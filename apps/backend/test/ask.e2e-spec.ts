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
  /** Scripted follow-up classifier verdicts, consumed in order (default: not a follow-up). */
  followUps: boolean[] = [];
  classifierFails = false;
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
    if (name === 'generated_sql') data = this.generated.shift();
    else if (name === 'sql_fix') data = this.fixes.shift();
    else if (name === 'follow_up_check') {
      if (this.classifierFails) throw new Error('classifier down');
      data = { followUp: this.followUps.shift() ?? false };
    }
    else if (name === 'result_answer') {
      if (this.answerFails) throw new Error('summary model down');
      data = { answer: 'Stub answer from the actual rows.' };
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
    const path = join(tmpDir, 'shop.sqlite');
    const db = new BetterSqlite3(path);
    db.exec(`
      CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, city TEXT, email TEXT);
      CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id),
                           total REAL, status TEXT, created_at TEXT);
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
    provider.followUps = [];
  });

  const ask = (question: string, conversationId?: string) =>
    request(app.getHttpServer())
      .post('/api/ai/ask')
      .set({ Authorization: `Bearer ${token}` })
      .send({ connectionId, question, conversationId });

  it('"How many customers?" → real count, KPI, answer, no chart', async () => {
    provider.generated = [gen('SELECT COUNT(*) AS total_customers FROM customers')];
    const res = await ask('How many customers are there?').expect(200);
    expect(res.body).toMatchObject({
      success: true,
      columns: ['total_customers'],
      rows: [{ total_customers: 4 }],
      rowCount: 1,
      resultType: 'single_value',
      explanation: 'Stub answer from the actual rows.',
    });
    expect(res.body.visualization.type).toBe('kpi');
    expect(res.body.sql).toContain('COUNT');
    expect(res.body.historyId).toBeTruthy();
  });

  it('"Show all customers" → table only, real rows, no chart offered', async () => {
    provider.generated = [gen('SELECT name, email FROM customers ORDER BY name')];
    const res = await ask('Show all customers').expect(200);
    expect(res.body.rowCount).toBe(4);
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
    expect(res.body).toMatchObject({ success: true, rowCount: 0, resultType: 'empty' });
    expect(res.body.explanation).toBeTruthy();
    expect(res.body.availableViews).toEqual(['table']);
  });

  it('a failed AI summary falls back to a deterministic answer and keeps the data', async () => {
    provider.answerFails = true;
    provider.generated = [gen('SELECT COUNT(*) AS total_customers FROM customers')];
    const res = await ask('How many customers?').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.explanation).toBe('The result is 4.');
    expect(res.body.rows).toEqual([{ total_customers: 4 }]);
  });

  it('a DB error is repaired automatically once and the real result is returned', async () => {
    provider.generated = [gen('SELECT nme FROM customers')]; // typo → DB error
    provider.fixes = [{ fixedSql: 'SELECT name FROM customers', diagnosis: 'typo', changes: [], confidence: 0.9 }];
    const res = await ask('List customer names').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.autoFixed).toBe(true);
    expect(res.body.sql).toBe('SELECT name FROM customers');
    expect(res.body.rowCount).toBe(4);
  });

  it('an unrepairable DB error → friendly message + technical detail, not a blank reply', async () => {
    provider.generated = [gen('SELECT nme FROM customers')];
    provider.fixes = [{ fixedSql: 'SELECT still_wrong FROM customers', diagnosis: 'x', changes: [], confidence: 0.1 }];
    const res = await ask('List customer names').expect(200);
    expect(res.body.success).toBe(false);
    expect(res.body.error.stage).toBe('execution');
    expect(res.body.error.message).toMatch(/could not be executed/i);
    expect(res.body.error.technical).toMatch(/no such column/i);
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

  it('question the schema cannot answer → clear message, no query run', async () => {
    provider.generated = [
      gen('', { unanswerable: true, unanswerableReason: 'The data for that is not available in the current schema.' }),
    ];
    const res = await ask('What is the weather in Paris?').expect(200);
    expect(res.body).toMatchObject({ success: false, rowCount: 0 });
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
