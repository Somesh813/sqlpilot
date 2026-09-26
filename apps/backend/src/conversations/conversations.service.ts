import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import {
  Conversation as SharedConversation,
  ConversationMessage as SharedMessage,
  ConversationMessageRole,
} from '@sqlpilot/shared';
import { Model, Types } from 'mongoose';
import {
  Conversation,
  ConversationDocument,
  ConversationMessage,
  ConversationMessageDocument,
} from './schemas/conversation.schema';

export interface AppendMessageInput {
  role: ConversationMessageRole;
  content: string;
  sql?: string | null;
  metadata?: Record<string, unknown> | null;
}

@Injectable()
export class ConversationsService {
  constructor(
    @InjectModel(Conversation.name) private readonly conversationModel: Model<ConversationDocument>,
    @InjectModel(ConversationMessage.name)
    private readonly messageModel: Model<ConversationMessageDocument>,
  ) {}

  async list(userId: string): Promise<SharedConversation[]> {
    const docs = await this.conversationModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ updatedAt: -1 })
      .limit(100)
      .exec();
    return docs.map((d) => this.toDto(d));
  }

  async create(
    userId: string,
    input: { title?: string; connectionId?: string | null },
  ): Promise<SharedConversation> {
    const doc = await this.conversationModel.create({
      userId: new Types.ObjectId(userId),
      connectionId: input.connectionId ? new Types.ObjectId(input.connectionId) : null,
      title: input.title?.trim() || 'New conversation',
    });
    return this.toDto(doc);
  }

  async getWithMessages(
    userId: string,
    id: string,
  ): Promise<{ conversation: SharedConversation; messages: SharedMessage[] }> {
    const conversation = await this.getDoc(userId, id);
    const messages = await this.messageModel
      .find({ conversationId: conversation._id })
      .sort({ createdAt: 1 })
      .exec();
    return {
      conversation: this.toDto(conversation),
      messages: messages.map((m) => this.messageToDto(m)),
    };
  }

  /** Returns the recent turns as compact {role, content} pairs for AI context. */
  async recentTurns(
    userId: string,
    id: string,
    limit = 8,
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const conversation = await this.getDoc(userId, id);
    const messages = await this.messageModel
      .find({ conversationId: conversation._id, role: { $ne: ConversationMessageRole.SYSTEM } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
    return messages
      .reverse()
      .map((m) =>
        m.role === ConversationMessageRole.ASSISTANT
          ? {
              role: 'assistant' as const,
              // The written answer quotes result data (names, amounts, emails). The model only
              // needs the query it wrote, to refine it, so the answer text never goes back out.
              content: m.sql ? `SQL:\n${m.sql}` : '(no query was run)',
            }
          : { role: 'user' as const, content: m.content },
      );
  }

  async append(userId: string, id: string, input: AppendMessageInput): Promise<SharedMessage> {
    const conversation = await this.getDoc(userId, id);
    const message = await this.messageModel.create({
      conversationId: conversation._id,
      role: input.role,
      content: input.content,
      sql: input.sql ?? null,
      metadata: input.metadata ?? null,
    });
    conversation.messageCount += 1;
    conversation.lastMessageAt = new Date();
    if (conversation.messageCount === 1 && input.role === ConversationMessageRole.USER) {
      conversation.title = input.content.slice(0, 60);
    }
    await conversation.save();
    return this.messageToDto(message);
  }

  async remove(userId: string, id: string): Promise<void> {
    const conversation = await this.getDoc(userId, id);
    await this.messageModel.deleteMany({ conversationId: conversation._id });
    await conversation.deleteOne();
  }

  private async getDoc(userId: string, id: string): Promise<ConversationDocument> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Conversation not found.');
    const doc = await this.conversationModel
      .findOne({ _id: new Types.ObjectId(id), userId: new Types.ObjectId(userId) })
      .exec();
    if (!doc) throw new NotFoundException('Conversation not found.');
    return doc;
  }

  private toDto(doc: ConversationDocument): SharedConversation {
    const ts = doc as unknown as { createdAt: Date; updatedAt: Date };
    return {
      id: doc.id,
      userId: doc.userId.toString(),
      connectionId: doc.connectionId ? doc.connectionId.toString() : null,
      title: doc.title,
      messageCount: doc.messageCount,
      lastMessageAt: doc.lastMessageAt ? doc.lastMessageAt.toISOString() : null,
      createdAt: ts.createdAt.toISOString(),
      updatedAt: ts.updatedAt.toISOString(),
    };
  }

  private messageToDto(doc: ConversationMessageDocument): SharedMessage {
    const ts = doc as unknown as { createdAt: Date; updatedAt: Date };
    return {
      id: doc.id,
      conversationId: doc.conversationId.toString(),
      role: doc.role,
      content: doc.content,
      sql: doc.sql,
      metadata: doc.metadata,
      createdAt: ts.createdAt.toISOString(),
      updatedAt: ts.updatedAt.toISOString(),
    };
  }
}
