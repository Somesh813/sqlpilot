import { Parser } from 'node-sql-parser';
import { inspectAst } from './ast-inspect';
import { ParserDialect } from './dialect';

/**
 * Checks that every table and column a query mentions exists in the known schema, BEFORE the
 * query is sent to the database. The model can invent names; catching that here turns a vague
 * database error into a precise, structured message the repair step can act on.
 *
 * Deliberately conservative: it only reports a name when it is sure it is wrong. Select-list
 * aliases, CTE names and derived-table aliases are understood and never reported, and matching
 * ignores case (PostgreSQL folds it, SQLite ignores it, MySQL varies by platform).
 */

export interface SchemaLike {
  tables: Array<{ name: string; columns: Array<{ name: string }> }>;
}

export type SchemaIssue =
  | {
      type: 'unknown_table';
      /** As written in the query. */
      table: string;
      /** Closest real table names. */
      suggestions: string[];
    }
  | {
      type: 'unknown_column';
      column: string;
      /** The real table the reference resolved to, or null when it was unqualified. */
      table: string | null;
      /** Closest real column names in the tables the query uses. */
      suggestions: string[];
      /** Other tables that DO have a column with this name (often a table missing from the JOIN). */
      foundIn: string[];
      /** Tables the column was looked up in. */
      searched: string[];
    };

export interface SchemaCheck {
  ok: boolean;
  issues: SchemaIssue[];
  /** Set when the check could not run (empty schema, unparseable SQL); the query is not blocked by it. */
  skipped: string | null;
}

/** Schema qualifiers that mean "the default schema" and are therefore fine to write. */
const DEFAULT_SCHEMAS = new Set(['public', 'main', 'dbo', 'default']);

const parser = new Parser();

const lower = (s: string) => s.toLowerCase();

export function checkAgainstSchema(sql: string, schema: SchemaLike, dialect: ParserDialect, databaseName?: string): SchemaCheck {
  if (!schema.tables.length) return { ok: true, issues: [], skipped: 'no schema is known for this connection' };

  const tableMap = new Map(schema.tables.map((t) => [lower(t.name), t]));
  const dbName = databaseName ? lower(databaseName) : null;

  let tableEntries: string[];
  let columnEntries: string[];
  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: dialect });
    tableEntries = parser.tableList(sql, { database: dialect });
    columnEntries = parser.columnList(sql, { database: dialect });
  } catch {
    return { ok: true, issues: [], skipped: 'the query could not be analysed' };
  }
  const roots = Array.isArray(ast) ? ast : [ast];
  const cteNames = new Set(inspectAst(roots).cteNames);
  const aliases = collectAliases(roots);

  const issues: SchemaIssue[] = [];
  const seen = new Set<string>();
  const push = (issue: SchemaIssue) => {
    const key = JSON.stringify([issue.type, (issue as { table: string | null }).table, (issue as { column?: string }).column]);
    if (!seen.has(key)) {
      seen.add(key);
      issues.push(issue);
    }
  };

  // ---- tables ----
  const usedTables = new Set<string>(); // real tables (lower-case names) the query reads
  for (const entry of tableEntries) {
    const [, qualifier, rawName] = entry.split('::');
    const name = lower(rawName ?? '');
    if (!name || cteNames.has(name)) continue;
    const qualified = qualifier && qualifier !== 'null' ? lower(qualifier) : null;
    const schemaOk = !qualified || DEFAULT_SCHEMAS.has(qualified) || qualified === dbName;
    if (schemaOk && tableMap.has(name)) {
      usedTables.add(name);
    } else {
      push({
        type: 'unknown_table',
        table: qualified ? `${qualifier}.${rawName}` : rawName,
        suggestions: closest(name, [...tableMap.keys()]).map((k) => tableMap.get(k)!.name),
      });
    }
  }

  const searched = [...usedTables].map((t) => tableMap.get(t)!.name);
  const columnsOf = (table: string) => new Set(tableMap.get(table)!.columns.map((c) => lower(c.name)));
  const usedColumnNames = new Set([...usedTables].flatMap((t) => [...columnsOf(t)]));

  // ---- columns ----
  for (const entry of columnEntries) {
    // `select::table::column`; a schema-qualified reference can add a segment (`select::db::table::column`)
    const parts = entry.split('::');
    const rawColumn = parts[parts.length - 1];
    const qualifier = parts.length > 2 ? parts[parts.length - 2] : parts[1];
    const column = lower(rawColumn ?? '');
    if (!column || column === '(.*)' || column === '*') continue;

    if (qualifier && qualifier !== 'null') {
      const table = lower(qualifier);
      if (tableMap.has(table)) {
        if (!columnsOf(table).has(column)) {
          push(unknownColumn(rawColumn, tableMap.get(table)!.name, [tableMap.get(table)!.name], tableMap, columnsOf(table)));
        }
      } else if (!cteNames.has(table) && !aliases.has(table)) {
        // a qualified reference to something that is neither a table, a CTE nor an alias
        push({
          type: 'unknown_table',
          table: qualifier,
          suggestions: closest(table, [...tableMap.keys()]).map((k) => tableMap.get(k)!.name),
        });
      }
      continue;
    }

    // unqualified: fine if it is an alias the query defined, or a column of any table it reads
    if (aliases.has(column) || usedColumnNames.has(column)) continue;
    push(unknownColumn(rawColumn, null, searched, tableMap, usedColumnNames));
  }

  return { ok: issues.length === 0, issues, skipped: null };
}

