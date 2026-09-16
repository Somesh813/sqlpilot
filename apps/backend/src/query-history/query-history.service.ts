import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Paginated, QueryHistoryEntry as SharedEntry, QueryStatus } from '@sqlpilot/shared';
import { FilterQuery, Model, Types } from 'mongoose';
import { QueryHistoryDocument, QueryHistoryEntry } from './schemas/query-history.schema';

export interface RecordHistoryInput {
  userId: string;
  connectionId: string;
  connectionName: string;
  conversationId?: string | null;
  prompt?: string | null;
  sql: string;
  status: QueryStatus;
  executionTimeMs?: number | null;
  rowCount?: number | null;
  truncated?: boolean;
  error?: string | null;
  aiGenerated?: boolean;
}

export interface HistoryQuery {
  page?: number;
  pageSize?: number;
  connectionId?: string;
  status?: QueryStatus;
  search?: string;
}

@Injectable()
export class QueryHistoryService {
  constructor(
    @InjectModel(QueryHistoryEntry.name) private readonly model: Model<QueryHistoryDocument>,
  ) {}

  async record(input: RecordHistoryInput): Promise<SharedEntry> {
    const doc = await this.model.create({
      userId: new Types.ObjectId(input.userId),
      connectionId: new Types.ObjectId(input.connectionId),
      connectionName: input.connectionName,
      conversationId: input.conversationId ? new Types.ObjectId(input.conversationId) : null,
      prompt: input.prompt ?? null,
      sql: input.sql,
      status: input.status,
      executionTimeMs: input.executionTimeMs ?? null,
      rowCount: input.rowCount ?? null,
      truncated: input.truncated ?? false,
      error: input.error ?? null,
      aiGenerated: input.aiGenerated ?? false,
    });
    return this.toDto(doc);
  }

  async list(userId: string, query: HistoryQuery): Promise<Paginated<SharedEntry>> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));
    const filter: FilterQuery<QueryHistoryDocument> = { userId: new Types.ObjectId(userId) };
    if (query.connectionId && Types.ObjectId.isValid(query.connectionId)) {
      filter.connectionId = new Types.ObjectId(query.connectionId);
    }
    if (query.status) filter.status = query.status;
    if (query.search) {
      const rx = new RegExp(escapeRegex(query.search), 'i');
      filter.$or = [{ sql: rx }, { prompt: rx }];
    }

    const [items, total] = await Promise.all([
      this.model
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .exec(),
      this.model.countDocuments(filter),
    ]);

    return { items: items.map((d) => this.toDto(d)), total, page, pageSize };
  }

  async get(userId: string, id: string): Promise<SharedEntry> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('History entry not found.');
    const doc = await this.model
      .findOne({ _id: new Types.ObjectId(id), userId: new Types.ObjectId(userId) })
      .exec();
    if (!doc) throw new NotFoundException('History entry not found.');
    return this.toDto(doc);
  }

  async remove(userId: string, id: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('History entry not found.');
    const res = await this.model.deleteOne({
      _id: new Types.ObjectId(id),
      userId: new Types.ObjectId(userId),
    });
    if (res.deletedCount === 0) throw new NotFoundException('History entry not found.');
  }

  private toDto(doc: QueryHistoryDocument): SharedEntry {
    const ts = doc as unknown as { createdAt: Date; updatedAt: Date };
    return {
      id: doc.id,
      userId: doc.userId.toString(),
      connectionId: doc.connectionId.toString(),
      connectionName: doc.connectionName,
      conversationId: doc.conversationId ? doc.conversationId.toString() : null,
      prompt: doc.prompt,
      sql: doc.sql,
      status: doc.status,
      executionTimeMs: doc.executionTimeMs,
      rowCount: doc.rowCount,
      truncated: doc.truncated,
      error: doc.error,
      aiGenerated: doc.aiGenerated,
      createdAt: ts.createdAt.toISOString(),
      updatedAt: ts.updatedAt.toISOString(),
    };
  }
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
