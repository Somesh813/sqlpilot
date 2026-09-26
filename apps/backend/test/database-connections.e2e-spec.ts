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
import { AuditModule } from '../src/audit/audit.module';
import { AuthModule } from '../src/auth/auth.module';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { CommonModule } from '../src/common/common.module';
import configuration from '../src/config/configuration';
import { DatabaseConnectionsModule } from '../src/database-connections/database-connections.module';
import { UsersModule } from '../src/users/users.module';

describe('Database connections (e2e)', () => {
  let app: INestApplication;
  let mongo: MongoMemoryServer;
  let token: string;
  let tmpDir: string;
  let sqlitePath: string;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.JWT_SECRET = 'test-access-secret-value-000000000000';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-value-11111111111';
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);

    tmpDir = mkdtempSync(join(tmpdir(), 'sqlpilot-'));
    process.env.SQLITE_ALLOWED_DIRS = tmpDir;
    sqlitePath = join(tmpDir, 'sample.sqlite');
    const db = new BetterSqlite3(sqlitePath);
    db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    db.exec("INSERT INTO customers (name) VALUES ('Ada'), ('Grace')");
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
      ],
      providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    const reg = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ name: 'Owner', email: 'owner@example.com', password: 'Password123' });
    token = reg.body.accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/api/databases').expect(401);
  });

  it('tests an ad-hoc SQLite connection before saving', async () => {
    const ok = await request(app.getHttpServer())
      .post('/api/databases/test')
      .set(auth())
      .send({ name: 'probe', type: 'sqlite', database: 'sample', filePath: sqlitePath })
      .expect(200);
    expect(ok.body.ok).toBe(true);

    const bad = await request(app.getHttpServer())
      .post('/api/databases/test')
      .set(auth())
      .send({ name: 'probe', type: 'sqlite', database: 'sample', filePath: join(tmpDir, 'nope.sqlite') })
      .expect(400);
    expect(bad.body.message).toMatch(/not available/);
  });

  it('F4: paths outside the approved directory look exactly like missing ones (no existence oracle)', async () => {
    const send = (filePath: string) =>
      request(app.getHttpServer())
        .post('/api/databases/test')
        .set(auth())
        .send({ name: 'probe', type: 'sqlite', database: 'x', filePath });
    const missing = await send(join(tmpDir, 'nope.sqlite')).expect(400);
    for (const p of [process.execPath, '/etc/passwd', 'C:\Windows\win.ini', join(tmpDir, '..', 'x.sqlite')]) {
      const res = await send(p).expect(400);
      expect(res.body.message).toBe(missing.body.message);
    }
  });

  it('creates a connection and never returns credentials', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/databases')
      .set(auth())
      .send({
        name: 'Local SQLite',
        type: 'sqlite',
        database: 'sample',
        filePath: sqlitePath,
      })
      .expect(201);

    expect(res.body.status).toBe('CONNECTED');
    expect(res.body).not.toHaveProperty('password');
    expect(res.body).not.toHaveProperty('username');
    expect(res.body).not.toHaveProperty('encryptedCredentials');
  });

  it('never returns credentials for a Postgres connection (test against unreachable host)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/databases')
      .set(auth())
      .send({
        name: 'PG somewhere',
        type: 'postgres',
        host: '127.0.0.1',
        port: 59999,
        database: 'app',
        username: 'secretuser',
        password: 'secretpass',
      })
      .expect(201);
    // Connection fails (nothing on :59999) but the row is still created, without secrets.
    expect(res.body.status).toBe('ERROR');
    expect(JSON.stringify(res.body)).not.toContain('secretpass');
    expect(JSON.stringify(res.body)).not.toContain('secretuser');
    await request(app.getHttpServer()).delete(`/api/databases/${res.body.id}`).set(auth()).expect(204);
  });

  it('rejects a Postgres connection with missing host', async () => {
    await request(app.getHttpServer())
      .post('/api/databases')
      .set(auth())
      .send({ name: 'bad pg', type: 'postgres', database: 'app', username: 'u', password: 'p' })
      .expect(400);
  });

  it('lists, re-tests, and deletes a connection', async () => {
    const list = await request(app.getHttpServer()).get('/api/databases').set(auth()).expect(200);
    expect(list.body).toHaveLength(1);
    const id = list.body[0].id;

    const test = await request(app.getHttpServer())
      .post(`/api/databases/${id}/test`)
      .set(auth())
      .expect(200);
    expect(test.body.ok).toBe(true);

    await request(app.getHttpServer()).delete(`/api/databases/${id}`).set(auth()).expect(204);
    const after = await request(app.getHttpServer()).get('/api/databases').set(auth()).expect(200);
    expect(after.body).toHaveLength(0);
  });

  it("enforces one user's connections are invisible to another", async () => {
    await request(app.getHttpServer())
      .post('/api/databases')
      .set(auth())
      .send({ name: 'Mine', type: 'sqlite', database: 'sample', filePath: sqlitePath })
      .expect(201);

    const other = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ name: 'Other', email: 'other@example.com', password: 'Password123' });
    const list = await request(app.getHttpServer())
      .get('/api/databases')
      .set({ Authorization: `Bearer ${other.body.accessToken}` })
      .expect(200);
    expect(list.body).toHaveLength(0);
  });
});
