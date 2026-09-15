import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCompanyWorkspace } from '../../src/server/company/company-paths.js';
import { createProjectService, type ProjectService } from '../../src/server/company/project-service.js';
import { createCompanyRuntime } from '../../src/server/company/company-runtime.js';
import { buildServer } from '../../src/server/app.js';
import { openStateKernel, type NormalStateKernel } from '../../src/server/db/database.js';

const roots: string[] = [];
const kernels: NormalStateKernel[] = [];
const servers: Array<ReturnType<typeof buildServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  for (const kernel of kernels.splice(0)) kernel.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  root: string;
  source: string;
  workspace: Awaited<ReturnType<typeof ensureCompanyWorkspace>>;
  database: NormalStateKernel['db'];
  service: ProjectService;
}> {
  const root = await mkdtemp(join(tmpdir(), 'company-project-service-'));
  roots.push(root);
  const source = join(root, '客户A教育项目');
  const appDataDir = join(root, 'state');
  const vaultRealRoot = join(root, 'vault');
  const workspaceRoot = join(root, 'company-workspace');
  await writeFile(join(root, 'placeholder'), '');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(source, { recursive: true });
  await mkdir(vaultRealRoot, { recursive: true });
  const workspace = await ensureCompanyWorkspace(workspaceRoot, appDataDir);
  const kernel = openStateKernel({ appDataDir, vaultRealRoot });
  if (kernel.mode !== 'normal') throw new Error('expected normal kernel');
  kernels.push(kernel);
  const service = createProjectService({
    database: kernel.db,
    workspace: { id: 'company', ...workspace }
  });
  await writeFile(join(source, '机构介绍.md'), '# 机构名称：明德培训\n服务开始：2026-09-01\n');
  await writeFile(join(source, '课程表.md'), '周一 试听课');
  return { root, source, workspace, database: kernel.db, service };
}

