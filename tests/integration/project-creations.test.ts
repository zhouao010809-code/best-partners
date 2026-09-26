import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { creationGenerateRequestSchema, creationCreateSchema, creationSaveSchema } from '../../src/shared/api/project-creations.js';
import { createProjectCreationService } from '../../src/server/projects/project-creations.js';
import { registerProjectCreationRoutes } from '../../src/server/api/routes/project-creations.js';
import type { CreationSave, CreationSuggestion, ProjectCreation } from '../../src/shared/api/project-creations.js';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createProjectService } from '../../src/server/projects/project-service.js';
import { afterEach, describe, expect, it } from 'vitest';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe('personal project creations', () => {
  it('requires an item/revision pair for script and revise requests and validates the selection', async () => {
    const schema = creationGenerateRequestSchema;
    const itemId = '11111111-1111-4111-8111-111111111111';
    expect(schema.safeParse({ task: 'topics', instruction: '策划选题' }).success).toBe(true);
    expect(schema.safeParse({ task: 'script', instruction: '写脚本' }).success).toBe(false);
    expect(schema.safeParse({ task: 'discuss', instruction: '讨论', itemId }).success).toBe(false);
    expect(schema.safeParse({ task: 'revise', instruction: '改开头', itemId, expectedRevision: 1, selection: { text: '开头', start: 4, end: 2 } }).success).toBe(false);
    expect(schema.safeParse({ task: 'revise', instruction: '改开头', itemId, expectedRevision: 1, selection: { text: '开头', start: 0, end: 2 } }).success).toBe(true);
  });

  it('bounds editable bodies and uses empty defaults only on creation', async () => {
    expect(creationCreateSchema.parse({ kind: 'script', title: '脚本' })).toMatchObject({ body: '', brief: '', sources: [], audience: '', angle: '', rationale: '' });
    expect(creationCreateSchema.safeParse({ kind: 'script', title: '脚本', body: '字'.repeat(60001) }).success).toBe(false);
    expect(creationSaveSchema.safeParse({ kind: 'script', title: '脚本', expectedRevision: 1 }).success).toBe(false);
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'project-creations-'));
  const vaultRoot = join(root, 'vault'); const stateRoot = join(root, 'state');
  const projectRoot = join(root, 'project-a'); const otherRoot = join(root, 'project-b');
  for (const path of [vaultRoot, stateRoot, projectRoot, otherRoot]) await mkdir(path);
  await writeFile(join(projectRoot, '原始资料.md'), '# 客户资料\n原文哨兵。\n');
  await writeFile(join(otherRoot, '另一个项目.md'), '项目B哨兵');
  const dbPath = join(stateRoot, 'creations.sqlite');
  let database = new Database(dbPath); applyMigrations(database);
  const projects = createProjectService({ database, vaultRoot, stateRoot });
  const preview = await projects.scan(projectRoot); const project = await projects.bind(preview.scanId, { sourceSha256: preview.sourceSha256 });
  const secondPreview = await projects.scan(otherRoot); const second = await projects.bind(secondPreview.scanId, { sourceSha256: secondPreview.sourceSha256 });
  let service = createProjectCreationService({ database });
  cleanup.push(async () => { await projects.close(); database.close(); await rm(root, { recursive: true, force: true }); });
  return { root, projectRoot, otherRoot, project, second, get database() { return database; }, get service() { return service; },
    reopen() { database.close(); database = new Database(dbPath); applyMigrations(database); service = createProjectCreationService({ database }); }
  };
}
const savedInput = (item: ProjectCreation, patch: Partial<CreationSave> = {}): CreationSave => ({
  kind: item.kind, title: item.title, brief: item.brief, body: item.body, audience: item.audience,
  angle: item.angle, rationale: item.rationale, sources: item.sources, expectedRevision: item.revision, ...patch
});
const suggestion = (patch: Partial<CreationSuggestion> = {}): CreationSuggestion => ({ id: randomUUID(), task: 'discuss', reply: '建议内容', topics: [], sources: [], createdAt: new Date().toISOString(), ...patch });

describe('creation persistence and version export', () => {
  it('recovers an independently saved work draft after the database is reopened', async () => {
    const f = await fixture();
    const created = await f.service.create(f.project.id, { kind: 'topic', title: '客户选题', brief: '给家长看的课程介绍' });
    expect(created).toMatchObject({ item: { projectId: f.project.id, revision: 1, body: '' }, versions: [], messages: [] });
    const saved = await f.service.save(f.project.id, created.item.id, savedInput(created.item, { kind: 'script', body: '第一句\n第二句', audience: '家长' }));
    expect(saved.item.revision).toBe(2);
    f.reopen();
    expect(await f.service.get(f.project.id, created.item.id)).toEqual(saved);
    expect(await f.service.list(f.second.id)).toEqual([]);
    expect(await f.service.list(f.project.id)).toEqual([saved.item]);
  });

  it('rejects every operation on an item owned by another project', async () => {
    const f = await fixture(); const detail = await f.service.create(f.project.id, { kind: 'script', title: 'A的稿件' });
    const versioned = await f.service.snapshot(f.project.id, detail.item.id, { expectedRevision: 1, finalize: false });
    const id = detail.item.id;
    for (const operation of [
      () => f.service.get(f.second.id, id),
      () => f.service.save(f.second.id, id, savedInput(versioned.item, { body: '不得改写' })),
      () => f.service.snapshot(f.second.id, id, { expectedRevision: 2, finalize: true }),
      () => f.service.exportVersion(f.second.id, id, versioned.versions[0]!.id),
      () => f.service.recordExchange(f.second.id, id, { instruction: '不得关联', suggestion: suggestion() })
    ]) await expect(operation()).rejects.toMatchObject({ code: 'CREATION_NOT_FOUND', statusCode: 404 });
    expect(await f.service.get(f.project.id, id)).toEqual(versioned);
  });

  it('allows only one concurrent save from an expected revision and rejects stale snapshots', async () => {
    const f = await fixture(); const detail = await f.service.create(f.project.id, { kind: 'script', title: '并发稿件' });
    const outcomes = await Promise.allSettled([
      f.service.save(f.project.id, detail.item.id, savedInput(detail.item, { body: '新稿A' })),
      f.service.save(f.project.id, detail.item.id, savedInput(detail.item, { body: '旧稿B' }))
    ]);
    expect(outcomes.map(item => item.status)).toEqual(['fulfilled', 'rejected']);
    expect((outcomes[1] as PromiseRejectedResult).reason).toMatchObject({ code: 'CREATION_REVISION_CONFLICT', statusCode: 409 });
    await expect(f.service.snapshot(f.project.id, detail.item.id, { expectedRevision: 1, finalize: true })).rejects.toMatchObject({ code: 'CREATION_REVISION_CONFLICT' });
    expect((await f.service.get(f.project.id, detail.item.id)).item.body).toBe('新稿A');
  });

  it('keeps finalized versions immutable while the working draft continues changing', async () => {
    const f = await fixture(); const created = await f.service.create(f.project.id, { kind: 'script', title: '不可变稿件', body: '定稿原文', brief: '原始要求', sources: [{ id: 'source-1', path: '原始资料.md', title: '原始资料' }] });
    const final = await f.service.snapshot(f.project.id, created.item.id, { expectedRevision: 1, finalize: true });
    const first = final.versions[0]!;
    expect(final.item).toMatchObject({ revision: 2, finalVersionId: first.id });
    const edited = await f.service.save(f.project.id, created.item.id, savedInput(final.item, { body: '继续编辑的新草稿', brief: '新的要求' }));
    const second = await f.service.snapshot(f.project.id, created.item.id, { expectedRevision: edited.item.revision, finalize: false });
    expect(second.item.finalVersionId).toBe(first.id);
    expect(second.versions.find(version => version.id === first.id)).toEqual(first);
    expect(second.versions.map(version => version.number).sort()).toEqual([1, 2]);
    expect(second.item.revision).toBe(4);
    f.reopen();
    expect((await f.service.get(f.project.id, created.item.id)).versions.find(version => version.id === first.id)).toEqual(first);
  });

  it('records bounded conversation history without changing the draft revision or body', async () => {
    const f = await fixture(); const detail = await f.service.create(f.project.id, { kind: 'script', title: '讨论稿件', body: '手写正文' });
    for (let index = 0; index < 102; index += 1) await f.service.recordExchange(f.project.id, detail.item.id, { instruction: `讨论${index}`, suggestion: suggestion({ baseRevision: 1 }) });
    const after = await f.service.get(f.project.id, detail.item.id);
    expect(after.item).toEqual(detail.item);
    expect(after.messages).toHaveLength(100);
    expect(after.messages[0]!.instruction).toBe('讨论2');
    expect(after.messages.at(-1)!.instruction).toBe('讨论101');
  });

  it('exports the chosen immutable version once and keeps same-title versions and creations separate', async () => {
    const f = await fixture(); const sourceBefore = await readFile(join(f.projectRoot, '原始资料.md'));
    const created = await f.service.create(f.project.id, { kind: 'script', title: '相同标题', body: '需要导出的版本一', brief: '创作要求一' });
    await f.service.recordExchange(f.project.id, created.item.id, { instruction: '讨论背景', suggestion: suggestion({ baseRevision: created.item.revision }) });
    const versioned = await f.service.snapshot(f.project.id, created.item.id, { expectedRevision: 1, finalize: true });
    const first = versioned.versions[0]!;
    const newer = await f.service.save(f.project.id, created.item.id, savedInput(versioned.item, { body: '不应混入版本一的新正文', brief: '新要求' }));
    const [exported, repeated] = await Promise.all([f.service.exportVersion(f.project.id, created.item.id, first.id), f.service.exportVersion(f.project.id, created.item.id, first.id)]);
    expect(repeated).toEqual(exported);
    expect(exported.path).toMatch(/^AI工作区\/内容草稿\//u);
    const content = await readFile(join(f.projectRoot, exported.path), 'utf8');
    expect(content).toContain('需要导出的版本一'); expect(content).toContain('创作要求一'); expect(content).toContain('讨论背景'); expect(content).not.toContain('不应混入版本一的新正文');
    const second = await f.service.snapshot(f.project.id, created.item.id, { expectedRevision: newer.item.revision, finalize: false });
    const secondExport = await f.service.exportVersion(f.project.id, created.item.id, second.versions.find(version => version.number === 2)!.id);
    const another = await f.service.create(f.project.id, { kind: 'script', title: '相同标题', body: '另一条内容' });
    const anotherSnapshot = await f.service.snapshot(f.project.id, another.item.id, { expectedRevision: 1, finalize: false });
    const anotherExport = await f.service.exportVersion(f.project.id, another.item.id, anotherSnapshot.versions[0]!.id);
    expect(new Set([exported.path, secondExport.path, anotherExport.path]).size).toBe(3);
    f.reopen(); expect(await f.service.exportVersion(f.project.id, created.item.id, first.id)).toEqual(exported);
    expect(await readFile(join(f.projectRoot, '原始资料.md'))).toEqual(sourceBefore);
    expect(await readdir(f.otherRoot)).toEqual(['另一个项目.md']);
  });

  it('refuses to overwrite an exported file changed outside the app', async () => {
    const f = await fixture(); const created = await f.service.create(f.project.id, { kind: 'script', title: '外部编辑', body: '原导出' });
    const versioned = await f.service.snapshot(f.project.id, created.item.id, { expectedRevision: 1, finalize: false });
    const exported = await f.service.exportVersion(f.project.id, created.item.id, versioned.versions[0]!.id);
    await writeFile(join(f.projectRoot, exported.path), '用户手动修改的文件');
    await expect(f.service.exportVersion(f.project.id, created.item.id, versioned.versions[0]!.id)).rejects.toMatchObject({ code: 'CREATION_EXPORT_CONFLICT', statusCode: 409 });
    expect(await readFile(join(f.projectRoot, exported.path), 'utf8')).toBe('用户手动修改的文件');
  });

  it('does not follow an AI workspace symlink or accept a version from a different item', async () => {
    const f = await fixture(); const created = await f.service.create(f.project.id, { kind: 'script', title: '边界稿件', body: '不应外写' });
    const versioned = await f.service.snapshot(f.project.id, created.item.id, { expectedRevision: 1, finalize: false });
    const another = await f.service.create(f.project.id, { kind: 'script', title: '另一条' });
    await expect(f.service.exportVersion(f.project.id, another.item.id, versioned.versions[0]!.id)).rejects.toMatchObject({ code: 'CREATION_VERSION_NOT_FOUND', statusCode: 404 });
    await symlink(f.otherRoot, join(f.projectRoot, 'AI工作区'));
    await expect(f.service.exportVersion(f.project.id, created.item.id, versioned.versions[0]!.id)).rejects.toMatchObject({ code: 'CREATION_EXPORT_UNAVAILABLE' });
    expect(await readdir(f.otherRoot)).toEqual(['另一个项目.md']);
  });
});

async function httpFixture() {
  const f = await fixture();
  const app = Fastify();
  const generated: Array<{ projectId: string; input: unknown; signal?: AbortSignal }> = [];
  registerProjectCreationRoutes(app, f.service, async (projectId, input, signal) => { generated.push({ projectId, input, ...(signal ? { signal } : {}) }); return suggestion({ task: input.task, ...(input.expectedRevision ? { baseRevision: input.expectedRevision } : {}) }); });
  cleanup.push(() => app.close());
  return { ...f, app, generated };
}

describe('creation HTTP contracts', () => {
  it('uses strict validated envelopes for create, save, snapshot, export and list', async () => {
    const f = await httpFixture(); const base = `/api/v1/projects/${f.project.id}/creations`;
    const create = await f.app.inject({ method: 'POST', url: base, payload: { kind: 'script', title: 'HTTP稿件', body: '正文' } });
    expect(create.statusCode).toBe(200); expect(create.headers['cache-control']).toBe('no-store');
    const item = create.json().data.item as ProjectCreation;
    expect(create.json().version).toBe(1);
    const saved = await f.app.inject({ method: 'PUT', url: `${base}/${item.id}`, payload: savedInput(item, { body: '修订正文' }) });
    expect(saved.statusCode).toBe(200);
    const stale = await f.app.inject({ method: 'PUT', url: `${base}/${item.id}`, payload: savedInput(item, { body: '旧稿' }) });
    expect(stale.statusCode).toBe(409);
    const version = await f.app.inject({ method: 'POST', url: `${base}/${item.id}/versions`, payload: { expectedRevision: 2, finalize: true } });
    expect(version.statusCode).toBe(200);
    const versionId = version.json().data.versions[0].id as string;
    expect(await readdir(f.projectRoot)).toEqual(['原始资料.md']);
    const exported = await f.app.inject({ method: 'POST', url: `${base}/${item.id}/versions/${versionId}/export`, payload: {} });
    expect(exported.statusCode).toBe(200); expect(exported.json().data.versionId).toBe(versionId);
    expect((await f.app.inject({ url: base })).json().data.items).toHaveLength(1);
    expect((await f.app.inject({ url: `${base}/${item.id}` })).json().data.item.finalVersionId).toBe(versionId);
    const unknown = await f.app.inject({ method: 'POST', url: base, payload: { kind: 'script', title: '拒绝私有字段', rootPath: f.otherRoot } });
    expect(unknown.statusCode).toBe(400);
  });

  it('rejects wrong ownership and stale generation before invoking the model callback', async () => {
    const f = await httpFixture(); const detail = await f.service.create(f.project.id, { kind: 'script', title: '生成接口' });
    const payload = { task: 'revise', instruction: '改开头', itemId: detail.item.id, expectedRevision: 1 };
    expect((await f.app.inject({ method: 'POST', url: `/api/v1/projects/${f.second.id}/creation-suggestions`, payload })).statusCode).toBe(404);
    expect((await f.app.inject({ method: 'POST', url: `/api/v1/projects/${f.project.id}/creation-suggestions`, payload: { ...payload, expectedRevision: 2 } })).statusCode).toBe(409);
    expect(f.generated).toHaveLength(0);
    const result = await f.app.inject({ method: 'POST', url: `/api/v1/projects/${f.project.id}/creation-suggestions`, payload });
    expect(result.statusCode).toBe(200); expect(f.generated).toHaveLength(1);
    expect(f.generated[0]).toMatchObject({ projectId: f.project.id, input: payload });
    expect(f.generated[0]!.signal).toBeInstanceOf(AbortSignal);
    expect((await f.service.get(f.project.id, detail.item.id)).item).toEqual(detail.item);
  });
});

describe('creation limits and recovery boundaries', () => {
  it('keeps all existing creations visible and explicitly rejects exceeding the 200-item capacity', async () => {
    const f = await fixture();
    for (let index = 0; index < 200; index += 1) await f.service.create(f.project.id, { kind: 'topic', title: `选题${index}` });
    await expect(f.service.create(f.project.id, { kind: 'topic', title: '超过容量' })).rejects.toMatchObject({ code: 'CREATION_LIMIT_EXCEEDED', statusCode: 409 });
    expect(await f.service.list(f.project.id)).toHaveLength(200);
    expect(await f.service.list(f.second.id)).toEqual([]);
  });

  it('rejects direct version mutation and does not regenerate an exported file removed by its owner', async () => {
    const f = await fixture(); const detail = await f.service.create(f.project.id, { kind: 'script', title: '中文长标题'.repeat(30), body: '已保存内容' });
    const snapshot = await f.service.snapshot(f.project.id, detail.item.id, { expectedRevision: 1, finalize: true });
    const version = snapshot.versions[0]!;
    expect(() => f.database.prepare('UPDATE personal_project_creation_versions SET body = ? WHERE id = ?').run('覆盖旧稿', version.id)).toThrow(/immutable/u);
    const exported = await f.service.exportVersion(f.project.id, detail.item.id, version.id);
    expect(Buffer.byteLength(exported.path.split('/').at(-1)!)).toBeLessThan(256);
    await rm(join(f.projectRoot, exported.path));
    await expect(f.service.exportVersion(f.project.id, detail.item.id, version.id)).rejects.toMatchObject({ code: 'CREATION_EXPORT_CONFLICT' });
    expect(existsSync(join(f.projectRoot, exported.path))).toBe(false);
  });

  it('rejects an occupied deterministic output path without changing its contents', async () => {
    const f = await fixture(); const detail = await f.service.create(f.project.id, { kind: 'script', title: '同名占用', body: '导出正文' });
    const snapshot = await f.service.snapshot(f.project.id, detail.item.id, { expectedRevision: 1, finalize: false });
    const version = snapshot.versions[0]!;
    const target = join(f.projectRoot, 'AI工作区', '内容草稿', `同名占用-${detail.item.id}-v1-${version.id}.md`);
    await mkdir(join(f.projectRoot, 'AI工作区', '内容草稿'), { recursive: true });
    await writeFile(target, '预先存在的用户文件');
    await expect(f.service.exportVersion(f.project.id, detail.item.id, version.id)).rejects.toMatchObject({ code: 'CREATION_EXPORT_CONFLICT' });
    expect(await readFile(target, 'utf8')).toBe('预先存在的用户文件');
  });

  it('fails closed for unconfigured services and rejects stale text selections', async () => {
    const f = await httpFixture(); const detail = await f.service.create(f.project.id, { kind: 'script', title: '局部修订', body: '现在的开头' });
    const response = await f.app.inject({ method: 'POST', url: `/api/v1/projects/${f.project.id}/creation-suggestions`, payload: {
      task: 'revise', instruction: '改写', itemId: detail.item.id, expectedRevision: 1, selection: { text: '旧开头', start: 0, end: 3 }
    } });
    expect(response.statusCode).toBe(409); expect(f.generated).toHaveLength(0);
    const empty = Fastify(); registerProjectCreationRoutes(empty); cleanup.push(() => empty.close());
    expect((await empty.inject({ url: `/api/v1/projects/${f.project.id}/creations` })).statusCode).toBe(503);
  });
});

const blankProfileFields = { audience: '', goal: '', style: '', facts: '', avoid: '' };
describe('creative context profiles and references', () => {
  it('persists a blank optional project profile with compare-and-swap revisions without changing project data', async () => {
    const f = await fixture();
    const projectBefore = f.database.prepare('SELECT * FROM personal_projects WHERE id = ?').get(f.project.id);
    expect(await f.service.getProfile(f.project.id)).toEqual({ projectId: f.project.id, revision: 0, ...blankProfileFields, samples: [] });
    const input = { ...blankProfileFields, audience: '独立创作者', facts: '已核对的项目事实', samples: [], expectedRevision: 0 };
    const saved = await f.service.saveProfile(f.project.id, input);
    expect(saved).toMatchObject({ ...blankProfileFields, audience: input.audience, facts: input.facts, revision: 1 });
    await expect(f.service.saveProfile(f.project.id, input)).rejects.toMatchObject({ code: 'CREATIVE_PROFILE_REVISION_CONFLICT', statusCode: 409 });
    f.reopen(); expect(await f.service.getProfile(f.project.id)).toEqual(saved);
    expect((await f.service.getProfile(f.second.id)).revision).toBe(0);
    expect(f.database.prepare('SELECT * FROM personal_projects WHERE id = ?').get(f.project.id)).toEqual(projectBefore);
    await expect(f.service.getProfile(randomUUID())).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('accepts only owned final samples and keeps a selected immutable sample when its draft is finalized again', async () => {
    const f = await fixture();
    const created = await f.service.create(f.project.id, { kind: 'script', title: '样稿', body: '第一份定稿' });
    const draft = await f.service.snapshot(f.project.id, created.item.id, { expectedRevision: 1, finalize: false });
    const profile = { ...blankProfileFields, samples: [{ creationId: created.item.id, versionId: draft.versions[0]!.id }], expectedRevision: 0 };
    await expect(f.service.saveProfile(f.project.id, profile)).rejects.toMatchObject({ code: 'CREATIVE_PROFILE_SAMPLE_INVALID' });
    const finalized = await f.service.snapshot(f.project.id, created.item.id, { expectedRevision: 2, finalize: true });
    profile.samples[0]!.versionId = finalized.versions[0]!.id;
    await expect(f.service.saveProfile(f.second.id, profile)).rejects.toMatchObject({ code: 'CREATIVE_PROFILE_SAMPLE_INVALID' });
    const saved = await f.service.saveProfile(f.project.id, profile);
    const edited = await f.service.save(f.project.id, created.item.id, savedInput(finalized.item, { body: '后续定稿' }));
    await f.service.snapshot(f.project.id, created.item.id, { expectedRevision: edited.item.revision, finalize: true });
    const resaved = await f.service.saveProfile(f.project.id, { ...profile, expectedRevision: saved.revision, style: '口语化' });
    expect(resaved.samples).toEqual(profile.samples);
    expect(await f.service.getProfileContext(f.project.id)).toMatchObject({ profile: resaved, samples: [{ id: finalized.versions[0]!.id, body: '第一份定稿' }] });
    await expect(f.service.saveProfile(f.project.id, { ...profile, expectedRevision: resaved.revision, samples: [{ ...profile.samples[0]!, creationId: randomUUID() }] })).rejects.toMatchObject({ code: 'CREATIVE_PROFILE_SAMPLE_INVALID' });
    f.reopen(); expect((await f.service.getProfileContext(f.project.id)).samples[0]!.body).toBe('第一份定稿');
  });

  it('defaults old drafts to automatic references and preserves saved scopes in snapshots, restores, and exports', async () => {
    const f = await fixture();
    const created = await f.service.create(f.project.id, { kind: 'script', title: '参考范围', body: '正文' });
    expect(created.item.referenceSelection).toEqual({ mode: 'auto', paths: [] });
    const referenceSelection = { mode: 'selected' as const, paths: ['原始资料.md'] };
    const scoped = await f.service.save(f.project.id, created.item.id, savedInput(created.item, { referenceSelection }));
    const preserved = await f.service.save(f.project.id, created.item.id, savedInput(scoped.item, { body: '新正文' }));
    expect(preserved.item.referenceSelection).toEqual(referenceSelection);
    const snapshot = await f.service.snapshot(f.project.id, created.item.id, { expectedRevision: preserved.item.revision, finalize: true });
    expect(snapshot.versions[0]!.referenceSelection).toEqual(referenceSelection);
    const reset = await f.service.save(f.project.id, created.item.id, savedInput(snapshot.item, { referenceSelection: { mode: 'auto', paths: [] } }));
    const restored = await f.service.save(f.project.id, created.item.id, savedInput(reset.item, { referenceSelection: snapshot.versions[0]!.referenceSelection }));
    f.reopen(); expect((await f.service.get(f.project.id, created.item.id)).item.referenceSelection).toEqual(restored.item.referenceSelection);
    const exported = await f.service.exportVersion(f.project.id, created.item.id, snapshot.versions[0]!.id);
    expect(await readFile(join(f.projectRoot, exported.path), 'utf8')).toContain('"paths": [\n    "原始资料.md"');
  });

  it('rejects malformed reference scopes and item request overrides, and supports non-item profile requests', async () => {
    const invalid = [
      { mode: 'auto', paths: ['原始资料.md'] }, { mode: 'selected', paths: [] },
      { mode: 'selected', paths: ['原始资料.md', '原始资料.md'] }, { mode: 'selected', paths: ['../secret.md'] },
      { mode: 'selected', paths: ['/private.md'] }, { mode: 'selected', paths: ['AI工作区'] },
      { mode: 'selected', paths: ['AI工作区/内容草稿/稿件.md'] }, { mode: 'selected', paths: Array.from({ length: 21 }, (_, i) => `${i}.md`) },
      { mode: 'auto', paths: [], rootPath: '/tmp' }
    ];
    for (const referenceSelection of invalid) expect(creationCreateSchema.safeParse({ kind: 'script', title: '无效范围', referenceSelection }).success).toBe(false);
    const referenceSelection = { mode: 'selected', paths: ['原始资料.md'] };
    expect(creationGenerateRequestSchema.safeParse({ task: 'topics', instruction: '选题', referenceSelection }).success).toBe(true);
    expect(creationGenerateRequestSchema.safeParse({ task: 'script', instruction: '写稿', itemId: randomUUID(), expectedRevision: 1, referenceSelection }).success).toBe(false);
    expect(creationGenerateRequestSchema.safeParse({ task: 'profile', instruction: '起草创作档案' }).success).toBe(true);
    expect(creationGenerateRequestSchema.safeParse({ task: 'profile', instruction: '起草创作档案', itemId: randomUUID(), expectedRevision: 1 }).success).toBe(false);
  });

  it('validates profile HTTP contracts and rejects unknown fields, duplicate samples and overlong profile values', async () => {
    const f = await httpFixture(); const url = `/api/v1/projects/${f.project.id}/creative-profile`;
    const blank = await f.app.inject({ url }); expect(blank.statusCode).toBe(200); expect(blank.headers['cache-control']).toBe('no-store');
    expect(blank.json().data.revision).toBe(0);
    const payload = { ...blankProfileFields, samples: [], expectedRevision: 0 };
    const save = await f.app.inject({ method: 'PUT', url, payload }); expect(save.statusCode).toBe(200); expect(save.json().data.revision).toBe(1);
    expect((await f.app.inject({ method: 'PUT', url, payload })).statusCode).toBe(409);
    const repeatedSample = { creationId: randomUUID(), versionId: randomUUID() };
    for (const invalid of [{ ...payload, samples: [repeatedSample, repeatedSample] }, { ...payload, samples: Array.from({ length: 4 }, () => ({ creationId: randomUUID(), versionId: randomUUID() })) }, { ...payload, rootPath: f.otherRoot }, { ...payload, goal: '字'.repeat(2001) }, { ...payload, facts: '字'.repeat(4001) }, { ...payload, expectedRevision: -1 }]) {
      expect((await f.app.inject({ method: 'PUT', url, payload: invalid })).statusCode).toBe(400);
    }
  });
});

describe('recoverable creation lifecycle', () => {
  it('discards and restores the same draft across restart with all history and export bytes intact', async () => {
    const f = await fixture();
    const initial = await f.service.create(f.project.id, { kind: 'script', title: '可恢复稿件', body: '原始正文' });
    await f.service.recordExchange(f.project.id, initial.item.id, { instruction: '保留讨论', suggestion: suggestion({ baseRevision: 1 }) });
    const finalized = await f.service.snapshot(f.project.id, initial.item.id, { expectedRevision: 1, finalize: true });
    const exported = await f.service.exportVersion(f.project.id, initial.item.id, finalized.versions[0]!.id);
    const bytes = await readFile(join(f.projectRoot, exported.path));
    const receipts = f.database.prepare('SELECT * FROM personal_project_creation_exports').all();
    const discarded = await f.service.discard(f.project.id, initial.item.id, { expectedRevision: 2 });
    expect(discarded.item).toMatchObject({ id: initial.item.id, revision: 3, discardedAt: expect.any(String) });
    expect(discarded.versions).toEqual(finalized.versions); expect(discarded.messages).toEqual(finalized.messages);
    expect(await f.service.list(f.project.id)).toEqual([]); expect(await f.service.listDiscarded(f.project.id)).toEqual([discarded.item]);
    f.reopen(); expect(await f.service.get(f.project.id, initial.item.id)).toEqual(discarded);
    const restored = await f.service.restore(f.project.id, initial.item.id, { expectedRevision: 3 });
    expect(restored.item.discardedAt).toBeUndefined(); expect(restored.item.revision).toBe(4);
    expect(restored.versions).toEqual(finalized.versions); expect(restored.messages).toEqual(finalized.messages);
    expect(await f.service.listDiscarded(f.project.id)).toEqual([]); expect(await f.service.list(f.project.id)).toEqual([restored.item]);
    expect(await readFile(join(f.projectRoot, exported.path))).toEqual(bytes);
    expect(f.database.prepare('SELECT * FROM personal_project_creation_exports').all()).toEqual(receipts);
  });

  it('rejects stale or foreign lifecycle writes and all mutations of discarded creations', async () => {
    const f = await fixture(); const initial = await f.service.create(f.project.id, { kind: 'script', title: '状态边界' });
    const final = await f.service.snapshot(f.project.id, initial.item.id, { expectedRevision: 1, finalize: true });
    await expect(f.service.discard(f.second.id, initial.item.id, { expectedRevision: 2 })).rejects.toMatchObject({ code: 'CREATION_NOT_FOUND' });
    await expect(f.service.discard(f.project.id, initial.item.id, { expectedRevision: 1 })).rejects.toMatchObject({ code: 'CREATION_REVISION_CONFLICT' });
    const removed = await f.service.discard(f.project.id, initial.item.id, { expectedRevision: 2 });
    for (const operation of [
      () => f.service.save(f.project.id, initial.item.id, savedInput(removed.item)),
      () => f.service.snapshot(f.project.id, initial.item.id, { expectedRevision: removed.item.revision, finalize: true }),
      () => f.service.exportVersion(f.project.id, initial.item.id, final.versions[0]!.id),
      () => f.service.recordExchange(f.project.id, initial.item.id, { instruction: '迟到回复', suggestion: suggestion({ baseRevision: 2 }) })
    ]) await expect(operation()).rejects.toMatchObject({ code: 'CREATION_DISCARDED', statusCode: 409 });
    await expect(f.service.restore(f.second.id, initial.item.id, { expectedRevision: 3 })).rejects.toMatchObject({ code: 'CREATION_NOT_FOUND' });
    await expect(f.service.restore(f.project.id, initial.item.id, { expectedRevision: 2 })).rejects.toMatchObject({ code: 'CREATION_REVISION_CONFLICT' });
    await f.service.restore(f.project.id, initial.item.id, { expectedRevision: 3 });
    await expect(f.service.recordExchange(f.project.id, initial.item.id, { instruction: '复活后旧回复', suggestion: suggestion({ baseRevision: 2 }) })).rejects.toMatchObject({ code: 'CREATION_REVISION_CONFLICT' });
    expect((await f.service.get(f.project.id, initial.item.id)).messages).toEqual([]);
  });

  it('atomically removes discarded samples and prevents a stale profile from reattaching them', async () => {
    const f = await fixture(); const initial = await f.service.create(f.project.id, { kind: 'script', title: '样稿' });
    const final = await f.service.snapshot(f.project.id, initial.item.id, { expectedRevision: 1, finalize: true });
    const input = { ...blankProfileFields, style: '保留风格', samples: [{ creationId: initial.item.id, versionId: final.versions[0]!.id }], expectedRevision: 0 };
    const profile = await f.service.saveProfile(f.project.id, input);
    await f.service.discard(f.project.id, initial.item.id, { expectedRevision: 2 });
    expect(await f.service.getProfileContext(f.project.id)).toMatchObject({ profile: { style: input.style, revision: 2, samples: [] }, samples: [] });
    await expect(f.service.saveProfile(f.project.id, { ...input, expectedRevision: profile.revision })).rejects.toMatchObject({ code: 'CREATIVE_PROFILE_REVISION_CONFLICT' });
    await expect(f.service.saveProfile(f.project.id, { ...input, expectedRevision: 2 })).rejects.toMatchObject({ code: 'CREATIVE_PROFILE_SAMPLE_INVALID' });
    await f.service.restore(f.project.id, initial.item.id, { expectedRevision: 3 });
    expect((await f.service.getProfile(f.project.id)).samples).toEqual([]);
  });

  it('frees active capacity on discard and refuses an over-capacity restore without losing it', async () => {
    const f = await fixture(); const first = await f.service.create(f.project.id, { kind: 'topic', title: '可回收' });
    for (let index = 1; index < 200; index++) await f.service.create(f.project.id, { kind: 'topic', title: `选题${index}` });
    await f.service.discard(f.project.id, first.item.id, { expectedRevision: 1 });
    const replacement = await f.service.create(f.project.id, { kind: 'topic', title: '腾出的空间' });
    await expect(f.service.restore(f.project.id, first.item.id, { expectedRevision: 2 })).rejects.toMatchObject({ code: 'CREATION_LIMIT_EXCEEDED' });
    expect(await f.service.listDiscarded(f.project.id)).toHaveLength(1);
    await f.service.discard(f.project.id, replacement.item.id, { expectedRevision: 1 });
    await f.service.restore(f.project.id, first.item.id, { expectedRevision: 2 });
    expect(await f.service.list(f.project.id)).toHaveLength(200);
  });

  it('does not discard while an export is running and releases the busy state afterwards', async () => {
    const f = await fixture(); const initial = await f.service.create(f.project.id, { kind: 'script', title: '正在导出' });
    const final = await f.service.snapshot(f.project.id, initial.item.id, { expectedRevision: 1, finalize: true });
    const exporting = f.service.exportVersion(f.project.id, initial.item.id, final.versions[0]!.id);
    try { await expect(f.service.discard(f.project.id, initial.item.id, { expectedRevision: 2 })).rejects.toMatchObject({ code: 'CREATION_BUSY' }); }
    finally { await exporting; }
    expect((await f.service.discard(f.project.id, initial.item.id, { expectedRevision: 2 })).item.discardedAt).toBeDefined();
  });

  it('persists an idempotent suggestion dismissal without changing the draft or versions', async () => {
    const f = await fixture(); const initial = await f.service.create(f.project.id, { kind: 'script', title: '明确放弃', body: '保持原稿' });
    const candidate = suggestion({ baseRevision: 1 });
    await f.service.recordExchange(f.project.id, initial.item.id, { instruction: '提出建议', suggestion: candidate });
    await expect(f.service.dismissSuggestion(f.second.id, initial.item.id, candidate.id)).rejects.toMatchObject({ code: 'CREATION_NOT_FOUND' });
    await expect(f.service.dismissSuggestion(f.project.id, initial.item.id, randomUUID())).rejects.toMatchObject({ code: 'CREATION_SUGGESTION_NOT_FOUND' });
    const dismissed = await f.service.dismissSuggestion(f.project.id, initial.item.id, candidate.id);
    expect(dismissed.item).toEqual(initial.item); expect(dismissed.versions).toEqual([]);
    expect(dismissed.messages[0]).toMatchObject({ suggestion: candidate, dismissedAt: expect.any(String) });
    expect(await f.service.dismissSuggestion(f.project.id, initial.item.id, candidate.id)).toEqual(dismissed);
    f.reopen(); expect(await f.service.get(f.project.id, initial.item.id)).toEqual(dismissed);
  });

  it('exposes strict discard/restore/list/dismiss endpoints and rejects generation for discarded items', async () => {
    const f = await httpFixture(); const initial = await f.service.create(f.project.id, { kind: 'script', title: '接口回收' });
    const base = `/api/v1/projects/${f.project.id}/creations`; const itemPath = `${base}/${initial.item.id}`;
    const candidate = suggestion({ baseRevision: 1 });
    await f.service.recordExchange(f.project.id, initial.item.id, { instruction: '建议', suggestion: candidate });
    expect((await f.app.inject({ method: 'POST', url: `${itemPath}/suggestions/${candidate.id}/dismiss`, payload: {} })).statusCode).toBe(200);
    expect((await f.app.inject({ method: 'POST', url: `${itemPath}/discard`, payload: { expectedRevision: 1, rootPath: 'ignored' } })).statusCode).toBe(400);
    const discarded = await f.app.inject({ method: 'POST', url: `${itemPath}/discard`, payload: { expectedRevision: 1 } });
    expect(discarded.statusCode).toBe(200); expect(discarded.headers['cache-control']).toBe('no-store');
    expect((await f.app.inject({ url: base })).json().data.items).toEqual([]);
    expect((await f.app.inject({ url: `${base}/discarded` })).json().data.items).toHaveLength(1);
    const generated = await f.app.inject({ method: 'POST', url: `/api/v1/projects/${f.project.id}/creation-suggestions`, payload: { task: 'script', instruction: '不应发送', itemId: initial.item.id, expectedRevision: 2 } });
    expect(generated.statusCode).toBe(409); expect(f.generated).toHaveLength(0);
    expect((await f.app.inject({ method: 'POST', url: `${itemPath}/restore`, payload: { expectedRevision: 2 } })).statusCode).toBe(200);
  });
});

describe('idempotent candidate acceptance', () => {
  it('returns one creation for repeated requests, including after edits or discard, without resurrecting it', async () => {
    const f = await fixture(); const request = { kind: 'topic' as const, title: '只保存一次', requestId: randomUUID() };
    const [first, repeated] = await Promise.all([f.service.create(f.project.id, request), f.service.create(f.project.id, request)]);
    expect(repeated).toEqual(first); expect(await f.service.list(f.project.id)).toHaveLength(1);
    const changed = await f.service.save(f.project.id, first.item.id, savedInput(first.item, { title: '用户后来改的标题' }));
    expect(await f.service.create(f.project.id, request)).toEqual(changed);
    const removed = await f.service.discard(f.project.id, first.item.id, { expectedRevision: changed.item.revision });
    f.reopen(); expect(await f.service.create(f.project.id, request)).toEqual(removed);
    expect(await f.service.list(f.project.id)).toEqual([]); expect(await f.service.listDiscarded(f.project.id)).toHaveLength(1);
  });

  it('rejects reuse for a different payload and scopes request identities to the owning project', async () => {
    const f = await fixture(); const request = { kind: 'topic' as const, title: '同一请求', requestId: randomUUID() };
    const first = await f.service.create(f.project.id, request);
    await expect(f.service.create(f.project.id, { ...request, title: '不同内容' })).rejects.toMatchObject({ code: 'CREATION_REQUEST_CONFLICT', statusCode: 409 });
    const second = await f.service.create(f.second.id, request); expect(second.item.id).not.toBe(first.item.id);
    expect((await f.service.create(f.project.id, { ...request, brief: '', referenceSelection: { mode: 'auto', paths: [] } })).item.id).toBe(first.item.id);
  });

  it('requires the generating profile revision on first acceptance but permits retries after that profile changes', async () => {
    const f = await fixture(); const request = { kind: 'topic' as const, title: '档案已变化', requestId: randomUUID(), expectedProfileRevision: 1 };
    await expect(f.service.create(f.project.id, request)).rejects.toMatchObject({ code: 'CREATIVE_PROFILE_REVISION_CONFLICT' });
    expect(await f.service.list(f.project.id)).toEqual([]);
    const profile = { ...blankProfileFields, samples: [], expectedRevision: 0 };
    await f.service.saveProfile(f.project.id, profile);
    const first = await f.service.create(f.project.id, request);
    await f.service.saveProfile(f.project.id, { ...profile, expectedRevision: 1, style: '新风格' });
    await expect(f.service.create(f.project.id, { ...request, requestId: randomUUID() })).rejects.toMatchObject({ code: 'CREATIVE_PROFILE_REVISION_CONFLICT' });
    expect(await f.service.create(f.project.id, request)).toEqual(first);
    expect(await f.service.list(f.project.id)).toHaveLength(1);
  });
});
