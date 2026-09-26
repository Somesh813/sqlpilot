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
  security: {
    /** SQLite files must live under one of these directories. */
    sqliteAllowedDirs: string[];
    /** Host allowlist (names, *.suffix, IPs, CIDRs). Empty = no allowlist. */
    dbAllowedHosts: string[];
    /** With no allowlist: refuse loopback/private/metadata destinations. Default on in production. */
    blockPrivateHosts: boolean;
    /** Number of reverse-proxy hops to trust for the client IP (0 = none). */
    trustProxyHops: number;
  };
  pool: {
    /** Connections per external database. */
    maxConnections: number;
    /** A pool unused this long is closed (ms). */
    idleMs: number;
    /** Pools kept at once across all connections. */
    maxDrivers: number;
  };
  mail: {
    transport: 'smtp' | 'file' | 'none';
    smtpUrl: string;
    from: string;
    outboxDir: string;
    /** Public URL of the web app, used to build links in emails. */
    appBaseUrl: string;
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
  security: {
    sqliteAllowedDirs: (process.env.SQLITE_ALLOWED_DIRS ?? './data/sqlite')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    dbAllowedHosts: (process.env.DB_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    blockPrivateHosts:
      process.env.DB_BLOCK_PRIVATE_HOSTS !== undefined
        ? process.env.DB_BLOCK_PRIVATE_HOSTS.toLowerCase() === 'true'
        : process.env.NODE_ENV === 'production',
    trustProxyHops: parseInt(process.env.TRUST_PROXY_HOPS ?? '0', 10),
  },
  pool: {
    maxConnections: parseInt(process.env.DB_POOL_MAX_CONNECTIONS ?? '5', 10),
    idleMs: parseInt(process.env.DB_POOL_IDLE_MS ?? '300000', 10),
    maxDrivers: parseInt(process.env.DB_POOL_MAX_DRIVERS ?? '50', 10),
  },
  mail: {
    // Development defaults to a local outbox; production defaults to "none" and must opt in to SMTP.
    transport:
      (process.env.MAIL_TRANSPORT as 'smtp' | 'file' | 'none' | undefined) ??
      (process.env.NODE_ENV === 'production' ? 'none' : 'file'),
    smtpUrl: process.env.MAIL_SMTP_URL ?? '',
    from: process.env.MAIL_FROM ?? 'SQLPilot <no-reply@localhost>',
    outboxDir: process.env.MAIL_OUTBOX_DIR ?? './data/outbox',
    appBaseUrl: process.env.APP_BASE_URL ?? (process.env.CORS_ORIGIN ?? 'http://localhost:4200').split(',')[0].trim(),
  },
  logLevel: process.env.LOG_LEVEL ?? 'info',
});
