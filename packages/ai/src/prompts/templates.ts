import { AiExplanationMode, SchemaContext } from '@sqlpilot/shared';
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

  for (const turn of params.history ?? []) {
    messages.push({ role: turn.role, content: turn.content });
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
  databaseError: string;
}): AiMessage[] {
  return [
    {
      role: 'system',
      content: [
        "You are SQLPilot's SQL repair assistant.",
        'You are given a failing SQL query and the exact database error it produced.',
        'Diagnose the root cause and return a corrected, read-only query that uses ONLY tables/columns from the provided schema.',
        'If the error indicates a missing column/table, find the correct name in the schema.',
        'Do not change the intent of the query.',
      ].join('\n'),
    },
    { role: 'system', content: `Schema:\n\n${renderSchemaContext(params.schema)}` },
    {
      role: 'user',
      content: `Failing SQL:\n\n${params.sql}\n\nDatabase error:\n${params.databaseError}`,
    },
  ];
}
