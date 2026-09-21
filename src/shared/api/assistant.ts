import { z } from 'zod';
import { successEnvelopeSchema } from './schemas.js';
import { attachmentSchema, attachmentSelectionSchema } from './attachments.js';
import { extractionSourceRangeSchema } from './extraction.js';
import { projectWriteActionSchema } from './projects.js';

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
const assistantSkillIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const assistantSkillRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const assistantSkillUseSchema = z.strictObject({
  id: assistantSkillIdSchema,
  name: z.string().min(1).max(256),
  revision: assistantSkillRevisionSchema,
  folderName: z.string().min(1).max(255).nullable()
});
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
  resultActionId: z.string().min(1).max(255).optional(), problem: z.string().max(2000).optional()
});
export const assistantActionSchema = z.discriminatedUnion('type', [assistantReviewActionSchema, assistantArchiveActionSchema, assistantPlanActionSchema, projectWriteActionSchema]);
export const assistantStepSchema = z.object({ id: z.string(), toolName: z.string(), label: z.string(), status: z.enum(['running', 'completed', 'failed', 'stopped']), startedAt: z.string(), finishedAt: z.string().optional() });
const assistantScopeSchema = z.enum(['brain', 'current', 'project']);
const projectRevisionSchema = z.number().int().nonnegative();
function validateProjectScope(value: { scope?: ('brain' | 'current' | 'project') | undefined; projectId?: string | undefined; projectRevision?: number | undefined; contextPath?: string | undefined }, context: z.RefinementCtx): void {
  if (value.scope === 'project') {
    if (value.projectId === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['projectId'], message: 'project scope requires projectId' });
    if (value.projectRevision === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['projectRevision'], message: 'project scope requires projectRevision' });
    if (value.contextPath !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['contextPath'], message: 'project scope cannot include contextPath' });
  } else if (value.projectId !== undefined || value.projectRevision !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['projectId'], message: 'project fields require project scope' });
  }
}
const assistantMessageFieldsSchema = z.object({
  id: z.string(), role: z.enum(['user', 'assistant']), text: z.string(), sources: z.array(assistantSourceSchema), actions: z.array(assistantActionSchema), activity: z.string().optional(), model: z.string().optional(),
  scope: assistantScopeSchema.optional(), contextPath: z.string().optional(), contextTitle: z.string().optional(), projectId: z.uuid().optional(), projectRevision: projectRevisionSchema.optional(),
  startedAt: z.string().optional(), finishedAt: z.string().optional(), steps: z.array(assistantStepSchema).optional(),
  usage: assistantUsageSchema.optional(), context: assistantContextSchema.optional(),
  skillUse: assistantSkillUseSchema.optional(),
  attachmentArchives: z.array(z.uuid()).max(8).optional(),
  attachments: z.array(attachmentSchema.extend({ startPage: z.number().int().positive().optional(), endPage: z.number().int().positive().optional() })).max(8).optional()
});
export const assistantMessageSchema = assistantMessageFieldsSchema.superRefine(validateProjectScope);
const assistantConversationFieldsSchema = z.object({ id: z.string(), title: z.string(), createdAt: z.string(), updatedAt: z.string(), status: z.enum(['idle', 'running', 'failed', 'stopped']), providerId: z.string(), model: z.string(), effort: z.string().optional(), scope: assistantScopeSchema, contextPath: z.string().optional(), projectId: z.uuid().optional(), projectRevision: projectRevisionSchema.optional(), messages: z.array(assistantMessageSchema), problem: z.string().optional() });
export const assistantConversationSchema = assistantConversationFieldsSchema.superRefine(validateProjectScope);
export const assistantSendSchema = z.strictObject({
  conversationId: z.uuid().optional(), clientRequestId: z.uuid(), message: z.string().trim().min(1).max(16000),
  providerId: z.string().min(1).max(80), model: z.string().min(1).max(160), effort: z.string().max(40).optional(),
  scope: assistantScopeSchema, contextPath: z.string().min(1).max(1024).optional(), projectId: z.uuid().optional(), projectRevision: projectRevisionSchema.optional(),
  attachments: z.array(attachmentSelectionSchema).max(8).refine(items => new Set(items.map(item => item.id)).size === items.length, '附件不可重复选择').optional(),
  skillId: assistantSkillIdSchema.optional(),
  skillRevision: assistantSkillRevisionSchema.optional()
}).superRefine((value, context) => {
  validateProjectScope(value, context);
  if ((value.skillId === undefined) !== (value.skillRevision === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['skillId'], message: 'skillId 和 skillRevision 必须同时提供' });
  }
});
export const assistantIdSchema = z.strictObject({ id: z.uuid() });
export const assistantProvidersResponseSchema = successEnvelopeSchema(z.object({ providers: z.array(assistantProviderSchema) }));
export const assistantConversationResponseSchema = successEnvelopeSchema(assistantConversationSchema);
export const assistantHistoryQuerySchema = z.strictObject({ search: z.string().trim().max(200).optional(), projectId: z.uuid().optional(), cursor: z.string().min(1).max(4096).optional(), limit: z.coerce.number().int().min(1).max(100).default(100) });
export const assistantHistoryItemSchema = assistantConversationFieldsSchema.omit({ messages: true }).superRefine(validateProjectScope);
export const assistantHistoryPageSchema = z.object({ conversations: z.array(assistantHistoryItemSchema), hasMore: z.boolean().optional(), nextCursor: z.string().min(1).max(4096).optional() });
export const assistantHistoryResponseSchema = successEnvelopeSchema(assistantHistoryPageSchema);
export type AssistantHistoryQuery = { search?: string | undefined; projectId?: string | undefined; cursor?: string | undefined; limit?: number | undefined };
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
export type AssistantSkillUse = z.infer<typeof assistantSkillUseSchema>;
export type AssistantSource = z.infer<typeof assistantSourceSchema>;
export type AssistantEvidence = z.infer<typeof assistantEvidenceSchema>;
export type AssistantStep = z.infer<typeof assistantStepSchema>;
export type AssistantAction = z.infer<typeof assistantActionSchema>;
export type AssistantReviewAction = z.infer<typeof assistantReviewActionSchema>;
export type AssistantArchiveAction = z.infer<typeof assistantArchiveActionSchema>;
export type AssistantPlanAction = z.infer<typeof assistantPlanActionSchema>;
export type AssistantProjectWriteAction = z.infer<typeof projectWriteActionSchema>;
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;
export type AssistantConversation = z.infer<typeof assistantConversationSchema>;
export type AssistantSend = z.infer<typeof assistantSendSchema>;
