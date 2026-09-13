import { describe, expect, it } from 'vitest';
import { buildLibraryCatalog } from '../../src/server/services/library-catalog.js';
import { libraryPageSchema, libraryQuerySchema } from '../../src/shared/api/library.js';
import type { KnowledgeRecord, MaterialRecord } from '../../src/shared/domain/records.js';

function material(path: string, extra: Partial<MaterialRecord> = {}): MaterialRecord {
  return { path, title: path.split('/').at(-1)!.slice(0, -3), rawSha256: 'a'.repeat(64), sourcePlatform: 'B站',
    knowledgeStatus: '未提炼', processingStatus: '已归档', generatedKnowledge: [], ...extra };
}
function knowledge(path: string, extra: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
  return { path, title: path.split('/').at(-1)!.slice(0, -3), rawSha256: 'b'.repeat(64), sourceType: 'AI提炼',
    usageStatus: '定论', knowledgeType: '方法', recallFields: { topics: [], keywords: [], scenarios: [], conclusion: '', keyPoints: [], boundary: '' },
    sourceMaterials: [], ...extra };
}

describe('library catalog', () => {
  it('opens real source directories containing literal percent tokens without decoding them', () => {
    for (const name of ['API%2FURL规范', '%2e%2e', '内容%5C格式']) {
      const parent = '来自公众号/2026-09';
      const directory = `${parent}/${name}`;
      const original = material(`01图书馆/${directory}/原文.md`);
      const input = { materials: [original], knowledge: [], trashed: new Set<string>() };
      const folders = buildLibraryCatalog({ ...input, query: { mode: 'source', path: parent } }).folders;
      expect(folders[0]?.path).toBe(directory);
      expect(buildLibraryCatalog({ ...input, query: { mode: 'source', path: folders[0]!.path } }).items).toEqual([original]);
    }
  });

  it('never resolves a missing explicit generated knowledge path through another note title', () => {
    for (const reference of ['02知识库/01AI/不存在.md', '01AI/不存在', '不存在.md']) {
      const original = material('01图书馆/来自B站/原文.md', { generatedKnowledge: [reference] });
      const misleading = knowledge('02知识库/02其他/另一个文件.md', { title: reference });
      expect(buildLibraryCatalog({ materials: [original], knowledge: [misleading], trashed: new Set(), query: {} }))
        .toMatchObject({ total: 1, unclassifiedCount: 1, folders: [{ path: '@unclassified' }] });
    }
  });

  it('resolves existing explicit paths despite an unrelated title with identical text', () => {
    const target = knowledge('02知识库/01AI/正确知识.md');
    const misleading = knowledge('02知识库/02其他/另一个文件.md', { title: target.path });
    const original = material('01图书馆/来自B站/原文.md', { generatedKnowledge: [target.path] });
    expect(buildLibraryCatalog({ materials: [original], knowledge: [target, misleading], trashed: new Set(), query: {} }))
      .toMatchObject({ total: 1, unclassifiedCount: 0, folders: [{ path: '01AI', count: 1 }] });
  });

  it('does not resolve explicit reverse-source or topic-directory paths through display titles', () => {
    const missingSource = '01图书馆/来自B站/不存在.md';
    const original = material('01图书馆/来自B站/真实原文.md', { title: missingSource, topics: ['02知识库/01AI/不存在目录'] });
    const misleading = knowledge('02知识库/02其他/另一个文件.md', {
      title: '02知识库/01AI/不存在目录', sourceMaterials: [missingSource]
    });
    expect(buildLibraryCatalog({ materials: [original], knowledge: [misleading], trashed: new Set(), query: {} }))
      .toMatchObject({ total: 1, unclassifiedCount: 1, folders: [{ path: '@unclassified' }] });
  });

  it('keeps hidden and filtered originals in the identity set for reference ambiguity', () => {
    const visible = material('01图书馆/来自B站/待显示.md', { generatedKnowledge: ['同名知识'] });
    const hidden = material('01图书馆/来自B站/隐藏.md', { title: '同名知识', knowledgeStatus: '已入库' });
    const catalog = buildLibraryCatalog({ materials: [visible, hidden],
      knowledge: [knowledge('02知识库/01方法/同名知识.md')], trashed: new Set([hidden.path]), query: { status: '未提炼' } });
    expect(catalog).toMatchObject({ total: 1, unclassifiedCount: 1, folders: [{ path: '@unclassified', count: 1 }] });
  });

  it('preserves Unicode filesystem identities while resolving normalized metadata aliases', () => {
    const original = material('01图书馆/来自B站/cafe\u0301.md', { topics: ['[[02知识库/01学习/café#知识|显示别名]]'] });
    const catalog = buildLibraryCatalog({ materials: [original], knowledge: [knowledge('02知识库/01学习/cafe\u0301.md')],
      trashed: new Set(), query: { mode: 'topic', path: '01学习' } });
    expect(catalog.items[0]?.path).toBe(original.path);
    expect(catalog).toMatchObject({ total: 1, directTotal: 1, unclassifiedCount: 0 });
  });

  it('does not infer a topic from titles or traverse dangerous metadata paths', () => {
    const original = material('01图书馆/来自B站/学习方法.md', {
      topics: ['图中示例', '02知识库/../01学习', 'https://example.test/01学习'],
      generatedKnowledge: ['02知识库/%2e%2e/01学习/学习.md', '/02知识库/01学习/学习.md', '02知识库\\01学习\\学习.md']
    });
    const catalog = buildLibraryCatalog({ materials: [original], knowledge: [knowledge('02知识库/01学习/真实.md')],
      trashed: new Set(), query: { path: '@unclassified' } });
    expect(catalog).toMatchObject({ total: 1, directTotal: 1, unclassifiedCount: 1, items: [original] });
  });

  it('resolves a unique real directory basename or numbered display label without guessing', () => {
    const original = material('01图书馆/来自B站/原文.md', { topics: ['AI工具'] });
    for (const directory of ['01AI/AI工具', '01AI/03AI工具']) {
      const catalog = buildLibraryCatalog({ materials: [original], knowledge: [knowledge(`02知识库/${directory}/使用经验.md`)],
        trashed: new Set(), query: { path: directory } });
      expect(catalog).toMatchObject({ total: 1, directTotal: 1, unclassifiedCount: 0, items: [original] });
    }
  });

  it('leaves a plain topic unclassified when its label matches different real directories or a note', () => {
    const original = material('01图书馆/来自B站/原文.md', { topics: ['AI工具'] });
    const primary = knowledge('02知识库/01AI/03AI工具/使用经验.md');
    const ambiguous = [knowledge('02知识库/02创作/AI工具/比较.md'), knowledge('02知识库/02创作/AI工具.md')];
    for (const duplicate of ambiguous) {
      const catalog = buildLibraryCatalog({ materials: [original], knowledge: [primary, duplicate], trashed: new Set(), query: {} });
      expect(catalog).toMatchObject({ total: 1, unclassifiedCount: 1, folders: [{ path: '@unclassified', count: 1 }] });
    }
    const exact = { ...original, topics: ['02知识库/01AI/03AI工具'] };
    expect(buildLibraryCatalog({ materials: [exact], knowledge: [primary, ...ambiguous], trashed: new Set(),
      query: { path: '01AI/03AI工具' } }).items).toEqual([exact]);
  });

  it('keeps source parent paths instead of replacing them with metadata dates or platform labels', () => {
    const original = material('01图书馆/来自B站/2026-08/资料包/子文件/原文.md', { sourcePlatform: 'YouTube', collectedAt: '2026-09-07' });
    const catalog = buildLibraryCatalog({ materials: [original], knowledge: [], trashed: new Set(),
      query: { mode: 'source', path: '来自B站/2026-08/资料包' } });
    expect(catalog).toMatchObject({ total: 1, directTotal: 0, items: [],
      folders: [{ path: '来自B站/2026-08/资料包/子文件', label: '子文件', count: 1, folderCount: 0 }] });
  });

  it('strictly validates query bounds, counts, and default all-state semantics', () => {
    expect(libraryQuerySchema.parse({})).toEqual({ mode: 'topic', path: '' });
    expect(libraryQuerySchema.safeParse({ status: 'all' }).success).toBe(false);
    expect(libraryQuerySchema.safeParse({ mode: 'tag' }).success).toBe(false);
    expect(libraryQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(libraryQuerySchema.safeParse({ mode: 'source', unexpected: true }).success).toBe(false);
    const empty = buildLibraryCatalog({ materials: [], knowledge: [], trashed: new Set(), query: {} });
    expect(libraryPageSchema.safeParse({ ...empty, indexVersion: 7 }).success).toBe(true);
    expect(libraryPageSchema.safeParse({ ...empty, indexVersion: 7, total: -1 }).success).toBe(false);
  });
});
