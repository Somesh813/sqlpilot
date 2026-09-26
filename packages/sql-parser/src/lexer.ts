import { ParserDialect } from './dialect';

export interface LexResult {
  /**
   * The SQL with every comment removed. String literals and quoted identifiers are kept
   * verbatim. THIS is the text that is validated and executed, so a comment can never
   * mean one thing to the validator and another to the database.
   */
  clean: string;
  /** `clean` with the *contents* of literals/quoted identifiers blanked, for token-level checks. */
  code: string;
  /** Top-level statements (split on `;` outside literals/comments), trimmed, empties dropped. */
  statements: string[];
  /** A string, quoted identifier, or block comment was never closed. Treated as unsafe. */
  unterminated: boolean;
}

const isIdentChar = (c: string) => /[A-Za-z0-9_\u0080-￿$]/.test(c);

/**
 * Splits and cleans SQL using the *actual comment/quoting rules of the target engine*.
 * The differences matter for safety:
 *   - `#` starts a comment in MySQL only (in PostgreSQL it is an operator).
 *   - `--` needs a following space in MySQL; PostgreSQL/SQLite do not.
 *   - Block comments nest in PostgreSQL only; MySQL also executes the body of version
 *     comments (slash-star-bang), so those are removed here as well.
 *   - PostgreSQL has dollar-quoted strings and E'..' backslash escapes.
 */
export function lexSql(sql: string, dialect: ParserDialect): LexResult {
  const n = sql.length;
  let clean = '';
  let code = '';
  let unterminated = false;
  const statements: string[] = [];
  let stmtStartClean = 0;

  const pushBoth = (cleanText: string, codeText: string = cleanText) => {
    clean += cleanText;
    code += codeText;
  };
  const endStatement = () => {
    const text = clean.slice(stmtStartClean).trim();
    if (text.length > 0) statements.push(text);
  };

  let i = 0;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // ---- line comments ----
    if (ch === '-' && next === '-') {
      const afterOk = dialect !== 'mysql' || i + 2 >= n || /[\s\u0000-\u001f]/.test(sql[i + 2]);
      if (afterOk) {
        while (i < n && sql[i] !== '\n') i++;
        pushBoth(' ');
        continue;
      }
    }
    if (ch === '#' && dialect === 'mysql') {
      while (i < n && sql[i] !== '\n') i++;
      pushBoth(' ');
      continue;
    }

    // ---- block comments ----
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (dialect === 'postgresql' && sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth > 0) unterminated = true;
      pushBoth(' ');
      continue;
    }

    // ---- PostgreSQL dollar-quoted strings: $$...$$ or $tag$...$tag$ ----
    if (dialect === 'postgresql' && ch === '$' && (i === 0 || !isIdentChar(sql[i - 1]))) {
      const m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) {
          unterminated = true;
          pushBoth(sql.slice(i), tag + ' ');
          i = n;
        } else {
          pushBoth(sql.slice(i, end + tag.length), tag + ' '.repeat(end - i - tag.length) + tag);
          i = end + tag.length;
        }
        continue;
      }
    }

    // ---- quoted strings / identifiers ----
    if (ch === "'" || ch === '"' || ch === '`' || (ch === '[' && dialect === 'sqlite')) {
      const close = ch === '[' ? ']' : ch;
      // E'..' in PostgreSQL uses backslash escapes; MySQL always does for ' and "
      const backslash =
        (dialect === 'mysql' && (ch === "'" || ch === '"')) ||
        (dialect === 'postgresql' && ch === "'" && i > 0 && /[eE]/.test(sql[i - 1]) && (i < 2 || !isIdentChar(sql[i - 2])));
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (backslash && sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === close) {
          if (sql[j + 1] === close && close !== ']') {
            j += 2; // doubled quote = escaped quote
            continue;
          }
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) {
        unterminated = true;
        pushBoth(sql.slice(i), close + ' '.repeat(Math.max(0, n - i - 1)));
        i = n;
        continue;
      }
      pushBoth(sql.slice(i, j + 1), ch + ' '.repeat(j - i - 1) + close);
      i = j + 1;
      continue;
    }

    // ---- statement separator ----
    if (ch === ';') {
      endStatement();
      pushBoth(';');
      stmtStartClean = clean.length;
      i++;
      continue;
    }

    pushBoth(ch);
    i++;
  }
  endStatement();

  return { clean, code, statements, unterminated };
}
