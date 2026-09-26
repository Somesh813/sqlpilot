import { AiExplanationMode, describeOmissions, LlmResultView, SchemaContext } from '@sqlpilot/shared';
import { AiMessage } from '../provider';
import { renderSchemaContext } from './schema-context';

const GUARDRAILS = [
  'You are SQLPilot, an expert SQL assistant.',
  'You must ONLY use tables and columns that appear in the provided schema.',
  'NEVER invent table names, column names, or relationships.',
  'If the schema does not contain the data required to answer, set "unanswerable" to true and explain why in "unanswerableReason"; leave "sql" as an empty string.',
  'Generate a SINGLE read-only SELECT statement. Never generate INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, GRANT, or REVOKE.',
  'Never use multiple statements separated by semicolons.',
  'Prefer explicit JOINs using the documented relationships. Prefer explicit column lists over SELECT *.',
  'Use parameter-free literals the user supplied; do not fabricate specific IDs.',
  'Keep "confidence" between 0 and 1 and be honest about uncertainty.',
  'Earlier turns may contain previous questions and the SQL you wrote for them. Decide first: is the NEW message a follow-up, or a fresh question?',
  'It is a FOLLOW-UP only if it cannot be understood on its own — it refers back ("only for 2026", "now the top 5", "and by city?", "sort that by date", "what about Delhi?"). Then MODIFY the previous SQL to apply it and keep earlier filters unless the user removes them.',
  'It is a FRESH QUESTION if it is self-contained and names its own subject ("Show sales by month", "How many employees are there?"), even if it follows an unrelated earlier question. Then IGNORE the earlier turns entirely and NEVER try to combine it with them.',
  'Select ONLY the columns needed to answer the question actually asked. Never carry columns, metrics or filters over from an earlier question unless the new message is a follow-up that asks for them.',
  'Give every selected expression a short, readable snake_case alias (e.g. total_customers, total_spending) — the aliases become the column headings the user sees.',
  'For charts: set visualization.type to bar for categories, line for time, pie only for shares of a whole with few categories, kpi for one number, table when the rows are text-heavy.',
].join('\n');

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export function buildSqlGenerationMessages(params: {
  schema: SchemaContext;
  question: string;
  history?: ConversationTurn[];
}): AiMessage[] {
  const messages: AiMessage[] = [
    { role: 'system', content: GUARDRAILS },
    {
      role: 'system',
      content: `Relevant database schema:\n\n${renderSchemaContext(params.schema)}`,
    },
  ];

  // Only the LAST exchange is offered, as labeled reference — never the whole chat. Feeding
  // several earlier requests as live turns made the model try to answer all of them at once
  // (UNIONing unrelated results); one clearly-labeled previous query is enough to refine.
  const previous = (params.history ?? []).slice(-2);
  if (previous.length > 0) {
    messages.push({
      role: 'system',
      content: [
        'PREVIOUS EXCHANGE — reference only. Use it ONLY if the new message is a follow-up that refers back to it',
        '("only for 2026", "now the top 5", "and by city?"). If the new message is a self-contained question, IGNORE this completely.',
        ...previous.map((t) => `${t.role === 'user' ? 'User asked' : 'You wrote'}: ${t.content}`),
      ].join('\n'),
    });
  }

  messages.push({
    role: 'user',
    content: `Question: ${params.question}\n\nReturn a JSON object describing the intent, the tables used, the SQL, an explanation, assumptions, confidence, warnings, whether it is answerable, and a visualization recommendation.`,
  });
  return messages;
}

export function buildSqlExplanationMessages(params: {
  schema: SchemaContext;
  sql: string;
  mode: AiExplanationMode;
}): AiMessage[] {
  const audience =
    params.mode === AiExplanationMode.SIMPLE
      ? 'Explain in plain language for a non-technical stakeholder. Avoid jargon.'
      : 'Explain for an experienced engineer. Reference join strategies, index usage, and cardinality where relevant.';
  return [
    {
      role: 'system',
      content: `You are SQLPilot's SQL explainer. ${audience} Only reference tables/columns from the provided schema. Return the requested JSON structure. Do not claim guaranteed performance characteristics.`,
    },
    { role: 'system', content: `Schema:\n\n${renderSchemaContext(params.schema)}` },
    { role: 'user', content: `Explain this SQL:\n\n${params.sql}` },
  ];
}

