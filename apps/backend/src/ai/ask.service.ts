import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  analyzeResult,
  buildResultFacts,
  deterministicAnswer,
  verifyAnswer,
  AskRequest,
  AskResponse,
  ConversationMessageRole,
  GeneratedSql,
  QueryResult,
  ResultAnalysis,
  VisualizationType,
} from '@sqlpilot/shared';
import { ConversationsService } from '../conversations/conversations.service';
import { DatabaseConnectionsService } from '../database-connections/database-connections.service';
import { QueryExecutionService } from '../query-execution/query-execution.service';
import { AiSqlService } from './ai-sql.service';

interface RequestCtx {
  requestId?: string | null;
  ip?: string | null;
}

const NOT_UNDERSTOOD =
  "Sorry, I couldn't understand that request. Try asking something like: “Show total sales by month.”";

const TRY_ASKING = 'Try asking about the data in this database, for example: “Show total sales by month.”';

/**
 * Natural language in → real data out. Orchestrates the whole chain so the browser
 * receives one stable contract (AskResponse) and never has to run SQL itself:
 *
 *   generate SQL → policy-validate → execute (read-only) → analyze the rows →
 *   write a plain-language answer from those rows → persist the conversation turn
 */
@Injectable()
export class AskService {
  private readonly logger = new Logger('Ask');

  constructor(
    private readonly ai: AiSqlService,
    private readonly queries: QueryExecutionService,
    private readonly conversations: ConversationsService,
    private readonly connections: DatabaseConnectionsService,
  ) {}

  async ask(userId: string, req: AskRequest, ctx: RequestCtx): Promise<AskResponse> {
    // Ownership first: an unknown / foreign connection is a real 404, not a "couldn't understand" reply.
    await this.connections.get(userId, req.connectionId);

    const question = req.question.trim();
    const conversationId =
      req.conversationId ?? (await this.conversations.create(userId, { connectionId: req.connectionId })).id;
    // Earlier context is sent ONLY for genuine follow-ups. A fresh question gets a clean slate:
    // shown a previous query, the model tends to extend it (accumulating UNIONs across a chat).
    const recent = req.conversationId ? await this.conversations.recentTurns(userId, conversationId) : [];
    const previousQuestion = [...recent].reverse().find((t) => t.role === 'user')?.content;
    const history =
      previousQuestion && (await this.ai.isFollowUp(question, previousQuestion)) ? recent : [];
    const base = this.blank(question, conversationId);

    // ---- 1. understand the question → SQL ----
    let generated: GeneratedSql;
    try {
      generated = await this.ai.generate(userId, req.connectionId, question, history, ctx);
    } catch (error) {
      const technical = this.technical(error);
      this.logger.warn(`Generation failed [${ctx.requestId ?? '-'}]: ${technical}`);
      const message =
        error instanceof HttpException && error.getStatus() === 503 ? technical : NOT_UNDERSTOOD;
      return this.fail(userId, base, 'generation', message, technical);
    }

    if (generated.unanswerable || !generated.sql.trim()) {
      const reason = generated.unanswerableReason?.trim();
      // Say why, then show what does work — a dead-end reply teaches a non-technical user nothing.
      const message = reason ? `${reason} ${TRY_ASKING}` : NOT_UNDERSTOOD;
      return this.fail(userId, { ...base, ...this.meta(generated) }, 'generation', message, null);
    }

    // ---- 2. run it (one automatic repair attempt if the database rejects it) ----
    let sql = generated.sql;
    let autoFixed = false;
    let result: QueryResult | null = null;
    let failure: { message: string; technical: string | null } | null = null;

    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try {
        result = await this.queries.execute(
          userId,
          req.connectionId,
          { sql, confirmed: true, forceReadOnly: true, prompt: question, conversationId, aiGenerated: true },
          ctx,
        );
      } catch (error) {
        const technical = this.technical(error);
        this.logger.warn(`Execution failed (attempt ${attempt + 1}) [${ctx.requestId ?? '-'}]: ${technical}`);

        if (error instanceof BadRequestException) {
          failure = {
            message: 'That request could not be run because it was not a safe, read-only question.',
            technical,
          };
          break;
        }
        if (attempt === 0 && error instanceof UnprocessableEntityException) {
          const repaired = await this.tryRepair(userId, req.connectionId, sql, technical);
          if (repaired) {
            sql = repaired;
            autoFixed = true;
            continue;
          }
        }
        failure = {
          message: 'Your request was understood, but the database query could not be executed.',
          technical,
        };
      }
    }

    if (!result) {
      return this.fail(
        userId,
        { ...base, ...this.meta(generated), sql },
        'execution',
        failure?.message ?? NOT_UNDERSTOOD,
        failure?.technical ?? null,
      );
    }

    // ---- 3. decide how to show it, then say it in words ----
    const columns = result.columns.map((c) => c.name);
    const analysis = this.analyze(columns, result.rows, generated);
    const answer = await this.answer(question, columns, result, analysis);

