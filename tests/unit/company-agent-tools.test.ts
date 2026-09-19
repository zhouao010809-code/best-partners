import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCompanyAgentTools } from '../../src/server/company/agent-tools.js';
import { createBrainTools } from '../../src/server/assistant/brain-tools.js';
import type { AssistantTool } from '../../src/server/assistant/types.js';
import type { ReadService } from '../../src/server/services/read-service.js';
import type { CompanyProjectService } from '../../src/server/company/company-runtime.js';
import type { ProjectScanResult, ProjectConfirmResult } from '../../src/server/company/project-service.js';

const roots: string[] = [];
const now = '2026-09-19T00:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function fixture(root: string) {
  const proposal = {
    sourceRoot: join(root, 'incoming', 'education-project'),
    sourceSha256: 'a'.repeat(64),
    suggestedName: 'education-project',
    suggestedStatus: 'draft' as const,
    fields: { clientName: { confidence: 'unknown' as const, evidencePaths: [] } },
    selectedSkillIds: [],
    entries: [{ relativePath: '项目说明.md', kind: 'file' as const, bytes: 4, modifiedAt: now, sha256: 'b'.repeat(64) }],
    issues: []
  };
  const project = {
    id: 'project-1', workspaceId: 'company', name: 'education-project', status: 'draft' as const,
    projectRoot: join(root, 'projects', 'project-1'), sourceRoot: proposal.sourceRoot,
    configSha256: 'c'.repeat(64), confidence: proposal.fields, createdAt: now, updatedAt: now,
    dataCoverage: 'not_configured' as const
  };
  const run = { id: 'run-1', projectId: project.id, sourceSha256: proposal.sourceSha256, state: 'proposed' as const,
    proposal, operationId: 'op-1', createdAt: now, updatedAt: now };
  const confirmedProject = { ...project, name: '明德培训教育代运营', clientName: '明德培训', status: 'active' as const, updatedAt: now };
  const scanResult: ProjectScanResult = { reused: false, run, project, proposal };
  const confirmResult: ProjectConfirmResult = { project: confirmedProject, run: { ...run, state: 'confirmed' }, operationId: 'op-confirm-1' };
  const service: CompanyProjectService = {
    scan: vi.fn(async () => scanResult),
    getDraft: vi.fn(async () => ({ run, project })),
    confirm: vi.fn(async () => confirmResult),
    list: vi.fn(async () => [confirmedProject]),
    get: vi.fn(async () => confirmedProject)
  };
  return { proposal, project, run, confirmResult, service };
}

async function makeFixture() {
  const root = await mkdtemp(join('/tmp', 'company-agent-tools-'));
  roots.push(root);
  await mkdir(join(root, 'incoming', 'education-project'), { recursive: true });
  await mkdir(join(root, 'projects'), { recursive: true });
  await writeFile(join(root, 'incoming', 'education-project', '项目说明.md'), '教育');
  const f = fixture(root);
  const tools = createCompanyAgentTools({
    projects: f.service,
    workspace: { incomingPath: join(root, 'incoming'), rootPath: root },
    actorId: 'operator-1',
    signal: new AbortController().signal
  });
  return { ...f, root, tools, execute: (name: string, input: unknown) => tools.find(tool => tool.name === name)!.execute(input) };
}

