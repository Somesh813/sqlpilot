import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseDriverError } from '@sqlpilot/database';
import {
  AuditAction,
  QueryResult,
  QueryStatus,
  sanitizeTechnical,
  SqlStatementKind,
  SqlValidationResult,
} from '@sqlpilot/shared';
import { validateSql } from '@sqlpilot/sql-parser';
import { AuditService } from '../audit/audit.service';
import { SafeException } from '../common/errors/safe-exception';
import { DriverPoolService } from '../database-connections/driver-pool.service';
import { DatabaseConnectionsService } from '../database-connections/database-connections.service';
import { QueryHistoryService } from '../query-history/query-history.service';

export interface ExecuteInput {
  sql: string;
  confirmed: boolean;
  /**
   * Internal only (never exposed through a DTO). The AI path sets this so that model-written
   * SQL is validated and executed read-only no matter how the connection is configured.
   */
  forceReadOnly?: boolean;
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
    private readonly pools: DriverPoolService,
  ) {}

  async validate(userId: string, connectionId: string, sql: string): Promise<SqlValidationResult> {
    const connection = await this.connections.get(userId, connectionId);
    return validateSql(sql, {
      databaseType: connection.type,
      allowWrite: this.writeAllowed(connection.writeEnabled),
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
    const allowWrite = !input.forceReadOnly && this.writeAllowed(connection.writeEnabled);

    const validation = validateSql(input.sql, { databaseType: connection.type, allowWrite });

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

    if (validation.statementKind === SqlStatementKind.WRITE && !allowWrite) {
      await this.recordBlocked(userId, connection, input, validation);
      throw new ForbiddenException('Write queries are disabled for this connection.');
    }

    let config;
    try {
      config = await this.connections.resolveDriverConfig(userId, connectionId);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      // A target the policy no longer allows, or credentials that cannot be read, is an
      // unavailable database from the user's point of view. The reason stays in the log.
      this.logger.warn(`Connection could not be prepared: ${sanitizeTechnical(error)}`);
      throw new SafeException('DB_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE, error);
    }

    try {
      const result = await this.pools.run(connectionId, config, (driver) =>
        driver.runQuery(validation.normalizedSql, {
          timeoutMs,
          maxRows,
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
        rowCount: result.returnedRows,
        truncated: result.truncated,
        aiGenerated: input.aiGenerated ?? false,
      });

      await this.audit.record({
        userId,
        action: AuditAction.QUERY_EXECUTED,
        connectionId,
        requestId: ctx.requestId,
        ip: ctx.ip,
        detail: { kind: validation.statementKind, rows: result.returnedRows, truncated: result.truncated, ms: result.executionTimeMs },
      });

      return { ...result, historyId: entry.id };
    } catch (error) {
      const driverCode = error instanceof DatabaseDriverError ? error.code : 'QUERY';
      const isTimeout = driverCode === 'TIMEOUT';
      const isUnavailable = driverCode === 'CONNECTION';
      const raw =
        error instanceof DatabaseDriverError
          ? error.driverError ?? error.message
          : error instanceof Error
            ? error.message
            : String(error);

      // Full text stays in the log and the history record (scrubbed); the response is safe.
      this.logger.warn(`Query failed [${driverCode}]: ${sanitizeTechnical(raw)}`);
      await this.history.record({
        userId,
        connectionId,
        connectionName: connection.name,
        conversationId: input.conversationId,
        prompt: input.prompt ?? null,
        sql: validation.normalizedSql,
        status: isTimeout ? QueryStatus.TIMEOUT : QueryStatus.ERROR,
        error: sanitizeTechnical(raw),
        aiGenerated: input.aiGenerated ?? false,
      });

      if (isUnavailable) {
        throw new SafeException('DB_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE, raw);
      }
      throw new SafeException(isTimeout ? 'DB_TIMEOUT' : 'QUERY_FAILED', HttpStatus.UNPROCESSABLE_ENTITY, raw, {
        status: isTimeout ? QueryStatus.TIMEOUT : QueryStatus.ERROR,
        // A rejected statement is about the user's own SQL (syntax, missing column), which the
        // SQL editor needs to show. It is scrubbed; timeouts carry nothing further.
        databaseError: isTimeout ? null : sanitizeTechnical(raw),
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
