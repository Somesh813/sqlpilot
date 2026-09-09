import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, AuthResponse } from '@sqlpilot/shared';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { UserDocument } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import { JwtPayload, RequestContext, TokensService, parseDuration } from './tokens.service';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    private readonly users: UsersService,
    private readonly tokens: TokensService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async register(
    input: { name: string; email: string; password: string },
    ctx: RequestContext,
  ): Promise<AuthResponse> {
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const user = await this.users.create({ name: input.name, email: input.email, passwordHash });
    return this.buildAuthResponse(user, ctx);
  }

  async login(input: { email: string; password: string }, ctx: RequestContext): Promise<AuthResponse> {
    const user = await this.users.findByEmail(input.email);
    const ok = user ? await bcrypt.compare(input.password, user.passwordHash) : false;

    if (!user || !ok) {
      await this.audit.record({
        action: AuditAction.LOGIN_FAILED,
        userId: user?.id ?? null,
        ip: ctx.ip,
        requestId: ctx.requestId,
        detail: { email: input.email },
      });
      throw new UnauthorizedException('Invalid email or password.');
    }

    await this.users.recordLogin(user.id);
    await this.audit.record({
      action: AuditAction.LOGIN,
      userId: user.id,
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
    return this.buildAuthResponse(user, ctx);
  }

  async refresh(refreshToken: string, ctx: RequestContext): Promise<AuthResponse> {
    const { userId } = await this.tokens.consumeRefreshToken(refreshToken);
    const user = await this.users.findByIdOrThrow(userId);
    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role };
    const tokens = await this.tokens.issueTokens(payload, ctx);
    await this.tokens.markRotated(refreshToken, tokens.refreshToken);
    return { ...tokens, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokens.revoke(refreshToken);
  }

  async changePassword(
    userId: string,
    input: { currentPassword: string; newPassword: string },
    ctx: RequestContext,
  ): Promise<void> {
    const user = await this.users.findByIdOrThrow(userId);
    const ok = await bcrypt.compare(input.currentPassword, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Current password is incorrect.');

    const passwordHash = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);
    await this.users.updatePasswordHash(userId, passwordHash);
    await this.tokens.revokeAllForUser(userId);
    await this.audit.record({
      action: AuditAction.PASSWORD_CHANGED,
      userId,
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
  }

  /**
   * Always returns without error, whether or not the email exists, to prevent
   * account enumeration. The reset token is logged here; wiring a mail transport
   * is the production integration point. Non-prod returns the token to ease testing.
   */
  async forgotPassword(email: string): Promise<{ resetToken?: string }> {
    const user = await this.users.findByEmail(email);
    if (!user) return {};

    const resetToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(resetToken).digest('hex');
    await this.users.setResetToken(user.id, tokenHash, new Date(Date.now() + parseDuration('1h')));

    this.logger.warn(`Password reset for ${email}; token (send by email in production): ${resetToken}`);
    return this.config.get('env') === 'production' ? {} : { resetToken };
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const user = await this.users.findByActiveResetToken(tokenHash);
    if (!user) throw new UnauthorizedException('Invalid or expired reset token.');

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.users.updatePasswordHash(user.id, passwordHash);
    await this.tokens.revokeAllForUser(user.id);
  }

  private async buildAuthResponse(user: UserDocument, ctx: RequestContext): Promise<AuthResponse> {
    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role };
    const tokens = await this.tokens.issueTokens(payload, ctx);
    return { ...tokens, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
  }
}
