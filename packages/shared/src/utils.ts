import { QueryResultColumn, VisualizationRecommendation } from './contracts';
import { VisualizationType } from './enums';

/** Naive but dependency-free heuristic for recommending a chart from a result set. */
export function recommendVisualization(
  columns: QueryResultColumn[],
  rows: Array<Record<string, unknown>>,
): VisualizationRecommendation {
  const fallback: VisualizationRecommendation = {
    type: VisualizationType.TABLE,
    reason: 'Result shape does not map cleanly to a chart.',
    xField: null,
    yField: null,
    seriesField: null,
  };

  if (rows.length === 0 || columns.length === 0) return fallback;

  const numericCols = columns.filter((c) => rows.every((r) => isNumeric(r[c.name])));
  const nonNumericCols = columns.filter((c) => !numericCols.includes(c));

  if (columns.length === 1 && numericCols.length === 1 && rows.length === 1) {
    return {
      type: VisualizationType.KPI,
      reason: 'Single numeric value.',
      xField: null,
      yField: columns[0].name,
      seriesField: null,
    };
  }

  if (nonNumericCols.length >= 1 && numericCols.length >= 1) {
    const x = nonNumericCols[0].name;
    const y = numericCols[0].name;
    const timeLike = /date|time|month|year|day|week|quarter/i.test(x);
    if (timeLike) {
      return { type: VisualizationType.LINE, reason: 'Time-like category with a numeric measure.', xField: x, yField: y, seriesField: null };
    }
    if (rows.length <= 8) {
      return { type: VisualizationType.PIE, reason: 'Few categories with one measure.', xField: x, yField: y, seriesField: null };
    }
    return { type: VisualizationType.BAR, reason: 'Categorical breakdown of a numeric measure.', xField: x, yField: y, seriesField: null };
  }

  if (numericCols.length >= 2) {
    return {
      type: VisualizationType.SCATTER,
      reason: 'Two or more numeric dimensions.',
      xField: numericCols[0].name,
      yField: numericCols[1].name,
      seriesField: null,
    };
  }

  return fallback;
}

export function isNumeric(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'bigint') return true;
  if (typeof value === 'string') return value.trim() !== '' && !Number.isNaN(Number(value));
  return false;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Redact obvious secrets from a string before logging. */
export function redactSecrets(input: string): string {
  return input
    .replace(/(password|pwd|secret|token|apikey|api_key)\s*[:=]\s*[^\s;,&]+/gi, '$1=***')
    .replace(/:\/\/([^:@/]+):([^@/]+)@/g, '://$1:***@');
}

export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const escape = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map(escape).join(',');
  const body = rows.map((r) => columns.map((c) => escape(r[c])).join(',')).join('\n');
  return `${header}\n${body}`;
}
