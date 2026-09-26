import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  AskResponse,
  ConversationMessageRole,
  GeneratedSql,
  SqlExplanation,
  SqlFix,
  SqlOptimization,
  UserRole,
} from '@sqlpilot/shared';
import { Request } from 'express';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ConversationsService } from '../conversations/conversations.service';
import { AiSqlService } from './ai-sql.service';
import { AskService } from './ask.service';
import { AskDto, ExplainSqlDto, FixSqlDto, GenerateSqlDto, OptimizeSqlDto } from './dto/ai.dto';

function ctx(req: Request): { requestId: string | null; ip: string | null } {
  const id = (req as { id?: string | number }).id;
  return { requestId: id !== undefined ? String(id) : null, ip: req.ip ?? null };
}

@Controller('ai')
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class AiController {
  constructor(
    private readonly ai: AiSqlService,
    private readonly conversations: ConversationsService,
    private readonly askService: AskService,
  ) {}

  /** Natural language in, real answer + data out: the main entry point for the assistant. */
  @Post('ask')
  @HttpCode(200)
  ask(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AskDto,
    @Req() req: Request,
  ): Promise<AskResponse> {
    return this.askService.ask(user.id, dto, ctx(req), { isAdmin: user.role === UserRole.ADMIN });
  }

  @Post('generate-sql')
  @HttpCode(200)
  async generate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: GenerateSqlDto,
    @Req() req: Request,
  ): Promise<GeneratedSql> {
    const history = dto.conversationId
      ? await this.conversations.recentTurns(user.id, dto.conversationId)
      : [];

    const result = await this.ai.generate(user.id, dto.connectionId, dto.question, history, ctx(req));

    if (dto.conversationId) {
      await this.conversations.append(user.id, dto.conversationId, {
        role: ConversationMessageRole.USER,
        content: dto.question,
      });
      await this.conversations.append(user.id, dto.conversationId, {
        role: ConversationMessageRole.ASSISTANT,
        content: result.explanation,
        sql: result.sql || null,
        metadata: {
          confidence: result.confidence,
          tablesUsed: result.tablesUsed,
          visualization: result.visualization,
        },
      });
    }
    return result;
  }

  @Post('explain-sql')
  @HttpCode(200)
  explain(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ExplainSqlDto,
  ): Promise<SqlExplanation> {
    return this.ai.explain(user.id, dto.connectionId, dto.sql, dto.mode);
  }

  @Post('optimize-sql')
  @HttpCode(200)
  optimize(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: OptimizeSqlDto,
  ): Promise<SqlOptimization> {
    return this.ai.optimize(user.id, dto.connectionId, dto.sql);
  }

  @Post('fix-sql')
  @HttpCode(200)
  fix(@CurrentUser() user: AuthenticatedUser, @Body() dto: FixSqlDto): Promise<SqlFix> {
    return this.ai.fix(user.id, dto.connectionId, dto.sql, dto.databaseError);
  }
}
