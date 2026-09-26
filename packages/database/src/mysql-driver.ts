import { DatabaseType, QueryResult, QueryStatus, TableSchema, TestConnectionResult } from '@sqlpilot/shared';
import type { Connection as CallbackConnection } from 'mysql2';
import * as mysql from 'mysql2/promise';
import { toDriverError } from './errors';
import { assertReadShaped, countSql, DatabaseDriverError, DriverConfig, IntrospectionResult, RunQueryOptions, SqlDriver } from './types';

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
      const warnings: string[] = [];
      try {
        const [grants] = await this.pool.query<mysql.RowDataPacket[]>('SHOW GRANTS FOR CURRENT_USER()');
        const text = grants.map((g) => String(Object.values(g)[0] ?? '')).join('\n');
        if (/ALL PRIVILEGES|\bFILE\b|\bSUPER\b|\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i.test(text)) {
          warnings.push(
            'This MySQL account can write or administer data. SQLPilot runs every query in a read-only transaction, but a dedicated account with only SELECT is safer.',
          );
        }
      } catch {
        /* privilege advice is best effort */
      }
      return {
        ok: true,
        latencyMs: Date.now() - start,
        serverVersion: String(rows[0]?.version ?? '') || null,
        error: null,
        warnings,
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

  /**
   * Runs ONE statement in `START TRANSACTION READ ONLY` (enforced by the server: writes fail
   * with error 1792). Rows are consumed as they stream in and reading stops at `maxRows + 1`;
   * when that happens the connection is destroyed, which cancels the rest of the transfer, so
   * a huge table is never buffered. `multipleStatements` is off at the pool level.
   */
  async runQuery(sql: string, options: RunQueryOptions): Promise<QueryResult> {
    const start = Date.now();
    const timeoutMs = Math.max(1000, options.timeoutMs);
    let discard = false;
    let conn: mysql.PoolConnection | null = null;
    try {
      if (!options.allowWrite) assertReadShaped(sql);
      conn = await this.pool.getConnection();
      await conn.query(`SET SESSION MAX_EXECUTION_TIME = ${Math.trunc(timeoutMs)}`).catch(() => undefined);
      await conn.query(options.allowWrite ? 'START TRANSACTION' : 'START TRANSACTION READ ONLY');

      const streamed = await streamRows(conn, sql, options.maxRows + 1, timeoutMs);
      discard = streamed.abandoned;

      const truncated = streamed.rows.length > options.maxRows;
      const kept = truncated ? streamed.rows.slice(0, options.maxRows) : streamed.rows;
      if (!discard) await conn.query(options.allowWrite ? 'COMMIT' : 'ROLLBACK');

      if (streamed.affectedRows !== null && streamed.fields.length === 0) {
        return {
          columns: [{ name: 'changes', type: 'integer' }],
          rows: [{ changes: streamed.affectedRows }],
          returnedRows: 1,
          totalRows: 1,
          executionTimeMs: Date.now() - start,
          truncated: false,
          status: QueryStatus.SUCCESS,
          historyId: null,
        };
      }

      const columns = streamed.fields.length
        ? streamed.fields.map((f) => ({ name: f.name, type: mysqlTypeName(f.type) }))
        : Object.keys(kept[0] ?? {}).map((name) => ({ name, type: null }));

      let totalRows: number | null = truncated ? null : kept.length;
      if (truncated && options.countTotal !== false && !options.allowWrite) {
        totalRows = await this.countRows(sql, Math.min(timeoutMs, 5000));
      }
      return {
        columns,
        rows: kept.map((r) => normalizeRow(r)),
        returnedRows: kept.length,
        totalRows,
        executionTimeMs: Date.now() - start,
        truncated,
        status: QueryStatus.SUCCESS,
        historyId: null,
      };
    } catch (error) {
      discard = true;
      throw toDriverError(error, Date.now() - start);
    } finally {
      if (discard) conn?.destroy();
      else conn?.release();
    }
  }

  /** Bounded exact count on a separate read-only connection; null if it cannot be had quickly. */
  private async countRows(sql: string, timeoutMs: number): Promise<number | null> {
    let conn: mysql.PoolConnection | null = null;
    try {
      conn = await this.pool.getConnection();
      await conn.query('START TRANSACTION READ ONLY');
      const [rows] = await conn.query<mysql.RowDataPacket[]>({ sql: countSql(sql), timeout: timeoutMs });
      await conn.query('ROLLBACK');
      const n = Number(rows[0]?.total);
      conn.release();
      return Number.isFinite(n) ? n : null;
    } catch {
      conn?.destroy();
      return null;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

interface StreamedRows {
  rows: Array<Record<string, unknown>>;
  fields: mysql.FieldPacket[];
  affectedRows: number | null;
  /** Reading stopped early; the connection still has unread data and must be destroyed. */
  abandoned: boolean;
}

/** Collects at most `limit` rows from the wire, then stops. Rejects on error or client-side timeout. */
function streamRows(conn: mysql.PoolConnection, sql: string, limit: number, timeoutMs: number): Promise<StreamedRows> {
  return new Promise((resolve, reject) => {
    const rows: Array<Record<string, unknown>> = [];
    let fields: mysql.FieldPacket[] = [];
    let affectedRows: number | null = null;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    // Backstop for when MAX_EXECUTION_TIME does not apply (it only covers SELECT).
    const timer = setTimeout(
      () => finish(() => {
        conn.destroy();
        reject(new Error('Query execution was interrupted: timeout'));
      }),
      timeoutMs + 2000,
    );

    // `conn.connection` is the underlying event-emitting connection of the promise wrapper.
    const query = (conn as unknown as { connection: CallbackConnection }).connection.query({ sql });
    query.on('fields', (f: mysql.FieldPacket[]) => {
      fields = f;
    });
    query.on('result', (row: Record<string, unknown> & { affectedRows?: number }) => {
      if (settled) return;
      if (fields.length === 0 && typeof row.affectedRows === 'number') {
        affectedRows = row.affectedRows;
        return;
      }
      rows.push(row);
      if (rows.length >= limit) finish(() => resolve({ rows, fields, affectedRows, abandoned: true }));
    });
    query.on('error', (e: Error) => finish(() => reject(e)));
    query.on('end', () => finish(() => resolve({ rows, fields, affectedRows, abandoned: false })));
  });
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
