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
import type { CreationDetail, CreationSave, CreationSuggestion } from '../../src/shared/api/project-creations.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture(runOverride?: (input: AssistantRunInput) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'creation-runtime-'));
  const vaultRoot = join(root, 'vault'); const stateRoot = join(root, 'state'); const projectRoot = join(root, 'project');
  for (const path of [vaultRoot, stateRoot, projectRoot]) await mkdir(path);
  await writeFile(join(projectRoot, '课程.md'), '# 课程资料\n每周一次课堂观察。\n');
  const database = new Database(join(stateRoot, 'state.sqlite')); applyMigrations(database);
  const projects = createProjectService({ database, vaultRoot, stateRoot });
  const scan = await projects.scan(projectRoot); const project = await projects.bind(scan.scanId, { sourceSha256: scan.sourceSha256 });
  const creations = createProjectCreationService({ database });
  const run = vi.fn(runOverride ?? (async (input: AssistantRunInput) => {
    const source = await input.tools.find(tool => tool.name === 'read_project_file')!.execute({ path: '课程.md' }) as { sourceId: string };
    input.emit({ type: 'text', text: JSON.stringify({ reply: `根据项目资料提出脚本建议 [${source.sourceId}]`, topics: [], body: `家长可以先观察一次课堂，再了解课程安排。[${source.sourceId}]` }) });
  }));
  const adapter: AssistantAdapter = {
    id: 'deepseek',
    describe: async () => ({ id: 'deepseek', name: '隔离假模型', status: 'ready', defaultModel: 'fixture-model', models: [{ id: 'fixture-model', name: '隔离假模型', reasoningEfforts: [] }] }),
    run
  };
  const app = buildServer({ projectService: projects, projectWritePlans: createProjectWritePlanService({ database }), projectCreations: creations, assistantAdapters: [adapter] });
  cleanup.push(async () => { await app.close(); await projects.close(); database.close(); await rm(root, { recursive: true, force: true }); });
  const bootstrap = await app.inject({ url: '/api/v1/bootstrap', headers });
  const cookie = String(bootstrap.headers['set-cookie']).split(';')[0]!;
  const auth = { ...headers, cookie, 'x-csrf-token': bootstrap.json().data.csrfToken as string };
  return { app, run, creations, project, projectRoot, database, auth, cookie };
}

it('records an API-generated suggestion without applying it, then saves, finalizes and exports only after explicit mutations', async () => {
  const f = await fixture(); const base = `/api/v1/projects/${f.project.id}`;
  const sourceBefore = sha(await readFile(join(f.projectRoot, '课程.md')));
  const payload = { kind: 'script', title: '家长如何观察课堂', brief: '一分钟口播，未知成绩待补充', body: '编导手写的原稿' };
  expect((await f.app.inject({ method: 'POST', url: `${base}/creations`, headers, payload })).statusCode).toBe(401);
  expect((await f.app.inject({ method: 'POST', url: `${base}/creations`, headers: { ...headers, cookie: f.cookie }, payload })).statusCode).toBe(403);
  const create = await f.app.inject({ method: 'POST', url: `${base}/creations`, headers: f.auth, payload });
  expect(create.statusCode).toBe(200);
  const initial = create.json().data as CreationDetail;
  const instruction = '根据项目资料生成口播脚本';
  const generated = await f.app.inject({ method: 'POST', url: `${base}/creation-suggestions`, headers: f.auth, payload: { task: 'script', instruction, itemId: initial.item.id, expectedRevision: initial.item.revision } });
  expect(generated.statusCode).toBe(200);
  const suggestion = generated.json().data as CreationSuggestion;
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(suggestion.sources).toMatchObject([{ path: `project:${f.project.id}/课程.md`, kind: 'read' }]);
  const after = (await f.app.inject({ url: `${base}/creations/${initial.item.id}`, headers })).json().data as CreationDetail;
  expect(after.item).toEqual(initial.item);
  expect(after.messages).toMatchObject([{ instruction, suggestion }]);
  expect(await readdir(f.projectRoot)).toEqual(['课程.md']);
  const { item } = after;
  const save: CreationSave = { kind: item.kind, title: item.title, brief: item.brief, body: suggestion.body!, audience: item.audience, angle: item.angle, rationale: item.rationale, sources: suggestion.sources, expectedRevision: item.revision };
  const adopted = await f.app.inject({ method: 'PUT', url: `${base}/creations/${item.id}`, headers: f.auth, payload: save });
  expect(adopted.statusCode).toBe(200);
  const finalized = await f.app.inject({ method: 'POST', url: `${base}/creations/${item.id}/versions`, headers: f.auth, payload: { expectedRevision: adopted.json().data.item.revision as number, finalize: true } });
  expect(finalized.statusCode).toBe(200);
  const versionId = finalized.json().data.item.finalVersionId as string;
  expect(await readdir(f.projectRoot)).toEqual(['课程.md']);
  const exported = await f.app.inject({ method: 'POST', url: `${base}/creations/${item.id}/versions/${versionId}/export`, headers: f.auth, payload: {} });
  expect(exported.statusCode).toBe(200);
  const path = exported.json().data.path as string;
  const content = await readFile(join(f.projectRoot, path), 'utf8');
  expect(content).toContain(suggestion.body); expect(content).toContain(payload.brief); expect(content).toContain(instruction);
  expect(sha(await readFile(join(f.projectRoot, '课程.md')))).toBe(sourceBefore);
  const company = buildServer({ runtimeMode: 'company', projectCreations: f.creations }); cleanup.push(() => company.close());
  expect((await company.inject({ url: `${base}/creations`, headers })).statusCode).toBe(404);
  expect((await company.inject({ method: 'POST', url: `${base}/creation-suggestions`, headers, payload: { task: 'topics', instruction: '禁止跨工作区' } })).statusCode).toBe(404);
});

it('aborts pending generation before shutdown and does not record an incomplete exchange', async () => {
  let reachedModel = false;
  const f = await fixture(async input => {
    reachedModel = true;
    await new Promise<void>((resolve, reject) => {
      if (input.signal.aborted) { reject(input.signal.reason); return; }
      input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
    });
  });
  const created = await f.creations.create(f.project.id, { kind: 'script', title: '关闭时保稿', body: '必须保留的原稿' });
  const response = f.app.inject({ method: 'POST', url: `/api/v1/projects/${f.project.id}/creation-suggestions`, headers: f.auth,
    payload: { task: 'script', instruction: '尚未完成', itemId: created.item.id, expectedRevision: 1 } });
  await vi.waitFor(() => expect(reachedModel).toBe(true));
  await f.app.close();
  expect((await response).statusCode).toBeGreaterThanOrEqual(400);
  expect(await f.creations.get(f.project.id, created.item.id)).toEqual(created);
}, 10_000);
