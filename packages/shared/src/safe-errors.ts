/**
 * Everything a user may be told about a failure, and the one function that scrubs the rest.
 *
 * Rule: a person asking questions about their data never sees provider names, organisation or
 * account ids, request ids, stack traces, credentials, connection strings, hosts or file paths.
 * Those go to the server log. Administrators may additionally see a short, scrubbed technical line.
 */

export type SafeErrorCode =
  | 'AI_BUSY'
  | 'AI_TIMEOUT'
  | 'AI_UNAVAILABLE'
  | 'AI_NOT_CONFIGURED'
  | 'AI_BAD_RESPONSE'
  | 'DB_UNAVAILABLE'
  | 'DB_TIMEOUT'
  | 'QUERY_FAILED'
  | 'UNSAFE_QUERY'
  | 'SCHEMA_MISMATCH'
  | 'NOT_UNDERSTOOD'
  | 'RATE_LIMITED';

export const SAFE_MESSAGES: Record<SafeErrorCode, string> = {
  AI_BUSY: 'AI service is temporarily busy. Please try again in a moment.',
  AI_TIMEOUT: 'The AI service took too long to respond. Please try again.',
  AI_UNAVAILABLE: 'The AI service is temporarily unavailable. Please try again in a moment.',
  AI_NOT_CONFIGURED: 'The AI service is not available right now. Please contact your administrator.',
  AI_BAD_RESPONSE: 'I could not turn that into a query. Try rephrasing your question.',
  DB_UNAVAILABLE: 'The database connection is unavailable. Please check the connection and try again.',
  DB_TIMEOUT: 'The query took too long and was stopped. Try a narrower question, for example a shorter date range.',
  QUERY_FAILED: 'Your request was understood, but the database could not run the query.',
  SCHEMA_MISMATCH: 'I could not match that request to the tables and columns in this database. Try rephrasing, or check that the data you are asking about exists.',
  UNSAFE_QUERY: 'That request could not be run because it was not a safe, read-only question.',
  NOT_UNDERSTOOD: 'Sorry, I could not understand that request. Try asking something like: \u201CShow total sales by month.\u201D',
  RATE_LIMITED: 'You are sending requests too quickly. Please wait a moment and try again.',
};

const REDACTIONS: Array<[RegExp, string]> = [
  // credentials and tokens
  [/\b(?:sk|gsk|pk|rk)[-_][A-Za-z0-9_-]{16,}\b/g, '[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]'],
  [/((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]'],
  // connection strings, with or without credentials
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, '[connection string]'],
  // provider organisation / project / request / account ids
  [/\b(?:org|proj|project|req|request|acct|user|key)[-_][A-Za-z0-9]{6,}\b/gi, '[id]'],
  [/\b(?:organization|organisation)\s+`?[A-Za-z0-9_-]{6,}`?/gi, 'organization [id]'],
  // file system paths (Windows and POSIX), keeping only the file name would still leak layout
  [/\b[A-Za-z]:\\(?:[^\s\\'"]+\\)*[^\s\\'"]*/g, '[path]'],
  [/(?<![\w:/])\/(?:[\w.@-]+\/)+[\w.@-]*/g, '[path]'],
  // network locations
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{2,5})?\b/g, '[address]'],
  [/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|local|corp|lan|svc|cluster\.local)(?::\d{2,5})?\b/gi, '[address]'],
];

/**
 * One line, scrubbed, length-limited. Stack frames are dropped. Safe to log, and safe to show
 * to an administrator; still never shown to end users.
 */
export function sanitizeTechnical(raw: unknown, maxLength = 300): string {
  let text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : String(raw ?? '');
  text = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*at\s+\S+/.test(line)) // stack frames
    .join(' ');
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}\u2026` : text;
}

/** True when the text still contains anything the redactions are meant to remove. */
export function looksSensitive(text: string): boolean {
  return REDACTIONS.some(([pattern]) => {
    pattern.lastIndex = 0;
    const found = pattern.test(text);
    pattern.lastIndex = 0;
    return found;
  });
}
