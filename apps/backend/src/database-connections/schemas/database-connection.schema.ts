import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ConnectionStatus, DatabaseType } from '@sqlpilot/shared';
import { HydratedDocument, Types } from 'mongoose';

export type DatabaseConnectionDocument = HydratedDocument<DatabaseConnection>;

@Schema({ timestamps: true, collection: 'database_connections' })
export class DatabaseConnection {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, enum: DatabaseType })
  type!: DatabaseType;

  @Prop({ type: String, default: null })
  host!: string | null;

  @Prop({ type: Number, default: null })
  port!: number | null;

  @Prop({ required: true })
  database!: string;

  /** SQLite only — absolute path on the backend host. */
  @Prop({ type: String, default: null })
  filePath!: string | null;

  @Prop({ default: false })
  ssl!: boolean;

  @Prop({ type: Object, default: {} })
  options!: Record<string, string | number | boolean>;

  /**
   * AES-256-GCM ciphertext of `{ username, password }`. Never selected into a
   * response. `null` for credential-less connections (e.g. local SQLite).
   */
  @Prop({ type: String, default: null, select: false })
  encryptedCredentials!: string | null;

  @Prop({ required: true, enum: ConnectionStatus, default: ConnectionStatus.DISCONNECTED })
  status!: ConnectionStatus;

  @Prop({ type: String, default: null })
  lastError!: string | null;

  @Prop({ type: Date, default: null })
  lastConnectedAt!: Date | null;

  @Prop({ type: Date, default: null })
  schemaRefreshedAt!: Date | null;

  /** ADMIN-only. Still gated by the global ALLOW_WRITE_QUERIES flag at execution time. */
  @Prop({ default: false })
  writeEnabled!: boolean;
}

export const DatabaseConnectionSchema = SchemaFactory.createForClass(DatabaseConnection);
DatabaseConnectionSchema.index({ userId: 1, name: 1 }, { unique: true });
