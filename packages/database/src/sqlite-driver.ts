import { DatabaseType, QueryResult, QueryStatus, TableSchema, TestConnectionResult } from '@sqlpilot/shared';
import BetterSqlite3 from 'better-sqlite3';
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { assertReadShaped, countSql, DatabaseDriverError, DriverConfig, IntrospectionResult, RunQueryOptions, SqlDriver } from './types';

const RUNNER = join(__dirname, '..', 'runner', 'sqlite-runner.js');

interface RunnerMessage {
  type: 'result' | 'total' | 'error';
  result?: Omit<QueryResult, 'status' | 'historyId'>;
  more?: boolean;
  total?: number | null;
  message?: string;
}

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
      throw new DatabaseDriverError('The SQLite database file could not be opened.', 'file not found', 'CONNECTION');
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

  /**
   * Runs the query in a separate process (see runner/sqlite-runner.js). The API's event loop
   * stays free while it runs, and the process is killed on timeout or cancellation, which
   * actually stops the work (a worker thread cannot interrupt a native SQLite call).
   */
  async runQuery(sql: string, options: RunQueryOptions): Promise<QueryResult> {
    const path = this.config.filePath!;
    if (!existsSync(path)) throw new DatabaseDriverError('The SQLite database file could not be opened.', 'file not found', 'CONNECTION');
    if (!options.allowWrite) assertReadShaped(sql);

    const timeoutMs = Math.max(1000, options.timeoutMs);
    const start = Date.now();

    return new Promise<QueryResult>((resolve, reject) => {
      const child = fork(RUNNER, [], {
        execArgv: ['--max-old-space-size=384'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'json',
      });
      let settled = false;
      let pending: QueryResult | null = null;
      let countTimer: NodeJS.Timeout | undefined;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(countTimer);
        options.signal?.removeEventListener('abort', onAbort);
        child.kill('SIGKILL');
        fn();
      };
      const fail = (error: DatabaseDriverError) => finish(() => reject(error));
      const timer = setTimeout(
        () => fail(new DatabaseDriverError(`Query exceeded the time limit (${Date.now() - start}ms).`, 'timeout', 'TIMEOUT')),
        timeoutMs,
      );
      const onAbort = () => fail(new DatabaseDriverError('The query was cancelled.', 'cancelled', 'CANCELLED'));
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener('abort', onAbort, { once: true });

      child.on('message', (msg: RunnerMessage) => {
        if (msg.type === 'error') return fail(new DatabaseDriverError('Query execution failed.', msg.message, 'QUERY'));
        if (msg.type === 'result') {
          pending = { ...msg.result!, status: QueryStatus.SUCCESS, historyId: null };
          if (!msg.more) return finish(() => resolve(pending!));
          // rows are in hand; give the exact count a short, separate budget
          countTimer = setTimeout(() => finish(() => resolve(pending!)), Math.min(5000, timeoutMs));
          return;
        }
        if (msg.type === 'total' && pending) {
          pending.totalRows = msg.total ?? null;
          finish(() => resolve(pending!));
        }
      });
      child.on('error', (e) => fail(new DatabaseDriverError('Query execution failed.', e.message, 'QUERY')));
      child.on('exit', (code) => {
        if (!settled) fail(new DatabaseDriverError('Query execution failed.', `query process exited unexpectedly (${code})`, 'QUERY'));
      });

      child.send({
        filePath: path,
        sql,
        maxRows: options.maxRows,
        allowWrite: options.allowWrite,
        countTotal: options.countTotal !== false,
        countSql: countSql(sql),
      });
    });
  }

  async close(): Promise<void> {
    /* connections are opened per-operation */
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function cleanError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
