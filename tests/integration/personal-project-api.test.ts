import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildServer } from '../../src/server/app.js';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createProjectService } from '../../src/server/projects/project-service.js';
import { createProjectWritePlanService } from '../../src/server/projects/project-write-plans.js';

const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'personal-project-api-'));
  const vaultRoot = join(root, 'vault');
  const stateRoot = join(root, 'state');
  const projectRoot = join(root, 'client-project');
  await mkdir(vaultRoot); await mkdir(stateRoot); await mkdir(projectRoot);
  await writeFile(join(projectRoot, 'README.md'), '# 说明\n获客内容\n');
  await writeFile(join(projectRoot, 'brief file.md'), '第一版选题\n');
  const database = new Database(':memory:');
  applyMigrations(database);
  database.prepare('INSERT INTO assistant_conversations (id, updated_at, payload) VALUES (?, ?, ?)').run('conversation-1', new Date().toISOString(), '{}');
  const service = createProjectService({ database, vaultRoot, stateRoot });
  const plans = createProjectWritePlanService({ database });
  const app = buildServer({ projectService: service, projectWritePlans: plans });
  cleanup.push(async () => { await app.close(); await service.close(); database.close(); await rm(root, { recursive: true, force: true }); });
  const bootstrap = await app.inject({ url: '/api/v1/bootstrap', headers });
  const authHeaders = {
    ...headers,
    cookie: String(bootstrap.headers['set-cookie']).split(';')[0]!,
    'x-csrf-token': bootstrap.json().data.csrfToken as string
  };
  return { app, projectRoot, authHeaders, plans };
}

