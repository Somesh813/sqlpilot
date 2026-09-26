import { VisualizationType } from '@sqlpilot/shared';
import { z } from 'zod';

export const generatedSqlSchema = z.object({
  intent: z.string(),
  tablesUsed: z.array(z.string()),
  sql: z.string(),
  explanation: z.string(),
  assumptions: z.array(z.string()),
  confidence: z.number(),
  warnings: z.array(z.string()),
  unanswerable: z.boolean(),
  unanswerableReason: z.string().nullable(),
  visualization: z.object({
    recommended: z.boolean(),
    type: z.nativeEnum(VisualizationType),
    xField: z.string().nullable(),
    yField: z.string().nullable(),
  }),
});
export type GeneratedSqlModel = z.infer<typeof generatedSqlSchema>;

export const sqlExplanationSchema = z.object({
  summary: z.string(),
  tablesUsed: z.array(z.string()),
  joins: z.array(z.string()),
  filters: z.array(z.string()),
  aggregations: z.array(z.string()),
  sorting: z.array(z.string()),
  risks: z.array(z.string()),
  performanceNotes: z.array(z.string()),
});
export type SqlExplanationModel = z.infer<typeof sqlExplanationSchema>;

export const sqlOptimizationSchema = z.object({
  optimizedSql: z.string(),
  changes: z.array(z.string()),
  expectedBenefits: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type SqlOptimizationModel = z.infer<typeof sqlOptimizationSchema>;

export const sqlFixSchema = z.object({
  fixedSql: z.string(),
  diagnosis: z.string(),
  changes: z.array(z.string()),
  confidence: z.number(),
});
export type SqlFixModel = z.infer<typeof sqlFixSchema>;

export const resultAnswerSchema = z.object({
  answer: z.string(),
});
export type ResultAnswerModel = z.infer<typeof resultAnswerSchema>;

export const followUpSchema = z.object({
  followUp: z.boolean(),
});
export type FollowUpModel = z.infer<typeof followUpSchema>;
