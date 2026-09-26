import { DatabaseType } from '@sqlpilot/shared';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDriver } from './sqlite-driver';
import { RunQueryOptions } from './types';

const READ: RunQueryOptions = { timeoutMs: 10_000, maxRows: 1000, allowWrite: false };

let dir: string;
let driver: SqliteDriver;
let file: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sqlpilot-sqlite-'));
  file = join(dir, 'test.sqlite');
  const db = new Database(file);
  db.exec(`
    CREATE TABLE victims (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO victims VALUES (1,'a'),(2,'b'),(3,'c');
    CREATE TABLE nums (n INTEGER);
    CREATE TABLE texts (id INTEGER, body TEXT, amount REAL, created TEXT, note TEXT);
    INSERT INTO texts VALUES (1,'आरव शर्मा',1234.5,'2026-01-31',NULL),(2,'₹ 1,25,000',0.1,NULL,'ok');
  `);
  const ins = db.prepare('INSERT INTO nums VALUES (?)');
  db.transaction(() => {
    for (let i = 1; i <= 1500; i++) ins.run(i);
  })();
  db.close();
  driver = new SqliteDriver({ type: DatabaseType.SQLITE, database: 'test', filePath: file });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const victims = () => {
  const db = new Database(file, { readonly: true });
  const n = (db.prepare('SELECT count(*) n FROM victims').get() as { n: number }).n;
  db.close();
  return n;
};

describe('SqliteDriver: read-only', () => {
  it.each([
    'DELETE FROM victims',
    "UPDATE victims SET name = 'x'",
    "INSERT INTO victims VALUES (9, 'evil')",
    'DROP TABLE victims',
    'CREATE TABLE evil (x int)',
    'ALTER TABLE victims ADD COLUMN evil int',
    'PRAGMA writable_schema = 1',
    "ATTACH DATABASE ':memory:' AS x",
    'WITH d AS (SELECT 1) DELETE FROM victims',
  ])('rejects %s', async (sql) => {
    await expect(driver.runQuery(sql, READ)).rejects.toMatchObject({ name: 'DatabaseDriverError' });
    expect(victims()).toBe(3);
  });

  it('refuses stacked statements', async () => {
    await expect(driver.runQuery('SELECT 1; DROP TABLE victims', READ)).rejects.toBeDefined();
    expect(victims()).toBe(3);
  });
});

describe('SqliteDriver: row cap uses fetch limit + 1', () => {
  it.each([
    [0, 0, false, 0],
    [1, 1, false, 1],
    [999, 999, false, 999],
    [1000, 1000, false, 1000],
    [1001, 1000, true, 1001],
    [1500, 1000, true, 1500],
  ])('%i rows -> returnedRows %i, truncated %s, totalRows %s', async (available, returned, truncated, total) => {
    const r = await driver.runQuery(`SELECT n FROM nums WHERE n <= ${available} ORDER BY n`, READ);
    expect(r.returnedRows).toBe(returned);
    expect(r.rows).toHaveLength(returned);
    expect(r.truncated).toBe(truncated);
    expect(r.totalRows).toBe(total);
  });

  it('a huge user LIMIT is still capped and flagged', async () => {
    const r = await driver.runQuery('SELECT n FROM nums LIMIT 99999999', READ);
    expect(r.returnedRows).toBe(1000);
    expect(r.truncated).toBe(true);
    expect(r.totalRows).toBe(1500);
  });

  it('countTotal:false leaves the total unknown', async () => {
    const r = await driver.runQuery('SELECT n FROM nums', { ...READ, countTotal: false });
    expect(r.truncated).toBe(true);
    expect(r.totalRows).toBeNull();
  });

  it('handles LIMIT inside subqueries and CTEs', async () => {
    const sub = await driver.runQuery('SELECT * FROM (SELECT n FROM nums LIMIT 1200)', READ);
    expect(sub.returnedRows).toBe(1000);
    expect(sub.totalRows).toBe(1200);
    const cte = await driver.runQuery('WITH s AS (SELECT n FROM nums LIMIT 10) SELECT * FROM s', READ);
    expect(cte.returnedRows).toBe(10);
    expect(cte.truncated).toBe(false);
  });
});

