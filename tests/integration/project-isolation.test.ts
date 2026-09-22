import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createAssistantService } from '../../src/server/assistant/service.js';
import type { AssistantAdapter } from '../../src/server/assistant/types.js';
import type { ProjectService, ProjectWritePlanService } from '../../src/shared/api/projects.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

function serviceFixture() {
  const database = new Database(':memory:'); applyMigrations(database);
  const projectA = randomUUID(); const projectB = randomUUID();
  const project = (id: string) => ({ id, displayName: id === projectA ? 'A项目' : 'B项目', sourceRevision: 1, availability: 'ready' as const, outputRoot: 'AI工作区' as const, fileCount: 0, readableFileCount: 0, issueCount: 0, createdAt: '', updatedAt: '' });
  const projectService = { ensureFresh: vi.fn(async (id: string) => project(id)) } as unknown as ProjectService;
  const adapter: AssistantAdapter = { id: 'test', describe: async () => ({ id: 'test', name: 'Test', status: 'ready', models: [{ id: 'pro', name: 'Pro', reasoningEfforts: [] }] }), run: vi.fn(async input => input.emit({ type: 'text', text: 'ok' })) };
  const service = createAssistantService({ database, adapters: [adapter], projectService, projectWritePlans: {} as ProjectWritePlanService, createTools: () => [] });
  cleanups.push(async () => { await service.close(); database.close(); });
  return { service, projectA, projectB, projectService };
}

it('rejects switching one conversation from project A to project B', async () => {
  const f = serviceFixture();
  const first = await f.service.send({ clientRequestId: randomUUID(), message: 'A项目问题', providerId: 'test', model: 'pro', scope: 'project', projectId: f.projectA, projectRevision: 1 });
  await vi.waitFor(() => expect(f.service.get(first.id).status).toBe('idle'));
  await expect(f.service.send({ clientRequestId: randomUUID(), conversationId: first.id, message: 'B项目问题', providerId: 'test', model: 'pro', scope: 'project', projectId: f.projectB, projectRevision: 1 })).rejects.toMatchObject({ code: 'ASSISTANT_PROJECT_CONFLICT' });
  expect(f.service.list({ projectId: f.projectA }).conversations).toHaveLength(1);
  expect(f.service.list({ projectId: f.projectB }).conversations).toHaveLength(0);
});

