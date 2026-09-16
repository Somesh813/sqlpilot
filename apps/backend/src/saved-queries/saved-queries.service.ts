import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { PromptTemplate as SharedPrompt, SavedQuery as SharedSavedQuery } from '@sqlpilot/shared';
import { Model, Types } from 'mongoose';
import {
  PromptTemplate,
  PromptTemplateDocument,
  SavedQuery,
  SavedQueryDocument,
} from './schemas/saved-query.schema';

export interface SavedQueryInput {
  name: string;
  description?: string;
  sql: string;
  connectionId?: string | null;
  tags?: string[];
}

export interface PromptInput {
  name: string;
  description?: string;
  body: string;
}

@Injectable()
export class SavedQueriesService {
  constructor(
    @InjectModel(SavedQuery.name) private readonly savedModel: Model<SavedQueryDocument>,
    @InjectModel(PromptTemplate.name) private readonly promptModel: Model<PromptTemplateDocument>,
  ) {}

  async list(userId: string, search?: string): Promise<SharedSavedQuery[]> {
    const filter: Record<string, unknown> = { userId: new Types.ObjectId(userId) };
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { description: rx }, { tags: rx }];
    }
    const docs = await this.savedModel.find(filter).sort({ updatedAt: -1 }).exec();
    return docs.map((d) => this.toSavedDto(d));
  }

  async create(userId: string, input: SavedQueryInput): Promise<SharedSavedQuery> {
    const doc = await this.savedModel.create({
      userId: new Types.ObjectId(userId),
      connectionId: input.connectionId ? new Types.ObjectId(input.connectionId) : null,
      name: input.name,
      description: input.description ?? '',
      sql: input.sql,
      tags: normalizeTags(input.tags),
    });
    return this.toSavedDto(doc);
  }

  async update(userId: string, id: string, input: Partial<SavedQueryInput>): Promise<SharedSavedQuery> {
    const doc = await this.getSaved(userId, id);
    if (input.name !== undefined) doc.name = input.name;
    if (input.description !== undefined) doc.description = input.description;
    if (input.sql !== undefined) doc.sql = input.sql;
    if (input.tags !== undefined) doc.tags = normalizeTags(input.tags);
    if (input.connectionId !== undefined) {
      doc.connectionId = input.connectionId ? new Types.ObjectId(input.connectionId) : null;
    }
    await doc.save();
    return this.toSavedDto(doc);
  }

  async remove(userId: string, id: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Saved query not found.');
    const res = await this.savedModel.deleteOne({
      _id: new Types.ObjectId(id),
      userId: new Types.ObjectId(userId),
    });
    if (res.deletedCount === 0) throw new NotFoundException('Saved query not found.');
  }

  async listPrompts(userId: string): Promise<SharedPrompt[]> {
    const docs = await this.promptModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ updatedAt: -1 })
      .exec();
    return docs.map((d) => this.toPromptDto(d));
  }

  async createPrompt(userId: string, input: PromptInput): Promise<SharedPrompt> {
    const doc = await this.promptModel.create({
      userId: new Types.ObjectId(userId),
      name: input.name,
      description: input.description ?? '',
      body: input.body,
    });
    return this.toPromptDto(doc);
  }

  async removePrompt(userId: string, id: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Prompt not found.');
    const res = await this.promptModel.deleteOne({
      _id: new Types.ObjectId(id),
      userId: new Types.ObjectId(userId),
    });
    if (res.deletedCount === 0) throw new NotFoundException('Prompt not found.');
  }

  private async getSaved(userId: string, id: string): Promise<SavedQueryDocument> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Saved query not found.');
    const doc = await this.savedModel
      .findOne({ _id: new Types.ObjectId(id), userId: new Types.ObjectId(userId) })
      .exec();
    if (!doc) throw new NotFoundException('Saved query not found.');
    return doc;
  }

  private toSavedDto(doc: SavedQueryDocument): SharedSavedQuery {
    const ts = doc as unknown as { createdAt: Date; updatedAt: Date };
    return {
      id: doc.id,
      userId: doc.userId.toString(),
      connectionId: doc.connectionId ? doc.connectionId.toString() : null,
      name: doc.name,
      description: doc.description,
      sql: doc.sql,
      tags: doc.tags,
      createdAt: ts.createdAt.toISOString(),
      updatedAt: ts.updatedAt.toISOString(),
    };
  }

  private toPromptDto(doc: PromptTemplateDocument): SharedPrompt {
    const ts = doc as unknown as { createdAt: Date; updatedAt: Date };
    return {
      id: doc.id,
      userId: doc.userId.toString(),
      name: doc.name,
      description: doc.description,
      body: doc.body,
      createdAt: ts.createdAt.toISOString(),
      updatedAt: ts.updatedAt.toISOString(),
    };
  }
}

function normalizeTags(tags?: string[]): string[] {
  return Array.from(new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))).slice(0, 12);
}