    const response: AskResponse = {
      ...base,
      ...this.meta(generated),
      success: true,
      sql,
      columns,
      columnTypes: Object.fromEntries(result.columns.map((c) => [c.name, c.type])),
      rows: result.rows,
      returnedRows: result.returnedRows,
      totalRows: result.totalRows,
      truncated: result.truncated,
      executionTimeMs: result.executionTimeMs,
      resultType: analysis.resultType,
      visualization: analysis.visualization,
      availableViews: analysis.availableViews,
      numericColumns: analysis.numericColumns,
      explanation: answer,
      queryExplanation: generated.explanation,
      autoFixed,
      historyId: result.historyId,
    };

    await this.remember(userId, conversationId, question, response);
    return response;
  }

  // ---------------------------------------------------------------------------

  private analyze(columns: string[], rows: Array<Record<string, unknown>>, generated: GeneratedSql): ResultAnalysis {
    try {
      return analyzeResult(columns, rows, {
        type: generated.visualization.recommended ? generated.visualization.type : null,
        xField: generated.visualization.xField,
        yField: generated.visualization.yField,
      });
    } catch (error) {
      // A chart decision must never cost the user their table.
      this.logger.warn(`Result analysis failed, falling back to table only: ${String(error)}`);
      return {
        resultType: 'table',
        visualization: { recommended: false, type: null, xColumn: null, yColumns: [] },
        availableViews: [VisualizationType.TABLE],
        numericColumns: [],
      };
    }
  }

  private async tryRepair(userId: string, connectionId: string, sql: string, dbError: string): Promise<string | null> {
    try {
      const fix = await this.ai.fix(userId, connectionId, sql, dbError);
      const fixed = fix.fixedSql?.trim();
      return fixed && fixed !== sql.trim() ? fixed : null;
    } catch (error) {
      this.logger.warn(`Automatic repair failed: ${String(error)}`);
      return null;
    }
  }

  /**
   * SQL -> database -> structured result -> deterministic facts -> model wording -> verify.
   * The model may only reword what the facts say; an answer that contradicts the data is
   * replaced by the deterministic one, so a wrong count never reaches the user.
   */
  private async answer(
    question: string,
    columns: string[],
    result: QueryResult,
    analysis: ResultAnalysis,
  ): Promise<string> {
    const facts = buildResultFacts({
      columns,
      rows: result.rows,
      returnedRows: result.returnedRows,
      totalRows: result.totalRows,
      truncated: result.truncated,
      analysis,
    });
    const fallback = deterministicAnswer(facts);
    if (facts.isEmpty) return fallback; // nothing for a model to add

    const wording = await this.ai.summarize(question, columns, result.rows, {
      returnedRows: result.returnedRows,
      totalRows: result.totalRows,
      truncated: result.truncated,
    });
    if (!wording) return fallback;

    const check = verifyAnswer(wording, facts, question);
    if (check.ok) return wording;
    this.logger.warn(`Rejected AI answer (${check.problems.join(', ')}); using the deterministic answer.`);
    return fallback;
  }

  private async fail(
    userId: string,
    base: AskResponse,
    stage: 'generation' | 'execution',
    message: string,
    technical: string | null,
  ): Promise<AskResponse> {
    const response: AskResponse = {
      ...base,
      success: false,
      explanation: message,
      error: { stage, message, technical },
    };
    if (base.conversationId) await this.remember(userId, base.conversationId, base.question, response);
    return response;
  }

  private async remember(userId: string, conversationId: string, question: string, r: AskResponse): Promise<void> {
    try {
      await this.conversations.append(userId, conversationId, {
        role: ConversationMessageRole.USER,
        content: question,
      });
      await this.conversations.append(userId, conversationId, {
        role: ConversationMessageRole.ASSISTANT,
        content: r.explanation,
        sql: r.sql || null,
        metadata: { success: r.success, rowCount: r.returnedRows, resultType: r.resultType, columns: r.columns },
      });
    } catch (error) {
      // Losing chat history must not lose the answer.
      this.logger.warn(`Could not persist conversation turn: ${String(error)}`);
    }
  }

  private technical(error: unknown): string {
    if (error instanceof HttpException) {
      const body = error.getResponse() as string | { databaseError?: string; message?: string | string[] };
      if (typeof body === 'string') return body;
      if (body.databaseError) return body.databaseError;
      return Array.isArray(body.message) ? body.message.join(' ') : (body.message ?? error.message);
    }
    return error instanceof Error ? error.message : String(error);
  }

  private meta(g: GeneratedSql): Pick<AskResponse, 'assumptions' | 'warnings' | 'tablesUsed' | 'confidence' | 'queryExplanation'> {
    return {
      assumptions: g.assumptions,
      warnings: g.warnings,
      tablesUsed: g.tablesUsed,
      confidence: g.confidence,
      queryExplanation: g.explanation,
    };
  }

  private blank(question: string, conversationId: string): AskResponse {
    return {
      success: false,
      question,
      conversationId,
      sql: '',
      columns: [],
      columnTypes: {},
      rows: [],
      returnedRows: 0,
      totalRows: 0,
      truncated: false,
      executionTimeMs: 0,
      resultType: 'empty',
      visualization: { recommended: false, type: null, xColumn: null, yColumns: [] },
      availableViews: [VisualizationType.TABLE],
      numericColumns: [],
      explanation: '',
      queryExplanation: '',
      assumptions: [],
      warnings: [],
      tablesUsed: [],
      confidence: 0,
      autoFixed: false,
      historyId: null,
      error: null,
    };
  }
}
