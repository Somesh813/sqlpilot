import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseDriverError, withDriver } from '@sqlpilot/database';
import {
  AuditAction,
  QueryResult,
  QueryStatus,
  SqlStatementKind,
  SqlValidationResult,
} from '@sqlpilot/shared';
import { validateSql } from '@sqlpilot/sql-parser';
import { AuditService } from '../audit/audit.service';
import { DatabaseConnectionsService } from '../database-connections/database-connections.service';
import { QueryHistoryService } from '../query-history/query-history.service';

export interface ExecuteInput {
  sql: string;
  confirmed: boolean;
  page?: number;
  pageSize?: number;
  prompt?: string;
  conversationId?: string;
  aiGenerated?: boolean;
}

export interface RequestCtx {
  requestId?: string | null;
  ip?: string | null;
}

@Injectable()
export class QueryExecutionService {
  private readonly logger = new Logger('QueryExecution');

  constructor(
    private readonly connections: DatabaseConnectionsService,
    private readonly history: QueryHistoryService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  async validate(userId: string, connectionId: string, sql: string): Promise<SqlValidationResult> {
    const connection = await this.connections.get(userId, connectionId);
    return validateSql(sql, {
      databaseType: connection.type,
      allowWrite: this.writeAllowed(connection.writeEnabled),
      enforceLimit: true,
      maxRows: this.config.get<number>('query.maxRows') ?? 1000,
    });
  }

  async execute(
    userId: string,
    connectionId: string,
    input: ExecuteInput,
    ctx: RequestCtx,
  ): Promise<QueryResult> {
    const connection = await this.connections.get(userId, connectionId);
    const maxRows = this.config.get<number>('query.maxRows') ?? 1000;
    const timeoutMs = this.config.get<number>('query.timeoutMs') ?? 15_000;
    const defaultPageSize = this.config.get<number>('query.defaultPageSize') ?? 100;

    const validation = validateSql(input.sql, {
      databaseType: connection.type,
      allowWrite: this.writeAllowed(connection.writeEnabled),
      enforceLimit: true,
      maxRows,
    });

    if (!validation.valid) {
      await this.recordBlocked(userId, connection, input, validation);
      throw new BadRequestException({
        error: 'SqlPolicyViolation',
        message: validation.violations.map((v) => v.message),
        validation,
      });
    }

    if (!input.confirmed) {
      throw new ForbiddenException('The query must be reviewed and confirmed before execution.');
    }

    if (
      validation.statementKind === SqlStatementKind.WRITE &&
      !this.writeAllowed(connection.writeEnabled)
    ) {
      await this.recordBlocked(userId, connection, input, validation);
      throw new ForbiddenException('Write queries are disabled for this connection.');
    }

    const page = Math.max(1, input.page ?? 1);
    const pageSize = Math.min(maxRows, Math.max(1, input.pageSize ?? defaultPageSize));
    const config = await this.connections.resolveDriverConfig(userId, connectionId);

    try {
      const result = await withDriver(config, (driver) =>
        driver.runQuery(validation.normalizedSql, {
          timeoutMs,
          maxRows,
          page,
          pageSize,
          allowWrite: validation.statementKind === SqlStatementKind.WRITE,
        }),
      );

      const entry = await this.history.record({
        userId,
        connectionId,
        connectionName: connection.name,
        conversationId: input.conversationId,
        prompt: input.prompt ?? null,
        sql: validation.normalizedSql,
        status: QueryStatus.SUCCESS,
        executionTimeMs: result.executionTimeMs,
        rowCount: result.rowCount,
        truncated: result.truncated,
        aiGenerated: input.aiGenerated ?? false,
      });

      await this.audit.record({
        userId,
        action: AuditAction.QUERY_EXECUTED,
        connectionId,
        requestId: ctx.requestId,
        ip: ctx.ip,
        detail: { kind: validation.statementKind, rows: result.rowCount, ms: result.executionTimeMs },
      });

      return { ...result, historyId: entry.id };
    } catch (error) {
      const isTimeout = error instanceof DatabaseDriverError && error.code === 'TIMEOUT';
      const driverMessage =
        error instanceof DatabaseDriverError
          ? error.driverError ?? error.message
          : error instanceof Error
            ? error.message
            : String(error);

      await this.history.record({
        userId,
        connectionId,
        connectionName: connection.name,
        conversationId: input.conversationId,
        prompt: input.prompt ?? null,
        sql: validation.normalizedSql,
        status: isTimeout ? QueryStatus.TIMEOUT : QueryStatus.ERROR,
        error: driverMessage,
        aiGenerated: input.aiGenerated ?? false,
      });

      throw new UnprocessableEntityException({
        error: 'QueryExecutionError',
        status: isTimeout ? QueryStatus.TIMEOUT : QueryStatus.ERROR,
        message: isTimeout ? 'The query timed out.' : 'The query failed to execute.',
        databaseError: driverMessage,
      });
    }
  }

  private writeAllowed(connectionWriteEnabled: boolean): boolean {
    return connectionWriteEnabled && (this.config.get<boolean>('query.allowWriteQueries') ?? false);
  }

  private async recordBlocked(
    userId: string,
    connection: { id: string; name: string },
    input: ExecuteInput,
    validation: SqlValidationResult,
  ): Promise<void> {
    await this.history.record({
      userId,
      connectionId: connection.id,
      connectionName: connection.name,
      conversationId: input.conversationId,
      prompt: input.prompt ?? null,
      sql: input.sql,
      status: QueryStatus.BLOCKED,
      error: validation.violations.map((v) => v.message).join(' '),
      aiGenerated: input.aiGenerated ?? false,
    });
    await this.audit.record({
      userId,
      action: AuditAction.QUERY_BLOCKED,
      connectionId: connection.id,
      detail: { violations: validation.violations.map((v) => v.code) },
    });
  }
}
