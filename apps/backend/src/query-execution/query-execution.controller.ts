import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { QueryResult, SqlValidationResult } from '@sqlpilot/shared';
import { Request } from 'express';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ExecuteQueryDto, ValidateQueryDto } from './dto/query.dto';
import { QueryExecutionService } from './query-execution.service';

function ctx(req: Request): { requestId: string | null; ip: string | null } {
  const id = (req as { id?: string | number }).id;
  return { requestId: id !== undefined ? String(id) : null, ip: req.ip ?? null };
}

@Controller('queries')
export class QueryExecutionController {
  constructor(private readonly queries: QueryExecutionService) {}

  @Post('validate')
  @HttpCode(200)
  validate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ValidateQueryDto,
  ): Promise<SqlValidationResult> {
    return this.queries.validate(user.id, dto.connectionId, dto.sql);
  }

  @Post('execute')
  @HttpCode(200)
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  execute(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ExecuteQueryDto,
    @Req() req: Request,
  ): Promise<QueryResult> {
    return this.queries.execute(
      user.id,
      dto.connectionId,
      {
        sql: dto.sql,
        confirmed: dto.confirmed,
        prompt: dto.prompt,
        conversationId: dto.conversationId,
        aiGenerated: dto.aiGenerated,
      },
      ctx(req),
    );
  }
}
