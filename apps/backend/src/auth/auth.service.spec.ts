import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, UserRole } from '@sqlpilot/shared';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  const ctx = { ip: '127.0.0.1', userAgent: 'jest', requestId: 'req-1' };

  let users: {
    create: jest.Mock;
    findByEmail: jest.Mock;
    findByIdOrThrow: jest.Mock;
    recordLogin: jest.Mock;
    updatePasswordHash: jest.Mock;
  };
  let tokens: { issueTokens: jest.Mock; consumeRefreshToken: jest.Mock; markRotated: jest.Mock; revoke: jest.Mock; revokeAllForUser: jest.Mock };
  let audit: { record: jest.Mock };
  let service: AuthService;

  beforeEach(() => {
    users = {
      create: jest.fn(),
      findByEmail: jest.fn(),
      findByIdOrThrow: jest.fn(),
      recordLogin: jest.fn().mockResolvedValue(undefined),
      updatePasswordHash: jest.fn().mockResolvedValue(undefined),
    };
    tokens = {
      issueTokens: jest.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 }),
      consumeRefreshToken: jest.fn(),
      markRotated: jest.fn().mockResolvedValue(undefined),
      revoke: jest.fn().mockResolvedValue(undefined),
      revokeAllForUser: jest.fn().mockResolvedValue(undefined),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    const config = { get: (k: string) => (k === 'env' ? 'test' : undefined) } as unknown as ConfigService;
    service = new AuthService(users as never, tokens as never, config, audit as never);
  });

  it('registers a user and returns tokens', async () => {
    users.create.mockResolvedValue({ id: 'u1', name: 'A', email: 'a@x.com', role: UserRole.USER });
    const res = await service.register({ name: 'A', email: 'a@x.com', password: 'Password123' }, ctx);
    expect(users.create).toHaveBeenCalled();
    expect(res.accessToken).toBe('a');
    expect(res.user.email).toBe('a@x.com');
  });

  it('logs in with a correct password', async () => {
    const passwordHash = await bcrypt.hash('Password123', 4);
    users.findByEmail.mockResolvedValue({ id: 'u1', name: 'A', email: 'a@x.com', role: UserRole.USER, passwordHash });
    const res = await service.login({ email: 'a@x.com', password: 'Password123' }, ctx);
    expect(res.refreshToken).toBe('r');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.LOGIN }));
  });

  it('rejects a wrong password and audits the failure', async () => {
    const passwordHash = await bcrypt.hash('Password123', 4);
    users.findByEmail.mockResolvedValue({ id: 'u1', email: 'a@x.com', role: UserRole.USER, passwordHash });
    await expect(service.login({ email: 'a@x.com', password: 'wrong' }, ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.LOGIN_FAILED }));
  });

  it('does not reveal whether an unknown email exists', async () => {
    users.findByEmail.mockResolvedValue(null);
    await expect(service.login({ email: 'ghost@x.com', password: 'whatever' }, ctx)).rejects.toThrow(
      'Invalid email or password.',
    );
  });

  it('rotates refresh tokens', async () => {
    tokens.consumeRefreshToken.mockResolvedValue({ userId: 'u1', recordId: 'rec1' });
    users.findByIdOrThrow.mockResolvedValue({ id: 'u1', name: 'A', email: 'a@x.com', role: UserRole.USER });
    const res = await service.refresh('old-refresh', ctx);
    expect(tokens.markRotated).toHaveBeenCalledWith('old-refresh', 'r');
    expect(res.accessToken).toBe('a');
  });

  it('changePassword requires the current password and revokes sessions', async () => {
    const passwordHash = await bcrypt.hash('OldPassword123', 4);
    users.findByIdOrThrow.mockResolvedValue({ id: 'u1', passwordHash });
    await service.changePassword('u1', { currentPassword: 'OldPassword123', newPassword: 'NewPassword123' }, ctx);
    expect(users.updatePasswordHash).toHaveBeenCalled();
    expect(tokens.revokeAllForUser).toHaveBeenCalledWith('u1');
  });

  it('changePassword rejects an incorrect current password', async () => {
    const passwordHash = await bcrypt.hash('OldPassword123', 4);
    users.findByIdOrThrow.mockResolvedValue({ id: 'u1', passwordHash });
    await expect(
      service.changePassword('u1', { currentPassword: 'nope', newPassword: 'NewPassword123' }, ctx),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
