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

export const skillFolderTrashIdSchema = z.uuid();
export const skillFolderParamsSchema = z.strictObject({ folderId: skillFolderIdSchema });
export const skillFolderTrashRequestSchema = z.strictObject({ id: skillFolderTrashIdSchema });
export const skillFolderTrashPreviewSchema = z.strictObject({
  id: skillFolderTrashIdSchema, folderId: skillFolderIdSchema,
  name: z.string().min(1).max(255), skillCount: z.number().int().nonnegative(),
  entryCount: z.number().int().nonnegative(), expiresAt: z.iso.datetime()
});
export const skillFolderTrashEntrySchema = z.strictObject({
  id: skillFolderTrashIdSchema, folderId: skillFolderIdSchema,
  name: z.string().min(1).max(255), skillCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(), status: z.enum(['trashed', 'restored', 'needs-review']),
  restoredAt: z.iso.datetime().optional(), problem: z.string().max(2000).optional()
});
export const skillFolderTrashListSchema = z.strictObject({ items: z.array(skillFolderTrashEntrySchema) });
export const skillFolderTrashPreviewResponseSchema = successEnvelopeSchema(skillFolderTrashPreviewSchema);
export const skillFolderTrashEntryResponseSchema = successEnvelopeSchema(skillFolderTrashEntrySchema);
export const skillFolderTrashListResponseSchema = successEnvelopeSchema(skillFolderTrashListSchema);
export type SkillFolderTrashPreview = z.output<typeof skillFolderTrashPreviewSchema>;
export type SkillFolderTrashEntry = z.output<typeof skillFolderTrashEntrySchema>;
export type SkillFolderTrashList = z.output<typeof skillFolderTrashListSchema>;

export const skillMatchRequestSchema = z.strictObject({
  message: z.string().trim().min(1).max(16_000)
});

export const skillMatchCandidateSchema = z.strictObject({
  id: skillIdSchema,
  name: skillNameSchema,
  description: skillDescriptionSchema,
  folderName: z.string().min(1).max(255).nullable(),
  revision: sha256Schema,
  reason: z.string().min(1).max(300)
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
export const skillsMatchResponseSchema = successEnvelopeSchema(z.strictObject({
  candidates: z.array(skillMatchCandidateSchema).max(3)
}));

export type SkillSummary = z.output<typeof skillSummarySchema>;
export type SkillDetail = z.output<typeof skillDetailSchema>;
export type SkillsPage = z.output<typeof skillsPageSchema>;
export type SkillFolder = z.output<typeof skillFolderSchema>;
export type SkillFolderCreateRequest = z.output<typeof skillFolderCreateRequestSchema>;
export type SkillMoveRequest = z.output<typeof skillMoveRequestSchema>;
export type SkillMatchRequest = z.output<typeof skillMatchRequestSchema>;
export type SkillMatchCandidate = z.output<typeof skillMatchCandidateSchema>;
export type SkillResponse = z.output<typeof skillResponseSchema>;
export type SkillMoveResponse = z.output<typeof skillMoveResponseSchema>;
export type SkillFolderResponse = z.output<typeof skillFolderResponseSchema>;
export type SkillFolderCreateResponse = z.output<typeof skillFolderCreateResponseSchema>;
export type SkillsResponse = z.output<typeof skillsResponseSchema>;
export type SkillsMatchResponse = z.output<typeof skillsMatchResponseSchema>;
