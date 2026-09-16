import { Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { DatabaseSchemaSnapshot } from '@sqlpilot/shared';
import { Request } from 'express';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { SchemaService } from './schema.service';

function ctx(req: Request): { requestId: string | null; ip: string | null } {
  const id = (req as { id?: string | number }).id;
  return { requestId: id !== undefined ? String(id) : null, ip: req.ip ?? null };
}

@Controller('databases/:id/schema')
export class SchemaController {
  constructor(private readonly schema: SchemaService) {}

  @Get()
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<DatabaseSchemaSnapshot> {
    return this.schema.get(user.id, id);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<DatabaseSchemaSnapshot> {
    return this.schema.refresh(user.id, id, ctx(req));
  }
}
