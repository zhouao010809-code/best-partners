import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createAssistantService } from '../../src/server/assistant/service.js';
import { createAssistantTools } from '../../src/server/assistant/tool-factory.js';
import type { AssistantAdapter, AssistantRunInput } from '../../src/server/assistant/types.js';
import type { ProjectService, ProjectWritePlanService } from '../../src/shared/api/projects.js';
import type { ReadService } from '../../src/server/services/read-service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

function fixture() {
  const database = new Database(':memory:'); applyMigrations(database);
  const projectId = randomUUID();
  const summary = { id: projectId, displayName: 'A项目', sourceRevision: 4, availability: 'ready' as const, outputRoot: 'AI工作区' as const, fileCount: 1, readableFileCount: 1, issueCount: 0, createdAt: '', updatedAt: '' };
  const projectService = {
    ensureFresh: vi.fn(async () => summary),
    get: vi.fn(async () => summary),
    listFiles: vi.fn(async () => ({ items: [{ relativePath: 'brief.md', kind: 'file' as const, origin: 'source' as const, parseStatus: 'readable' as const, sha256: 'a'.repeat(64) }], total: 1, revision: 4 })),
    readFile: vi.fn(async (_id: string, path: string) => ({ relativePath: path, kind: 'file' as const, origin: 'source' as const, parseStatus: 'readable' as const, sha256: 'a'.repeat(64), content: '项目获客证据', totalCharacters: 7, truncated: false })),
    refresh: vi.fn(async () => summary)
  } as unknown as ProjectService;
  const writePlans = { proposeDraft: vi.fn(async () => ({ id: randomUUID(), type: 'project-write' as const, label: '保存到内容草稿', status: 'pending' as const, projectId, projectName: 'A项目', category: '内容草稿' as const, targetPath: 'AI工作区/内容草稿/稿件.md', contentSha256: 'b'.repeat(64), sourceRevision: 4, summary: '摘要', createdAt: '', expiresAt: '' })) } as unknown as ProjectWritePlanService;
  const readService = { listKnowledge: vi.fn(() => ({ items: [] })), listMaterials: vi.fn(() => ({ items: [] })), getKnowledgeDetail: vi.fn(), getDocumentDetail: vi.fn() } as unknown as ReadService;
  let modelInput: AssistantRunInput | undefined;
  const adapter: AssistantAdapter = { id: 'test', describe: async () => ({ id: 'test', name: 'Test', status: 'ready', models: [{ id: 'pro', name: 'Pro', reasoningEfforts: [] }] }), run: vi.fn(async input => { modelInput = input; input.emit({ type: 'text', text: '项目回答' }); }) };
  const service = createAssistantService({ database, adapters: [adapter], projectService, projectWritePlans: writePlans, createTools: context => createAssistantTools({ ...context, readService, projectService, projectWritePlans: writePlans }) });
  cleanups.push(async () => { await service.close(); database.close(); });
  return { projectId, projectService, service, modelInput: () => modelInput };
}

it('registers global read tools and project tools in project scope with one source namespace', async () => {
  const f = fixture();
  const conversation = await f.service.send({ clientRequestId: randomUUID(), message: '评估下周获客选题', providerId: 'test', model: 'pro', scope: 'project', projectId: f.projectId, projectRevision: 4 });
  await vi.waitFor(() => expect(f.service.get(conversation.id).status).toBe('idle'));
  const names = f.modelInput()!.tools.map(tool => tool.name);
  expect(names).toEqual(expect.arrayContaining(['search_knowledge', 'search_project_files', 'read_project_file', 'save_project_draft', 'propose_project_edit', 'refresh_project_index']));
  expect(names).not.toEqual(expect.arrayContaining(['prepare_extraction', 'submit_candidates', 'archive_attachment', 'write_file']));
  expect(f.modelInput()!.system).toContain('项目模式');
  expect(f.modelInput()!.system).toContain('项目名称：A项目');
});
