import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { AuditAction, redactSecrets } from '@sqlpilot/shared';
import { Model, Types } from 'mongoose';
import { AuditLog, AuditLogDocument } from './schemas/audit-log.schema';

export interface AuditInput {
  userId?: string | null;
  action: AuditAction;
  connectionId?: string | null;
  requestId?: string | null;
  ip?: string | null;
  detail?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(@InjectModel(AuditLog.name) private readonly model: Model<AuditLogDocument>) {}

  /** Records an audit event. Failures are logged but never block the request. */
  async record(input: AuditInput): Promise<void> {
    try {
      await this.model.create({
        userId: input.userId ? new Types.ObjectId(input.userId) : null,
        action: input.action,
        connectionId: input.connectionId ? new Types.ObjectId(input.connectionId) : null,
        requestId: input.requestId ?? null,
        ip: input.ip ?? null,
        detail: sanitize(input.detail ?? {}),
      });
      this.logger.log(`${input.action} user=${input.userId ?? 'anon'} req=${input.requestId ?? '-'}`);
    } catch (error) {
      this.logger.error(`Failed to write audit log for ${input.action}: ${String(error)}`);
    }
  }

  async list(filter: { userId?: string; action?: AuditAction; limit?: number }): Promise<AuditLogDocument[]> {
    const query: Record<string, unknown> = {};
    if (filter.userId) query.userId = new Types.ObjectId(filter.userId);
    if (filter.action) query.action = filter.action;
    return this.model
      .find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(filter.limit ?? 100, 500))
      .exec();
  }
}

function sanitize(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    out[k] = typeof v === 'string' ? redactSecrets(v) : v;
  }
  return out;
}
