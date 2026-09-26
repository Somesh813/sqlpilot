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

const gen = (sql: string) => ({
  intent: 'test', tablesUsed: [], sql, explanation: 'How it works.', assumptions: [], confidence: 0.9, warnings: [],
  unanswerable: false, unanswerableReason: null, visualization: { recommended: false, type: 'table', xField: null, yField: null },
});

class Scripted implements AiProvider {
  readonly name = 'scripted';
  generated: unknown[] = [];
  fixes: Array<{ fixedSql: string }> = [];
  answers: string[] = [];
  followUps: boolean[] = [];
  calls: Array<{ name: string; text: string }> = [];
  async complete(): Promise<never> {
    throw new Error('not used');
  }
  // eslint-disable-next-line require-yield
  async *streamComplete(): AsyncIterable<string> {
    throw new Error('not used');
  }
  async completeStructured<T>(req: { messages: Array<{ content: string }> }, _s: unknown, name: string): Promise<AiStructuredResult<T>> {
    this.calls.push({ name, text: req.messages.map((m) => m.content).join('\n') });
    let data: unknown;
    if (name === 'generated_sql') data = this.generated.shift();
    else if (name === 'follow_up_check') data = { followUp: this.followUps.shift() ?? false };
    else if (name === 'sql_fix') data = { ...(this.fixes.shift() ?? { fixedSql: '' }), diagnosis: 'x', changes: [], confidence: 0.8 };
    else if (name === 'result_answer') data = { answer: this.answers.shift() ?? 'Here are the results.' };
    if (data === undefined) throw new Error(`no scripted output for ${name}`);
    return { data: data as T, model: 'scripted', usage: null, raw: '' };
  }
}

/**
 * F17 (AI): multi-hop joins, a missing intermediate table, follow-ups that refine, filter and
 * un-filter, and contradictory answers, all against a real 5-table SQLite retail database.
 * Expected numbers are computed independently with direct SQL, never taken from the pipeline.
 */
