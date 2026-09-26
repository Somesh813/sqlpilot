import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiProvider,
  AiProviderError,
  buildSqlExplanationMessages,
  buildSqlFixMessages,
  buildSqlGenerationMessages,
  buildFollowUpCheckMessages,
  buildResultSummaryMessages,
  followUpSchema,
  buildSqlOptimizationMessages,
  resultAnswerSchema,
  generatedSqlSchema,
  sqlExplanationSchema,
  sqlFixSchema,
  sqlOptimizationSchema,
} from '@sqlpilot/ai';
import {
  AiExplanationMode,
  AuditAction,
  GeneratedSql,
  SqlExplanation,
  SqlFix,
  SqlOptimization,
  VisualizationType,
} from '@sqlpilot/shared';
import { validateSql } from '@sqlpilot/sql-parser';
import { AuditService } from '../audit/audit.service';
import { SchemaService } from '../schema/schema.service';
import { DatabaseConnectionsService } from '../database-connections/database-connections.service';
import { AI_PROVIDER } from './ai-provider.factory';

@Injectable()
export class AiSqlService {
  private readonly logger = new Logger('AiSql');

  constructor(
    @Inject(AI_PROVIDER) private readonly ai: AiProvider,
    private readonly schema: SchemaService,
    private readonly connections: DatabaseConnectionsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  async generate(
    userId: string,
    connectionId: string,
    question: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    ctx: { requestId?: string | null; ip?: string | null },
  ): Promise<GeneratedSql> {
    const connection = await this.connections.get(userId, connectionId);
    const maxTables = this.config.get<number>('ai.maxSchemaTables') ?? 25;
    const schemaContext = await this.schema.buildContext(userId, connectionId, question, maxTables);

    const messages = buildSqlGenerationMessages({ schema: schemaContext, question, history });
    const { data } = await this.call(() =>
      this.ai.completeStructured(
        { messages, temperature: 0 },
        generatedSqlSchema,
        'generated_sql',
      ),
    );

    // Defense in depth: the model's SQL still passes the security policy.
    const validation = data.unanswerable
      ? null
      : validateSql(data.sql, {
          databaseType: connection.type,
          allowWrite: false,
          enforceLimit: false,
          maxRows: this.config.get<number>('query.maxRows') ?? 1000,
        });

    const warnings = [...data.warnings];
    if (validation && !validation.valid) {
      warnings.push(
        `The generated query was rejected by the safety policy: ${validation.violations
          .map((v) => v.message)
          .join(' ')}`,
      );
    }

    await this.audit.record({
      userId,
      action: AuditAction.AI_SQL_GENERATED,
      connectionId,
      requestId: ctx.requestId,
      ip: ctx.ip,
      detail: { confidence: data.confidence, tables: data.tablesUsed, unanswerable: data.unanswerable },
    });

    return {
      intent: data.intent,
      tablesUsed: data.tablesUsed,
      sql: validation && !validation.valid ? '' : data.sql,
      explanation: data.explanation,
      assumptions: data.assumptions,
      confidence: clamp01(data.confidence),
      warnings,
      unanswerable: data.unanswerable || Boolean(validation && !validation.valid),
      unanswerableReason:
        data.unanswerableReason ??
        (validation && !validation.valid ? 'The generated query violated the safety policy.' : null),
      visualization: {
        recommended: data.visualization.recommended,
        type: data.visualization.type ?? VisualizationType.TABLE,
        xField: data.visualization.xField,
        yField: data.visualization.yField,
      },
    };
  }

  async explain(
    userId: string,
    connectionId: string,
    sql: string,
    mode: AiExplanationMode,
  ): Promise<SqlExplanation> {
    const schemaContext = await this.contextForSql(userId, connectionId, sql);
    const messages = buildSqlExplanationMessages({ schema: schemaContext, sql, mode });
    const { data } = await this.call(() =>
      this.ai.completeStructured({ messages, temperature: 0.1 }, sqlExplanationSchema, 'sql_explanation'),
    );
    return data;
  }

  async optimize(userId: string, connectionId: string, sql: string): Promise<SqlOptimization> {
    const schemaContext = await this.contextForSql(userId, connectionId, sql);
    const messages = buildSqlOptimizationMessages({ schema: schemaContext, sql });
    const { data } = await this.call(() =>
      this.ai.completeStructured({ messages, temperature: 0.1 }, sqlOptimizationSchema, 'sql_optimization'),
    );
    return {
      originalSql: sql,
      optimizedSql: data.optimizedSql,
      changes: data.changes,
      expectedBenefits: data.expectedBenefits,
      warnings: data.warnings,
      disclaimer:
        'These are expected improvements based on static analysis, not guarantees. Measure with EXPLAIN ANALYZE against your data.',
    };
  }

  async fix(
    userId: string,
    connectionId: string,
    sql: string,
    databaseError: string,
  ): Promise<SqlFix> {
    const schemaContext = await this.contextForSql(userId, connectionId, sql);
    const messages = buildSqlFixMessages({ schema: schemaContext, sql, databaseError });
    const { data } = await this.call(() =>
      this.ai.completeStructured({ messages, temperature: 0 }, sqlFixSchema, 'sql_fix'),
    );
    return {
      fixedSql: data.fixedSql,
      diagnosis: data.diagnosis,
      changes: data.changes,
      confidence: clamp01(data.confidence),
    };
  }

  /**
   * Writes a short plain-language answer from the ACTUAL result rows. Returns null on
   * any failure so the caller can fall back to a deterministic description — a failed
   * summary must never cost the user their data.
   */
  async summarize(
    question: string,
    columns: string[],
    rows: Array<Record<string, unknown>>,
    totalRowCount: number,
  ): Promise<string | null> {
    try {
      const messages = buildResultSummaryMessages({ question, columns, rows, totalRowCount });
      const { data } = await this.ai.completeStructured(
        { messages, temperature: 0.2, model: this.fastModel() },
        resultAnswerSchema,
        'result_answer',
      );
      return data.answer.trim() || null;
    } catch (error) {
      this.logger.warn(`Result summary failed, using fallback: ${String(error)}`);
      return null;
    }
  }

  /**
   * Does `question` depend on the previous question? Decides whether earlier context is
   * sent to the SQL model at all: a fresh question gets a clean slate, because a model
   * shown a previous query tends to extend it (accumulating UNIONs) even when told not to.
   * Falls back to a conservative heuristic if the classifier call fails.
   */
  async isFollowUp(question: string, previousQuestion: string): Promise<boolean> {
    try {
      const messages = buildFollowUpCheckMessages({ previousQuestion, question });
      const { data } = await this.ai.completeStructured(
        { messages, temperature: 0, model: this.fastModel() },
        followUpSchema,
        'follow_up_check',
      );
      return data.followUp;
    } catch (error) {
      this.logger.warn(`Follow-up check failed, using heuristic: ${String(error)}`);
      return looksLikeFollowUp(question);
    }
  }

  private fastModel(): string | undefined {
    const ai = this.config.get<{ provider: string; openai: { fastModel: string }; groq: { fastModel: string } }>('ai');
    return ai?.provider === 'groq' ? ai.groq.fastModel : ai?.openai.fastModel;
  }

  private async contextForSql(userId: string, connectionId: string, sql: string) {
    const maxTables = this.config.get<number>('ai.maxSchemaTables') ?? 25;
    // Use the SQL text itself as the relevance query so referenced tables are included.
    return this.schema.buildContext(userId, connectionId, sql, maxTables);
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof AiProviderError) {
        this.logger.warn(`AI provider error: ${error.message}`);
        throw new ServiceUnavailableException(error.message);
      }
      throw error;
    }
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Short messages that lean on the previous turn: "only 2026", "now the top 5", "what about Delhi?" */
export function looksLikeFollowUp(question: string): boolean {
  const q = question.trim();
  const words = q.split(/\s+/).length;
  if (words > 10) return false;
  return (
    /^(now|only|also|and|but|then|just|instead|same|sort|order|limit|filter|exclude|remove|add|what about|how about|show only)\b/i.test(q) ||
    /\b(it|that|those|them|these|previous|above|same)\b/i.test(q)
  );
}
