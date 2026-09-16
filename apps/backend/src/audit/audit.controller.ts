import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuditAction, UserRole } from '@sqlpilot/shared';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuditService } from './audit.service';

@Controller('audit')
@UseGuards(RolesGuard)
@Roles(UserRole.ADMIN)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(
    @Query('action') action?: AuditAction,
    @Query('userId') userId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.audit
      .list({ action, userId, limit: limit ? Number(limit) : undefined })
      .then((docs) =>
        docs.map((d) => ({
          id: d.id,
          userId: d.userId ? d.userId.toString() : null,
          action: d.action,
          connectionId: d.connectionId ? d.connectionId.toString() : null,
          requestId: d.requestId,
          ip: d.ip,
          detail: d.detail,
          createdAt: (d as unknown as { createdAt: Date }).createdAt.toISOString(),
        })),
      );
  }
}
