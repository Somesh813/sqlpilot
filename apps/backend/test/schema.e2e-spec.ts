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
import { SchemaModule } from '../src/schema/schema.module';
import { UsersModule } from '../src/users/users.module';

describe('Schema discovery (e2e)', () => {
  let app: INestApplication;
  let mongo: MongoMemoryServer;
  let token: string;
  let connectionId: string;
  let tmpDir: string;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.JWT_SECRET = 'test-access-secret-value-000000000000';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-value-11111111111';
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);

    tmpDir = mkdtempSync(join(tmpdir(), 'sqlpilot-schema-'));
    process.env.SQLITE_ALLOWED_DIRS = tmpDir;
    const sqlitePath = join(tmpDir, 'shop.sqlite');
    const db = new BetterSqlite3(sqlitePath);
    db.exec(`
      CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES customers(id),
        total REAL NOT NULL,
        created_at TEXT
      );
      CREATE INDEX idx_orders_customer ON orders(customer_id);
    `);
    db.exec("INSERT INTO customers (name, email) VALUES ('Ada', 'ada@x.com'), ('Grace', 'grace@x.com')");
    db.exec("INSERT INTO orders (customer_id, total, created_at) VALUES (1, 99.5, '2026-01-01'), (2, 42, '2026-01-02')");
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
        SchemaModule,
      ],
      providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    const reg = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ name: 'Owner', email: 'schema-owner@example.com', password: 'Password123' });
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

  it('discovers tables, columns, keys, indexes, and relationships', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/databases/${connectionId}/schema`)
      .set(auth())
      .expect(200);

    const names = res.body.tables.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['customers', 'orders']);

    const orders = res.body.tables.find((t: { name: string }) => t.name === 'orders');
    const customerIdCol = orders.columns.find((c: { name: string }) => c.name === 'customer_id');
    expect(customerIdCol.isForeignKey).toBe(true);
    expect(customerIdCol.references).toEqual({ table: 'customers', column: 'id' });
    expect(orders.indexes.some((i: { name: string }) => i.name === 'idx_orders_customer')).toBe(true);

    expect(res.body.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromTable: 'orders', fromColumn: 'customer_id', toTable: 'customers', toColumn: 'id' }),
      ]),
    );
  });

  it('caches the snapshot on repeat reads and updates it on refresh', async () => {
    const first = await request(app.getHttpServer())
      .get(`/api/databases/${connectionId}/schema`)
      .set(auth())
      .expect(200);
    const second = await request(app.getHttpServer())
      .get(`/api/databases/${connectionId}/schema`)
      .set(auth())
      .expect(200);
    expect(second.body.discoveredAt).toBe(first.body.discoveredAt);

    const refreshed = await request(app.getHttpServer())
      .post(`/api/databases/${connectionId}/schema/refresh`)
      .set(auth())
      .expect(200);
    expect(new Date(refreshed.body.discoveredAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.body.discoveredAt).getTime(),
    );
  });

  it('requires authentication and scopes by owner', async () => {
    await request(app.getHttpServer()).get(`/api/databases/${connectionId}/schema`).expect(401);

    const other = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ name: 'Other', email: 'schema-other@example.com', password: 'Password123' });
    await request(app.getHttpServer())
      .get(`/api/databases/${connectionId}/schema`)
      .set({ Authorization: `Bearer ${other.body.accessToken}` })
      .expect(404);
  });
});
