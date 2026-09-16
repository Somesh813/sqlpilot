/**
 * Small, dependency-free SQL pretty-printer. Not a full parser — it uppercases
 * keywords and breaks lines before the major clauses, which covers the queries
 * SQLPilot generates and edits.
 */
const KEYWORDS = [
  'select', 'from', 'where', 'group by', 'order by', 'having', 'limit', 'offset',
  'inner join', 'left join', 'right join', 'full join', 'cross join', 'join',
  'on', 'and', 'or', 'union all', 'union', 'insert into', 'values', 'update',
  'set', 'delete from', 'with', 'as', 'distinct', 'count', 'sum', 'avg', 'min',
  'max', 'case', 'when', 'then', 'else', 'end', 'is null', 'is not null',
  'not', 'in', 'like', 'between', 'asc', 'desc',
];

const BREAK_BEFORE = new Set([
  'select', 'from', 'where', 'group by', 'order by', 'having', 'limit', 'offset',
  'inner join', 'left join', 'right join', 'full join', 'cross join', 'join',
  'union all', 'union',
]);

export function formatSql(input: string): string {
  let sql = input.replace(/\s+/g, ' ').trim();
  if (!sql) return sql;

  // Uppercase keywords (longest first so "group by" beats "group").
  for (const kw of [...KEYWORDS].sort((a, b) => b.length - a.length)) {
    const rx = new RegExp(`\\b${kw.replace(/ /g, '\\s+')}\\b`, 'gi');
    sql = sql.replace(rx, kw.toUpperCase());
  }

  for (const kw of [...BREAK_BEFORE].map((k) => k.toUpperCase())) {
    sql = sql.replace(new RegExp(`\\s+${kw.replace(/ /g, '\\s+')}\\b`, 'g'), `\n${kw}`);
  }

  // Indent continuation of SELECT column lists a little.
  sql = sql.replace(/,\s*/g, ',\n  ');

  return sql
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{2,}/g, '\n');
}
