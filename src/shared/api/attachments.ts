import { z } from 'zod';
import { successEnvelopeSchema } from './schemas.js';
import { intakeFieldsSchema } from './intake.js';

export const ATTACHMENT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_GROUP_BYTES = 16 * 1024 * 1024;
export const attachmentSelectionSchema = z.strictObject({ id: z.uuid(), startPage: z.number().int().positive().optional(), endPage: z.number().int().positive().optional() });
export const attachmentArchiveSchema = z.object({ state: z.enum(['preparing', 'archived', 'needs-review']), operationId: z.uuid().optional(), materialPath: z.string().optional(), target: z.string().optional(), indexed: z.boolean().optional(), problem: z.string().optional() });
export const attachmentSchema = z.object({
  id: z.uuid(), name: z.string(), mediaType: z.enum(['application/pdf', 'text/markdown', 'text/plain']), size: z.number().int().nonnegative(), sha256: z.string(),
  status: z.enum(['processing', 'ready', 'needs-ocr', 'encrypted', 'failed', 'cancelled']), pageCount: z.number().int().nonnegative().optional(), textBytes: z.number().int().nonnegative(),
  problem: z.string().optional(), createdAt: z.string(), updatedAt: z.string(), archive: attachmentArchiveSchema.optional(), duplicateOf: z.uuid().optional()
});
export const attachmentPageSchema = z.object({ page: z.number().int().positive(), text: z.string() });
export const attachmentPagesSchema = z.object({ id: z.uuid(), sha256: z.string(), textRevision: z.string(), pages: z.array(attachmentPageSchema), startPage: z.number().int().positive(), endPage: z.number().int().positive(), totalPages: z.number().int().nonnegative(), truncated: z.boolean() });
export const attachmentResponseSchema = successEnvelopeSchema(z.object({ attachment: attachmentSchema }));
export const attachmentListResponseSchema = successEnvelopeSchema(z.object({ attachments: z.array(attachmentSchema) }));
export const attachmentPagesResponseSchema = successEnvelopeSchema(attachmentPagesSchema);
export const attachmentUploadQuerySchema = z.strictObject({ name: z.string().min(1).max(255).refine(value => !/[/\\\0\p{Cc}]/u.test(value) && value !== '.' && value !== '..'), uploadId: z.uuid(), groupId: z.uuid() });
export const attachmentArchiveRequestSchema = z.strictObject({ id: z.uuid(), fields: intakeFieldsSchema.partial().optional() });
export const attachmentArchiveResultSchema = z.object({ id: z.uuid(), state: z.enum(['archived', 'needs-review']), operationId: z.uuid(), materialPath: z.string(), target: z.string(), indexed: z.boolean(), duplicate: z.boolean() });
export const attachmentArchiveResponseSchema = successEnvelopeSchema(z.object({ result: attachmentArchiveResultSchema }));
export type Attachment = z.infer<typeof attachmentSchema>;
export type AttachmentSelection = z.infer<typeof attachmentSelectionSchema>;
export type AttachmentPages = z.infer<typeof attachmentPagesSchema>;
export type AttachmentArchiveRequest = z.infer<typeof attachmentArchiveRequestSchema>;
export type AttachmentArchiveResult = z.infer<typeof attachmentArchiveResultSchema>;
