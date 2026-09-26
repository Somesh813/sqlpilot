import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createDriver, DriverConfig, withDriver } from '@sqlpilot/database';
import {
  AuditAction,
  ConnectionStatus,
  DatabaseType,
  DEFAULT_PORTS,
  SafeDatabaseConnection,
  TestConnectionResult,
} from '@sqlpilot/shared';
import { Model, Types } from 'mongoose';
import { AuditService } from '../audit/audit.service';
import { EncryptionService } from '../common/services/encryption.service';
import {
  assertHostAllowed,
  assertSqlitePathAllowed,
  ConnectionPolicy,
  safeConnectionError,
} from './connection-policy';
import {
  DatabaseConnection,
  DatabaseConnectionDocument,
} from './schemas/database-connection.schema';

interface Credentials {
  username?: string;
  password?: string;
}

export interface ConnectionInput {
  name: string;
  type: DatabaseType;
  host?: string;
  port?: number;
  database: string;
  filePath?: string;
  username?: string;
  password?: string;
  ssl?: boolean;
  options?: Record<string, string | number | boolean>;
}

@Injectable()
export class DatabaseConnectionsService {
  private readonly logger = new Logger('DatabaseConnections');

  constructor(
    @InjectModel(DatabaseConnection.name)
    private readonly model: Model<DatabaseConnectionDocument>,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  async list(userId: string): Promise<SafeDatabaseConnection[]> {
    const docs = await this.model
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .exec();
    return docs.map((d) => this.toDto(d));
  }

  async get(userId: string, id: string): Promise<SafeDatabaseConnection> {
    return this.toDto(await this.getDoc(userId, id));
  }

  async create(
    userId: string,
    input: ConnectionInput,
    ctx: { requestId?: string | null; ip?: string | null },
  ): Promise<SafeDatabaseConnection> {
    this.assertShape(input);
    input = await this.assertTargetAllowed(input);
    const exists = await this.model.exists({
      userId: new Types.ObjectId(userId),
      name: input.name,
    });
    if (exists) throw new ConflictException('A connection with this name already exists.');

    // Validate the connection works before persisting it.
    const test = await this.runTest(this.toDriverConfig(input, input));
    const encryptedCredentials = this.encryptCredentials(input);

    const doc = await this.model.create({
      userId: new Types.ObjectId(userId),
      name: input.name,
      type: input.type,
      host: input.host ?? null,
      port: input.port ?? this.defaultPort(input.type),
      database: input.database,
      filePath: input.filePath ?? null,
      ssl: input.ssl ?? false,
      options: input.options ?? {},
      encryptedCredentials,
      status: test.ok ? ConnectionStatus.CONNECTED : ConnectionStatus.ERROR,
      lastError: test.error,
      lastConnectedAt: test.ok ? new Date() : null,
    });

    await this.audit.record({
      userId,
      action: AuditAction.CONNECTION_CREATED,
      connectionId: doc.id,
      requestId: ctx.requestId,
      ip: ctx.ip,
      detail: { type: input.type, database: input.database, testOk: test.ok },
    });
    return this.toDto(doc);
  }

  async update(
    userId: string,
    id: string,
    input: Partial<ConnectionInput>,
    ctx: { requestId?: string | null; ip?: string | null },
  ): Promise<SafeDatabaseConnection> {
    const doc = await this.getDocWithCredentials(userId, id);

    if (input.name && input.name !== doc.name) {
      const clash = await this.model.exists({
        userId: new Types.ObjectId(userId),
        name: input.name,
        _id: { $ne: doc._id },
      });
      if (clash) throw new ConflictException('A connection with this name already exists.');
      doc.name = input.name;
    }

    if (input.host !== undefined) doc.host = input.host || null;
    if (input.port !== undefined) doc.port = input.port;
    if (input.database !== undefined) doc.database = input.database;
    if (input.filePath !== undefined) doc.filePath = input.filePath || null;
    if (input.ssl !== undefined) doc.ssl = input.ssl;
    if (input.options !== undefined) doc.options = input.options;

    const current = this.decryptCredentials(doc.encryptedCredentials);
    const nextCreds: Credentials = {
      username: input.username ?? current.username,
      password: input.password ?? current.password,
    };
    if (input.username !== undefined || input.password !== undefined) {
      doc.encryptedCredentials =
        nextCreds.username || nextCreds.password
          ? this.encryption.encryptJson(nextCreds)
          : null;
    }

    const checked = await this.assertTargetAllowed(this.toInput(doc, nextCreds));
    this.assertShape(checked);
    if (doc.type === DatabaseType.SQLITE) doc.filePath = checked.filePath ?? doc.filePath;
    doc.status = ConnectionStatus.DISCONNECTED;
    await doc.save();

    await this.audit.record({
      userId,
      action: AuditAction.CONNECTION_UPDATED,
      connectionId: doc.id,
      requestId: ctx.requestId,
      ip: ctx.ip,
    });
    return this.toDto(doc);
  }

  async remove(
    userId: string,
    id: string,
    ctx: { requestId?: string | null; ip?: string | null },
  ): Promise<void> {
    const res = await this.model.deleteOne({
      _id: new Types.ObjectId(id),
      userId: new Types.ObjectId(userId),
    });
    if (res.deletedCount === 0) throw new NotFoundException('Connection not found.');
    await this.audit.record({
      userId,
      action: AuditAction.CONNECTION_DELETED,
      connectionId: id,
      requestId: ctx.requestId,
      ip: ctx.ip,
    });
  }

  /** Ad-hoc test for a not-yet-saved connection. */
  async testAdHoc(input: ConnectionInput): Promise<TestConnectionResult> {
    this.assertShape(input);
    input = await this.assertTargetAllowed(input);
    return this.runTest(this.toDriverConfig(input, input));
  }

  /** Test a stored connection and persist the resulting status. */
  async testExisting(
    userId: string,
    id: string,
    ctx: { requestId?: string | null; ip?: string | null },
  ): Promise<TestConnectionResult> {
    const doc = await this.getDocWithCredentials(userId, id);
    const result = await this.runTest(await this.checkedConfig(doc));

    doc.status = result.ok ? ConnectionStatus.CONNECTED : ConnectionStatus.ERROR;
    doc.lastError = result.error;
    if (result.ok) doc.lastConnectedAt = new Date();
    await doc.save();

    await this.audit.record({
      userId,
      action: AuditAction.CONNECTION_TESTED,
      connectionId: id,
      requestId: ctx.requestId,
      ip: ctx.ip,
      detail: { ok: result.ok },
    });
    return result;
  }

  /**
   * Resolves the full driver config (with decrypted credentials) for a stored
   * connection. Used by the schema and query-execution modules. Never exposed
   * over HTTP.
   */
  async resolveDriverConfig(userId: string, id: string): Promise<DriverConfig> {
    return this.checkedConfig(await this.getDocWithCredentials(userId, id));
  }

  async markStatus(id: string, status: ConnectionStatus, error: string | null): Promise<void> {
    await this.model.updateOne({ _id: id }, { status, lastError: error }).exec();
  }

  async touchSchemaRefreshed(id: string, at: Date): Promise<void> {
    await this.model.updateOne({ _id: id }, { schemaRefreshedAt: at }).exec();
  }

  /** ADMIN-only. Enables/disables non-SELECT statements for this connection. */
  async setWritePolicy(userId: string, id: string, enabled: boolean): Promise<SafeDatabaseConnection> {
    const doc = await this.getDoc(userId, id);
    doc.writeEnabled = enabled;
    await doc.save();
    return this.toDto(doc);
  }

  // ---------------------------------------------------------------------------

  private policy(): ConnectionPolicy {
    const sec = this.config.get<{ sqliteAllowedDirs: string[]; dbAllowedHosts: string[]; blockPrivateHosts: boolean }>('security');
    return {
      sqliteAllowedDirs: sec?.sqliteAllowedDirs ?? [],
      allowedHosts: sec?.dbAllowedHosts ?? [],
      blockPrivateHosts: sec?.blockPrivateHosts ?? true,
    };
  }

  /** Enforced on create, update, test AND every use, so a stored or edited target cannot bypass it. */
  private async assertTargetAllowed(input: ConnectionInput): Promise<ConnectionInput> {
    if (input.type === DatabaseType.SQLITE) {
      return { ...input, filePath: assertSqlitePathAllowed(input.filePath ?? '', this.policy()) };
    }
    await assertHostAllowed(input.host ?? '', this.policy());
    return input;
  }

  private async checkedConfig(doc: DatabaseConnectionDocument): Promise<DriverConfig> {
    const config = this.resolveConfig(doc);
    if (config.type === DatabaseType.SQLITE) {
      config.filePath = assertSqlitePathAllowed(config.filePath ?? '', this.policy());
    } else {
      await assertHostAllowed(config.host ?? '', this.policy());
    }
    return config;
  }

  private async runTest(config: DriverConfig): Promise<TestConnectionResult> {
    try {
      const result = await withDriver(config, (driver) => driver.testConnection());
      if (!result.ok) this.logger.warn(`Connection test failed: ${result.error}`);
      return { ...result, error: safeConnectionError(result.error) };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Connection test failed: ${raw}`);
      return { ok: false, latencyMs: null, serverVersion: null, error: safeConnectionError(raw) };
    }
  }

  private resolveConfig(doc: DatabaseConnectionDocument): DriverConfig {
    const creds = this.decryptCredentials(doc.encryptedCredentials);
    return {
      type: doc.type,
      host: doc.host ?? undefined,
      port: doc.port ?? undefined,
      database: doc.database,
      filePath: doc.filePath ?? undefined,
      username: creds.username,
      password: creds.password,
      ssl: doc.ssl,
      options: doc.options,
    };
  }

  private toDriverConfig(input: ConnectionInput, creds: Credentials): DriverConfig {
    return {
      type: input.type,
      host: input.host,
      port: input.port ?? this.defaultPort(input.type),
      database: input.database,
      filePath: input.filePath,
      username: creds.username,
      password: creds.password,
      ssl: input.ssl,
      options: input.options,
    };
  }

  private encryptCredentials(input: Credentials): string | null {
    if (!input.username && !input.password) return null;
    return this.encryption.encryptJson({ username: input.username, password: input.password });
  }

  private decryptCredentials(payload: string | null | undefined): Credentials {
    if (!payload) return {};
    try {
      return this.encryption.decryptJson<Credentials>(payload);
    } catch (error) {
      this.logger.error(`Failed to decrypt stored credentials: ${String(error)}`);
      throw new BadRequestException('Stored credentials could not be read. Re-enter them.');
    }
  }

  private assertShape(input: ConnectionInput): void {
    if (input.type === DatabaseType.SQLITE) {
      if (!input.filePath) throw new BadRequestException('SQLite connections require a file path.');
    } else if (!input.host || !input.database) {
      throw new BadRequestException('Host and database are required for this connection type.');
    }
  }

  private defaultPort(type: DatabaseType): number | undefined {
    const port = DEFAULT_PORTS[type];
    return port ? port : undefined;
  }

  private toInput(doc: DatabaseConnectionDocument, creds: Credentials): ConnectionInput {
    return {
      name: doc.name,
      type: doc.type,
      host: doc.host ?? undefined,
      port: doc.port ?? undefined,
      database: doc.database,
      filePath: doc.filePath ?? undefined,
      username: creds.username,
      password: creds.password,
      ssl: doc.ssl,
      options: doc.options,
    };
  }

  private async getDoc(userId: string, id: string): Promise<DatabaseConnectionDocument> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Connection not found.');
    const doc = await this.model
      .findOne({ _id: new Types.ObjectId(id), userId: new Types.ObjectId(userId) })
      .exec();
    if (!doc) throw new NotFoundException('Connection not found.');
    return doc;
  }

  private async getDocWithCredentials(
    userId: string,
    id: string,
  ): Promise<DatabaseConnectionDocument> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Connection not found.');
    const doc = await this.model
      .findOne({ _id: new Types.ObjectId(id), userId: new Types.ObjectId(userId) })
      .select('+encryptedCredentials')
      .exec();
    if (!doc) throw new NotFoundException('Connection not found.');
    return doc;
  }

  toDto(doc: DatabaseConnectionDocument): SafeDatabaseConnection {
    const ts = doc as unknown as { createdAt: Date; updatedAt: Date };
    return {
      id: doc.id,
      userId: doc.userId.toString(),
      name: doc.name,
      type: doc.type,
      host: doc.host,
      port: doc.port,
      database: doc.database,
      filePath: doc.filePath,
      ssl: doc.ssl,
      options: doc.options,
      status: doc.status,
      lastError: doc.lastError,
      lastConnectedAt: doc.lastConnectedAt ? doc.lastConnectedAt.toISOString() : null,
      schemaRefreshedAt: doc.schemaRefreshedAt ? doc.schemaRefreshedAt.toISOString() : null,
      writeEnabled: doc.writeEnabled,
      createdAt: ts.createdAt.toISOString(),
      updatedAt: ts.updatedAt.toISOString(),
    };
  }
}
