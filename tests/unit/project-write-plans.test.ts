import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createProjectService } from '../../src/server/projects/project-service.js';
import { createProjectWritePlanService } from '../../src/server/projects/project-write-plans.js';
import * as attachmentParser from '../../src/server/attachments/parser.js';
import { scanProjectFolder } from '../../src/server/projects/project-scanner.js';
import type { ProjectWriteAction } from '../../src/shared/api/projects.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), link: vi.fn(actual.link) };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(options: { scan?: typeof scanProjectFolder; durable?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'project-write-plan-'));
  const projectRoot = join(root, 'project'); const vaultRoot = join(root, 'vault'); const stateRoot = join(root, 'state');
  await mkdir(projectRoot); await mkdir(vaultRoot); await mkdir(stateRoot); await writeFile(join(projectRoot, 'README.md'), '# 说明\n');
  const databasePath = join(stateRoot, 'projects.sqlite');
  const database = new Database(options.durable ? databasePath : ':memory:'); applyMigrations(database);
  database.prepare('INSERT INTO assistant_conversations (id, updated_at, payload) VALUES (?, ?, ?)').run('conversation-1', new Date().toISOString(), '{}');
  const projects = createProjectService({ database, vaultRoot, stateRoot, ...options }); const plans = createProjectWritePlanService({ database });
  const scan = await projects.scan(projectRoot); const project = await projects.bind(scan.scanId, { sourceSha256: scan.sourceSha256 });
  cleanups.push(async () => { await projects.close(); if (database.open) database.close(); await rm(root, { recursive: true, force: true }); });
  return { database, databasePath, projectRoot, project, plans, projects };
}

