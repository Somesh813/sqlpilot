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
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { AI_PROVIDER } from '../src/ai/ai-provider.factory';
import { AiModule } from '../src/ai/ai.module';
import { AuditModule } from '../src/audit/audit.module';
import { AuthModule } from '../src/auth/auth.module';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { CommonModule } from '../src/common/common.module';
import configuration from '../src/config/configuration';
import { DatabaseConnectionsModule } from '../src/database-connections/database-connections.module';
import { UsersModule } from '../src/users/users.module';

/** Model output shape for the 'generated_sql' schema. */
function gen(sql: string, extra: Record<string, unknown> = {}) {
  return {
    intent: 'test',
    tablesUsed: ['customers'],
    sql,
    explanation: 'How the query works.',
    assumptions: [],
    confidence: 0.9,
    warnings: [],
    unanswerable: false,
    unanswerableReason: null,
    visualization: { recommended: false, type: 'table', xField: null, yField: null },
    ...extra,
  };
}

/**
 * Scripted stand-in for the LLM. Everything downstream of it — schema context, policy
 * validation, real SQL execution against SQLite, result analysis, conversation storage —
 * is the production code path.
 */
class ScriptedProvider implements AiProvider {
  readonly name = 'scripted';
  generated: unknown[] = [];
  fixes: unknown[] = [];
  answerFails = false;
  /** Scripted answer wordings, consumed in order (default: a neutral sentence with no claims). */
  answers: string[] = [];
  /** Scripted follow-up classifier verdicts, consumed in order (default: not a follow-up). */
  followUps: boolean[] = [];
  classifierFails = false;
  /** When set, the next SQL generation throws this (consumed once). */
  generateError: unknown = null;
  calls: Array<{ name: string; messages: Array<{ role: string; content: string }> }> = [];

  async complete(): Promise<never> {
    throw new Error('not used');
  }
  // eslint-disable-next-line require-yield
  async *streamComplete(): AsyncIterable<string> {
    throw new Error('not used');
  }
  async completeStructured<T>(
    request: { messages: Array<{ role: string; content: string }> },
    _schema: unknown,
    name: string,
  ): Promise<AiStructuredResult<T>> {
    this.calls.push({ name, messages: request.messages });
    let data: unknown;
    if (name === 'generated_sql') {
      if (this.generateError) {
        const e = this.generateError;
        this.generateError = null;
        throw e;
      }
      data = this.generated.shift();
    }
    else if (name === 'sql_fix') data = this.fixes.shift();
    else if (name === 'follow_up_check') {
      if (this.classifierFails) throw new Error('classifier down');
      data = { followUp: this.followUps.shift() ?? false };
    }
    else if (name === 'result_answer') {
      if (this.answerFails) throw new Error('summary model down');
      data = { answer: this.answers.shift() ?? 'Stub answer from the actual rows.' };
    }
    if (data === undefined) throw new Error(`no scripted output for ${name}`);
    return { data: data as T, model: 'scripted', usage: null, raw: '' };
  }
}

