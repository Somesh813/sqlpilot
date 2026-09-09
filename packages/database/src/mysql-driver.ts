import { DatabaseType, QueryResult, QueryStatus, TableSchema, TestConnectionResult } from '@sqlpilot/shared';
import * as mysql from 'mysql2/promise';
import { DatabaseDriverError, DriverConfig, IntrospectionResult, RunQueryOptions, SqlDriver } from './types';

export class MysqlDriver implements SqlDriver {
  readonly type = DatabaseType.MYSQL;
  private pool: mysql.Pool;

  constructor(private readonly config: DriverConfig) {
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port ?? 3306,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      connectionLimit: 4,
      connectTimeout: 8000,
      dateStrings: true,
      multipleStatements: false,
    });
  }

  async testConnection(): Promise<TestConnectionResult> {
    const start = Date.now();
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>('SELECT VERSION() AS version');
      return {
        ok: true,
        latencyMs: Date.now() - start,
        serverVersion: String(rows[0]?.version ?? '') || null,
        error: null,
      };
    } catch (error) {
      return { ok: false, latencyMs: null, serverVersion: null, error: cleanError(error) };
    }
  }

  async introspect(): Promise<IntrospectionResult> {
    try {
      const db = this.config.database;
      const [columns] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, ORDINAL_POSITION,
                (SELECT TABLE_TYPE FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME) AS TABLE_TYPE
         FROM information_schema.COLUMNS c
         WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [db],
      );
      const [fks] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, CONSTRAINT_NAME
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [db],
      );
      const [indexes] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
        [db],
      );

      const fkMap = new Map(
        fks.map((r) => [
          `${r.TABLE_NAME}.${r.COLUMN_NAME}`,
          { table: r.REFERENCED_TABLE_NAME as string, column: r.REFERENCED_COLUMN_NAME as string },
        ]),
      );

      const tableMap = new Map<string, TableSchema>();
      for (const row of columns) {
        const name = row.TABLE_NAME as string;
        if (!tableMap.has(name)) {
          tableMap.set(name, {
            name,
            schema: db,
            kind: row.TABLE_TYPE === 'VIEW' ? 'view' : 'table',
            rowEstimate: null,
            comment: null,
            columns: [],
            indexes: [],
          });
        }
        const key = `${name}.${row.COLUMN_NAME}`;
        tableMap.get(name)!.columns.push({
          name: row.COLUMN_NAME as string,
          dataType: row.DATA_TYPE as string,
          nullable: row.IS_NULLABLE === 'YES',
          defaultValue: (row.COLUMN_DEFAULT as string) ?? null,
          isPrimaryKey: row.COLUMN_KEY === 'PRI',
          isForeignKey: fkMap.has(key),
          references: fkMap.get(key) ?? null,
          comment: null,
        });
      }

      const idxAcc = new Map<string, Map<string, { columns: string[]; unique: boolean; primary: boolean }>>();
      for (const row of indexes) {
        const t = row.TABLE_NAME as string;
        const i = row.INDEX_NAME as string;
        if (!idxAcc.has(t)) idxAcc.set(t, new Map());
        const m = idxAcc.get(t)!;
        if (!m.has(i)) m.set(i, { columns: [], unique: row.NON_UNIQUE === 0, primary: i === 'PRIMARY' });
        m.get(i)!.columns.push(row.COLUMN_NAME as string);
      }
      for (const [t, m] of idxAcc) {
        const table = tableMap.get(t);
        if (!table) continue;
        for (const [name, info] of m) table.indexes.push({ name, ...info });
      }

      return {
        databaseName: db,
        tables: Array.from(tableMap.values()),
        relationships: fks.map((r) => ({
          fromTable: r.TABLE_NAME as string,
          fromColumn: r.COLUMN_NAME as string,
          toTable: r.REFERENCED_TABLE_NAME as string,
          toColumn: r.REFERENCED_COLUMN_NAME as string,
          constraintName: r.CONSTRAINT_NAME as string,
        })),
        functions: [],
      };
    } catch (error) {
      throw new DatabaseDriverError('Failed to inspect MySQL schema.', cleanError(error), 'INTROSPECTION');
    }
  }

  async runQuery(sql: string, options: RunQueryOptions): Promise<QueryResult> {
    const conn = await this.pool.getConnection();
    const start = Date.now();
    try {
      await conn.query(`SET SESSION MAX_EXECUTION_TIME = ${Math.max(1000, options.timeoutMs)}`).catch(() => undefined);
      if (!options.allowWrite) {
        await conn.query('SET SESSION TRANSACTION READ ONLY').catch(() => undefined);
      }
      const [rows, fields] = await conn.query<mysql.RowDataPacket[]>({ sql });
      const rowArray = Array.isArray(rows) ? rows : [];
      const truncated = rowArray.length > options.maxRows;
      const limited = truncated ? rowArray.slice(0, options.maxRows) : rowArray;
      const columns = (fields as mysql.FieldPacket[] | undefined)?.map((f) => ({
        name: f.name,
        type: mysqlTypeName(f.type),
      })) ?? Object.keys(limited[0] ?? {}).map((name) => ({ name, type: null }));
      return {
        columns,
        rows: limited.map((r) => normalizeRow(r as Record<string, unknown>)),
        rowCount: limited.length,
        totalRowCount: rowArray.length,
        executionTimeMs: Date.now() - start,
        truncated,
        page: options.page,
        pageSize: options.pageSize,
        status: QueryStatus.SUCCESS,
        historyId: null,
      };
    } catch (error) {
      throw toQueryError(error, Date.now() - start);
    } finally {
      conn.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? v.toString() : v;
  }
  return out;
}

function mysqlTypeName(code: number | undefined): string | null {
  const map: Record<number, string> = { 1: 'tinyint', 2: 'smallint', 3: 'int', 8: 'bigint', 4: 'float', 5: 'double', 246: 'decimal', 7: 'timestamp', 10: 'date', 12: 'datetime', 253: 'varchar', 252: 'text', 245: 'json' };
  return code !== undefined ? map[code] ?? null : null;
}

function cleanError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toQueryError(error: unknown, elapsed: number): DatabaseDriverError {
  const message = cleanError(error);
  if (/max_execution_time|query execution was interrupted|timeout/i.test(message)) {
    return new DatabaseDriverError(`Query exceeded the time limit (${elapsed}ms).`, message, 'TIMEOUT');
  }
  return new DatabaseDriverError('Query execution failed.', message, 'QUERY');
}
