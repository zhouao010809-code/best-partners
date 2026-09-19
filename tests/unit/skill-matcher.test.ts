import { expect, it, vi } from 'vitest';
import { createSkillMatcherService } from '../../src/server/services/skill-matcher.js';
import type { SkillCatalogService } from '../../src/server/services/skill-catalog.js';
import type { SkillDetail } from '../../src/shared/api/skills.js';

const revision = 'b'.repeat(64);

function detail(input: Partial<SkillDetail> & Pick<SkillDetail, 'id' | 'name'>): SkillDetail {
  return {
    description: 'No description provided.',
    revision,
    folderId: null,
    folderName: null,
    markdown: '',
    references: [],
    ...input
  };
}

function fixture(items: SkillDetail[], failures = new Set<string>()) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const catalog: SkillCatalogService = {
    list: vi.fn(async () => ({ folders: [], items: items.map(({ markdown: _markdown, references: _references, ...summary }) => summary) })),
    get: vi.fn(async (id: string) => {
      if (failures.has(id)) throw new Error('PRIVATE_PATH_MUST_NOT_ESCAPE');
      const item = byId.get(id);
      if (!item) throw new Error('missing');
      return item;
    }),
    createFolder: vi.fn(),
    move: vi.fn(),
    resolveSource: vi.fn()
  };
  return { catalog, matcher: createSkillMatcherService({ catalog }) };
}

it('prioritizes name and description matches over generic body matches', async () => {
  const preferred = detail({
    id: 'a'.repeat(64),
    name: '公众号长文写作',
    description: '把选题扩写成结构完整的公众号文章',
    folderName: '内容创作',
    markdown: '# 方法\n先确定核心观点，再完成文章。'
  });
  const bodyOnly = detail({
    id: 'c'.repeat(64),
    name: '通用整理',
    description: '整理零散信息',
    markdown: '# 参考\n也可以把选题写成公众号文章。'
  });
  const { matcher } = fixture([bodyOnly, preferred]);

  const candidates = await matcher.match('帮我把这个选题写成公众号文章');

  expect(candidates.map((candidate) => candidate.id)).toEqual([preferred.id, bodyOnly.id]);
  expect(candidates[0]).toMatchObject({
    name: preferred.name,
    description: preferred.description,
    folderName: '内容创作',
    revision,
    reason: expect.stringContaining('匹配')
  });
  expect(candidates[0]).not.toHaveProperty('markdown');
});

it('normalizes punctuation, whitespace and case while keeping english word boundaries', async () => {
  const landing = detail({
    id: 'd'.repeat(64),
    name: 'Landing Copy',
    description: 'Draft clear copy for landing pages',
    markdown: '# Landing copy method'
  });
  const { matcher } = fixture([landing]);

  await expect(matcher.match('DRAFT，  landing   COPY!')).resolves.toHaveLength(1);
  await expect(matcher.match('copycat review')).resolves.toEqual([]);
});

it('returns no candidate without a meaningful match and skips unreadable skills', async () => {
  const unreadable = detail({ id: 'e'.repeat(64), name: '公众号写作', description: '长文写作' });
  const unrelated = detail({ id: 'f'.repeat(64), name: '数据清洗', description: '整理表格字段', markdown: '# CSV' });
  const { matcher } = fixture([unreadable, unrelated], new Set([unreadable.id]));

  await expect(matcher.match('写一篇公众号文章')).resolves.toEqual([]);
});

it('returns at most three candidates with stable id ordering for equal scores', async () => {
  const items = ['f', 'a', 'd', 'b'].map((prefix) => detail({
    id: prefix.repeat(64),
    name: `写作助手 ${prefix}`,
    description: '写作助手',
    markdown: '# 写作助手'
  }));
  const { matcher } = fixture(items);

  const candidates = await matcher.match('使用写作助手');

  expect(candidates).toHaveLength(3);
  expect(candidates.map((candidate) => candidate.id)).toEqual([
    'a'.repeat(64),
    'b'.repeat(64),
    'd'.repeat(64)
  ]);
});

it('never exposes filesystem paths or private read errors in candidates or reasons', async () => {
  const safe = detail({
    id: '1'.repeat(64),
    name: '短视频脚本',
    description: '生成短视频脚本',
    folderName: '视频',
    markdown: '# 方法\n/private/vault/.claude/skills/secret\n短视频脚本'
  });
  const failed = detail({ id: '2'.repeat(64), name: '短视频脚本备份' });
  const { matcher } = fixture([safe, failed], new Set([failed.id]));

  const candidates = await matcher.match('生成短视频脚本');
  const serialized = JSON.stringify(candidates);

  expect(candidates).toHaveLength(1);
  expect(serialized).not.toContain('/private/');
  expect(serialized).not.toContain('PRIVATE_PATH_MUST_NOT_ESCAPE');
  expect(Object.keys(candidates[0]!).sort()).toEqual([
    'description',
    'folderName',
    'id',
    'name',
    'reason',
    'revision'
  ]);
});

it('uses the catalog batch snapshot instead of rescanning the directory for every skill', async () => {
  const writer = detail({
    id: '3'.repeat(64),
    name: '公众号写作',
    description: '生成公众号文章',
    markdown: '# 写作方法'
  });
  const catalog: SkillCatalogService = {
    list: vi.fn(async () => ({ folders: [], items: [] })),
    get: vi.fn(async () => { throw new Error('must not rescan'); }),
    matchDocuments: vi.fn(async () => [writer]),
    createFolder: vi.fn(),
    move: vi.fn(),
    resolveSource: vi.fn()
  };

  const candidates = await createSkillMatcherService({ catalog }).match('生成公众号文章');

  expect(candidates).toHaveLength(1);
  expect(catalog.matchDocuments).toHaveBeenCalledOnce();
  expect(catalog.list).not.toHaveBeenCalled();
  expect(catalog.get).not.toHaveBeenCalled();
});
