import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { buildServer } from '../../src/server/app.js';
import { createCompanyRuntime } from '../../src/server/company/company-runtime.js';
import { applyMigrations } from '../../src/server/db/migrate.js';
import {
  companyProjectConfirmResponseSchema,
  companyProjectDetailResponseSchema,
  companyProjectDraftResponseSchema,
  companyProjectListResponseSchema,
  companyProjectScanResponseSchema
} from '../../src/shared/api/company-projects.js';

const servers: Array<ReturnType<typeof buildServer>> = [];
const databases: Database.Database[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function cookie(response: Awaited<ReturnType<ReturnType<typeof buildServer>['inject']>>): string {
  const value = response.headers['set-cookie'];
  if (typeof value !== 'string') throw new Error('missing company cookie');
  return value.split(';', 1)[0]!;
}

async function companySession(server: ReturnType<typeof buildServer>): Promise<{ cookie: string; csrfToken: string }> {
  const bootstrap = await server.inject({
    method: 'POST',
    url: '/api/company/v1/auth/bootstrap',
    headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' },
    payload: {
      operator: { displayName: 'Operator', password: 'operator-secret' },
      reviewer: { displayName: 'Reviewer', password: 'reviewer-secret' }
    }
  });
  expect(bootstrap.statusCode).toBe(200);
  const login = await server.inject({
    method: 'POST',
    url: '/api/company/v1/auth/login',
    headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' },
    payload: { displayName: 'Operator', password: 'operator-secret' }
  });
  expect(login.statusCode).toBe(200);
  return { cookie: cookie(login), csrfToken: login.json().data.csrfToken as string };
}

describe('runtime mode boundary', () => {
  it('keeps personal mode as the default and does not expose company routes', async () => {
    const server = buildServer();
    servers.push(server);

    const bootstrap = await server.inject({ url: '/api/v1/bootstrap', headers: { host: '127.0.0.1:4317' } });
    const companyRequests = await Promise.all([
      server.inject({ url: '/api/company/v1/projects', headers: { host: '127.0.0.1:4317' } }),
      server.inject({ method: 'POST', url: '/api/company/v1/projects', headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' } }),
      server.inject({ method: 'PATCH', url: '/api/company/v1/projects/one', headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' } }),
      server.inject({ method: 'DELETE', url: '/api/company/v1/projects/one', headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' } })
    ]);

    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().data.runtimeMode).toBe('personal');
    expect(companyRequests.map(response => response.statusCode)).toEqual([404, 404, 404, 404]);

    const versionPrefixCollision = await server.inject({
      method: 'POST',
      url: '/api/company/v10/auth/login',
      headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' }
    });
    expect(versionPrefixCollision.statusCode).toBe(401);
  });

  it('registers the company namespace against the isolated company project service', async () => {
    const companyRuntime = createCompanyRuntime({ workspaceRoot: '/srv/company-workspace' });
    const server = buildServer({ runtimeMode: 'company', companyRuntime });
    servers.push(server);

    const bootstrap = await server.inject({ url: '/api/v1/bootstrap', headers: { host: '127.0.0.1:4317' } });
    const companyRoute = await server.inject({ url: '/api/company/v1/projects', headers: { host: '127.0.0.1:4317' } });

    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().data.runtimeMode).toBe('company');
    expect(companyRoute.statusCode).toBe(401);
    expect(companyRuntime.workspace).toEqual({
      id: 'company',
      displayName: 'Company workspace',
      rootPath: '/srv/company-workspace',
      incomingPath: join('/srv/company-workspace', 'incoming'),
      projectsPath: join('/srv/company-workspace', 'projects'),
      skillsPath: join('/srv/company-workspace', 'skills'),
      systemPath: join('/srv/company-workspace', 'system')
    });
    expect(companyRuntime.paths.rootPath).toBe('/srv/company-workspace');
    expect(companyRuntime.paths.resolve('projects')).toBe(join('/srv/company-workspace', 'projects'));
    expect(companyRuntime.database).toEqual({ kind: 'company' });
    expect(await companyRuntime.auth.authenticate({})).toBeUndefined();
    expect(await companyRuntime.projects.list()).toEqual([]);
    expect(companyRuntime).not.toHaveProperty('vaultRealRoot');
    expect(companyRuntime).not.toHaveProperty('gateway');
  });

  it('does not expose personal API routes from a company runtime', async () => {
    const companyRuntime = createCompanyRuntime({ workspaceRoot: '/srv/company-workspace' });
    const server = buildServer({ runtimeMode: 'company', companyRuntime });
    servers.push(server);

    const personalRoutes = await Promise.all([
      server.inject({ url: '/api/v1/health', headers: { host: '127.0.0.1:4317' } }),
      server.inject({ url: '/api/v1/library', headers: { host: '127.0.0.1:4317' } }),
      server.inject({ url: '/api/v1/skills', headers: { host: '127.0.0.1:4317' } }),
      server.inject({ url: '/api/v1/assistant/providers', headers: { host: '127.0.0.1:4317' } })
    ]);

    expect(personalRoutes.map(response => response.statusCode)).toEqual([404, 404, 404, 404]);
    expect(personalRoutes.map(response => response.json().error.code)).toEqual([
      'NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND'
    ]);
    const bootstrap = await server.inject({ url: '/api/v1/bootstrap', headers: { host: '127.0.0.1:4317' } });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().data.runtimeMode).toBe('company');
  });

  it('exposes strict typed project responses only in company mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'company-route-'));
    roots.push(root);
    await mkdir(join(root, 'incoming', 'project-1'), { recursive: true });
    const database = new Database(':memory:');
    databases.push(database);
    applyMigrations(database);
    const project = {
      id: 'project-1', workspaceId: 'company', name: '教育代运营', clientName: '明德培训',
      status: 'draft' as const, projectRoot: '/srv/company-workspace/projects/project-1',
      sourceRoot: '/srv/uploads/project-1', configSha256: 'a'.repeat(64), confidence: {},
      selectedSkillIds: [],
      createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z', dataCoverage: 'not_configured' as const
    };
    const proposal = {
      sourceRoot: '/srv/uploads/project-1', sourceSha256: 'b'.repeat(64), suggestedName: '教育代运营',
      suggestedClientName: '明德培训', suggestedStatus: 'draft' as const,
      fields: { clientName: { value: '明德培训', confidence: 'inferred' as const, evidencePaths: ['机构介绍.md'] } },
      selectedSkillIds: [], entries: [], issues: []
    };
    const run = {
      id: 'run-1', projectId: 'project-1', sourceSha256: proposal.sourceSha256,
      state: 'proposed' as const, proposal, operationId: 'operation-1',
      createdAt: project.createdAt, updatedAt: project.updatedAt
    };
    const projects = {
      list: async () => [project],
      scan: async () => ({ reused: false, run, project, proposal }),
      getDraft: async () => ({ run, project }),
      confirm: async () => ({ project: { ...project, status: 'active' as const }, run: { ...run, state: 'confirmed' as const }, operationId: 'operation-2' }),
      get: async () => project
    };
    const runtime = createCompanyRuntime({ database, workspaceRoot: root, projects });
    const server = buildServer({ runtimeMode: 'company', companyRuntime: runtime });
    servers.push(server);
    const session = await companySession(server);
    const headers = { host: '127.0.0.1:4317', cookie: session.cookie, 'x-csrf-token': session.csrfToken, origin: 'http://127.0.0.1:4317' };

    const list = await server.inject({ url: '/api/company/v1/projects', headers });
    expect(list.statusCode).toBe(200);
    expect(companyProjectListResponseSchema.parse(list.json())).toEqual(list.json());

    const scan = await server.inject({ method: 'POST', url: '/api/company/v1/projects/scan', headers, payload: { incomingPath: 'incoming/project-1' } });
    expect(scan.statusCode).toBe(200);
    expect(companyProjectScanResponseSchema.parse(scan.json())).toEqual(scan.json());

    const draft = await server.inject({ url: '/api/company/v1/projects/drafts/run-1', headers });
    expect(draft.statusCode).toBe(200);
    expect(companyProjectDraftResponseSchema.parse(draft.json())).toEqual(draft.json());

    const detail = await server.inject({ url: '/api/company/v1/projects/project-1', headers });
    expect(detail.statusCode).toBe(200);
    expect(companyProjectDetailResponseSchema.parse(detail.json())).toEqual(detail.json());

    const confirm = await server.inject({ method: 'POST', url: '/api/company/v1/projects/drafts/run-1/confirm', headers, payload: {
      name: '教育代运营', clientName: '明德培训', status: 'active', sourceSha256: proposal.sourceSha256, selectedSkillIds: []
    } });
    expect(confirm.statusCode).toBe(200);
    expect(companyProjectConfirmResponseSchema.parse(confirm.json())).toEqual(confirm.json());
  });

  it('rejects arbitrary scan paths and invalid confirm bodies with operation ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'company-route-invalid-'));
    roots.push(root);
    await mkdir(join(root, 'incoming'), { recursive: true });
    const database = new Database(':memory:');
    databases.push(database);
    applyMigrations(database);
    const runtime = createCompanyRuntime({
      database,
      workspaceRoot: root,
      projects: { list: async () => [] }
    });
    const server = buildServer({ runtimeMode: 'company', companyRuntime: runtime });
    servers.push(server);
    const session = await companySession(server);
    const headers = { host: '127.0.0.1:4317', cookie: session.cookie, 'x-csrf-token': session.csrfToken, origin: 'http://127.0.0.1:4317' };

    const absolute = await server.inject({ method: 'POST', url: '/api/company/v1/projects/scan', headers, payload: { incomingPath: '/etc/passwd' } });
    expect(absolute.statusCode).toBe(400);
    expect(absolute.json().error).toMatchObject({ code: expect.stringMatching(/VALIDATION|PATH/u), operationId: expect.any(String) });

    const extra = await server.inject({ method: 'POST', url: '/api/company/v1/projects/drafts/run-1/confirm', headers, payload: {
      name: '教育代运营', status: 'paused', sourceSha256: 'b'.repeat(64), selectedSkillIds: [], unexpected: true
    } });
    expect(extra.statusCode).toBe(400);
    expect(extra.json().error).toMatchObject({ code: 'VALIDATION_ERROR', operationId: expect.any(String) });
  });
});
