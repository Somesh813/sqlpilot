import { SqlStatementKind } from '@sqlpilot/shared';

const READ_KEYWORDS = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'PRAGMA', 'VALUES', 'TABLE']);
const WRITE_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'UPSERT', 'MERGE', 'LOAD', 'COPY']);
const DDL_KEYWORDS = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'COMMENT', 'VACUUM', 'ANALYZE', 'REINDEX', 'CLUSTER']);
const DCL_KEYWORDS = new Set(['GRANT', 'REVOKE', 'DENY']);
const TX_KEYWORDS = new Set(['BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'END']);
const UTILITY_KEYWORDS = new Set(['SET', 'USE', 'CALL', 'EXEC', 'EXECUTE', 'PREPARE', 'DEALLOCATE', 'DISCARD', 'LISTEN', 'NOTIFY', 'ATTACH', 'DETACH']);

export function classifyByKeyword(keyword: string): SqlStatementKind {
  if (READ_KEYWORDS.has(keyword)) return SqlStatementKind.READ;
  if (WRITE_KEYWORDS.has(keyword)) return SqlStatementKind.WRITE;
  if (DDL_KEYWORDS.has(keyword)) return SqlStatementKind.DDL;
  if (DCL_KEYWORDS.has(keyword)) return SqlStatementKind.DCL;
  if (TX_KEYWORDS.has(keyword)) return SqlStatementKind.TRANSACTION;
  if (UTILITY_KEYWORDS.has(keyword)) return SqlStatementKind.UTILITY;
  return SqlStatementKind.UNKNOWN;
}

/** Map a node-sql-parser AST node `.type` to a statement kind. */
export function classifyByAstType(astType: string | undefined): SqlStatementKind {
  switch ((astType || '').toLowerCase()) {
    case 'select':
      return SqlStatementKind.READ;
    case 'insert':
    case 'update':
    case 'delete':
    case 'replace':
      return SqlStatementKind.WRITE;
    case 'create':
    case 'alter':
    case 'drop':
    case 'truncate':
    case 'rename':
      return SqlStatementKind.DDL;
    case 'grant':
    case 'revoke':
      return SqlStatementKind.DCL;
    case 'transaction':
      return SqlStatementKind.TRANSACTION;
    default:
      return SqlStatementKind.UNKNOWN;
  }
}

export function mergeKinds(kinds: SqlStatementKind[]): SqlStatementKind {
  const priority = [
    SqlStatementKind.DCL,
    SqlStatementKind.DDL,
    SqlStatementKind.WRITE,
    SqlStatementKind.UTILITY,
    SqlStatementKind.TRANSACTION,
    SqlStatementKind.UNKNOWN,
    SqlStatementKind.READ,
  ];
  for (const kind of priority) {
    if (kinds.includes(kind)) return kind;
  }
  return SqlStatementKind.UNKNOWN;
}
