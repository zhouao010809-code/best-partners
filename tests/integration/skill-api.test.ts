import { afterEach, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/server/app.js';
import type { SkillCatalogService } from '../../src/server/services/skill-catalog.js';
import type { SkillDetail, SkillSummary } from '../../src/shared/api/skills.js';
import { PublicApiError } from '../../src/shared/api/errors.js';

const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
const folder = { id: 'f'.repeat(64), name: 'Marketing', skillCount: 1 };
const summary: SkillSummary = { id: 'a'.repeat(64), name: 'Writer', description: 'Drafts copy', revision: 'b'.repeat(64), folderId: folder.id, folderName: folder.name };
const detail: SkillDetail = { ...summary, markdown: '# Writer\n', references: ['REFERENCE.md'] };
const servers: ReturnType<typeof buildServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

function fixture(catalog: Partial<SkillCatalogService> = {}): { app: ReturnType<typeof buildServer>; service: SkillCatalogService } {
  const service: SkillCatalogService = {
    list: vi.fn(async () => ({ folders: [folder], items: [summary] })),
    get: vi.fn(async () => detail),
    createFolder: vi.fn(async (name: string) => ({ id: 'e'.repeat(64), name, skillCount: 0 })),
    move: vi.fn(async () => summary),
    resolveSource: vi.fn(async () => '/private/path/SKILL.md'),
    ...catalog
  };
  const app = buildServer({ skillCatalog: service });
  servers.push(app);
  return { app, service };
}

it('serves strict list and detail envelopes without exposing filesystem paths', async () => {
  const { app, service } = fixture();
  const list = await app.inject({ url: '/api/v1/skills', headers });
  expect(list.statusCode).toBe(200);
  expect(list.headers['cache-control']).toBe('no-store');
  expect(list.json()).toEqual({ version: 1, data: { folders: [folder], items: [summary] } });
  const detailResponse = await app.inject({ url: `/api/v1/skills/${summary.id}`, headers });
  expect(detailResponse.statusCode).toBe(200);
  expect(detailResponse.headers['cache-control']).toBe('no-store');
  expect(detailResponse.json()).toEqual({ version: 1, data: detail });
  expect(service.list).toHaveBeenCalledOnce();
  expect(service.get).toHaveBeenCalledWith(summary.id);
});

async function sessionHeaders(app: ReturnType<typeof buildServer>): Promise<Record<string, string>> {
  const bootstrap = await app.inject({ url: '/api/v1/bootstrap', headers });
  const cookie = bootstrap.headers['set-cookie'];
  const csrf = bootstrap.json().data.csrfToken;
  return { ...headers, cookie: Array.isArray(cookie) ? cookie[0] : cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };
}

it('creates folders and moves skills through protected strict mutation endpoints', async () => {
  const { app, service } = fixture();
  const authHeaders = await sessionHeaders(app);
  const created = await app.inject({ method: 'POST', url: '/api/v1/skills/folders', headers: authHeaders, payload: { name: 'Docs' } });
  expect(created.statusCode).toBe(200);
  expect(created.headers['cache-control']).toBe('no-store');
  expect(created.json()).toEqual({ version: 1, data: { id: 'e'.repeat(64), name: 'Docs', skillCount: 0 } });
  expect(service.createFolder).toHaveBeenCalledWith('Docs');
  const moved = await app.inject({ method: 'POST', url: `/api/v1/skills/${summary.id}/move`, headers: authHeaders, payload: { folderId: null } });
  expect(moved.statusCode).toBe(200);
  expect(moved.json()).toEqual({ version: 1, data: summary });
  expect(moved.headers['cache-control']).toBe('no-store');
  expect(service.move).toHaveBeenCalledWith(summary.id, null);
});

it('protects mutations and rejects strict payloads', async () => {
  const { app, service } = fixture();
  const noSession = await app.inject({ method: 'POST', url: '/api/v1/skills/folders', headers, payload: { name: 'Docs' } });
  expect(noSession.statusCode).toBe(401);
  const authHeaders = await sessionHeaders(app);
  const badCsrf = await app.inject({ method: 'POST', url: '/api/v1/skills/folders', headers: { ...authHeaders, 'x-csrf-token': 'bad' }, payload: { name: 'Docs' } });
  expect(badCsrf.statusCode).toBe(403);
  const extra = await app.inject({ method: 'POST', url: '/api/v1/skills/folders', headers: authHeaders, payload: { name: 'Docs', extra: true } });
  expect(extra.statusCode).toBe(400);
  expect(service.createFolder).not.toHaveBeenCalled();
  const malformedMove = await app.inject({ method: 'POST', url: `/api/v1/skills/${summary.id}/move`, headers: authHeaders, payload: { folderId: null, extra: true } });
  expect(malformedMove.statusCode).toBe(400);
  expect(service.move).not.toHaveBeenCalled();
});

it('transparently returns catalog errors for unknown skills and folders', async () => {
  const { app } = fixture({
    createFolder: vi.fn(async () => { throw new PublicApiError('SKILL_FOLDER_CONFLICT', 'Skill folder conflicts.', 409); }),
    move: vi.fn(async () => { throw new PublicApiError('SKILL_FOLDER_NOT_FOUND', 'Skill folder was not found.', 404); })
  });
  const authHeaders = await sessionHeaders(app);
  expect((await app.inject({ method: 'POST', url: '/api/v1/skills/folders', headers: authHeaders, payload: { name: 'Docs' } })).statusCode).toBe(409);
  expect((await app.inject({ method: 'POST', url: `/api/v1/skills/${summary.id}/move`, headers: authHeaders, payload: { folderId: folder.id } })).statusCode).toBe(404);
});

it('rejects malformed and unknown ids before reaching the catalog', async () => {
  const { app, service } = fixture({ get: vi.fn(async () => { throw new PublicApiError('SKILL_NOT_FOUND', 'Skill was not found.', 404); }) });
  const malformed = await app.inject({ url: '/api/v1/skills/not-an-id', headers });
  expect(malformed.statusCode).toBe(400);
  expect(malformed.json().error.code).toBe('VALIDATION_ERROR');
  expect(service.get).not.toHaveBeenCalled();

  const unknown = await app.inject({ url: `/api/v1/skills/${'c'.repeat(64)}`, headers });
  expect(unknown.statusCode).toBe(404);
});

it('returns a typed 503 when no local catalog is configured', async () => {
  const app = buildServer();
  servers.push(app);
  const list = await app.inject({ url: '/api/v1/skills', headers });
  expect(list.statusCode).toBe(503);
  expect(list.json().error.code).toBe('SKILL_CATALOG_UNAVAILABLE');
  expect((await app.inject({ url: `/api/v1/skills/${summary.id}`, headers })).statusCode).toBe(503);
  const authHeaders = await sessionHeaders(app);
  const folder = await app.inject({ method: 'POST', url: '/api/v1/skills/folders', headers: authHeaders, payload: { name: 'Docs' } });
  expect(folder.statusCode).toBe(503);
  expect(folder.json().error.code).toBe('SKILL_CATALOG_UNAVAILABLE');
  const move = await app.inject({ method: 'POST', url: `/api/v1/skills/${summary.id}/move`, headers: authHeaders, payload: { folderId: null } });
  expect(move.statusCode).toBe(503);
  expect(move.json().error.code).toBe('SKILL_CATALOG_UNAVAILABLE');
});