function unknownColumn(
  column: string,
  table: string | null,
  searched: string[],
  tableMap: Map<string, SchemaLike['tables'][number]>,
  candidates: Set<string>,
): SchemaIssue {
  const lc = lower(column);
  const foundIn = [...tableMap.values()]
    .filter((t) => t.columns.some((c) => lower(c.name) === lc))
    .map((t) => t.name)
    .slice(0, 5);
  const original = new Map<string, string>();
  for (const t of tableMap.values()) for (const c of t.columns) original.set(lower(c.name), c.name);
  return {
    type: 'unknown_column',
    column,
    table,
    suggestions: closest(lc, [...candidates]).map((c) => original.get(c) ?? c),
    foundIn,
    searched,
  };
}

/** Every name the query itself introduces: select aliases, table/subquery aliases, CTE column lists. */
function collectAliases(roots: unknown[]): Set<string> {
  const out = new Set<string>();
  const visit = (node: unknown, depth: number): void => {
    if (depth > 400 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (typeof obj.as === 'string' && obj.as) out.add(lower(obj.as));
    // WITH t(a, b) AS (...): the listed names are columns of t
    if (Array.isArray(obj.columns) && obj.name && typeof obj.name === 'object') {
      for (const c of obj.columns as unknown[]) {
        const v = typeof c === 'string' ? c : (c as { value?: unknown; column?: unknown })?.value ?? (c as { column?: unknown })?.column;
        if (typeof v === 'string') out.add(lower(v));
      }
    }
    for (const key of Object.keys(obj)) visit(obj[key], depth + 1);
  };
  roots.forEach((r) => visit(r, 0));
  return out;
}

/** Edit-distance + prefix/substring matching, best first, at most 3. */
export function closest(target: string, candidates: string[]): string[] {
  const t = lower(target);
  const scored = candidates
    .map((c) => {
      const d = levenshtein(t, lower(c));
      const limit = Math.max(2, Math.floor(Math.max(t.length, c.length) / 3));
      const related = lower(c).includes(t) || t.includes(lower(c)) || stem(t) === stem(lower(c));
      return { c, score: related ? Math.min(d, 1) : d, ok: d <= limit || related };
    })
    .filter((s) => s.ok)
    .sort((a, b) => a.score - b.score || a.c.localeCompare(b.c));
  return scored.slice(0, 3).map((s) => s.c);
}

const stem = (s: string) => s.replace(/(ies)$/, 'y').replace(/s$/, '');

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** A short, model-friendly rendering of the issues, used in the repair prompt. */
export function describeIssues(issues: SchemaIssue[]): string {
  return issues
    .map((i) => {
      if (i.type === 'unknown_table') {
        return `- Table "${i.table}" does not exist.${i.suggestions.length ? ` Did you mean: ${i.suggestions.join(', ')}?` : ''}`;
      }
      const where = i.table ? `table "${i.table}"` : `the tables used (${i.searched.join(', ') || 'none'})`;
      const parts = [`- Column "${i.column}" does not exist in ${where}.`];
      if (i.suggestions.length) parts.push(`Similar columns: ${i.suggestions.join(', ')}.`);
      if (i.foundIn.length) parts.push(`A column named "${i.column}" exists in: ${i.foundIn.join(', ')}; that table may need to be joined.`);
      return parts.join(' ');
    })
    .join('\n');
}
