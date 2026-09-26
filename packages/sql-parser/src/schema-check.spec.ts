import { checkAgainstSchema, closest, describeIssues, SchemaLike } from './schema-check';
import { ParserDialect } from './dialect';

const table = (name: string, ...columns: string[]) => ({ name, columns: columns.map((c) => ({ name: c })) });
const schema: SchemaLike = {
  tables: [
    table('customers', 'id', 'name', 'city', 'email', 'created_at'),
    table('orders', 'id', 'customer_id', 'status', 'total', 'created_at'),
    table('order_items', 'id', 'order_id', 'product_id', 'quantity', 'amount_inr'),
    table('products', 'id', 'name', 'price', 'category_id'),
    table('categories', 'id', 'title'),
  ],
};

const check = (sql: string, dialect: ParserDialect = 'postgresql') => checkAgainstSchema(sql, schema, dialect, 'shop');
const issuesOf = (sql: string, dialect: ParserDialect = 'postgresql') => check(sql, dialect).issues;

describe('valid queries are never flagged', () => {
  const valid: Array<[ParserDialect, string]> = [
    ['postgresql', 'SELECT COUNT(*) AS total_customers FROM customers'],
    ['postgresql', 'SELECT id, name, city, email, created_at FROM customers'],
    ['postgresql', "SELECT c.name, SUM(o.total) AS spend FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.city = 'Mumbai' GROUP BY c.name ORDER BY spend DESC LIMIT 10"],
    ['postgresql', 'SELECT name, total FROM customers JOIN orders ON orders.customer_id = customers.id'],
    // multi-hop: customers -> orders -> order_items -> products -> categories
    ['postgresql', 'SELECT cat.title, SUM(oi.amount_inr) FROM customers c JOIN orders o ON o.customer_id = c.id JOIN order_items oi ON oi.order_id = o.id JOIN products p ON p.id = oi.product_id JOIN categories cat ON cat.id = p.category_id GROUP BY cat.title'],
    ['postgresql', 'WITH t AS (SELECT customer_id, SUM(total) AS s FROM orders GROUP BY customer_id) SELECT c.name, t.s FROM customers c JOIN t ON t.customer_id = c.id'],
    ['postgresql', 'SELECT x.cnt FROM (SELECT COUNT(*) AS cnt FROM orders) x'],
    ['postgresql', 'SELECT s.customer_id, s.total_spend FROM (SELECT customer_id, SUM(total) AS total_spend FROM orders GROUP BY customer_id) s ORDER BY s.total_spend DESC'],
    ['postgresql', "SELECT date_trunc('month', created_at)::date AS month, count(*) AS orders FROM orders GROUP BY 1 ORDER BY 1"],
    ['postgresql', 'SELECT name, ROW_NUMBER() OVER (PARTITION BY city ORDER BY id DESC) AS rn FROM customers'],
    ['postgresql', 'SELECT name FROM customers WHERE id IN (SELECT customer_id FROM orders WHERE total > 500)'],
    ['postgresql', 'SELECT a.name FROM customers a WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = a.id)'],
    ['postgresql', 'SELECT name FROM customers UNION SELECT title FROM categories'],
    ['postgresql', 'SELECT * FROM public.customers'],
    ['postgresql', 'SELECT c.* FROM customers c'],
    ['postgresql', "SELECT count(*) FILTER (WHERE status = 'shipped') AS shipped FROM orders"],
    ['postgresql', "SELECT * FROM orders WHERE created_at >= now() - interval '30 days'"],
    ['postgresql', 'SELECT CURRENT_DATE AS today, 1 AS one, true AS yes'],
    ['postgresql', 'SELECT COUNT(*) FROM CUSTOMERS'],
    ['postgresql', 'SELECT "Name" FROM Customers'],
    ['postgresql', 'SELECT city, COUNT(*) AS n FROM customers GROUP BY city HAVING COUNT(*) > 1 ORDER BY n DESC'],
    ['postgresql', 'SELECT o.id FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id WHERE oi.id IS NULL'],
    ['mysql', 'SELECT `c`.`name`, COUNT(*) AS n FROM `customers` AS `c` GROUP BY `c`.`name` HAVING n > 1'],
    ['mysql', "SELECT DATE_FORMAT(created_at, '%Y-%m') AS m, SUM(total) FROM orders GROUP BY m"],
    ['mysql', 'SELECT shop.customers.name FROM shop.customers'],
    ['sqlite', "SELECT strftime('%Y-%m', created_at) AS m, SUM(total) FROM orders GROUP BY m"],
    ['sqlite', 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10) SELECT x FROM c'],
    ['sqlite', 'SELECT COUNT(DISTINCT customer_id) FROM orders'],
  ];
  it.each(valid)('[%s] %s', (dialect, sql) => {
    const r = check(sql, dialect);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe('hallucinated tables', () => {
  it('flags a table that does not exist and suggests the real one', () => {
    const [issue] = issuesOf('SELECT name FROM custmers');
    expect(issue).toMatchObject({ type: 'unknown_table', table: 'custmers' });
    expect((issue as { suggestions: string[] }).suggestions).toContain('customers');
  });

  it.each([
    'SELECT * FROM users',
    'SELECT * FROM customer_orders',
    'SELECT * FROM sales',
  ])('flags %s', (sql) => {
    expect(issuesOf(sql)[0]).toMatchObject({ type: 'unknown_table' });
  });

  it('flags a hallucinated table in a JOIN while accepting the real ones', () => {
    const issues = issuesOf('SELECT c.name FROM customers c JOIN purchases p ON p.customer_id = c.id');
    expect(issues.map((i) => (i as { table: string }).table)).toEqual(['purchases']);
  });

  it('flags a hallucinated table hidden in a subquery or CTE body', () => {
    expect(issuesOf('SELECT name FROM customers WHERE id IN (SELECT customer_id FROM purchases)')[0]).toMatchObject({ type: 'unknown_table', table: 'purchases' });
    expect(issuesOf('WITH x AS (SELECT * FROM ghosts) SELECT * FROM x')[0]).toMatchObject({ type: 'unknown_table', table: 'ghosts' });
  });

  it('flags a qualified reference to something that is not in the query at all', () => {
    expect(issuesOf('SELECT foo.name FROM customers')).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'unknown_table', table: 'foo' })]),
    );
  });

  it('rejects system catalogs and other schemas: only the connected data is queryable', () => {
    for (const sql of [
      'SELECT * FROM information_schema.tables',
      'SELECT * FROM pg_catalog.pg_tables',
      'SELECT * FROM pg_shadow',
      'SELECT * FROM other_schema.customers',
    ]) {
      expect(issuesOf(sql)[0]).toMatchObject({ type: 'unknown_table' });
    }
    expect(issuesOf('SELECT * FROM sqlite_master', 'sqlite')[0]).toMatchObject({ type: 'unknown_table' });
    expect(issuesOf('SELECT * FROM mysql.user', 'mysql')[0]).toMatchObject({ type: 'unknown_table' });
  });
});

