import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { UserRole } from '@sqlpilot/shared';
import { HydratedDocument } from 'mongoose';

export type UserDocument = HydratedDocument<User>;

@Schema({ timestamps: true, collection: 'users' })
export class User {
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true, index: true })
  email!: string;

  @Prop({ required: true })
  passwordHash!: string;

  @Prop({ required: true, enum: UserRole, default: UserRole.USER })
  role!: UserRole;

  @Prop({ type: String, default: null })
  passwordResetTokenHash!: string | null;

  @Prop({ type: Date, default: null })
  passwordResetExpiresAt!: Date | null;

  @Prop({ type: Date, default: null })
  lastLoginAt!: Date | null;
}

export const UserSchema = SchemaFactory.createForClass(User);

UserSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, record) => {
    const ret = record as unknown as Record<string, unknown>;
    ret['id'] = ret['_id'];
    delete ret['_id'];
    delete ret['__v'];
    delete ret['passwordHash'];
    delete ret['passwordResetTokenHash'];
    delete ret['passwordResetExpiresAt'];
    return ret;
  },
});
