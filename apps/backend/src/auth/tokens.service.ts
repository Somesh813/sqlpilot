import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { AuthTokens, UserRole } from '@sqlpilot/shared';
import { createHash, randomBytes } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { RefreshToken, RefreshTokenDocument } from './schemas/refresh-token.schema';

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
}

export interface RequestContext {
  userAgent?: string | null;
  ip?: string | null;
  requestId?: string | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class TokensService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectModel(RefreshToken.name) private readonly refreshModel: Model<RefreshTokenDocument>,
  ) {}

  async issueTokens(payload: JwtPayload, context: RequestContext): Promise<AuthTokens> {
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.get<string>('jwt.accessSecret'),
      expiresIn: this.config.get<string>('jwt.accessExpiresIn'),
    });

    const refreshToken = randomBytes(48).toString('hex');
    await this.refreshModel.create({
      userId: new Types.ObjectId(payload.sub),
      tokenHash: sha256(refreshToken),
      expiresAt: this.refreshExpiry(),
      userAgent: context.userAgent ?? null,
      ip: context.ip ?? null,
    });

    return { accessToken, refreshToken, expiresIn: this.accessTtlSeconds() };
  }

  /**
   * Validates an opaque refresh token and returns the owning user id.
   * Detects reuse of an already-rotated token and revokes the whole family.
   */
  async consumeRefreshToken(rawToken: string): Promise<{ userId: string; recordId: string }> {
    const hash = sha256(rawToken);
    const record = await this.refreshModel.findOne({ tokenHash: hash }).exec();

    if (!record) throw new UnauthorizedException('Invalid refresh token.');
    if (record.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh token expired.');
    }
    if (record.revoked) {
      await this.revokeAllForUser(record.userId.toString());
      throw new UnauthorizedException(
        'Refresh token has already been used. All sessions for this account were revoked.',
      );
    }
    return { userId: record.userId.toString(), recordId: record.id };
  }

  /** Marks a consumed token as rotated, linking it to its successor. */
  async markRotated(oldRawToken: string, newRawToken: string): Promise<void> {
    await this.refreshModel
      .updateOne(
        { tokenHash: sha256(oldRawToken) },
        { revoked: true, replacedByHash: sha256(newRawToken) },
      )
      .exec();
  }

  async revoke(rawToken: string): Promise<void> {
    await this.refreshModel.updateOne({ tokenHash: sha256(rawToken) }, { revoked: true }).exec();
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.refreshModel.updateMany({ userId: new Types.ObjectId(userId) }, { revoked: true }).exec();
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + parseDuration(this.config.get<string>('jwt.refreshExpiresIn') ?? '7d'));
  }

  private accessTtlSeconds(): number {
    return Math.floor(parseDuration(this.config.get<string>('jwt.accessExpiresIn') ?? '15m') / 1000);
  }
}

export function parseDuration(input: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d)$/.exec(input.trim());
  if (!match) return Number(input) || 0;
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return Number(match[1]) * multipliers[match[2]];
}
