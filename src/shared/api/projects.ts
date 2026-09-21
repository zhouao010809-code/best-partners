import { z } from 'zod';
import { successEnvelopeSchema } from './schemas.js';

/** Public project state. The bound absolute root is deliberately not exposed. */
export const projectAvailabilitySchema = z.enum(['ready', 'scanning', 'unavailable', 'reconnect-required']);
export const projectStatusSchema = projectAvailabilitySchema;
export const projectParseStatusSchema = z.enum(['readable', 'unsupported', 'too-large', 'failed']);
export const projectFileParseStatusSchema = projectParseStatusSchema;
export const projectCategorySchema = z.enum(['选题评估', '内容草稿', '周计划', '复盘草稿', '工作日志']);
export const projectOutputCategorySchema = projectCategorySchema;
export const projectWriteStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'stale']);

const dateTimeSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const revisionSchema = z.union([z.number().int().nonnegative(), z.string().min(1).max(256)]);

/**
 * A path crossing the public API is always relative to the already-bound
 * project root.  Keep this validator in one place so query, read and write
 * contracts cannot accidentally accept a filesystem path.
 */
export function isProjectRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes('\\') || value.includes('\0')) return false;
  if (/^[\u0000-\u001f\u007f]/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/u.test(value)) return false;
  const segments = value.split('/');
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

export const projectRelativePathSchema = z.string().min(1).max(4096)
  .refine(isProjectRelativePath, 'Expected a safe project-relative path');
export const relativeProjectPathSchema = projectRelativePathSchema;

// Root paths are accepted only by private bind/reconnect requests. They never
// appear in project/file response schemas or assistant model payloads.
export const projectRootPathSchema = z.string().min(1).max(4096)
  .refine(value => !/[\u0000-\u001f\u007f]/u.test(value), 'Invalid project root path');

export const projectSummarySchema = z.strictObject({
  id: z.uuid(),
  displayName: z.string().trim().min(1).max(255),
  sourceRevision: revisionSchema,
  availability: projectAvailabilitySchema,
  outputRoot: z.enum(['AI工作区', 'AI工作区/']),
  fileCount: z.number().int().nonnegative(),
  readableFileCount: z.number().int().nonnegative(),
  issueCount: z.number().int().nonnegative(),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
  lastScannedAt: dateTimeSchema.nullable()
});
export const projectSchema = projectSummarySchema;

const projectFileShape = {
  projectId: z.uuid().optional(),
  id: z.uuid().optional(),
  // `path` is retained as a wire-level alias for early clients; both values,
  // when supplied, must identify the same relative path.
  relativePath: projectRelativePathSchema.optional(),
  path: projectRelativePathSchema.optional(),
  origin: z.enum(['source', 'output']),
  parseStatus: projectParseStatusSchema,
  kind: z.enum(['file', 'directory']).optional(),
  bytes: z.number().int().nonnegative().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  modifiedAt: dateTimeSchema.optional(),
  sha256: sha256Schema.optional(),
  mimeType: z.string().max(255).optional(),
  issue: z.string().max(2000).optional(),
  title: z.string().max(1000).optional(),
  sourceRevision: revisionSchema.optional()
} as const;

function requireOnePath(value: { relativePath?: string | undefined; path?: string | undefined }, context: z.RefinementCtx): void {
  if (value.relativePath === undefined && value.path === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['relativePath'], message: 'relativePath is required' });
  }
  if (value.relativePath !== undefined && value.path !== undefined && value.relativePath !== value.path) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['path'], message: 'path and relativePath must match' });
  }
}

export const projectFileSchema = z.strictObject(projectFileShape).superRefine(requireOnePath);
export const projectFileDetailSchema = z.strictObject({
  ...projectFileShape,
  content: z.string().optional(),
  encoding: z.string().max(64).optional(),
  truncated: z.boolean().optional(),
  totalBytes: z.number().int().nonnegative().optional(),
  readRevision: revisionSchema.optional()
}).superRefine(requireOnePath);

