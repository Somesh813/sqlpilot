/** Application-wide enumerations shared by frontend and backend. */

export enum UserRole {
  USER = 'USER',
  ADMIN = 'ADMIN',
}

/** External SQL database engines SQLPilot can connect to. */
export enum DatabaseType {
  POSTGRES = 'postgres',
  MYSQL = 'mysql',
  SQLITE = 'sqlite',
}

export enum ConnectionStatus {
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  ERROR = 'ERROR',
}

export enum QueryStatus {
  SUCCESS = 'SUCCESS',
  ERROR = 'ERROR',
  BLOCKED = 'BLOCKED',
  TIMEOUT = 'TIMEOUT',
}

/** Classification of a SQL statement by the parser/policy layer. */
export enum SqlStatementKind {
  READ = 'READ',
  WRITE = 'WRITE',
  DDL = 'DDL',
  DCL = 'DCL',
  TRANSACTION = 'TRANSACTION',
  UTILITY = 'UTILITY',
  UNKNOWN = 'UNKNOWN',
}

export enum SqlRiskLevel {
  SAFE = 'SAFE',
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export enum ConversationMessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  SYSTEM = 'system',
}

export enum AuditAction {
  CONNECTION_CREATED = 'CONNECTION_CREATED',
  CONNECTION_UPDATED = 'CONNECTION_UPDATED',
  CONNECTION_DELETED = 'CONNECTION_DELETED',
  CONNECTION_TESTED = 'CONNECTION_TESTED',
  SCHEMA_REFRESHED = 'SCHEMA_REFRESHED',
  AI_SQL_GENERATED = 'AI_SQL_GENERATED',
  QUERY_VALIDATED = 'QUERY_VALIDATED',
  QUERY_EXECUTED = 'QUERY_EXECUTED',
  QUERY_BLOCKED = 'QUERY_BLOCKED',
  SAVED_QUERY_CREATED = 'SAVED_QUERY_CREATED',
  SAVED_QUERY_DELETED = 'SAVED_QUERY_DELETED',
  LOGIN = 'LOGIN',
  LOGIN_FAILED = 'LOGIN_FAILED',
  PASSWORD_CHANGED = 'PASSWORD_CHANGED',
}

export enum VisualizationType {
  BAR = 'bar',
  LINE = 'line',
  PIE = 'pie',
  AREA = 'area',
  SCATTER = 'scatter',
  KPI = 'kpi',
  TABLE = 'table',
}

export enum AiExplanationMode {
  SIMPLE = 'simple',
  TECHNICAL = 'technical',
}
