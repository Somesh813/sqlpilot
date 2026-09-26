import { VisualizationType, type AskResponse } from '@sqlpilot/shared';

/** A complete AskResponse with sensible defaults; tests override only what they care about. */
export function askResponse(over: Partial<AskResponse> = {}): AskResponse {
  const rows = over.rows ?? [];
  const columns = over.columns ?? (rows[0] ? Object.keys(rows[0]) : []);
  return {
    success: true,
    question: 'a question',
    conversationId: 'conv-1',
    sql: 'SELECT 1',
    columns,
    columnTypes: {},
    rows,
    returnedRows: rows.length,
    totalRows: rows.length,
    truncated: false,
    executionTimeMs: 4,
    resultType: 'table',
    visualization: { recommended: false, type: null, xColumn: null, yColumns: [] },
    availableViews: [VisualizationType.TABLE],
    numericColumns: [],
    explanation: 'Here is the answer.',
    queryExplanation: 'How the query works.',
    assumptions: [],
    warnings: [],
    tablesUsed: [],
    confidence: 0.9,
    autoFixed: false,
    historyId: 'h1',
    error: null,
    ...over,
  };
}

export const rowsOf = (n: number): Array<Record<string, unknown>> =>
  Array.from({ length: n }, (_, i) => ({ name: `Customer ${i + 1}`, spend: (i + 1) * 100 }));