export const projectScanPreviewSchema = z.strictObject({
  scanId: z.uuid().optional(),
  sourceSha256: sha256Schema.optional(),
  projectId: z.uuid().optional(),
  displayName: z.string().trim().min(1).max(255),
  sourceRevision: revisionSchema,
  availability: projectAvailabilitySchema,
  outputRoot: z.enum(['AI工作区', 'AI工作区/']).default('AI工作区'),
  fileCount: z.number().int().nonnegative(),
  readableFileCount: z.number().int().nonnegative(),
  issueCount: z.number().int().nonnegative(),
  files: z.array(projectFileSchema).max(100_000).optional(),
  issues: z.array(z.string().max(2000)).max(10_000).optional(),
  createdAt: dateTimeSchema.optional(),
  updatedAt: dateTimeSchema.optional(),
  lastScannedAt: dateTimeSchema.nullable().optional()
});

export const projectWriteActionSchema = z.strictObject({
  id: z.uuid(),
  type: z.literal('project-write'),
  label: z.string().min(1).max(300),
  status: projectWriteStatusSchema,
  projectId: z.uuid(),
  projectRevision: revisionSchema,
  category: projectCategorySchema,
  path: projectRelativePathSchema.optional(),
  targetPath: projectRelativePathSchema.optional(),
  operationId: z.string().min(1).max(256).optional(),
  summary: z.string().max(4000).optional(),
  problem: z.string().max(2000).optional(),
  createdAt: dateTimeSchema.optional(),
  updatedAt: dateTimeSchema.optional()
}).superRefine((value, context) => {
  if (value.path === undefined && value.targetPath === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['path'], message: 'path is required' });
  }
  if (value.path !== undefined && value.targetPath !== undefined && value.path !== value.targetPath) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['targetPath'], message: 'path and targetPath must match' });
  }
});

export const projectOperationSchema = z.strictObject({
  id: z.string().min(1).max(256),
  projectId: z.uuid(),
  planId: z.uuid().optional(),
  type: z.enum(['scan', 'bind', 'reconnect', 'refresh', 'project-write']),
  status: projectWriteStatusSchema,
  path: projectRelativePathSchema.optional(),
  targetPath: projectRelativePathSchema.optional(),
  beforeSha256: sha256Schema.optional(),
  afterSha256: sha256Schema.optional(),
  problem: z.string().max(2000).optional(),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
  completedAt: dateTimeSchema.optional()
});

export const projectScanRequestSchema = z.strictObject({
  projectId: z.uuid().optional(),
  rootPath: projectRootPathSchema.optional(),
  displayName: z.string().trim().min(1).max(255).optional(),
  sourceSha256: sha256Schema.optional()
}).superRefine((value, context) => {
  if (value.projectId === undefined && value.rootPath === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['projectId'], message: 'projectId or rootPath is required' });
  }
});
export const projectBindRequestSchema = z.union([
  z.strictObject({ scanId: z.uuid(), sourceSha256: sha256Schema, displayName: z.string().trim().min(1).max(255).optional() }),
  // Kept for local callers that have not yet split scan and bind. This input
  // is consumed server-side and never echoed in a public project payload.
  z.strictObject({ rootPath: projectRootPathSchema, displayName: z.string().trim().min(1).max(255).optional() })
]);
export const projectReconnectRequestSchema = z.strictObject({
  id: z.uuid(),
  rootPath: projectRootPathSchema
});
export const projectIdParamsSchema = z.strictObject({ id: z.uuid() });
export const projectIdSchema = projectIdParamsSchema;

export const projectFileQuerySchema = z.strictObject({
  projectId: z.uuid().optional(),
  search: z.string().trim().max(200).optional(),
  origin: z.enum(['source', 'output']).optional(),
  parseStatus: projectParseStatusSchema.optional(),
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100)
});
export const projectFileReadRequestSchema = z.strictObject({
  projectId: z.uuid().optional(),
  relativePath: projectRelativePathSchema.optional(),
  path: projectRelativePathSchema.optional(),
  offset: z.number().int().nonnegative().optional(),
  length: z.number().int().positive().max(120_000).optional()
}).superRefine(requireOnePath);
export const projectFileReadSchema = projectFileReadRequestSchema;
export const projectScanSchema = projectScanRequestSchema;
export const projectBindSchema = projectBindRequestSchema;
export const projectReconnectSchema = projectReconnectRequestSchema;
export const projectFileQueryParamsSchema = projectFileQuerySchema;
export const projectFileReadParamsSchema = projectFileReadRequestSchema;

export const projectWritePlanRequestSchema = z.strictObject({
  projectId: z.uuid(),
  projectRevision: revisionSchema,
  category: projectCategorySchema,
  path: projectRelativePathSchema,
  content: z.string().max(200_000),
  conversationId: z.uuid().optional(),
  messageId: z.string().min(1).max(256).optional()
});
export const projectWritePlanIdParamsSchema = z.strictObject({ id: z.uuid() });
export const projectWritePlanConfirmRequestSchema = z.strictObject({ clientRequestId: z.uuid() });

