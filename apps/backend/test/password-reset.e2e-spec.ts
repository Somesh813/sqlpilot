import { ConsoleLogger, INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { AuditModule } from '../src/audit/audit.module';
import { AuthModule } from '../src/auth/auth.module';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import configuration from '../src/config/configuration';
import { validateEnv } from '../src/config/env.validation';
import { UsersModule } from '../src/users/users.module';

/** F6: reset tokens are delivered by mail only; never returned, never logged. */
describe('Password reset (e2e)', () => {
  let app: INestApplication;
  let mongo: MongoMemoryServer;
  let outbox: string;
  const logged: string[] = [];
  const email = 'reset-me@example.com';

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    outbox = mkdtempSync(join(tmpdir(), 'sqlpilot-outbox-'));
    process.env.JWT_SECRET = 'test-access-secret-value-000000000000';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-value-11111111111';
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.MAIL_TRANSPORT = 'file';
    process.env.MAIL_OUTBOX_DIR = outbox;
    process.env.APP_BASE_URL = 'https://app.example.test';

    // capture EVERYTHING the app logs
    const capture = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    jest.spyOn(ConsoleLogger.prototype, 'log').mockImplementation(capture);
    jest.spyOn(ConsoleLogger.prototype, 'warn').mockImplementation(capture);
    jest.spyOn(ConsoleLogger.prototype, 'error').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(capture);

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
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ name: 'Reset Me', email, password: 'OldPassword123' })
      .expect(201);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
    await mongo.stop();
    rmSync(outbox, { recursive: true, force: true });
  });

  const mailFiles = () => readdirSync(outbox).map((f) => readFileSync(join(outbox, f), 'utf8'));
  const waitForMail = async (n: number) => {
    for (let i = 0; i < 50 && mailFiles().length < n; i++) await new Promise((r) => setTimeout(r, 50));
  };

  it('answers identically for a known and an unknown email, with no token in the response', async () => {
    const known = await request(app.getHttpServer()).post('/api/auth/forgot-password').send({ email });
    const unknown = await request(app.getHttpServer()).post('/api/auth/forgot-password').send({ email: 'ghost@example.com' });
    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
    expect(JSON.stringify(known.body)).not.toMatch(/token/i);
    expect(known.headers['set-cookie']).toBeUndefined();
  });

  it('delivers the link by mail (fragment, not query string) and only to real accounts', async () => {
    await waitForMail(1);
    const mails = mailFiles();
    expect(mails).toHaveLength(1); // nothing was written for ghost@example.com
    expect(mails[0]).toContain(`To: ${email}`);
    expect(mails[0]).toMatch(/https:\/\/app\.example\.test\/reset-password#token=[0-9a-f]{64}/);
    expect(mails[0]).not.toMatch(/reset-password\?token=/);
  });

  it('never writes the token to any log line', async () => {
    const token = /#token=([0-9a-f]{64})/.exec(mailFiles()[0])![1];
    expect(logged.join('\n')).not.toContain(token);
    expect(logged.join('\n')).not.toMatch(/[0-9a-f]{64}/);
  });

  it('the emailed token resets the password once, and only once', async () => {
    const token = /#token=([0-9a-f]{64})/.exec(mailFiles()[0])![1];
    await request(app.getHttpServer()).post('/api/auth/reset-password').send({ token, password: 'BrandNewPass123' }).expect(204);
    await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'BrandNewPass123' }).expect(200);
    await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'OldPassword123' }).expect(401);
    await request(app.getHttpServer()).post('/api/auth/reset-password').send({ token, password: 'AnotherPass123' }).expect(401);
  });

  it('rejects a guessed token', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/reset-password')
      .send({ token: 'a'.repeat(64), password: 'BrandNewPass123' })
      .expect(401);
  });
});

describe('mail configuration cannot leak development behaviour into production', () => {
  const base = {
    DATABASE_URL: 'mongodb://app:9f2c1a7e5b3d4c8a@db:27017/x',
    JWT_SECRET: 'a'.repeat(40),
    JWT_REFRESH_SECRET: 'b'.repeat(40),
    ENCRYPTION_KEY: 'c'.repeat(64),
    OPENAI_API_KEY: 'sk-test',
  };
  it('refuses the file outbox in production', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', MAIL_TRANSPORT: 'file' })).toThrow(/not allowed in production/);
  });
  it('requires an SMTP url when smtp is selected', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', MAIL_TRANSPORT: 'smtp' })).toThrow(/MAIL_SMTP_URL/);
  });
  it('production without mail config boots, with mail disabled (nothing is exposed instead)', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).not.toThrow();
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', MAIL_TRANSPORT: 'smtp', MAIL_SMTP_URL: 'smtp://u:p@h:587' })).not.toThrow();
  });
});
