import {
  DatabaseType,
  SqlPolicyViolation,
  SqlRiskLevel,
  SqlStatementKind,
  SqlValidationResult,
} from '@sqlpilot/shared';
import { Parser } from 'node-sql-parser';
import { inspectAst } from './ast-inspect';
import { classifyByAstType, classifyByKeyword } from './classify';
import { toParserDialect } from './dialect';
import { lexSql } from './lexer';
import { isDangerousFunction } from './policy';
import { leadingKeyword } from './tokenize';

export interface ValidateOptions {
  databaseType: DatabaseType;
  /**
   * Allow ONE INSERT/UPDATE/DELETE (manual SQL editor with write mode enabled). Never set on
   * the AI path. DDL, DCL, and every other statement stay blocked regardless.
   */
  allowWrite: boolean;
}

const parser = new Parser();

/** Root statement types that are legal when writes are allowed. */
const WRITE_ROOTS = new Set(['insert', 'update', 'delete', 'replace']);

/**
 * Token-level backstops that run on the literal-blanked text. They exist so that an AST shape
 * we did not anticipate cannot smuggle a construct past the walker.
 */
const CALL_TOKEN = /([A-Za-z_][A-Za-z0-9_$]*)\s*\(/g;
const INTO_TOKEN = /\binto\b/i;
const LOCK_TOKEN = /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i;

export function validateSql(rawSql: string, options: ValidateOptions): SqlValidationResult {
  const violations: SqlPolicyViolation[] = [];
  const add = (code: string, message: string, keyword: string | null = null) => {
    if (!violations.some((v) => v.code === code && v.keyword === keyword)) violations.push({ code, message, keyword });
  };

  const dialect = toParserDialect(options.databaseType);
  const lexed = lexSql(rawSql ?? '', dialect);
  const statements = lexed.statements;
  const sql = statements[0] ?? '';

  const result: SqlValidationResult = {
    valid: false,
    statementKind: SqlStatementKind.UNKNOWN,
    risk: SqlRiskLevel.MEDIUM,
    referencedTables: [],
    isReadOnly: false,
    hasLimit: false,
    stackedStatements: statements.length > 1,
    violations,
    normalizedSql: sql,
    functionsUsed: [],
    topLevelLimit: null,
    referencedColumns: [],
  };

  if (statements.length === 0) {
    add('EMPTY', 'Query is empty.');
    result.risk = SqlRiskLevel.SAFE;
    return result;
  }

  if (lexed.unterminated) {
    add('UNTERMINATED', 'The query has an unterminated string, identifier, or comment.');
  }
  if (statements.length > 1) {
    add('STACKED_STATEMENTS', 'Multiple SQL statements are not allowed in a single request.');
  }

  // ---- parse (fail closed) ------------------------------------------------------------
  let roots: unknown[] | null = null;
  try {
    const ast = parser.astify(sql, { database: dialect });
    roots = Array.isArray(ast) ? ast : [ast];
  } catch {
    add('PARSE_FAILED', 'The query could not be parsed, so its safety cannot be verified.');
  }

  const keywordKind = classifyByKeyword(leadingKeyword(sql));
  let kind = keywordKind;

  if (roots) {
    if (roots.length > 1) {
      result.stackedStatements = true;
      add('STACKED_STATEMENTS', 'Multiple SQL statements are not allowed in a single request.');
    }
    const facts = inspectAst(roots);
    kind = classifyByAstType(facts.rootTypes[0]);
    result.functionsUsed = facts.functions;
    result.topLevelLimit = facts.topLevelLimit;
    result.hasLimit = facts.topLevelLimit !== null;

    const rootType = facts.rootTypes[0] ?? '';
    const isSelect = rootType === 'select';
    const isAllowedWrite = options.allowWrite && WRITE_ROOTS.has(rootType);

    if (!isSelect && !isAllowedWrite) {
      if (kind === SqlStatementKind.DDL) add('DDL_BLOCKED', 'Schema-changing statements (DDL) are never permitted.');
      else if (kind === SqlStatementKind.DCL) add('DCL_BLOCKED', 'Permission statements (GRANT/REVOKE) are never permitted.');
      else if (kind === SqlStatementKind.WRITE) {
        add('WRITE_DISABLED', 'Write statements are disabled. An administrator must enable write mode for this connection.');
      } else {
        add('NON_QUERY_BLOCKED', 'Only SELECT queries are permitted. Transaction, session, and utility statements are blocked.');
      }
    }
    for (const nested of facts.nestedStatements) {
      add('NESTED_STATEMENT', `A nested ${nested.toUpperCase()} statement is not permitted.`, nested.toUpperCase());
    }
    if (facts.hasInto) add('SELECT_INTO', 'SELECT ... INTO (creating tables, variables, or files) is not permitted.', 'INTO');
    if (facts.hasLocking) add('LOCKING_READ', 'Locking reads (FOR UPDATE / FOR SHARE) are not permitted.', 'FOR UPDATE');
    for (const fn of facts.dangerousFunctions) {
      add('DANGEROUS_FUNCTION', `The function "${fn}" is not permitted.`, fn);
    }

    try {
      const withoutCtes = new Set(facts.cteNames);
      result.referencedTables = Array.from(
        new Set(
          parser
            .tableList(sql, { database: dialect })
            .map((entry) => entry.split('::').pop() || entry)
            .filter((t) => t && !withoutCtes.has(t.toLowerCase())),
        ),
      );
      result.referencedColumns = Array.from(
        new Set(parser.columnList(sql, { database: dialect }).map((entry) => entry.split('::').slice(1).join('.'))),
      );
    } catch {
      /* table/column extraction is advisory; the policy checks above do not depend on it */
    }
  } else {
    // Unparseable: nothing was inspected, so report what the leading keyword says and stay invalid.
    if (kind === SqlStatementKind.DDL) add('DDL_BLOCKED', 'Schema-changing statements (DDL) are never permitted.');
    if (kind === SqlStatementKind.DCL) add('DCL_BLOCKED', 'Permission statements (GRANT/REVOKE) are never permitted.');
  }

  // ---- token backstops (independent of the AST) -----------------------------------------
  const code = lexed.code;
  if (INTO_TOKEN.test(code) && kind === SqlStatementKind.READ) {
    add('SELECT_INTO', 'SELECT ... INTO (creating tables, variables, or files) is not permitted.', 'INTO');
  }
  if (LOCK_TOKEN.test(code)) add('LOCKING_READ', 'Locking reads (FOR UPDATE / FOR SHARE) are not permitted.', 'FOR UPDATE');
  for (const m of code.matchAll(CALL_TOKEN)) {
    const name = m[1].toLowerCase();
    if (isDangerousFunction(name)) add('DANGEROUS_FUNCTION', `The function "${name}" is not permitted.`, name);
  }

  result.statementKind = kind;
  result.isReadOnly = kind === SqlStatementKind.READ && violations.length === 0;
  result.valid = violations.length === 0;
  result.risk = computeRisk(kind, violations, result);
  return result;
}

function computeRisk(kind: SqlStatementKind, violations: SqlPolicyViolation[], r: SqlValidationResult): SqlRiskLevel {
  const codes = new Set(violations.map((v) => v.code));
  const critical = ['DDL_BLOCKED', 'DCL_BLOCKED', 'STACKED_STATEMENTS', 'NESTED_STATEMENT', 'SELECT_INTO', 'DANGEROUS_FUNCTION'];
  if (critical.some((c) => codes.has(c))) return SqlRiskLevel.CRITICAL;
  if (codes.has('WRITE_DISABLED') || codes.has('LOCKING_READ') || codes.has('NON_QUERY_BLOCKED')) return SqlRiskLevel.HIGH;
  if (kind === SqlStatementKind.WRITE) return SqlRiskLevel.HIGH;
  if (codes.size > 0) return SqlRiskLevel.MEDIUM;
  return r.hasLimit ? SqlRiskLevel.SAFE : SqlRiskLevel.LOW;
}
