import { z } from 'zod';
import { successEnvelopeSchema } from './schemas.js';

/** Public project state. The canonical root is private server state. */
export const projectAvailabilitySchema = z.enum([
  'ready',
  'scanning',
  'unavailable',
  'reconnect-required'
]);

export const projectParseStatusSchema = z.enum([
  'readable',
  'unsupported',
  'too-large',
  'failed'
]);

export const projectCategorySchema = z.enum([
  '选题评估',
  '内容草稿',
  '周计划',
  '复盘草稿',
  '工作日志'
]);
export type ProjectCategory = z.infer<typeof projectCategorySchema>;

export const projectWriteStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'stale'
]);

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * A path crossing the public API is always relative to the selected project.
 * Reject empty segments as well as traversal and platform-specific absolute
 * path forms so a URL/query value can never become a filesystem path.
 */
export function isProjectRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  if (value.startsWith('/')) return false;
  if (/^[A-Za-z]:/u.test(value)) return false;
  const segments = value.split('/');
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

export const projectRelativePathSchema = z.string().min(1).max(4096)
  .refine(isProjectRelativePath, 'PROJECT_PATH_INVALID');

// Root paths are accepted only by the authenticated local scan endpoint. They
// are never part of a project/file/assistant response payload.
export const projectRootPathSchema = z.string().min(1).max(4096)
  .refine(value => !/[\u0000-\u001f\u007f]/u.test(value), 'PROJECT_ROOT_INVALID');