describe('company project service', () => {
  it('persists an idempotent draft, confirms once, and keeps source bytes untouched', async () => {
    const { root, source, workspace, service } = await fixture();
    const sourceBefore = await readFile(join(source, '课程表.md'));

    const draft = await service.scan({ sourceRoot: source, actorId: 'operator-1' });
    expect(draft.run.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(draft.run.state).toBe('proposed');
    expect(draft.proposal.suggestedClientName).toBe('明德培训');

    const confirmed = await service.confirm(draft.run.id, {
      sourceSha256: draft.proposal.sourceSha256,
      name: '明德培训教育代运营',
      clientName: '明德培训',
      status: 'active',
      actorId: 'operator-1'
    });
    expect(confirmed.project.status).toBe('active');
    expect(confirmed.operationId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const projectRoot = join(workspace.projectsPath, confirmed.project.id);
    expect(await readFile(join(projectRoot, '项目配置.yaml'), 'utf8')).toContain('name: 明德培训教育代运营');
    expect(await readFile(join(projectRoot, '项目说明.md'), 'utf8')).toContain('明德培训教育代运营');
    expect(await readFile(join(projectRoot, 'source-manifest.json'), 'utf8')).toContain(draft.proposal.sourceSha256);
    expect(await readFile(join(projectRoot, 'raw', '课程表.md'), 'utf8')).toBe('周一 试听课');
    expect(await readFile(join(source, '课程表.md'))).toEqual(sourceBefore);

    const listed = await service.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: confirmed.project.id, status: 'active', dataCoverage: 'not_configured' });

    const repeated = await service.scan({ sourceRoot: source, actorId: 'operator-1' });
    expect(repeated.run.id).not.toBe(draft.run.id);

    await writeFile(join(source, '课程表.md'), '周二 新课程');
    const changed = await service.scan({ sourceRoot: source, actorId: 'operator-1' });
    expect(changed.run.id).not.toBe(repeated.run.id);
    expect((await service.list()).filter(project => project.id === confirmed.project.id)).toHaveLength(1);
    expect(root).toBeTruthy();
  });

  it('returns an existing open run for the same source before confirmation', async () => {
    const { source, service } = await fixture();
    const first = await service.scan({ sourceRoot: source });
    const second = await service.scan({ sourceRoot: source });
    expect(second.run.id).toBe(first.run.id);
    expect(second.reused).toBe(true);
    expect((await service.list()).filter(project => project.id === first.project.id)).toHaveLength(1);
  });

  it('confirms one concurrent run once and reuses the persisted operation id', async () => {
    const { source, service, database } = await fixture();
    const draft = await service.scan({ sourceRoot: source });
    const input = {
      sourceSha256: draft.proposal.sourceSha256,
      name: '明德培训教育代运营',
      clientName: '明德培训',
      status: 'active' as const,
      actorId: 'operator-1'
    };
    const results = await Promise.all([
      service.confirm(draft.run.id, input),
      service.confirm(draft.run.id, input)
    ]);
    expect(new Set(results.map(result => result.operationId)).size).toBe(1);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM company_project_events WHERE project_id = ? AND event_type = 'project_confirmed'
    `).get(results[0]!.project.id)).toEqual({ count: 1 });
  });
});

describe('company project ingestion routes', () => {
  it('scans, reads, and confirms a folder supplied through the incoming area', async () => {
    const root = await mkdtemp(join(tmpdir(), 'company-project-route-'));
    roots.push(root);
    const appDataDir = join(root, 'state');
    const vaultRealRoot = join(root, 'vault');
    const workspaceRoot = join(root, 'company-workspace');
    const workspace = await ensureCompanyWorkspace(workspaceRoot, appDataDir);
    const source = join(workspace.incomingPath, 'upload-1');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, '项目说明.md'), '客户名称：明德培训');
    await mkdir(vaultRealRoot, { recursive: true });
    const kernel = openStateKernel({ appDataDir, vaultRealRoot });
    if (kernel.mode !== 'normal') throw new Error('expected normal kernel');
    kernels.push(kernel);
    const runtime = createCompanyRuntime({ database: kernel.db, workspaceRoot });
    const server = buildServer({ runtimeMode: 'company', companyRuntime: runtime });
    servers.push(server);
    const baseHeaders = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
    const bootstrap = await server.inject({ method: 'POST', url: '/api/company/v1/auth/bootstrap', headers: baseHeaders, payload: {
      operator: { displayName: 'Operator', password: 'operator-secret' },
      reviewer: { displayName: 'Reviewer', password: 'reviewer-secret' }
    } });
    expect(bootstrap.statusCode).toBe(200);
    const login = await server.inject({ method: 'POST', url: '/api/company/v1/auth/login', headers: baseHeaders, payload: {
      displayName: 'Operator', password: 'operator-secret'
    } });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers['set-cookie'];
    if (typeof setCookie !== 'string') throw new Error('missing company cookie');
    const headers = {
      ...baseHeaders,
      cookie: setCookie.split(';', 1)[0],
      'x-csrf-token': login.json().data.csrfToken as string
    };
    const scan = await server.inject({ method: 'POST', url: '/api/company/v1/projects/scan', headers, payload: { incomingPath: 'incoming/upload-1' } });
    expect(scan.statusCode).toBe(200);
    const draft = scan.json().data;
    expect(draft.proposal.suggestedClientName).toBe('明德培训');
    const read = await server.inject({ url: `/api/company/v1/projects/drafts/${draft.run.id}`, headers });
    expect(read.statusCode).toBe(200);
    const confirm = await server.inject({ method: 'POST', url: `/api/company/v1/projects/drafts/${draft.run.id}/confirm`, headers, payload: {
      name: '明德培训代运营', clientName: '明德培训', status: 'active',
      sourceSha256: draft.proposal.sourceSha256, selectedSkillIds: []
    } });
    expect(confirm.statusCode).toBe(200);
    const projectId = confirm.json().data.project.id as string;
    const detail = await server.inject({ url: `/api/company/v1/projects/${projectId}`, headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.status).toBe('active');
  });
});
