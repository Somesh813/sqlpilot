import { DatabaseType, QueryResult, QueryStatus, TableSchema, TestConnectionResult } from '@sqlpilot/shared';
import { Pool, PoolClient } from 'pg';
import Cursor from 'pg-cursor';
import { toDriverError } from './errors';
import { assertReadShaped, countSql, DatabaseDriverError, DriverConfig, IntrospectionResult, RunQueryOptions, SqlDriver } from './types';

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
      max: config.pool?.max ?? 5,
      connectionTimeoutMillis: 8000,
      // Idle connections are released after this; the registry closes the whole pool later.
      idleTimeoutMillis: config.pool?.idleMs ?? 30_000,
      keepAlive: true,
      application_name: 'sqlpilot',
    });
    // An idle connection dropped by the server (restart, network) emits 'error' on the pool. With
    // no listener, Node treats that as an uncaught exception and the API process dies.
    this.pool.on('error', () => undefined);
  }

  async testConnection(): Promise<TestConnectionResult> {
    const start = Date.now();
    try {
      const res = await this.pool.query('SELECT version() AS version');
      const warnings: string[] = [];
      try {
        const role = await this.pool.query<{ rolsuper: boolean; rolcreaterole: boolean }>(
          'SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user',
        );
        if (role.rows[0]?.rolsuper) {
          warnings.push(
            'This account is a PostgreSQL superuser. SQLPilot runs every query in a read-only transaction, but a dedicated read-only role (GRANT pg_read_all_data) is safer.',
          );
        }
      } catch {
        /* privilege advice is best effort */
      }
      return {
        ok: true,
        latencyMs: Date.now() - start,
        serverVersion: String(res.rows[0]?.version ?? '').split(' ').slice(0, 2).join(' ') || null,
        error: null,
        warnings,
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

  /**
   * Runs ONE statement inside an explicit transaction.
   *
   * Read-only mode uses `BEGIN READ ONLY`, which PostgreSQL itself enforces: DELETE, INSERT,
   * CREATE, SELECT ... INTO, nextval() and friends all fail with "cannot execute ... in a
   * read-only transaction". (`SET TRANSACTION READ ONLY` outside a transaction block is a
   * no-op with a warning, which is what this driver used to rely on.)
   *
   * Rows are pulled through a cursor, `maxRows + 1` at most, so a huge table is never loaded.
   * The extended protocol also refuses multi-statement strings.
   */
  async runQuery(sql: string, options: RunQueryOptions): Promise<QueryResult> {
    const start = Date.now();
    const timeoutMs = Math.max(1000, options.timeoutMs);
    let destroy = false;
    let client: PoolClient | null = null;
    try {
      if (!options.allowWrite) assertReadShaped(sql);
      client = await this.pool.connect();
      await client.query(options.allowWrite ? 'BEGIN' : 'BEGIN READ ONLY');
      // Setting the timeouts through a SELECT takes the transaction's first snapshot. After that
      // PostgreSQL refuses `SET TRANSACTION READ WRITE`, so a read-only transaction cannot be
      // flipped back (before the first snapshot it can).
      await client.query('SELECT set_config($1, $2, true), set_config($3, $4, true)', [
        'statement_timeout',
        String(Math.trunc(timeoutMs)),
        'idle_in_transaction_session_timeout',
        String(Math.trunc(timeoutMs) + 5000),
      ]);

      const cursor = client.query(new Cursor(sql, [], { rowMode: 'array' }));
      let rows: unknown[][];
      let fields: Array<{ name: string; dataTypeID: number }>;
      let affected: number | null;
      try {
        rows = (await cursor.read(options.maxRows + 1)) as unknown[][];
        const meta = (cursor as unknown as { _result?: { fields?: typeof fields; rowCount?: number | null } })._result;
        fields = meta?.fields ?? [];
        affected = meta?.rowCount ?? null;
      } finally {
        await cursor.close().catch(() => undefined);
      }

      const truncated = rows.length > options.maxRows;
      const kept = truncated ? rows.slice(0, options.maxRows) : rows;

      let totalRows: number | null = truncated ? null : kept.length;
      if (truncated && options.countTotal !== false && !options.allowWrite) {
        totalRows = await this.countRows(client, sql, Math.min(timeoutMs, 5000));
      }

      // Read-only transactions are always rolled back; the editor's writes are committed.
      await client.query(options.allowWrite ? 'COMMIT' : 'ROLLBACK');

      if (fields.length === 0) {
        // DML without RETURNING / utility command: report what changed.
        return {
          columns: [{ name: 'changes', type: 'integer' }],
          rows: [{ changes: affected ?? 0 }],
          returnedRows: 1,
          totalRows: 1,
          executionTimeMs: Date.now() - start,
          truncated: false,
          status: QueryStatus.SUCCESS,
          historyId: null,
        };
      }

      const columns = fields.map((f) => ({ name: f.name, type: pgTypeName(f.dataTypeID) }));
      const names = columns.map((c) => c.name);
      return {
        columns,
        rows: kept.map((r) => rowToObject(names, r)),
        returnedRows: kept.length,
        totalRows,
        executionTimeMs: Date.now() - start,
        truncated,
        status: QueryStatus.SUCCESS,
        historyId: null,
      };
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => {
        destroy = true; // the session is in an unknown state; do not return it to the pool
      });
      throw toDriverError(error, Date.now() - start);
    } finally {
      client?.release(destroy ? new Error('discarded after failed rollback') : undefined);
    }
  }

  /** Bounded exact count inside the same READ ONLY transaction; null if it cannot be had quickly. */
  private async countRows(client: PoolClient, sql: string, timeoutMs: number): Promise<number | null> {
    try {
      await client.query('SAVEPOINT sqlpilot_count');
      await client.query(`SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}`);
      const res = await client.query<{ total: string }>(countSql(sql));
      await client.query('RELEASE SAVEPOINT sqlpilot_count');
      const n = Number(res.rows[0]?.total);
      return Number.isFinite(n) ? n : null;
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT sqlpilot_count').catch(() => undefined);
      return null;
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
