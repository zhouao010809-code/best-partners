import { z } from 'zod';
import { successEnvelopeSchema } from './schemas.js';

const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const dateTimeSchema = z.string().datetime({ offset: true });
const pathSchema = z.string().min(1).max(2048);

/**
 * A browser may refer only to a path already made available by the company
 * runtime.  The route applies the workspace/incoming containment check; this
 * schema deliberately rejects absolute paths and traversal before that step.
 */
const serverRelativePathSchema = pathSchema.refine(value => {
  if (value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value)) return false;
  return !value.split('/').some(segment => segment === '' || segment === '.' || segment === '..');
}, 'Expected a server-relative path');

export const companyProjectSourceEntrySchema = z.object({
  relativePath: serverRelativePathSchema,
  kind: z.enum(['file', 'directory']),
  bytes: z.number().int().nonnegative().optional(),
  modifiedAt: dateTimeSchema.optional(),
  sha256: sha256Schema.optional()
}).strict();

const inferredFieldSchema = z.object({
  value: z.string().min(1).max(2048),
  confidence: z.literal('inferred'),
  evidencePaths: z.array(serverRelativePathSchema).max(1000)
}).strict();
const unknownFieldSchema = z.object({
  confidence: z.literal('unknown'),
  evidencePaths: z.array(serverRelativePathSchema).max(1000)
}).strict();

export const companyProjectFieldSchema = z.union([inferredFieldSchema, unknownFieldSchema]);

export const companyProjectProposalSchema = z.object({
  sourceRoot: pathSchema,
  sourceSha256: sha256Schema,
  suggestedName: z.string().min(1).max(200),
  suggestedClientName: z.string().min(1).max(200).optional(),
  suggestedStatus: z.enum(['draft', 'active']),
  fields: z.record(z.string().min(1).max(128), companyProjectFieldSchema),
  selectedSkillIds: z.array(idSchema).max(1000),
  entries: z.array(companyProjectSourceEntrySchema).max(100_000),
  issues: z.array(z.string().min(1).max(1000)).max(1000)
}).strict();

export const companyProjectSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  name: z.string().min(1).max(200),
  clientName: z.string().min(1).max(200).optional(),
  status: z.enum(['draft', 'active', 'acceptance', 'completed', 'paused', 'archived']),
  projectRoot: pathSchema,
  sourceRoot: pathSchema,
  configSha256: sha256Schema,
  confidence: z.record(z.string(), z.unknown()),
  selectedSkillIds: z.array(idSchema).max(1000),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
  dataCoverage: z.literal('not_configured')
}).strict();

export const companyProjectRunSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  sourceSha256: sha256Schema,
  state: z.enum(['scanning', 'proposed', 'confirmed', 'failed', 'superseded']),
  proposal: companyProjectProposalSchema,
  operationId: idSchema,
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema
}).strict();

export const companyProjectScanRequestSchema = z.union([
  z.strictObject({ incomingPath: serverRelativePathSchema }),
  z.strictObject({ sourcePath: serverRelativePathSchema }),
  z.strictObject({ uploadId: idSchema })
]);

export const companyProjectConfirmRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  clientName: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['draft', 'active']),
  sourceSha256: sha256Schema,
  selectedSkillIds: z.array(idSchema).max(1000)
});

export const companyProjectRunParamsSchema = z.strictObject({ id: idSchema });
export const companyProjectIdParamsSchema = z.strictObject({ id: idSchema });

export const companyProjectListDataSchema = z.object({
  items: z.array(companyProjectSchema)
}).strict();
export const companyProjectScanDataSchema = z.object({
  reused: z.boolean(),
  run: companyProjectRunSchema,
  project: companyProjectSchema,
  proposal: companyProjectProposalSchema
}).strict();
export const companyProjectDraftDataSchema = z.object({
  run: companyProjectRunSchema,
  project: companyProjectSchema
}).strict();
export const companyProjectConfirmDataSchema = z.object({
  project: companyProjectSchema,
  run: companyProjectRunSchema,
  operationId: idSchema
}).strict();

export const companyProjectListResponseSchema = successEnvelopeSchema(companyProjectListDataSchema);
export const companyProjectScanResponseSchema = successEnvelopeSchema(companyProjectScanDataSchema);
export const companyProjectDraftResponseSchema = successEnvelopeSchema(companyProjectDraftDataSchema);
export const companyProjectConfirmResponseSchema = successEnvelopeSchema(companyProjectConfirmDataSchema);
export const companyProjectDetailResponseSchema = successEnvelopeSchema(companyProjectSchema);

export type CompanyProjectScanRequest = z.infer<typeof companyProjectScanRequestSchema>;
export type CompanyProjectConfirmRequest = z.infer<typeof companyProjectConfirmRequestSchema>;
export type CompanyProject = z.infer<typeof companyProjectSchema>;
export type CompanyProjectProposal = z.infer<typeof companyProjectProposalSchema>;
export type CompanyProjectRun = z.infer<typeof companyProjectRunSchema>;
