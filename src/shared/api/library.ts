import { z } from 'zod';
import { materialQuerySchema, materialRecordSchema, successEnvelopeSchema } from './schemas.js';

export const libraryModeSchema = z.enum(['topic', 'source']);
const directoryPathSchema = z.string().max(1024);
export const libraryQuerySchema = z.strictObject({
  mode: libraryModeSchema.default('topic'),
  path: directoryPathSchema.default(''),
  status: materialQuerySchema.shape.status,
  title: materialQuerySchema.shape.title,
  cursor: materialQuerySchema.shape.cursor,
  limit: z.coerce.number<number>().int().min(1).max(200).optional()
});
const countSchema = z.number().int().nonnegative();
export const libraryPageSchema = z.strictObject({
  mode: libraryModeSchema,
  path: directoryPathSchema,
  breadcrumbs: z.array(z.strictObject({ path: directoryPathSchema, label: z.string().min(1).max(1000) })),
  folders: z.array(z.strictObject({
    path: directoryPathSchema.min(1),
    label: z.string().min(1).max(1000),
    count: countSchema,
    folderCount: countSchema
  })),
  items: z.array(materialRecordSchema).max(200),
  total: countSchema,
  directTotal: countSchema,
  unclassifiedCount: countSchema,
  indexVersion: countSchema,
  nextCursor: materialQuerySchema.shape.cursor
});
export const libraryPageResponseSchema = successEnvelopeSchema(libraryPageSchema);
export type LibraryQuery = z.input<typeof libraryQuerySchema>;
export type LibraryPage = z.output<typeof libraryPageSchema>;
export type LibraryFolder = LibraryPage['folders'][number];
