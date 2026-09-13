import { z } from 'zod';
import { successEnvelopeSchema } from './schemas.js';
import { knowledgeContentSchema } from './knowledge-content.js';

const materialPath = z.string().min(1).max(1024);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const text = (maximum: number) => z.string().trim().min(1).max(maximum);
export const extractionReadingStateSchema = z.enum(['未看', '已看']);
/** UTF-16 offsets in the entire original Markdown, including a possible BOM. */
export const extractionSourceRangeSchema = z.strictObject({
  offset: z.number().int().nonnegative(), length: z.number().int().positive(), label: text(1000),
  coversWholeSource: z.boolean().optional()
});
export const extractionPreviewRequestSchema = z.strictObject({ materialPath, readingState: extractionReadingStateSchema });
export const extractionTokenSchema = z.strictObject({ token: z.uuid() });
export const extractionIdSchema = z.strictObject({ id: z.uuid() });
export const extractionQuerySchema = z.strictObject({ materialPath: materialPath.optional() });
export const deepSeekKeyRequestSchema = z.strictObject({ apiKey: z.string().trim().min(1).max(512).regex(/^[\x21-\x7e]+$/u) });
export const extractionEmptyBodySchema = z.strictObject({});
export const deepSeekSettingsSchema = z.strictObject({
  available: z.boolean(), configured: z.boolean(), providerHost: z.literal('api.deepseek.com'),
  model: text(160), problem: text(1000).optional(),
  verification: z.strictObject({ status: z.enum(['verified', 'failed']), checkedAt: z.iso.datetime(), message: text(1000) }).optional()
});
export const extractionMessageSchema = z.strictObject({ role: z.enum(['system', 'user']), content: z.string().max(500_000) });
export const extractionPreviewSchema = z.strictObject({
  token: z.uuid(), materialPath, title: text(1000), readingState: extractionReadingStateSchema,
  sourceRawSha256: sha256, ruleFingerprint: sha256, model: text(160),
  providerHost: z.literal('api.deepseek.com'), messages: z.array(extractionMessageSchema).min(1).max(4), expiresAt: z.iso.datetime()
});
export const extractionCandidateSchema = z.strictObject({
    title: text(300), knowledgeType: z.enum(['概念', '原理', '模型', '方法', 'SOP', '标准', '案例', '数据', '观点', '素材']),
    suggestedPath: z.string().min(1).max(1024).refine((value) => value.startsWith('02知识库/') && !value.split('/').some((part) => !part || part === '.' || part === '..') && !/[\\\u0000-\u001f\u007f]/u.test(value)),
    topics: z.array(text(512)).max(20), coreContent: text(20_000), value: text(3000), draft: knowledgeContentSchema.optional()
});
export const extractionResultSchema = z.strictObject({
  briefing: z.strictObject({ sentences: z.array(text(3000)).min(3).max(6), keyPoints: z.array(text(3000)).max(20), usefulness: text(6000), caution: text(6000).optional() }),
  candidates: z.array(extractionCandidateSchema).max(12)
});
/** Saved v1 results remain readable; every newly generated candidate must be complete. */
export const extractionGenerationResultSchema = extractionResultSchema.extend({
  candidates: z.array(extractionCandidateSchema.extend({ draft: knowledgeContentSchema })).max(12)
});
export const extractionRunSchema = z.strictObject({
  id: z.uuid(), materialPath, title: text(1000), readingState: extractionReadingStateSchema,
  sourceRawSha256: sha256, ruleFingerprint: sha256, model: text(160),
  createdAt: z.iso.datetime(), status: z.enum(['generating', 'ready', 'failed', 'cancelled']),
  result: extractionResultSchema.optional(), problem: text(1000).optional(), sourceRange: extractionSourceRangeSchema.optional()
}).refine((run) => run.status === 'ready' ? run.result !== undefined : run.result === undefined);
export const extractionListSchema = z.strictObject({ items: z.array(extractionRunSchema).max(50) });
export const deepSeekSettingsResponseSchema = successEnvelopeSchema(deepSeekSettingsSchema);
export const extractionPreviewResponseSchema = successEnvelopeSchema(extractionPreviewSchema);
export const extractionRunResponseSchema = successEnvelopeSchema(extractionRunSchema);
export const extractionListResponseSchema = successEnvelopeSchema(extractionListSchema);
export type DeepSeekSettings = z.infer<typeof deepSeekSettingsSchema>;
export type ExtractionPreview = z.infer<typeof extractionPreviewSchema>;
export type ExtractionResult = z.infer<typeof extractionResultSchema>;
export type ExtractionRun = z.infer<typeof extractionRunSchema>;
export type ExtractionPreviewRequest = z.infer<typeof extractionPreviewRequestSchema>;
export type ExtractionSourceRange = z.infer<typeof extractionSourceRangeSchema>;