describe('personal project API', () => {
  it('scans, binds, lists, refreshes, searches and reads without private fields', async () => {
    const f = await fixture();
    const scan = await f.app.inject({ method: 'POST', url: '/api/v1/projects/scan', headers: f.authHeaders, payload: { rootPath: f.projectRoot } });
    expect(scan.statusCode).toBe(200);
    expect(scan.headers['cache-control']).toBe('no-store');
    expect(scan.json().data).not.toHaveProperty('sourceRoot');
    expect(scan.json().data).not.toHaveProperty('proposal_json');
    expect(scan.json().data).not.toHaveProperty('content_text');
    const bind = await f.app.inject({ method: 'POST', url: '/api/v1/projects', headers: f.authHeaders, payload: { scanId: scan.json().data.scanId, sourceSha256: scan.json().data.sourceSha256 } });
    expect(bind.statusCode).toBe(200);
    expect(bind.headers['cache-control']).toBe('no-store');
    const id = bind.json().data.id as string;
    const list = await f.app.inject({ url: '/api/v1/projects', headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.projects).toHaveLength(1);
    expect((await f.app.inject({ url: `/api/v1/projects/${id}`, headers })).statusCode).toBe(200);
    expect((await f.app.inject({ method: 'POST', url: `/api/v1/projects/${id}/refresh`, headers: f.authHeaders, payload: {} })).statusCode).toBe(200);
    const files = await f.app.inject({ url: `/api/v1/projects/${id}/files?search=${encodeURIComponent('获客')}`, headers });
    expect(files.statusCode).toBe(200);
    expect(files.json().data.items[0].relativePath).toBe('README.md');
    const file = await f.app.inject({ url: `/api/v1/projects/${id}/file?path=${encodeURIComponent('brief file.md')}`, headers });
    expect(file.statusCode).toBe(200);
    expect(file.json().data.content).toContain('第一版选题');
  });

  it('enforces validation, not-found, CSRF, unavailable and company boundaries', async () => {
    const f = await fixture();
    expect((await f.app.inject({ method: 'POST', url: '/api/v1/projects/scan', headers, payload: { rootPath: f.projectRoot } })).statusCode).toBe(401);
    const { 'x-csrf-token': _csrf, ...withoutCsrf } = f.authHeaders;
    expect((await f.app.inject({ method: 'POST', url: '/api/v1/projects/scan', headers: withoutCsrf, payload: { rootPath: f.projectRoot } })).statusCode).toBe(403);
    expect((await f.app.inject({ url: '/api/v1/projects/not-a-uuid', headers })).statusCode).toBe(400);
    expect((await f.app.inject({ url: '/api/v1/projects/11111111-1111-4111-8111-111111111111/file?path=../secret.md', headers })).statusCode).toBe(400);
    expect((await f.app.inject({ url: '/api/v1/projects/11111111-1111-4111-8111-111111111111', headers })).statusCode).toBe(404);
    const unavailable = buildServer();
    cleanup.push(() => unavailable.close());
    expect((await unavailable.inject({ url: '/api/v1/projects', headers })).statusCode).toBe(503);
    const company = buildServer({ runtimeMode: 'company' });
    cleanup.push(() => company.close());
    expect((await company.inject({ url: '/api/v1/projects', headers })).statusCode).toBe(404);
  });

  it('confirms project output through a dedicated route with only an idempotency token', async () => {
    const f = await fixture();
    const scan = await f.app.inject({ method: 'POST', url: '/api/v1/projects/scan', headers: f.authHeaders, payload: { rootPath: f.projectRoot } });
    const bind = await f.app.inject({ method: 'POST', url: '/api/v1/projects', headers: f.authHeaders, payload: { scanId: scan.json().data.scanId, sourceSha256: scan.json().data.sourceSha256 } });
    const projectId = bind.json().data.id as string;
    const action = await f.plans.proposeDraft({ projectId, conversationId: 'conversation-1', messageId: 'message-1', category: '周计划', title: '下周获客', summary: '计划', content: '# 下周获客', expectedRevision: 1 });
    const requestId = '2c0ce1ae-511b-4bf4-9a9d-444444444447';
    const response = await f.app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/write-plans/${action.id}/confirm`, headers: f.authHeaders, payload: { clientRequestId: requestId } });
    expect(response.statusCode).toBe(200); expect(response.json().data.status).toBe('completed'); expect(response.json().data).not.toHaveProperty('content');
    const duplicate = await f.app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/write-plans/${action.id}/confirm`, headers: f.authHeaders, payload: { clientRequestId: requestId } });
    expect(duplicate.statusCode).toBe(200); expect(duplicate.json().data).toEqual(response.json().data);
    const extra = await f.app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/write-plans/${action.id}/confirm`, headers: f.authHeaders, payload: { clientRequestId: requestId, conversationId: 'conversation-1' } });
    expect(extra.statusCode).toBe(400);
    const wrongProject = await f.app.inject({ method: 'POST', url: `/api/v1/projects/33333333-3333-4333-8333-333333333333/write-plans/${action.id}/confirm`, headers: f.authHeaders, payload: { clientRequestId: '2c0ce1ae-511b-4bf4-9a9d-444444444451' } });
    expect(wrongProject.statusCode).toBe(409);
    const cancelAction = await f.plans.proposeDraft({ projectId, conversationId: 'conversation-1', messageId: 'message-2', category: '工作日志', title: '取消日志', summary: '日志', content: '待取消', expectedRevision: 1 });
    const cancelled = await f.app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/write-plans/${cancelAction.id}/cancel`, headers: f.authHeaders, payload: { clientRequestId: '2c0ce1ae-511b-4bf4-9a9d-444444444452' } });
    expect(cancelled.statusCode).toBe(200); expect(cancelled.json().data.status).toBe('cancelled');
    const repeatedCancel = await f.app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/write-plans/${cancelAction.id}/cancel`, headers: f.authHeaders, payload: { clientRequestId: '2c0ce1ae-511b-4bf4-9a9d-444444444453' } });
    expect(repeatedCancel.statusCode).toBe(409);
    expect((await f.app.inject({ url: `/api/v1/projects/${projectId}/operations`, headers: f.authHeaders })).json().data.operations[0].targetPath).toContain('AI工作区/周计划');
  });
});
