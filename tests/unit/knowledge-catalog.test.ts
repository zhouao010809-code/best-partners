import { expect, it } from 'vitest';
import { knowledgeCatalogPageSchema, knowledgeCatalogQuerySchema } from '../../src/shared/api/knowledge-catalog.js';
import { buildKnowledgeCatalog, knowledgeDirectoryPath, readKnowledgeDirectory } from '../../src/server/services/knowledge-catalog.js';
import type { KnowledgeRecord } from '../../src/shared/domain/records.js';

const note: KnowledgeRecord = { path: '02知识库/01AI/工具/a.md', title: '知识', rawSha256: 'a'.repeat(64),
  sourceType: 'AI提炼', usageStatus: 'AI总结', knowledgeType: '方法', sourceMaterials: [],
  recallFields: { topics: [], keywords: [], scenarios: [], conclusion: '结论', keyPoints: [], boundary: '边界' } };

it('keeps the HTTP query bounded and strict while sharing existing knowledge filter semantics', () => {
  expect(knowledgeCatalogQuerySchema.parse({})).toEqual({ path: '' });
  expect(knowledgeCatalogQuerySchema.parse({ path: '01AI/工具', includeObsolete: 'false', usageStatus: '定论', limit: '200' }))
    .toEqual({ path: '01AI/工具', includeObsolete: false, usageStatus: '定论', limit: 200 });
  for (const query of [{ folder: '01AI' }, { limit: 201 }, { path: 'a'.repeat(1025) }, { usageStatus: '成熟' }, { includeObsolete: 'yes' }]) {
    expect(knowledgeCatalogQuerySchema.safeParse(query).success).toBe(false);
  }
});

it('rejects internally impossible catalog counts rather than exposing a misleading result total', () => {
  const page = { path: '', breadcrumbs: [{ path: '', label: '知识书柜' }], folders: [], items: [], total: 1, directTotal: 0, indexVersion: 7 };
  expect(knowledgeCatalogPageSchema.safeParse(page).success).toBe(true);
  for (const invalid of [{ ...page, directTotal: 2 }, { ...page, items: [note] },
    { ...page, folders: [{ path: '01AI', label: 'AI', count: 2 }] }]) {
    expect(knowledgeCatalogPageSchema.safeParse(invalid).success).toBe(false);
  }
});

it('preserves literal percent tokens and decomposed Unicode in directory identities', () => {
  const path = '01AI/%2e%2e/cafe\u0301';
  expect(knowledgeDirectoryPath(path)).toBe(`02知识库/${path}`);
  const catalog = buildKnowledgeCatalog({ path, entries: ['01工具/'], records: [] });
  expect(catalog).toMatchObject({ path, breadcrumbs: [{ path: '', label: '知识书柜' }, { path: '01AI', label: 'AI' },
    { path: '01AI/%2e%2e', label: '%2e%2e' }, { path, label: 'cafe\u0301' }], folders: [{ path: `${path}/01工具`, label: '工具', count: 0 }] });
});

it('keeps hidden entries out of the visible listing without reading note bodies', async () => {
  const entries = await readKnowledgeDirectory({ listDirectory: async () => ['.hidden/', '工具/', 'b.md', '100%.md'],
    readRaw: async () => { throw new Error('must not read Markdown'); } }, '01AI');
  expect(entries).toEqual(['100%.md', 'b.md', '工具/']);
});

it('uses complete path segments to keep similarly named sibling directories separate', () => {
  const catalog = buildKnowledgeCatalog({ path: '01AI/工具', entries: ['空目录/'], records: [note,
    { ...note, path: '02知识库/01AI/工具箱/b.md' }, { ...note, path: '02知识库/01AI/工具/子目录/c.md' }] });
  expect(catalog).toMatchObject({ total: 2, directTotal: 1, items: [note], folders: [{ path: '01AI/工具/空目录', count: 0 }] });
});
