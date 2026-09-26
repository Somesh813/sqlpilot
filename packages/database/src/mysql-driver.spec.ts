/**
 * Integration tests against a REAL MySQL 8 server (mysql-memory-server downloads and starts one
 * on a free port; the first run fetches the binary). Set MYSQL_TEST_URL=mysql://user:pw@host:port/db
 * to use an existing server instead. Every malicious statement is sent to the driver WITHOUT the
 * validator, so these show what the database and the driver's own guard refuse.
 */
import { DatabaseType, QueryStatus } from '@sqlpilot/shared';
import * as mysql from 'mysql2/promise';
import { MysqlDriver } from './mysql-driver';
import { DriverRegistry } from './registry';
import { DriverConfig, RunQueryOptions } from './types';

const READ: RunQueryOptions = { timeoutMs: 10_000, maxRows: 1000, allowWrite: false };

let stop: () => Promise<void> = async () => undefined;
let cfg: DriverConfig;
let admin: mysql.Connection;
let driver: MysqlDriver;

beforeAll(async () => {
  if (process.env.MYSQL_TEST_URL) {
    const u = new URL(process.env.MYSQL_TEST_URL);
    cfg = {
      type: DatabaseType.MYSQL,
      host: u.hostname,
      port: Number(u.port || 3306),
      database: u.pathname.slice(1),
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    };
  } else {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createDB } = require('mysql-memory-server') as typeof import('mysql-memory-server');
    const db = await createDB({ version: '8.0.x', logLevel: 'ERROR', dbName: 'sqlpilot_test' });
    stop = () => db.stop();
    cfg = { type: DatabaseType.MYSQL, host: '127.0.0.1', port: db.port, database: db.dbName, username: db.username, password: '' };
  }
  admin = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.username,
    password: cfg.password || undefined,
    database: cfg.database,
    multipleStatements: true,
    charset: 'utf8mb4',
  });
  await admin.query(`
    DROP TABLE IF EXISTS victims, texts, nums;
    CREATE TABLE victims (id INT PRIMARY KEY, name VARCHAR(50)) ENGINE=InnoDB;
    INSERT INTO victims VALUES (1,'a'),(2,'b'),(3,'c');
    CREATE TABLE texts (id INT, body VARCHAR(100), amount DECIMAL(12,2), created DATE, note VARCHAR(50)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    INSERT INTO texts VALUES
      (1, 'आरव शर्मा', 1234.50, '2026-01-31', NULL),
      (2, 'Priya Nair', 99999999.99, '2026-02-01', 'ok'),
      (3, '₹ 1,25,000', 0.10, NULL, 'ok');
    CREATE TABLE nums (n INT PRIMARY KEY) ENGINE=InnoDB;
  `);
  // 1,500 rows in one statement
  const values = Array.from({ length: 1500 }, (_, i) => `(${i + 1})`).join(',');
  await admin.query(`INSERT INTO nums VALUES ${values}`);
  driver = new MysqlDriver(cfg);
}, 240_000);

afterAll(async () => {
  await driver?.close();
  await admin?.end();
  await stop();
}, 60_000);

const victimCount = async () => Number(((await admin.query('SELECT COUNT(*) n FROM victims'))[0] as Array<{ n: number }>)[0].n);