export function buildSqlOptimizationMessages(params: { schema: SchemaContext; sql: string }): AiMessage[] {
  return [
    {
      role: 'system',
      content: [
        "You are SQLPilot's SQL optimizer.",
        'Analyze for: missing indexes, expensive joins, SELECT *, unnecessary subqueries, repeated calculations, poor filtering, redundant sorting, and heavy aggregation.',
        'Return an optimized query that is SEMANTICALLY EQUIVALENT to the original and still read-only.',
        'List concrete changes and expected benefits.',
        'NEVER promise guaranteed performance improvements — benefits are expectations, not guarantees.',
        'Only use tables/columns from the provided schema.',
      ].join('\n'),
    },
    { role: 'system', content: `Schema:\n\n${renderSchemaContext(params.schema)}` },
    { role: 'user', content: `Optimize this SQL:\n\n${params.sql}` },
  ];
}

export function buildSqlFixMessages(params: {
  schema: SchemaContext;
  sql: string;
  /** The exact error the database returned. */
  databaseError?: string;
  /**
   * Structured problems found BEFORE running the query: names that do not exist in the schema,
   * with close matches and where a column actually lives.
   */
  schemaProblems?: string;
}): AiMessage[] {
  const problem = params.schemaProblems
    ? `The query was NOT run. It refers to names that do not exist in the schema:\n${params.schemaProblems}`
    : `Database error:\n${params.databaseError ?? '(none)'}`;
  return [
    {
      role: 'system',
      content: [
        "You are SQLPilot's SQL repair assistant.",
        'You are given a failing SQL query and what is wrong with it.',
        'Diagnose the root cause and return a corrected, read-only query that uses O\nY tables/columns from the provided schema.',
        'If a table or column is missing, find the correct name in the schema. If a column belongs to a table the query does not join, add the JOIN (follow the documented relationships, including intermediate tables).',
        'Do not change the intent of the query. Never invent names that are not in the schema.',
      ].join('\n'),
    },
    { role: 'system', content: `Schema:\n\n${renderSchemaContext(params.schema)}` },
    { role: 'user', content: `Failing SQL:\n\n${params.sql}\n\n${problem}` },
  ];
}

export function buildResultSummaryMessages(params: {
  question: string;
  /**
   * The ONLY result data the model sees: a small, scrubbed view (see minimizeResultForLlm).
   * Passing raw rows here is a type error on purpose.
   */
  view: LlmResultView;
  /** Rows actually returned by the database. */
  returnedRows: number;
  /** Exact total when known. */
  totalRows: number | null;
  /** The database had more rows than were returned. */
  truncated: boolean;
}): AiMessage[] {
  const { view } = params;
  const scope = params.truncated
    ? params.totalRows !== null
      ? `PARTIAL result: ${params.returnedRows} of ${params.totalRows} rows. Do not describe totals, sums or averages as if they covered all ${params.totalRows} rows.`
      : `PARTIAL result: the first ${params.returnedRows} rows; more exist. Do not call anything a total, and do not sum or average across the rows.`
    : `COMPLETE result: exactly ${params.returnedRows} ${params.returnedRows === 1 ? 'row' : 'rows'}.`;
  const omitted = describeOmissions(view);
  return [
    {
      role: 'system',
      content: [
        "You are SQLPilot. Answer the user's question in 1-3 short, plain sentences, using ONLY the data provided.",
        'The user is not technical: never mention SQL, tables, columns, queries, or joins.',
        'Use thousands separators for large numbers. Write money without inventing a currency symbol.',
        'For a single value, state it directly (e.g. "There are 1,250 customers."). For lists, name the top items and the overall picture.',
        'If no rows were returned, say no matching records were found.',
        'Never invent or estimate values that are not in the data. Every number you write must appear in the data or be a simple count, difference or percentage of it.',
        'The result scope line is authoritative. If rows are present, never say no records were found.',
        'Values shown as [hidden] or [redacted] are private. Never try to guess or reconstruct them.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `Question: ${params.question}\n\nColumns: ${view.columns.join(', ')}\nResult scope: ${scope}\n${omitted ? `${omitted}\n` : ''}Rows shown to you (${view.rows.length}, JSON):\n${JSON.stringify(view.rows)}`,
    },
  ];
}

/** Cheap yes/no: does the new message depend on the previous question, or stand alone? */
export function buildFollowUpCheckMessages(params: { previousQuestion: string; question: string }): AiMessage[] {
  return [
    {
      role: 'system',
      content: [
        'Decide whether the NEW message can be understood on its own.',
        'followUp = true ONLY if it depends on the previous question: it refers back (it/that/those/them), or modifies it ("only for 2026", "now the top 5", "and by city?", "also show email", "sort that by date", "what about Delhi?"), or omits its own subject.',
        'followUp = false if it is a self-contained question that names its own subject ("Show sales by month", "How many employees are there?", "Show customers from Mumbai"), even when the topic is related to the previous question.',
        'When unsure, answer false.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `Previous question: ${params.previousQuestion}\nNew message: ${params.question}`,
    },
  ];
}
