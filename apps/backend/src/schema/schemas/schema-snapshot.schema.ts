import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { DatabaseType, RelationshipSchema, TableSchema } from '@sqlpilot/shared';
import { HydratedDocument, Types } from 'mongoose';

export type SchemaSnapshotDocument = HydratedDocument<SchemaSnapshot>;

@Schema({ timestamps: true, collection: 'schema_snapshots' })
export class SchemaSnapshot {
  @Prop({ type: Types.ObjectId, ref: 'DatabaseConnection', required: true, unique: true, index: true })
  connectionId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  @Prop({ required: true, enum: DatabaseType })
  databaseType!: DatabaseType;

  @Prop({ required: true })
  databaseName!: string;

  @Prop({ type: Array, default: [] })
  tables!: TableSchema[];

  @Prop({ type: Array, default: [] })
  relationships!: RelationshipSchema[];

  @Prop({ type: [String], default: [] })
  functions!: string[];

  @Prop({ required: true })
  discoveredAt!: Date;
}

export const SchemaSnapshotSchema = SchemaFactory.createForClass(SchemaSnapshot);
