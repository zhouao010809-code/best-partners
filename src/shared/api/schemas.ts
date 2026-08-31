import { z } from 'zod';

export const API_VERSION = 1;
export const MAX_CURSOR_LENGTH = 12_288;

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const vaultPathSchema = z.string().min(1).max(1024);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const operationIdSchema = z.string().min(1).max(128).regex(/^[a-z0-9._:-]+$/iu);
const opaqueCursorSchema = z.string()
  .max(MAX_CURSOR_LENGTH)
  .regex(/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/u);

export const knowledgeStatusSchema = z.enum(['未提炼', '部分入库', '已入库']);
export const usageStatusSchema = z.enum(['AI总结', '已优化', '定论', '过时']);

export const materialRecordSchema = z.object({
  path: vaultPathSchema,
  rawSha256: sha256Schema,
  upstreamVersion: z.string().min(1).max(512).optional(),
  title: z.string().min(1).max(1000),
  sourcePlatform: z.string().min(1).max(128),
  processingStatus: z.enum(['未归档', '已归档']),
  knowledgeStatus: knowledgeStatusSchema,
  collectedAt: z.string().max(64).optional(),
  generatedKnowledge: z.array(z.string().max(1024)).max(1000)
}).strict();

export const knowledgeRecordSchema = z.object({
  path: vaultPathSchema,
  rawSha256: sha256Schema,
  upstreamVersion: z.string().min(1).max(512).optional(),
  title: z.string().min(1).max(1000),
  sourceType: z.enum(['AI提炼', '人工输入']),
  usageStatus: usageStatusSchema,
  knowledgeType: z.string().min(1).max(128),
  recallFields: z.object({
    topics: z.array(z.string().max(512)).max(1000),
    keywords: z.array(z.string().max(512)).max(1000),
    scenarios: z.array(z.string().max(2000)).max(1000),
    conclusion: z.string().max(100_000),
    keyPoints: z.array(z.string().max(10_000)).max(1000),
    boundary: z.string().max(100_000)
  }).strict(),
  sourceMaterials: z.array(z.string().max(1024)).max(1000)
}).strict();

export const schemaIssueSchema = z.object({
  path: vaultPathSchema,
  code: z.enum(['FRONTMATTER_INVALID', 'UNEXPECTED_TYPE', 'INVALID_FIELD']),
  message: z.string().min(1).max(1000),
  field: z.string().min(1).max(256).optional()
}).strict();

export const materialQuerySchema = z.object({
  status: knowledgeStatusSchema.optional(),
  sourcePlatform: z.string().min(1).max(128).optional(),
  collectedFrom: isoDateSchema.optional(),
  collectedTo: isoDateSchema.optional(),
  title: z.string().min(1).max(1000).optional(),
  cursor: opaqueCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
}).strict().superRefine((query, context) => {
  if (
    query.collectedFrom !== undefined
    && query.collectedTo !== undefined
    && query.collectedFrom > query.collectedTo
  ) {
    context.addIssue({
      code: 'custom',
      path: ['collectedTo'],
      message: 'collectedTo must not precede collectedFrom'
    });
  }
});

export const knowledgeQuerySchema = z.object({
  search: z.string().min(1).max(1000).optional(),
  includeObsolete: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  usageStatus: usageStatusSchema.optional(),
  knowledgeType: z.string().min(1).max(128).optional(),
  topic: z.string().min(1).max(512).optional(),
  cursor: opaqueCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
}).strict();

export const knowledgeFileQuerySchema = z.object({ path: vaultPathSchema }).strict();
export const knowledgeOpenBodySchema = z.object({ path: vaultPathSchema }).strict();
export const rebuildBodySchema = z.object({ indexVersion: z.number().int().nonnegative() }).strict();
export const rebuildHeadersSchema = z.object({
  'idempotency-key': z.string().min(1).max(128).regex(/^[a-z0-9._:-]+$/iu)
}).passthrough();
export const indexJobParamsSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-z0-9._:-]+$/iu)
}).strict();

export const materialPageSchema = z.object({
  items: z.array(materialRecordSchema),
  nextCursor: opaqueCursorSchema.optional()
}).strict();

export const knowledgePageSchema = z.object({
  items: z.array(knowledgeRecordSchema),
  nextCursor: opaqueCursorSchema.optional()
}).strict();

export const operationPageSchema = z.object({
  items: z.array(z.never()),
  nextCursor: opaqueCursorSchema.optional()
}).strict();

