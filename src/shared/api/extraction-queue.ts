import { z } from 'zod';
import { materialQuerySchema, materialRecordSchema, successEnvelopeSchema } from './schemas.js';
import { extractionRunSchema } from './extraction.js';

export const extractionQueueViewSchema = z.enum(['pending', 'generating', 'ready', 'unfinished']);
export const extractionRunSummarySchema = z.strictObject({
  id: extractionRunSchema.shape.id,
  status: extractionRunSchema.shape.status,
  createdAt: extractionRunSchema.shape.createdAt,
  sourceRawSha256: extractionRunSchema.shape.sourceRawSha256,
  candidateCount: z.number().int().min(0).max(12).optional(),
  pendingCandidateCount: z.number().int().min(0).max(12).optional(),
  reviewComplete: z.boolean().optional(),
  currentSourceSha256: extractionRunSchema.shape.sourceRawSha256.optional(),
  problem: extractionRunSchema.shape.problem
}).refine((run) => run.status === 'ready' ? run.candidateCount !== undefined : run.candidateCount === undefined);
export const extractionQueueItemSchema = z.strictObject({
  materialPath: extractionRunSchema.shape.materialPath,
  title: extractionRunSchema.shape.title,
  view: extractionQueueViewSchema,
  sourcePlatform: materialRecordSchema.shape.sourcePlatform.optional(),
  collectedAt: materialRecordSchema.shape.collectedAt,
  sourceRawSha256: extractionRunSchema.shape.sourceRawSha256.optional(),
  canExtract: z.boolean(),
  removedAt: z.iso.datetime().optional(),
  pendingCandidateCount: z.number().int().nonnegative().optional(),
  reviewComplete: z.boolean().optional(),
  latestRun: extractionRunSummarySchema.optional(),
  activeRun: extractionRunSummarySchema.optional(),
  latestReadyRun: extractionRunSummarySchema.optional()
});
export const extractionQueueQuerySchema = z.strictObject({
  view: extractionQueueViewSchema.default('pending'),
  visibility: z.enum(['active', 'removed']).default('active'),
  reviewState: z.enum(['pending', 'complete']).optional(),
  title: materialQuerySchema.shape.title,
  sourcePlatform: materialQuerySchema.shape.sourcePlatform,
  collectedFrom: materialQuerySchema.shape.collectedFrom,
  collectedTo: materialQuerySchema.shape.collectedTo,
  cursor: materialQuerySchema.shape.cursor,
  limit: z.coerce.number<number>().int().min(1).max(200).optional()
}).superRefine((query, context) => {
  if (query.collectedFrom !== undefined && query.collectedTo !== undefined && query.collectedFrom > query.collectedTo) {
    context.addIssue({ code: 'custom', path: ['collectedTo'], message: 'collectedTo must not precede collectedFrom' });
  }
});
export const extractionHistoryQuerySchema = z.strictObject({
  materialPath: extractionRunSchema.shape.materialPath,
  cursor: materialQuerySchema.shape.cursor,
  limit: z.coerce.number<number>().int().min(1).max(200).optional()
});
export const extractionQueueSourceQuerySchema = z.strictObject({ materialPath: extractionRunSchema.shape.materialPath });
export const extractionQueueVisibilityRequestSchema = z.strictObject({ materialPath: extractionRunSchema.shape.materialPath, removed: z.boolean() });
export const extractionQueueSourceSchema = z.strictObject({ item: extractionQueueItemSchema.nullable() });
export const extractionQueueSourceResponseSchema = successEnvelopeSchema(extractionQueueSourceSchema);
export const extractionQueuePageSchema = z.strictObject({
  items: z.array(extractionQueueItemSchema).max(200),
  counts: z.strictObject({ pending: z.number().int().nonnegative(), generating: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(), unfinished: z.number().int().nonnegative() }),
  nextCursor: materialQuerySchema.shape.cursor
});
export const extractionHistoryPageSchema = z.strictObject({
  items: z.array(extractionRunSummarySchema).max(200),
  nextCursor: materialQuerySchema.shape.cursor
});
export const extractionQueueResponseSchema = successEnvelopeSchema(extractionQueuePageSchema);
export const extractionHistoryResponseSchema = successEnvelopeSchema(extractionHistoryPageSchema);
export type ExtractionQueueView = z.output<typeof extractionQueueViewSchema>;
export type ExtractionRunSummary = z.output<typeof extractionRunSummarySchema>;
export type ExtractionQueueItem = z.output<typeof extractionQueueItemSchema>;
export type ExtractionQueueQuery = z.input<typeof extractionQueueQuerySchema>;
export type ExtractionQueuePage = z.output<typeof extractionQueuePageSchema>;
export type ExtractionQueueSource = z.output<typeof extractionQueueSourceSchema>;
export type ExtractionHistoryQuery = z.input<typeof extractionHistoryQuerySchema>;
export type ExtractionHistoryPage = z.output<typeof extractionHistoryPageSchema>;
