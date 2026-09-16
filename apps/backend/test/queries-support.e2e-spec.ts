import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { AnalyticsModule } from '../src/analytics/analytics.module';
import { AuditModule } from '../src/audit/audit.module';
import { AuthModule } from '../src/auth/auth.module';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { CommonModule } from '../src/common/common.module';
import configuration from '../src/config/configuration';
import { ConversationsModule } from '../src/conversations/conversations.module';
import { DatabaseConnectionsModule } from '../src/database-connections/database-connections.module';
import { SavedQueriesModule } from '../src/saved-queries/saved-queries.module';
import { UsersModule } from '../src/users/users.module';

describe('Saved queries, prompts, conversations, analytics (e2e)', () => {
  let app: INestApplication;
  let mongo: MongoMemoryServer;
  let token: string;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.JWT_SECRET = 'test-access-secret-value-000000000000';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-value-11111111111';
    process.env.ENCRYPTION_KEY = 'd'.repeat(64);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        MongooseModule.forRoot(mongo.getUri()),
        CommonModule,
        AuditModule,
        UsersModule,
        AuthModule,
        DatabaseConnectionsModule,
        SavedQueriesModule,
        ConversationsModule,
        AnalyticsModule,
      ],
      providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    const reg = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ name: 'Owner', email: 'support-owner@example.com', password: 'Password123' });
    token = reg.body.accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  describe('saved queries', () => {
    let id: string;

    it('creates, lists, searches, updates, and deletes a saved query', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/queries/save')
        .set(auth())
        .send({ name: 'Top spenders', description: 'Ranks by spend', sql: 'SELECT * FROM customers', tags: ['Revenue', 'revenue', ' vip '] })
        .expect(201);
      id = created.body.id;
      expect(created.body.tags).toEqual(['revenue', 'vip']);

      const list = await request(app.getHttpServer()).get('/api/queries/saved').set(auth()).expect(200);
      expect(list.body).toHaveLength(1);

      const search = await request(app.getHttpServer())
        .get('/api/queries/saved')
        .query({ search: 'spenders' })
        .set(auth())
        .expect(200);
      expect(search.body).toHaveLength(1);
      const noMatch = await request(app.getHttpServer())
        .get('/api/queries/saved')
        .query({ search: 'nope' })
        .set(auth())
        .expect(200);
      expect(noMatch.body).toHaveLength(0);

      const updated = await request(app.getHttpServer())
        .patch(`/api/queries/saved/${id}`)
        .set(auth())
        .send({ name: 'Top spenders (updated)' })
        .expect(200);
      expect(updated.body.name).toBe('Top spenders (updated)');

      await request(app.getHttpServer()).delete(`/api/queries/saved/${id}`).set(auth()).expect(204);
      await request(app.getHttpServer())
        .patch(`/api/queries/saved/${id}`)
        .set(auth())
        .send({ name: 'x' })
        .expect(404);
    });
  });

  describe('prompt templates', () => {
    it('creates, lists, and deletes a prompt template', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/prompts')
        .set(auth())
        .send({ name: 'Revenue prompt', body: 'Show revenue by {{period}}' })
        .expect(201);
      const list = await request(app.getHttpServer()).get('/api/prompts').set(auth()).expect(200);
      expect(list.body).toHaveLength(1);
      await request(app.getHttpServer()).delete(`/api/prompts/${created.body.id}`).set(auth()).expect(204);
    });
  });

  describe('conversations', () => {
    it('creates a conversation, appends messages via the service round-trip, and deletes it', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/conversations')
        .set(auth())
        .send({ title: 'Revenue chat' })
        .expect(201);
      expect(created.body.messageCount).toBe(0);

      const got = await request(app.getHttpServer())
        .get(`/api/conversations/${created.body.id}`)
        .set(auth())
        .expect(200);
      expect(got.body.conversation.id).toBe(created.body.id);
      expect(got.body.messages).toEqual([]);

      await request(app.getHttpServer()).delete(`/api/conversations/${created.body.id}`).set(auth()).expect(204);
      await request(app.getHttpServer()).get(`/api/conversations/${created.body.id}`).set(auth()).expect(404);
    });

    it('isolates conversations per user', async () => {
      const other = await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({ name: 'Other', email: 'support-other@example.com', password: 'Password123' });
      const list = await request(app.getHttpServer())
        .get('/api/conversations')
        .set({ Authorization: `Bearer ${other.body.accessToken}` })
        .expect(200);
      expect(list.body).toEqual([]);
    });
  });

  describe('analytics dashboard', () => {
    it('returns zeroed stats for a fresh account', async () => {
      const res = await request(app.getHttpServer()).get('/api/analytics/dashboard').set(auth()).expect(200);
      expect(res.body).toMatchObject({
        connectedDatabases: 0,
        totalQueries: 0,
        savedQueries: 0,
        successRate: 0,
      });
      expect(res.body.recentQueries).toEqual([]);
    });

    it('requires authentication', async () => {
      await request(app.getHttpServer()).get('/api/analytics/dashboard').expect(401);
    });
  });
});
