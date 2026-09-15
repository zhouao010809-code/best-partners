import { z } from 'zod';
import { successEnvelopeSchema } from './schemas.js';

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const skillIdSchema = sha256Schema;
export const skillFolderIdSchema = sha256Schema;
export const skillIdParamsSchema = z.strictObject({ id: skillIdSchema });

export const skillNameSchema = z.string().min(1).max(256);
export const skillDescriptionSchema = z.string().min(1).max(10_000);

export const skillFolderSchema = z.strictObject({
  id: skillFolderIdSchema,
  name: z.string().min(1).max(255),
  skillCount: z.number().int().nonnegative().max(1_000)
});

export const skillSummarySchema = z.strictObject({
  id: skillIdSchema,
  name: skillNameSchema,
  description: skillDescriptionSchema,
  revision: sha256Schema,
  folderId: skillFolderIdSchema.nullable(),
  folderName: z.string().min(1).max(255).nullable()
});

export const skillDetailSchema = skillSummarySchema.extend({
  markdown: z.string().max(256 * 1024),
  references: z.array(z.string().min(1).max(255)).max(1_000)
}).strict();

export const skillFolderCreateRequestSchema = z.strictObject({
  name: z.string().min(1).max(255)
});

export const skillMoveRequestSchema = z.strictObject({
  folderId: skillFolderIdSchema.nullable()
});

export const skillsPageSchema = z.strictObject({
  folders: z.array(skillFolderSchema).max(1_000),
  items: z.array(skillSummarySchema).max(1_000)
});

export const skillEmptyQuerySchema = z.strictObject({});

export const skillsResponseSchema = successEnvelopeSchema(skillsPageSchema);
export const skillResponseSchema = successEnvelopeSchema(skillDetailSchema);
export const skillFolderResponseSchema = successEnvelopeSchema(skillFolderSchema);
export const skillFolderCreateResponseSchema = skillFolderResponseSchema;
export const skillMoveResponseSchema = successEnvelopeSchema(skillSummarySchema);

export type SkillSummary = z.output<typeof skillSummarySchema>;
export type SkillDetail = z.output<typeof skillDetailSchema>;
export type SkillsPage = z.output<typeof skillsPageSchema>;
export type SkillFolder = z.output<typeof skillFolderSchema>;
export type SkillFolderCreateRequest = z.output<typeof skillFolderCreateRequestSchema>;
export type SkillMoveRequest = z.output<typeof skillMoveRequestSchema>;
export type SkillResponse = z.output<typeof skillResponseSchema>;
export type SkillMoveResponse = z.output<typeof skillMoveResponseSchema>;
export type SkillFolderResponse = z.output<typeof skillFolderResponseSchema>;
export type SkillFolderCreateResponse = z.output<typeof skillFolderCreateResponseSchema>;
export type SkillsResponse = z.output<typeof skillsResponseSchema>;