describe('SqliteDriver: data fidelity and editor writes', () => {
  it('returns NULL, decimals, ₹ and Hindi text unchanged', async () => {
    const r = await driver.runQuery('SELECT * FROM texts ORDER BY id', READ);
    expect(r.rows[0]).toMatchObject({ body: 'आरव शर्मा', amount: 1234.5, note: null });
    expect(r.rows[1]).toMatchObject({ body: '₹ 1,25,000', created: null });
  });

  it('write mode still works for the SQL editor', async () => {
    const w = await driver.runQuery("INSERT INTO victims VALUES (100, 'temp')", { ...READ, allowWrite: true });
    expect(w.rows).toEqual([{ changes: 1 }]);
    await driver.runQuery('DELETE FROM victims WHERE id = 100', { ...READ, allowWrite: true });
    expect(victims()).toBe(3);
  });
});

describe('SqliteDriver: heavy queries cannot freeze the API (F3)', () => {
  // ~unbounded recursive count: seconds of pure CPU inside SQLite
  const HEAVY = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 500000000) SELECT count(*) FROM c';

  /** Longest gap between two ticks of a 20ms timer = how long the event loop was frozen. */
  const watchLoop = () => {
    let last = Date.now();
    let worst = 0;
    const t = setInterval(() => {
      const now = Date.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 20);
    return { stop: () => (clearInterval(t), worst) };
  };

  it('a heavy query times out on schedule, and the event loop stays responsive meanwhile', async () => {
    const loop = watchLoop();
    const started = Date.now();
    await expect(driver.runQuery(HEAVY, { ...READ, timeoutMs: 1000 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    const elapsed = Date.now() - started;
    const frozen = loop.stop();
    expect(elapsed).toBeLessThan(2500); // before: a 1s timeout took ~7s
    expect(frozen).toBeLessThan(250); // before: the loop was frozen for the whole query
  });

  it('a concurrent request finishes quickly while a heavy query is running', async () => {
    const heavy = driver.runQuery(HEAVY, { ...READ, timeoutMs: 3000 }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 200));
    const t = Date.now();
    const quick = await driver.runQuery('SELECT count(*) AS n FROM victims', READ);
    expect(quick.rows).toEqual([{ n: 3 }]);
    expect(Date.now() - t).toBeLessThan(1500);
    expect(await heavy).toMatchObject({ code: 'TIMEOUT' });
  });

  it('cancellation kills the query immediately', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = driver.runQuery(HEAVY, { ...READ, timeoutMs: 20_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('an already-aborted signal never starts the query', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(driver.runQuery('SELECT 1', { ...READ, signal: ac.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('the killed query process is really gone (no orphan burning CPU)', async () => {
    const before = await countRunners();
    await driver.runQuery(HEAVY, { ...READ, timeoutMs: 1000 }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
    expect(await countRunners()).toBeLessThanOrEqual(before);
  });

  it('many parallel queries do not block each other', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => driver.runQuery('SELECT n FROM nums LIMIT 5', READ)));
    expect(results.every((r) => r.returnedRows === 5)).toBe(true);
  });
});

async function countRunners(): Promise<number> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'wmic' : 'pgrep';
    const args = process.platform === 'win32' ? ['process', 'where', "commandline like '%sqlite-runner%'", 'get', 'processid'] : ['-fc', 'sqlite-runner'];
    execFile(cmd, args, (_e, out) => {
      const n = process.platform === 'win32' ? out.split('\n').filter((l) => /^\d+/.test(l.trim())).length : Number(out.trim() || 0);
      resolve(n);
    });
  });
}
