import { DatabaseType, QueryResult, QueryStatus, TableSchema, TestConnectionResult } from '@sqlpilot/shared';
import BetterSqlite3 from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { assertReadShaped, countSql, DatabaseDriverError, DriverConfig, IntrospectionResult, RunQueryOptions, SqlDriver } from './types';

export class SqliteDriver implements SqlDriver {
  readonly type = DatabaseType.SQLITE;

  constructor(private readonly config: DriverConfig) {
    if (!config.filePath) {
      throw new DatabaseDriverError('SQLite connections require a file path.', null, 'CONNECTION');
    }
  }

  private open(readonly: boolean): BetterSqlite3.Database {
    const path = this.config.filePath!;
    if (!existsSync(path)) {
      throw new DatabaseDriverError(`SQLite database file not found: ${path}`, null, 'CONNECTION');
    }
    return new BetterSqlite3(path, { readonly, fileMustExist: true, timeout: 8000 });
  }

  async testConnection(): Promise<TestConnectionResult> {
    const start = Date.now();
    try {
      const db = this.open(true);
      const row = db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
      db.close();
      return { ok: true, latencyMs: Date.now() - start, serverVersion: `SQLite ${row.version}`, error: null };
    } catch (error) {
      return { ok: false, latencyMs: null, serverVersion: null, error: cleanError(error) };
    }
  }

  async introspect(): Promise<IntrospectionResult> {
    const db = this.open(true);
    try {
      const objects = db
        .prepare(`SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'`)
        .all() as Array<{ name: string; type: 'table' | 'view' }>;

      const tables: TableSchema[] = [];
      const relationships: IntrospectionResult['relationships'] = [];

      for (const obj of objects) {
        const cols = db.prepare(`PRAGMA table_info(${quoteIdent(obj.name)})`).all() as Array<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
          pk: number;
        }>;
        const fkList = db.prepare(`PRAGMA foreign_key_list(${quoteIdent(obj.name)})`).all() as Array<{
          table: string;
          from: string;
          to: string;
        }>;
        const idxList = db.prepare(`PRAGMA index_list(${quoteIdent(obj.name)})`).all() as Array<{
          name: string;
          unique: number;
          origin: string;
        }>;

        const fkFrom = new Map(fkList.map((f) => [f.from, { table: f.table, column: f.to }]));

        tables.push({
          name: obj.name,
          schema: null,
          kind: obj.type,
          rowEstimate: null,
          comment: null,
          columns: cols.map((c) => ({
            name: c.name,
            dataType: c.type || 'TEXT',
            nullable: c.notnull === 0,
            defaultValue: c.dflt_value,
            isPrimaryKey: c.pk > 0,
            isForeignKey: fkFrom.has(c.name),
            references: fkFrom.get(c.name) ?? null,
            comment: null,
          })),
          indexes: idxList.map((idx) => {
            const info = db.prepare(`PRAGMA index_info(${quoteIdent(idx.name)})`).all() as Array<{ name: string }>;
            return {
              name: idx.name,
              columns: info.map((i) => i.name),
              unique: idx.unique === 1,
              primary: idx.origin === 'pk',
            };
          }),
        });

        for (const fk of fkList) {
          relationships.push({
            fromTable: obj.name,
            fromColumn: fk.from,
            toTable: fk.table,
            toColumn: fk.to,
            constraintName: null,
          });
        }
      }

      return { databaseName: this.config.filePath!.split(/[\\/]/).pop() ?? 'sqlite', tables, relationships, functions: [] };
    } catch (error) {
      throw new DatabaseDriverError('Failed to inspect SQLite schema.', cleanError(error), 'INTROSPECTION');
    } finally {
      db.close();
    }
  }

  async runQuery(sql: string, options: RunQueryOptions): Promise<QueryResult> {
    const db = this.open(!options.allowWrite);
    const start = Date.now();
    // better-sqlite3 is synchronous and has no statement-interrupt API. The `timeout`
    // option above bounds lock contention; a hard wall-clock guard is enforced after the
    // fact so a pathological query still surfaces as a TIMEOUT to the caller.
    const deadline = start + Math.max(1000, options.timeoutMs);

    try {
      // Read-only access is enforced by the file handle itself (opened `readonly`), plus
      // query_only, which also refuses temp-table writes.
      if (!options.allowWrite) {
        assertReadShaped(sql);
        db.pragma('query_only = ON');
      }
      const stmt = db.prepare(sql);
      if (stmt.reader) {
        // Pull at most maxRows + 1 rows; the extra one proves the result was cut off.
        const names = stmt.columns().map((c) => c.name);
        const rows: Array<Record<string, unknown>> = [];
        let truncated = false;
        for (const row of stmt.iterate() as IterableIterator<Record<string, unknown>>) {
          if (rows.length >= options.maxRows) {
            truncated = true;
            break;
          }
          rows.push(pick(names, row));
        }
        if (Date.now() > deadline) {
          throw new DatabaseDriverError(`Query exceeded the time limit (${Date.now() - start}ms).`, null, 'TIMEOUT');
        }
        let totalRows: number | null = truncated ? null : rows.length;
        if (truncated && options.countTotal !== false && !options.allowWrite) {
          try {
            const total = db.prepare(countSql(sql)).get() as { total: number | bigint } | undefined;
            totalRows = total ? Number(total.total) : null;
          } catch {
            totalRows = null;
          }
        }
        return {
          columns: stmt.columns().map((c) => ({ name: c.name, type: c.type ?? null })),
          rows,
          returnedRows: rows.length,
          totalRows,
          executionTimeMs: Date.now() - start,
          truncated,
          status: QueryStatus.SUCCESS,
          historyId: null,
        };
      }
      const info = stmt.run();
      return {
        columns: [{ name: 'changes', type: 'integer' }],
        rows: [{ changes: info.changes }],
        returnedRows: 1,
        totalRows: 1,
        executionTimeMs: Date.now() - start,
        truncated: false,
        status: QueryStatus.SUCCESS,
        historyId: null,
      };
    } catch (error) {
      if (error instanceof DatabaseDriverError) throw error;
      throw new DatabaseDriverError('Query execution failed.', cleanError(error), 'QUERY');
    } finally {
      db.close();
    }
  }

  async close(): Promise<void> {
    /* connections are opened per-operation */
  }
}

function pick(names: string[], row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const v = row[name];
    out[name] = typeof v === 'bigint' ? v.toString() : v instanceof Buffer ? v.toString('base64') : v;
  }
  return out;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function cleanError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
