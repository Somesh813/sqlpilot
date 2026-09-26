import { VisualizationType } from './enums';
import { isNumeric } from './utils';

/** Shape of the data, independent of how it will be drawn. */
export type ResultType =
  | 'empty'
  | 'single_value'
  | 'table'
  | 'categorical'
  | 'time_series'
  | 'multi_series'
  | 'percentage_distribution'
  | 'correlation';

export interface VisualizationPlan {
  recommended: boolean;
  type: VisualizationType | null;
  xColumn: string | null;
  yColumns: string[];
}

export interface ResultAnalysis {
  resultType: ResultType;
  visualization: VisualizationPlan;
  /** Views that make sense for this data. Always includes TABLE; KPI only for single values. */
  availableViews: VisualizationType[];
  /** Columns whose every non-null value is numeric — used for right-aligned, formatted display. */
  numericColumns: string[];
}

export interface AnalysisHint {
  type?: VisualizationType | null;
  xField?: string | null;
  yField?: string | null;
}

const MAX_CATEGORIES_FOR_BAR = 30;
const MAX_CATEGORIES_FOR_PIE = 10;
const MAX_TIME_POINTS = 500;
const MAX_SERIES = 4;

const TIME_NAME = /(date|time|month|year|day|week|quarter|period|hour)/i;
const ISO_DATE = /^\d{4}-\d{2}(-\d{2})?([T ]\d{2}:\d{2}(:\d{2})?)?/;
const MONTH_NAMES = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

/** `id`, `customer_id`, `ID` … — numbers that identify rows rather than measure something. */
export function isIdLike(name: string): boolean {
  return /(^id$|_id$|^id_|Id$|^uuid$|^guid$|_key$)/.test(name);
}

/** A numeric column that is a calendar unit (2026, 3) rather than a measure. */
export function isYearOrPeriodLike(name: string): boolean {
  return /^(year|yr|month|month_num|month_number|quarter|week|day|hour)$/i.test(name);
}

function isDateValue(v: unknown): boolean {
  if (v instanceof Date) return true;
  return typeof v === 'string' && (ISO_DATE.test(v) || MONTH_NAMES.test(v));
}

/**
 * Decides what a result set is and how (or whether) to draw it. Deterministic on
 * purpose: the model's opinion is only a hint, and a chart is never recommended
 * for data that would make it meaningless (a single value, free text, IDs only).
 */
export function analyzeResult(
  columnNames: string[],
  rows: Array<Record<string, unknown>>,
  hint?: AnalysisHint,
): ResultAnalysis {
  const tableOnly = (resultType: ResultType, numericColumns: string[] = []): ResultAnalysis => ({
    resultType,
    visualization: { recommended: false, type: null, xColumn: null, yColumns: [] },
    availableViews: [VisualizationType.TABLE],
    numericColumns,
  });

  if (rows.length === 0 || columnNames.length === 0) return tableOnly('empty');

  const nonNull = (c: string) => rows.map((r) => r[c]).filter((v) => v !== null && v !== undefined && v !== '');
  const numericColumns = columnNames.filter((c) => {
    const values = nonNull(c);
    return values.length > 0 && values.every(isNumeric) && !values.every((v) => typeof v === 'boolean');
  });

  // ---- single value / single row of numbers → KPI ----
  const allNumeric = numericColumns.length === columnNames.length;
  if (rows.length === 1 && (columnNames.length === 1 || allNumeric)) {
    return {
      resultType: 'single_value',
      visualization: { recommended: true, type: VisualizationType.KPI, xColumn: null, yColumns: columnNames },
      availableViews: [VisualizationType.KPI, VisualizationType.TABLE],
      numericColumns,
    };
  }
  if (rows.length === 1) return tableOnly('table', numericColumns);

  // ---- split into measures and dimensions ----
  const measures = numericColumns.filter((c) => !isIdLike(c) && !isYearOrPeriodLike(c));
  const dimensions = columnNames.filter((c) => !measures.includes(c));
  if (measures.length === 0) return tableOnly('table', numericColumns);

  // ---- correlation: only numbers, no label column ----
  if (dimensions.length === 0) {
    if (measures.length >= 2 && rows.length >= 5) {
      return {
        resultType: 'correlation',
        visualization: {
          recommended: true,
          type: VisualizationType.SCATTER,
          xColumn: measures[0],
          yColumns: [measures[1]],
        },
        availableViews: [VisualizationType.SCATTER, VisualizationType.TABLE],
        numericColumns,
      };
    }
    return tableOnly('table', numericColumns);
  }

  // ---- pick the x axis: a time column beats a category ----
  const timeColumn = dimensions.find((c) => {
    const values = nonNull(c);
    return (
      (TIME_NAME.test(c) && (isYearOrPeriodLike(c) || values.every((v) => isDateValue(v) || isNumeric(v)))) ||
      (values.length > 0 && values.every(isDateValue))
    );
  });
  const xColumn =
    (hint?.xField && dimensions.includes(hint.xField) ? hint.xField : undefined) ?? timeColumn ?? dimensions[0];

  const labels = nonNull(xColumn).map((v) => String(v));
  const distinct = new Set(labels).size;
  const avgLength = labels.reduce((sum, l) => sum + l.length, 0) / Math.max(labels.length, 1);
  const isTime = xColumn === timeColumn;

  // free text, or far too many categories to read → table
  if (!isTime && (avgLength > 40 || distinct > MAX_CATEGORIES_FOR_BAR)) return tableOnly('table', numericColumns);
  if (isTime && rows.length > MAX_TIME_POINTS) return tableOnly('table', numericColumns);
  if (distinct < 2) return tableOnly('table', numericColumns);

  const yColumns = measures.slice(0, MAX_SERIES);
  const views: VisualizationType[] = [];
  const nonNegative = yColumns.length === 1 && nonNull(yColumns[0]).every((v) => Number(v) >= 0);
  const pieOk = !isTime && nonNegative && distinct <= MAX_CATEGORIES_FOR_PIE && rows.length >= 2;

  let type: VisualizationType;
  let resultType: ResultType;
  if (isTime) {
    resultType = yColumns.length > 1 ? 'multi_series' : 'time_series';
    type = VisualizationType.LINE;
    views.push(VisualizationType.LINE, VisualizationType.AREA, VisualizationType.BAR);
  } else {
    resultType = yColumns.length > 1 ? 'multi_series' : pieOk && hint?.type === VisualizationType.PIE ? 'percentage_distribution' : 'categorical';
    type = VisualizationType.BAR;
    views.push(VisualizationType.BAR);
    if (pieOk) views.push(VisualizationType.PIE);
  }
  views.push(VisualizationType.TABLE);

  // The model may refine the choice, but only among views that are actually valid.
  if (hint?.type && views.includes(hint.type) && hint.type !== VisualizationType.TABLE) type = hint.type;

  // Two bars are not worth a chart by default; the option is still offered.
  const recommended = rows.length >= 3;
  return {
    resultType,
    visualization: { recommended, type: recommended ? type : null, xColumn, yColumns },
    availableViews: views,
    numericColumns,
  };
}