describe('POST /ai/ask — natural language to real data (e2e)', () => {
  let app: INestApplication;
  let mongo: MongoMemoryServer;
  let token: string;
  let connectionId: string;
  let tmpDir: string;
  const provider = new ScriptedProvider();

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.JWT_SECRET = 'test-access-secret-value-000000000000';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-value-11111111111';
    process.env.ENCRYPTION_KEY = '1'.repeat(64);

    tmpDir = mkdtempSync(join(tmpdir(), 'sqlpilot-ask-'));
    process.env.SQLITE_ALLOWED_DIRS = tmpDir;
    const path = join(tmpDir, 'shop.sqlite');
    const db = new BetterSqlite3(path);
    db.exec(`
      CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, city TEXT, email TEXT);
      CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id),
                           total REAL, status TEXT, created_at TEXT);
    `);
    db.exec(`
      CREATE TABLE accounts (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT, api_token TEXT, plan TEXT);
      INSERT INTO accounts (username, password_hash, api_token, plan) VALUES
        ('ada', '$2b$12$abcdefghijklmnopqrstuv', 'tok_live_ABCDEFGHIJKLMNOP1234', 'pro'),
        ('grace', '$2b$12$zyxwvutsrqponmlkjihgfe', 'tok_live_QRSTUVWXYZ9876543210', 'free');
    `);
    db.exec(`INSERT INTO customers (name, city, email) VALUES
      ('Ada','Mumbai','ada@x.com'),('Grace','Mumbai','grace@x.com'),('Linus','Pune','linus@x.com'),
      ('Alan','Delhi','alan@x.com')`);
    db.exec(`INSERT INTO orders (customer_id, total, status, created_at) VALUES
      (1,500,'shipped','2026-01-05'),(2,900,'shipped','2026-01-20'),(2,300,'pending','2026-02-03'),
      (3,50,'cancelled','2026-02-14'),(1,700,'shipped','2026-03-01')`);
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
        AiModule,
      ],
      providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
    })
      .overrideProvider(AI_PROVIDER)
      .useValue(provider)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    const reg = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ name: 'Owner', email: 'ask-owner@example.com', password: 'Password123' });
    token = reg.body.accessToken;
    const conn = await request(app.getHttpServer())
      .post('/api/databases')
      .set({ Authorization: `Bearer ${token}` })
      .send({ name: 'Shop', type: 'sqlite', database: 'shop', filePath: path });
    connectionId = conn.body.id;
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    provider.generated = [];
    provider.fixes = [];
    provider.calls = [];
    provider.answerFails = false;
    provider.generateError = null;
    provider.followUps = [];
  });

  const ask = (question: string, conversationId?: string) =>
    request(app.getHttpServer())
      .post('/api/ai/ask')
      .set({ Authorization: `Bearer ${token}` })
      .send({ connectionId, question, conversationId });

  it('"How many customers?" → real count, KPI, answer, no chart', async () => {
    provider.generated = [gen('SELECT COUNT(*) AS total_customers FROM customers')];
    provider.answers = ['There are 4 customers.'];
    const res = await ask('How many customers are there?').expect(200);
    expect(res.body).toMatchObject({
      success: true,
      columns: ['total_customers'],
      rows: [{ total_customers: 4 }],
      returnedRows: 1,
      resultType: 'single_value',
      explanation: 'There are 4 customers.',
    });
    expect(res.body.visualization.type).toBe('kpi');
    expect(res.body.sql).toContain('COUNT');
    expect(res.body.historyId).toBeTruthy();
  });

  it('"Show all customers" → table only, real rows, no chart offered', async () => {
    provider.generated = [gen('SELECT name, email FROM customers ORDER BY name')];
    const res = await ask('Show all customers').expect(200);
    expect(res.body.returnedRows).toBe(4);
    expect(res.body.rows[0]).toEqual({ name: 'Ada', email: 'ada@x.com' });
    expect(res.body.availableViews).toEqual(['table']);
    expect(res.body.visualization.recommended).toBe(false);
  });

  it('"Top customers by spending" → bar chart built from the actual sums', async () => {
    provider.generated = [
      gen(
        `SELECT c.name AS customer_name, SUM(o.total) AS total_spending
         FROM customers c JOIN orders o ON o.customer_id = c.id
         GROUP BY c.name ORDER BY total_spending DESC`,
        { visualization: { recommended: true, type: 'bar', xField: 'customer_name', yField: 'total_spending' } },
      ),
    ];
    const res = await ask('Show the top customers by spending').expect(200);
    // Ada (500+700) and Grace (900+300) tie at 1200, so compare as a set; Linus is last.
    expect(res.body.rows).toHaveLength(3);
    expect(res.body.rows[2]).toEqual({ customer_name: 'Linus', total_spending: 50 });
    expect(res.body.rows.slice(0, 2).map((r: { total_spending: number }) => r.total_spending)).toEqual([1200, 1200]);
    expect(res.body.visualization).toMatchObject({
      recommended: true,
      type: 'bar',
      xColumn: 'customer_name',
      yColumns: ['total_spending'],
    });
    expect(res.body.availableViews).toEqual(expect.arrayContaining(['bar', 'pie', 'table']));
  });

  it('"Sales by month" → line chart on the time column', async () => {
    provider.generated = [
      gen(`SELECT substr(created_at,1,7) AS month, SUM(total) AS revenue FROM orders GROUP BY month ORDER BY month`),
    ];
    const res = await ask('Show sales by month').expect(200);
    expect(res.body.rows.map((r: { month: string }) => r.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(res.body.resultType).toBe('time_series');
    expect(res.body.visualization.type).toBe('line');
  });

  it('"Distribution of orders by status" → pie when it is a valid share-of-whole', async () => {
    provider.generated = [
      gen('SELECT status, COUNT(*) AS orders FROM orders GROUP BY status ORDER BY orders DESC', {
        visualization: { recommended: true, type: 'pie', xField: 'status', yField: 'orders' },
      }),
    ];
    const res = await ask('Show the distribution of orders by status').expect(200);
    expect(res.body.visualization.type).toBe('pie');
    expect(res.body.resultType).toBe('percentage_distribution');
  });

  it('"Customers from Mumbai" → filtered real rows', async () => {
    provider.generated = [gen("SELECT name, city FROM customers WHERE city = 'Mumbai'")];
    const res = await ask('Show customers from Mumbai').expect(200);
    expect(res.body.rows.map((r: { name: string }) => r.name)).toEqual(['Ada', 'Grace']);
  });

  it('zero rows → success with an explicit empty result, never a blank response', async () => {
    provider.generated = [gen("SELECT name FROM customers WHERE city = 'Atlantis'")];
    const res = await ask('Show customers from Atlantis').expect(200);
    expect(res.body).toMatchObject({ success: true, returnedRows: 0, resultType: 'empty' });
    expect(res.body.explanation).toBeTruthy();
    expect(res.body.availableViews).toEqual(['table']);
  });

  it('a failed AI summary falls back to a deterministic answer and keeps the data', async () => {
    provider.answerFails = true;
    provider.generated = [gen('SELECT COUNT(*) AS total_customers FROM customers')];
    const res = await ask('How many customers?').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.explanation).toBe('Total customers: 4.');
    expect(res.body.rows).toEqual([{ total_customers: 4 }]);
  });

  it('a misspelt column is caught before running and repaired, and the real result is returned', async () => {
    provider.generated = [gen('SELECT nme FROM customers')]; // typo → DB error
    provider.fixes = [{ fixedSql: 'SELECT name FROM customers', diagnosis: 'typo', changes: [], confidence: 0.9 }];
    const res = await ask('List customer names').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.autoFixed).toBe(true);
    expect(res.body.sql).toBe('SELECT name FROM customers');
    expect(res.body.returnedRows).toBe(4);
  });

  it('a runtime DB error the schema check cannot see is still repaired via the database error', async () => {
    provider.generated = [gen("SELECT json_extract(name, '$.a') AS a FROM customers")]; // names are not JSON: a runtime error
    provider.fixes = [{ fixedSql: 'SELECT name FROM customers', diagnosis: 'not json', changes: [], confidence: 0.9 }];
    const res = await ask('List customer names').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.autoFixed).toBe(true);
    const fixPrompt = provider.calls.filter((c) => c.name === 'sql_fix').map((c) => c.messages.map((m) => m.content).join(' '))[0];
    expect(fixPrompt).toMatch(/Database error/);
  });

  it('an unrepairable runtime DB error gives a friendly message and no technical detail to a normal user', async () => {
    provider.generated = [gen("SELECT json_extract(name, '$.a') AS a FROM customers")];
    provider.fixes = [
      { fixedSql: "SELECT json_extract(city, '$.b') AS b FROM customers", diagnosis: 'x', changes: [], confidence: 0.1 },
      { fixedSql: "SELECT json_extract(email, '$.c') AS c FROM customers", diagnosis: 'x', changes: [], confidence: 0.1 },
    ];
    const res = await ask('List customer names').expect(200);
    expect(res.body.success).toBe(false);
    expect(res.body.error.stage).toBe('execution');
    expect(res.body.error.message).toMatch(/could not run the query/i);
    expect(res.body.error.code).toBe('QUERY_FAILED');
    expect(res.body.error.technical).toBeNull(); // technical detail is for administrators only
    expect(res.body.explanation).toBeTruthy();
  });

  it('SECURITY: a destructive statement from the model is never executed', async () => {
    provider.generated = [gen('DROP TABLE customers')];
    const res = await ask('Delete all the customers').expect(200);
    expect(res.body.success).toBe(false);
    expect(res.body.sql).toBe('');
    // …and the table is still there:
    provider.generated = [gen('SELECT COUNT(*) AS n FROM customers')];
    const after = await ask('How many customers?').expect(200);
    expect(after.body.rows).toEqual([{ n: 4 }]);
  });

  it('SECURITY: an UPDATE is blocked too', async () => {
    provider.generated = [gen("UPDATE customers SET name = 'x'")];
    const res = await ask('Rename everyone').expect(200);
    expect(res.body.success).toBe(false);
  });

  it('F9: a model answer that contradicts the data (COUNT = 4 said as 2) is replaced by the true one', async () => {
    provider.generated = [gen('SELECT COUNT(*) AS total_customers FROM customers')];
    provider.answers = ['There are 2 customers.'];
    const res = await ask('How many customers are there?').expect(200);
    expect(res.body.rows).toEqual([{ total_customers: 4 }]);
    expect(res.body.explanation).toBe('Total customers: 4.');
    expect(res.body.explanation).not.toMatch(/2/);
  });

  it('F9: "no matching records" is never shown when rows came back', async () => {
    provider.generated = [gen("SELECT name, city FROM customers WHERE city = 'Pune'")];
    provider.answers = ['No matching records were found.'];
    const res = await ask('Filter those to Pune').expect(200);
    expect(res.body.returnedRows).toBe(1);
    expect(res.body.explanation).not.toMatch(/no matching/i);
    expect(res.body.explanation).toContain('Linus');
  });

  it('F9: a grounded model answer is kept as written', async () => {
    provider.generated = [gen("SELECT name, city FROM customers WHERE city = 'Mumbai' ORDER BY name")];
    provider.answers = ['Two customers are in Mumbai: Ada and Grace.'];
    const res = await ask('Show customers from Mumbai').expect(200);
    expect(res.body.explanation).toBe('Two customers are in Mumbai: Ada and Grace.');
  });

  it('an empty result gets the deterministic sentence without asking the model', async () => {
    provider.generated = [gen("SELECT name FROM customers WHERE city = 'Atlantis'")];
    const before = provider.calls.length;
    const res = await ask('Customers in Atlantis').expect(200);
    expect(res.body.explanation).toBe('No matching records were found.');
    expect(provider.calls.slice(before).map((c) => c.name)).not.toContain('result_answer');
  });

  describe('F16: generated SQL is checked against the schema before it runs', () => {
    const fixPrompts = () => provider.calls.filter((c) => c.name === 'sql_fix').map((c) => c.messages.map((m) => m.content).join('\n'));
    const fix = (sql: string) => ({ fixedSql: sql, diagnosis: 'x', changes: [], confidence: 0.8 });

    it('a hallucinated table is repaired using a structured problem with the closest real name', async () => {
      provider.generated = [gen('SELECT name FROM custmers')];
      provider.fixes = [fix('SELECT name FROM customers')];
      const res = await ask('List customer names').expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.autoFixed).toBe(true);
      expect(res.body.sql).toBe('SELECT name FROM customers');
      expect(fixPrompts()).toHaveLength(1);
      expect(fixPrompts()[0]).toContain('The query was NOT run');
      expect(fixPrompts()[0]).toContain('Table "custmers" does not exist');
      expect(fixPrompts()[0]).toContain('Did you mean: customers');
    });

    it('a hallucinated column says where the real one lives (a table that may need joining)', async () => {
      provider.generated = [gen('SELECT c.name, o.city FROM customers c JOIN orders o ON o.customer_id = c.id')];
      provider.fixes = [fix('SELECT c.name, c.city FROM customers c')];
      const res = await ask('Names with cities').expect(200);
      expect(res.body.success).toBe(true);
      expect(fixPrompts()[0]).toContain('Column "city" does not exist in table "orders"');
      expect(fixPrompts()[0]).toContain('exists in: customers');
    });

    it('the repaired SQL is checked again: a second bad repair is repaired once more, then it works', async () => {
      provider.generated = [gen('SELECT name FROM custmers')];
      provider.fixes = [fix('SELECT nme FROM customers'), fix('SELECT name FROM customers')];
      const res = await ask('List customer names').expect(200);
      expect(res.body.success).toBe(true);
      expect(fixPrompts()).toHaveLength(2);
      expect(fixPrompts()[1]).toContain('Column "nme" does not exist');
    });

    it('stops after two repairs and never loops, even when more fixes are on offer', async () => {
      provider.generated = [gen('SELECT name FROM custmers')];
      provider.fixes = [fix('SELECT name FROM cust'), fix('SELECT name FROM custs'), fix('SELECT name FROM customers')];
      const res = await ask('List customer names').expect(200);
      expect(fixPrompts()).toHaveLength(2);
      expect(provider.fixes).toHaveLength(1); // the third was never requested
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('SCHEMA_MISMATCH');
      expect(res.body.error.message).toMatch(/could not match that request/i);
      expect(res.body.rows).toEqual([]);
    });

    it('stops at once when a repair makes no progress (returns the same SQL)', async () => {
      provider.generated = [gen('SELECT nme FROM customers')];
      provider.fixes = [fix('SELECT nme FROM customers'), fix('SELECT name FROM customers')];
      const res = await ask('List customer names').expect(200);
      expect(fixPrompts()).toHaveLength(1);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('SCHEMA_MISMATCH');
    });

    it('a repair that goes back to SQL already tried is treated as no progress', async () => {
      provider.generated = [gen('SELECT nme FROM customers')];
      provider.fixes = [fix('SELECT nam FROM customers'), fix('SELECT   nme  FROM customers;')];
      const res = await ask('List customer names').expect(200);
      expect(fixPrompts()).toHaveLength(2);
      expect(res.body.success).toBe(false);
    });

    it('the schema-repair budget is shared with database-error repairs (two in total)', async () => {
      provider.generated = [gen('SELECT nme FROM customers')];
      provider.fixes = [
        fix("SELECT json_extract(name, '$.a') AS a FROM customers"),
        fix("SELECT json_extract(city, '$.b') AS b FROM customers"),
        fix('SELECT name FROM customers'),
      ];
      const res = await ask('List customer names').expect(200);
      expect(fixPrompts()).toHaveLength(2);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('QUERY_FAILED');
    });

    it('system tables are not queryable through the assistant', async () => {
      provider.generated = [gen('SELECT name FROM sqlite_master')];
      provider.fixes = [];
      const res = await ask('What tables exist?').expect(200);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('SCHEMA_MISMATCH');
      expect(res.body.rows).toEqual([]);
    });

    it('valid multi-table SQL is not delayed or altered by the check', async () => {
      provider.generated = [
        gen('SELECT c.name, SUM(o.total) AS spend FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.name ORDER BY spend DESC'),
      ];
      const res = await ask('Top customers by spending').expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.autoFixed).toBe(false);
      expect(fixPrompts()).toHaveLength(0);
    });

    it('an ordinary user gets no technical detail about which names were wrong', async () => {
      provider.generated = [gen('SELECT nme FROM customers')];
      provider.fixes = [];
      const res = await ask('List customer names').expect(200);
      expect(res.body.error.technical).toBeNull();
    });
  });

  describe('F15: what is sent to the model', () => {
    const lastCall = (name: string) => [...provider.calls].reverse().find((c) => c.name === name)!;
    const promptText = (name: string) => lastCall(name).messages.map((m) => m.content).join('\n---\n');

    it('the SQL model is never shown secret-holding columns, so it cannot select them', async () => {
      provider.generated = [gen('SELECT username, plan FROM accounts')];
      await ask('Which plan is each account on?').expect(200);
      const prompt = promptText('generated_sql');
      expect(prompt).toContain('accounts');
      expect(prompt).toContain('username');
      expect(prompt).not.toMatch(/password_hash|api_token/);
    });

    it('SELECT * on a table with secrets: the user sees the real rows, the answer model does not', async () => {
      provider.generated = [gen('SELECT * FROM accounts')];
      provider.answers = ['There are 2 accounts.'];
      const res = await ask('Show all accounts').expect(200);
      expect(res.body.rows[0].password_hash).toMatch(/^\$2b\$/); // the user's own data is untouched
      const sent = promptText('result_answer');
      expect(sent).not.toMatch(/\$2b\$|tok_live|password_hash|api_token/);
      expect(sent).toContain('ada');
    });

    it('contact details are shown to the user but only placeholders reach the answer model', async () => {
      provider.generated = [gen('SELECT name, email FROM customers ORDER BY name')];
      const res = await ask('List customers with their email').expect(200);
      expect(res.body.rows[0].email).toBe('ada@x.com');
      const sent = promptText('result_answer');
      expect(sent).not.toMatch(/@x\.com/);
      expect(sent).toContain('[hidden]');
    });

    it('a follow-up sends the earlier SQL but never the earlier answer (which quotes result data)', async () => {
      provider.generated = [gen("SELECT name, city FROM customers WHERE city = 'Mumbai'")];
      provider.answers = ['Ada and Grace live in Mumbai.'];
      const first = await ask('Show customers from Mumbai').expect(200);
      provider.followUps = [true];
      provider.generated = [gen("SELECT name FROM customers WHERE city = 'Mumbai' LIMIT 1")];
      await ask('Only the first one', first.body.conversationId).expect(200);
      const prompt = promptText('generated_sql');
      expect(prompt).toContain("WHERE city = 'Mumbai'"); // the query is what a refinement needs
      expect(prompt).not.toContain('Ada and Grace live in Mumbai');
    });
  });


  describe('F11/F12: failures are safe for users and never leak internals', () => {
    const LEAKY_429 =
      'groq request failed (429): 429 Rate limit reached for model `openai/gpt-oss-120b` in organization `org_01abcXYZ789` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 7900. Please try again in 2.5s.';
    const FORBIDDEN = /org_01abcXYZ789|groq|gpt-oss|on_demand|Limit 8000|tokens per minute|stack|\bat\s+\S+\s+\(|[A-Z]:\\|\/home\/|\/etc\/|ECONN|password/i;

    let adminToken: string;
    let adminConnectionId: string;
    const askAs = (t: string, cid: string, question: string) =>
      request(app.getHttpServer()).post('/api/ai/ask').set({ Authorization: `Bearer ${t}` }).send({ connectionId: cid, question });

    beforeAll(async () => {
      const { MongoClient } = await import('mongodb');
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({ name: 'Admin', email: 'ask-admin@example.com', password: 'Password123' });
      const client = await MongoClient.connect(mongo.getUri());
      await client.db().collection('users').updateOne({ email: 'ask-admin@example.com' }, { $set: { role: 'ADMIN' } });
      await client.close();
      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'ask-admin@example.com', password: 'Password123' });
      adminToken = login.body.accessToken;
      const conn = await request(app.getHttpServer())
        .post('/api/databases')
        .set({ Authorization: `Bearer ${adminToken}` })
        .send({ name: 'Shop', type: 'sqlite', database: 'shop', filePath: join(tmpDir, 'shop.sqlite') });
      adminConnectionId = conn.body.id;
    });

    it('a provider rate limit becomes the friendly message: no org id, model, provider or limits', async () => {
      const { AiProviderError } = await import('@sqlpilot/ai');
      provider.generateError = new AiProviderError(LEAKY_429, undefined, true, 'RATE_LIMITED', 429);
      const res = await ask('Show all customers').expect(200);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('AI_BUSY');
      expect(res.body.error.message).toBe('AI service is temporarily busy. Please try again in a moment.');
      expect(res.body.explanation).toBe(res.body.error.message);
      expect(res.body.error.technical).toBeNull();
      expect(JSON.stringify(res.body)).not.toMatch(FORBIDDEN);
    });

    it('administrators get a coded, scrubbed technical line: still no org id or provider text', async () => {
      const { AiProviderError } = await import('@sqlpilot/ai');
      provider.generateError = new AiProviderError(LEAKY_429, undefined, true, 'RATE_LIMITED', 429);
      const res = await askAs(adminToken, adminConnectionId, 'Show all customers').expect(200);
      expect(res.body.error.message).toBe('AI service is temporarily busy. Please try again in a moment.');
      expect(res.body.error.technical).toBe('AI provider error: RATE_LIMITED (HTTP 429)');
      expect(JSON.stringify(res.body)).not.toMatch(FORBIDDEN);
    });

    it.each([
      ['TIMEOUT', 'AI_TIMEOUT', /took too long/],
      ['UNAVAILABLE', 'AI_UNAVAILABLE', /temporarily unavailable/],
      ['NOT_CONFIGURED', 'AI_NOT_CONFIGURED', /contact your administrator/],
    ])('%s maps to %s', async (aiCode, safeCode, pattern) => {
      const { AiProviderError } = await import('@sqlpilot/ai');
      provider.generateError = new AiProviderError('401 Incorrect API key provided: gsk_live_abcdefghijklmnop1234', undefined, false, aiCode as never, 401);
      const res = await ask('Show all customers').expect(200);
      expect(res.body.error.code).toBe(safeCode);
      expect(res.body.error.message).toMatch(pattern);
      expect(JSON.stringify(res.body)).not.toMatch(/gsk_|API key|401/i);
    });

    it('an unreachable database says so plainly, does not try to "repair" the SQL, and leaks no path', async () => {
      const path = join(tmpDir, 'vanishing.sqlite');
      const db = new BetterSqlite3(path);
      db.exec("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO customers (name) VALUES ('Ada')");
      db.close();
      const conn = await request(app.getHttpServer())
        .post('/api/databases')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'Vanishing', type: 'sqlite', database: 'v', filePath: path })
        .expect(201);
      await request(app.getHttpServer()).get(`/api/databases/${conn.body.id}/schema`).set({ Authorization: `Bearer ${token}` }).expect(200);
      rmSync(path); // the database goes away after its schema was cached

      provider.generated = [gen('SELECT name FROM customers')];
      provider.fixes = [{ fixedSql: 'SELECT name FROM customers', diagnosis: 'x', changes: [], confidence: 1 }];
      const res = await askAs(token, conn.body.id, 'List customers').expect(200);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('DB_UNAVAILABLE');
      expect(res.body.error.message).toBe('The database connection is unavailable. Please check the connection and try again.');
      expect(res.body.error.technical).toBeNull();
      expect(provider.calls.map((c) => c.name)).not.toContain('sql_fix');
      expect(JSON.stringify(res.body)).not.toMatch(/vanishing|sqlpilot-ask|ENOENT|[A-Z]:\\|\/tmp\/|AppData/i);
    });

    it('the REST endpoints use the same wording for an unreachable database', async () => {
      const list = await request(app.getHttpServer()).get('/api/databases').set({ Authorization: `Bearer ${token}` });
      const vanishing = list.body.find((c: { name: string }) => c.name === 'Vanishing');
      const res = await request(app.getHttpServer())
        .post('/api/queries/execute')
        .set({ Authorization: `Bearer ${token}` })
        .send({ connectionId: vanishing.id, sql: 'SELECT 1', confirmed: true })
        .expect(503);
      expect(res.body.code).toBe('DB_UNAVAILABLE');
      expect(res.body.message).toMatch(/connection is unavailable/);
      expect(JSON.stringify(res.body)).not.toMatch(/vanishing|ENOENT|[A-Z]:\\|\/tmp\/|AppData/i);
    });

    it('a rejected statement in the SQL editor shows a scrubbed database message', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/queries/execute')
        .set({ Authorization: `Bearer ${token}` })
        .send({ connectionId, sql: 'SELECT nme FROM customers', confirmed: true })
        .expect(422);
      expect(res.body.code).toBe('QUERY_FAILED');
      expect(res.body.databaseError).toMatch(/no such column/i);
    });
  });

  it('question the schema cannot answer → clear message, no query run', async () => {
    provider.generated = [
      gen('', { unanswerable: true, unanswerableReason: 'The data for that is not available in the current schema.' }),
    ];
    const res = await ask('What is the weather in Paris?').expect(200);
    expect(res.body).toMatchObject({ success: false, returnedRows: 0 });
    expect(res.body.error.stage).toBe('generation');
    expect(res.body.explanation).toMatch(/not available/i);
  });

  it('FOLLOW-UP: a real follow-up receives the previous question and its SQL', async () => {
    provider.generated = [gen('SELECT city, COUNT(*) AS customers FROM customers GROUP BY city')];
    const first = await ask('Show customers by city').expect(200);
    const conversationId = first.body.conversationId as string;
    expect(conversationId).toBeTruthy();

    provider.generated = [gen("SELECT city, COUNT(*) AS customers FROM customers WHERE city = 'Mumbai' GROUP BY city")];
    provider.followUps = [true];
    provider.calls = [];
    const second = await ask('Only Mumbai', conversationId).expect(200);
    expect(second.body.conversationId).toBe(conversationId);
    expect(second.body.rows).toEqual([{ city: 'Mumbai', customers: 2 }]);

    const prompt = provider.calls.find((c) => c.name === 'generated_sql')!.messages.map((m) => m.content).join('\n');
    expect(prompt).toContain('Show customers by city'); // earlier question
    expect(prompt).toContain('GROUP BY city'); // earlier SQL
  });

  it('REGRESSION: a fresh question in a long chat gets NO earlier context (no accumulating UNIONs)', async () => {
    // Shown a previous query, the model extended it — every answer inherited the last one's UNION.
    // Context is now sent only when the classifier says the message is a follow-up.
    provider.generated = [gen('SELECT city, COUNT(*) AS customers FROM customers GROUP BY city')];
    const first = await ask('Show customers by city').expect(200);
    const conversationId = first.body.conversationId as string;

    provider.generated = [gen('SELECT COUNT(*) AS total_orders FROM orders')];
    provider.followUps = [false]; // "How many orders are there?" stands on its own
    provider.calls = [];
    const fresh = await ask('How many orders are there?', conversationId).expect(200);
    expect(fresh.body.rows).toEqual([{ total_orders: 5 }]);

    expect(provider.calls.map((c) => c.name)).toEqual(['follow_up_check', 'generated_sql', 'result_answer']);
    const prompt = provider.calls.find((c) => c.name === 'generated_sql')!.messages.map((m) => m.content).join('\n');
    expect(prompt).not.toContain('Show customers by city');
    expect(prompt).not.toContain('GROUP BY city');
    expect(prompt).not.toContain('PREVIOUS EXCHANGE');
  });

  it('only the LAST exchange is offered even for a follow-up', async () => {
    provider.generated = [gen('SELECT city FROM customers GROUP BY city')];
    const a = await ask('Show all cities').expect(200);
    const id = a.body.conversationId as string;
    provider.generated = [gen('SELECT COUNT(*) AS n FROM orders')];
    await ask('How many orders?', id).expect(200);

    provider.generated = [gen('SELECT COUNT(*) AS n FROM orders WHERE total > 100')];
    provider.followUps = [true];
    provider.calls = [];
    await ask('Only those over 100', id).expect(200);
    const prompt = provider.calls.find((c) => c.name === 'generated_sql')!.messages.map((m) => m.content).join('\n');
    expect(prompt).toContain('How many orders?');
    expect(prompt).not.toContain('Show all cities');
  });

  it('a failed follow-up check falls back to a heuristic instead of failing the request', async () => {
    provider.generated = [gen('SELECT city FROM customers GROUP BY city')];
    const a = await ask('Show all cities').expect(200);
    provider.classifierFails = true;
    provider.generated = [gen('SELECT COUNT(*) AS n FROM customers')];
    const res = await ask('How many customers are there?', a.body.conversationId).expect(200);
    expect(res.body.success).toBe(true);
    provider.classifierFails = false;
  });

  it('validates input and requires authentication', async () => {
    await request(app.getHttpServer()).post('/api/ai/ask').send({ connectionId, question: 'hi there' }).expect(401);
    await ask('x').expect(400);
  });

  it("cannot ask about another user's connection", async () => {
    const other = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ name: 'Other', email: 'ask-other@example.com', password: 'Password123' });
    provider.generated = [gen('SELECT 1 AS x')];
    await request(app.getHttpServer())
      .post('/api/ai/ask')
      .set({ Authorization: `Bearer ${other.body.accessToken}` })
      .send({ connectionId, question: 'How many customers?' })
      .expect(404);
  });
});
