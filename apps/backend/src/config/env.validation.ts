/**
 * Fail-fast environment validation. Runs before the Nest app is created so a
 * misconfigured deployment never boots into a half-working state.
 */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const errors: string[] = [];

  const required = (key: string) => {
    const value = config[key];
    if (value === undefined || value === null || String(value).trim() === '') {
      errors.push(`${key} is required`);
      return '';
    }
    return String(value);
  };

  const env = String(config.NODE_ENV ?? 'development');
  const isProd = env === 'production';

  required('DATABASE_URL');
  const jwtSecret = required('JWT_SECRET');
  const jwtRefreshSecret = required('JWT_REFRESH_SECRET');
  const encryptionKey = required('ENCRYPTION_KEY');

  if (jwtSecret && jwtRefreshSecret && jwtSecret === jwtRefreshSecret) {
    errors.push('JWT_SECRET and JWT_REFRESH_SECRET must be different');
  }
  if (isProd && jwtSecret && jwtSecret.length < 32) {
    errors.push('JWT_SECRET must be at least 32 characters in production');
  }
  if (encryptionKey && !/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    errors.push('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }
  const aiProvider = String(config.AI_PROVIDER ?? 'openai');
  if (isProd) {
    if (aiProvider === 'groq' && !config.GROQ_API_KEY) {
      errors.push('GROQ_API_KEY is required in production when AI_PROVIDER=groq');
    } else if (aiProvider !== 'groq' && !config.OPENAI_API_KEY) {
      errors.push('OPENAI_API_KEY is required in production (or set AI_PROVIDER=groq with GROQ_API_KEY)');
    }
  }

  if (isProd) {
    const placeholder = /^(replace-with|changeme|change-me|secret|password|test|example)/i;
    for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET']) {
      if (placeholder.test(String(config[key] ?? ''))) errors.push(`${key} is still a placeholder value`);
    }
    if (/^0+$/.test(encryptionKey)) errors.push('ENCRYPTION_KEY must not be all zeros');

    const dbUrl = String(config.DATABASE_URL ?? '');
    const creds = /^mongodb(?:\+srv)?:\/\/([^:@/]+):([^@/]*)@/.exec(dbUrl);
    if (dbUrl && !creds) errors.push('DATABASE_URL must include credentials in production (MongoDB without auth is not allowed)');
    if (creds && /^(root|admin|password|sqlpilot|mongo|changeme|123456)$/i.test(decodeURIComponent(creds[2]))) {
      errors.push('DATABASE_URL uses a well-known password; set a strong random one');
    }
  }

  const mailTransport = String(config.MAIL_TRANSPORT ?? (isProd ? 'none' : 'file'));
  if (!['smtp', 'file', 'none'].includes(mailTransport)) errors.push('MAIL_TRANSPORT must be smtp, file or none');
  if (isProd && mailTransport === 'file') {
    errors.push('MAIL_TRANSPORT=file is a development outbox and is not allowed in production');
  }
  if (mailTransport === 'smtp' && !String(config.MAIL_SMTP_URL ?? '').trim()) {
    errors.push('MAIL_SMTP_URL is required when MAIL_TRANSPORT=smtp');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n  - ${errors.join('\n  - ')}`);
  }
  return config;
}
