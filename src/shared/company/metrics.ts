import { z } from 'zod';

/** Platforms supported by the first company metrics ingestion slice. */
export const companyPlatformSchema = z.enum([
  'douyin',
  'xiaohongshu',
  'wechat-channels'
]);

export type CompanyPlatform = z.infer<typeof companyPlatformSchema>;

/**
 * Metadata accepted from the browser upload surface.  A filename is only a
 * display/evidence label; it must never be allowed to select a directory or
 * escape the project-scoped platform drop folder.
 */
export const companyMetricUploadMetadataSchema = z.object({
  platform: companyPlatformSchema,
  fileName: z.string()
    .min(1)
    .max(255)
    .refine(value => !value.includes('\0') && !value.includes('/') && !value.includes('\\'), 'Filename must not contain a path')
    .refine(value => /\.(?:csv|xlsx|xls)$/iu.test(value), 'Only CSV, XLSX, and XLS files are supported')
}).strict();

export type CompanyMetricUploadMetadata = z.infer<typeof companyMetricUploadMetadataSchema>;

export const companyMetricNameSchema = z.enum([
  'views',
  'likes',
  'comments',
  'shares',
  'saves',
  'followers',
  'leads'
]);

export type CompanyMetricName = z.infer<typeof companyMetricNameSchema>;

const nonNegativeMetric = z.number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

/**
 * A snapshot only carries metrics that the source actually supplied.  An
 * absent metric is intentionally different from zero: the dashboard must not
 * turn an unsupported/export-missing value into a made-up number.
 */
export const companyMetricValuesSchema = z.object({
  views: nonNegativeMetric.optional(),
  likes: nonNegativeMetric.optional(),
  comments: nonNegativeMetric.optional(),
  shares: nonNegativeMetric.optional(),
  saves: nonNegativeMetric.optional(),
  followers: nonNegativeMetric.optional(),
  leads: nonNegativeMetric.optional()
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'At least one metric is required'
});

export type CompanyMetricValues = z.infer<typeof companyMetricValuesSchema>;

const safeIdentifier = z.string().min(1).max(256);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

/** A workspace-relative path; absolute and traversal paths are never accepted. */
export const companyWorkspaceRelativePathSchema = z.string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'), 'Path contains NUL')
  .refine((value) => !value.includes('\\'), 'Path must use forward slashes')
  .refine((value) => !value.startsWith('/'), 'Path must be relative')
  .refine((value) => !/^[A-Za-z]:\//u.test(value), 'Path must be relative')
  .refine((value) => value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'), 'Path contains unsafe segments');

export type CompanyWorkspaceRelativePath = z.infer<typeof companyWorkspaceRelativePathSchema>;

export const companyMetricSnapshotSchema = z.object({
  id: safeIdentifier,
  workspaceId: safeIdentifier,
  projectId: safeIdentifier,
  platform: companyPlatformSchema,
  accountRef: safeIdentifier.optional(),
  contentId: safeIdentifier,
  contentTitle: z.string().max(1024).optional(),
  metricDate: dateSchema,
  metricKind: z.literal('cumulative'),
  observedAt: z.string().datetime({ offset: true }),
  metrics: companyMetricValuesSchema,
  sourceType: z.literal('official-export'),
  sourceRelativePath: companyWorkspaceRelativePathSchema,
  rawRelativePath: companyWorkspaceRelativePathSchema,
  sourceSha256: sha256Schema,
  sourceRow: z.number().int().min(2),
  headerRow: z.number().int().min(1),
  sheetName: z.string().min(1).max(255),
  rawRowSha256: sha256Schema,
  createdAt: z.string().datetime({ offset: true })
}).strict();

export type CompanyMetricSnapshot = z.infer<typeof companyMetricSnapshotSchema>;

/** States shown by the dashboard when a platform is not a plain number. */
export const companyDataCoverageSchema = z.enum([
  'not_configured',
  'connected',
  'stale',
  'import_required',
  'error',
  'attention'
]);

export type CompanyDataCoverage = z.infer<typeof companyDataCoverageSchema>;

export const companyMetricImportStateSchema = z.enum([
  'imported',
  'partial',
  'duplicate',
  'conflict',
  'failed'
]);

export type CompanyMetricImportState = z.infer<typeof companyMetricImportStateSchema>;
