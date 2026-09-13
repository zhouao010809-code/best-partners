import { z } from 'zod';
import { knowledgeQuerySchema, knowledgeRecordSchema, successEnvelopeSchema } from './schemas.js';

const directoryPathSchema = z.string().max(1024);
const countSchema = z.number().int().nonnegative();

export const knowledgeCatalogQuerySchema = knowledgeQuerySchema.extend({
  path: directoryPathSchema.default('')
});

export const knowledgeCatalogPageSchema = z.strictObject({
  path: directoryPathSchema,
  breadcrumbs: z.array(z.strictObject({ path: directoryPathSchema, label: z.string().min(1).max(1000) })),
  folders: z.array(z.strictObject({
    path: directoryPathSchema.min(1),
    label: z.string().min(1).max(1000),
    count: countSchema
  })),
  items: z.array(knowledgeRecordSchema).max(200),
  total: countSchema,
  directTotal: countSchema,
  indexVersion: countSchema,
  nextCursor: knowledgeQuerySchema.shape.cursor
}).superRefine((page, context) => {
  if (page.directTotal > page.total || page.items.length > page.directTotal
    || page.folders.some((folder) => folder.count > page.total)) {
    context.addIssue({ code: 'custom', path: ['total'], message: 'Catalog counts are inconsistent' });
  }
});

export const knowledgeCatalogPageResponseSchema = successEnvelopeSchema(knowledgeCatalogPageSchema);
export type KnowledgeCatalogQuery = Omit<z.output<typeof knowledgeCatalogQuerySchema>, 'path'> & { readonly path?: string };
export type KnowledgeCatalogPage = z.output<typeof knowledgeCatalogPageSchema>;
export type KnowledgeCatalogFolder = KnowledgeCatalogPage['folders'][number];
