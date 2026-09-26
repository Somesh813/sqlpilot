import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { AiProvider, AiStructuredResult } from '@sqlpilot/ai';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { AI_PROVIDER } from '../src/ai/ai-provider.factory';
import { AiModule } from '../src/ai/ai.module';
import { AuditModule } from '../src/audit/audit.module';
import { AuthModule } from '../src/auth/auth.module';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { CommonModule } from '../src/common/common.module';
import { RolesGuard } from '../src/common/guards/roles.guard';
import configuration from '../src/config/configuration';
import { DatabaseConnectionsModule } from '../src/database-connections/database-connections.module';
import { QueryExecutionModule } from '../src/query-execution/query-execution.module';
import { QueryHistoryModule } from '../src/query-history/query-history.module';
import { UsersModule } from '../src/users/users.module';

/** Model output for the 'generated_sql' schema. */
const gen = (sql: string) => ({
  intent: 'test', tablesUsed: [], sql, explanation: 'x', assumptions: [], confidence: 0.9, warnings: [],
  unanswerable: false, unanswerableReason: null, visualization: { recommended: false, type: 'table', xField: null, yField: null },
});

class ScriptedProvider implements AiProvider {
  readonly name = 'scripted';
  generated: unknown[] = [];
  async complete(): Promise<never> {
    throw new Error('not used');
  }
  // eslint-disable-next-line require-yield
  async *streamComplete(): AsyncIterable<string> {
    throw new Error('not used');
  }
  async completeStructured<T>(_r: unknown, _s: unknown, name: string): Promise<AiStructuredResult<T>> {
    let data: unknown;
    if (name === 'generated_sql') data = this.generated.shift();
    else if (name === 'follow_up_check') data = { followUp: false };
    else if (name === 'result_answer') data = { answer: 'Here are the results.' };
    else if (name === 'sql_fix') data = { fixedSql: '', diagnosis: 'none', changes: [], confidence: 0 };
    if (data === undefined) throw new Error(`no scripted output for ${name}`);
    return { data: data as T, model: 'scripted', usage: null, raw: '' };
  }
}

/**
 * F17: security, data-size and data-fidelity behaviour through the real HTTP stack
 * (validation -> policy -> driver -> SQLite), including the worst-case configuration
 * (global write switch ON, connection write-enabled).
 */
