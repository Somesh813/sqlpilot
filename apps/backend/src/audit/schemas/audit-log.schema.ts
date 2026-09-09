import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { AuditAction } from '@sqlpilot/shared';
import { HydratedDocument, Types } from 'mongoose';

export type AuditLogDocument = HydratedDocument<AuditLog>;

@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'audit_logs' })
export class AuditLog {
  @Prop({ type: Types.ObjectId, ref: 'User', default: null, index: true })
  userId!: Types.ObjectId | null;

  @Prop({ required: true, enum: AuditAction, index: true })
  action!: AuditAction;

  @Prop({ type: Types.ObjectId, ref: 'DatabaseConnection', default: null, index: true })
  connectionId!: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  requestId!: string | null;

  @Prop({ type: String, default: null })
  ip!: string | null;

  @Prop({ type: Object, default: {} })
  detail!: Record<string, unknown>;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
AuditLogSchema.index({ createdAt: -1 });
