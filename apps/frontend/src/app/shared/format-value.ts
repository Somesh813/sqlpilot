import { isIdLike, isYearOrPeriodLike } from '@sqlpilot/shared';

export type CellKind = 'null' | 'number' | 'text' | 'boolean' | 'date';

export interface FormattedCell {
  text: string;
  kind: CellKind;
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Formats one database value for display. Column-name agnostic: nothing here knows
 * about a particular schema. Numeric columns get grouping and at most 2 decimals,
 * except identifiers and calendar years, which must stay as written (2026, not 2,026).
 */
export function formatCell(value: unknown, column: string, numericColumns: ReadonlySet<string>): FormattedCell {
  if (value === null || value === undefined) return { text: 'NULL', kind: 'null' };
  if (typeof value === 'boolean') return { text: value ? 'true' : 'false', kind: 'boolean' };

  if (numericColumns.has(column) && !isIdLike(column) && !isYearOrPeriodLike(column)) {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return { text: n.toLocaleString(undefined, { maximumFractionDigits: 2 }), kind: 'number' };
    }
  }
  if (typeof value === 'number' || typeof value === 'bigint') return { text: String(value), kind: 'number' };

  if (typeof value === 'string') {
    if (ISO_DATETIME.test(value)) {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return { text: d.toLocaleString(), kind: 'date' };
    }
    return { text: value, kind: 'text' };
  }
  if (value instanceof Date) return { text: value.toLocaleString(), kind: 'date' };
  return { text: JSON.stringify(value), kind: 'text' };
}

/** `total_spending` → `Total Spending`. The raw name stays available as a tooltip. */
export function humanizeHeader(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
