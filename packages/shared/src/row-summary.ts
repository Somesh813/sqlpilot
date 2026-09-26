/**
 * The one place that words "how many rows are you looking at". Results are never truncated
 * silently: whenever the database had more rows than were returned, the user is told.
 */

const fmt = (n: number) => n.toLocaleString('en-US');
const plural = (n: number) => (n === 1 ? 'row' : 'rows');

export interface RowSummary {
  /** Short text for a footer/caption, always accurate for the numbers given. */
  text: string;
  /** True when the result is incomplete and the UI should draw attention to it. */
  incomplete: boolean;
}

export function summarizeRows(returnedRows: number, totalRows: number | null, truncated: boolean): RowSummary {
  if (!truncated) {
    return { text: `${fmt(returnedRows)} ${plural(returnedRows)}`, incomplete: false };
  }
  if (totalRows !== null && totalRows >= returnedRows) {
    return { text: `Showing ${fmt(returnedRows)} of ${fmt(totalRows)} rows.`, incomplete: true };
  }
  return { text: `Showing the first ${fmt(returnedRows)} rows. More results are available.`, incomplete: true };
}
