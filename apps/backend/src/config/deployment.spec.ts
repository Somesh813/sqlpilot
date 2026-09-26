import * as yaml from 'js-yaml';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** F7: guards the deployment files against regressing to hardcoded credentials or public databases. */
const root = resolve(__dirname, '../../../..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
type Service = { ports?: string[]; environment?: Record<string, string>; networks?: string[] | Record<string, unknown> };
const compose = yaml.load(read('docker-compose.yml')) as { services: Record<string, Service>; networks: Record<string, { internal?: boolean }> };

describe('docker-compose.yml', () => {
  it('does not publish MongoDB or the API to the host', () => {
    expect(compose.services.mongo.ports).toBeUndefined();
    expect(compose.services.backend.ports).toBeUndefined();
  });

  it('publishes only the web container, on loopback unless deliberately changed', () => {
    const published = Object.entries(compose.services).filter(([, s]) => s.ports?.length);
    expect(published.map(([name]) => name)).toEqual(['frontend']);
    expect(compose.services.frontend.ports![0]).toMatch(/^'?\$\{WEB_BIND:-127\.0\.0\.1\}/);
  });

  it('has no literal passwords: every secret is required from the environment', () => {
    const env = { ...compose.services.mongo.environment, ...compose.services.backend.environment } as Record<string, string>;
    for (const key of ['MONGO_INITDB_ROOT_PASSWORD', 'MONGO_APP_PASSWORD', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'ENCRYPTION_KEY']) {
      expect(env[key]).toMatch(/^\$\{[A-Z_]+:\?/);
    }
    expect(env.DATABASE_URL).toMatch(/\$\{MONGO_APP_PASSWORD:\?/);
    const text = read('docker-compose.yml');
    expect(text).not.toMatch(/root:root|sqlpilot:sqlpilot|PASSWORD:\s*(root|sqlpilot|password|admin)\b/i);
  });

  it('keeps MongoDB on an internal-only network', () => {
    expect(compose.networks.data.internal).toBe(true);
    expect(compose.services.mongo.networks).toEqual(['data']);
  });

  it('trusts exactly one proxy hop and restricts SQLite paths', () => {
    const env = compose.services.backend.environment!;
    expect(env.TRUST_PROXY_HOPS).toBe('1');
    expect(env.SQLITE_ALLOWED_DIRS).toBe('/app/data/sqlite');
    expect(env.MAIL_TRANSPORT).not.toMatch(/file/);
  });
});

describe('supporting deployment files', () => {
  it('the Mongo init script takes its password from the environment (the old hardcoded one is gone)', () => {
    expect(existsSync(join(root, 'docker/mongo-init.js'))).toBe(false);
    const sh = read('docker/mongo-init.sh');
    expect(sh).toContain('MONGO_APP_PASSWORD');
    expect(sh).not.toMatch(/pwd:\s*['"]/);
  });

  it('the dev override binds MongoDB to loopback only', () => {
    const dev = yaml.load(read('docker-compose.dev.yml')) as { services: { mongo: { ports: string[] } } };
    expect(dev.services.mongo.ports.every((p) => p.startsWith('127.0.0.1:'))).toBe(true);
  });

  it('nginx overwrites (never appends to) X-Forwarded-For, matching TRUST_PROXY_HOPS=1', () => {
    const conf = read('docker/nginx.conf');
    expect(conf).toMatch(/proxy_set_header X-Forwarded-For \$remote_addr;/);
    expect(conf).not.toMatch(/proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
    expect(conf).toMatch(/server_tokens off;/);
  });

  it('.env.example ships no usable secrets', () => {
    const env = read('.env.example');
    expect(env).not.toMatch(/ENCRYPTION_KEY=0{64}/);
    expect(env).not.toMatch(/root:root|sqlpilot:sqlpilot/);
    expect(env).not.toMatch(/gsk_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}/);
  });
});
