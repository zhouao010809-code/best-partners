import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { buildServer } from '../../src/server/app.js';
import { createCompanyRuntime } from '../../src/server/company/company-runtime.js';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { companyMetricsStatusResponseSchema, companyProjectMetricsResponseSchema, companyMetricScanResponseSchema } from '../../src/shared/api/company-metrics.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const COMPANY_BOOTSTRAP_TOKEN = 'b'.repeat(43);
const servers: Array<ReturnType<typeof buildServer>> = [];
const databases: Database.Database[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  for (const db of databases.splice(0)) db.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function cookie(response: Awaited<ReturnType<ReturnType<typeof buildServer>['inject']>>): string {
  const value = response.headers['set-cookie'];
  if (typeof value !== 'string') throw new Error('missing cookie');
  return value.split(';', 1)[0]!;
}

async function login(server: ReturnType<typeof buildServer>, displayName: string, password: string) {
  const response = await server.inject({
    method: 'POST', url: '/api/company/v1/auth/login',
    headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' },
    payload: { displayName, password }
  });
  expect(response.statusCode).toBe(200);
  return { cookie: cookie(response), csrfToken: response.json().data.csrfToken as string };
}

describe('company metrics API', () => {
  it('scans official exports, returns typed project metrics, and protects imports by role', async () => {
    const root = await mkdtemp(join(tmpdir(), 'company-metrics-api-'));
    roots.push(root);
    const db = new Database(':memory:');
    databases.push(db);
    applyMigrations(db);
    const now = '2026-09-19T12:00:00.000Z';
    db.prepare('INSERT INTO company_workspaces (id, display_name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('company', 'Company', root, now, now);
    db.prepare('INSERT INTO company_projects (id, workspace_id, name, status, project_root, source_root, config_sha256, confidence_json, selected_skill_ids_json, created_at, updated_at) VALUES (?, ?, ?, \'active\', ?, ?, ?, ?, ?, ?, ?)')
      .run('project-1', 'company', '教育代运营', join(root, 'projects/project-1'), join(root, 'incoming/project-1'), 'a'.repeat(64), '{}', '[]', now, now);
    const drop = join(root, 'platform-data/douyin/project-1');
    await mkdir(drop, { recursive: true });
    await writeFile(join(drop, 'data.csv'), '作品ID,数据日期,播放量,点赞\nitem-1,2026-09-19,1200,8\n', { mode: 0o600 });
    const runtime = createCompanyRuntime({ database: db, workspaceRoot: root });
    const server = buildServer({ runtimeMode: 'company', companyRuntime: runtime, companyBootstrapToken: COMPANY_BOOTSTRAP_TOKEN });
    servers.push(server);
    const bootstrap = await server.inject({
      method: 'POST', url: '/api/company/v1/auth/bootstrap',
      headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'x-company-bootstrap-token': COMPANY_BOOTSTRAP_TOKEN },
      payload: { operator: { displayName: 'Operator', password: 'operator-secret' }, reviewer: { displayName: 'Reviewer', password: 'reviewer-secret' } }
    });
    expect(bootstrap.statusCode).toBe(200);
    const operator = await login(server, 'Operator', 'operator-secret');
    const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', cookie: operator.cookie, 'x-csrf-token': operator.csrfToken };
    const scan = await server.inject({ method: 'POST', url: '/api/company/v1/metrics/scan', headers, payload: {} });
    expect(scan.statusCode).toBe(200);
    expect(companyMetricScanResponseSchema.parse(scan.json())).toEqual(scan.json());
    expect(scan.json().data.imported).toBe(1);
    const metrics = await server.inject({ url: '/api/company/v1/projects/project-1/metrics', headers });
    expect(metrics.statusCode).toBe(200);
    expect(companyProjectMetricsResponseSchema.parse(metrics.json())).toEqual(metrics.json());
    expect(metrics.json().data.totals).toMatchObject({ views: 1200, likes: 8 });
    const status = await server.inject({ url: '/api/company/v1/metrics/status', headers });
    expect(status.statusCode).toBe(200);
    expect(companyMetricsStatusResponseSchema.parse(status.json())).toEqual(status.json());

    const reviewer = await login(server, 'Reviewer', 'reviewer-secret');
    const forbidden = await server.inject({
      method: 'POST', url: '/api/company/v1/metrics/scan',
      headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', cookie: reviewer.cookie, 'x-csrf-token': reviewer.csrfToken },
      payload: {}
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('accepts a project-scoped binary export upload and keeps the import permission boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'company-metrics-upload-api-'));
    roots.push(root);
    const db = new Database(':memory:');
    databases.push(db);
    applyMigrations(db);
    const now = '2026-09-19T12:00:00.000Z';
    db.prepare('INSERT INTO company_workspaces (id, display_name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('company', 'Company', root, now, now);
    db.prepare('INSERT INTO company_projects (id, workspace_id, name, status, project_root, source_root, config_sha256, confidence_json, selected_skill_ids_json, created_at, updated_at) VALUES (?, ?, ?, \'active\', ?, ?, ?, ?, ?, ?, ?)')
      .run('project-1', 'company', '教育代运营', join(root, 'projects/project-1'), join(root, 'incoming/project-1'), 'a'.repeat(64), '{}', '[]', now, now);
    const runtime = createCompanyRuntime({ database: db, workspaceRoot: root });
    const server = buildServer({ runtimeMode: 'company', companyRuntime: runtime, companyBootstrapToken: COMPANY_BOOTSTRAP_TOKEN });
    servers.push(server);
    const bootstrap = await server.inject({
      method: 'POST', url: '/api/company/v1/auth/bootstrap',
      headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'x-company-bootstrap-token': COMPANY_BOOTSTRAP_TOKEN },
      payload: { operator: { displayName: 'Operator', password: 'operator-secret' }, reviewer: { displayName: 'Reviewer', password: 'reviewer-secret' } }
    });
    expect(bootstrap.statusCode).toBe(200);
    const operator = await login(server, 'Operator', 'operator-secret');
    const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', cookie: operator.cookie, 'x-csrf-token': operator.csrfToken, 'content-type': 'application/octet-stream' };
    const bytes = Buffer.from('作品ID,数据日期,播放量,点赞\nitem-upload,2026-09-19,1300,9\n');
    const upload = await server.inject({
      method: 'POST',
      url: '/api/company/v1/projects/project-1/metrics/upload?platform=douyin&fileName=%E5%AE%98%E6%96%B9%E5%AF%BC%E5%87%BA.csv',
      headers,
      payload: bytes
    });
    expect(upload.statusCode).toBe(200);
    expect(upload.json().data).toMatchObject({ projectId: 'project-1', platform: 'douyin', state: 'imported', importedCount: 1 });
    expect(upload.json().data.sourceRelativePath).toMatch(/^platform-data\/douyin\/project-1\/[a-f0-9]{64}-.*\.csv$/u);

    const reviewer = await login(server, 'Reviewer', 'reviewer-secret');
    const forbidden = await server.inject({
      method: 'POST',
      url: '/api/company/v1/projects/project-1/metrics/upload?platform=douyin&fileName=blocked.csv',
      headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', cookie: reviewer.cookie, 'x-csrf-token': reviewer.csrfToken, 'content-type': 'application/octet-stream' },
      payload: bytes
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('bounds the binary metrics upload parser at 20 MiB before persistence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'company-metrics-upload-limit-'));
    roots.push(root);
    const db = new Database(':memory:');
    databases.push(db);
    applyMigrations(db);
    const now = '2026-09-19T12:00:00.000Z';
    db.prepare('INSERT INTO company_workspaces (id, display_name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('company', 'Company', root, now, now);
    db.prepare('INSERT INTO company_projects (id, workspace_id, name, status, project_root, source_root, config_sha256, confidence_json, selected_skill_ids_json, created_at, updated_at) VALUES (?, ?, ?, \'active\', ?, ?, ?, ?, ?, ?, ?)')
      .run('project-1', 'company', '教育代运营', join(root, 'projects/project-1'), join(root, 'incoming/project-1'), 'a'.repeat(64), '{}', '[]', now, now);
    const runtime = createCompanyRuntime({ database: db, workspaceRoot: root });
    const server = buildServer({ runtimeMode: 'company', companyRuntime: runtime, companyBootstrapToken: COMPANY_BOOTSTRAP_TOKEN });
    servers.push(server);
    await server.inject({
      method: 'POST', url: '/api/company/v1/auth/bootstrap',
      headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'x-company-bootstrap-token': COMPANY_BOOTSTRAP_TOKEN },
      payload: { operator: { displayName: 'Operator', password: 'operator-secret' }, reviewer: { displayName: 'Reviewer', password: 'reviewer-secret' } }
    });
    const operator = await login(server, 'Operator', 'operator-secret');
    const response = await server.inject({
      method: 'POST',
      url: '/api/company/v1/projects/project-1/metrics/upload?platform=douyin&fileName=large.csv',
      headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', cookie: operator.cookie, 'x-csrf-token': operator.csrfToken, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(20 * 1024 * 1024 + 1, 65)
    });
    expect(response.statusCode).toBe(413);
    expect(runtime.metrics.getStatus && (await runtime.metrics.getStatus()).recentImports).toHaveLength(0);
  });
});
