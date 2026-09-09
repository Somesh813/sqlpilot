import {
  AuditAction,
  ConnectionStatus,
  ConversationMessageRole,
  DatabaseType,
  QueryStatus,
  UserRole,
} from './enums';

/** A record identifier — Mongo ObjectId serialized as string over the wire. */
export type Id = string;

export interface Timestamped {
  createdAt: string;
  updatedAt: string;
}

export interface User extends Timestamped {
  id: Id;
  name: string;
  email: string;
  role: UserRole;
}

/**
 * External database connection. `encryptedCredentials` never leaves the backend;
 * the frontend only ever sees `SafeDatabaseConnection`.
 */
export interface DatabaseConnection extends Timestamped {
  id: Id;
  userId: Id;
  name: string;
  type: DatabaseType;
  host: string | null;
  port: number | null;
  database: string;
  /** SQLite: absolute file path on the backend host. */
  filePath: string | null;
  ssl: boolean;
  /** Extra driver options (e.g. connectionTimeoutMillis). Non-secret. */
  options: Record<string, string | number | boolean>;
  status: ConnectionStatus;
  lastError: string | null;
  lastConnectedAt: string | null;
  schemaRefreshedAt: string | null;
  /** ADMIN-only: allow non-SELECT DML for this connection. Still gated by global flag. */
  writeEnabled: boolean;
}

/** Connection shape safe to send to the browser — no credentials. */
export type SafeDatabaseConnection = DatabaseConnection;

export interface ColumnSchema {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  references: { table: string; column: string } | null;
  comment: string | null;
}

export interface IndexSchema {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface TableSchema {
  name: string;
  schema: string | null;
  kind: 'table' | 'view';
  rowEstimate: number | null;
  comment: string | null;
  columns: ColumnSchema[];
  indexes: IndexSchema[];
}

export interface RelationshipSchema {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  constraintName: string | null;
}

export interface DatabaseSchemaSnapshot extends Timestamped {
  id: Id;
  connectionId: Id;
  databaseType: DatabaseType;
  databaseName: string;
  tables: TableSchema[];
  relationships: RelationshipSchema[];
  functions: string[];
  discoveredAt: string;
}

export interface Conversation extends Timestamped {
  id: Id;
  userId: Id;
  connectionId: Id | null;
  title: string;
  messageCount: number;
  lastMessageAt: string | null;
}

export interface ConversationMessage extends Timestamped {
  id: Id;
  conversationId: Id;
  role: ConversationMessageRole;
  content: string;
  /** Structured AI payload when role = assistant and this was a SQL generation. */
  sql: string | null;
  metadata: Record<string, unknown> | null;
}

export interface QueryHistoryEntry extends Timestamped {
  id: Id;
  userId: Id;
  connectionId: Id;
  connectionName: string;
  conversationId: Id | null;
  prompt: string | null;
  sql: string;
  status: QueryStatus;
  executionTimeMs: number | null;
  rowCount: number | null;
  truncated: boolean;
  error: string | null;
  aiGenerated: boolean;
}

export interface SavedQuery extends Timestamped {
  id: Id;
  userId: Id;
  connectionId: Id | null;
  name: string;
  description: string;
  sql: string;
  tags: string[];
}

export interface PromptTemplate extends Timestamped {
  id: Id;
  userId: Id;
  name: string;
  description: string;
  body: string;
}

export interface AuditLogEntry {
  id: Id;
  userId: Id | null;
  action: AuditAction;
  connectionId: Id | null;
  requestId: string | null;
  ip: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}
