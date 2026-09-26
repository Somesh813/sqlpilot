import type { ResultAnalysis } from './analysis';
import { isIdLike } from './analysis';
import { summarizeRows } from './row-summary';
import { isNumeric } from './utils';

/**
 * Grounding for AI answers. The pipeline is
 *
 *   SQL -> database -> structured result -> deterministic facts -> (model words it) -> verify
 *
 * The model only rewords. Everything it says that can be checked (numbers, "no results",
 * "total" of a partial result) is checked against the facts, and a wrong answer is replaced
 * by the deterministic one built here. So "COUNT = 3" can never reach the user as "2".
 */

export interface ResultFacts {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  returnedRows: number;
  totalRows: number | null;
  truncated: boolean;
  isEmpty: boolean;
  /** Columns that hold measurements (numeric, not IDs). */
  measureColumns: string[];
  /** First non-measure column, used to label rows. */
  labelColumn: string | null;
  resultType: string;
}

export function buildResultFacts(input: {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  returnedRows?: number;
  totalRows?: number | null;
  truncated?: boolean;
  analysis?: Pick<ResultAnalysis, 'resultType' | 'numericColumns'>;
}): ResultFacts {
  const { columns, rows } = input;
  const numeric =
    input.analysis?.numericColumns ??
    columns.filter((c) => {
      const vals = rows.map((r) => r[c]).filter((v) => v !== null && v !== undefined && v !== '');
      return vals.length > 0 && vals.every(isNumeric);
    });
  const measureColumns = numeric.filter((c) => !isIdLike(c));
  return {
    columns,
    rows,
    returnedRows: input.returnedRows ?? rows.length,
    totalRows: input.totalRows ?? null,
    truncated: input.truncated ?? false,
    isEmpty: rows.length === 0,
    measureColumns,
    labelColumn: columns.find((c) => !numeric.includes(c)) ?? null,
    resultType: input.analysis?.resultType ?? (rows.length === 0 ? 'empty' : 'table'),
  };
}

/* ------------------------------------------------------------------ formatting */

export function formatFactNumber(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function humanizeColumn(name: string): string {
  const s = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\s]+/g, ' ').trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ------------------------------------------------------------------ deterministic answer */

/** An answer built only from the facts. Used when the model is unavailable or contradicts the data. */
export function deterministicAnswer(facts: ResultFacts): string {
  if (facts.isEmpty) return 'No matching records were found.';

  const { columns, rows } = facts;
  if (rows.length === 1 && facts.measureColumns.length === columns.length) {
    const parts = columns.map((c) => `${humanizeColumn(c)}: ${formatFactNumber(rows[0][c])}`);
    return `${parts.join('; ')}.`;
  }
  if (rows.length === 1) {
    const parts = columns.map((c) => `${humanizeColumn(c)}: ${rows[0][c] === null ? 'no value' : String(rows[0][c])}`);
    return `${parts.join('; ')}.`;
  }

  const summary = summarizeRows(facts.returnedRows, facts.totalRows, facts.truncated);
  const lead = facts.truncated ? summary.text : `Found ${summary.text}.`;
  const measure = facts.measureColumns[0];
  if (measure && facts.labelColumn && !facts.truncated) {
    const withValue = rows.filter((r) => isNumeric(r[measure]));
    if (withValue.length > 1) {
      const max = withValue.reduce((a, b) => (Number(b[measure]) > Number(a[measure]) ? b : a));
      const min = withValue.reduce((a, b) => (Number(b[measure]) < Number(a[measure]) ? b : a));
      return `${lead} The highest ${humanizeColumn(measure).toLowerCase()} is ${String(max[facts.labelColumn])} (${formatFactNumber(max[measure])}) and the lowest is ${String(min[facts.labelColumn])} (${formatFactNumber(min[measure])}).`;
    }
  }
  return lead;
}

/* ------------------------------------------------------------------ verification */

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};
const MULTIPLIERS: Record<string, number> = {
  k: 1e3, thousand: 1e3, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, crore: 1e7, crores: 1e7,
  m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9,
};

interface Claim {
  value: number;
  /** Decimal places written in the answer (rounding tolerance). */
  decimals: number;
  approx: boolean;
  text: string;
}