describe('MysqlDriver: read-only enforcement (F1 / F2 on MySQL)', () => {
  const dml: Array<[string, string]> = [
    ['DELETE', 'DELETE FROM victims'],
    ['UPDATE', "UPDATE victims SET name = 'x'"],
    ['INSERT', "INSERT INTO victims VALUES (99, 'evil')"],
    ['REPLACE', "REPLACE INTO victims VALUES (1, 'evil')"],
    ['data-modifying WITH', 'WITH x AS (SELECT 1) DELETE FROM victims'],
  ];
  it.each(dml)('the database rejects %s inside START TRANSACTION READ ONLY', async (_l, sql) => {
    await expect(driver.runQuery(sql, READ)).rejects.toMatchObject({ name: 'DatabaseDriverError' });
    expect(await victimCount()).toBe(3);
  });

  it('DOCUMENTED FINDING: a MySQL read-only transaction does NOT stop DDL, so the driver guard and validator carry that load', async () => {
    // Verified on MySQL 8.0.43: DROP, CREATE, TRUNCATE and ALTER all succeed inside START TRANSACTION READ ONLY
    // (DDL commits implicitly). Only DML is refused by the server. Everything below relies on the
    // driver's statement-shape guard, the AST validator, and (best) an account that only has SELECT.
    await admin.query('CREATE TABLE ddl_probe (x INT)');
    await admin.query('START TRANSACTION READ ONLY');
    let ddlSucceeded = false;
    try {
      await admin.query('DROP TABLE ddl_probe');
      ddlSucceeded = true;
    } catch {
      ddlSucceeded = false;
    }
    await admin.query('ROLLBACK').catch(() => undefined);
    await admin.query('DROP TABLE IF EXISTS ddl_probe');
    expect(ddlSucceeded).toBe(true);
  });

  const ddl: Array<[string, string]> = [
    ['DROP', 'DROP TABLE victims'],
    ['TRUNCATE', 'TRUNCATE TABLE victims'],
    ['ALTER', 'ALTER TABLE victims ADD COLUMN evil INT'],
    ['CREATE', 'CREATE TABLE evil (x INT)'],
    ['GRANT', "GRANT ALL ON *.* TO 'x'@'%'"],
    ['SET GLOBAL', 'SET GLOBAL read_only = 0'],
    ['LOAD DATA', "LOAD DATA INFILE '/etc/passwd' INTO TABLE victims"],
    ['CALL', 'CALL sys.ps_setup_reset_to_default(TRUE)'],
  ];
  it.each(ddl)('the driver refuses %s before it reaches the server', async (_l, sql) => {
    await expect(driver.runQuery(sql, READ)).rejects.toMatchObject({ code: 'QUERY' });
    expect(await victimCount()).toBe(3);
    const [rows] = await admin.query("SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('evil')");
    expect((rows as Array<{ n: number }>)[0].n).toBe(0);
  });

  it('refuses SELECT ... INTO OUTFILE and locking reads', async () => {
    await expect(driver.runQuery("SELECT * FROM victims INTO OUTFILE '/tmp/sqlpilot_x'", READ)).rejects.toBeDefined();
    await expect(driver.runQuery('SELECT * FROM victims FOR UPDATE', READ)).rejects.toBeDefined();
  });

  it('refuses stacked statements (multipleStatements is off) and nothing from the second one runs', async () => {
    await expect(driver.runQuery('SELECT 1; DROP TABLE victims', READ)).rejects.toBeDefined();
    await expect(driver.runQuery('SELECT 1; DELETE FROM victims', READ)).rejects.toBeDefined();
    expect(await victimCount()).toBe(3);
  });

  it('the editor can write when explicitly allowed, and a later read-only query still cannot', async () => {
    const w = await driver.runQuery("INSERT INTO victims VALUES (100, 'temp')", { ...READ, allowWrite: true });
    expect(w.rows).toEqual([{ changes: 1 }]);
    expect(await victimCount()).toBe(4);
    await expect(driver.runQuery('DELETE FROM victims WHERE id = 100', READ)).rejects.toBeDefined();
    expect(await victimCount()).toBe(4);
    await driver.runQuery('DELETE FROM victims WHERE id = 100', { ...READ, allowWrite: true });
    expect(await victimCount()).toBe(3);
  });

  it('keeps serving queries after a rejected statement', async () => {
    await expect(driver.runQuery('DELETE FROM victims', READ)).rejects.toMatchObject({ code: 'QUERY' });
    const ok = await driver.runQuery('SELECT COUNT(*) AS n FROM victims', READ);
    expect(ok.rows).toEqual([{ n: 3 }]);
  });
});

describe('MysqlDriver: row cap uses fetch limit + 1 (F13 on MySQL)', () => {
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
    expect(r.status).toBe(QueryStatus.SUCCESS);
  });

  it('a 0-row result still reports its columns', async () => {
    const r = await driver.runQuery('SELECT id, name FROM victims WHERE 1 = 0', READ);
    expect(r.columns.map((c) => c.name)).toEqual(['id', 'name']);
    expect(r.rows).toEqual([]);
  });

  it('a huge user LIMIT is still capped and flagged', async () => {
    const r = await driver.runQuery('SELECT n FROM nums LIMIT 99999999', READ);
    expect(r.returnedRows).toBe(1000);
    expect(r.truncated).toBe(true);
    expect(r.totalRows).toBe(1500);
  });

  it('a user LIMIT below the cap is respected and not flagged', async () => {
    const r = await driver.runQuery('SELECT n FROM nums LIMIT 7', READ);
    expect(r.returnedRows).toBe(7);
    expect(r.truncated).toBe(false);
  });

  it('handles LIMIT hidden in subqueries and CTEs', async () => {
    const sub = await driver.runQuery('SELECT * FROM (SELECT n FROM nums LIMIT 1200) s', READ);
    expect(sub.returnedRows).toBe(1000);
    expect(sub.totalRows).toBe(1200);
    const cte = await driver.runQuery('WITH s AS (SELECT n FROM nums LIMIT 10) SELECT * FROM s', READ);
    expect(cte.returnedRows).toBe(10);
    expect(cte.truncated).toBe(false);
  });

  it('honours a smaller maxRows and skips the count when asked', async () => {
    const r = await driver.runQuery('SELECT n FROM nums', { ...READ, maxRows: 10, countTotal: false });
    expect(r.returnedRows).toBe(10);
    expect(r.truncated).toBe(true);
    expect(r.totalRows).toBeNull();
  });

  it('does not buffer a huge result: a 3-million-row cross join returns quickly and the connection is discarded cleanly', async () => {
    const t = Date.now();
    const r = await driver.runQuery('SELECT a.n FROM nums a CROSS JOIN nums b', { ...READ, countTotal: false });
    expect(r.returnedRows).toBe(1000);
    expect(r.truncated).toBe(true);
    expect(Date.now() - t).toBeLessThan(8000);
    // the pool is healthy afterwards
    expect((await driver.runQuery('SELECT 1 AS one', READ)).rows).toEqual([{ one: 1 }]);
  });

  it('enforces the time limit on a slow query and stays usable', async () => {
    const t = Date.now();
    // ~560 million row combinations: far longer than the 1s limit (MySQL then raises error 3024)
    await expect(
      driver.runQuery('SELECT COUNT(*) FROM nums a JOIN nums b ON a.n < b.n JOIN nums c ON b.n < c.n', { ...READ, timeoutMs: 1000, countTotal: false }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(Date.now() - t).toBeLessThan(6000);
    expect((await driver.runQuery('SELECT 2 AS two', READ)).rows).toEqual([{ two: 2 }]);
  });
});

