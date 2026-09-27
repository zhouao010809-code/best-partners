import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createProjectService } from '../../src/server/projects/project-service.js';
import { createProjectWritePlanService } from '../../src/server/projects/project-write-plans.js';
import * as attachmentParser from '../../src/server/attachments/parser.js';
import { scanProjectFolder } from '../../src/server/projects/project-scanner.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(options: { scan?: typeof scanProjectFolder } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'project-write-plan-'));
  const projectRoot = join(root, 'project'); const vaultRoot = join(root, 'vault'); const stateRoot = join(root, 'state');
  await mkdir(projectRoot); await mkdir(vaultRoot); await mkdir(stateRoot); await writeFile(join(projectRoot, 'README.md'), '# 说明\n');
  const database = new Database(':memory:'); applyMigrations(database);
  database.prepare('INSERT INTO assistant_conversations (id, updated_at, payload) VALUES (?, ?, ?)').run('conversation-1', new Date().toISOString(), '{}');
  const projects = createProjectService({ database, vaultRoot, stateRoot, ...options }); const plans = createProjectWritePlanService({ database });
  const scan = await projects.scan(projectRoot); const project = await projects.bind(scan.scanId, { sourceSha256: scan.sourceSha256 });
  cleanups.push(async () => { await projects.close(); database.close(); await rm(root, { recursive: true, force: true }); });
  return { database, projectRoot, project, plans, projects };
}