/** Numbers stated in prose, including words ("three") and unit suffixes ("1.5 lakh", "2M"). */
export function extractNumericClaims(text: string): Claim[] {
  const claims: Claim[] = [];
  const t = text.replace(/ /g, ' ');

  const numberToken = /(?<![\w.])[-+]?\d[\d,]*(?:\.\d+)?(?:\s?(k|thousand|lakhs?|lacs?|crores?|mn|million|bn|billion|m|b)\b)?(?:st|nd|rd|th)?/gi;
  for (const m of t.matchAll(numberToken)) {
    const raw = m[0];
    if (/\d(st|nd|rd|th)$/i.test(raw)) continue; // 1st, 2nd, 3rd: ordinals, not claims
    const suffix = m[1]?.toLowerCase();
    const digits = raw.replace(/[a-z\s]/gi, '').replace(/,/g, '');
    const value = Number(digits);
    if (!Number.isFinite(value)) continue;
    const dot = digits.indexOf('.');
    claims.push({
      value: suffix ? value * (MULTIPLIERS[suffix] ?? 1) : value,
      decimals: dot === -1 ? 0 : digits.length - dot - 1,
      approx: Boolean(suffix),
      text: raw.trim(),
    });
  }

  const words = [...t.matchAll(/\b(?:(no|the|any|every|each|this|that)\s+)?(zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|one)\b(\s+of\b)?/gi)];
  for (const m of words) {
    const w = m[2].toLowerCase();
    if (w === 'one' && (m[1] || m[3])) continue; // "no one", "one of them"
    const value = w === 'one' ? 1 : WORD_NUMBERS[w];
    if (value === undefined) continue;
    claims.push({ value, decimals: 0, approx: false, text: m[2] });
  }
  return claims;
}

