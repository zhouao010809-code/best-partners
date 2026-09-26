import { z } from 'zod';
import type { CreationVersion } from './project-creations.js';
import { successEnvelopeSchema } from './schemas.js';

export const creativeProfileFieldsSchema = z.strictObject({
  audience: z.string().max(2000),
  goal: z.string().max(2000),
  style: z.string().max(2000),
  facts: z.string().max(4000),
  avoid: z.string().max(2000)
});
export const creativeProfileSampleSchema = z.strictObject({ creationId: z.uuid(), versionId: z.uuid() });
const samplesSchema = z.array(creativeProfileSampleSchema).max(3)
  .refine(samples => new Set(samples.map(sample => sample.creationId)).size === samples.length, '同一创作只能选择一份样稿');
export const projectCreativeProfileSchema = z.strictObject({
  ...creativeProfileFieldsSchema.shape,
  projectId: z.uuid(), revision: z.number().int().nonnegative(), samples: samplesSchema,
  updatedAt: z.string().optional()
});
export const creativeProfileSaveSchema = z.strictObject({
  ...creativeProfileFieldsSchema.shape,
  samples: samplesSchema, expectedRevision: z.number().int().nonnegative()
});
export const creativeProfileResponseSchema = successEnvelopeSchema(projectCreativeProfileSchema);
export type CreativeProfileFields = z.infer<typeof creativeProfileFieldsSchema>;
export type ProjectCreativeProfile = z.infer<typeof projectCreativeProfileSchema>;
export type CreativeProfileSave = z.infer<typeof creativeProfileSaveSchema>;
export type CreativeProfileContext = { profile: ProjectCreativeProfile; samples: CreationVersion[] };