describe('project write plans', () => {
  it('immediately indexes each confirmed output without changing source revision or invalidating other pending plans', async () => {
    const f = await fixture();
    const first = await f.plans.proposeDraft({ projectId: f.project.id, conversationId: 'conversation-1', messageId: 'message-1', category: '内容草稿', title: '第一个输出', summary: '第一份', content: '# 第一份\n即时可读', expectedRevision: 1 });
    const second = await f.plans.proposeDraft({ projectId: f.project.id, conversationId: 'conversation-1', messageId: 'message-1', category: '周计划', title: '第二个输出', summary: '第二份', content: '# 第二份', expectedRevision: 1 });
    const completed = await f.plans.confirm(first.id, 'conversation-1', '2c0ce1ae-511b-4bf4-9a9d-444444444451');
    const outputs = await f.projects.listFiles(f.project.id, { origin: 'output' });
    expect(outputs).toMatchObject({ revision: 1, items: expect.arrayContaining([expect.objectContaining({ relativePath: first.targetPath, kind: 'file', origin: 'output', parseStatus: 'readable', sha256: completed.contentSha256 })]) });
    expect(await f.projects.readFile(f.project.id, first.targetPath)).toMatchObject({ content: '# 第一份\n即时可读', sha256: completed.contentSha256 });
    expect((await f.projects.listFiles(f.project.id, { origin: 'output', search: '即时可读' })).items).toHaveLength(1);
    expect((await f.projects.listFiles(f.project.id, { origin: 'source' })).items.map(item => item.relativePath)).toEqual(['README.md']);
    expect((await f.projects.get(f.project.id)).sourceRevision).toBe(1);
    expect(f.plans.project(second.id)?.status).toBe('pending');
    expect((await f.plans.confirm(second.id, 'conversation-1', '2c0ce1ae-511b-4bf4-9a9d-444444444452')).status).toBe('completed');
    expect((await f.projects.listFiles(f.project.id, { origin: 'output' })).items.filter(item => item.kind === 'file')).toHaveLength(2);
  });

  it('preserves the completed receipt when indexing fails and repairs only the index on an idempotent retry', async () => {
    const f = await fixture();
    const action = await f.plans.proposeDraft({ projectId: f.project.id, conversationId: 'conversation-1', messageId: 'message-1', category: '工作日志', title: '待同步输出', summary: '日志', content: '# 已保存正文', expectedRevision: 1 });
    const requestId = '2c0ce1ae-511b-4bf4-9a9d-444444444453';
    f.database.exec("CREATE TRIGGER reject_output_index BEFORE INSERT ON personal_project_files WHEN NEW.origin = 'output' BEGIN SELECT RAISE(FAIL, 'index unavailable'); END;");
    const receipt = await f.plans.confirm(action.id, 'conversation-1', requestId);
    expect(receipt).toMatchObject({ status: 'completed', resultPath: action.targetPath, problem: expect.stringContaining('已保存') });
    expect(await readFile(join(f.projectRoot, action.targetPath), 'utf8')).toBe('# 已保存正文');
    const before = await stat(join(f.projectRoot, action.targetPath));
    expect(f.plans.project(action.id)).toMatchObject({ status: 'completed', problem: receipt.problem });
    f.database.exec('DROP TRIGGER reject_output_index');
    const repaired = await f.plans.confirm(action.id, 'conversation-1', requestId);
    expect(repaired.status).toBe('completed');
    expect(repaired.problem).toBeUndefined();
    const after = await stat(join(f.projectRoot, action.targetPath));
    expect([after.ino, after.mtimeMs, after.ctimeMs]).toEqual([before.ino, before.mtimeMs, before.ctimeMs]);
    expect(await f.projects.readFile(f.project.id, action.targetPath)).toMatchObject({ content: '# 已保存正文' });
    expect((await f.plans.operations(f.project.id)).filter(operation => operation.eventType === 'project-write')).toHaveLength(1);
  });

  it('does not overwrite or index an externally changed output while repairing a completed receipt', async () => {
    const f = await fixture();
    const action = await f.plans.proposeDraft({ projectId: f.project.id, conversationId: 'conversation-1', messageId: 'message-1', category: '工作日志', title: '之后手动修改', summary: '日志', content: 'original', expectedRevision: 1 });
    const requestId = '2c0ce1ae-511b-4bf4-9a9d-444444444454';
    f.database.exec("CREATE TRIGGER reject_output_index BEFORE INSERT ON personal_project_files WHEN NEW.origin = 'output' BEGIN SELECT RAISE(FAIL, 'index unavailable'); END;");
    await f.plans.confirm(action.id, 'conversation-1', requestId);
    f.database.exec('DROP TRIGGER reject_output_index');
    await writeFile(join(f.projectRoot, action.targetPath), 'user edit');
    expect(await f.plans.confirm(action.id, 'conversation-1', requestId)).toMatchObject({ status: 'completed', problem: expect.stringContaining('已保存') });
    expect(await readFile(join(f.projectRoot, action.targetPath), 'utf8')).toBe('user edit');
    expect((await f.projects.listFiles(f.project.id, { origin: 'output' })).items).toEqual([]);
  });

  it('keeps the saved receipt when an out-of-band project context change occurs during parsing', async () => {
    const f = await fixture();
    const action = await f.plans.proposeDraft({ projectId: f.project.id, conversationId: 'conversation-1', messageId: 'message-1', category: '内容草稿', title: '旧目录输出', summary: '旧项目输出', content: '# old root content', expectedRevision: 1 });
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const originalParse = attachmentParser.parseAttachment;
    const parser = vi.spyOn(attachmentParser, 'parseAttachment').mockImplementationOnce(async (...args) => { await paused; return originalParse(...args); });
    const pending = f.plans.confirm(action.id, 'conversation-1', '2c0ce1ae-511b-4bf4-9a9d-444444444455');
    try {
      await vi.waitFor(() => expect(parser).toHaveBeenCalledOnce());
      const nextRoot = join(f.projectRoot, '..', 'reconnected-project');
      await mkdir(nextRoot);
      await writeFile(join(nextRoot, 'README.md'), '# Replacement project');
      // Simulate an external state change that cannot participate in the
      // in-process lock; the final transaction must retain its own guard.
      f.database.prepare('UPDATE personal_projects SET root_path = ?, source_revision = source_revision + 1 WHERE id = ?').run(await realpath(nextRoot), f.project.id);
    } finally { release(); }
    expect(await pending).toMatchObject({ status: 'completed', problem: expect.stringContaining('已保存') });
    expect(await readFile(join(f.projectRoot, action.targetPath), 'utf8')).toBe('# old root content');
    expect((await f.projects.listFiles(f.project.id, { origin: 'output' })).items).toEqual([]);
    expect(await f.projects.readFile(f.project.id, 'README.md')).toMatchObject({ content: '# Replacement project' });
  });

  it('queues confirmation behind an in-flight full refresh so its old snapshot cannot erase the saved output', async () => {
    let pauseNextScan = false;
    let snapshotReady!: () => void;
    let releaseSnapshot!: () => void;
    const ready = new Promise<void>(resolve => { snapshotReady = resolve; });
    const paused = new Promise<void>(resolve => { releaseSnapshot = resolve; });
    const f = await fixture({ scan: async (...args) => {
      const snapshot = await scanProjectFolder(...args);
      if (pauseNextScan) { pauseNextScan = false; snapshotReady(); await paused; }
      return snapshot;
    } });
    const action = await f.plans.proposeDraft({ projectId: f.project.id, conversationId: 'conversation-1', messageId: 'message-1', category: '内容草稿', title: '刷新后的输出', summary: '输出', content: '# must remain indexed', expectedRevision: 1 });
    pauseNextScan = true;
    const refreshing = f.projects.refresh(f.project.id);
    await ready;
    const confirming = f.plans.confirm(action.id, 'conversation-1', '2c0ce1ae-511b-4bf4-9a9d-444444444456');
    let completedBeforeRefresh = false;
    try {
      completedBeforeRefresh = await Promise.race([confirming.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 100))]);
    } finally { releaseSnapshot(); }
    const [refreshed, confirmed] = await Promise.all([refreshing, confirming]);
    expect(completedBeforeRefresh).toBe(false);
    expect(refreshed.sourceRevision).toBe(1);
    expect(confirmed).toMatchObject({ status: 'completed', resultPath: action.targetPath });
    expect(confirmed.problem).toBeUndefined();
    expect((await f.projects.listFiles(f.project.id, { origin: 'output' })).items).toContainEqual(expect.objectContaining({ relativePath: action.targetPath }));
    expect(await f.projects.readFile(f.project.id, action.targetPath)).toMatchObject({ content: '# must remain indexed' });
  });

  it('queues reconnect behind a confirmation already parsing its saved output', async () => {
    const f = await fixture();
    const nextRoot = join(f.projectRoot, '..', 'replacement');
    await mkdir(nextRoot);
    await writeFile(join(nextRoot, 'README.md'), '# Replacement');
    const preview = await f.projects.scan(nextRoot);
    const action = await f.plans.proposeDraft({ projectId: f.project.id, conversationId: 'conversation-1', messageId: 'message-1', category: '工作日志', title: '先完成保存', summary: '输出', content: '# saved before reconnect', expectedRevision: 1 });
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const originalParse = attachmentParser.parseAttachment;
    const parser = vi.spyOn(attachmentParser, 'parseAttachment').mockImplementationOnce(async (...args) => { await paused; return originalParse(...args); });
    const confirming = f.plans.confirm(action.id, 'conversation-1', '2c0ce1ae-511b-4bf4-9a9d-444444444457');
    await vi.waitFor(() => expect(parser).toHaveBeenCalledOnce());
    const reconnecting = f.projects.reconnect(f.project.id, preview.scanId, { sourceSha256: preview.sourceSha256 });
    let reconnectedBeforeSave = false;
    try {
      reconnectedBeforeSave = await Promise.race([reconnecting.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 100))]);
    } finally { release(); }
    const [confirmed] = await Promise.all([confirming, reconnecting]);
    expect(reconnectedBeforeSave).toBe(false);
    expect(confirmed.status).toBe('completed');
    expect(confirmed.problem).toBeUndefined();
    expect(await readFile(join(f.projectRoot, action.targetPath), 'utf8')).toBe('# saved before reconnect');
    expect((await f.projects.listFiles(f.project.id, { origin: 'output' })).items).toEqual([]);
  });

  it('keeps draft content private until explicit confirmation', async () => {
    const f = await fixture();
    const action = await f.plans.proposeDraft({ projectId: f.project.id, conversationId: 'conversation-1', messageId: 'message-1', category: '周计划', title: '下周获客内容', summary: '保存周计划草稿', content: '# 下周获客内容', expectedRevision: 1 });
    expect(action.status).toBe('pending'); expect(action.targetPath).toMatch(/^AI工作区\/周计划\//u); expect(action).not.toHaveProperty('content');
    await expect(readFile(join(f.projectRoot, action.targetPath))).rejects.toThrow();
    await expect(f.plans.confirm(action.id, f.project.id, '2c0ce1ae-511b-4bf4-9a9d-444444444448')).rejects.toMatchObject({ code: 'PROJECT_WRITE_PLAN_NOT_FOUND' });
    const completed = await f.plans.confirm(action.id, 'conversation-1', '2c0ce1ae-511b-4bf4-9a9d-444444444444');
    expect(completed.status).toBe('completed'); expect(await readFile(join(f.projectRoot, completed.resultPath!), 'utf8')).toContain('下周获客内容');
    expect(await f.plans.confirm(action.id, 'conversation-1', '2c0ce1ae-511b-4bf4-9a9d-444444444444')).toEqual(completed);
    expect((await f.plans.operations(f.project.id))[0]).toMatchObject({ targetPath: completed.targetPath, status: 'completed' });
  });

  it('makes stale plans safe and does not overwrite an existing target', async () => {
    const f = await fixture();
    const action = await f.plans.proposeDraft({ projectId: f.project.id, conversationId: 'conversation-1', messageId: 'message-1', category: '内容草稿', title: '同名内容', summary: '草稿', content: 'one', expectedRevision: 1 });
    await mkdir(join(f.projectRoot, 'AI工作区', '内容草稿'), { recursive: true });
    await writeFile(join(f.projectRoot, action.targetPath), 'existing');
    await expect(f.plans.confirm(action.id, 'conversation-1', '2c0ce1ae-511b-4bf4-9a9d-444444444445')).rejects.toMatchObject({ code: 'PROJECT_OUTPUT_EXISTS' });
    expect(f.plans.project(action.id)?.status).toBe('stale'); expect(await readFile(join(f.projectRoot, action.targetPath), 'utf8')).toBe('existing');
  });

  it('cancels without creating a file and makes confirmation idempotent', async () => {
    const f = await fixture();
    const action = await f.plans.proposeDraft({ projectId: f.project.id, conversationId: 'conversation-1', messageId: 'message-1', category: '工作日志', title: '今日工作', summary: '日志', content: 'hello', expectedRevision: 1 });
    const requestId = '2c0ce1ae-511b-4bf4-9a9d-444444444446'; const cancelled = f.plans.cancel(action.id, 'conversation-1', requestId);
    expect(cancelled.status).toBe('cancelled'); expect(f.plans.cancel(action.id, 'conversation-1', requestId)).toMatchObject({ status: 'cancelled' });
    await expect(readFile(join(f.projectRoot, action.targetPath))).rejects.toThrow();
  });

  it('rejects stale revisions, oversized content and invalid categories', async () => {
    const f = await fixture();
    const stale = await f.plans.proposeDraft({ projectId: f.project.id, conversationId: 'conversation-1', messageId: 'message-1', category: '周计划', title: '过期计划', summary: '计划', content: 'stale', expectedRevision: 1 });
    await writeFile(join(f.projectRoot, 'README.md'), '# changed\n'); await f.projects.refresh(f.project.id);
    expect((await f.plans.confirm(stale.id, 'conversation-1', '2c0ce1ae-511b-4bf4-9a9d-444444444449')).status).toBe('stale');
    await expect(f.plans.proposeDraft({ projectId: f.project.id, conversationId: 'conversation-1', messageId: 'message-1', category: '周计划', title: '大文件', summary: '计划', content: '字'.repeat(80_001), expectedRevision: 2 })).rejects.toMatchObject({ code: 'PROJECT_OUTPUT_TOO_LARGE' });
    await expect(f.plans.proposeDraft({ projectId: f.project.id, conversationId: 'conversation-1', messageId: 'message-1', category: '../越界' as never, title: '标题', summary: '计划', content: 'x', expectedRevision: 2 })).rejects.toMatchObject({ code: 'PROJECT_CATEGORY_INVALID' });
  });

  it('rejects symlinked output parents and records relative hashes only', async () => {
    const f = await fixture(); const outside = join(f.projectRoot, 'outside'); await mkdir(outside); await mkdir(join(f.projectRoot, 'AI工作区')); await symlink(outside, join(f.projectRoot, 'AI工作区', '工作日志'));
    const action = await f.plans.proposeDraft({ projectId: f.project.id, conversationId: 'conversation-1', messageId: 'message-1', category: '工作日志', title: '符号链接', summary: '日志', content: 'hello', expectedRevision: 1 });
    await expect(f.plans.confirm(action.id, 'conversation-1', '2c0ce1ae-511b-4bf4-9a9d-444444444450')).rejects.toMatchObject({ code: 'PROJECT_OUTPUT_WRITE_FAILED' });
    const operation = (await f.plans.operations(f.project.id)).find(item => item.id);
    expect(operation?.targetPath.startsWith('/')).toBe(false); expect(operation?.oldSha256).toBeUndefined(); expect(operation?.newSha256).toBeUndefined(); expect(operation?.status).toBe('failed');
  });
});
