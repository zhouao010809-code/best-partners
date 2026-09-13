import { z } from 'zod';
import { successEnvelopeSchema } from './schemas.js';

export const trashIdSchema = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
export const trashOriginSchema = z.enum(['library', 'queue', 'knowledge']);
/** This document-only scope must not widen extraction or intake paths. */
export const trashDocumentPathSchema = z.string().min(1).max(1024).refine((path) =>
  /^(?:01图书馆\/来自(?:B站|YouTube|抖音|小红书|公众号|飞书|X推特|Reddit|小宇宙|独立站|个人|其他)|02知识库)\/.+\.md$/u.test(path)
  && !/[\\\u0000-\u001f\u007f]/u.test(path)
  && !path.split('/').some((part) => !part || part.startsWith('.')));
export const trashPathRequestSchema = z.strictObject({ materialPath: trashDocumentPathSchema, origin: trashOriginSchema.optional() });
export const trashIdRequestSchema = z.strictObject({ id: trashIdSchema });
export const trashEmptySchema = z.strictObject({});
export const trashReferenceSchema = z.strictObject({ path: z.string().min(1).max(1024), title: z.string().min(1).max(1000) });
export const trashPreviewSchema = z.strictObject({
  id: trashIdSchema, materialPath: trashDocumentPathSchema, origin: trashOriginSchema.optional(), title: z.string().min(1).max(1000),
  bytes: z.number().int().nonnegative(), referencedKnowledge: z.array(trashReferenceSchema).max(10000),
  expiresAt: z.iso.datetime()
});
export const trashDeleteRequestSchema = z.strictObject({ token: trashIdSchema });
export const trashDeletePreviewSchema = trashPreviewSchema.extend({ token: trashIdSchema });
export const trashEntrySchema = z.strictObject({
  id: trashIdSchema, materialPath: trashDocumentPathSchema, origin: trashOriginSchema.optional(), title: z.string().min(1).max(1000),
  createdAt: z.iso.datetime(), status: z.enum(['moving', 'trashed', 'restoring', 'restored', 'needs-review', 'deleting', 'deleted']),
  indexed: z.boolean(), restoredAt: z.iso.datetime().optional(), deletedAt: z.iso.datetime().optional(), problem: z.string().min(1).max(2000).optional()
});
export const trashListSchema = z.strictObject({ items: z.array(trashEntrySchema) });
export const trashPreviewResponseSchema = successEnvelopeSchema(trashPreviewSchema);
export const trashDeletePreviewResponseSchema = successEnvelopeSchema(trashDeletePreviewSchema);
export const trashEntryResponseSchema = successEnvelopeSchema(trashEntrySchema);
export const trashListResponseSchema = successEnvelopeSchema(trashListSchema);
export type TrashPreview = z.output<typeof trashPreviewSchema>;
export type TrashOrigin = z.output<typeof trashOriginSchema>;
export type TrashDeletePreview = z.output<typeof trashDeletePreviewSchema>;
export type TrashEntry = z.output<typeof trashEntrySchema>;
export type TrashList = z.output<typeof trashListSchema>;
