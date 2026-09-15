import { z } from 'zod';
import { successEnvelopeSchema } from './schemas.js';

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const skillIdSchema = sha256Schema;
export const skillIdParamsSchema = z.strictObject({ id: skillIdSchema });
export const skillNameSchema = z.string().min(1).max(256);
export const skillDescriptionSchema = z.string().min(1).max(10_000);

export const skillSummarySchema = z.strictObject({
  id: skillIdSchema,
  name: skillNameSchema,
  description: skillDescriptionSchema,
  revision: sha256Schema,
  folderId: sha256Schema.nullable(),
  folderName: z.string().min(1).max(255).nullable()
});

export const skillFolderIdSchema = sha256Schema;
export const skillFolderSchema = z.strictObject({
  id: skillFolderIdSchema,
  name: z.string().min(1).max(255),
  skillCount: z.number().int().nonnegative().max(1_000)
});
export const skillFolderCreateRequestSchema = z.strictObject({ name: z.string().min(1).max(255) });
export const skillMoveRequestSchema = z.strictObject({ folderId: skillFolderIdSchema.nullable() });

export const skillDetailSchema = skillSummarySchema.extend({
  markdown: z.string().max(256 * 1024),
  references: z.array(z.string().min(1).max(255)).max(1_000)
}).strict();

export const skillsPageSchema = z.strictObject({
  folders: z.array(skillFolderSchema).max(1_000),
  items: z.array(skillSummarySchema).max(1_000)
});
export const skillEmptyQuerySchema = z.strictObject({});

export const skillsResponseSchema = successEnvelopeSchema(skillsPageSchema);
export const skillResponseSchema = successEnvelopeSchema(skillDetailSchema);
export const skillFolderResponseSchema = successEnvelopeSchema(skillFolderSchema);
export const skillMoveResponseSchema = successEnvelopeSchema(skillDetailSchema);

export type SkillSummary = z.output<typeof skillSummarySchema>;
export type SkillDetail = z.output<typeof skillDetailSchema>;
export type SkillsPage = z.output<typeof skillsPageSchema>;
export type SkillFolder = z.output<typeof skillFolderSchema>;
