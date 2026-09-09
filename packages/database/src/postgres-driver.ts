import { DatabaseType, QueryResult, QueryStatus, TableSchema, TestConnectionResult } from '@sqlpilot/shared';
import { Pool } from 'pg';
import { DatabaseDriverError, DriverConfig, IntrospectionResult, RunQueryOptions, SqlDriver } from './types';

export class PostgresDriver implements SqlDriver {
  readonly type = DatabaseType.POSTGRES;
  private pool: Pool;

  constructor(private readonly config: DriverConfig) {
    this.pool = new Pool({
      host: config.host,
      port: config.port ?? 5432,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      max: 4,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 10_000,
    });
  }

  async testConnection(): Promise<TestConnectionResult> {
    const start = Date.now();
    try {
      const res = await this.pool.query('SELECT version() AS version');
      return {
        ok: true,
        latencyMs: Date.now() - start,
        serverVersion: String(res.rows[0]?.version ?? '').split(' ').slice(0, 2).join(' ') || null,
        error: null,
      };
    } catch (error) {
      return { ok: false, latencyMs: null, serverVersion: null, error: cleanError(error) };
    }
  }

  async introspect(): Promise<IntrospectionResult> {
    try {
      const columns = await this.pool.query<{
        table_name: string;
        table_type: string;
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
        ordinal_position: number;
      }>(`
        SELECT c.table_name, t.table_type, c.column_name, c.data_type,
               c.is_nullable, c.column_default, c.ordinal_position
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        WHERE c.table_schema = 'public'
        ORDER BY c.table_name, c.ordinal_position
      `);

      const pks = await this.pool.query<{ table_name: string; column_name: string }>(`
        SELECT tc.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
      `);

      const fks = await this.pool.query<{
        table_name: string;
        column_name: string;
        foreign_table_name: string;
        foreign_column_name: string;
        constraint_name: string;
      }>(`
        SELECT tc.table_name, kcu.column_name,
               ccu.table_name AS foreign_table_name,
               ccu.column_name AS foreign_column_name,
               tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      `);

      const indexes = await this.pool.query<{ table_name: string; index_name: string; column_name: string; is_unique: boolean; is_primary: boolean }>(`
        SELECT t.relname AS table_name, i.relname AS index_name,
               a.attname AS column_name, ix.indisunique AS is_unique, ix.indisprimary AS is_primary
        FROM pg_class t
        JOIN pg_index ix ON t.oid = ix.indrelid
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public' AND t.relkind IN ('r', 'p')
        ORDER BY t.relname, i.relname
      `);

      const functions = await this.pool.query<{ routine_name: string }>(`
        SELECT routine_name FROM information_schema.routines
        WHERE specific_schema = 'public' AND routine_type = 'FUNCTION'
      `);

      const pkSet = new Set(pks.rows.map((r) => `${r.table_name}.${r.column_name}`));
      const fkMap = new Map(
        fks.rows.map((r) => [
          `${r.table_name}.${r.column_name}`,
          { table: r.foreign_table_name, column: r.foreign_column_name },
        ]),
      );

      const tableMap = new Map<string, TableSchema>();
      for (const row of columns.rows) {
        if (!tableMap.has(row.table_name)) {
          tableMap.set(row.table_name, {
            name: row.table_name,
            schema: 'public',
            kind: row.table_type === 'VIEW' ? 'view' : 'table',
            rowEstimate: null,
            comment: null,
            columns: [],
            indexes: [],
          });
        }
        const key = `${row.table_name}.${row.column_name}`;
        tableMap.get(row.table_name)!.columns.push({
          name: row.column_name,
          dataType: row.data_type,
          nullable: row.is_nullable === 'YES',
          defaultValue: row.column_default,
          isPrimaryKey: pkSet.has(key),
          isForeignKey: fkMap.has(key),
          references: fkMap.get(key) ?? null,
          comment: null,
        });
      }

      const indexByTable = new Map<string, Map<string, { columns: string[]; unique: boolean; primary: boolean }>>();
      for (const row of indexes.rows) {
        if (!indexByTable.has(row.table_name)) indexByTable.set(row.table_name, new Map());
        const map = indexByTable.get(row.table_name)!;
        if (!map.has(row.index_name)) map.set(row.index_name, { columns: [], unique: row.is_unique, primary: row.is_primary });
        map.get(row.index_name)!.columns.push(row.column_name);
      }
      for (const [tableName, idxMap] of indexByTable) {
        const table = tableMap.get(tableName);
        if (!table) continue;
        for (const [name, info] of idxMap) {
          table.indexes.push({ name, columns: info.columns, unique: info.unique, primary: info.primary });
        }
      }

      return {
        databaseName: this.config.database,
        tables: Array.from(tableMap.values()),
        relationships: fks.rows.map((r) => ({
          fromTable: r.table_name,
          fromColumn: r.column_name,
          toTable: r.foreign_table_name,
          toColumn: r.foreign_column_name,
          constraintName: r.constraint_name,
        })),
        functions: functions.rows.map((r) => r.routine_name),
      };
    } catch (error) {
      throw new DatabaseDriverError('Failed to inspect PostgreSQL schema.', cleanError(error), 'INTROSPECTION');
    }
  }

  async runQuery(sql: string, options: RunQueryOptions): Promise<QueryResult> {
    const client = await this.pool.connect();
    const start = Date.now();
    try {
      await client.query(`SET statement_timeout = ${Math.max(1000, options.timeoutMs)}`);
      if (!options.allowWrite) await client.query('SET TRANSACTION READ ONLY');
      const res = await client.query({ text: sql, rowMode: 'array' });
      const fields = res.fields ?? [];
      const allRows = (res.rows as unknown[][]) ?? [];
      const truncated = allRows.length > options.maxRows;
      const limited = truncated ? allRows.slice(0, options.maxRows) : allRows;
      const columns = fields.map((f) => ({ name: f.name, type: pgTypeName(f.dataTypeID) }));
      return {
        columns,
        rows: limited.map((r) => rowToObject(columns.map((c) => c.name), r)),
        rowCount: limited.length,
        totalRowCount: res.rowCount ?? allRows.length,
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
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function rowToObject(names: string[], row: unknown[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  names.forEach((name, i) => {
    obj[name] = normalizeValue(row[i]);
  });
  return obj;
}

function normalizeValue(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  return v;
}

function pgTypeName(oid: number): string | null {
  const map: Record<number, string> = {
    23: 'integer',
    20: 'bigint',
    21: 'smallint',
    1700: 'numeric',
    700: 'real',
    701: 'double precision',
    16: 'boolean',
    25: 'text',
    1043: 'varchar',
    1114: 'timestamp',
    1184: 'timestamptz',
    1082: 'date',
    114: 'json',
    3802: 'jsonb',
    2950: 'uuid',
  };
  return map[oid] ?? null;
}

function cleanError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toQueryError(error: unknown, elapsed: number): DatabaseDriverError {
  const message = cleanError(error);
  if (/statement timeout|canceling statement due to statement timeout/i.test(message)) {
    return new DatabaseDriverError(`Query exceeded the time limit (${elapsed}ms).`, message, 'TIMEOUT');
  }
  return new DatabaseDriverError('Query execution failed.', message, 'QUERY');
}
