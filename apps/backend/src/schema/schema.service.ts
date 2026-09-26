import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { withDriver } from '@sqlpilot/database';
import {
  AuditAction,
  ConnectionStatus,
  DatabaseSchemaSnapshot,
  SchemaContext,
  selectSchemaTables,
} from '@sqlpilot/shared';
import { Model, Types } from 'mongoose';
import { AuditService } from '../audit/audit.service';
import { DatabaseConnectionsService } from '../database-connections/database-connections.service';
import { SchemaSnapshot, SchemaSnapshotDocument } from './schemas/schema-snapshot.schema';

@Injectable()
export class SchemaService {
  private readonly logger = new Logger('Schema');

  constructor(
    @InjectModel(SchemaSnapshot.name) private readonly model: Model<SchemaSnapshotDocument>,
    private readonly connections: DatabaseConnectionsService,
    private readonly audit: AuditService,
  ) {}

  /** Returns the cached snapshot, discovering it on first access. */
  async get(userId: string, connectionId: string): Promise<DatabaseSchemaSnapshot> {
    const existing = await this.model
      .findOne({ connectionId: new Types.ObjectId(connectionId), userId: new Types.ObjectId(userId) })
      .exec();
    if (existing) return this.toDto(existing);
    return this.refresh(userId, connectionId, {});
  }

  async getCachedOrNull(userId: string, connectionId: string): Promise<DatabaseSchemaSnapshot | null> {
    const doc = await this.model
      .findOne({ connectionId: new Types.ObjectId(connectionId), userId: new Types.ObjectId(userId) })
      .exec();
    return doc ? this.toDto(doc) : null;
  }

  async refresh(
    userId: string,
    connectionId: string,
    ctx: { requestId?: string | null; ip?: string | null },
  ): Promise<DatabaseSchemaSnapshot> {
    const connection = await this.connections.get(userId, connectionId);
    const config = await this.connections.resolveDriverConfig(userId, connectionId);

    let result;
    try {
      result = await withDriver(config, (driver) => driver.introspect());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.connections.markStatus(connectionId, ConnectionStatus.ERROR, message);
      throw new NotFoundException(`Could not read the schema: ${message}`);
    }

    const now = new Date();
    const doc = await this.model.findOneAndUpdate(
      { connectionId: new Types.ObjectId(connectionId) },
      {
        connectionId: new Types.ObjectId(connectionId),
        userId: new Types.ObjectId(userId),
        databaseType: connection.type,
        databaseName: result.databaseName,
        tables: result.tables,
        relationships: result.relationships,
        functions: result.functions,
        discoveredAt: now,
      },
      { upsert: true, new: true },
    );

    await this.connections.markStatus(connectionId, ConnectionStatus.CONNECTED, null);
    await this.connections.touchSchemaRefreshed(connectionId, now);
    await this.audit.record({
      userId,
      action: AuditAction.SCHEMA_REFRESHED,
      connectionId,
      requestId: ctx.requestId,
      ip: ctx.ip,
      detail: { tables: result.tables.length },
    });

    return this.toDto(doc);
  }

  /**
   * Builds the SchemaContext for the AI. Small schemas are sent whole; larger ones are
   * narrowed by meaning and connected through the foreign-key graph (see selectSchemaTables).
   */
  async buildContext(
    userId: string,
    connectionId: string,
    question: string,
    maxTables: number,
  ): Promise<SchemaContext> {
    const snapshot = await this.get(userId, connectionId);
    const selection = selectSchemaTables(snapshot.tables, snapshot.relationships, question, { maxTables });
    const includedNames = new Set(selection.tables);
    const tables = snapshot.tables.filter((t) => includedNames.has(t.name));
    const omittedTables = selection.omitted;

    return {
      databaseType: snapshot.databaseType,
      databaseName: snapshot.databaseName,
      tables,
      relationships: snapshot.relationships.filter(
        (r) => includedNames.has(r.fromTable) && includedNames.has(r.toTable),
      ),
      omittedTables,
    };
  }

  private toDto(doc: SchemaSnapshotDocument): DatabaseSchemaSnapshot {
    const ts = doc as unknown as { createdAt: Date; updatedAt: Date };
    return {
      id: doc.id,
      connectionId: doc.connectionId.toString(),
      databaseType: doc.databaseType,
      databaseName: doc.databaseName,
      tables: doc.tables,
      relationships: doc.relationships,
      functions: doc.functions,
      discoveredAt: doc.discoveredAt.toISOString(),
      createdAt: ts.createdAt.toISOString(),
      updatedAt: ts.updatedAt.toISOString(),
    };
  }
}
