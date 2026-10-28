import { z } from 'zod';
import { successEnvelopeSchema } from './schemas.js';

export const workdiskSearchRequestSchema = z.strictObject({
  query: z.string().trim().min(1).max(1000),
  today: z.iso.date()
});
export const workdiskSearchPlanSchema = z.strictObject({
  terms: z.array(z.string().trim().min(1).max(100)).max(12),
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
  kind: z.enum(['video', 'audio', 'image', 'document', 'other']).optional()
}).refine(plan => (!plan.startDate && !plan.endDate) || (!!plan.startDate && !!plan.endDate && plan.startDate <= plan.endDate), '日期范围不完整或顺序错误。');
export const workdiskSearchDataSchema = z.strictObject({
  mode: z.enum(['ai', 'local']),
  plan: workdiskSearchPlanSchema,
  message: z.string().max(300).optional()
});
export const workdiskSearchResponseSchema = successEnvelopeSchema(workdiskSearchDataSchema);
export type WorkdiskSearchRequest = z.infer<typeof workdiskSearchRequestSchema>;
export type WorkdiskSearchResponse = z.infer<typeof workdiskSearchDataSchema>;
export type WorkdiskSearchPlan = z.infer<typeof workdiskSearchPlanSchema>;
