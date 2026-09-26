import { validateEnv } from './env.validation';

const good = {
  NODE_ENV: 'production',
  DATABASE_URL: 'mongodb://sqlpilot:9f2c1a7e5b3d4c8a@mongo:27017/sqlpilot?authSource=sqlpilot',
  JWT_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  ENCRYPTION_KEY: 'ab12'.repeat(16),
  OPENAI_API_KEY: 'sk-real',
};

describe('validateEnv: production must not boot with development leftovers (F7)', () => {
  it('accepts a properly configured production environment', () => {
    expect(() => validateEnv(good)).not.toThrow();
  });

  it.each([
    ['root:root', 'mongodb://root:root@mongo:27017/sqlpilot'],
    ['sqlpilot:sqlpilot', 'mongodb://sqlpilot:sqlpilot@mongo:27017/sqlpilot?authSource=sqlpilot'],
    ['admin:password', 'mongodb://admin:password@mongo:27017/x'],
  ])('rejects the well-known Mongo credential %s', (_n, url) => {
    expect(() => validateEnv({ ...good, DATABASE_URL: url })).toThrow(/well-known password/);
  });

  it('rejects a MongoDB URL without credentials', () => {
    expect(() => validateEnv({ ...good, DATABASE_URL: 'mongodb://mongo:27017/sqlpilot' })).toThrow(/must include credentials/);
  });

  it('rejects the placeholder secrets copied from .env.example', () => {
    expect(() => validateEnv({ ...good, JWT_SECRET: 'replace-with-64-char-random-string-aaaaaaaaaaaaaaaa' })).toThrow(/placeholder/);
    expect(() => validateEnv({ ...good, ENCRYPTION_KEY: '0'.repeat(64) })).toThrow(/all zeros/);
    expect(() => validateEnv({ ...good, ENCRYPTION_KEY: 'replace-with-64-hex-chars' })).toThrow(/64 hex/);
  });

  it('is relaxed in development so local work needs no ceremony', () => {
    expect(() =>
      validateEnv({ ...good, NODE_ENV: 'development', DATABASE_URL: 'mongodb://localhost:27017/sqlpilot' }),
    ).not.toThrow();
  });
});
