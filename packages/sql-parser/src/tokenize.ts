/**
 * Lightweight SQL lexer used for defense-in-depth checks that must work even
 * when the AST parser fails. It strips string literals and comments so keyword
 * scans cannot be fooled by payloads hidden inside strings.
 */

export interface StrippedSql {
  /** SQL with string/identifier literals and comments blanked out. */
  stripped: string;
  hadBlockComment: boolean;
  hadLineComment: boolean;
  hadString: boolean;
}

export function stripLiteralsAndComments(sql: string): StrippedSql {
  let out = '';
  let hadBlockComment = false;
  let hadLineComment = false;
  let hadString = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    // line comment
    if ((ch === '-' && next === '-') || ch === '#') {
      hadLineComment = true;
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    // block comment
    if (ch === '/' && next === '*') {
      hadBlockComment = true;
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i++;
      out += ' ';
      continue;
    }
    // single/double quoted strings + backtick identifiers
    if (ch === "'" || ch === '"' || ch === '`') {
      hadString = ch === "'";
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote && sql[i + 1] === quote) {
          i += 2;
          continue;
        }
        if (sql[i] === '\\' && quote === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === quote) break;
        i++;
      }
      out += ' ? ';
      continue;
    }
    out += ch;
  }

  return { stripped: out, hadBlockComment, hadLineComment, hadString };
}

export function splitStatements(strippedSql: string): string[] {
  return strippedSql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function leadingKeyword(statement: string): string {
  const match = statement.trim().match(/^([a-zA-Z_]+)/);
  return match ? match[1].toUpperCase() : '';
}
