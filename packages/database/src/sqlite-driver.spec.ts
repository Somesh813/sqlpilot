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
