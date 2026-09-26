import { isIdLike } from './analysis';
import { isNumeric } from './utils';

/**
 * What the language model is allowed to see.
 *
 * The database result is executed and analysed locally. The model is only asked to word an
 * answer, and for that it needs a small, scrubbed view: a few rows, a few columns, short
 * cells, no credentials, and no contact or identity details it does not need. The user still
 * sees the full, real result in their own table; nothing here changes what is displayed.
 */

/** Columns that hold secrets. Never sent, and never offered to the model as selectable. */
export const SENSITIVE_COLUMN =
  /(^|_)(pass(word|wd)?|pwd|passcode|secret|token|api_?key|apikey|private_?key|credential|salt|otp|cvv|cvc|ssn|aadhaar|aadhar|pan_?(no|number)?|card_?(no|number|num)|credit_?card|iban|account_?(no|number|num)|routing_?(no|number)|auth|session|cookie)(_|$)|password|passwd|hash$|_hash|secret/i;

/** Columns that identify or locate a person. Values are replaced with a placeholder for the model. */
export const PII_COLUMN =
  /(^|_)(e_?mail|phone|mobile|msisdn|tel(ephone)?|contact_?(no|number)|address|street|dob|birth_?(date|day)?|date_?of_?birth|ip(_?address)?|passport|licen[cs]e_?(no|number)?|national_?id|tax_?id|gstin|latitude|longitude)(_|$)/i;

export interface LlmLimits {
  /** Most rows shown to the model. */
  maxRows: number;
  /** Most columns shown to the model. */
  maxColumns: number;
  /** Longest cell, in characters. */
  maxCell: number;
}

export const DEFAULT_LLM_LIMITS: LlmLimits = { maxRows: 20, maxColumns: 10, maxCell: 60 };

/* ------------------------------------------------------------------ value scrubbing */

const CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key]'],
  [/\b(?:sk|gsk|pk|rk|xox[abp])[-_][A-Za-z0-9_-]{16,}\b/g, '[secret]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[secret]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [secret]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[secret]'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:'"]+:[^\s/@'"]+@[^\s'"]+/gi, '[connection string]'],
  [/((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;)]+)/gi, '$1[secret]'],
];

const PII_PATTERNS: Array<[RegExp, string | ((m: string) => string)]> = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'],
  [/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, '[id number]'], // Indian PAN
  [/\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, (m) => (m.replace(/\D/g, '').length === 12 ? '[id number]' : m)], // Aadhaar
  [/\b(?:\d[ -]?){13,19}\b/g, (m) => (luhn(m.replace(/\D/g, '')) ? '[card number]' : m)],
  [/(?<![\w.])\+?\d(?:[ -]?\d){9,14}(?![\w.])/g, (m) => (m.replace(/\D/g, '').length >= 10 ? '[phone]' : m)],
];

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Removes credentials from any text about to leave the server (prompts, SQL, errors). */
export function redactCredentials(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
    out = out.replace(pattern, (...args) => {
      count++;
      return typeof replacement === 'string' ? replacement.replace(/\$1/g, String(args[1] ?? '')) : replacement;
    });
  }
  return { text: out, count };
}

/** Masks contact and identity details inside free text (database errors, cell contents). */
export function maskPii(text: string): string {
  let out = redactCredentials(text).text;
  for (const [pattern, replacement] of PII_PATTERNS) {
    out = out.replace(pattern, (m) => (typeof replacement === 'string' ? replacement : replacement(m)));
  }
  return out;
}

export function truncateCell(value: unknown, max: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[A-Za-z0-9+/]{200,}={0,2}$/.test(text)) return '[binary data]';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/* ------------------------------------------------------------------ the view */

export interface LlmResultView {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  /** What was held back, so the prompt can say so and the model does not guess at it. */
  omitted: {
    rows: number;
    secretColumns: number;
    identifierColumns: number;
    extraColumns: number;
    maskedColumns: string[];
    redactedValues: number;
  };
}

