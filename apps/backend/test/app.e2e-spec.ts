import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { API_PREFIX } from '@sqlpilot/shared';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Boots the real AppModule (config validation, pino, throttler, global guards,
 * exception filter) to catch wiring regressions in the production bootstrap path.
 */
describe('App bootstrap (e2e)', () => {
  let app: INestApplication;
  let mongo: MongoMemoryServer;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = mongo.getUri();
    process.env.JWT_SECRET = 'test-access-secret-value-000000000000';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-value-11111111111';
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.LOG_LEVEL = 'silent';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(API_PREFIX);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  });

  it('exposes a public liveness endpoint', async () => {
    await request(app.getHttpServer())
      .get('/api/health/live')
      .expect(200)
      .expect((res) => expect(res.body.status).toBe('ok'));
  });

  it('protects routes by default (global JWT guard)', async () => {
    await request(app.getHttpServer()).get('/api/auth/profile').expect(401);
  });

  it('validates registration input and rejects extra fields', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ name: 'A', email: 'not-an-email', password: 'weak', admin: true })
      .expect(400);
  });
});
