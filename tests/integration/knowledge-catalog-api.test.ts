import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/server/app.js';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createIndexRepository } from '../../src/server/index/index-repository.js';
import type { OpenableVaultGateway } from '../../src/server/vault/VaultGateway.js';
import { AppError } from '../../src/shared/api/errors.js';
import type { KnowledgeRecord } from '../../src/shared/domain/records.js';

const headers = { host: '127.0.0.1:4317' };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fixture() {
  const database = new Database(':memory:');
  applyMigrations(database);
  cleanup.push(() => { database.close(); });
  const repository = createIndexRepository(database);
  const directories = new Map<string, string[]>([['02知识库', []]]);
  const forbidden = vi.fn(async (): Promise<never> => { throw new Error('Knowledge catalog must not read or open notes'); });
  const gateway: OpenableVaultGateway = {
    listDirectory: vi.fn(async (path: string) => {
      const entries = directories.get(path);
      if (!entries) throw new AppError('NOT_FOUND', 'private filesystem path', 404);
      return [...entries];
    }),
    readRaw: forbidden,
    openInObsidian: forbidden
  };
  let version = 7;
  const app = buildServer({ readApi: { database, repository, gateway, currentIndexVersion: () => version,
    indexScheduler: {
      requestFocusRefresh: forbidden,
      snapshot: () => ({ state: { status: 'ready', version, refreshedAt: '2026-09-07T00:00:00Z' },
        refresh: { status: 'ready', checked: 0, total: 0, version } })
    }
  } });
  cleanup.push(() => app.close());
  const directory = (relative: string) => {
    let current = '02知识库';
    for (const name of relative.split('/').filter(Boolean)) {
      const entries = directories.get(current)!;
      if (!entries.includes(`${name}/`)) entries.push(`${name}/`);
      current += `/${name}`;
      if (!directories.has(current)) directories.set(current, []);
    }
  };
  const note = (relative: string, changes: Partial<KnowledgeRecord> = {}) => {
    const parent = relative.split('/').slice(0, -1).join('/');
    directory(parent);
    const path = `02知识库/${relative}`;
    directories.get(parent ? `02知识库/${parent}` : '02知识库')!.push(relative.split('/').at(-1)!);
    const record: KnowledgeRecord = { path, title: relative.split('/').at(-1)!.slice(0, -3), rawSha256: 'a'.repeat(64),
      sourceType: 'AI提炼', usageStatus: 'AI总结', knowledgeType: '方法', sourceMaterials: [],
      recallFields: { topics: ['知识管理'], keywords: ['Needle'], scenarios: [], conclusion: '可复用结论', keyPoints: [], boundary: '适用边界' }, ...changes };
    repository.replaceFile({ kind: 'knowledge', record });
    return record;
  };
  const get = (query: Record<string, string | number | boolean> = {}) => app.inject({
    url: `/api/v1/knowledge/catalog?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`, headers
  });
  return { app, database, repository, gateway, directories, forbidden, note, directory, get, bumpVersion: () => { version += 1; } };
}

it('hides recycled knowledge immediately in catalog and list, invalidates cursors and blocks opening until restored', async () => {
  const f = fixture(); const a = f.note('01AI/a.md'); f.note('01AI/b.md');
  const first = (await f.get({ path: '01AI', limit: 1 })).json().data;
  f.database.prepare("INSERT INTO personal_trash_entries(id,material_path,title,created_at,status,manifest_json) VALUES(?,?,?,?,'moving','{}')")
    .run('knowledge-trash', a.path, a.title, '2026-09-07T00:00:00.000Z');
  expect((await f.get({ path: '01AI' })).json().data).toMatchObject({ total: 1, items: [{ title: 'b' }] });
  expect((await f.get({ path: '01AI', limit: 1, cursor: first.nextCursor })).statusCode).toBe(409);
  const list = await f.app.inject({ url: '/api/v1/knowledge', headers });
  expect(list.json().data.items.map((item: KnowledgeRecord) => item.path)).not.toContain(a.path);
  for (const endpoint of ['knowledge/file', 'documents/file']) {
    const detail = await f.app.inject({ url: `/api/v1/${endpoint}?path=${encodeURIComponent(a.path)}`, headers });
    expect(detail.statusCode).toBe(409); expect(detail.body).toContain('KNOWLEDGE_IN_TRASH');
  }
  expect(f.forbidden).not.toHaveBeenCalled();
  f.database.prepare("UPDATE personal_trash_entries SET status='restored' WHERE id='knowledge-trash'").run();
  expect((await f.get({ path: '01AI' })).json().data.total).toBe(2);
});

