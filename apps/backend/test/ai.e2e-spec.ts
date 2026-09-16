import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { AiModule } from '../src/ai/ai.module';
import { AuditModule } from '../src/audit/audit.module';
import { AuthModule } from '../src/auth/auth.module';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { CommonModule } from '../src/common/common.module';
import configuration from '../src/config/configuration';
import { DatabaseConnectionsModule } from '../src/database-connections/database-connections.module';
import { UsersModule } from '../src/users/users.module';

describe('AI endpoints without OPENAI_API_KEY configured (e2e)', () => {
  let app: INestApplication;
  let mongo: MongoMemoryServer;
  let token: string;
  let connectionId: string;
  let tmpDir: string;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.JWT_SECRET = 'test-access-secret-value-000000000000';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-value-11111111111';
    process.env.ENCRYPTION_KEY = 'e'.repeat(64);
    delete process.env.OPENAI_API_KEY;

    tmpDir = mkdtempSync(join(tmpdir(), 'sqlpilot-ai-'));
    const sqlitePath = join(tmpDir, 'shop.sqlite');
    const db = new BetterSqlite3(sqlitePath);
    db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    db.close();

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        MongooseModule.forRoot(mongo.getUri()),
        CommonModule,
        AuditModule,
        UsersModule,
        AuthModule,
        DatabaseConnectionsModule,
        AiModule,
      ],
      providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    const reg = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ name: 'Owner', email: 'ai-owner@example.com', password: 'Password123' });
    token = reg.body.accessToken;

    const conn = await request(app.getHttpServer())
      .post('/api/databases')
      .set({ Authorization: `Bearer ${token}` })
      .send({ name: 'Shop', type: 'sqlite', database: 'shop', filePath: sqlitePath });
    connectionId = conn.body.id;
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('returns 503 with a clear message instead of crashing', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/ai/generate-sql')
      .set(auth())
      .send({ connectionId, question: 'top customers' })
      .expect(503);
    expect(res.body.message).toMatch(/AI features are disabled/i);
  });

  it('validates the request body before touching the AI provider', async () => {
    await request(app.getHttpServer())
      .post('/api/ai/generate-sql')
      .set(auth())
      .send({ connectionId, question: 'ab' }) // below MinLength(3)
      .expect(400);
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer())
      .post('/api/ai/explain-sql')
      .send({ connectionId, sql: 'SELECT 1', mode: 'simple' })
      .expect(401);
  });
});