function cellNumbers(v: unknown, out: number[]): void {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return;
  if (isNumeric(v)) {
    out.push(Number(v));
    return;
  }
  if (typeof v === 'string') {
    // dates and labels: the numbers inside ("2026-05-01", "Q3", "Zone 4") are legitimate to quote
    for (const m of v.matchAll(/\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
  }
}

/** Every number the answer is allowed to state, derived from the data alone. */
export function allowedNumbers(facts: ResultFacts, question = ''): number[] {
  const out: number[] = [facts.returnedRows];
  if (facts.totalRows !== null) out.push(facts.totalRows);

  const idCols = new Set(facts.columns.filter((c) => isIdLike(c)));
  for (const row of facts.rows) {
    for (const c of facts.columns) {
      if (idCols.has(c)) continue; // "customer 3" must not make "3 customers" look true
      cellNumbers(row[c], out);
    }
  }
  for (const m of question.matchAll(/\d+(?:\.\d+)?/g)) out.push(Number(m[0]));

  // Derived figures. Sums/averages/shares of a partial result would mislead, so only when complete.
  if (!facts.truncated) {
    for (const col of facts.measureColumns) {
      const vals = facts.rows.map((r) => Number(r[col])).filter(Number.isFinite);
      if (vals.length === 0) continue;
      const sum = vals.reduce((a, b) => a + b, 0);
      out.push(sum, sum / vals.length, Math.max(...vals), Math.min(...vals));
      if (sum !== 0) for (const v of vals) out.push((v / sum) * 100);
      if (vals.length <= 12) {
        for (let i = 0; i < vals.length; i++) {
          for (let j = 0; j < vals.length; j++) {
            if (i === j) continue;
            out.push(Math.abs(vals[i] - vals[j]));
            if (vals[j] !== 0) out.push(Math.abs((vals[i] - vals[j]) / vals[j]) * 100);
          }
        }
      }
    }
  }
  return out;
}

function matches(claim: Claim, allowed: number[]): boolean {
  return allowed.some((a) => {
    if (claim.approx) return Math.abs(a - claim.value) <= Math.abs(claim.value) * 0.06 + 1e-9;
    const tolerance = 0.5 * 10 ** -claim.decimals + 1e-9;
    return Math.abs(a - claim.value) < tolerance;
  });
}

const CLAIMS_EMPTY =
  /\b(no|zero)\s+(?:\w+\s+){0,2}(?:matching|matches|records?|results?|rows|data|entries|customers?|orders?|items?|products?)\b|\bnothing\s+(?:was\s+)?found\b|\bno\s+data\b|\bnone\s+(?:were|was)\s+found\b/i;
const CLAIMS_TOTAL = /\b(in total|altogether|overall|all told|in all|combined)\b|\btotal(?:s|ling)?\s+(?:of\s+)?\d/i;

export interface Verification {
  ok: boolean;
  problems: string[];
}

export function verifyAnswer(answer: string, facts: ResultFacts, question = ''): Verification {
  const problems: string[] = [];
  const text = answer.trim();
  if (!text) return { ok: false, problems: ['empty_answer'] };

  if (facts.isEmpty) {
    // nothing to describe; the deterministic sentence is the only honest answer
    if (extractNumericClaims(text).some((c) => !matches(c, allowedNumbers(facts, question)))) problems.push('numbers_with_no_data');
    return { ok: problems.length === 0, problems };
  }

  if (CLAIMS_EMPTY.test(text)) problems.push('claims_no_results_but_rows_exist');

  const allowed = allowedNumbers(facts, question);
  for (const claim of extractNumericClaims(text)) {
    if (!matches(claim, allowed)) problems.push(`unsupported_number:${claim.text}`);
  }

  // A single value must actually be stated.
  if (facts.rows.length === 1 && facts.columns.length === 1 && isNumeric(facts.rows[0][facts.columns[0]])) {
    const value = Number(facts.rows[0][facts.columns[0]]);
    const stated = extractNumericClaims(text).some((c) => matches(c, [value]));
    if (!stated) problems.push('single_value_not_stated');
  }

  // "The most expensive product is Phone" must name the row that really has the maximum.
  const wrong = superlativeMismatch(text, facts);
  if (wrong) problems.push(`superlative_mismatch:${wrong}`);

  // Do not present a partial result as complete.
  if (facts.truncated && facts.totalRows === null && CLAIMS_TOTAL.test(text)) {
    problems.push('total_claimed_for_partial_result');
  }

  return { ok: problems.length === 0, problems };
}

const HIGH_WORDS = /\b(highest|most|largest|biggest|greatest|maximum|max|top|best|leading|priciest|costliest)\b/i;
const LOW_WORDS = /\b(lowest|least|smallest|cheapest|minimum|min|worst|fewest|bottom|weakest)\b/i;

/**
 * Checks sentences that name ONE item as the highest/lowest. The item must be the row holding the
 * extreme value of some measure column. Sentences naming several items ("the top 3 are A, B, C")
 * are skipped, as are partial results (the true extreme may not be in the sample).
 * Returns the offending label, or null.
 */
export function superlativeMismatch(text: string, facts: ResultFacts): string | null {
  const { labelColumn, measureColumns, rows } = facts;
  if (!labelColumn || measureColumns.length === 0 || rows.length < 2 || facts.truncated) return null;

  const labels = [...new Set(rows.map((r) => r[labelColumn]).filter((v): v is string => typeof v === 'string' && v.trim().length >= 2))];
  if (labels.length < 2) return null;

  for (const sentence of text.split(/[.!?;\n]+/)) {
    const high = HIGH_WORDS.test(sentence);
    const low = LOW_WORDS.test(sentence);
    if (high === low) continue; // no superlative, or contradictory words: nothing to check

    const lower = sentence.toLowerCase();
    const named = labels.filter((l) => lower.includes(l.toLowerCase()));
    // a label that is a prefix of a longer named label ("Phone" in "Phone Pro") is not a second item
    const distinct = named.filter((l) => !named.some((o) => o !== l && o.toLowerCase().includes(l.toLowerCase())));
    if (distinct.length !== 1) continue;

    const label = distinct[0];
    const holdsExtreme = measureColumns.some((col) => {
      const values = rows.map((r) => Number(r[col])).filter(Number.isFinite);
      if (values.length < 2) return false;
      const target = high ? Math.max(...values) : Math.min(...values);
      return rows.some((r) => r[labelColumn] === label && Number(r[col]) === target);
    });
    if (!holdsExtreme) return label;
  }
  return null;
}
