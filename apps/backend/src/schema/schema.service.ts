import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { withDriver } from '@sqlpilot/database';
import {
  AuditAction,
  ConnectionStatus,
  DatabaseSchemaSnapshot,
  SchemaContext,
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
   * Builds a compact SchemaContext for the AI, limited to `maxTables` most
   * relevant tables. Relevance = tables whose name or a column name matches a
   * keyword in `question`, plus tables they have relationships with.
   */
  async buildContext(
    userId: string,
    connectionId: string,
    question: string,
    maxTables: number,
  ): Promise<SchemaContext> {
    const snapshot = await this.get(userId, connectionId);
    const keywords = tokenize(question);

    const scored = snapshot.tables.map((table) => {
      let score = 0;
      const haystack = `${table.name} ${table.columns.map((c) => c.name).join(' ')}`.toLowerCase();
      for (const kw of keywords) if (haystack.includes(kw)) score += kw.length > 4 ? 3 : 1;
      if (/^(id|name|created_at|updated_at)$/i.test(table.name)) score -= 1;
      return { table, score };
    });

    let chosen = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.table.name);

    // Pull in directly related tables.
    const related = new Set(chosen);
    for (const rel of snapshot.relationships) {
      if (related.has(rel.fromTable)) related.add(rel.toTable);
      if (related.has(rel.toTable)) related.add(rel.fromTable);
    }
    chosen = Array.from(related);

    // If nothing matched, fall back to the largest / most-connected tables.
    if (chosen.length === 0) {
      chosen = snapshot.tables.map((t) => t.name).slice(0, maxTables);
    }

    const includedNames = new Set(chosen.slice(0, maxTables));
    const tables = snapshot.tables.filter((t) => includedNames.has(t.name));
    const omittedTables = snapshot.tables
      .filter((t) => !includedNames.has(t.name))
      .map((t) => t.name);

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

function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9_\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
    ),
  );
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'show', 'find', 'list', 'get', 'all',
  'how', 'many', 'much', 'what', 'which', 'who', 'top', 'per', 'each', 'give', 'last', 'first',
  'total', 'count', 'sum', 'average', 'avg', 'group', 'order', 'sort', 'between', 'over', 'under',
]);
