import { z } from 'zod';
import { successEnvelopeSchema } from './schemas.js';
import { attachmentSchema, attachmentSelectionSchema } from './attachments.js';
import { extractionSourceRangeSchema } from './extraction.js';

const tokenCount = z.number().int().nonnegative();
export const assistantModelCapacitySchema = z.object({ contextWindowTokens: z.number().int().positive(), maxOutputTokens: z.number().int().positive().optional(), sourceUrl: z.string().url(), verifiedAt: z.string() });
export const assistantModelSchema = z.object({ id: z.string(), name: z.string(), reasoningEfforts: z.array(z.string()), recommended: z.boolean().optional(), capacity: assistantModelCapacitySchema.optional() });
export const assistantTokenCountsSchema = z.object({ inputTokens: tokenCount.optional(), outputTokens: tokenCount.optional(), totalTokens: tokenCount.optional(), cachedInputTokens: tokenCount.optional(), reasoningTokens: tokenCount.optional() });
export const assistantUsageStepSchema = assistantTokenCountsSchema.extend({ step: z.number().int().positive(), measuredAt: z.string(), status: z.enum(['reported', 'partial', 'unavailable']) });
export const assistantUsageSchema = z.object({ steps: z.array(assistantUsageStepSchema), latest: assistantUsageStepSchema.optional(), total: assistantTokenCountsSchema, status: z.enum(['complete', 'partial', 'unavailable']) });
export const assistantContextEstimateSchema = z.object({ inputTokens: tokenCount, method: z.literal('utf8-conservative-v1'), status: z.enum(['within-budget', 'over-budget', 'capacity-unknown']) });
export const assistantContextSchema = z.object({
  capacity: assistantModelCapacitySchema.optional(), outputReserveTokens: tokenCount, estimate: assistantContextEstimateSchema,
  history: z.object({ availableMessages: tokenCount, selectedMessages: tokenCount, omittedMessages: tokenCount, messageLimit: z.literal(24), conversationMessageLimit: z.literal(100), conversationMessages: tokenCount, remainingMessages: tokenCount, firstMessageId: z.string().optional(), lastMessageId: z.string().optional() })
});
export const assistantProviderSchema = z.object({ id: z.string(), name: z.string(), status: z.enum(['ready', 'unconfigured', 'unavailable']), models: z.array(assistantModelSchema), defaultModel: z.string().optional(), defaultEffort: z.string().optional(), problem: z.string().optional() });
// Offsets and lengths are UTF-16 code units in the original Markdown; lines are 1-based.
export const assistantEvidenceSchema = z.object({ excerpt: z.string(), revision: z.string(), offset: z.number().int().nonnegative(), length: z.number().int().nonnegative(), startLine: z.number().int().positive(), endLine: z.number().int().positive(), page: z.number().int().positive().optional() });
export const assistantSourceSchema = z.object({ id: z.string(), path: z.string(), title: z.string(), kind: z.enum(['search', 'read']).optional(), evidence: z.array(assistantEvidenceSchema).optional(), attachmentId: z.uuid().optional() });
export const assistantReviewActionSchema = z.object({
  id: z.string(), type: z.literal('review'), label: z.string(), runId: z.string(),
  materialPath: z.string().optional(), materialTitle: z.string().optional(), candidateCount: z.number().int().nonnegative().optional(),
  committedCount: z.number().int().nonnegative().optional(), discardedCount: z.number().int().nonnegative().optional(),
  status: z.enum(['ready', 'empty', 'partial', 'committed', 'writing', 'needs-review', 'discarded', 'unavailable']).optional(),
  sourceRange: extractionSourceRangeSchema.optional()
});
export const assistantArchiveActionSchema = z.object({
  id: z.string(), type: z.literal('archive'), label: z.string(), attachmentId: z.uuid(),
  materialPath: z.string(), materialTitle: z.string(), operationId: z.string(),
  status: z.literal('archived'), duplicate: z.boolean().optional(), indexed: z.boolean().optional()
});
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
export const assistantPlanActionSchema = z.strictObject({
  id: z.uuid(), type: z.literal('plan'), kind: z.literal('archive'), label: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'stale']),
  attachmentId: z.uuid(), sourceTitle: z.string().max(255), sourceSha256: sha256,
  targetPath: z.string().min(1).max(4096), mainName: z.string().min(1).max(255),
  summary: z.string().max(2000), createdAt: z.string(), expiresAt: z.string(),
  resultActionId: z.uuid().optional(), problem: z.string().optional()
});
export const assistantActionSchema = z.discriminatedUnion('type', [assistantReviewActionSchema, assistantArchiveActionSchema, assistantPlanActionSchema]);
export const assistantStepSchema = z.object({ id: z.string(), toolName: z.string(), label: z.string(), status: z.enum(['running', 'completed', 'failed', 'stopped']), startedAt: z.string(), finishedAt: z.string().optional() });
export const assistantMessageSchema = z.object({
  id: z.string(), role: z.enum(['user', 'assistant']), text: z.string(), sources: z.array(assistantSourceSchema), actions: z.array(assistantActionSchema), activity: z.string().optional(), model: z.string().optional(),
  scope: z.enum(['brain', 'current']).optional(), contextPath: z.string().optional(), contextTitle: z.string().optional(),
  startedAt: z.string().optional(), finishedAt: z.string().optional(), steps: z.array(assistantStepSchema).optional(),
  usage: assistantUsageSchema.optional(), context: assistantContextSchema.optional(),
  attachmentArchives: z.array(z.uuid()).max(8).optional(),
  attachments: z.array(attachmentSchema.extend({ startPage: z.number().int().positive().optional(), endPage: z.number().int().positive().optional() })).max(8).optional()
});
export const assistantConversationSchema = z.object({ id: z.string(), title: z.string(), createdAt: z.string(), updatedAt: z.string(), status: z.enum(['idle', 'running', 'failed', 'stopped']), providerId: z.string(), model: z.string(), effort: z.string().optional(), scope: z.enum(['brain', 'current']), contextPath: z.string().optional(), messages: z.array(assistantMessageSchema), problem: z.string().optional() });
export const assistantSendSchema = z.strictObject({ conversationId: z.uuid().optional(), clientRequestId: z.uuid(), message: z.string().trim().min(1).max(16000), providerId: z.string().min(1).max(80), model: z.string().min(1).max(160), effort: z.string().max(40).optional(), scope: z.enum(['brain', 'current']), contextPath: z.string().min(1).max(1024).optional(), attachments: z.array(attachmentSelectionSchema).max(8).refine(items => new Set(items.map(item => item.id)).size === items.length, '附件不可重复选择').optional() });
export const assistantIdSchema = z.strictObject({ id: z.uuid() });
export const assistantProvidersResponseSchema = successEnvelopeSchema(z.object({ providers: z.array(assistantProviderSchema) }));
export const assistantConversationResponseSchema = successEnvelopeSchema(assistantConversationSchema);
export const assistantHistoryQuerySchema = z.strictObject({ search: z.string().trim().max(200).optional(), cursor: z.string().min(1).max(4096).optional(), limit: z.coerce.number().int().min(1).max(100).default(100) });
export const assistantHistoryItemSchema = assistantConversationSchema.omit({ messages: true });
export const assistantHistoryPageSchema = z.object({ conversations: z.array(assistantHistoryItemSchema), hasMore: z.boolean().optional(), nextCursor: z.string().min(1).max(4096).optional() });
export const assistantHistoryResponseSchema = successEnvelopeSchema(assistantHistoryPageSchema);
export type AssistantHistoryQuery = { search?: string | undefined; cursor?: string | undefined; limit?: number | undefined };
export type AssistantHistoryPage = z.infer<typeof assistantHistoryPageSchema>;
export const assistantLoginResponseSchema = successEnvelopeSchema(z.object({ authUrl: z.string().url().optional(), message: z.string() }));
export type AssistantModel = z.infer<typeof assistantModelSchema>;
export type AssistantModelCapacity = z.infer<typeof assistantModelCapacitySchema>;
export type AssistantTokenCounts = z.infer<typeof assistantTokenCountsSchema>;
export type AssistantUsageStep = z.infer<typeof assistantUsageStepSchema>;
export type AssistantUsage = z.infer<typeof assistantUsageSchema>;
export type AssistantContextEstimate = z.infer<typeof assistantContextEstimateSchema>;
export type AssistantContext = z.infer<typeof assistantContextSchema>;
export type AssistantProvider = z.infer<typeof assistantProviderSchema>;
export type AssistantSource = z.infer<typeof assistantSourceSchema>;
export type AssistantEvidence = z.infer<typeof assistantEvidenceSchema>;
export type AssistantStep = z.infer<typeof assistantStepSchema>;
export type AssistantAction = z.infer<typeof assistantActionSchema>;
export type AssistantReviewAction = z.infer<typeof assistantReviewActionSchema>;
export type AssistantArchiveAction = z.infer<typeof assistantArchiveActionSchema>;
export type AssistantPlanAction = z.infer<typeof assistantPlanActionSchema>;
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;
export type AssistantConversation = z.infer<typeof assistantConversationSchema>;
export type AssistantSend = z.infer<typeof assistantSendSchema>;
