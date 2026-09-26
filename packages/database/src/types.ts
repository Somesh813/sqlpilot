import {
  DatabaseType,
  QueryResult,
  RelationshipSchema,
  TableSchema,
  TestConnectionResult,
} from '@sqlpilot/shared';

/** Fully-resolved connection parameters. Lives only on the backend. */
export interface DriverConfig {
  type: DatabaseType;
  host?: string;
  port?: number;
  database: string;
  username?: string;
  password?: string;
  /** SQLite only. */
  filePath?: string;
  ssl?: boolean;
  options?: Record<string, string | number | boolean>;
  /** Connection pool sizing for PostgreSQL / MySQL. */
  pool?: { max?: number; idleMs?: number };
}

export interface RunQueryOptions {
  timeoutMs: number;
  /**
   * Hard cap on returned rows. Drivers fetch `maxRows + 1` rows: getting the extra one proves
   * more exist (`truncated`) without ever holding the full result set in memory.
   */
  maxRows: number;
  /**
   * When false the query runs inside a genuine READ ONLY transaction, so the database itself
   * refuses writes even if a statement slipped past the validator.
   */
  allowWrite: boolean;
  /**
   * When the result was cut off, run a bounded `SELECT count(*)` so the UI can say
   * "Showing 1,000 of 1,500 rows". Best effort: null when it cannot be counted in time.
   */
  countTotal?: boolean;
  /** Aborting stops the query (SQLite: the query process is killed). */
  signal?: AbortSignal;
}

/**
 * Last-resort shape check, applied by every driver when writes are not allowed. It is NOT the
 * security boundary (that is the AST validator plus the database's own READ ONLY transaction);
 * it exists because some statements do not write to the database, so a READ ONLY transaction
 * does not stop them. Verified on PostgreSQL 18: `COPY (SELECT 1) TO PROGRAM '...'` runs
 * inside `BEGIN READ ONLY` for a superuser. Anything that is not SELECT/WITH/VALUES/TABLE is
 * refused here before it reaches the server.
 */
export function assertReadShaped(sql: string): void {
  let s = sql;
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, '').replace(/^--[^\n]*(\n|$)/, '').replace(/^\/\*[\s\S]*?\*\//, '').replace(/^\(+/, '');
    if (s === before) break;
  }
  if (!/^(select|with|values|table)\b/i.test(s)) {
    throw new DatabaseDriverError('Only read-only SELECT queries can be run here.', 'statement is not a SELECT/WITH query', 'QUERY');
  }
}

/** Wrap validated SQL for a total-row count. Only ever applied to validated read-only SQL. */
export function countSql(sql: string): string {
  return `SELECT COUNT(*) AS total FROM (${sql}) AS sqlpilot_count`;
}

export interface IntrospectionResult {
  databaseName: string;
  tables: TableSchema[];
  relationships: RelationshipSchema[];
  functions: string[];
}

export interface SqlDriver {
  readonly type: DatabaseType;
  testConnection(): Promise<TestConnectionResult>;
  introspect(): Promise<IntrospectionResult>;
  runQuery(sql: string, options: RunQueryOptions): Promise<QueryResult>;
  close(): Promise<void>;
}

export class DatabaseDriverError extends Error {
  constructor(
    message: string,
    readonly driverError: string | null = null,
    readonly code: 'CONNECTION' | 'QUERY' | 'TIMEOUT' | 'INTROSPECTION' | 'CANCELLED' = 'QUERY',
  ) {
    super(message);
    this.name = 'DatabaseDriverError';
  }
}