export const liveKnowledgeDetailSchema = z.object({
  path: vaultPathSchema,
  title: z.string().min(1).max(1000),
  markdown: z.string(),
  versionMarker: z.object({
    rawSha256: sha256Schema,
    upstreamVersion: z.string().min(1).max(512).optional()
  }).strict()
}).strict();

export const openKnowledgeResultSchema = z.object({
  opened: z.literal(true),
  path: vaultPathSchema
}).strict();

export const indexJobSchema = z.object({
  id: z.string().min(1).max(128),
  operationId: operationIdSchema,
  status: z.enum(['queued', 'running', 'completed', 'failed', 'interrupted']),
  requestedIndexVersion: z.number().int().nonnegative(),
  indexVersion: z.number().int().nonnegative(),
  progress: z.object({
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative()
  }).strict(),
  errorCode: z.string().min(1).max(128).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

export const healthSnapshotSchema = z.object({
  status: z.enum(['ready', 'recovery-only']),
  plugin: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('connected'),
      pluginId: z.string().min(1).max(128).regex(/^[a-z0-9._-]+$/iu),
      pluginVersion: z.string().min(1).max(64).regex(/^[a-z0-9.+_-]+$/iu),
      obsidianVersion: z.string().min(1).max(64).regex(/^[a-z0-9.+_-]+$/iu)
    }).strict(),
    z.object({
      status: z.literal('unavailable'),
      reason: z.literal('PLUGIN_UNAVAILABLE')
    }).strict()
  ]),
  index: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('building'),
      startedAt: z.string().datetime()
    }).strict(),
    z.object({
      status: z.literal('ready'),
      version: z.number().int().nonnegative(),
      refreshedAt: z.string().datetime()
    }).strict(),
    z.object({
      status: z.literal('stale'),
      version: z.number().int().nonnegative(),
      lastSuccessAt: z.string().datetime(),
      reason: z.literal('INDEX_STALE')
    }).strict(),
    z.object({
      status: z.literal('failed'),
      lastSuccessAt: z.string().datetime().optional(),
      reason: z.literal('INDEX_FAILED')
    }).strict(),
    z.object({
      status: z.literal('unavailable'),
      reason: z.enum(['RECOVERY_ONLY', 'READ_API_UNAVAILABLE'])
    }).strict()
  ]),
  model: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('configured'),
      providerHost: z.string().min(1).max(253).regex(/^[^\s@/?#]+$/u),
      name: z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/u)
    }).strict(),
    z.object({
      status: z.literal('unconfigured'),
      providerHost: z.string().min(1).max(253).regex(/^[^\s@/?#]+$/u)
    }).strict(),
    z.object({
      status: z.literal('unavailable'),
      reason: z.literal('CONFIG_UNAVAILABLE')
    }).strict()
  ]),
  writeGate: z.object({
    status: z.enum(['blocked', 'enabled']),
    missing: z.array(z.string().max(128)),
    fingerprintMatches: z.boolean()
  }).strict(),
  schemaIssues: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('available'),
      count: z.number().int().nonnegative()
    }).strict(),
    z.object({
      status: z.literal('unavailable'),
      count: z.literal(0),
      reason: z.enum(['INDEX_UNAVAILABLE', 'SCHEMA_ISSUES_UNAVAILABLE'])
    }).strict()
  ])
}).strict();

export function successEnvelopeSchema<T extends z.ZodType>(data: T) {
  return z.object({
    data,
    version: z.literal(API_VERSION),
    operationId: operationIdSchema.optional()
  }).strict();
}

export const apiFailureSchema = z.object({
  error: z.object({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(1000),
    operationId: operationIdSchema,
    fields: z.record(z.string(), z.string()).optional()
  }).strict()
}).strict();

export const materialPageResponseSchema = successEnvelopeSchema(materialPageSchema);
export const knowledgePageResponseSchema = successEnvelopeSchema(knowledgePageSchema);
export const liveKnowledgeDetailResponseSchema = successEnvelopeSchema(liveKnowledgeDetailSchema);
export const openKnowledgeResponseSchema = successEnvelopeSchema(openKnowledgeResultSchema);
export const operationPageResponseSchema = successEnvelopeSchema(operationPageSchema);
export const indexJobResponseSchema = successEnvelopeSchema(indexJobSchema);
export const healthResponseSchema = successEnvelopeSchema(healthSnapshotSchema);
