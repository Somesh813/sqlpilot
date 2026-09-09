import { DEFAULTS } from '@sqlpilot/shared';

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  corsOrigin: string[];
  databaseUrl: string;
  jwt: {
    accessSecret: string;
    refreshSecret: string;
    accessExpiresIn: string;
    refreshExpiresIn: string;
  };
  encryptionKey: string;
  openai: {
    apiKey: string;
    model: string;
    fastModel: string;
    timeoutMs: number;
    maxSchemaTables: number;
  };
  query: {
    timeoutMs: number;
    maxRows: number;
    defaultPageSize: number;
    allowWriteQueries: boolean;
  };
  logLevel: string;
}

export default (): AppConfig => ({
  env: (process.env.NODE_ENV as AppConfig['env']) ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:4200').split(',').map((s) => s.trim()),
  databaseUrl: process.env.DATABASE_URL ?? 'mongodb://localhost:27017/sqlpilot',
  jwt: {
    accessSecret: process.env.JWT_SECRET ?? '',
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? '',
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? DEFAULTS.ACCESS_TOKEN_TTL,
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? DEFAULTS.REFRESH_TOKEN_TTL,
  },
  encryptionKey: process.env.ENCRYPTION_KEY ?? '',
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: process.env.OPENAI_MODEL ?? 'gpt-4o',
    fastModel: process.env.OPENAI_MODEL_FAST ?? 'gpt-4o-mini',
    timeoutMs: parseInt(process.env.AI_REQUEST_TIMEOUT_MS ?? '45000', 10),
    maxSchemaTables: parseInt(process.env.AI_MAX_SCHEMA_TABLES ?? String(DEFAULTS.AI_MAX_SCHEMA_TABLES), 10),
  },
  query: {
    timeoutMs: parseInt(process.env.QUERY_TIMEOUT_MS ?? String(DEFAULTS.QUERY_TIMEOUT_MS), 10),
    maxRows: parseInt(process.env.QUERY_MAX_ROWS ?? String(DEFAULTS.QUERY_MAX_ROWS), 10),
    defaultPageSize: parseInt(process.env.QUERY_DEFAULT_PAGE_SIZE ?? String(DEFAULTS.QUERY_DEFAULT_PAGE_SIZE), 10),
    allowWriteQueries: (process.env.ALLOW_WRITE_QUERIES ?? 'false').toLowerCase() === 'true',
  },
  logLevel: process.env.LOG_LEVEL ?? 'info',
});
