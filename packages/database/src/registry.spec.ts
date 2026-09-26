import { DatabaseType, QueryStatus } from '@sqlpilot/shared';
import { configFingerprint, DriverRegistry } from './registry';
import { DatabaseDriverError, DriverConfig, SqlDriver } from './types';

const cfg = (over: Partial<DriverConfig> = {}): DriverConfig => ({
  type: DatabaseType.POSTGRES,
  host: 'db',
  port: 5432,
  database: 'app',
  username: 'u',
  password: 'p',
  ...over,
});

class FakeDriver implements SqlDriver {
  readonly type = DatabaseType.POSTGRES;
  closed = 0;
  constructor(readonly config: DriverConfig) {}
  async testConnection() {
    return { ok: true, latencyMs: 1, serverVersion: 'x', error: null };
  }
  async introspect() {
    return { databaseName: 'app', tables: [], relationships: [], functions: [] };
  }
  async runQuery() {
    return { columns: [], rows: [], returnedRows: 0, totalRows: 0, executionTimeMs: 0, truncated: false, status: QueryStatus.SUCCESS, historyId: null };
  }
  async close() {
    this.closed++;
  }
}

function setup(options: { idleMs?: number; maxDrivers?: number } = {}) {
  let clock = 1_000_000;
  const created: FakeDriver[] = [];
  const registry = new DriverRegistry({
    ...options,
    sweepMs: 0, // tests sweep by hand
    now: () => clock,
    factory: (c) => {
      const d = new FakeDriver(c);
      created.push(d);
      return d;
    },
  });
  return { registry, created, advance: (ms: number) => (clock += ms) };
}
const use = (r: DriverRegistry, id: string, c = cfg()) => r.run(id, c, async (d) => d as FakeDriver);
const flush = () => new Promise((r) => setImmediate(r));