const recoveryRequestId = '2c0ce1ae-511b-4bf4-9a9d-444444444461';
const recoveryContent = '# 已确认输出\n只写一次';
async function recoveryDraft(f: Awaited<ReturnType<typeof fixture>>) {
  return f.plans.proposeDraft({ projectId: f.project.id, conversationId: 'conversation-1', messageId: 'message-1', category: '内容草稿', title: '恢复输出', summary: '保存已确认草稿', content: recoveryContent, expectedRevision: 1 });
}
async function persistInterruptedConfirmation(f: Awaited<ReturnType<typeof fixture>>, action: ProjectWriteAction) {
  const rootPath = await realpath(f.projectRoot);
  const root = await stat(rootPath);
  f.database.transaction(() => {
    f.database.prepare("UPDATE personal_project_write_plans SET status = 'running', confirm_request_id = ?, expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(recoveryRequestId, action.id);
    f.database.prepare(`INSERT INTO personal_project_operations (id,project_id,plan_id,event_type,target_path,new_sha256,payload_json,created_at)
      VALUES (?,?,?,'project-write',?,?,?,?)`).run('2c0ce1ae-511b-4bf4-9a9d-444444444462', f.project.id, action.id, action.targetPath, action.contentSha256,
      JSON.stringify({ status: 'running', confirmation: { planId: action.id, clientRequestId: recoveryRequestId, targetPath: action.targetPath, contentSha256: action.contentSha256, sourceRevision: action.sourceRevision, rootPath, rootDev: root.dev, rootIno: root.ino } }), new Date().toISOString());
  })();
}

describe('interrupted project confirmations', () => {
  it('gives same-title plans distinct targets tied to their plan identity', async () => {
    const f = await fixture();
    const first = await recoveryDraft(f); const second = await recoveryDraft(f);
    expect(first.targetPath).toContain(first.id);
    expect(second.targetPath).toContain(second.id);
    expect(first.targetPath).not.toBe(second.targetPath);
  });

  it('keeps long Chinese titles within the filesystem filename limit', async () => {
    const f = await fixture();
    const action = await f.plans.proposeDraft({ projectId: f.project.id, conversationId: 'conversation-1', messageId: 'message-1', category: '内容草稿', title: '长'.repeat(100), summary: '标题很长', content: recoveryContent, expectedRevision: 1 });
    expect(Buffer.byteLength(action.targetPath.split('/').at(-1)!, 'utf8')).toBeLessThanOrEqual(255);
    expect(await f.plans.confirm(action.id, 'conversation-1', recoveryRequestId)).toMatchObject({ status: 'completed' });
  });

  it('continues only the original confirmed request when the target is absent after restart', async () => {
    const f = await fixture(); const action = await recoveryDraft(f);
    await persistInterruptedConfirmation(f, action);
    const restarted = createProjectWritePlanService({ database: f.database });
    await expect(restarted.confirm(action.id, 'conversation-1', '2c0ce1ae-511b-4bf4-9a9d-444444444463')).rejects.toMatchObject({ code: 'PROJECT_WRITE_PLAN_RESOLVED' });
    expect(await restarted.operations(f.project.id)).toEqual([]);
    expect(await restarted.confirm(action.id, 'conversation-1', recoveryRequestId)).toMatchObject({ status: 'completed', resultPath: action.targetPath });
    expect(await readFile(join(f.projectRoot, action.targetPath), 'utf8')).toBe(recoveryContent);
    expect(await f.projects.readFile(f.project.id, action.targetPath)).toMatchObject({ content: recoveryContent });
    const before = await stat(join(f.projectRoot, action.targetPath));
    await restarted.confirm(action.id, 'conversation-1', recoveryRequestId);
    const after = await stat(join(f.projectRoot, action.targetPath));
    expect([after.ino, after.mtimeMs, after.ctimeMs]).toEqual([before.ino, before.mtimeMs, before.ctimeMs]);
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM personal_project_operations WHERE plan_id = ?').get(action.id)).toEqual({ count: 1 });
  });

  it('repairs the receipt for an already published matching file without rewriting it', async () => {
    const f = await fixture(); const action = await recoveryDraft(f);
    await persistInterruptedConfirmation(f, action);
    await mkdir(join(f.projectRoot, 'AI工作区', '内容草稿'), { recursive: true });
    const target = join(f.projectRoot, action.targetPath);
    await writeFile(target, recoveryContent);
    const before = await stat(target);
    const restarted = createProjectWritePlanService({ database: f.database });
    expect(await restarted.confirm(action.id, 'conversation-1', recoveryRequestId)).toMatchObject({ status: 'completed' });
    const after = await stat(target);
    expect([after.ino, after.mtimeMs, after.ctimeMs]).toEqual([before.ino, before.mtimeMs, before.ctimeMs]);
    expect(await restarted.operations(f.project.id)).toHaveLength(1);
    expect((await f.projects.listFiles(f.project.id, { origin: 'output' })).items.filter(item => item.kind === 'file')).toHaveLength(1);
  });

  it('cleans the owned staged link left after publication without replacing the target', async () => {
    const f = await fixture(); const action = await recoveryDraft(f);
    await persistInterruptedConfirmation(f, action);
    const directory = join(f.projectRoot, 'AI工作区', '内容草稿'); await mkdir(directory, { recursive: true });
    const staged = join(directory, `.xiao-project-${action.id}.staged`); const target = join(f.projectRoot, action.targetPath);
    await writeFile(staged, recoveryContent); await link(staged, target); const before = await stat(target);
    expect(await createProjectWritePlanService({ database: f.database }).confirm(action.id, 'conversation-1', recoveryRequestId)).toMatchObject({ status: 'completed' });
    await expect(stat(staged)).rejects.toThrow();
    const after = await stat(target); expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
  });

  it('recovers a real interruption between publishing the file and committing its receipt', async () => {
    const f = await fixture(); const action = await recoveryDraft(f);
    f.database.exec("CREATE TRIGGER interrupt_receipt BEFORE UPDATE OF status ON personal_project_write_plans WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'simulated receipt interruption'); END;");
    await expect(f.plans.confirm(action.id, 'conversation-1', recoveryRequestId)).rejects.toThrow('simulated receipt interruption');
    expect(f.plans.project(action.id)?.status).toBe('running');
    expect(await readFile(join(f.projectRoot, action.targetPath), 'utf8')).toBe(recoveryContent);
    f.database.exec('DROP TRIGGER interrupt_receipt');
    expect(await createProjectWritePlanService({ database: f.database }).confirm(action.id, 'conversation-1', recoveryRequestId)).toMatchObject({ status: 'completed' });
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM personal_project_operations WHERE plan_id = ?').get(action.id)).toEqual({ count: 1 });
  });

  it('recovers the persisted confirmation after closing and reopening a file-backed SQLite database', async () => {
    const f = await fixture({ durable: true }); const action = await recoveryDraft(f);
    await persistInterruptedConfirmation(f, action);
    await f.projects.close(); f.database.close();
    const database = new Database(f.databasePath);
    try {
      const restarted = createProjectWritePlanService({ database });
      expect(await restarted.confirmForProject(action.id, f.project.id, recoveryRequestId)).toMatchObject({ status: 'completed' });
      expect(await readFile(join(f.projectRoot, action.targetPath), 'utf8')).toBe(recoveryContent);
      expect(database.prepare("SELECT COUNT(*) AS count FROM personal_project_files WHERE project_id = ? AND kind = 'file' AND origin = 'output'").get(f.project.id)).toEqual({ count: 1 });
      const operations = await restarted.operations(f.project.id);
      expect(operations).toHaveLength(1);
      expect(JSON.stringify(operations)).not.toContain(await realpath(f.projectRoot));
      expect(JSON.stringify(operations)).not.toContain('confirmation');
    } finally { database.close(); }
  });

  it.each(['different-content', 'target-symlink', 'parent-symlink', 'revision', 'root-path', 'root-inode', 'missing-confirmation'] as const)('stops recovery for %s without overwriting or indexing the target', async conflict => {
    const f = await fixture(); const action = await recoveryDraft(f);
    await persistInterruptedConfirmation(f, action);
    const target = join(f.projectRoot, action.targetPath);
    if (conflict === 'different-content' || conflict === 'target-symlink') {
      await mkdir(join(f.projectRoot, 'AI工作区', '内容草稿'), { recursive: true });
      if (conflict === 'different-content') await writeFile(target, 'user edit');
      else { const outside = join(f.projectRoot, '..', 'outside.md'); await writeFile(outside, recoveryContent); await symlink(outside, target); }
    } else if (conflict === 'parent-symlink') {
      const outside = join(f.projectRoot, '..', 'outside'); await mkdir(outside); await symlink(outside, join(f.projectRoot, 'AI工作区'));
    } else if (conflict === 'revision') f.database.prepare('UPDATE personal_projects SET source_revision = 2 WHERE id = ?').run(f.project.id);
    else if (conflict === 'root-path') { const replacement = join(f.projectRoot, '..', 'replacement'); await mkdir(replacement); f.database.prepare('UPDATE personal_projects SET root_path = ? WHERE id = ?').run(await realpath(replacement), f.project.id); }
    else if (conflict === 'root-inode') { await rename(f.projectRoot, `${f.projectRoot}-old`); await mkdir(f.projectRoot); }
    else f.database.prepare('DELETE FROM personal_project_operations WHERE plan_id = ?').run(action.id);
    const restarted = createProjectWritePlanService({ database: f.database });
    expect(await restarted.confirm(action.id, 'conversation-1', recoveryRequestId)).toMatchObject({ status: 'stale', problem: expect.any(String) });
    expect(await restarted.confirm(action.id, 'conversation-1', recoveryRequestId)).toMatchObject({ status: 'stale' });
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM personal_project_files WHERE project_id = ? AND origin = 'output'").get(f.project.id)).toEqual({ count: 0 });
    if (conflict === 'different-content') expect(await readFile(target, 'utf8')).toBe('user edit');
    else if (conflict !== 'target-symlink') await expect(readFile(target)).rejects.toThrow();
    expect((await restarted.operations(f.project.id)).filter(operation => operation.status === 'completed')).toEqual([]);
  });

  it.each(['tmp', 'staged'] as const)('continues an owned %s artifact while refusing unsafe temporary artifacts', async suffix => {
    const f = await fixture(); const action = await recoveryDraft(f);
    await persistInterruptedConfirmation(f, action);
    const directory = join(f.projectRoot, 'AI工作区', '内容草稿'); await mkdir(directory, { recursive: true });
    const artifact = join(directory, `.xiao-project-${action.id}.${suffix}`);
    await writeFile(artifact, suffix === 'tmp' ? recoveryContent.slice(0, 5) : recoveryContent);
    expect(await createProjectWritePlanService({ database: f.database }).confirm(action.id, 'conversation-1', recoveryRequestId)).toMatchObject({ status: 'completed' });
    expect(await readFile(join(f.projectRoot, action.targetPath), 'utf8')).toBe(recoveryContent);
    await expect(stat(artifact)).rejects.toThrow();
  });

  it('leaves unrelated or symlinked scratch content as a conflict', async () => {
    const f = await fixture(); const action = await recoveryDraft(f);
    await persistInterruptedConfirmation(f, action);
    const directory = join(f.projectRoot, 'AI工作区', '内容草稿'); await mkdir(directory, { recursive: true });
    const artifact = join(directory, `.xiao-project-${action.id}.tmp`);
    await writeFile(artifact, 'not this confirmed content');
    expect(await createProjectWritePlanService({ database: f.database }).confirm(action.id, 'conversation-1', recoveryRequestId)).toMatchObject({ status: 'stale' });
    expect(await readFile(artifact, 'utf8')).toBe('not this confirmed content');
    await expect(readFile(join(f.projectRoot, action.targetPath))).rejects.toThrow();
  });

  it('does not execute pending plans or retry terminal failed writes on service creation', async () => {
    const f = await fixture(); const pending = await recoveryDraft(f); const failed = await recoveryDraft(f);
    f.database.prepare("UPDATE personal_project_write_plans SET status = 'failed', confirm_request_id = ?, problem = 'terminal failure' WHERE id = ?").run(recoveryRequestId, failed.id);
    const restarted = createProjectWritePlanService({ database: f.database });
    expect(restarted.project(pending.id)?.status).toBe('pending');
    expect(await restarted.confirm(failed.id, 'conversation-1', recoveryRequestId)).toMatchObject({ status: 'failed', problem: 'terminal failure' });
    await expect(readFile(join(f.projectRoot, pending.targetPath))).rejects.toThrow();
    await expect(readFile(join(f.projectRoot, failed.targetPath))).rejects.toThrow();
  });

  it('recovers persisted running confirmations at startup while leaving pending and failed plans untouched', async () => {
    const f = await fixture(); const running = await recoveryDraft(f); const pending = await recoveryDraft(f); const failed = await recoveryDraft(f);
    await persistInterruptedConfirmation(f, running);
    f.database.prepare("UPDATE personal_project_write_plans SET status = 'failed', confirm_request_id = ? WHERE id = ?").run('2c0ce1ae-511b-4bf4-9a9d-444444444464', failed.id);
    const restarted = createProjectWritePlanService({ database: f.database });
    expect(restarted).toHaveProperty('recoverConfirmedPlans', expect.any(Function));
    await restarted.recoverConfirmedPlans();
    await restarted.recoverConfirmedPlans();
    expect(restarted.project(running.id)?.status).toBe('completed');
    expect(restarted.project(pending.id)?.status).toBe('pending');
    expect(restarted.project(failed.id)?.status).toBe('failed');
    await expect(readFile(join(f.projectRoot, pending.targetPath))).rejects.toThrow();
    await expect(readFile(join(f.projectRoot, failed.targetPath))).rejects.toThrow();
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM personal_project_operations WHERE plan_id = ?').get(running.id)).toEqual({ count: 1 });
  });

  it('stops a production recovery when rules differ from the durable confirmation fingerprint', async () => {
    const f = await fixture(); const action = await recoveryDraft(f);
    let ruleFingerprint = 'original-rule-fingerprint';
    const plans = createProjectWritePlanService({ database: f.database, getRuleFingerprint: async () => ruleFingerprint });
    f.database.exec("CREATE TRIGGER interrupt_receipt BEFORE UPDATE OF status ON personal_project_write_plans WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'simulated receipt interruption'); END;");
    await expect(plans.confirm(action.id, 'conversation-1', recoveryRequestId)).rejects.toThrow('simulated receipt interruption');
    f.database.exec('DROP TRIGGER interrupt_receipt');
    ruleFingerprint = 'changed-rule-fingerprint';
    expect(await plans.confirm(action.id, 'conversation-1', recoveryRequestId)).toMatchObject({ status: 'stale' });
    expect(await readFile(join(f.projectRoot, action.targetPath), 'utf8')).toBe(recoveryContent);
    expect((await plans.operations(f.project.id)).filter(operation => operation.status === 'completed')).toEqual([]);
  });

  it.each(['RECOVERY_REQUIRED', 'temporary-rule-read-failure'])('pauses recovery for transient %s and completes when rules can be read again', async code => {
    const f = await fixture(); const action = await recoveryDraft(f);
    await persistInterruptedConfirmation(f, action);
    const operation = f.database.prepare('SELECT id,payload_json FROM personal_project_operations WHERE plan_id = ?').get(action.id) as { id: string; payload_json: string };
    const payload = JSON.parse(operation.payload_json); payload.confirmation.ruleFingerprint = 'approved-rules';
    f.database.prepare('UPDATE personal_project_operations SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), operation.id);
    let unavailable = true;
    const plans = createProjectWritePlanService({ database: f.database, getRuleFingerprint: async () => {
      if (unavailable) throw Object.assign(new Error(code), { code });
      return 'approved-rules';
    } });
    expect(await plans.confirm(action.id, 'conversation-1', recoveryRequestId)).toMatchObject({ status: 'running', problem: expect.any(String) });
    await expect(readFile(join(f.projectRoot, action.targetPath))).rejects.toThrow();
    unavailable = false;
    expect(await plans.confirm(action.id, 'conversation-1', recoveryRequestId)).toMatchObject({ status: 'completed' });
    expect((await plans.operations(f.project.id)).filter(item => item.status === 'completed')).toHaveLength(1);
  });

  it.each(['present', 'missing'] as const)('keeps a directory sync failure after publication available for verification only: %s target', async targetState => {
    const f = await fixture(); const action = await recoveryDraft(f);
    const directory = join(await realpath(f.projectRoot), 'AI工作区', '内容草稿');
    const realOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
    const opening = vi.spyOn(filesystem, 'open').mockImplementation(async (...args: Parameters<typeof filesystem.open>) => {
      if (String(args[0]) === directory && args[1] === 'r') throw Object.assign(new Error('directory sync unavailable'), { code: 'EIO' });
      return realOpen(...args);
    });
    await expect(f.plans.confirm(action.id, 'conversation-1', recoveryRequestId)).rejects.toThrow();
    const target = join(f.projectRoot, action.targetPath); const before = await stat(target);
    expect(await readFile(target, 'utf8')).toBe(recoveryContent);
    expect(f.plans.project(action.id)).toMatchObject({ status: 'running', problem: expect.any(String) });
    if (targetState === 'present') expect(await f.plans.confirm(action.id, 'conversation-1', recoveryRequestId)).toMatchObject({ status: 'running' });
    opening.mockRestore();
    if (targetState === 'missing') await rm(target);
    await f.plans.recoverConfirmedPlans();
    expect(f.plans.project(action.id)?.status).toBe(targetState === 'present' ? 'completed' : 'stale');
    if (targetState === 'present') {
      const after = await stat(target); expect([after.ino, after.mtimeMs, after.ctimeMs]).toEqual([before.ino, before.mtimeMs, before.ctimeMs]);
      expect((await f.plans.operations(f.project.id)).filter(item => item.status === 'completed')).toHaveLength(1);
    } else await expect(readFile(target)).rejects.toThrow();
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM personal_project_operations WHERE plan_id = ?').get(action.id)).toEqual({ count: 1 });
  });

  it('does not mark a raced output parent as completed when publication escaped the project', async () => {
    const f = await fixture(); const action = await recoveryDraft(f);
    const directory = join(await realpath(f.projectRoot), 'AI工作区', '内容草稿');
    const outside = join(f.projectRoot, '..', 'outside'); await mkdir(outside);
    const realLink = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).link; let changed = false;
    const linking = vi.spyOn(filesystem, 'link').mockImplementation(async (...args: Parameters<typeof filesystem.link>) => {
      if (!changed && String(args[1]) === join(await realpath(f.projectRoot), action.targetPath)) {
        changed = true; await rename(directory, outside); await symlink(await realpath(outside), directory);
      }
      return realLink(...args);
    });
    await expect(f.plans.confirm(action.id, 'conversation-1', recoveryRequestId)).rejects.toThrow();
    linking.mockRestore();
    expect(changed).toBe(true);
    expect(f.plans.project(action.id)?.status).toBe('running');
    expect((await f.plans.operations(f.project.id)).filter(item => item.status === 'completed')).toEqual([]);
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM personal_project_files WHERE project_id = ? AND origin = 'output'").get(f.project.id)).toEqual({ count: 0 });
    expect(await readFile(join(outside, action.targetPath.split('/').at(-1)!), 'utf8')).toBe(recoveryContent);
    expect(await f.plans.confirm(action.id, 'conversation-1', recoveryRequestId)).toMatchObject({ status: 'stale' });
  });
});

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

  it('does not repair a completed index against a reconnected root containing the same bytes', async () => {
    const f = await fixture(); const action = await recoveryDraft(f);
    f.database.exec("CREATE TRIGGER reject_output_index BEFORE INSERT ON personal_project_files WHEN NEW.origin = 'output' BEGIN SELECT RAISE(FAIL, 'index unavailable'); END;");
    await f.plans.confirm(action.id, 'conversation-1', recoveryRequestId);
    f.database.exec('DROP TRIGGER reject_output_index');
    const nextRoot = join(f.projectRoot, '..', 'same-content-replacement');
    await mkdir(join(nextRoot, 'AI工作区', '内容草稿'), { recursive: true });
    await writeFile(join(nextRoot, action.targetPath), recoveryContent);
    f.database.prepare('UPDATE personal_projects SET root_path = ? WHERE id = ?').run(await realpath(nextRoot), f.project.id);
    expect(await f.plans.confirm(action.id, 'conversation-1', recoveryRequestId)).toMatchObject({ status: 'completed', problem: expect.stringContaining('已保存') });
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM personal_project_files WHERE project_id = ? AND origin = 'output'").get(f.project.id)).toEqual({ count: 0 });
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