describe('company project Agent tools', () => {
  it('registers company tools only through an explicit brain-tool hook', () => {
    const companyTool: AssistantTool = { name: 'company.test_only', description: 'test', inputSchema: {}, execute: async () => ({ ok: true }) };
    const baseInput = {
      readService: { listKnowledge: () => ({ items: [] }), listMaterials: () => ({ items: [] }) } as unknown as ReadService,
      scope: 'brain' as const, model: 'test', signal: new AbortController().signal, emit: vi.fn()
    };
    expect(createBrainTools(baseInput).some(tool => tool.name.startsWith('company.'))).toBe(false);
    expect(createBrainTools({ ...baseInput, companyTools: [companyTool] }).at(-1)).toBe(companyTool);
  });

  it('exposes exactly the five company project tools and does not expose them by default', async () => {
    const f = await makeFixture();
    expect(f.tools.map(tool => tool.name)).toEqual([
      'company.scan_project_folder',
      'company.get_project_proposal',
      'company.confirm_project',
      'company.list_projects',
      'company.get_project'
    ]);
  });

  it('rejects absolute, traversing, and symlinked scan paths before calling the service', async () => {
    const f = await makeFixture();
    const scan = f.tools.find(tool => tool.name === 'company.scan_project_folder')!;
    for (const incomingPath of ['/tmp/secret', '../secret', 'incoming/../secret', 'incoming/education-project/../secret']) {
      await expect(scan.execute({ incomingPath })).rejects.toMatchObject({ code: 'COMPANY_AGENT_PATH_INVALID' });
    }
    await expect(scan.execute({ incomingPath: 'incoming/education-project', sourcePath: '/tmp/secret' })).rejects.toMatchObject({ code: 'COMPANY_AGENT_PATH_INVALID' });
    await mkdir(join(f.root, 'outside-project'), { recursive: true });
    await symlink(join(f.root, 'outside-project'), join(f.root, 'incoming', 'linked-project'));
    await expect(scan.execute({ incomingPath: 'incoming/linked-project' })).rejects.toMatchObject({ code: 'COMPANY_AGENT_PATH_INVALID' });
    expect(f.service.scan).not.toHaveBeenCalled();
  });

  it('returns a structured proposal and never turns model fields into a filesystem write', async () => {
    const f = await makeFixture();
    const result = await f.execute('company.scan_project_folder', { incomingPath: 'incoming/education-project' });
    expect(result).toMatchObject({ reused: false, run: f.run, project: f.project, proposal: f.proposal });
    expect(result).not.toHaveProperty('command');
    expect(result).not.toHaveProperty('write');
    expect(f.service.scan).toHaveBeenCalledWith({ sourceRoot: expect.stringMatching(/\/incoming\/education-project$/u), actorId: 'operator-1' });
  });

  it('keeps proposal retrieval read-only and confirmation explicit', async () => {
    const f = await makeFixture();
    await expect(f.execute('company.get_project_proposal', { runId: 'run-1' })).resolves.toEqual({ run: f.run, project: f.project });
    expect(f.service.confirm).not.toHaveBeenCalled();
    const result = await f.execute('company.confirm_project', {
      runId: 'run-1', sourceSha256: f.proposal.sourceSha256, name: '明德培训教育代运营', clientName: '明德培训', status: 'active', selectedSkillIds: []
    });
    expect(result).toMatchObject(f.confirmResult);
    expect(result).toMatchObject({ operationId: 'op-confirm-1', run: { sourceSha256: f.proposal.sourceSha256 } });
    expect(f.service.confirm).toHaveBeenCalledWith('run-1', {
      sourceSha256: f.proposal.sourceSha256, name: '明德培训教育代运营', clientName: '明德培训', status: 'active', selectedSkillIds: [], actorId: 'operator-1'
    });
  });

  it('delegates company permission checks to the authenticated composition root', async () => {
    const f = await makeFixture();
    const permissions: string[] = [];
    const tools = createCompanyAgentTools({
      projects: f.service,
      workspace: { incomingPath: join(f.root, 'incoming'), rootPath: f.root },
      actorId: 'operator-1',
      signal: new AbortController().signal,
      authorize: permission => { permissions.push(permission); }
    });
    await tools.find(tool => tool.name === 'company.scan_project_folder')!.execute({ incomingPath: 'incoming/education-project' });
    await tools.find(tool => tool.name === 'company.list_projects')!.execute({});
    await tools.find(tool => tool.name === 'company.get_project')!.execute({ projectId: 'project-1' });
    await tools.find(tool => tool.name === 'company.get_project_proposal')!.execute({ runId: 'run-1' });
    expect(permissions).toEqual(['project:create', 'proposal:read', 'proposal:read', 'proposal:read']);
    const rejectingTools = createCompanyAgentTools({ projects: f.service, workspace: { incomingPath: join(f.root, 'incoming'), rootPath: f.root }, signal: new AbortController().signal, authorize: permission => { if (permission === 'project:confirm') throw new Error('forbidden'); } });
    await expect(rejectingTools.find(tool => tool.name === 'company.confirm_project')!.execute({ runId: 'run-1', sourceSha256: f.proposal.sourceSha256, name: 'x', status: 'active', selectedSkillIds: [] })).rejects.toMatchObject({ code: 'COMPANY_AGENT_TOOL_FAILED' });
    expect(f.service.confirm).not.toHaveBeenCalled();
  });

  it('lists and reads projects through the service without mutation', async () => {
    const f = await makeFixture();
    await expect(f.execute('company.list_projects', {})).resolves.toEqual({ items: [f.confirmResult.project] });
    await expect(f.execute('company.get_project', { projectId: 'project-1' })).resolves.toEqual(f.confirmResult.project);
    expect(f.service.confirm).not.toHaveBeenCalled();
  });
});
