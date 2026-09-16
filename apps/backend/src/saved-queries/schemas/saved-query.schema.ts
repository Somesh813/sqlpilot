import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SavedQueryDocument = HydratedDocument<SavedQuery>;
export type PromptTemplateDocument = HydratedDocument<PromptTemplate>;

@Schema({ timestamps: true, collection: 'saved_queries' })
export class SavedQuery {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'DatabaseConnection', default: null })
  connectionId!: Types.ObjectId | null;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ default: '' })
  description!: string;

  @Prop({ required: true })
  sql!: string;

  @Prop({ type: [String], default: [] })
  tags!: string[];
}

@Schema({ timestamps: true, collection: 'prompt_templates' })
export class PromptTemplate {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ default: '' })
  description!: string;

  @Prop({ required: true })
  body!: string;
}

export const SavedQuerySchema = SchemaFactory.createForClass(SavedQuery);
export const PromptTemplateSchema = SchemaFactory.createForClass(PromptTemplate);
SavedQuerySchema.index({ userId: 1, name: 1 });
