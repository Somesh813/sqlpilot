import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ConversationMessageRole } from '@sqlpilot/shared';
import { HydratedDocument, Types } from 'mongoose';

export type ConversationDocument = HydratedDocument<Conversation>;
export type ConversationMessageDocument = HydratedDocument<ConversationMessage>;

@Schema({ timestamps: true, collection: 'conversations' })
export class Conversation {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'DatabaseConnection', default: null })
  connectionId!: Types.ObjectId | null;

  @Prop({ required: true, default: 'New conversation' })
  title!: string;

  @Prop({ default: 0 })
  messageCount!: number;

  @Prop({ type: Date, default: null })
  lastMessageAt!: Date | null;
}

@Schema({ timestamps: true, collection: 'conversation_messages' })
export class ConversationMessage {
  @Prop({ type: Types.ObjectId, ref: 'Conversation', required: true, index: true })
  conversationId!: Types.ObjectId;

  @Prop({ required: true, enum: ConversationMessageRole })
  role!: ConversationMessageRole;

  @Prop({ required: true })
  content!: string;

  @Prop({ type: String, default: null })
  sql!: string | null;

  @Prop({ type: Object, default: null })
  metadata!: Record<string, unknown> | null;
}

export const ConversationSchema = SchemaFactory.createForClass(Conversation);
export const ConversationMessageSchema = SchemaFactory.createForClass(ConversationMessage);
ConversationSchema.index({ userId: 1, updatedAt: -1 });
ConversationMessageSchema.index({ conversationId: 1, createdAt: 1 });
