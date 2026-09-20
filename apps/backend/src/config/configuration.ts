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
  ai: {
    /** Which provider backs AI SQL generation/explain/optimize/fix. */
    provider: 'openai' | 'groq';
    timeoutMs: number;
    maxSchemaTables: number;
    /** See OpenAiProviderOptions.structuredOutputMode. */
    structuredOutputMode: 'json_schema' | 'json_object';
    openai: {
      apiKey: string;
      model: string;
      fastModel: string;
      baseUrl: string | undefined;
    };
    /** Groq's API is OpenAI-SDK compatible, so it reuses the same client. */
    groq: {
      apiKey: string;
      model: string;
      fastModel: string;
      baseUrl: string;
    };
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
  ai: {
    provider: (process.env.AI_PROVIDER as 'openai' | 'groq' | undefined) ?? 'openai',
    timeoutMs: parseInt(process.env.AI_REQUEST_TIMEOUT_MS ?? '45000', 10),
    maxSchemaTables: parseInt(process.env.AI_MAX_SCHEMA_TABLES ?? String(DEFAULTS.AI_MAX_SCHEMA_TABLES), 10),
    structuredOutputMode:
      (process.env.AI_STRUCTURED_OUTPUT_MODE as 'json_schema' | 'json_object' | undefined) ?? 'json_schema',
    openai: {
      apiKey: process.env.OPENAI_API_KEY ?? '',
      model: process.env.OPENAI_MODEL ?? 'gpt-4o',
      fastModel: process.env.OPENAI_MODEL_FAST ?? 'gpt-4o-mini',
      baseUrl: process.env.OPENAI_BASE_URL || undefined,
    },
    groq: {
      apiKey: process.env.GROQ_API_KEY ?? '',
      model: process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b',
      fastModel: process.env.GROQ_MODEL_FAST ?? 'openai/gpt-oss-20b',
      baseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
    },
  },
  query: {
    timeoutMs: parseInt(process.env.QUERY_TIMEOUT_MS ?? String(DEFAULTS.QUERY_TIMEOUT_MS), 10),
    maxRows: parseInt(process.env.QUERY_MAX_ROWS ?? String(DEFAULTS.QUERY_MAX_ROWS), 10),
    defaultPageSize: parseInt(process.env.QUERY_DEFAULT_PAGE_SIZE ?? String(DEFAULTS.QUERY_DEFAULT_PAGE_SIZE), 10),
    allowWriteQueries: (process.env.ALLOW_WRITE_QUERIES ?? 'false').toLowerCase() === 'true',
  },
  logLevel: process.env.LOG_LEVEL ?? 'info',
});
