import {
  AiExplanationMode,
  DatabaseType,
  QueryStatus,
  SqlRiskLevel,
  SqlStatementKind,
  VisualizationType,
} from './enums';
import { ResultType, VisualizationPlan } from './analysis';
import { RelationshipSchema, TableSchema } from './models';

/* ============================================================
 * Auth
 * ========================================================== */

export interface RegisterRequest {
  name: string;
  email: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthResponse extends AuthTokens {
  user: { id: string; name: string; email: string; role: string };
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface ForgotPasswordRequest {
  email: string;
}

export interface ResetPasswordRequest {
  token: string;
  password: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/* ============================================================
 * Database connections
 * ========================================================== */

export interface CreateConnectionRequest {
  name: string;
  type: DatabaseType;
  host?: string;
  port?: number;
  database: string;
  filePath?: string;
  username?: string;
  password?: string;
  ssl?: boolean;
  options?: Record<string, string | number | boolean>;
}

export type UpdateConnectionRequest = Partial<CreateConnectionRequest>;

export interface TestConnectionResult {
  ok: boolean;
  latencyMs: number | null;
  serverVersion: string | null;
  error: string | null;
}

/* ============================================================
 * Schema-aware AI SQL generation
 * ========================================================== */

/** Compact schema context passed to the model. Only relevant tables are included. */
export interface SchemaContext {
  databaseType: DatabaseType;
  databaseName: string;
  tables: TableSchema[];
  relationships: RelationshipSchema[];
  /** Names of tables omitted from context because of size limits. */
  omittedTables: string[];
}

export interface GenerateSqlRequest {
  connectionId: string;
  question: string;
  conversationId?: string;
}

/** Structured model output. Never parsed from free text. */
export interface GeneratedSql {
  intent: string;
  tablesUsed: string[];
  sql: string;
  explanation: string;
  assumptions: string[];
  confidence: number;
  warnings: string[];
  /** Set when the schema cannot answer the question. */
  unanswerable: boolean;
  unanswerableReason: string | null;
  visualization: {
    recommended: boolean;
    type: VisualizationType;
    xField: string | null;
    yField: string | null;
  };
}

/* ------------------------------------------------------------
 * Ask: natural language in → answer + real data out, in one call.
 * The frontend renders this contract and nothing else.
 * ---------------------------------------------------------- */

export interface AskRequest {
  connectionId: string;
  question: string;
  conversationId?: string;
}

export interface AskError {
  /** Where it failed: understanding the request, or running the query. */
  stage: 'generation' | 'execution';
  /** Friendly, non-technical message for the user. */
  message: string;
  /** Raw database/AI error for the expandable debug section. */
  technical: string | null;
}

export interface AskResponse {
  success: boolean;
  question: string;
  conversationId: string | null;
  sql: string;
  columns: string[];
  columnTypes: Record<string, string | null>;
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  totalRowCount: number | null;
  truncated: boolean;
  executionTimeMs: number;
  resultType: ResultType;
  visualization: VisualizationPlan;
  availableViews: VisualizationType[];
  numericColumns: string[];
  /** Plain-language answer to the question, written from the actual result. */
  explanation: string;
  /** How the query works — secondary, shown next to the SQL. */
  queryExplanation: string;
  assumptions: string[];
  warnings: string[];
  tablesUsed: string[];
  confidence: number;
  /** True when the first query failed and an automatic repair succeeded. */
  autoFixed: boolean;
  historyId: string | null;
  error: AskError | null;
}

export interface ExplainSqlRequest {
  connectionId: string;
  sql: string;
  mode: AiExplanationMode;
}

export interface SqlExplanation {
  summary: string;
  tablesUsed: string[];
  joins: string[];
  filters: string[];
  aggregations: string[];
  sorting: string[];
  risks: string[];
  performanceNotes: string[];
}

export interface OptimizeSqlRequest {
  connectionId: string;
  sql: string;
}

export interface SqlOptimization {
  originalSql: string;
  optimizedSql: string;
  changes: string[];
  expectedBenefits: string[];
  warnings: string[];
  /** Never a guarantee — advisory only. */
  disclaimer: string;
}

export interface FixSqlRequest {
  connectionId: string;
  sql: string;
  databaseError: string;
}

export interface SqlFix {
  fixedSql: string;
  diagnosis: string;
  changes: string[];
  confidence: number;
}

/* ============================================================
 * Query validation & execution
 * ========================================================== */

export interface SqlPolicyViolation {
  code: string;
  message: string;
  keyword: string | null;
}

export interface SqlValidationResult {
  valid: boolean;
  statementKind: SqlStatementKind;
  risk: SqlRiskLevel;
  referencedTables: string[];
  isReadOnly: boolean;
  hasLimit: boolean;
  stackedStatements: boolean;
  violations: SqlPolicyViolation[];
  /** SQL after safe normalization (e.g. an injected LIMIT). */
  normalizedSql: string;
}

export interface ValidateQueryRequest {
  connectionId: string;
  sql: string;
}

export interface ExecuteQueryRequest {
  connectionId: string;
  sql: string;
  /** User has reviewed the SQL and confirms execution. Required by the backend. */
  confirmed: boolean;
  conversationId?: string;
  prompt?: string;
  page?: number;
  pageSize?: number;
  aiGenerated?: boolean;
}

export interface QueryResultColumn {
  name: string;
  type: string | null;
}

export interface QueryResult {
  columns: QueryResultColumn[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  totalRowCount: number | null;
  executionTimeMs: number;
  truncated: boolean;
  page: number;
  pageSize: number;
  status: QueryStatus;
  historyId: string | null;
}

export interface QueryError {
  status: QueryStatus;
  message: string;
  /** Raw driver error, safe-trimmed. */
  databaseError: string | null;
  aiSuggestion: string | null;
}

/* ============================================================
 * Visualization
 * ========================================================== */

export interface VisualizationRecommendation {
  type: VisualizationType;
  reason: string;
  xField: string | null;
  yField: string | null;
  seriesField: string | null;
}

/* ============================================================
 * Analytics / dashboard
 * ========================================================== */

export interface DashboardStats {
  connectedDatabases: number;
  totalConnections: number;
  totalQueries: number;
  queriesToday: number;
  aiGeneratedQueries: number;
  savedQueries: number;
  successRate: number;
  avgExecutionTimeMs: number;
  recentQueries: Array<{
    id: string;
    sql: string;
    prompt: string | null;
    status: QueryStatus;
    connectionName: string;
    createdAt: string;
  }>;
}

/* ============================================================
 * Generic list envelope
 * ========================================================== */

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiError {
  statusCode: number;
  message: string | string[];
  error: string;
  requestId?: string;
}
