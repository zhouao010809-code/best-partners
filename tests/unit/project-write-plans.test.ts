import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createProjectService } from '../../src/server/projects/project-service.js';
import { createProjectWritePlanService } from '../../src/server/projects/project-write-plans.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'project-write-plan-'));
  const projectRoot = join(root, 'project'); const vaultRoot = join(root, 'vault'); const stateRoot = join(root, 'state');
  await mkdir(projectRoot); await mkdir(vaultRoot); await mkdir(stateRoot); await writeFile(join(projectRoot, 'README.md'), '# 说明\n');
  const database = new Database(':memory:'); applyMigrations(database);
  database.prepare('INSERT INTO assistant_conversations (id, updated_at, payload) VALUES (?, ?, ?)').run('conversation-1', new Date().toISOString(), '{}');
  const projects = createProjectService({ database, vaultRoot, stateRoot }); const plans = createProjectWritePlanService({ database });
  const scan = await projects.scan(projectRoot); const project = await projects.bind(scan.scanId, { sourceSha256: scan.sourceSha256 });
  cleanups.push(async () => { await projects.close(); database.close(); await rm(root, { recursive: true, force: true }); });
  return { database, projectRoot, project, plans };
}

describe('project write plans', () => {
  it('keeps draft content private until explicit confirmation', async () => {
    const f = await fixture();
    const action = await f.plans.proposeDraft({ projectId: f.project.id, conversationId: 'conversation-1', messageId: 'message-1', category: '周计划', title: '下周获客内容', summary: '保存周计划草稿', content: '# 下周获客内容', expectedRevision: 1 });
    expect(action.status).toBe('pending'); expect(action.targetPath).toMatch(/^AI工作区\/周计划\//u); expect(action).not.toHaveProperty('content');
    await expect(readFile(join(f.projectRoot, action.targetPath))).rejects.toThrow();
    await expect(f.plans.confirm(action.id, f.project.id, '2c0ce1ae-511b-4bf4-9a9d-444444444448')).rejects.toMatchObject({ code: 'PROJECT_WRITE_PLAN_NOT_FOUND' });
    const completed = await f.plans.confirm(action.id, 'conversation-1', '2c0ce1ae-511b-4bf4-9a9d-444444444444');
    expect(completed.status).toBe('completed'); expect(await readFile(join(f.projectRoot, completed.resultPath!), 'utf8')).toContain('下周获客内容');
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
});