export const projectListDataSchema = z.strictObject({ projects: z.array(projectSummarySchema) });
export const projectFilesDataSchema = z.strictObject({ files: z.array(projectFileSchema), hasMore: z.boolean().optional(), nextCursor: z.string().min(1).max(4096).optional() });
export const projectOperationsDataSchema = z.strictObject({ operations: z.array(projectOperationSchema), hasMore: z.boolean().optional(), nextCursor: z.string().min(1).max(4096).optional() });
export const projectResponseSchema = successEnvelopeSchema(projectSummarySchema);
export const projectListResponseSchema = successEnvelopeSchema(projectListDataSchema);
export const projectScanResponseSchema = successEnvelopeSchema(projectScanPreviewSchema);
export const projectBindResponseSchema = successEnvelopeSchema(projectSummarySchema);
export const projectReconnectResponseSchema = successEnvelopeSchema(projectSummarySchema);
export const projectFileListResponseSchema = successEnvelopeSchema(projectFilesDataSchema);
export const projectFileResponseSchema = successEnvelopeSchema(projectFileDetailSchema);
export const projectWriteActionResponseSchema = successEnvelopeSchema(projectWriteActionSchema);
export const projectOperationResponseSchema = successEnvelopeSchema(projectOperationSchema);
export const projectOperationsResponseSchema = successEnvelopeSchema(projectOperationsDataSchema);
export const projectSummaryResponseSchema = projectResponseSchema;
export const projectScanPreviewResponseSchema = projectScanResponseSchema;
export const projectFileDetailResponseSchema = projectFileResponseSchema;

export type ProjectAvailability = z.infer<typeof projectAvailabilitySchema>;
export type ProjectParseStatus = z.infer<typeof projectParseStatusSchema>;
export type ProjectCategory = z.infer<typeof projectCategorySchema>;
export type ProjectWriteStatus = z.infer<typeof projectWriteStatusSchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type Project = ProjectSummary;
export type ProjectFile = z.infer<typeof projectFileSchema>;
export type ProjectFileDetail = z.infer<typeof projectFileDetailSchema>;
export type ProjectScanPreview = z.infer<typeof projectScanPreviewSchema>;
export type ProjectWriteAction = z.infer<typeof projectWriteActionSchema>;
export type ProjectOperation = z.infer<typeof projectOperationSchema>;
export type ProjectScanRequest = z.infer<typeof projectScanRequestSchema>;
export type ProjectBindRequest = z.infer<typeof projectBindRequestSchema>;
export type ProjectReconnectRequest = z.infer<typeof projectReconnectRequestSchema>;
export type ProjectFileQuery = z.infer<typeof projectFileQuerySchema>;
export type ProjectFileReadRequest = z.infer<typeof projectFileReadRequestSchema>;
export type ProjectWritePlanRequest = z.infer<typeof projectWritePlanRequestSchema>;

export interface ProjectService {
  scan(input: ProjectScanRequest): Promise<ProjectScanPreview>;
  bind(input: ProjectBindRequest): Promise<ProjectSummary>;
  reconnect(input: ProjectReconnectRequest): Promise<ProjectSummary>;
  list(): Promise<readonly ProjectSummary[]>;
  get(id: string): Promise<ProjectSummary>;
  refresh(id: string): Promise<ProjectSummary>;
  ensureFresh(id: string): Promise<ProjectSummary>;
  listFiles(input: ProjectFileQuery): Promise<z.infer<typeof projectFilesDataSchema>>;
  readFile(input: ProjectFileReadRequest): Promise<ProjectFileDetail>;
  context(id: string): Promise<Record<string, unknown>>;
}

export interface ProjectWritePlanService {
  create(input: ProjectWritePlanRequest): Promise<ProjectWriteAction>;
  confirm(id: string, clientRequestId: string): Promise<ProjectWriteAction>;
  cancel(id: string, clientRequestId: string): Promise<ProjectWriteAction>;
  project(id: string): Promise<ProjectSummary>;
  operations(projectId: string): Promise<z.infer<typeof projectOperationsDataSchema>>;
}

export type PersonalProjectService = ProjectService & ProjectWritePlanService;
