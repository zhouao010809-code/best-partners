import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/server/app.js';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createProjectService } from '../../src/server/projects/project-service.js';
import { createProjectWritePlanService } from '../../src/server/projects/project-write-plans.js';
import { createProjectCreationService } from '../../src/server/projects/project-creations.js';
import type { AssistantAdapter, AssistantRunInput } from '../../src/server/assistant/types.js';
import type { CreativeProfileContext } from '../../src/shared/api/creative-profile.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
const fields = { audience: '家长', goal: '了解课程', style: '简洁口播', facts: '每周一次课堂观察', avoid: '不编造成绩' };

async function fixture(runOverride?: (input: AssistantRunInput) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'creation-profile-runtime-'));
  const vaultRoot = join(root, 'vault'); const stateRoot = join(root, 'state'); const projectRoot = join(root, 'project');
  for (const path of [vaultRoot, stateRoot, projectRoot]) await mkdir(path);
  await writeFile(join(projectRoot, '课程.md'), '# 课程\n每周一次课堂观察。\n');
  await writeFile(join(projectRoot, '未选.md'), '未选的私人资料哨兵');
  const database = new Database(join(stateRoot, 'state.sqlite')); applyMigrations(database);
  const projects = createProjectService({ database, vaultRoot, stateRoot });
  const scan = await projects.scan(projectRoot); const project = await projects.bind(scan.scanId, { sourceSha256: scan.sourceSha256 });
  const creations = createProjectCreationService({ database });
  const run = vi.fn(runOverride ?? (async (input: AssistantRunInput) => {
    const source = await input.tools.find(tool => tool.name === 'read_project_file')!.execute({ path: '课程.md' }) as { sourceId: string };
    input.emit({ type: 'text', text: JSON.stringify({ reply: '画像候选待确认', topics: [], profile: { ...fields, facts: `每周一次课堂观察 [${source.sourceId}]` } }) });
  }));
  const adapter: AssistantAdapter = { id: 'deepseek', describe: async () => ({ id: 'deepseek', name: '隔离假模型', status: 'ready', defaultModel: 'fixture-model', models: [{ id: 'fixture-model', name: '隔离假模型', reasoningEfforts: [] }] }), run };
  const app = buildServer({ projectService: projects, projectWritePlans: createProjectWritePlanService({ database }), projectCreations: creations, assistantAdapters: [adapter] });
  cleanup.push(async () => { await app.close(); await projects.close(); database.close(); await rm(root, { recursive: true, force: true }); });
  const bootstrap = await app.inject({ url: '/api/v1/bootstrap', headers });
  const auth = { ...headers, cookie: String(bootstrap.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': bootstrap.json().data.csrfToken as string };
  return { app, run, creations, project, projectRoot, projects, auth };
}

it('wires persisted profile and immutable pinned samples into real generation while keeping candidates and files unsaved', async () => {
  const f = await fixture();
  const draft = await f.creations.create(f.project.id, { kind: 'script', title: '优秀样稿', body: '固定样稿版本一正文' });
  const finalized = await f.creations.snapshot(f.project.id, draft.item.id, { expectedRevision: 1, finalize: true });
  const version = finalized.versions[0]!;
  const profile = await f.creations.saveProfile(f.project.id, { ...fields, samples: [{ creationId: draft.item.id, versionId: version.id }], expectedRevision: 0 });
  await f.creations.save(f.project.id, draft.item.id, { kind: draft.item.kind, title: draft.item.title, brief: '', body: '后来的可编辑版本二正文', audience: '', angle: '', rationale: '', sources: [], expectedRevision: finalized.item.revision });
  const before = await f.creations.get(f.project.id, draft.item.id);
  const sourceBefore = await readFile(join(f.projectRoot, '课程.md'));
  const generated = await f.app.inject({ method: 'POST', url: `/api/v1/projects/${f.project.id}/creation-suggestions`, headers: f.auth, payload: { task: 'profile', instruction: '生成候选，仅预览后再确认', referenceSelection: { mode: 'selected', paths: ['课程.md'] } } });
  expect(generated.statusCode).toBe(200);
  expect(generated.json().data).toMatchObject({ profileRevision: profile.revision, profile: { facts: '每周一次课堂观察 [S1]' } });
  const run = f.run.mock.calls[0]![0];
  const context = JSON.parse(run.messages[0]!.content) as { creativeProfile: CreativeProfileContext; styleSamples: { items: Array<{ versionId: string; body: string }> } };
  expect(context.creativeProfile.profile).toEqual(profile);
  expect(context.styleSamples.items).toMatchObject([{ versionId: version.id, body: '固定样稿版本一正文' }]);
  expect(JSON.stringify(context)).not.toContain('后来的可编辑版本二正文');
  expect(JSON.stringify(context)).not.toContain('未选的私人资料哨兵');
  expect(await f.creations.getProfile(f.project.id)).toEqual(profile);
  expect(await f.creations.get(f.project.id, draft.item.id)).toEqual(before);
  expect(await readFile(join(f.projectRoot, '课程.md'))).toEqual(sourceBefore);
  expect((await readdir(f.projectRoot)).sort()).toEqual(['未选.md', '课程.md']);
});

it('enforces saved per-item source scope at HTTP runtime before reading original files', async () => {
  const f = await fixture(async run => {
    const read = run.tools.find(tool => tool.name === 'read_project_file')!;
    await expect(read.execute({ path: '未选.md' })).rejects.toMatchObject({ code: 'CREATION_REFERENCE_SCOPE' });
    const found = await run.tools.find(tool => tool.name === 'search_project_files')!.execute({ query: '私人资料' });
    expect(found).toMatchObject({ items: [], hasMore: false });
    await read.execute({ path: '课程.md' });
    run.emit({ type: 'text', text: JSON.stringify({ reply: '课程建议', topics: [], body: '课程安排 [S1]' }) });
  });
  const readFileSpy = vi.spyOn(f.projects, 'readFile');
  const draft = await f.creations.create(f.project.id, { kind: 'script', title: '指定范围', body: '当前稿件', referenceSelection: { mode: 'selected', paths: ['课程.md'] } });
  const generated = await f.app.inject({ method: 'POST', url: `/api/v1/projects/${f.project.id}/creation-suggestions`, headers: f.auth, payload: { task: 'script', instruction: '根据选中资料写脚本', itemId: draft.item.id, expectedRevision: 1 } });
  expect(generated.statusCode).toBe(200);
  expect(readFileSpy.mock.calls.map(([, path]) => path)).toEqual(['课程.md']);
  expect((await f.creations.get(f.project.id, draft.item.id)).item).toEqual(draft.item);
});

it('returns an actionable error for deleted selected files without calling the adapter or changing the draft', async () => {
  const f = await fixture();
  const draft = await f.creations.create(f.project.id, { kind: 'script', title: '移走的依据', body: '保留原稿', referenceSelection: { mode: 'selected', paths: ['课程.md'] } });
  await rm(join(f.projectRoot, '课程.md'));
  const generated = await f.app.inject({ method: 'POST', url: `/api/v1/projects/${f.project.id}/creation-suggestions`, headers: f.auth, payload: { task: 'script', instruction: '生成', itemId: draft.item.id, expectedRevision: 1 } });
  expect(generated.statusCode).toBe(409);
  expect(generated.json().error).toMatchObject({ code: 'CREATION_REFERENCE_UNAVAILABLE', message: expect.stringContaining('重新选择') });
  expect(f.run).not.toHaveBeenCalled();
  expect(await f.creations.get(f.project.id, draft.item.id)).toEqual(draft);
});


it('grounds every selected search and read in one real-byte snapshot when a UTF8 BOM file changes before and after preflight', async () => {
  const validatedText = '# 课程\n预读快照每周一次观察。\n';
  const validatedBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(validatedText, 'utf8')]);
  const validatedHash = createHash('sha256').update(validatedBytes).digest('hex');
  const f = await fixture(async run => {
    await writeFile(join(f.projectRoot, '课程.md'), '# 课程\n模型运行后外部新增内容。\n');
    const search = run.tools.find(tool => tool.name === 'search_project_files')!;
    expect(await search.execute({ query: '预读快照' })).toMatchObject({ items: [{ relativePath: '课程.md', sha256: validatedHash }] });
    expect(await search.execute({ query: '外部新增' })).toMatchObject({ items: [] });
    const read = run.tools.find(tool => tool.name === 'read_project_file')!;
    expect(await read.execute({ path: '课程.md' })).toMatchObject({ markdown: validatedText, rawSha256: validatedHash });
    expect(await read.execute({ path: '课程.md' })).toMatchObject({ markdown: validatedText, rawSha256: validatedHash });
    run.emit({ type: 'text', text: JSON.stringify({ reply: '依据本轮读取快照 [S1]', topics: [] }) });
  });
  const originalEnsureFresh = f.projects.ensureFresh.bind(f.projects);
  vi.spyOn(f.projects, 'ensureFresh').mockImplementation(async (projectId, signal) => {
    const summary = await originalEnsureFresh(projectId, signal);
    // The index still identifies the earlier UTF8 bytes at this point.
    await writeFile(join(f.projectRoot, '课程.md'), validatedBytes);
    return summary;
  });
  const response = await f.app.inject({ method: 'POST', url: `/api/v1/projects/${f.project.id}/creation-suggestions`, headers: f.auth, payload: { task: 'topics', instruction: '以本轮验证的资料快照策划', referenceSelection: { mode: 'selected', paths: ['课程.md'] } } });
  expect(response.statusCode).toBe(200);
  expect(response.json().data.sources).toMatchObject([{ id: 'S1', evidence: [{ revision: validatedHash, excerpt: validatedText }] }]);
});


it('rejects a selected file changed to unsupported UTF16 before preflight without contacting the adapter', async () => {
  const f = await fixture();
  const originalEnsureFresh = f.projects.ensureFresh.bind(f.projects);
  vi.spyOn(f.projects, 'ensureFresh').mockImplementation(async (projectId, signal) => {
    const summary = await originalEnsureFresh(projectId, signal);
    await writeFile(join(f.projectRoot, '课程.md'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('无法按UTF8解析的新内容', 'utf16le')]));
    return summary;
  });
  const response = await f.app.inject({ method: 'POST', url: `/api/v1/projects/${f.project.id}/creation-suggestions`, headers: f.auth, payload: { task: 'topics', instruction: '解析失败时保留资料选择', referenceSelection: { mode: 'selected', paths: ['课程.md'] } } });
  expect(response.statusCode).toBe(409);
  expect(response.json().error.code).toBe('CREATION_REFERENCE_UNAVAILABLE');
  expect(f.run).not.toHaveBeenCalled();
});
