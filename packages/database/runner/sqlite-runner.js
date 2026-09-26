'use strict';
/**
 * Runs ONE SQLite query in its own process. better-sqlite3 is synchronous and has no
 * interrupt API, so a heavy query in the API process freezes the whole event loop. Here it
 * only freezes this throwaway process, which the parent can SIGKILL on timeout/cancel.
 */
const Database = require('better-sqlite3');

process.once('message', (job) => {
  const { filePath, sql, maxRows, allowWrite, countTotal, countSql } = job;
  const started = Date.now();
  let db;
  try {
    db = new Database(filePath, { readonly: !allowWrite, fileMustExist: true, timeout: 8000 });
    if (!allowWrite) db.pragma('query_only = ON');
    const stmt = db.prepare(sql);
    const pick = (names, row) => {
      const out = {};
      for (const n of names) {
        const v = row[n];
        out[n] = typeof v === 'bigint' ? v.toString() : Buffer.isBuffer(v) ? v.toString('base64') : v;
      }
      return out;
    };
    let result;
    if (stmt.reader) {
      const cols = stmt.columns();
      const names = cols.map((c) => c.name);
      const rows = [];
      let truncated = false;
      for (const row of stmt.iterate()) {
        if (rows.length >= maxRows) {
          truncated = true;
          break;
        }
        rows.push(pick(names, row));
      }
      result = {
        columns: cols.map((c) => ({ name: c.name, type: c.type || null })),
        rows,
        returnedRows: rows.length,
        totalRows: truncated ? null : rows.length,
        truncated,
      };
    } else {
      const info = stmt.run();
      result = {
        columns: [{ name: 'changes', type: 'integer' }],
        rows: [{ changes: info.changes }],
        returnedRows: 1,
        totalRows: 1,
        truncated: false,
      };
    }
    result.executionTimeMs = Date.now() - started;
    const wantsCount = result.truncated && countTotal && !allowWrite;
    // The rows go out first; the (possibly slow) exact count follows and the parent may stop waiting.
    process.send({ type: 'result', result, more: wantsCount }, () => {
      if (!wantsCount) return process.exit(0);
      let total = null;
      try {
        const t = db.prepare(countSql).get();
        total = t ? Number(t.total) : null;
      } catch {
        total = null;
      }
      process.send({ type: 'total', total }, () => process.exit(0));
    });
  } catch (error) {
    process.send({ type: 'error', message: error && error.message ? error.message : String(error) }, () => process.exit(0));
  }
});
