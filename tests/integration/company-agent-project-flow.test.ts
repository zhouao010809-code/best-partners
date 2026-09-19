import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createAssistantService } from '../../src/server/assistant/service.js';
import type { AssistantAdapter, AssistantRunInput } from '../../src/server/assistant/types.js';
import { createCompanyAgentTools } from '../../src/server/company/agent-tools.js';
import { ensureCompanyWorkspace } from '../../src/server/company/company-paths.js';
import { createProjectService, type ProjectService } from '../../src/server/company/project-service.js';

const roots: string[] = [];
const services: Array<ReturnType<typeof createAssistantService>> = [];
const databases: Database.Database[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; workspace: Awaited<ReturnType<typeof ensureCompanyWorkspace>>; projects: ProjectService; database: Database.Database }> {
  const root = await mkdtemp(join('/tmp', 'company-agent-flow-'));
  roots.push(root);
  const workspace = await ensureCompanyWorkspace(join(root, 'workspace'), join(root, 'state'));
  await mkdir(join(workspace.incomingPath, 'education-project'), { recursive: true });
  await writeFile(join(workspace.incomingPath, 'education-project', '项目说明.md'), '客户名称：明德培训');
  const database = new Database(':memory:');
  databases.push(database);
  applyMigrations(database);
  const projects = createProjectService({ database, workspace: { id: 'company', ...workspace } });
  return { root, workspace, projects, database };
}

async function settled(service: ReturnType<typeof createAssistantService>, id: string) {
  await vi.waitFor(() => expect(service.get(id).status).not.toBe('running'));
  return service.get(id);
}

describe('company Agent project flow', () => {
  it('analyzes a natural-language project request without activating it, then confirms explicitly', async () => {
    const f = await fixture();
    let runId = '';
    let sourceSha256 = '';
    const run = vi.fn(async (input: AssistantRunInput) => {
      const message = input.messages.at(-1)?.content ?? '';
      const scan = input.tools.find(tool => tool.name === 'company.scan_project_folder');
      const confirm = input.tools.find(tool => tool.name === 'company.confirm_project');
      if (message.includes('先分析')) {
        if (!scan) throw new Error('scan tool missing');
        const result = await scan.execute({ incomingPath: 'incoming/education-project' }) as { run: { id: string; sourceSha256: string } };
        runId = result.run.id;
        sourceSha256 = result.run.sourceSha256;
        input.emit({ type: 'text', text: '已完成项目分析，提案等待确认。' });
        return;
      }
      if (!confirm) throw new Error('confirm tool missing');
      await confirm.execute({ runId, sourceSha256, name: '明德培训教育代运营', clientName: '明德培训', status: 'active', selectedSkillIds: [] });
      input.emit({ type: 'text', text: '已按明确确认完成项目建立。' });
    });
    const adapter: AssistantAdapter = {
      id: 'fake-company',
      describe: async () => ({ id: 'fake-company', name: 'Fake company', status: 'ready', defaultModel: 'test', defaultEffort: 'high', models: [{ id: 'test', name: 'Test', reasoningEfforts: ['high'] }] }),
      run
    };
    const service = createAssistantService({
      database: f.database,
      adapters: [adapter],
      createTools: context => createCompanyAgentTools({
        projects: f.projects,
        workspace: { rootPath: f.workspace.rootPath, incomingPath: f.workspace.incomingPath },
        actorId: 'operator-1',
        signal: context.signal,
        authorize: permission => {
          if (permission === 'project:confirm' && context.userMessage.includes('先分析')) throw new Error('confirmation not authorized');
        }
      })
    });
    services.push(service);

    const first = await service.send({ clientRequestId: randomUUID(), message: '把这个项目文件夹建立成一个新项目，先分析，不要直接确认。', providerId: 'fake-company', model: 'test', scope: 'brain' });
    await settled(service, first.id);
    expect((await f.projects.list()).map(project => project.status)).toEqual(['draft']);
    expect(run).toHaveBeenCalledTimes(1);

    const second = await service.send({ clientRequestId: randomUUID(), conversationId: first.id, message: '我已经核对提案，请确认建立这个项目。', providerId: 'fake-company', model: 'test', scope: 'brain' });
    await settled(service, second.id);
    const projects = await f.projects.list();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ status: 'active', name: '明德培训教育代运营' });
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM company_project_events WHERE event_type = 'project_confirmed'").get()).toEqual({ count: 1 });
  });
});
