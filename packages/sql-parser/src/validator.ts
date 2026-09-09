import {
  DANGEROUS_SQL_KEYWORDS,
  DatabaseType,
  SqlPolicyViolation,
  SqlRiskLevel,
  SqlStatementKind,
  SqlValidationResult,
  WRITE_DML_KEYWORDS,
} from '@sqlpilot/shared';
import { Parser } from 'node-sql-parser';
import { classifyByAstType, classifyByKeyword, mergeKinds } from './classify';
import { toParserDialect } from './dialect';
import { leadingKeyword, splitStatements, stripLiteralsAndComments } from './tokenize';

export interface ValidateOptions {
  databaseType: DatabaseType;
  /** connection.writeEnabled && global ALLOW_WRITE_QUERIES */
  allowWrite: boolean;
  /** Inject a LIMIT into limit-less SELECTs. */
  enforceLimit: boolean;
  maxRows: number;
}

const parser = new Parser();

const LIMIT_PRESENT = /\blimit\s+\d+/i;
const FETCH_PRESENT = /\bfetch\s+(first|next)\b/i;
const LOCKING_READ = /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i;
const INTO_OUTFILE = /\binto\s+(outfile|dumpfile)\b/i;

export function validateSql(rawSql: string, options: ValidateOptions): SqlValidationResult {
  const violations: SqlPolicyViolation[] = [];
  const sql = rawSql.trim().replace(/;\s*$/, '');
  const { stripped, hadBlockComment, hadLineComment } = stripLiteralsAndComments(sql);

  const base: SqlValidationResult = {
    valid: false,
    statementKind: SqlStatementKind.UNKNOWN,
    risk: SqlRiskLevel.MEDIUM,
    referencedTables: [],
    isReadOnly: false,
    hasLimit: LIMIT_PRESENT.test(stripped) || FETCH_PRESENT.test(stripped),
    stackedStatements: false,
    violations,
    normalizedSql: sql,
  };

  if (!sql) {
    violations.push({ code: 'EMPTY', message: 'Query is empty.', keyword: null });
    return { ...base, risk: SqlRiskLevel.SAFE };
  }

  // --- Stacked statements ---
  const statements = splitStatements(stripped);
  if (statements.length > 1) {
    base.stackedStatements = true;
    violations.push({
      code: 'STACKED_STATEMENTS',
      message: 'Multiple SQL statements are not allowed in a single request.',
      keyword: null,
    });
  }

  // --- Keyword defense-in-depth (works even if AST parse fails) ---
  const upperStripped = ` ${stripped.toUpperCase()} `;
  const wordBoundary = (kw: string) => new RegExp(`(^|[^A-Z_])${kw}([^A-Z_]|$)`);
  for (const kw of DANGEROUS_SQL_KEYWORDS) {
    if (wordBoundary(kw).test(upperStripped)) {
      violations.push({
        code: 'DANGEROUS_KEYWORD',
        message: `The keyword "${kw}" is not permitted.`,
        keyword: kw,
      });
    }
  }
  if (!options.allowWrite) {
    for (const kw of WRITE_DML_KEYWORDS) {
      if (wordBoundary(kw).test(upperStripped)) {
        pushOnce(violations, {
          code: 'WRITE_DISABLED',
          message: 'Write statements are disabled. An administrator must enable write mode for this connection.',
          keyword: kw,
        });
      }
    }
  }
  if (INTO_OUTFILE.test(stripped)) {
    violations.push({ code: 'FILE_WRITE', message: 'Writing query output to files is not permitted.', keyword: 'OUTFILE' });
  }
  if (LOCKING_READ.test(stripped)) {
    violations.push({ code: 'LOCKING_READ', message: 'Locking reads (FOR UPDATE/SHARE) are not permitted.', keyword: 'FOR UPDATE' });
  }

  // --- AST analysis ---
  let statementKind = SqlStatementKind.UNKNOWN;
  let referencedTables: string[] = [];
  let astParsed = false;

  try {
    const dialect = toParserDialect(options.databaseType);
    const astResult = parser.astify(sql, { database: dialect });
    const nodes = Array.isArray(astResult) ? astResult : [astResult];
    astParsed = true;

    if (nodes.length > 1 && !base.stackedStatements) {
      base.stackedStatements = true;
      violations.push({
        code: 'STACKED_STATEMENTS',
        message: 'Multiple SQL statements are not allowed in a single request.',
        keyword: null,
      });
    }

    statementKind = mergeKinds(nodes.map((n) => classifyByAstType((n as { type?: string }).type)));

    try {
      const tableList = parser.tableList(sql, { database: dialect });
      referencedTables = Array.from(
        new Set(tableList.map((entry) => entry.split('::').pop() || entry).filter(Boolean)),
      );
    } catch {
      /* tableList can throw on exotic syntax; non-fatal */
    }
  } catch {
    // Fall back to keyword classification.
    statementKind = mergeKinds(statements.map((s) => classifyByKeyword(leadingKeyword(s))));
    if (statementKind === SqlStatementKind.UNKNOWN) {
      violations.push({
        code: 'PARSE_FAILED',
        message: 'The query could not be parsed and its safety cannot be verified.',
        keyword: null,
      });
    }
  }

  if (statementKind === SqlStatementKind.UNKNOWN) {
    statementKind = mergeKinds(statements.map((s) => classifyByKeyword(leadingKeyword(s))));
  }

  base.statementKind = statementKind;
  base.referencedTables = referencedTables;
  base.isReadOnly = statementKind === SqlStatementKind.READ;

  // --- Policy: statement kind ---
  if (statementKind === SqlStatementKind.DDL) {
    pushOnce(violations, { code: 'DDL_BLOCKED', message: 'Schema-changing statements (DDL) are never permitted.', keyword: null });
  }
  if (statementKind === SqlStatementKind.DCL) {
    pushOnce(violations, { code: 'DCL_BLOCKED', message: 'Permission statements (GRANT/REVOKE) are never permitted.', keyword: null });
  }
  if (statementKind === SqlStatementKind.WRITE && !options.allowWrite) {
    pushOnce(violations, {
      code: 'WRITE_DISABLED',
      message: 'Write statements are disabled. An administrator must enable write mode for this connection.',
      keyword: null,
    });
  }
  if (statementKind === SqlStatementKind.TRANSACTION || statementKind === SqlStatementKind.UTILITY) {
    pushOnce(violations, {
      code: 'NON_QUERY_BLOCKED',
      message: 'Transaction control and session/utility statements are not permitted.',
      keyword: null,
    });
  }

  // --- LIMIT enforcement for reads ---
  if (options.enforceLimit && base.isReadOnly && !base.hasLimit && !base.stackedStatements) {
    base.normalizedSql = `${sql}\nLIMIT ${options.maxRows}`;
    base.hasLimit = true;
  }

  // --- Comment warnings (non-blocking) ---
  if (hadBlockComment || hadLineComment) {
    // informational only — recorded as a low-risk violation entry for the UI
  }

  base.valid = violations.length === 0;
  base.risk = computeRisk(statementKind, violations, base);

  return base;
}

function pushOnce(list: SqlPolicyViolation[], violation: SqlPolicyViolation): void {
  if (!list.some((v) => v.code === violation.code)) list.push(violation);
}

function computeRisk(
  kind: SqlStatementKind,
  violations: SqlPolicyViolation[],
  result: SqlValidationResult,
): SqlRiskLevel {
  if (violations.some((v) => ['DDL_BLOCKED', 'DCL_BLOCKED', 'STACKED_STATEMENTS', 'FILE_WRITE'].includes(v.code))) {
    return SqlRiskLevel.CRITICAL;
  }
  if (violations.some((v) => v.code === 'DANGEROUS_KEYWORD' || v.code === 'WRITE_DISABLED')) {
    return SqlRiskLevel.HIGH;
  }
  if (kind === SqlStatementKind.WRITE) return SqlRiskLevel.HIGH;
  if (violations.some((v) => v.code === 'PARSE_FAILED')) return SqlRiskLevel.MEDIUM;
  if (kind === SqlStatementKind.READ && result.hasLimit) return SqlRiskLevel.SAFE;
  if (kind === SqlStatementKind.READ) return SqlRiskLevel.LOW;
  return SqlRiskLevel.MEDIUM;
}