it('lists real direct folders including empty folders and direct notes at arbitrary depth', async () => {
  const f = fixture();
  f.directory('01AI/AI工具/空目录/更深一层');
  const direct = f.note('01AI/AI工具/直接知识.md');
  f.note('01AI/AI工具/子目录/后代知识.md');
  f.note('01AI/AI工具箱/相邻知识.md');
  const response = await f.get({ path: '01AI/AI工具' });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ version: 1, data: { path: '01AI/AI工具', total: 2, directTotal: 1,
    breadcrumbs: [{ path: '', label: '知识书柜' }, { path: '01AI', label: 'AI' }, { path: '01AI/AI工具', label: 'AI工具' }],
    folders: [{ path: '01AI/AI工具/子目录', label: '子目录', count: 1 }, { path: '01AI/AI工具/空目录', label: '空目录', count: 0 }], items: [direct] } });
  expect((await f.get({ path: '01AI/AI工具/空目录/更深一层' })).json().data).toMatchObject({ folders: [], items: [], total: 0, directTotal: 0 });
  expect(vi.mocked(f.gateway.listDirectory).mock.calls.map(([path]) => path)).toEqual(['02知识库/01AI/AI工具', '02知识库/01AI/AI工具/空目录/更深一层']);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('counts every matching indexed note before paginating more than 200 results', async () => {
  const f = fixture();
  for (let i = 0; i < 205; i += 1) f.note(`01AI/${String(i).padStart(3, '0')}.md`);
  expect((await f.get()).json().data.folders).toEqual([{ path: '01AI', label: 'AI', count: 205 }]);
  const first = await f.get({ path: '01AI', limit: 200 });
  expect(first.statusCode).toBe(200);
  expect(first.json().data).toMatchObject({ total: 205, directTotal: 205, indexVersion: 7 });
  expect(first.json().data.items).toHaveLength(200);
  const last = await f.get({ path: '01AI', limit: 200, cursor: first.json().data.nextCursor });
  expect(last.statusCode).toBe(200);
  expect(last.json().data.items).toHaveLength(5);
  expect(last.json().data.nextCursor).toBeUndefined();
  expect(new Set([...first.json().data.items, ...last.json().data.items].map((record: KnowledgeRecord) => record.path)).size).toBe(205);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('preserves knowledge status and recall filters including explicit obsolete selection', async () => {
  const f = fixture();
  f.note('01AI/活跃.md');
  f.note('01AI/已优化.md', { usageStatus: '已优化', knowledgeType: '模型' });
  f.note('01AI/过时.md', { usageStatus: '过时' });
  expect((await f.get({ path: '01AI' })).json().data.total).toBe(2);
  expect((await f.get({ path: '01AI', includeObsolete: true })).json().data.total).toBe(3);
  expect((await f.get({ path: '01AI', usageStatus: '过时' })).json().data.items).toMatchObject([{ usageStatus: '过时' }]);
  expect((await f.get({ path: '01AI', knowledgeType: '模型', topic: '知识管理' })).json().data.items).toMatchObject([{ title: '已优化' }]);
  expect((await f.get({ path: '01AI', topic: '01AI' })).json().data.total).toBe(0);
  expect((await f.get({ usageStatus: '定论' })).json().data.folders).toEqual([{ path: '01AI', label: 'AI', count: 0 }]);
});

it('searches only current subtree recall fields, flattens results and does not search paths or sources', async () => {
  const f = fixture();
  f.note('01AI/根部.md');
  f.note('01AI/子目录/深层.md');
  f.note('01AI扩展/其他.md');
  f.note('01AI/body-only-token.md', { sourceMaterials: ['source-only-token'], recallFields: {
    topics: [], keywords: [], scenarios: [], conclusion: '其它', keyPoints: [], boundary: '其它'
  } });
  const response = await f.get({ path: '01AI', search: ' Needle ' });
  expect(response.statusCode).toBe(200);
  expect(response.json().data).toMatchObject({ total: 2, directTotal: 2, folders: [] });
  expect(response.json().data.items.map((record: KnowledgeRecord) => record.title).sort()).toEqual(['根部', '深层']);
  expect((await f.get({ path: '01AI', search: 'source-only-token' })).json().data.total).toBe(0);
  expect((await f.get({ path: '01AI', search: ' ' })).json().data).toMatchObject({ total: 3, directTotal: 2, folders: [{ count: 1 }] });
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('rejects unsafe and nonexistent directories but preserves literal percent and Unicode identities', async () => {
  const f = fixture();
  for (const path of ['../01图书馆', '/01AI', '01AI//工具', '01AI/..', '01AI\\工具', '01AI/.hidden']) {
    const response = await f.get({ path });
    expect(response.statusCode).toBe(400);
  }
  expect(f.gateway.listDirectory).not.toHaveBeenCalled();
  const missing = await f.get({ path: '不存在' });
  expect(missing.statusCode).toBe(404);
  expect(missing.json().error.code).toBe('KNOWLEDGE_FOLDER_NOT_FOUND');
  expect(missing.body).not.toContain('private filesystem');
  f.directory('01AI/%2e%2e/cafe\u0301');
  const literal = await f.get({ path: '01AI/%2e%2e/cafe\u0301' });
  expect(literal.statusCode).toBe(200);
  expect(literal.json().data.path).toBe('01AI/%2e%2e/cafe\u0301');
});

it('binds cursors to query, endpoint, index version and the sorted directory snapshot', async () => {
  const f = fixture(); f.note('01AI/a.md'); f.note('01AI/b.md');
  const first = await f.get({ path: '01AI', limit: 1 });
  expect(first.statusCode).toBe(200);
  const cursor = first.json().data.nextCursor;
  for (const extra of [{ path: '' }, { search: 'Needle' }, { usageStatus: '已优化' }, { topic: '知识管理' }, { knowledgeType: '方法' }, { includeObsolete: true }]) {
    expect((await f.get({ path: '01AI', limit: 1, cursor, ...extra })).statusCode).toBe(400);
  }
  expect((await f.app.inject({ url: `/api/v1/knowledge?cursor=${encodeURIComponent(cursor)}`, headers })).statusCode).toBe(400);
  f.directories.get('02知识库/01AI')!.reverse();
  expect((await f.get({ path: '01AI', limit: 1, cursor })).statusCode).toBe(200);
  f.directory('01AI/新空目录');
  expect((await f.get({ path: '01AI', limit: 1, cursor })).statusCode).toBe(409);
  const refreshed = (await f.get({ path: '01AI', limit: 1 })).json().data.nextCursor;
  f.bumpVersion();
  expect((await f.get({ path: '01AI', limit: 1, cursor: refreshed })).statusCode).toBe(409);
});

it('rejects index drift across the directory await and while collecting indexed notes', async () => {
  const f = fixture(); f.note('01AI/a.md');
  vi.mocked(f.gateway.listDirectory).mockImplementationOnce(async () => { f.bumpVersion(); return ['01AI/']; });
  expect((await f.get()).statusCode).toBe(409);
  const list = f.repository.listKnowledge.bind(f.repository);
  vi.spyOn(f.repository, 'listKnowledge').mockImplementationOnce((query) => { const result = list(query); f.bumpVersion(); return result; });
  expect((await f.get()).statusCode).toBe(409);
});

it('does not turn malformed directory entries or unavailable gateways into empty catalogs', async () => {
  const f = fixture();
  for (const entries of [['../'], ['a/b/'], ['/absolute/'], ['same/', 'same/']]) {
    vi.mocked(f.gateway.listDirectory).mockResolvedValueOnce(entries);
    const response = await f.get();
    expect(response.statusCode).toBe(502);
  }
  vi.mocked(f.gateway.listDirectory).mockRejectedValueOnce(new AppError('READ_FAILED', 'private path', 502));
  expect((await f.get()).statusCode).toBe(503);
});
