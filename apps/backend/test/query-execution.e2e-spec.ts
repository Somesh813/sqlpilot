import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { AuditModule } from '../src/audit/audit.module';
import { AuthModule } from '../src/auth/auth.module';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { CommonModule } from '../src/common/common.module';
import { RolesGuard } from '../src/common/guards/roles.guard';
import configuration from '../src/config/configuration';
import { DatabaseConnectionsModule } from '../src/database-connections/database-connections.module';
import { QueryExecutionModule } from '../src/query-execution/query-execution.module';
import { QueryHistoryModule } from '../src/query-history/query-history.module';
import { UsersModule } from '../src/users/users.module';

describe('Query execution (e2e)', () => {
  let app: INestApplication;
  let mongo: MongoMemoryServer;
  let token: string;
  let connectionId: string;
  let tmpDir: string;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.JWT_SECRET = 'test-access-secret-value-000000000000';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-value-11111111111';
    process.env.ENCRYPTION_KEY = 'c'.repeat(64);
    // Global kill switch is on for this whole suite; per-connection writeEnabled
    // (default false, admin-toggleable) is what the tests below actually exercise.
    process.env.ALLOW_WRITE_QUERIES = 'true';

    tmpDir = mkdtempSync(join(tmpdir(), 'sqlpilot-exec-'));
    process.env.SQLITE_ALLOWED_DIRS = tmpDir;
    const sqlitePath = join(tmpDir, 'shop.sqlite');
    const db = new BetterSqlite3(sqlitePath);
    db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, spend REAL)');
    db.exec("INSERT INTO customers (name, spend) VALUES ('Ada', 500), ('Grace', 900), ('Linus', 100)");
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
        QueryHistoryModule,
        QueryExecutionModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    const reg = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ name: 'Owner', email: 'exec-owner@example.com', password: 'Password123' });
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

  it('validates a safe SELECT and reports it is read-only', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/queries/validate')
      .set(auth())
      .send({ connectionId, sql: 'SELECT * FROM customers' })
      .expect(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.isReadOnly).toBe(true);
  });

  it('validates and flags a DROP TABLE as critical', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/queries/validate')
      .set(auth())
      .send({ connectionId, sql: 'DROP TABLE customers' })
      .expect(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.risk).toBe('CRITICAL');
  });

  it('executes a confirmed SELECT and returns rows', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/queries/execute')
      .set(auth())
      .send({ connectionId, sql: 'SELECT name, spend FROM customers ORDER BY spend DESC', confirmed: true })
      .expect(200);
    expect(res.body.returnedRows).toBe(3);
    expect(res.body.rows[0].name).toBe('Grace');
    expect(res.body.historyId).toBeTruthy();
  });

  it('refuses to execute an unconfirmed query', async () => {
    await request(app.getHttpServer())
      .post('/api/queries/execute')
      .set(auth())
      .send({ connectionId, sql: 'SELECT * FROM customers', confirmed: false })
      .expect(403);
  });

  it('blocks a DROP TABLE at execution time regardless of confirmation', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/queries/execute')
      .set(auth())
      .send({ connectionId, sql: 'DROP TABLE customers', confirmed: true })
      .expect(400);
    expect(res.body.error).toBe('SqlPolicyViolation');
  });

  it('blocks INSERT when write mode is disabled for the connection', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/queries/execute')
      .set(auth())
      .send({ connectionId, sql: "INSERT INTO customers (name, spend) VALUES ('New', 1)", confirmed: true })
      .expect(400);
    expect(res.body.error).toBe('SqlPolicyViolation');
    expect(res.body.validation.violations.map((v: { code: string }) => v.code)).toContain('WRITE_DISABLED');
  });

  it('rejects stacked statements', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/queries/execute')
      .set(auth())
      .send({ connectionId, sql: 'SELECT 1; DROP TABLE customers', confirmed: true })
      .expect(400);
    expect(res.body.error).toBe('SqlPolicyViolation');
  });

  it('surfaces a real database error for an unknown column', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/queries/execute')
      .set(auth())
      .send({ connectionId, sql: 'SELECT not_a_real_column FROM customers', confirmed: true })
      .expect(422);
    expect(res.body.databaseError).toBeTruthy();
  });

  it('records executed queries in history', async () => {
    const res = await request(app.getHttpServer()).get('/api/queries/history').set(auth()).expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(3);
    expect(res.body.items[0]).toHaveProperty('sql');
  });

  it('a USER cannot toggle the write policy', async () => {
    await request(app.getHttpServer())
      .patch(`/api/databases/${connectionId}/write-policy`)
      .set(auth())
      .send({ enabled: true })
      .expect(403);
  });

  it('an ADMIN can enable write mode, after which INSERT succeeds', async () => {
    const client = new MongoClient(mongo.getUri());
    await client.connect();
    await client.db().collection('users').updateOne({ email: 'exec-owner@example.com' }, { $set: { role: 'ADMIN' } });
    await client.close();

    // Re-authenticate so the JWT carries the new role.
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'exec-owner@example.com', password: 'Password123' });
    const adminToken = login.body.accessToken;
    const adminAuth = { Authorization: `Bearer ${adminToken}` };

    await request(app.getHttpServer())
      .patch(`/api/databases/${connectionId}/write-policy`)
      .set(adminAuth)
      .send({ enabled: true })
      .expect(200)
      .expect((res) => expect(res.body.writeEnabled).toBe(true));

    const ok = await request(app.getHttpServer())
      .post('/api/queries/execute')
      .set(adminAuth)
      .send({ connectionId, sql: "INSERT INTO customers (name, spend) VALUES ('New', 1)", confirmed: true })
      .expect(200);
    expect(ok.body.status).toBe('SUCCESS');
  });
});
