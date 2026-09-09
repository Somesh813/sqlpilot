import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { User as SharedUser, UserRole } from '@sqlpilot/shared';
import { Model } from 'mongoose';
import { User, UserDocument } from './schemas/user.schema';

export interface CreateUserInput {
  name: string;
  email: string;
  passwordHash: string;
  role?: UserRole;
}

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private readonly userModel: Model<UserDocument>) {}

  async create(input: CreateUserInput): Promise<UserDocument> {
    const existing = await this.userModel.exists({ email: input.email.toLowerCase() });
    if (existing) {
      throw new ConflictException('An account with this email already exists.');
    }
    return this.userModel.create({
      name: input.name,
      email: input.email.toLowerCase(),
      passwordHash: input.passwordHash,
      role: input.role ?? UserRole.USER,
    });
  }

  findByEmail(email: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ email: email.toLowerCase() }).exec();
  }

  /** Looks up a user by a non-expired password reset token hash. */
  findByActiveResetToken(tokenHash: string): Promise<UserDocument | null> {
    return this.userModel
      .findOne({
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: { $gt: new Date() },
      })
      .exec();
  }

  async findByIdOrThrow(id: string): Promise<UserDocument> {
    const user = await this.userModel.findById(id).exec();
    if (!user) throw new NotFoundException('User not found.');
    return user;
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.userModel
      .updateOne(
        { _id: id },
        { passwordHash, passwordResetTokenHash: null, passwordResetExpiresAt: null },
      )
      .exec();
  }

  async setResetToken(id: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.userModel
      .updateOne({ _id: id }, { passwordResetTokenHash: tokenHash, passwordResetExpiresAt: expiresAt })
      .exec();
  }

  async recordLogin(id: string): Promise<void> {
    await this.userModel.updateOne({ _id: id }, { lastLoginAt: new Date() }).exec();
  }

  toDto(user: UserDocument): SharedUser {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      createdAt: (user as unknown as { createdAt: Date }).createdAt.toISOString(),
      updatedAt: (user as unknown as { updatedAt: Date }).updatedAt.toISOString(),
    };
  }
}
