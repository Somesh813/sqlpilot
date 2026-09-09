import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MongooseModule } from '@nestjs/mongoose';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import configuration from '../src/config/configuration';
import { AuditModule } from '../src/audit/audit.module';
import { AuthModule } from '../src/auth/auth.module';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { UsersModule } from '../src/users/users.module';

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let mongo: MongoMemoryServer;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.JWT_SECRET = 'test-access-secret-value-000000000000';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-value-11111111111';
    process.env.ENCRYPTION_KEY = '0'.repeat(64);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        MongooseModule.forRoot(mongo.getUri()),
        AuditModule,
        UsersModule,
        AuthModule,
      ],
      providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await mongo.stop();
  });

  const creds = { name: 'Ada', email: 'ada@example.com', password: 'Password123' };

  it('registers, then logs in, refreshes, and reads the profile', async () => {
    const reg = await request(app.getHttpServer()).post('/api/auth/register').send(creds).expect(201);
    expect(reg.body.accessToken).toBeDefined();
    expect(reg.body.user.role).toBe('USER');

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: creds.email, password: creds.password })
      .expect(200);

    const refresh = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(200);
    expect(refresh.body.accessToken).toBeDefined();

    await request(app.getHttpServer())
      .get('/api/auth/profile')
      .set('Authorization', `Bearer ${refresh.body.accessToken}`)
      .expect(200)
      .expect((res) => expect(res.body.email).toBe(creds.email));
  });

  it('rejects a reused (rotated) refresh token', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: creds.email, password: creds.password })
      .expect(200);
    const token = login.body.refreshToken;
    await request(app.getHttpServer()).post('/api/auth/refresh').send({ refreshToken: token }).expect(200);
    await request(app.getHttpServer()).post('/api/auth/refresh').send({ refreshToken: token }).expect(401);
  });

  it('blocks duplicate registration', async () => {
    await request(app.getHttpServer()).post('/api/auth/register').send(creds).expect(409);
  });

  it('rejects weak passwords', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ name: 'X', email: 'x@example.com', password: 'weak' })
      .expect(400);
  });

  it('requires auth for the profile route', async () => {
    await request(app.getHttpServer()).get('/api/auth/profile').expect(401);
  });
});