describe('hallucinated columns', () => {
  it('flags an unqualified column that is in none of the tables used', () => {
    const [issue] = issuesOf('SELECT nme FROM customers');
    expect(issue).toMatchObject({ type: 'unknown_column', column: 'nme', table: null, searched: ['customers'] });
    expect((issue as { suggestions: string[] }).suggestions).toContain('name');
  });

  it('flags a qualified column, resolving the alias to the real table', () => {
    const [issue] = issuesOf('SELECT c.nme FROM customers c');
    expect(issue).toMatchObject({ type: 'unknown_column', column: 'nme', table: 'customers' });
  });

  it('flags a made-up measure column', () => {
    expect(issuesOf('SELECT SUM(revenue) FROM orders')[0]).toMatchObject({ type: 'unknown_column', column: 'revenue' });
    expect(issuesOf('SELECT city, AVG(order_value) FROM customers GROUP BY city')[0]).toMatchObject({ type: 'unknown_column', column: 'order_value' });
  });

  it('flags bad columns in WHERE, GROUP BY, ORDER BY and JOIN conditions', () => {
    for (const sql of [
      "SELECT name FROM customers WHERE town = 'Mumbai'",
      'SELECT COUNT(*) FROM customers GROUP BY town',
      'SELECT name FROM customers ORDER BY signup_date',
      'SELECT c.name FROM customers c JOIN orders o ON o.cust_id = c.id',
    ]) {
      expect(issuesOf(sql).some((i) => i.type === 'unknown_column')).toBe(true);
    }
  });

  it('does not treat select aliases as unknown columns', () => {
    expect(issuesOf('SELECT SUM(total) AS spend FROM orders ORDER BY spend DESC')).toEqual([]);
    expect(issuesOf('SELECT city AS town FROM customers GROUP BY town')).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(issuesOf('SELECT NAME, City FROM CUSTOMERS')).toEqual([]);
  });
});

