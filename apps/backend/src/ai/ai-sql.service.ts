import { Inject, Injectable, Logger } from '@nestjs/common';
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
  LlmResultView,
  maskPii,
  SafeDatabaseConnection,
  SchemaContext,
  SqlExplanation,
  SqlFix,
  SqlOptimization,
  sanitizeTechnical,
  VisualizationType,
} from '@sqlpilot/shared';
import {
  checkAgainstSchema,
  describeIssues,
  SchemaCheck,
  SchemaIssue,
  toParserDialect,
  validateSql,
} from '@sqlpilot/sql-parser';
import { AuditService } from '../audit/audit.service';
import { aiErrorToSafe } from '../common/errors/ai-errors';
import { SchemaService } from '../schema/schema.service';
import { DatabaseConnectionsService } from '../database-connections/database-connections.service';
import { AI_PROVIDER } from './ai-provider.factory';

export interface PreparedContext {
  connection: SafeDatabaseConnection;
  schemaContext: SchemaContext;
}

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

  /**
   * Loads the connection and the schema slice for a question. Independent of the follow-up
   * classifier, so the caller runs the two at the same time instead of one after the other.
   * `relatedText` (the previous question) widens table selection for follow-ups on large schemas.
   */
  async prepareContext(userId: string, connectionId: string, question: string, relatedText?: string): Promise<PreparedContext> {
    const maxTables = this.config.get<number>('ai.maxSchemaTables') ?? 25;
    const [connection, schemaContext] = await Promise.all([
      this.connections.get(userId, connectionId),
      this.schema.buildContext(userId, connectionId, relatedText ? `${relatedText} ${question}` : question, maxTables),
    ]);
    return { connection, schemaContext };
  }

  async generate(
    userId: string,
    connectionId: string,
    question: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    ctx: { requestId?: string | null; ip?: string | null },
    prepared?: PreparedContext,
  ): Promise<GeneratedSql> {
    const { connection, schemaContext } = prepared ?? (await this.prepareContext(userId, connectionId, question));

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
      blockedByPolicy: validation && !validation.valid ? [...new Set(validation.violations.map((v) => v.code))] : null,
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

  /**
   * Checks the model's SQL against the real schema BEFORE it runs. No model call: this is a
   * parse and a lookup. It never blocks on its own failure (no schema, unparseable SQL): in that
   * case the database is left to decide.
   */
  async checkSql(userId: string, connectionId: string, sql: string, connection: SafeDatabaseConnection): Promise<SchemaCheck> {
    try {
      const snapshot = await this.schema.get(userId, connectionId);
      return checkAgainstSchema(sql, snapshot, toParserDialect(connection.type), snapshot.databaseName);
    } catch (error) {
      this.logger.warn(`Schema check skipped: ${sanitizeTechnical(error)}`);
      return { ok: true, issues: [], skipped: 'schema unavailable' };
    }
  }

  /**
   * Repairs a failing query. `problem` is either the database's error text, or the structured
   * schema issues found before running it.
   */
  async fix(
    userId: string,
    connectionId: string,
    sql: string,
    problem: string | { issues: SchemaIssue[] },
  ): Promise<SqlFix> {
    const structured = typeof problem === 'string' ? null : problem.issues;
    // Table names the check suggested are added to the relevance text, so the repair prompt
    // includes the tables it needs even when the original SQL named none of them.
    const hints = structured
      ? structured.flatMap((i) => (i.type === 'unknown_table' ? i.suggestions : [...i.suggestions, ...i.foundIn])).join(' ')
      : '';
    const schemaContext = await this.contextForSql(userId, connectionId, `${sql} ${hints}`);
    // The error text can quote values from the user's data; contact details are masked before it leaves.
    const messages = buildSqlFixMessages(
      structured
        ? { schema: schemaContext, sql, schemaProblems: describeIssues(structured) }
        : { schema: schemaContext, sql, databaseError: maskPii(problem as string) },
    );
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
    view: LlmResultView,
    scope: { returnedRows: number; totalRows: number | null; truncated: boolean },
  ): Promise<string | null> {
    try {
      const messages = buildResultSummaryMessages({ question, view, ...scope });
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
    // A model occasionally returns output that is not valid JSON or does not fit the schema. That is
    // usually a one-off, so the call is retried once before the user is told anything.
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof AiProviderError && error.code === 'BAD_RESPONSE' && attempt === 0) {
          this.logger.warn('The model returned an unusable response; retrying once.');
          continue;
        }
        throw this.toSafe(error);
      }
    }
  }

  /** Provider failures become a safe exception; anything else passes through unchanged. */
  private toSafe(error: unknown): unknown {
    if (error instanceof AiProviderError) {
      // The raw provider text (which can hold organisation ids, limits, model names) stays in
      // the log, scrubbed. The caller gets a safe message and a coded, developer-safe detail.
      this.logger.warn(`AI provider error [${error.code}${error.status ? ` ${error.status}` : ''}]: ${sanitizeTechnical(error.message)}`);
      return aiErrorToSafe(error);
    }
    return error;
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
