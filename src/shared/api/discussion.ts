import { z } from 'zod';
import { successEnvelopeSchema } from './schemas.js';

export const discussionStatusSchema = z.enum(['未探讨', '部分探讨完成', '全面探讨完成']);
const phase = z.enum(['prepared', 'active', 'paused', 'ended']);
const path = z.string().min(1).max(1024);
const materialPaths = z.array(path).max(32);
const text = z.string().min(1).max(32000);
const identity = { id: z.uuid(), expectedUpdatedAt: z.string().optional() };
const progress = z.strictObject({ path, status: discussionStatusSchema });

export const discussionActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('continueChat'), chatPath: path, requestId: z.uuid().optional() }),
  z.strictObject({ type: z.literal('start'), materialPaths, text: text.optional(), requestId: z.uuid().optional() }),
  z.strictObject({ type: z.enum(['open', 'begin', 'pause', 'resume', 'diary', 'end']), ...identity }),
  z.strictObject({ type: z.literal('message'), ...identity, text }),
  z.strictObject({ type: z.literal('addMaterials'), ...identity, materialPaths: materialPaths.min(1) }),
  z.strictObject({ type: z.literal('confirm'), ...identity, progress: z.array(progress).max(32) })
]);
export const discussionSummarySchema = z.object({
  id: z.uuid(), title: z.string(), phase, materialPaths, updatedAt: z.string()
});
export const discussionSessionSchema = discussionSummarySchema.extend({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string() })),
  proposals: z.array(progress.extend({ covered: z.string(), remaining: z.string() })),
  notice: z.string().optional(), chatPath: path.optional(), diaryPath: path.optional(), diaryMarkdown: z.string().optional(), knowledgePaths: z.array(path)
});
export const discussionListResponseSchema = successEnvelopeSchema(z.array(discussionSummarySchema));
export const discussionResponseSchema = successEnvelopeSchema(discussionSessionSchema);
export type DiscussionAction = z.infer<typeof discussionActionSchema>;
export type DiscussionSummary = z.infer<typeof discussionSummarySchema>;
export type DiscussionSession = z.infer<typeof discussionSessionSchema>;
export type DiscussionStatus = z.infer<typeof discussionStatusSchema>;
export const discussionHistoryItemSchema = z.object({ path, title: z.string(), startedAt: z.string(), materialPaths: z.array(path) });
export const discussionHistoryDetailSchema = discussionHistoryItemSchema.extend({ body: z.string() });
export const discussionHistoryQuerySchema = z.strictObject({ path });
export const discussionHistoryResponseSchema = successEnvelopeSchema(z.array(discussionHistoryItemSchema));
export const discussionHistoryDetailResponseSchema = successEnvelopeSchema(discussionHistoryDetailSchema);
export type DiscussionHistoryItem = z.infer<typeof discussionHistoryItemSchema>;
export type DiscussionHistoryDetail = z.infer<typeof discussionHistoryDetailSchema>;
export interface DiscussionService {
  history(): DiscussionHistoryItem[] | Promise<DiscussionHistoryItem[]>;
  readHistory(path: string): DiscussionHistoryDetail | Promise<DiscussionHistoryDetail>;
  list(): DiscussionSummary[] | Promise<DiscussionSummary[]>;
  act(action: DiscussionAction): Promise<DiscussionSession>;
}
