/** Security and execution constants shared across the stack. */

/**
 * SQL keywords that are ALWAYS blocked, regardless of any write policy.
 * These change schema, permissions, or the server environment.
 */
export const DANGEROUS_SQL_KEYWORDS = [
  'DROP',
  'TRUNCATE',
  'ALTER',
  'CREATE',
  'GRANT',
  'REVOKE',
  'RENAME',
  'ATTACH',
  'DETACH',
  'VACUUM',
  'REINDEX',
  'CALL',
  'EXEC',
  'EXECUTE',
  'PREPARE',
  'DEALLOCATE',
] as const;

/**
 * Write DML. Blocked by default; permitted only when an ADMIN has enabled
 * write mode for the connection AND the global ALLOW_WRITE_QUERIES flag is on.
 */
export const WRITE_DML_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'UPSERT',
  'MERGE',
] as const;

/** Statement separators / stacked-query markers that should never appear in a single AI query. */
export const STACKED_QUERY_PATTERN = /;\s*\S/;

/** Common SQL comment markers used to smuggle payloads. */
export const SQL_COMMENT_PATTERN = /(--|#|\/\*)/;

export const DEFAULTS = {
  QUERY_TIMEOUT_MS: 15_000,
  QUERY_MAX_ROWS: 1_000,
  QUERY_DEFAULT_PAGE_SIZE: 100,
  AI_MAX_SCHEMA_TABLES: 25,
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL: '7d',
} as const;

export const API_PREFIX = 'api';

export const DEFAULT_PORTS: Record<string, number> = {
  postgres: 5432,
  mysql: 3306,
  sqlite: 0,
};
