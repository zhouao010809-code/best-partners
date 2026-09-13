import { z } from 'zod';
import { successEnvelopeSchema } from './schemas.js';

export const intakeTrashIdSchema = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
export const intakeTrashNameSchema = z.string().min(1).max(255).refine((name) => {
  const bytes = new TextEncoder().encode(name);
  return name !== '.' && name !== '..' && !/[\0/\\]/u.test(name)
    && bytes.length <= 255 && new TextDecoder().decode(bytes) === name;
});
export const intakeTrashNameRequestSchema = z.strictObject({ name: intakeTrashNameSchema });
export const intakeTrashIdRequestSchema = z.strictObject({ id: intakeTrashIdSchema });
export const intakeTrashEmptySchema = z.strictObject({});
const common = {
  id: intakeTrashIdSchema,
  name: intakeTrashNameSchema,
  title: z.string().min(1).max(255),
  kind: z.enum(['file', 'directory']),
  bytes: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative()
};
export const intakeTrashPreviewSchema = z.strictObject({ ...common, expiresAt: z.iso.datetime() });
export const intakeTrashDeletePreviewSchema = intakeTrashPreviewSchema.extend({ token: intakeTrashIdSchema });
export const intakeTrashDeleteRequestSchema = z.strictObject({ token: intakeTrashIdSchema });
export const intakeTrashEntrySchema = z.strictObject({
  ...common,
  createdAt: z.iso.datetime(),
  status: z.enum(['moving', 'trashed', 'restoring', 'restored', 'deleting', 'deleted', 'needs-review']),
  deletedAt: z.iso.datetime().optional(),
  problem: z.string().min(1).max(2000).optional()
});
export const intakeTrashListSchema = z.strictObject({ items: z.array(intakeTrashEntrySchema) });
export const intakeTrashPreviewResponseSchema = successEnvelopeSchema(intakeTrashPreviewSchema);
export const intakeTrashDeletePreviewResponseSchema = successEnvelopeSchema(intakeTrashDeletePreviewSchema);
export const intakeTrashEntryResponseSchema = successEnvelopeSchema(intakeTrashEntrySchema);
export const intakeTrashListResponseSchema = successEnvelopeSchema(intakeTrashListSchema);
export type IntakeTrashPreview = z.output<typeof intakeTrashPreviewSchema>;
export type IntakeTrashDeletePreview = z.output<typeof intakeTrashDeletePreviewSchema>;
export type IntakeTrashEntry = z.output<typeof intakeTrashEntrySchema>;
export type IntakeTrashList = z.output<typeof intakeTrashListSchema>;