describe('MysqlDriver: data fidelity', () => {
  it('returns NULL, exact decimals, dates, rupee and Hindi text unchanged', async () => {
    const r = await driver.runQuery('SELECT id, body, amount, created, note FROM texts ORDER BY id', READ);
    expect(r.rows[0]).toMatchObject({ id: 1, body: 'आरव शर्मा', note: null });
    expect(r.rows[0].amount).toBe('1234.50'); // DECIMAL arrives as an exact string
    expect(r.rows[1].amount).toBe('99999999.99');
    expect(r.rows[0].created).toBe('2026-01-31'); // a date stays a date string (no timezone shift)
    expect(r.rows[2].body).toBe('₹ 1,25,000');
    expect(r.rows[2].created).toBeNull();
  });

  it('reports column types', async () => {
    const r = await driver.runQuery('SELECT id, amount, created FROM texts LIMIT 1', READ);
    expect(r.columns.map((c) => c.name)).toEqual(['id', 'amount', 'created']);
  });

  it('testConnection returns the version and warns about broad privileges', async () => {
    const res = await driver.testConnection();
    expect(res.ok).toBe(true);
    expect(res.serverVersion).toMatch(/^8\./);
    expect(res.warnings?.join(' ')).toMatch(/write or administer/i);
  });

  it('introspection sees tables, columns and keys', async () => {
    const schema = await driver.introspect();
    const texts = schema.tables.find((t) => t.name === 'texts')!;
    expect(texts.columns.map((c) => c.name)).toEqual(['id', 'body', 'amount', 'created', 'note']);
    expect(schema.tables.find((t) => t.name === 'victims')!.columns.find((c) => c.name === 'id')!.isPrimaryKey).toBe(true);
  });
});

describe('MysqlDriver through the registry: persistent pools (F14 on MySQL)', () => {
  const connId = (registry: DriverRegistry, id = 'my-1') =>
    registry.run(id, cfg, async (d) => (await d.runQuery('SELECT CONNECTION_ID() AS id', READ)).rows[0].id as number);

  it('sequential requests reuse one database connection', async () => {
    const registry = new DriverRegistry({ sweepMs: 0 });
    const ids = new Set<number>();
    for (let i = 0; i < 8; i++) ids.add(await connId(registry));
    expect(ids.size).toBe(1);
    await registry.closeAll();
  });

  it('closing the registry releases the connections', async () => {
    const count = async () => Number(((await admin.query("SELECT COUNT(*) n FROM information_schema.processlist WHERE db = DATABASE()"))[0] as Array<{ n: number }>)[0].n);
    const before = await count();
    const registry = new DriverRegistry({ sweepMs: 0 });
    await Promise.all([connId(registry, 'a'), connId(registry, 'b')]);
    expect(await count()).toBeGreaterThan(before);
    await registry.closeAll();
    for (let i = 0; i < 30 && (await count()) > before; i++) await new Promise((r) => setTimeout(r, 100));
    expect(await count()).toBe(before);
  });

  it('classifies an unreachable server as a CONNECTION error, not a query error', async () => {
    const dead = new MysqlDriver({ ...cfg, port: 1 });
    await expect(dead.runQuery('SELECT 1', READ)).rejects.toMatchObject({ code: 'CONNECTION' });
    await dead.close();
  });

  it('classifies wrong credentials as CONNECTION with a generic message', async () => {
    const bad = new MysqlDriver({ ...cfg, username: 'nobody', password: 'wrong' });
    const err = await bad.runQuery('SELECT 1', READ).catch((e) => e);
    expect(err.code).toBe('CONNECTION');
    expect(err.message).not.toMatch(/nobody|wrong|127\.0\.0\.1/);
    await bad.close();
  });
});
