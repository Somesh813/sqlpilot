/**
 * Integration tests against a REAL PostgreSQL server (embedded-postgres, started per run on
 * a free port). Set PG_TEST_URL=postgres://user:pw@host:port/db to use an existing server instead.
 *
 * These prove the database itself rejects writes: every malicious statement below is sent to
 * the driver WITHOUT going through the validator, so this is the last line of defence.
 */
import { QueryStatus } from '@sqlpilot/shared';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { PostgresDriver } from './postgres-driver';
import { DriverRegistry } from './registry';
import { DriverConfig, RunQueryOptions } from './types';
import { DatabaseType } from '@sqlpilot/shared';

const READ: RunQueryOptions = { timeoutMs: 10_000, maxRows: 1000, allowWrite: false };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

let stop: () => Promise<void> = async () => undefined;
let cfg: DriverConfig;
let admin: Client;
let driver: PostgresDriver;

beforeAll(async () => {
  if (process.env.PG_TEST_URL) {
    const u = new URL(process.env.PG_TEST_URL);
    cfg = {
      type: DatabaseType.POSTGRES,
      host: u.hostname,
      port: Number(u.port || 5432),
      database: u.pathname.slice(1),
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    };
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'sqlpilot-pg-'));
    const port = await freePort();
    const child = spawn(process.execPath, [join(__dirname, '..', 'test', 'pg-server.mjs'), String(port), dir], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (b: Buffer) => b.toString().includes('READY') && resolve());
      child.on('exit', (code) => reject(new Error(`embedded postgres exited early (${code})`)));
    });
    stop = async () => {
      child.stdin!.end();
      await new Promise((r) => (child.exitCode !== null ? r(null) : child.on('exit', r)));
      rmSync(dir, { recursive: true, force: true });
    };
    cfg = { type: DatabaseType.POSTGRES, host: '127.0.0.1', port, database: 'postgres', username: 'postgres', password: 'pw' };
  }
  admin = new Client({ host: cfg.host, port: cfg.port, user: cfg.username, password: cfg.password, database: cfg.database });
  await admin.connect();
  await admin.query(`
    DROP TABLE IF EXISTS victims, big, wide, texts CASCADE;
    CREATE TABLE victims (id int PRIMARY KEY, name text);
    INSERT INTO victims VALUES (1,'a'),(2,'b'),(3,'c');
    CREATE SEQUENCE IF NOT EXISTS victims_seq;
    CREATE TABLE texts (id int, body text, amount numeric(12,2), created date, note text);
    INSERT INTO texts VALUES
      (1, 'आरव शर्मा', 1234.50, '2026-01-31', NULL),
      (2, 'Priya Nair', 99999999.99, '2026-02-01', 'ok'),
      (3, '₹ 1,25,000', 0.10, NULL, 'ok');
  `);
  driver = new PostgresDriver(cfg);
}, 180_000);

afterAll(async () => {
  await driver?.close();
  await admin?.end();
  await stop();
}, 60_000);

const victimCount = async () => Number((await admin.query('SELECT count(*)::int n FROM victims')).rows[0].n);