describe('Security and data handling through the full stack (e2e)', () => {
  let app: INestApplication;
  let mongo: MongoMemoryServer;
  let tmpDir: string;
  let dbPath: string;
  let token: string;
  let readOnlyConn: string;
  let writeEnabledConn: string;
  const provider = new ScriptedProvider();

  const snapshot = () => {
    const db = new BetterSqlite3(dbPath, { readonly: true });
    const state = {
      schema: db.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(),
      customers: db.prepare('SELECT * FROM customers ORDER BY id').all(),
      big: (db.prepare('SELECT COUNT(*) n FROM big').get() as { n: number }).n,
    };
    db.close();
    return JSON.stringify(state);
  };
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const execute = (connectionId: string, sql: string) =>
    request(app.getHttpServer()).post('/api/queries/execute').set(auth()).send({ connectionId, sql, confirmed: true });
  const ask = (connectionId: string, question = 'do it') =>
    request(app.getHttpServer()).post('/api/ai/ask').set(auth()).send({ connectionId, question });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.JWT_SECRET = 'test-access-secret-value-000000000000';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-value-11111111111';
    process.env.ENCRYPTION_KEY = 'f'.repeat(64);
    process.env.ALLOW_WRITE_QUERIES = 'true'; // worst case: the global switch is ON

    tmpDir = mkdtempSync(join(tmpdir(), 'sqlpilot-sec-'));
    process.env.SQLITE_ALLOWED_DIRS = tmpDir;
    dbPath = join(tmpDir, 'shop.sqlite');
    const db = new BetterSqlite3(dbPath);
    db.exec(`
      CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, spend REAL, note TEXT, joined TEXT);
      INSERT INTO customers (name, spend, note, joined) VALUES
        ('Ada', 500.25, NULL, '2026-01-31'), ('आरव शर्मा', 900, 'VIP', '2026-02-01'),
        ('Linus', 1234567.89, '₹ 1,25,000', NULL);
      CREATE TABLE big (n INTEGER PRIMARY KEY);
    `);
    const ins = db.prepare('INSERT INTO big VALUES (?)');
    db.transaction(() => {
      for (let i = 1; i <= 1500; i++) ins.run(i);
    })();
    db.close();

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        MongooseModule.forRoot(mongo.getUri()),
        CommonModule,
        AuditModule,
        UsersModule,
        AuthModule,
        DatabaseConnectionsModule,
        QueryHistoryModule,
        QueryExecutionModule,
        AiModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideProvider(AI_PROVIDER)
      .useValue(provider)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    await request(app.getHttpServer()).post('/api/auth/register').send({ name: 'Owner', email: 'sec-owner@example.com', password: 'Password123' });
    const client = await MongoClient.connect(mongo.getUri());
    await client.db().collection('users').updateOne({ email: 'sec-owner@example.com' }, { $set: { role: 'ADMIN' } });
    await client.close();
    token = (await request(app.getHttpServer()).post('/api/auth/login').send({ email: 'sec-owner@example.com', password: 'Password123' })).body.accessToken;

    const mk = async (name: string) =>
      (await request(app.getHttpServer()).post('/api/databases').set(auth()).send({ name, type: 'sqlite', database: 'shop', filePath: dbPath })).body.id as string;
    readOnlyConn = await mk('ReadOnly');
    writeEnabledConn = await mk('WriteEnabled');
    await request(app.getHttpServer()).patch(`/api/databases/${writeEnabledConn}/write-policy`).set(auth()).send({ enabled: true }).expect(200);
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  // ---------------------------------------------------------------------------------------------
  describe('destructive SQL is refused everywhere and never changes the database', () => {
    const attacks: Array<[string, string]> = [
      ['DROP', 'DROP TABLE customers'],
      ['DELETE', 'DELETE FROM customers'],
      ['UPDATE', "UPDATE customers SET name = 'pwned'"],
      ['INSERT', "INSERT INTO customers (name) VALUES ('evil')"],
      ['ALTER', 'ALTER TABLE customers ADD COLUMN evil TEXT'],
      ['TRUNCATE', 'TRUNCATE TABLE customers'],
      ['CREATE', 'CREATE TABLE evil (x INT)'],
      ['CREATE ... AS SELECT', 'CREATE TABLE copy AS SELECT * FROM customers'],
      ['SELECT INTO', 'SELECT * INTO evil FROM customers'],
      ['nested destructive (CTE)', 'WITH d AS (DELETE FROM customers RETURNING *) SELECT * FROM d'],
      ['destructive after WITH', 'WITH x AS (SELECT 1) DELETE FROM customers'],
      ['comment-hidden', 'DEL/**/ETE FROM customers'],
      ['comment stacking', 'SELECT 1 /* a */ ; /* b */ DROP TABLE customers'],
      ['line-comment stacking', 'SELECT 1 -- x\n; DROP TABLE customers'],
      ['multiple statements', 'SELECT 1; DELETE FROM customers'],
      ['multiple statements (semicolon only)', 'SELECT 1;;DROP TABLE customers'],
      ['PRAGMA', 'PRAGMA writable_schema = 1'],
      ['ATTACH', "ATTACH DATABASE ':memory:' AS x"],
      ['REPLACE', "REPLACE INTO customers (id, name) VALUES (1, 'evil')"],
      ['UPSERT', "INSERT INTO customers (id, name) VALUES (1, 'x') ON CONFLICT(id) DO UPDATE SET name = 'evil'"],
      ['transaction control', 'BEGIN; DELETE FROM customers; COMMIT'],
      ['VACUUM INTO', "VACUUM INTO '/tmp/stolen.db'"],
    ];

    it.each(attacks)('the SQL editor refuses %s (connection not write-enabled)', async (_label, sql) => {
      const before = snapshot();
      const res = await execute(readOnlyConn, sql);
      expect([400, 403]).toContain(res.status);
      expect(snapshot()).toBe(before);
    });

    it.each(attacks)('the SQL editor STILL refuses %s on a write-enabled connection (only single DML is ever allowed)', async (label, sql) => {
      const dml = ['DELETE', 'UPDATE', 'INSERT', 'REPLACE', 'UPSERT'].includes(label);
      if (dml) return; // a single, explicit DML statement is the one thing write mode permits; covered below
      const before = snapshot();
      const res = await execute(writeEnabledConn, sql);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(snapshot()).toBe(before);
    });

    it.each(attacks)('the AI assistant refuses %s even on a write-enabled connection (AI is always read-only)', async (_label, sql) => {
      const before = snapshot();
      provider.generated = [gen(sql)];
      const res = await ask(writeEnabledConn).expect(200);
      expect(res.body.success).toBe(false);
      expect(res.body.rows).toEqual([]);
      expect(res.body.error.code).toBe('UNSAFE_QUERY');
      expect(res.body.error.message).toBe('That request could not be run because it was not a safe, read-only question.');
      expect(res.body.sql).toBe('');
      expect(snapshot()).toBe(before);
    });

    it('write mode is narrow: one DML statement works for the editor, and only there', async () => {
      const ok = await execute(writeEnabledConn, "UPDATE customers SET note = 'edited' WHERE id = 1");
      expect(ok.status).toBe(200);
      expect(ok.body.rows).toEqual([{ changes: 1 }]);
      const db = new BetterSqlite3(dbPath);
      db.prepare('UPDATE customers SET note = NULL WHERE id = 1').run(); // restore the fixture
      db.close();

      provider.generated = [gen("UPDATE customers SET note = 'ai-edit' WHERE id = 1")];
      const viaAi = await ask(writeEnabledConn).expect(200);
      expect(viaAi.body.success).toBe(false);
      expect(viaAi.body.error.code).toBe('UNSAFE_QUERY');
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('dangerous functions and file access are refused', () => {
    it.each([
      "SELECT load_extension('evil.so')",
      "SELECT readfile('/etc/passwd')",
      "SELECT writefile('/tmp/x', 'y')",
      'SELECT zeroblob(2000000000)',
      'SELECT randomblob(2000000000)',
      "SELECT name FROM customers WHERE id = (SELECT length(readfile('/etc/passwd')))",
      "WITH x AS (SELECT load_extension('e')) SELECT * FROM x",
      "SELECT pg_read_file('/etc/passwd')",
      'SELECT pg_sleep(30)',
      'SELECT sleep(30)',
      'SELECT benchmark(100000000, md5(1))',
    ])('refuses %s', async (sql) => {
      const before = snapshot();
      const res = await execute(readOnlyConn, sql);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/not permitted|not allowed|could not be parsed/i);
      expect(snapshot()).toBe(before);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('huge and nested LIMIT never bypass the row cap', () => {
    it.each([
      ['a huge LIMIT', 'SELECT n FROM big LIMIT 999999999'],
      ['a huge LIMIT with OFFSET', 'SELECT n FROM big LIMIT 999999999 OFFSET 0'],
      ['no LIMIT at all', 'SELECT n FROM big'],
      ['LIMIT hidden in a subquery', 'SELECT * FROM (SELECT n FROM big LIMIT 1200)'],
      ['LIMIT hidden in a CTE', 'WITH s AS (SELECT n FROM big LIMIT 1400) SELECT * FROM s'],
      ['nested LIMITs', 'SELECT * FROM (SELECT * FROM (SELECT n FROM big LIMIT 1500) LIMIT 1300) LIMIT 1100'],
    ])('%s: the response is capped at 1,000 rows and says so', async (_label, sql) => {
      const res = await execute(readOnlyConn, sql).expect(200);
      expect(res.body.returnedRows).toBe(1000);
      expect(res.body.rows).toHaveLength(1000);
      expect(res.body.truncated).toBe(true);
    });

    it('a small LIMIT is honoured and is not called truncated', async () => {
      const res = await execute(readOnlyConn, 'SELECT n FROM big LIMIT 5').expect(200);
      expect(res.body).toMatchObject({ returnedRows: 5, truncated: false, totalRows: 5 });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('result sizes: 0, 1, 999, 1,000, 1,001 and 1,500 rows', () => {
    it.each([
      [0, 0, false, 0],
      [1, 1, false, 1],
      [999, 999, false, 999],
      [1000, 1000, false, 1000],
      [1001, 1000, true, 1001],
      [1500, 1000, true, 1500],
    ])('%i rows -> returned %i, truncated %s, total %s', async (available, returned, truncated, total) => {
      const res = await execute(readOnlyConn, `SELECT n FROM big WHERE n <= ${available} ORDER BY n`).expect(200);
      expect(res.body).toMatchObject({ returnedRows: returned, truncated, totalRows: total });
      expect(res.body.rows).toHaveLength(returned);
    });

    it.each([
      [0, 'empty', false],
      [1, 'single_value', false],
      [999, 'table', false],
      [1000, 'table', false],
      [1001, 'table', true],
      [1500, 'table', true],
    ])('the assistant handles %i rows: shape %s, truncated %s, and the answer never overstates', async (available, shape, truncated) => {
      provider.generated = [gen(`SELECT n FROM big WHERE n <= ${available} ORDER BY n`)];
      const res = await ask(readOnlyConn, 'list the numbers').expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.truncated).toBe(truncated);
      expect(res.body.returnedRows).toBe(Math.min(available, 1000));
      if (available > 1) expect(res.body.resultType).toBe(shape === 'table' ? 'table' : shape);
      if (available === 0) expect(res.body.explanation).toMatch(/no matching records/i);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('data fidelity over JSON: NULL, dates, decimals, rupee amounts, Hindi', () => {
    it('returns every value exactly as stored', async () => {
      const res = await execute(readOnlyConn, 'SELECT id, name, spend, note, joined FROM customers ORDER BY id').expect(200);
      expect(res.body.rows).toEqual([
        { id: 1, name: 'Ada', spend: 500.25, note: null, joined: '2026-01-31' },
        { id: 2, name: 'आरव शर्मा', spend: 900, note: 'VIP', joined: '2026-02-01' },
        { id: 3, name: 'Linus', spend: 1234567.89, note: '₹ 1,25,000', joined: null },
      ]);
    });

    it('keeps NULL distinct from an empty string and from zero', async () => {
      const res = await execute(readOnlyConn, "SELECT NULL AS a, '' AS b, 0 AS c").expect(200);
      expect(res.body.rows[0]).toEqual({ a: null, b: '', c: 0 });
    });

    it('a Hindi and rupee question round-trips through the assistant', async () => {
      provider.generated = [gen("SELECT name, note FROM customers WHERE note = '₹ 1,25,000'")];
      const res = await ask(readOnlyConn, 'कौन सा ग्राहक ₹ 1,25,000 वाला है?').expect(200);
      expect(res.body.rows).toEqual([{ name: 'Linus', note: '₹ 1,25,000' }]);
    });
  });
});
