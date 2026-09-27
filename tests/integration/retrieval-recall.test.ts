import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createIndexRepository } from '../../src/server/index/index-repository.js';
import { createReadService } from '../../src/server/services/read-service.js';
import { FakeVaultGateway } from '../../src/server/vault/FakeVaultGateway.js';
import { createProjectService } from '../../src/server/projects/project-service.js';
import type { KnowledgeRecord } from '../../src/shared/domain/records.js';
import { createBrainTools } from '../../src/server/assistant/brain-tools.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const database = new Database(':memory:'); databases.push(database); applyMigrations(database);
  const repository = createIndexRepository(database);
  const gateway = Object.assign(new FakeVaultGateway({}), { openInObsidian: async () => {} });
  const service = createReadService({ database, repository, gateway, currentIndexVersion: () => 1, cursorSecret: Buffer.alloc(32, 1) });
  const add = (path: string, title: string, conclusion: string, status: KnowledgeRecord['usageStatus'] = 'AI总结') => repository.replaceFile({ kind: 'knowledge', record: {
    path: `02知识库/${path}.md`, title, rawSha256: 'a'.repeat(64), sourceType: 'AI提炼', usageStatus: status, knowledgeType: '方法', sourceMaterials: ['正文之外的来源'],
    recallFields: { topics: [], keywords: [], scenarios: [], conclusion, keyPoints: [], boundary: '' }
  } });
  return { database, repository, service, add };
}

it('recalls separated keywords across allowed fields, ranks direct titles first, and keeps cursors complete', () => {
  const f = fixture();
  f.add('A', '内容方法', '用短视频帮助获客');
  f.add('B', '短视频', '先明确获客对象');
  f.add('Z', '短视频获客', '直接回答问题');
  f.add('C', '只有短视频', '没有第二个词');
  f.add('D', '短视频获客', '过时方法', '过时');
  const first = f.service.listKnowledge({ search: '短视频 获客', limit: 1 });
  expect(first.items.map(x => x.path)).toEqual(['02知识库/Z.md']);
  expect(first.nextCursor).toBeDefined();
  const second = f.service.listKnowledge({ search: '短视频 获客', limit: 1, cursor: first.nextCursor! });
  const third = f.service.listKnowledge({ search: '短视频 获客', limit: 1, cursor: second.nextCursor! });
  expect(new Set([...first.items, ...second.items, ...third.items].map(x => x.path))).toEqual(new Set(['02知识库/A.md', '02知识库/B.md', '02知识库/Z.md']));
  expect(third.nextCursor).toBeUndefined();
  expect(f.repository.listKnowledge({ search: '正文之外的来源' }).total).toBe(0);
});

it('recalls reordered Chinese compounds but requires every meaningful term', () => {
  const f = fixture();
  f.add('A', '中考美术', '录取人数和年度数据');
  f.add('B', '美术兴趣班', '儿童绘画');
  expect(f.repository.listKnowledge({ search: '美术中考' }).items.map(x => x.title)).toEqual(['中考美术']);
  expect(f.repository.listKnowledge({ search: '录取数据' }).items.map(x => x.title)).toEqual(['中考美术']);
  expect(f.repository.listKnowledge({ search: '中考 不存在词' }).total).toBe(0);
});

it('searches project text with Chinese terms and prioritizes the matching filename within the requested project', async () => {
  const f = fixture();
  const project = '00000000-0000-4000-8000-000000000001';
  const other = '00000000-0000-4000-8000-000000000002';
  for (const id of [project, other]) f.database.prepare(`INSERT INTO personal_projects(id,root_path,display_name,source_revision,source_sha256,availability,created_at,updated_at) VALUES(?,?,?,1,?,'ready','','')`).run(id, `/test/${id}`, '隔离测试', 'b'.repeat(64));
  const add = (id: string, path: string, text: string) => f.database.prepare(`INSERT INTO personal_project_files(project_id,relative_path,kind,parse_status,content_text,indexed_revision) VALUES(?,?,'file','readable',?,1)`).run(id, path, text);
  add(project, 'A脚本.md', '美术中考的一些片段');
  add(project, 'Z中考美术.md', '录取人数与年度数据');
  add(project, '兴趣班.md', '美术兴趣班');
  add(other, '美术中考.md', '别的项目不应出现');
  const service = createProjectService({ database: f.database, vaultRoot: '/test/vault', stateRoot: '/test/state' });
  expect((await service.listFiles(project, { search: '美术中考', limit: 10 })).items.map(x => x.relativePath)).toEqual(['Z中考美术.md', 'A脚本.md']);
  expect((await service.listFiles(project, { search: '录取数据' })).items.map(x => x.relativePath)).toEqual(['Z中考美术.md']);
  expect((await service.listFiles(project, { search: '不存在词 中考' })).total).toBe(0);
  await service.close();
});

it('keeps material relevance order when assistant merges all ingestion states', async () => {
  const f = fixture();
  for (const [path, title, knowledgeStatus] of [['A', '中考美术讨论', '未提炼'], ['Z', '美术中考', '已入库']] as const) {
    f.repository.replaceFile({ kind: 'material', record: { path: `01图书馆/${path}.md`, title, rawSha256: 'a'.repeat(64), sourcePlatform: '个人', processingStatus: '已归档', knowledgeStatus, generatedKnowledge: [] } });
  }
  const tools = createBrainTools({ readService: f.service, scope: 'brain', model: 'test', signal: new AbortController().signal, emit: () => {} });
  expect(await tools.find(tool => tool.name === 'search_materials')!.execute({ query: '美术中考', limit: 1 })).toMatchObject({ items: [{ title: '美术中考' }], hasMore: true });
});