describe('PostgresDriver: read-only enforcement is real (F1)', () => {
  const malicious: Array<[string, string]> = [
    ['DELETE', 'DELETE FROM victims'],
    ['UPDATE', "UPDATE victims SET name = 'x'"],
    ['INSERT', "INSERT INTO victims VALUES (99, 'evil')"],
    ['TRUNCATE', 'TRUNCATE victims'],
    ['DROP', 'DROP TABLE victims'],
    ['ALTER', 'ALTER TABLE victims ADD COLUMN evil int'],
    ['CREATE', 'CREATE TABLE evil (x int)'],
    ['SELECT INTO', 'SELECT * INTO evil_copy FROM victims'],
    ['CTAS', 'CREATE TABLE evil_copy AS SELECT * FROM victims'],
    ['data-modifying CTE', 'WITH d AS (DELETE FROM victims RETURNING *) SELECT * FROM d'],
    ['nextval', "SELECT nextval('victims_seq')"],
    ['setval', "SELECT setval('victims_seq', 100)"],
    ['GRANT', 'GRANT ALL ON victims TO PUBLIC'],
    ['COMMENT', "COMMENT ON TABLE victims IS 'pwned'"],
  ];

  it.each(malicious)('the database rejects %s inside a READ ONLY transaction', async (_label, sql) => {
    await expect(driver.runQuery(sql, READ)).rejects.toMatchObject({ name: 'DatabaseDriverError' });
    expect(await victimCount()).toBe(3);
    expect((await admin.query("SELECT to_regclass('evil') e, to_regclass('evil_copy') c")).rows[0]).toEqual({ e: null, c: null });
  });

  it('rejects COPY ... PROGRAM (server-side code execution) and COPY TO file', async () => {
    await expect(driver.runQuery("COPY (SELECT 1) TO PROGRAM 'echo pwned'", READ)).rejects.toBeDefined();
    await expect(driver.runQuery("COPY victims TO '/tmp/sqlpilot_x'", READ)).rejects.toBeDefined();
  });

  it('rejects FOR UPDATE locking reads', async () => {
    await expect(driver.runQuery('SELECT * FROM victims FOR UPDATE', READ)).rejects.toBeDefined();
  });

  it('refuses stacked statements (extended protocol) and nothing from the second one runs', async () => {
    await expect(driver.runQuery('SELECT 1; DROP TABLE victims', READ)).rejects.toBeDefined();
    await expect(driver.runQuery('SELECT 1; DELETE FROM victims', READ)).rejects.toBeDefined();
    expect(await victimCount()).toBe(3);
  });

  it('does not let a statement switch the transaction back to read-write', async () => {
    await expect(driver.runQuery('SET TRANSACTION READ WRITE', READ)).rejects.toBeDefined();
    await expect(driver.runQuery('DELETE FROM victims', READ)).rejects.toBeDefined(); // still read-only afterwards
    expect(await victimCount()).toBe(3);
  });

  it('a pooled connection is not left read-only for the editor, and not read-write for the AI', async () => {
    // editor write commits
    const w = await driver.runQuery("INSERT INTO victims VALUES (100, 'temp')", { ...READ, allowWrite: true });
    expect(w.rows).toEqual([{ changes: 1 }]);
    expect(await victimCount()).toBe(4);
    // the very next read-only query on the (reused) pool connection still cannot write
    await expect(driver.runQuery("DELETE FROM victims WHERE id = 100", READ)).rejects.toBeDefined();
    expect(await victimCount()).toBe(4);
    await driver.runQuery('DELETE FROM victims WHERE id = 100', { ...READ, allowWrite: true });
    expect(await victimCount()).toBe(3);
  });

  it('reports a read-only failure as a QUERY error and keeps serving queries afterwards', async () => {
    await expect(driver.runQuery('DELETE FROM victims', READ)).rejects.toMatchObject({ code: 'QUERY' });
    const ok = await driver.runQuery('SELECT count(*)::int AS n FROM victims', READ);
    expect(ok.rows).toEqual([{ n: 3 }]);
  });
});

