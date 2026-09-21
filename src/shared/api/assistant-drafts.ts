import { z } from 'zod';
import { successEnvelopeSchema } from './schemas.js';
import { attachmentSelectionSchema } from './attachments.js';

const projectRevisionSchema = z.number().int().nonnegative();
function validateProjectScope(value: { scope: 'brain' | 'current' | 'project'; projectId?: string | undefined; projectRevision?: number | undefined; contextPath?: string | undefined }, context: z.RefinementCtx): void {
  if (value.scope === 'project') {
    if (value.projectId === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['projectId'], message: 'project scope requires projectId' });
    if (value.projectRevision === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['projectRevision'], message: 'project scope requires projectRevision' });
    if (value.contextPath !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['contextPath'], message: 'project scope cannot include contextPath' });
  } else if (value.projectId !== undefined || value.projectRevision !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['projectId'], message: 'project fields require project scope' });
  }
}

const assistantDraftFieldsBaseSchema = z.strictObject({
  conversationId: z.uuid().optional(), text: z.string().max(16000),
  attachments: z.array(attachmentSelectionSchema).max(8), groupId: z.uuid(),
  scope: z.enum(['brain', 'current', 'project']), contextPath: z.string().min(1).max(1024).optional(),
  projectId: z.uuid().optional(), projectRevision: projectRevisionSchema.optional()
});
export const assistantDraftFieldsSchema = assistantDraftFieldsBaseSchema.superRefine(validateProjectScope);
const assistantDraftBaseSchema = assistantDraftFieldsBaseSchema.extend({ id: z.uuid(), revision: z.number().int().positive(), updatedAt: z.string(), lastActive: z.string() });
export const assistantDraftSchema = assistantDraftBaseSchema.superRefine(validateProjectScope);
const assistantDraftSaveBaseSchema = assistantDraftFieldsBaseSchema.extend({ expectedRevision: z.number().int().nonnegative(), active: z.literal(true) });
export const assistantDraftSaveSchema = assistantDraftSaveBaseSchema.superRefine(validateProjectScope);
export const assistantDraftListSchema = z.object({ drafts: z.array(assistantDraftSchema), activeId: z.uuid().optional() });
export const assistantDraftQuerySchema = z.strictObject({ projectId: z.uuid().optional() });
export const assistantDraftResponseSchema = successEnvelopeSchema(z.object({ draft: assistantDraftSchema }));
export const assistantDraftListResponseSchema = successEnvelopeSchema(assistantDraftListSchema);
export const assistantDraftDeleteResponseSchema = successEnvelopeSchema(z.object({ deleted: z.literal(true) }));
export type AssistantDraft = z.infer<typeof assistantDraftSchema>;
export type AssistantDraftFields = z.infer<typeof assistantDraftFieldsSchema>;
export type AssistantDraftSave = z.infer<typeof assistantDraftSaveSchema>;
export type AssistantDraftList = z.infer<typeof assistantDraftListSchema>;
export type AssistantDraftQuery = z.infer<typeof assistantDraftQuerySchema>;
