import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { buildServer } from '../../src/server/app.js';
import { createCompanyRuntime } from '../../src/server/company/company-runtime.js';
import { applyMigrations } from '../../src/server/db/migrate.js';
import type { SkillCatalogService } from '../../src/server/services/skill-catalog.js';
import { skillResponseSchema, skillsResponseSchema } from '../../src/shared/api/skills.js';

const servers: Array<ReturnType<typeof buildServer>> = [];
const databases: Database.Database[] = [];
const COMPANY_BOOTSTRAP_TOKEN = 'b'.repeat(43);

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  for (const database of databases.splice(0)) database.close();
});

const revision = 'a'.repeat(64);
const summary = { id: revision, name: '教育内容策划', description: '教育项目的方法论', revision, folderId: null, folderName: null };
const detail = { ...summary, markdown: '# 教育内容策划\n\n只读方法。', references: ['REFERENCE.md'] };

function cookie(response: Awaited<ReturnType<ReturnType<typeof buildServer>['inject']>>): string {
  const value = response.headers['set-cookie'];
  if (typeof value !== 'string') throw new Error('missing company cookie');
  return value.split(';', 1)[0]!;
}

async function session(server: ReturnType<typeof buildServer>): Promise<{ cookie: string; csrfToken: string }> {
  const bootstrap = await server.inject({ method: 'POST', url: '/api/company/v1/auth/bootstrap', headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'x-company-bootstrap-token': COMPANY_BOOTSTRAP_TOKEN }, payload: { operator: { displayName: 'Operator', password: 'operator-secret' }, reviewer: { displayName: 'Reviewer', password: 'reviewer-secret' } } });
  expect(bootstrap.statusCode).toBe(200);
  const login = await server.inject({ method: 'POST', url: '/api/company/v1/auth/login', headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' }, payload: { displayName: 'Operator', password: 'operator-secret' } });
  expect(login.statusCode).toBe(200);
  return { cookie: cookie(login), csrfToken: login.json().data.csrfToken as string };
}

function fixture(): SkillCatalogService {
  return {
    list: async () => ({ folders: [], items: [summary] }),
    get: async () => detail,
    createFolder: async () => ({ id: revision, name: 'unused', skillCount: 0 }),
    move: async () => summary,
    resolveSource: async () => '/unexposed/source'
  };
}

describe('company Skill read API', () => {
  it('is session-protected and returns strict list/detail envelopes', async () => {
    const database = new Database(':memory:');
    databases.push(database);
    applyMigrations(database);
    const runtime = createCompanyRuntime({ database, workspaceRoot: '/srv/company-workspace', skills: fixture() });
    const server = buildServer({ runtimeMode: 'company', companyRuntime: runtime, companyBootstrapToken: COMPANY_BOOTSTRAP_TOKEN });
    servers.push(server);

    expect((await server.inject({ url: '/api/company/v1/skills', headers: { host: '127.0.0.1:4317' } })).statusCode).toBe(401);
    const current = await session(server);
    const headers = { host: '127.0.0.1:4317', cookie: current.cookie, origin: 'http://127.0.0.1:4317' };
    const list = await server.inject({ url: '/api/company/v1/skills', headers });
    expect(list.statusCode).toBe(200);
    expect(skillsResponseSchema.parse(list.json())).toEqual(list.json());
    const itemId = list.json().data.items[0].id as string;
    const detailResponse = await server.inject({ url: `/api/company/v1/skills/${itemId}`, headers });
    expect(detailResponse.statusCode).toBe(200);
    expect(skillResponseSchema.parse(detailResponse.json())).toEqual(detailResponse.json());
    expect(detailResponse.json().data.markdown).toContain('只读方法');
  });
});
