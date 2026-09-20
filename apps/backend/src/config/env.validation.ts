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

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n  - ${errors.join('\n  - ')}`);
  }
  return config;
}
