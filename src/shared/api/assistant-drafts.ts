import { z } from 'zod';
import { successEnvelopeSchema } from './schemas.js';
import { attachmentSelectionSchema } from './attachments.js';

export const assistantDraftFieldsSchema = z.strictObject({
  conversationId: z.uuid().optional(), text: z.string().max(16000),
  attachments: z.array(attachmentSelectionSchema).max(8), groupId: z.uuid(),
  scope: z.enum(['brain', 'current']), contextPath: z.string().min(1).max(1024).optional()
});
export const assistantDraftSchema = assistantDraftFieldsSchema.extend({ id: z.uuid(), revision: z.number().int().positive(), updatedAt: z.string(), lastActive: z.string() });
export const assistantDraftSaveSchema = assistantDraftFieldsSchema.extend({ expectedRevision: z.number().int().nonnegative(), active: z.literal(true) });
export const assistantDraftListSchema = z.object({ drafts: z.array(assistantDraftSchema), activeId: z.uuid().optional() });
export const assistantDraftResponseSchema = successEnvelopeSchema(z.object({ draft: assistantDraftSchema }));
export const assistantDraftListResponseSchema = successEnvelopeSchema(assistantDraftListSchema);
export const assistantDraftDeleteResponseSchema = successEnvelopeSchema(z.object({ deleted: z.literal(true) }));
export type AssistantDraft = z.infer<typeof assistantDraftSchema>;
export type AssistantDraftFields = z.infer<typeof assistantDraftFieldsSchema>;
export type AssistantDraftSave = z.infer<typeof assistantDraftSaveSchema>;
export type AssistantDraftList = z.infer<typeof assistantDraftListSchema>;
