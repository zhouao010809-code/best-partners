import { z } from 'zod';
import {
  companyDataCoverageSchema,
  companyMetricImportStateSchema,
  companyMetricSnapshotSchema,
  companyPlatformSchema,
  companyWorkspaceRelativePathSchema
} from '../company/metrics.js';
import { successEnvelopeSchema } from './schemas.js';

const idSchema = z.string().min(1).max(256);
const dateTimeSchema = z.string().datetime({ offset: true });
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const companyMetricImportIssueSchema = z.object({
  row: z.number().int().min(1),
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(1000)
}).strict();

export const companyMetricImportSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  projectId: idSchema,
  platform: companyPlatformSchema,
  sourceRelativePath: companyWorkspaceRelativePathSchema,
  rawRelativePath: companyWorkspaceRelativePathSchema.nullable(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceType: z.literal('official-export'),
  state: companyMetricImportStateSchema,
  rowCount: z.number().int().nonnegative(),
  importedCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  issues: z.array(companyMetricImportIssueSchema).max(1000),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
  importedAt: dateTimeSchema.nullable()
}).strict();

export const companyMetricSnapshotPublicSchema = companyMetricSnapshotSchema;

// A projection can legitimately have no imported metric yet.  Snapshots use
// the stricter non-empty schema; dashboard totals may therefore be an empty
// object while coverage communicates why no number is shown.
export const companyMetricTotalsSchema = z.object({
  views: z.number().int().nonnegative().optional(),
  likes: z.number().int().nonnegative().optional(),
  comments: z.number().int().nonnegative().optional(),
  shares: z.number().int().nonnegative().optional(),
  saves: z.number().int().nonnegative().optional(),
  followers: z.number().int().nonnegative().optional(),
  leads: z.number().int().nonnegative().optional()
}).strict();

export const companyPlatformMetricsSummarySchema = z.object({
  platform: companyPlatformSchema,
  coverage: companyDataCoverageSchema,
  snapshotCount: z.number().int().nonnegative(),
  contentCount: z.number().int().nonnegative(),
  totals: companyMetricTotalsSchema,
  latestMetricDate: dateSchema.nullable(),
  latestObservedAt: dateTimeSchema.nullable(),
  lastImportedAt: dateTimeSchema.nullable()
}).strict();

export const companyProjectMetricsSchema = z.object({
  projectId: idSchema,
  coverage: companyDataCoverageSchema,
  snapshotCount: z.number().int().nonnegative(),
  contentCount: z.number().int().nonnegative(),
  totals: companyMetricTotalsSchema,
  latestMetricDate: dateSchema.nullable(),
  latestObservedAt: dateTimeSchema.nullable(),
  lastImportedAt: dateTimeSchema.nullable(),
  platforms: z.array(companyPlatformMetricsSummarySchema),
  recentImports: z.array(companyMetricImportSchema).max(100)
}).strict();

export const companyMetricsStatusSchema = z.object({
  coverage: companyDataCoverageSchema,
  platforms: z.array(companyPlatformMetricsSummarySchema),
  recentImports: z.array(companyMetricImportSchema).max(100),
  lastScanAt: dateTimeSchema.nullable()
}).strict();

export const companyMetricImportRequestSchema = z.object({
  sourcePath: companyWorkspaceRelativePathSchema
    .refine(value => {
      const segments = value.split('/');
      return segments.length >= 4
        && segments[0] === 'platform-data'
        && companyPlatformSchema.safeParse(segments[1]).success
        && segments[1] !== 'raw'
        && /^[A-Za-z0-9._:-]+$/u.test(segments[2] ?? '');
    }, 'Source must be a platform-data/<platform>/<projectId>/... export path')
}).strict();

export const companyMetricScanResponseDataSchema = z.object({
  scanned: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  partial: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  conflict: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  imports: z.array(companyMetricImportSchema).max(1000),
  scannedAt: dateTimeSchema
}).strict();

export const companyProjectMetricsResponseSchema = successEnvelopeSchema(companyProjectMetricsSchema);
export const companyMetricsStatusResponseSchema = successEnvelopeSchema(companyMetricsStatusSchema);
export const companyMetricImportResponseSchema = successEnvelopeSchema(companyMetricImportSchema);
export const companyMetricScanResponseSchema = successEnvelopeSchema(companyMetricScanResponseDataSchema);

export type CompanyMetricImport = z.infer<typeof companyMetricImportSchema>;
export type CompanyMetricImportIssue = z.infer<typeof companyMetricImportIssueSchema>;
export type CompanyMetricSnapshotPublic = z.infer<typeof companyMetricSnapshotPublicSchema>;
export type CompanyPlatformMetricsSummary = z.infer<typeof companyPlatformMetricsSummarySchema>;
export type CompanyProjectMetrics = z.infer<typeof companyProjectMetricsSchema>;
export type CompanyMetricsStatus = z.infer<typeof companyMetricsStatusSchema>;
export type CompanyMetricImportRequest = z.infer<typeof companyMetricImportRequestSchema>;
export type CompanyMetricScanResponseData = z.infer<typeof companyMetricScanResponseDataSchema>;