describe('DriverRegistry (F14)', () => {
  it('reuses one driver for repeated use of the same connection', async () => {
    const { registry, created } = setup();
    const a = await use(registry, 'c1');
    const b = await use(registry, 'c1');
    expect(a).toBe(b);
    expect(created).toHaveLength(1);
    expect(registry.size).toBe(1);
  });

  it('creates the pool only once when many requests arrive at the same moment', async () => {
    const { registry, created } = setup();
    await Promise.all(Array.from({ length: 20 }, () => use(registry, 'c1')));
    expect(created).toHaveLength(1);
  });

  it('keeps separate pools for separate connections (user isolation)', async () => {
    const { registry, created } = setup();
    const a = await use(registry, 'user-a-conn', cfg({ password: 'a' }));
    const b = await use(registry, 'user-b-conn', cfg({ password: 'b' }));
    expect(a).not.toBe(b);
    expect(created).toHaveLength(2);
  });

  it('builds a new pool when the settings change, and closes the old one', async () => {
    const { registry, created } = setup();
    await use(registry, 'c1', cfg({ password: 'old' }));
    await use(registry, 'c1', cfg({ password: 'new' }));
    await flush();
    expect(created).toHaveLength(2);
    expect(created[0].closed).toBe(1);
    expect(created[1].closed).toBe(0);
    expect(registry.size).toBe(1);
  });

  it('invalidate() drops the pool for an edited or deleted connection', async () => {
    const { registry, created } = setup();
    await use(registry, 'c1');
    registry.invalidate('c1');
    await flush();
    expect(created[0].closed).toBe(1);
    expect(registry.size).toBe(0);
    await use(registry, 'c1');
    expect(created).toHaveLength(2);
  });

  it('invalidate() waits for a running query instead of cutting it off', async () => {
    const { registry, created } = setup();
    let release!: () => void;
    const running = registry.run('c1', cfg(), () => new Promise<void>((r) => (release = r)));
    registry.invalidate('c1');
    await flush();
    expect(created[0].closed).toBe(0); // still busy
    release();
    await running;
    await flush();
    expect(created[0].closed).toBe(1);
  });

  it('closes pools that stay idle, and keeps recently used ones', async () => {
    const { registry, created, advance } = setup({ idleMs: 60_000 });
    await use(registry, 'old');
    advance(50_000);
    await use(registry, 'recent');
    advance(20_000); // old: 70s idle, recent: 20s
    expect(await registry.sweep()).toBe(1);
    expect(created[0].closed).toBe(1);
    expect(created[1].closed).toBe(0);
    expect(registry.size).toBe(1);
  });

  it('never closes a pool that is running a query, however long it has been', async () => {
    const { registry, created, advance } = setup({ idleMs: 1000 });
    let release!: () => void;
    const running = registry.run('c1', cfg(), () => new Promise<void>((r) => (release = r)));
    advance(60_000);
    expect(await registry.sweep()).toBe(0);
    expect(created[0].closed).toBe(0);
    release();
    await running;
  });

  it('caps the number of pools by closing the least recently used idle one', async () => {
    const { registry, created, advance } = setup({ maxDrivers: 2 });
    await use(registry, 'a');
    advance(10);
    await use(registry, 'b');
    advance(10);
    await use(registry, 'a'); // a is now more recent than b
    advance(10);
    await use(registry, 'c'); // needs room: evicts b
    await flush();
    expect(registry.size).toBe(2);
    expect(created.find((d) => d.config === created[1].config)!.closed).toBe(1); // b
    expect(created[0].closed).toBe(0); // a survives
  });

  it('when every pool is busy it allows a temporary overshoot rather than failing the request', async () => {
    const { registry } = setup({ maxDrivers: 1 });
    const releases: Array<() => void> = [];
    const p1 = registry.run('a', cfg(), () => new Promise<void>((r) => releases.push(r)));
    const p2 = registry.run('b', cfg({ database: 'other' }), () => new Promise<void>((r) => releases.push(r)));
    await flush();
    expect(registry.size).toBe(2);
    releases.forEach((r) => r());
    await Promise.all([p1, p2]);
  });

  it('retires a pool after a connection failure so the next call starts fresh', async () => {
    const { registry, created } = setup();
    await expect(
      registry.run('c1', cfg(), async () => {
        throw new DatabaseDriverError('down', 'ECONNREFUSED', 'CONNECTION');
      }),
    ).rejects.toMatchObject({ code: 'CONNECTION' });
    await flush();
    expect(created[0].closed).toBe(1);
    await use(registry, 'c1');
    expect(created).toHaveLength(2);
  });

  it('does not retire a pool because of an ordinary SQL error', async () => {
    const { registry, created } = setup();
    await expect(
      registry.run('c1', cfg(), async () => {
        throw new DatabaseDriverError('bad sql', 'no such column', 'QUERY');
      }),
    ).rejects.toBeDefined();
    await use(registry, 'c1');
    expect(created).toHaveLength(1);
    expect(created[0].closed).toBe(0);
  });

  it('never caches SQLite (each query already runs in its own process)', async () => {
    const { registry, created } = setup();
    await use(registry, 'lite', cfg({ type: DatabaseType.SQLITE, filePath: '/x.sqlite' }));
    await use(registry, 'lite', cfg({ type: DatabaseType.SQLITE, filePath: '/x.sqlite' }));
    expect(created).toHaveLength(2);
    expect(created.every((d) => d.closed === 1)).toBe(true);
    expect(registry.size).toBe(0);
  });

  it('closeAll() closes every pool and refuses new work', async () => {
    const { registry, created } = setup();
    await use(registry, 'a');
    await use(registry, 'b', cfg({ database: 'b' }));
    await registry.closeAll();
    expect(created.map((d) => d.closed)).toEqual([1, 1]);
    expect(registry.size).toBe(0);
    await expect(use(registry, 'a')).rejects.toThrow(/closed/);
  });

  it('a failing close() cannot break the registry', async () => {
    const { registry, created } = setup();
    await use(registry, 'a');
    created[0].close = async () => {
      throw new Error('socket already gone');
    };
    await expect(registry.closeAll()).resolves.toBeUndefined();
  });

  it('fingerprints settings deterministically and distinguishes each field', () => {
    expect(configFingerprint(cfg())).toBe(configFingerprint(cfg()));
    for (const change of [{ host: 'x' }, { port: 1 }, { database: 'x' }, { username: 'x' }, { password: 'x' }, { ssl: true }]) {
      expect(configFingerprint(cfg(change))).not.toBe(configFingerprint(cfg()));
    }
  });
});