describe('PostgresDriver: row cap uses fetch limit + 1 (F13)', () => {
  const series = (n: number) => `SELECT g AS id FROM generate_series(1, ${n}) g ORDER BY g`;

  it.each([
    [0, 0, false, 0],
    [1, 1, false, 1],
    [999, 999, false, 999],
    [1000, 1000, false, 1000],
    [1001, 1000, true, 1001],
    [1500, 1000, true, 1500],
  ])('%i rows -> returnedRows %i, truncated %s, totalRows %s', async (available, returned, truncated, total) => {
    const r = await driver.runQuery(series(available), READ);
    expect(r.returnedRows).toBe(returned);
    expect(r.rows).toHaveLength(returned);
    expect(r.truncated).toBe(truncated);
    expect(r.totalRows).toBe(total);
    expect(r.status).toBe(QueryStatus.SUCCESS);
  });

  it('a 0-row result still reports its columns', async () => {
    const r = await driver.runQuery('SELECT id, name FROM victims WHERE false', READ);
    expect(r.columns.map((c) => c.name)).toEqual(['id', 'name']);
    expect(r.rows).toEqual([]);
  });

  it('does not add or rely on a LIMIT: a huge user LIMIT still returns at most maxRows + flag', async () => {
    const r = await driver.runQuery('SELECT g FROM generate_series(1, 5000) g LIMIT 99999999', READ);
    expect(r.returnedRows).toBe(1000);
    expect(r.truncated).toBe(true);
    expect(r.totalRows).toBe(5000);
  });

  it('a user LIMIT below the cap is respected and not flagged as truncated', async () => {
    const r = await driver.runQuery('SELECT g FROM generate_series(1, 5000) g LIMIT 7', READ);
    expect(r.returnedRows).toBe(7);
    expect(r.truncated).toBe(false);
    expect(r.totalRows).toBe(7);
  });

  it('handles LIMIT hidden in subqueries and CTEs', async () => {
    const sub = await driver.runQuery('SELECT * FROM (SELECT g FROM generate_series(1, 3000) g LIMIT 1200) s', READ);
    expect(sub.returnedRows).toBe(1000);
    expect(sub.truncated).toBe(true);
    expect(sub.totalRows).toBe(1200);
    const cte = await driver.runQuery('WITH s AS (SELECT g FROM generate_series(1, 3000) g LIMIT 10) SELECT * FROM s', READ);
    expect(cte.returnedRows).toBe(10);
    expect(cte.truncated).toBe(false);
  });

  it('honours a smaller maxRows', async () => {
    const r = await driver.runQuery(series(50), { ...READ, maxRows: 10 });
    expect(r.returnedRows).toBe(10);
    expect(r.truncated).toBe(true);
    expect(r.totalRows).toBe(50);
  });

  it('countTotal:false skips the count and reports an unknown total', async () => {
    const r = await driver.runQuery(series(1500), { ...READ, countTotal: false });
    expect(r.truncated).toBe(true);
    expect(r.totalRows).toBeNull();
  });

  it('never buffers the whole table: a 5-million-row query returns quickly', async () => {
    const t = Date.now();
    const r = await driver.runQuery('SELECT g FROM generate_series(1, 5000000) g', { ...READ, countTotal: false });
    expect(r.returnedRows).toBe(1000);
    expect(r.truncated).toBe(true);
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('enforces the statement timeout', async () => {
    await expect(driver.runQuery('SELECT pg_sleep(5)', { ...READ, timeoutMs: 1000 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    // and the pool is still healthy
    expect((await driver.runQuery('SELECT 1 AS one', READ)).rows).toEqual([{ one: 1 }]);
  });
});

describe('PostgresDriver: data fidelity', () => {
  it('returns NULL, decimals, dates, ₹ and Hindi text unchanged', async () => {
    const r = await driver.runQuery('SELECT id, body, amount, created, note FROM texts ORDER BY id', READ);
    expect(r.rows[0]).toMatchObject({ id: 1, body: 'आरव शर्मा', note: null });
    expect(r.rows[0].amount).toBe('1234.50'); // numeric arrives as an exact string, never a float
    expect(r.rows[1].amount).toBe('99999999.99');
    expect(r.rows[2].body).toBe('₹ 1,25,000');
    expect(r.rows[2].created).toBeNull();
    expect(String(r.rows[0].created)).toMatch(/^2026-01-3[01]/);
  });

  it('testConnection warns when the account is a superuser', async () => {
    const res = await driver.testConnection();
    expect(res.ok).toBe(true);
    expect(res.serverVersion).toMatch(/PostgreSQL/i);
    expect(res.warnings?.join(' ')).toMatch(/superuser/i);
  });
});

describe('PostgresDriver through the registry: persistent pools (F14)', () => {
  const appConnections = async () =>
    Number(
      (await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name = 'sqlpilot' AND datname = current_database()"))
        .rows[0].n,
    );
  const pid = (registry: DriverRegistry, id = 'conn-1') =>
    registry.run(id, cfg, async (d) => (await d.runQuery('SELECT pg_backend_pid() AS pid', READ)).rows[0].pid as number);

  it('sequential requests reuse the same database connection instead of reconnecting', async () => {
    const registry = new DriverRegistry({ sweepMs: 0 });
    const first = await pid(registry);
    const pids = new Set([first]);
    for (let i = 0; i < 10; i++) pids.add(await pid(registry));
    expect(pids.size).toBe(1);
    await registry.closeAll();
  });

  it('the old per-request pattern opens a fresh connection every time (what this replaces)', async () => {
    const pids = new Set<number>();
    for (let i = 0; i < 4; i++) {
      const d = new PostgresDriver(cfg);
      pids.add((await d.runQuery('SELECT pg_backend_pid() AS pid', READ)).rows[0].pid as number);
      await d.close();
    }
    expect(pids.size).toBeGreaterThan(1);
  });

  it('is faster than reconnecting for every request', async () => {
    const registry = new DriverRegistry({ sweepMs: 0 });
    await pid(registry); // warm the pool
    const rounds = 15;
    let t = Date.now();
    for (let i = 0; i < rounds; i++) await pid(registry);
    const pooled = Date.now() - t;
    t = Date.now();
    for (let i = 0; i < rounds; i++) {
      const d = new PostgresDriver(cfg);
      await d.runQuery('SELECT 1', READ);
      await d.close();
    }
    const perRequest = Date.now() - t;
    await registry.closeAll();
    // eslint-disable-next-line no-console
    console.log(`pooled ${(pooled / rounds).toFixed(1)} ms/query vs new pool each time ${(perRequest / rounds).toFixed(1)} ms/query`);
    expect(pooled).toBeLessThan(perRequest);
  });

  it('respects the configured pool size under parallel load', async () => {
    const baseline = await appConnections(); // the suite's own shared driver keeps a connection open
    const registry = new DriverRegistry({ sweepMs: 0 });
    const small: DriverConfig = { ...cfg, pool: { max: 3 } };
    const pids = await Promise.all(
      Array.from({ length: 12 }, () =>
        registry.run('conn-size', small, async (d) => (await d.runQuery('SELECT pg_backend_pid() AS pid, pg_sleep(0.05)', { ...READ, timeoutMs: 5000 }).catch(() => null)) !== null),
      ),
    );
    expect(pids).toHaveLength(12);
    expect((await appConnections()) - baseline).toBeLessThanOrEqual(3);
    await registry.closeAll();
  });

  it('closing the registry releases every database connection', async () => {
    const before = await appConnections();
    const registry = new DriverRegistry({ sweepMs: 0 });
    await Promise.all([pid(registry, 'a'), pid(registry, 'b')]);
    expect(await appConnections()).toBeGreaterThan(before);
    await registry.closeAll();
    for (let i = 0; i < 20 && (await appConnections()) > before; i++) await new Promise((r) => setTimeout(r, 100));
    expect(await appConnections()).toBe(before);
  });

  it('idle eviction closes the pool and its connections', async () => {
    const before = await appConnections();
    let clock = Date.now();
    const registry = new DriverRegistry({ sweepMs: 0, idleMs: 1000, now: () => clock });
    await pid(registry);
    clock += 5000;
    expect(await registry.sweep()).toBe(1);
    for (let i = 0; i < 20 && (await appConnections()) > before; i++) await new Promise((r) => setTimeout(r, 100));
    expect(await appConnections()).toBe(before);
    await registry.closeAll();
  });

  it('survives the server killing an idle pooled connection (no crash, next query works)', async () => {
    const registry = new DriverRegistry({ sweepMs: 0 });
    const victim = await pid(registry);
    await admin.query('SELECT pg_terminate_backend($1)', [victim]);
    await new Promise((r) => setTimeout(r, 300));
    const next = await registry.run('conn-1', cfg, (d) => d.runQuery('SELECT 42 AS answer', READ)).catch(() => null);
    const retry = next ?? (await registry.run('conn-1', cfg, (d) => d.runQuery('SELECT 42 AS answer', READ)));
    expect(retry.rows).toEqual([{ answer: 42 }]);
    await registry.closeAll();
  });
});
