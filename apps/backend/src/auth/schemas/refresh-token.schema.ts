import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type RefreshTokenDocument = HydratedDocument<RefreshToken>;

/**
 * One row per issued refresh token. Only a SHA-256 hash of the token is stored.
 * Rotation revokes the previous row; `replacedBy` gives a reuse-detection trail.
 */
@Schema({ timestamps: true, collection: 'refresh_tokens' })
export class RefreshToken {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  @Prop({ required: true, unique: true })
  tokenHash!: string;

  @Prop({ required: true })
  expiresAt!: Date;

  @Prop({ default: false })
  revoked!: boolean;

  @Prop({ type: String, default: null })
  replacedByHash!: string | null;

  @Prop({ type: String, default: null })
  userAgent!: string | null;

  @Prop({ type: String, default: null })
  ip!: string | null;
}

export const RefreshTokenSchema = SchemaFactory.createForClass(RefreshToken);
// TTL index: Mongo removes expired documents automatically.
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
