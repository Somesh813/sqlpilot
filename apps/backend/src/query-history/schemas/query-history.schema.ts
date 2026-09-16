import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { QueryStatus } from '@sqlpilot/shared';
import { HydratedDocument, Types } from 'mongoose';

export type QueryHistoryDocument = HydratedDocument<QueryHistoryEntry>;

@Schema({ timestamps: true, collection: 'query_history' })
export class QueryHistoryEntry {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'DatabaseConnection', required: true, index: true })
  connectionId!: Types.ObjectId;

  @Prop({ required: true })
  connectionName!: string;

  @Prop({ type: Types.ObjectId, ref: 'Conversation', default: null })
  conversationId!: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  prompt!: string | null;

  @Prop({ required: true })
  sql!: string;

  @Prop({ required: true, enum: QueryStatus })
  status!: QueryStatus;

  @Prop({ type: Number, default: null })
  executionTimeMs!: number | null;

  @Prop({ type: Number, default: null })
  rowCount!: number | null;

  @Prop({ default: false })
  truncated!: boolean;

  @Prop({ type: String, default: null })
  error!: string | null;

  @Prop({ default: false })
  aiGenerated!: boolean;
}

export const QueryHistorySchema = SchemaFactory.createForClass(QueryHistoryEntry);
QueryHistorySchema.index({ userId: 1, createdAt: -1 });
