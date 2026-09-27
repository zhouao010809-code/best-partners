import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createAssistantService } from '../../src/server/assistant/service.js';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createProjectService } from '../../src/server/projects/project-service.js';
import { createProjectWritePlanService } from '../../src/server/projects/project-write-plans.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-project-receipts-'));
  const projectRoot = join(root, 'project');
  const vaultRoot = join(root, 'vault');
  const stateRoot = join(root, 'state');
  await Promise.all([projectRoot, vaultRoot, stateRoot].map(path => mkdir(path)));
  await writeFile(join(projectRoot, 'README.md'), '# Isolated project');
  const database = new Database(':memory:');
  applyMigrations(database);
  const projects = createProjectService({ database, vaultRoot, stateRoot });
  const preview = await projects.scan(projectRoot);
  const project = await projects.bind(preview.scanId, { sourceSha256: preview.sourceSha256 });
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const timestamp = '2026-09-27T00:00:00.000Z';
  const conversation = { id: conversationId, title: '保存项目输出', createdAt: timestamp, updatedAt: timestamp, status: 'idle', providerId: 'stub', model: 'stub', scope: 'project', projectId: project.id, projectRevision: project.sourceRevision, messages: [] as unknown[] };
  const persist = database.prepare('INSERT INTO assistant_conversations (id,updated_at,payload) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload');
  persist.run(conversationId, timestamp, JSON.stringify(conversation));
  const plans = createProjectWritePlanService({ database });
  const action = await plans.proposeDraft({ projectId: project.id, conversationId, messageId, category: '内容草稿', title: '待确认输出', summary: '保存摘要', content: '# Saved body', expectedRevision: project.sourceRevision });
  conversation.messages = [{ id: messageId, role: 'assistant', text: '请确认保存。', sources: [], actions: [action] }];
  persist.run(conversationId, timestamp, JSON.stringify(conversation));
  const assistant = createAssistantService({ database, adapters: [], createTools: () => [], projectService: projects, projectWritePlans: plans });
  cleanups.push(async () => { await assistant.close(); await projects.close(); database.close(); await rm(root, { recursive: true, force: true }); });
  return { root, projectRoot, database, assistant, plans, action, conversationId, conversation, timestamp, persist };
}

it.each(['completed', 'cancelled', 'failed'] as const)('projects the durable %s receipt when reloading an old pending conversation', async status => {
  const f = await fixture();
  const rawBefore = f.database.prepare('SELECT payload,updated_at FROM assistant_conversations WHERE id=?').get(f.conversationId);
  expect(f.assistant.get(f.conversationId).messages[0]?.actions[0]?.status).toBe('pending');
  if (status === 'completed') await f.plans.confirm(f.action.id, f.conversationId, randomUUID());
  else if (status === 'cancelled') f.plans.cancel(f.action.id, f.conversationId, randomUUID());
  else {
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(f.projectRoot, 'AI工作区'));
    await expect(f.plans.confirm(f.action.id, f.conversationId, randomUUID())).rejects.toMatchObject({ code: 'PROJECT_OUTPUT_WRITE_FAILED' });
  }
  const receipt = f.plans.project(f.action.id, f.conversationId)!;
  const first = f.assistant.get(f.conversationId);
  const again = f.assistant.get(f.conversationId);
  expect(first.messages[0]?.actions[0]).toEqual(receipt);
  expect(again.messages[0]?.actions[0]?.status).toBe(status);
  expect(first.updatedAt).toBe(f.timestamp);
  expect(f.database.prepare('SELECT payload,updated_at FROM assistant_conversations WHERE id=?').get(f.conversationId)).toEqual(rawBefore);
});

it('does not project a receipt owned by another conversation', async () => {
  const f = await fixture();
  await f.plans.confirm(f.action.id, f.conversationId, randomUUID());
  const otherId = randomUUID();
  f.persist.run(otherId, f.timestamp, JSON.stringify({ ...f.conversation, id: otherId }));
  const other = f.assistant.get(otherId);
  expect(other.messages[0]?.actions[0]).toEqual(f.action);
  expect(other.messages[0]?.actions[0]).not.toHaveProperty('resultPath');
});