/**
 * The only shape of result data that may be put in a prompt. Built from the full local result:
 *   1. secret columns are dropped entirely;
 *   2. identifier columns (id, customer_id, ...) are dropped: they carry no meaning for wording;
 *   3. contact/identity columns keep their place but every value becomes a placeholder;
 *   4. any value that looks like a credential, email, phone, card or national id is scrubbed
 *      whatever its column is called;
 *   5. cells are shortened, and only the first rows and the most useful columns are kept.
 */
export function minimizeResultForLlm(
  columns: string[],
  rows: Array<Record<string, unknown>>,
  limits: Partial<LlmLimits> = {},
): LlmResultView {
  const { maxRows, maxColumns, maxCell } = { ...DEFAULT_LLM_LIMITS, ...limits };

  const secret = columns.filter((c) => SENSITIVE_COLUMN.test(c));
  let kept = columns.filter((c) => !secret.includes(c));

  const ids = kept.filter((c) => isIdLike(c));
  // an id is only worth sending when nothing else would be left to describe the rows
  const withoutIds = kept.filter((c) => !ids.includes(c));
  const droppedIds = withoutIds.length > 0 ? ids : [];
  kept = withoutIds.length > 0 ? withoutIds : kept;

  const numeric = (c: string) => {
    const vals = rows.map((r) => r[c]).filter((v) => v !== null && v !== undefined && v !== '');
    return vals.length > 0 && vals.every(isNumeric);
  };
  // most useful first: labels, then measures, then the rest in their original order
  const firstLabel = kept.find((c) => !numeric(c) && !PII_COLUMN.test(c));
  const rank = (c: string) => (PII_COLUMN.test(c) ? 3 : c === firstLabel ? 0 : numeric(c) ? 1 : 2);
  const ordered = [...kept].sort((a, b) => rank(a) - rank(b) || kept.indexOf(a) - kept.indexOf(b));
  const shown = ordered.slice(0, maxColumns);
  const extra = ordered.length - shown.length;

  let redacted = 0;
  const masked = shown.filter((c) => PII_COLUMN.test(c));
  const cleanCell = (col: string, value: unknown): unknown => {
    if (value === null || value === undefined) return null;
    if (masked.includes(col)) return '[hidden]';
    const cell = truncateCell(value, maxCell);
    if (typeof cell !== 'string') return cell;
    // A bare number (a bigint or numeric that arrived as text) is a measure, not a phone number.
    if (/^-?\d+(\.\d+)?$/.test(cell)) return cell;
    const scrubbed = maskPii(cell);
    if (scrubbed !== cell) redacted++;
    return scrubbed;
  };

  const sample = rows.slice(0, maxRows).map((row) => {
    const out: Record<string, unknown> = {};
    for (const col of shown) out[col] = cleanCell(col, row[col]);
    return out;
  });

  return {
    columns: shown,
    rows: sample,
    omitted: {
      rows: Math.max(0, rows.length - sample.length),
      secretColumns: secret.length,
      identifierColumns: droppedIds.length,
      extraColumns: Math.max(0, extra),
      maskedColumns: masked,
      redactedValues: redacted,
    },
  };
}

/** One line for the prompt describing what the model is not being shown. */
export function describeOmissions(view: LlmResultView): string {
  const o = view.omitted;
  const parts: string[] = [];
  if (o.rows > 0) parts.push(`${o.rows} more row(s)`);
  const hidden = o.secretColumns + o.identifierColumns + o.extraColumns;
  if (hidden > 0) parts.push(`${hidden} other column(s)`);
  if (o.maskedColumns.length) parts.push(`the values of ${o.maskedColumns.join(', ')} (personal data, shown as [hidden])`);
  return parts.length ? `Not shown to you: ${parts.join('; ')}. Do not guess at them or mention them.` : '';
}

/* ------------------------------------------------------------------ schema */

/** Secret-holding columns are not offered to the model at all, so it cannot select them. */
export function isSelectableForLlm(columnName: string): boolean {
  return !SENSITIVE_COLUMN.test(columnName);
}
