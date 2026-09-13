import { z } from 'zod';
import { successEnvelopeSchema } from './schemas.js';
import { knowledgeContentDraftSchema } from './knowledge-content.js';

const path = z.string().min(1).max(1024);
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
export const candidateDraftSchema = z.strictObject({
  title: z.string().max(300), knowledgeType: z.enum(['概念', '原理', '模型', '方法', 'SOP', '标准', '案例', '数据', '观点', '素材']),
  suggestedPath: z.string().max(1024), topics: z.array(z.string().max(512)).max(20),
  coreContent: z.string().max(20_000), value: z.string().max(3000), draft: knowledgeContentDraftSchema
});
export const candidateTargetSchema = z.strictObject({ mode: z.enum(['new', 'merge', 'reference']), path: path.optional(), confirmLegacySources: z.boolean().optional() });
export const reviewCandidateSchema = z.strictObject({
  id: z.string().max(64), version: z.number().int().positive(), state: z.enum(['pending', 'discarded', 'committed']),
  decision: z.enum(['later', 'keep', 'discard']), draft: candidateDraftSchema, target: candidateTargetSchema,
  committedPath: path.optional(), batchId: z.uuid().optional()
});
export const ingestionFileSchema = z.strictObject({
  path, kind: z.enum(['new', 'update', 'source']), before: z.string().max(500_000).nullable(), after: z.string().max(500_000), preserved: z.string().max(500_000).optional()
});
export const ingestionBatchSchema = z.strictObject({
  id: z.uuid(), runId: z.uuid(), status: z.enum(['writing', 'committed', 'needs-review']), indexed: z.boolean(),
  createdAt: z.iso.datetime(), knowledgePaths: z.array(path).max(12), pendingCount: z.number().int().nonnegative(),
  sourceStatus: z.enum(['未提炼', '部分入库', '已入库']), problem: z.string().max(1000).optional()
});
export const ingestionReviewSchema = z.strictObject({
  runId: z.uuid(), materialPath: path, title: z.string().max(1000), candidates: z.array(reviewCandidateSchema).max(12),
  directories: z.array(path).max(1000), sourceStatus: z.enum(['未提炼', '部分入库', '已入库']),
  sourceCurrentSha: sha.optional(), sourceChanged: z.boolean(), complete: z.boolean(),
  relatedRuns: z.array(z.strictObject({ id: z.uuid(), createdAt: z.iso.datetime(), pendingCount: z.number().int().nonnegative() })).max(200),
  batches: z.array(ingestionBatchSchema).max(200)
});
export const saveCandidateRequestSchema = z.strictObject({
  candidateId: z.string().min(1).max(64), version: z.number().int().positive(), draft: candidateDraftSchema,
  target: candidateTargetSchema, decision: z.enum(['later', 'keep', 'discard'])
});
export const ingestionPreviewRequestSchema = z.strictObject({
  runId: z.uuid(), versions: z.array(z.strictObject({ id: z.string().min(1).max(64), version: z.number().int().positive() })).max(12),
  acknowledgedSourceSha: sha.optional()
});
export const ingestionPreviewSchema = z.strictObject({
  id: z.uuid(), runId: z.uuid(), expiresAt: z.iso.datetime(), files: z.array(ingestionFileSchema).max(13),
  selectedCount: z.number().int().nonnegative(), discardedCount: z.number().int().nonnegative(), pendingCount: z.number().int().nonnegative(),
  sourceStatus: z.enum(['未提炼', '部分入库', '已入库'])
});
export const ingestionMatchQuerySchema = z.strictObject({ candidateId: z.string().min(1).max(64), search: z.string().max(200).optional() });
export const ingestionMatchesSchema = z.strictObject({
  items: z.array(z.strictObject({ path, title: z.string().max(1000), usageStatus: z.enum(['AI总结', '已优化', '定论', '过时']),
    conclusion: z.string().max(6000), reason: z.string().max(500) })).max(50)
});
export const ingestionRecoveryRequestSchema = z.strictObject({ sourceChoice: z.enum(['current', 'preserved']).optional(), newTargets: z.record(path, path).refine((value) => Object.keys(value).length <= 12).optional() });
export const ingestionRecoveryPreviewSchema = z.strictObject({ id: z.uuid(), batchId: z.uuid(), expiresAt: z.iso.datetime(), files: z.array(ingestionFileSchema).max(25), sourceChoice: z.enum(['current', 'preserved']), hasPreservedSource: z.boolean() });
export const ingestionIdRequestSchema = z.strictObject({ id: z.uuid() });
export const ingestionReviewResponseSchema = successEnvelopeSchema(ingestionReviewSchema);
export const reviewCandidateResponseSchema = successEnvelopeSchema(reviewCandidateSchema);
export const ingestionMatchesResponseSchema = successEnvelopeSchema(ingestionMatchesSchema);
export const ingestionPreviewResponseSchema = successEnvelopeSchema(ingestionPreviewSchema);
export const ingestionBatchResponseSchema = successEnvelopeSchema(ingestionBatchSchema);
export const ingestionRecoveryPreviewResponseSchema = successEnvelopeSchema(ingestionRecoveryPreviewSchema);
export type CandidateDraft = z.infer<typeof candidateDraftSchema>;
export type CandidateTarget = z.infer<typeof candidateTargetSchema>;
export type ReviewCandidate = z.infer<typeof reviewCandidateSchema>;
export type IngestionReview = z.infer<typeof ingestionReviewSchema>;
export type SaveCandidateRequest = z.infer<typeof saveCandidateRequestSchema>;
export type IngestionPreviewRequest = z.infer<typeof ingestionPreviewRequestSchema>;
export type IngestionPreview = z.infer<typeof ingestionPreviewSchema>;
export type IngestionBatch = z.infer<typeof ingestionBatchSchema>;
export type IngestionMatches = z.infer<typeof ingestionMatchesSchema>;
export type IngestionFile = z.infer<typeof ingestionFileSchema>;
export type IngestionRecoveryPreview = z.infer<typeof ingestionRecoveryPreviewSchema>;
