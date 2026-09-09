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
}

export interface RunQueryOptions {
  timeoutMs: number;
  maxRows: number;
  page: number;
  pageSize: number;
  /** When false, the driver refuses anything that is not a plain read. */
  allowWrite: boolean;
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
    readonly code: 'CONNECTION' | 'QUERY' | 'TIMEOUT' | 'INTROSPECTION' = 'QUERY',
  ) {
    super(message);
    this.name = 'DatabaseDriverError';
  }
}
