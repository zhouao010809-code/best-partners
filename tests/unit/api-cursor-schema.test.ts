import { describe, expect, it } from 'vitest';
import {
  API_VERSION,
  MAX_CURSOR_LENGTH,
  bootstrapDataSchema,
  bootstrapResponseSchema,
  healthSnapshotSchema,
  knowledgeRecordSchema,
  knowledgeQuerySchema,
  materialRecordSchema,
  materialQuerySchema
} from '../../src/shared/api/schemas.js';

describe('API cursor schema', () => {
  it('accepts a cursor containing the worst-case JSON encoding of a maximum path', () => {
    const body = Buffer.from(JSON.stringify({
      version: 1,
      kind: 'material',
      filterSha256: 'a'.repeat(64),
      indexVersion: Number.MAX_SAFE_INTEGER,
      afterPath: '\u0001'.repeat(1024)
    }), 'utf8').toString('base64url');
    const worstCaseCursor = `${body}.${'b'.repeat(64)}`;
    const maximumCursor = `${'a'.repeat(MAX_CURSOR_LENGTH - 65)}.${'b'.repeat(64)}`;
    const oversizedCursor = `a${maximumCursor}`;

    expect(worstCaseCursor.length).toBeGreaterThan(8192);
    expect(materialQuerySchema.safeParse({ cursor: worstCaseCursor }).success).toBe(true);
    expect(knowledgeQuerySchema.safeParse({ cursor: worstCaseCursor }).success).toBe(true);
    expect(maximumCursor).toHaveLength(MAX_CURSOR_LENGTH);
    expect(materialQuerySchema.safeParse({ cursor: maximumCursor }).success).toBe(true);
    expect(materialQuerySchema.safeParse({ cursor: oversizedCursor }).success).toBe(false);
  });
});

describe('read-console shared schemas', () => {
  const material = {
    path: '01图书馆/资料.md',
    rawSha256: 'a'.repeat(64),
    title: '资料',
    sourcePlatform: 'B站',
    processingStatus: '未归档',
    knowledgeStatus: '未提炼',
    generatedKnowledge: []
  };
  const knowledge = {
    path: '02知识库/知识.md',
    rawSha256: 'b'.repeat(64),
    title: '知识',
    sourceType: 'AI提炼',
    usageStatus: 'AI总结',
    knowledgeType: '方法',
    recallFields: {
      topics: [],
      keywords: [],
      scenarios: [],
      conclusion: '',
      keyPoints: [],
      boundary: ''
    },
    sourceMaterials: []
  };

  it('accepts only valid optional ISO calendar dates on shared records and queries', () => {
    expect(materialRecordSchema.safeParse({ ...material, collectedAt: '2024-02-29' }).success)
      .toBe(true);
    expect(materialRecordSchema.safeParse({ ...material, collectedAt: '2026-02-29' }).success)
      .toBe(false);
    expect(knowledgeRecordSchema.safeParse({
      ...knowledge,
      createdAt: '2026-08-30',
      updatedAt: '2026-08-31'
    }).success).toBe(true);
    expect(knowledgeRecordSchema.safeParse({ ...knowledge, updatedAt: '2026-04-31' }).success)
      .toBe(false);
    expect(materialQuerySchema.safeParse({ collectedFrom: '2026-02-29' }).success).toBe(false);
  });

  it('requires safe index versions even while health is building or failed', () => {
    const base = {
      status: 'ready',
      vaultSource: { status: 'unavailable', reason: 'VAULT_UNAVAILABLE' },
      model: { status: 'unavailable', reason: 'CONFIG_UNAVAILABLE' },
      writeGate: { status: 'blocked', missing: [], fingerprintMatches: false },
      schemaIssues: { status: 'unavailable', count: 0, reason: 'INDEX_UNAVAILABLE' }
    };

    expect(healthSnapshotSchema.safeParse({
      ...base,
      index: { status: 'building', version: 0, startedAt: '2026-09-01T00:00:00.000Z' }
    }).success).toBe(true);
    expect(healthSnapshotSchema.safeParse({
      ...base,
      index: { status: 'failed', version: 0, reason: 'INDEX_FAILED' }
    }).success).toBe(true);
    expect(healthSnapshotSchema.safeParse({
      ...base,
      index: { status: 'failed', version: -1, reason: 'INDEX_FAILED' }
    }).success).toBe(false);
  });

  it('exports strict bootstrap schemas with an exact base64url-43 CSRF token', () => {
    const token = 'A'.repeat(43);

    expect(bootstrapDataSchema.safeParse({ csrfToken: token }).success).toBe(true);
    expect(bootstrapDataSchema.safeParse({ csrfToken: 'A'.repeat(42) }).success).toBe(false);
    expect(bootstrapDataSchema.safeParse({ csrfToken: `${'A'.repeat(42)}+` }).success).toBe(false);
    expect(bootstrapDataSchema.safeParse({ csrfToken: `${token}=` }).success).toBe(false);
    expect(bootstrapDataSchema.safeParse({ csrfToken: token, extra: true }).success).toBe(false);
    expect(bootstrapResponseSchema.safeParse({
      data: { csrfToken: token },
      version: API_VERSION
    }).success).toBe(true);
    expect(bootstrapResponseSchema.safeParse({
      data: { csrfToken: token },
      version: API_VERSION,
      extra: true
    }).success).toBe(false);
  });
});
