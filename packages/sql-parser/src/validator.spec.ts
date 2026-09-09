import { DatabaseType, SqlRiskLevel, SqlStatementKind } from '@sqlpilot/shared';
import { validateSql, ValidateOptions } from './validator';

const readOnly: ValidateOptions = {
  databaseType: DatabaseType.POSTGRES,
  allowWrite: false,
  enforceLimit: true,
  maxRows: 1000,
};

describe('validateSql — safe reads', () => {
  it('accepts a simple SELECT and injects a LIMIT', () => {
    const r = validateSql('SELECT id, name FROM customers', readOnly);
    expect(r.valid).toBe(true);
    expect(r.statementKind).toBe(SqlStatementKind.READ);
    expect(r.isReadOnly).toBe(true);
    expect(r.hasLimit).toBe(true);
    expect(r.normalizedSql).toMatch(/LIMIT 1000/);
    expect(r.risk).toBe(SqlRiskLevel.SAFE);
  });

  it('keeps an existing LIMIT untouched', () => {
    const r = validateSql('SELECT * FROM orders LIMIT 5', readOnly);
    expect(r.valid).toBe(true);
    expect(r.normalizedSql).not.toMatch(/LIMIT 1000/);
  });

  it('accepts CTEs', () => {
    const r = validateSql('WITH t AS (SELECT 1 AS x) SELECT x FROM t', readOnly);
    expect(r.valid).toBe(true);
    expect(r.isReadOnly).toBe(true);
  });

  it('extracts referenced tables', () => {
    const r = validateSql('SELECT c.name FROM customers c JOIN orders o ON o.customer_id = c.id', readOnly);
    expect(r.referencedTables.sort()).toEqual(['customers', 'orders']);
  });
});

describe('validateSql — dangerous operations are blocked', () => {
  const cases: Array<[string, string]> = [
    ['DROP TABLE users', 'DANGEROUS_KEYWORD'],
    ['TRUNCATE customers', 'DANGEROUS_KEYWORD'],
    ['ALTER TABLE users ADD COLUMN x int', 'DANGEROUS_KEYWORD'],
    ['CREATE TABLE t (id int)', 'DANGEROUS_KEYWORD'],
    ['GRANT ALL ON users TO bob', 'DANGEROUS_KEYWORD'],
    ['REVOKE SELECT ON users FROM bob', 'DANGEROUS_KEYWORD'],
  ];

  it.each(cases)('blocks %s', (sql, code) => {
    const r = validateSql(sql, readOnly);
    expect(r.valid).toBe(false);
    expect(r.violations.map((v) => v.code)).toContain(code);
    expect(r.risk).toBe(SqlRiskLevel.CRITICAL);
  });
});

describe('validateSql — write policy', () => {
  it('blocks INSERT/UPDATE/DELETE when write is disabled', () => {
    for (const sql of ['INSERT INTO t (a) VALUES (1)', 'UPDATE t SET a = 1', 'DELETE FROM t WHERE a = 1']) {
      const r = validateSql(sql, readOnly);
      expect(r.valid).toBe(false);
      expect(r.violations.map((v) => v.code)).toContain('WRITE_DISABLED');
    }
  });

  it('permits DELETE when write is explicitly enabled', () => {
    const r = validateSql('DELETE FROM t WHERE a = 1', { ...readOnly, allowWrite: true });
    expect(r.violations.map((v) => v.code)).not.toContain('WRITE_DISABLED');
    expect(r.statementKind).toBe(SqlStatementKind.WRITE);
    expect(r.valid).toBe(true);
  });

  it('still blocks DDL even when write is enabled', () => {
    const r = validateSql('DROP TABLE t', { ...readOnly, allowWrite: true });
    expect(r.valid).toBe(false);
  });
});

describe('validateSql — injection defenses', () => {
  it('blocks stacked statements', () => {
    const r = validateSql('SELECT 1; DROP TABLE users', readOnly);
    expect(r.valid).toBe(false);
    expect(r.stackedStatements).toBe(true);
    expect(r.violations.map((v) => v.code)).toContain('STACKED_STATEMENTS');
  });

  it('is not fooled by keywords hidden in string literals', () => {
    const r = validateSql("SELECT 'DROP TABLE users' AS note FROM customers", readOnly);
    expect(r.valid).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('blocks comment-smuggled stacked payloads', () => {
    const r = validateSql('SELECT 1 -- \n; DELETE FROM users', readOnly);
    expect(r.valid).toBe(false);
  });

  it('blocks INTO OUTFILE', () => {
    const r = validateSql("SELECT * FROM users INTO OUTFILE '/tmp/x'", {
      ...readOnly,
      databaseType: DatabaseType.MYSQL,
    });
    expect(r.valid).toBe(false);
    expect(r.violations.map((v) => v.code)).toContain('FILE_WRITE');
  });

  it('blocks locking reads', () => {
    const r = validateSql('SELECT * FROM users FOR UPDATE', readOnly);
    expect(r.valid).toBe(false);
    expect(r.violations.map((v) => v.code)).toContain('LOCKING_READ');
  });

  it('rejects empty input', () => {
    expect(validateSql('   ', readOnly).valid).toBe(false);
  });
});