describe('AI scenarios on a real multi-table database (e2e)', () => {
  let app: INestApplication;
  let mongo: MongoMemoryServer;
  let tmpDir: string;
  let dbPath: string;
  let token: string;
  let connectionId: string;
  const provider = new Scripted();

  const direct = <T = Record<string, unknown>>(sql: string): T[] => {
    const db = new BetterSqlite3(dbPath, { readonly: true });
    const rows = db.prepare(sql).all() as T[];
    db.close();
    return rows;
  };
  const ask = (question: string, conversationId?: string) =>
    request(app.getHttpServer())
      .post('/api/ai/ask')
      .set({ Authorization: `Bearer ${token}` })
      .send({ connectionId, question, conversationId });
  const promptOf = (name: string) => [...provider.calls].reverse().find((c) => c.name === name)!.text;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.JWT_SECRET = 'test-access-secret-value-000000000000';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-value-11111111111';
    process.env.ENCRYPTION_KEY = 'e'.repeat(64);
    tmpDir = mkdtempSync(join(tmpdir(), 'sqlpilot-scn-'));
    process.env.SQLITE_ALLOWED_DIRS = tmpDir;
    dbPath = join(tmpDir, 'retail.sqlite');
    const db = new BetterSqlite3(dbPath);
    db.exec(`
      CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, city TEXT);
      CREATE TABLE categories (id INTEGER PRIMARY KEY, title TEXT);
      CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, price REAL, category_id INTEGER REFERENCES categories(id));
      CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), created_at TEXT);
      CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id), product_id INTEGER REFERENCES products(id), quantity INTEGER, amount_inr REAL);
    `);
    const cities = ['Mumbai', 'Delhi', 'Pune', 'Mumbai', 'Chennai', 'Delhi', 'Mumbai', 'Pune'];
    cities.forEach((c, i) => db.prepare('INSERT INTO customers (name, city) VALUES (?, ?)').run(`Customer ${i + 1}`, c));
    ['Electronics', 'Books', 'Home'].forEach((t) => db.prepare('INSERT INTO categories (title) VALUES (?)').run(t));
    [['Phone', 30000, 1], ['Laptop', 60000, 1], ['Novel', 500, 2], ['Lamp', 1500, 3], ['Tablet', 20000, 1]].forEach(([n, p, c]) =>
      db.prepare('INSERT INTO products (name, price, category_id) VALUES (?, ?, ?)').run(n, p, c),
    );
    let order = 0;
    for (let cust = 1; cust <= 8; cust++) {
      for (let k = 0; k < cust; k++) {
        order++;
        db.prepare('INSERT INTO orders (customer_id, created_at) VALUES (?, ?)').run(cust, `2026-0${1 + (order % 4)}-1${k}`);
        const product = 1 + (order % 5);
        const qty = 1 + (order % 3);
        db.prepare('INSERT INTO order_items (order_id, product_id, quantity, amount_inr) VALUES (?, ?, ?, ?)').run(order, product, qty, qty * [30000, 60000, 500, 1500, 20000][product - 1]);
      }
    }
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
    const reg = await request(app.getHttpServer()).post('/api/auth/register').send({ name: 'O', email: 'scn@example.com', password: 'Password123' });
    token = reg.body.accessToken;
    const conn = await request(app.getHttpServer())
      .post('/api/databases')
      .set({ Authorization: `Bearer ${token}` })
      .send({ name: 'Retail', type: 'sqlite', database: 'retail', filePath: dbPath });
    connectionId = conn.body.id;
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  beforeEach(() => {
    provider.generated = [];
    provider.fixes = [];
    provider.answers = [];
    provider.followUps = [];
    provider.calls = [];
  });

  const REVENUE_BY_CATEGORY =
    'SELECT cat.title AS category, SUM(oi.amount_inr) AS revenue FROM customers c JOIN orders o ON o.customer_id = c.id JOIN order_items oi ON oi.order_id = o.id JOIN products p ON p.id = oi.product_id JOIN categories cat ON cat.id = p.category_id GROUP BY cat.title ORDER BY revenue DESC';

  it('MULTI-HOP: customers -> orders -> order_items -> products -> categories gives the true totals', async () => {
    provider.generated = [gen(REVENUE_BY_CATEGORY)];
    const res = await ask('Revenue by product category').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.autoFixed).toBe(false); // the schema check accepted the 5-table join as written
    expect(res.body.rows).toEqual(direct(REVENUE_BY_CATEGORY));
    expect(res.body.rows.length).toBe(3);
    // the model was given every table on the path (small schema: all of it)
    for (const table of ['customers', 'orders', 'order_items', 'products', 'categories']) expect(promptOf('generated_sql')).toContain(table);
  });

  it('MISSING INTERMEDIATE TABLE: a shortcut join is repaired with the right path and yields the true numbers', async () => {
    // order_items has no customer_id: the model skipped `orders`
    provider.generated = [gen('SELECT c.city, SUM(oi.amount_inr) AS revenue FROM customers c JOIN order_items oi ON oi.customer_id = c.id GROUP BY c.city ORDER BY revenue DESC')];
    const fixed = 'SELECT c.city, SUM(oi.amount_inr) AS revenue FROM customers c JOIN orders o ON o.customer_id = c.id JOIN order_items oi ON oi.order_id = o.id GROUP BY c.city ORDER BY revenue DESC';
    provider.fixes = [{ fixedSql: fixed }];
    const res = await ask('Revenue by city').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.autoFixed).toBe(true);
    expect(res.body.rows).toEqual(direct(fixed));
    const problem = promptOf('sql_fix');
    expect(problem).toContain('Column "customer_id" does not exist in table "order_items"');
    expect(problem).toMatch(/exists in: .*orders/); // points at the table that has it
  });

  it('HALLUCINATIONS: an invented table and an invented column are both caught and repaired', async () => {
    provider.generated = [gen('SELECT city, SUM(total_value) FROM sales GROUP BY city')];
    provider.fixes = [{ fixedSql: 'SELECT c.city, SUM(oi.amount_inr) FROM customers c JOIN orders o ON o.customer_id = c.id JOIN order_items oi ON oi.order_id = o.id GROUP BY c.city' }];
    const res = await ask('Sales by city').expect(200);
    expect(res.body.success).toBe(true);
    expect(promptOf('sql_fix')).toContain('Table "sales" does not exist');
  });

  it('FOLLOW-UP CHAIN: top N -> filter -> remove filter, each on the true data, each sent only the last exchange', async () => {
    const top = 'SELECT c.name, c.city, SUM(oi.amount_inr) AS spend FROM customers c JOIN orders o ON o.customer_id = c.id JOIN order_items oi ON oi.order_id = o.id GROUP BY c.id ORDER BY spend DESC LIMIT 5';
    provider.generated = [gen(top)];
    const first = await ask('Show the top 5 customers by spending').expect(200);
    const conversationId = first.body.conversationId as string;
    expect(first.body.rows).toEqual(direct(top));
    expect(first.body.returnedRows).toBe(5);

    // "Filter those to Mumbai": a refinement of the previous SQL
    const filtered = "SELECT c.name, c.city, SUM(oi.amount_inr) AS spend FROM customers c JOIN orders o ON o.customer_id = c.id JOIN order_items oi ON oi.order_id = o.id WHERE c.city = 'Mumbai' GROUP BY c.id ORDER BY spend DESC LIMIT 5";
    provider.followUps = [true];
    provider.generated = [gen(filtered)];
    const second = await ask('Filter those to Mumbai', conversationId).expect(200);
    expect(second.body.rows).toEqual(direct(filtered));
    expect(second.body.rows.every((r: { city: string }) => r.city === 'Mumbai')).toBe(true);
    expect(promptOf('generated_sql')).toContain('GROUP BY c.id ORDER BY spend DESC LIMIT 5'); // the previous SQL was supplied
    expect(promptOf('generated_sql')).not.toContain('Show the top 5 customers by spending, and'); // no accumulated chat

    // "Remove the filter": back to the unfiltered ranking
    provider.followUps = [true];
    provider.generated = [gen(top)];
    const third = await ask('Remove the filter', conversationId).expect(200);
    expect(third.body.rows).toEqual(direct(top));
    expect(third.body.rows.some((r: { city: string }) => r.city !== 'Mumbai')).toBe(true);
    expect(promptOf('generated_sql')).toContain("WHERE c.city = 'Mumbai'"); // it saw the filtered query it was asked to undo
  });

  it('a fresh question mid-conversation gets a clean slate (no earlier SQL leaks in)', async () => {
    provider.generated = [gen('SELECT COUNT(*) AS n FROM customers')];
    const first = await ask('How many customers are there?').expect(200);
    provider.followUps = [false];
    provider.generated = [gen('SELECT COUNT(*) AS n FROM products')];
    const second = await ask('How many products do we sell?', first.body.conversationId).expect(200);
    expect(second.body.rows).toEqual([{ n: 5 }]);
    expect(promptOf('generated_sql')).not.toContain('FROM customers');
  });

  it('CONTRADICTORY ANSWERS: wrong counts, wrong extremes and "no results" are replaced by the true statement', async () => {
    provider.generated = [gen('SELECT COUNT(*) AS total_customers FROM customers')];
    provider.answers = ['There are 5 customers.'];
    const wrongCount = await ask('How many customers?').expect(200);
    expect(wrongCount.body.explanation).toBe('Total customers: 8.');

    provider.generated = [gen("SELECT name, city FROM customers WHERE city = 'Mumbai' ORDER BY name")];
    provider.answers = ['No matching records were found.'];
    const denied = await ask('Customers from Mumbai').expect(200);
    expect(denied.body.returnedRows).toBe(3);
    expect(denied.body.explanation).not.toMatch(/no matching/i);
    expect(denied.body.explanation).toMatch(/3 rows/);

    provider.generated = [gen('SELECT p.name, p.price FROM products p ORDER BY p.price DESC')];
    provider.answers = ['The most expensive product is Phone at 30,000.'];
    const wrongMax = await ask('Most expensive product').expect(200);
    // the price 30,000 belongs to Phone, but the maximum is 60,000: the claim fails the check
    expect(wrongMax.body.explanation).toContain('Laptop');
    expect(wrongMax.body.explanation).toContain('60,000');
  });

  it('an honest, grounded answer is kept exactly as the model wrote it', async () => {
    provider.generated = [gen('SELECT COUNT(*) AS total_customers FROM customers')];
    provider.answers = ['You have 8 customers in total.'];
    const res = await ask('How many customers?').expect(200);
    expect(res.body.explanation).toBe('You have 8 customers in total.');
  });
});