export const projectSummarySchema = z.strictObject({
  id: z.uuid(),
  displayName: z.string().min(1).max(255),
  sourceRevision: z.number().int().nonnegative(),
  availability: projectAvailabilitySchema,
  outputRoot: z.literal('AI工作区'),
  fileCount: z.number().int().nonnegative(),
  readableFileCount: z.number().int().nonnegative(),
  issueCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastScannedAt: z.string().optional()
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const projectScanRequestSchema = z.strictObject({
  rootPath: projectRootPathSchema
});

export const projectBindRequestSchema = z.strictObject({
  scanId: z.uuid(),
  sourceSha256: sha256Schema,
  displayName: z.string().min(1).max(255).optional()
});

// Reconnect uses the same scan proof as bind. In particular, it never accepts
// an arbitrary root path from a public caller.
export const projectReconnectRequestSchema = projectBindRequestSchema;

export const projectFileQuerySchema = z.strictObject({
  search: z.string().trim().max(200).optional(),
  origin: z.enum(['source', 'output']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

export const projectFileReadQuerySchema = z.strictObject({
  path: projectRelativePathSchema
});

export const projectIdParamSchema = z.strictObject({
  id: z.uuid()
});

export const projectFileSchema = z.strictObject({
  relativePath: projectRelativePathSchema,
  kind: z.enum(['file', 'directory']),
  bytes: z.number().int().nonnegative().optional(),
  modifiedAt: z.string().optional(),
  sha256: sha256Schema.optional(),
  parseStatus: projectParseStatusSchema.optional(),
  problem: z.string().max(1000).optional(),
  origin: z.enum(['source', 'output']).optional()
});
export type ProjectFile = z.infer<typeof projectFileSchema>;

export const projectFileDetailSchema = projectFileSchema.extend({
  content: z.string().optional(),
  totalCharacters: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional()
});
export type ProjectFileDetail = z.infer<typeof projectFileDetailSchema>;

export const projectScanPreviewSchema = z.strictObject({
  scanId: z.uuid(),
  displayName: z.string().min(1).max(255),
  sourceSha256: sha256Schema,
  fileCount: z.number().int().nonnegative(),
  readableFileCount: z.number().int().nonnegative(),
  unsupportedCount: z.number().int().nonnegative(),
  ignoredCount: z.number().int().nonnegative(),
  issueCount: z.number().int().nonnegative(),
  guidanceFiles: z.array(z.string().min(1).max(4096)).max(20),
  entries: z.array(projectFileSchema).max(20_000),
  issues: z.array(z.string().max(1000)).max(200),
  expiresAt: z.string()
});
export type ProjectScanPreview = z.infer<typeof projectScanPreviewSchema>;

export const projectWriteActionSchema = z.strictObject({
  id: z.uuid(),
  type: z.literal('project-write'),
  label: z.string().min(1).max(120),
  status: projectWriteStatusSchema,
  projectId: z.uuid(),
  projectName: z.string().min(1).max(255),
  category: projectCategorySchema,
  targetPath: projectRelativePathSchema,
  contentSha256: sha256Schema,
  sourceRevision: z.number().int().nonnegative(),
  summary: z.string().max(2000),
  createdAt: z.string(),
  expiresAt: z.string(),
  resultPath: projectRelativePathSchema.optional(),
  problem: z.string().max(2000).optional()
});
export type ProjectWriteAction = z.infer<typeof projectWriteActionSchema>;
export type AssistantProjectWriteAction = ProjectWriteAction;

export const projectOperationSchema = z.strictObject({
  id: z.uuid(),
  projectId: z.uuid(),
  eventType: z.string().min(1).max(120),
  targetPath: projectRelativePathSchema,
  oldSha256: sha256Schema.optional(),
  newSha256: sha256Schema.optional(),
  createdAt: z.string(),
  status: z.enum(['completed', 'failed', 'stale'])
});
export type ProjectOperation = z.infer<typeof projectOperationSchema>;

export const projectFilePageSchema = z.strictObject({
  items: z.array(projectFileSchema),
  total: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative()
});
export type ProjectFilePage = z.infer<typeof projectFilePageSchema>;

export const projectContextSchema = z.strictObject({
  id: z.uuid(),
  displayName: z.string().min(1).max(255),
  sourceRevision: z.number().int().nonnegative(),
  availability: projectAvailabilitySchema
});

export const projectFileResponseSchema = successEnvelopeSchema(projectFileDetailSchema);
export const projectScanPreviewResponseSchema = successEnvelopeSchema(projectScanPreviewSchema);
export const projectSummaryResponseSchema = successEnvelopeSchema(projectSummarySchema);
export const projectListResponseSchema = successEnvelopeSchema(z.strictObject({
  projects: z.array(projectSummarySchema)
}));
export const projectFilePageResponseSchema = successEnvelopeSchema(projectFilePageSchema);
export const projectOperationsResponseSchema = successEnvelopeSchema(z.strictObject({
  operations: z.array(projectOperationSchema)
}));

export type ProjectAvailability = z.infer<typeof projectAvailabilitySchema>;
export type ProjectParseStatus = z.infer<typeof projectParseStatusSchema>;
export type ProjectWriteStatus = z.infer<typeof projectWriteStatusSchema>;
export type ProjectContext = z.infer<typeof projectContextSchema>;
export type ProjectScanRequest = z.infer<typeof projectScanRequestSchema>;
export type ProjectBindRequest = z.infer<typeof projectBindRequestSchema>;
export type ProjectReconnectRequest = z.infer<typeof projectReconnectRequestSchema>;
export type ProjectFileQuery = z.infer<typeof projectFileQuerySchema>;
export type ProjectFileReadQuery = z.infer<typeof projectFileReadQuerySchema>;

export interface ProjectService {
  scan(rootPath: string, signal?: AbortSignal): Promise<ProjectScanPreview>;
  bind(scanId: string, input: { sourceSha256: string; displayName?: string }): Promise<ProjectSummary>;
  reconnect(id: string, scanId: string, input: { sourceSha256: string; displayName?: string }): Promise<ProjectSummary>;
  list(): Promise<readonly ProjectSummary[]>;
  get(id: string): Promise<ProjectSummary>;
  refresh(id: string, signal?: AbortSignal): Promise<ProjectSummary>;
  ensureFresh(id: string, signal?: AbortSignal): Promise<ProjectSummary>;
  listFiles(id: string, query: { search?: string; origin?: 'source' | 'output'; limit?: number }): Promise<ProjectFilePage>;
  readFile(id: string, relativePath: string): Promise<ProjectFileDetail>;
  context(id: string): Promise<ProjectContext>;
}

export interface ProjectWritePlanService {
  proposeDraft(input: {
    projectId: string;
    conversationId: string;
    messageId: string;
    category: ProjectCategory;
    title: string;
    summary: string;
    content: string;
    expectedRevision: number;
  }): Promise<ProjectWriteAction>;
  confirm(planId: string, conversationId: string, clientRequestId: string): Promise<ProjectWriteAction>;
  cancel(planId: string, conversationId: string, clientRequestId: string): ProjectWriteAction;
  project(planId: string, conversationId?: string): ProjectWriteAction | undefined;
  operations(projectId: string): Promise<readonly ProjectOperation[]>;
}

export type PersonalProjectService = ProjectService & ProjectWritePlanService;
