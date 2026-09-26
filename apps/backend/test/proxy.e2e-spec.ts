import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { AuditModule } from '../src/audit/audit.module';
import { AuthModule } from '../src/auth/auth.module';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import configuration from '../src/config/configuration';
import { applyProxySettings } from '../src/proxy';
import { UsersModule } from '../src/users/users.module';

/**
 * F5: the login limit (20/min) must count PER CLIENT behind nginx, and a client must not be
 * able to dodge it, or frame someone else, by forging X-Forwarded-For.
 */
describe('Rate limiting behind a reverse proxy (e2e)', () => {
  let mongo: MongoMemoryServer;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.JWT_SECRET = 'test-access-secret-value-000000000000';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-value-11111111111';
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
  });
  afterAll(() => mongo.stop());

  async function boot(hops: number): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        MongooseModule.forRoot(mongo.getUri(), { dbName: `proxy_${hops}_${Date.now()}` }),
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
        AuditModule,
        UsersModule,
        AuthModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    applyProxySettings(app, hops);
    await app.init();
    return app;
  }

  const attempt = (app: INestApplication, xff?: string) => {
    const r = request(app.getHttpServer()).post('/api/auth/login');
    if (xff) r.set('X-Forwarded-For', xff);
    return r.send({ email: 'nobody@example.com', password: 'wrong-password-1' });
  };
  const burst = async (app: INestApplication, xff: (i: number) => string | undefined, n = 21) => {
    const statuses: number[] = [];
    for (let i = 0; i < n; i++) statuses.push((await attempt(app, xff(i))).status);
    return statuses;
  };

  it('one trusted hop: each client behind nginx gets its own bucket', async () => {
    const app = await boot(1);
    const a = await burst(app, () => '203.0.113.10');
    expect(a[19]).toBe(401);
    expect(a[20]).toBe(429); // client A is limited...
    expect((await attempt(app, '203.0.113.11')).status).toBe(401); // ...client B is not
    await app.close();
  }, 60_000);

  it('one trusted hop: prepending fake addresses cannot dodge the limit', async () => {
    const app = await boot(1);
    // nginx appends the real peer last; the client controls everything before it
    const s = await burst(app, (i) => `10.9.8.${i}, 198.51.100.7`);
    expect(s[20]).toBe(429);
    await app.close();
  }, 60_000);

  it('one trusted hop: a forged header cannot frame another client', async () => {
    const app = await boot(1);
    await burst(app, (i) => `198.51.100.9, 203.0.113.50`, 21); // attacker burns THEIR bucket (203.0.113.50 is the peer nginx saw)
    // the victim's real address is different and unaffected, no matter what the attacker wrote
    expect((await attempt(app, '198.51.100.9')).status).toBe(401);
    await app.close();
  }, 60_000);

  it('no proxy (0 hops): X-Forwarded-For is ignored, so rotating it does not help', async () => {
    const app = await boot(0);
    const s = await burst(app, (i) => `192.0.2.${i}`);
    expect(s[20]).toBe(429);
    await app.close();
  }, 60_000);
});