describe('missing intermediate table (multi-hop)', () => {
  it('reports which table actually has the column, so the repair can add the JOIN', () => {
    // order_items has no customer_id; orders does
    const issues = issuesOf('SELECT c.name, SUM(oi.amount_inr) FROM customers c JOIN order_items oi ON oi.customer_id = c.id GROUP BY c.name');
    const issue = issues.find((i) => i.type === 'unknown_column') as Extract<(typeof issues)[number], { type: 'unknown_column' }>;
    expect(issue).toMatchObject({ column: 'customer_id', table: 'order_items' });
    expect(issue.foundIn).toContain('orders');
  });

  it('reports a column used without the table that owns it being joined at all', () => {
    const issues = issuesOf('SELECT c.name, amount_inr FROM customers c');
    const issue = issues.find((i) => i.type === 'unknown_column') as Extract<(typeof issues)[number], { type: 'unknown_column' }>;
    expect(issue.column).toBe('amount_inr');
    expect(issue.foundIn).toEqual(['order_items']);
  });

  it('describeIssues renders a hint the model can act on', () => {
    const text = describeIssues(issuesOf('SELECT c.name, amount_inr FROM customers c'));
    expect(text).toContain('"amount_inr" does not exist');
    expect(text).toContain('order_items');
    expect(text).toContain('may need to be joined');
  });
});

describe('robustness', () => {
  it('does not run when nothing is known about the schema (the database decides)', () => {
    const r = checkAgainstSchema('SELECT x FROM y', { tables: [] }, 'postgresql');
    expect(r).toMatchObject({ ok: true, skipped: expect.stringContaining('no schema') });
  });

  it('does not throw or block on SQL it cannot analyse', () => {
    const r = check('SELEKT * FROM customers');
    expect(r.ok).toBe(true);
    expect(r.skipped).toContain('could not be analysed');
  });

  it('reports each problem once', () => {
    const issues = issuesOf('SELECT nme, nme FROM customers WHERE nme IS NOT NULL');
    expect(issues.filter((i) => i.type === 'unknown_column')).toHaveLength(1);
  });

  it('handles a large schema quickly', () => {
    const big: SchemaLike = { tables: Array.from({ length: 500 }, (_, i) => table(`t${i}`, 'id', 'a', 'b', 'c')) };
    const started = Date.now();
    const r = checkAgainstSchema('SELECT t1.a, t2.b FROM t1 JOIN t2 ON t2.id = t1.id', big, 'postgresql');
    expect(r.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('closest', () => {
  it('finds typos, plurals and near names, best first', () => {
    expect(closest('custmers', ['customers', 'orders', 'products'])[0]).toBe('customers');
    expect(closest('order', ['orders', 'order_items', 'products'])).toContain('orders');
    expect(closest('title', ['title', 'name'])[0]).toBe('title');
    expect(closest('zzzzzz', ['customers', 'orders'])).toEqual([]);
  });
});
