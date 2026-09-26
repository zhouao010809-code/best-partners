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
  const cookieHeader = bootstrap.headers['set-cookie'];
  const cookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  if (cookie === undefined) throw new Error('bootstrap response did not set a session cookie');
  const csrf = bootstrap.json().data.csrfToken;
  return { ...headers, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };
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

it('protects matching with session and CSRF and rejects empty or unknown fields', async () => {
  const { app, service } = fixture();
  expect((await app.inject({ method: 'POST', url: '/api/v1/skills/match', headers, payload: { message: 'Draft copy' } })).statusCode).toBe(401);
  const authHeaders = await sessionHeaders(app);
  expect((await app.inject({ method: 'POST', url: '/api/v1/skills/match', headers: { ...authHeaders, 'x-csrf-token': 'bad' }, payload: { message: 'Draft copy' } })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/api/v1/skills/match', headers: authHeaders, payload: { message: '' } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/api/v1/skills/match', headers: authHeaders, payload: { message: 'Draft copy', path: '/tmp/skill' } })).statusCode).toBe(400);
  expect(service.list).not.toHaveBeenCalled();
  expect(service.get).not.toHaveBeenCalled();
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
  const match = await app.inject({ method: 'POST', url: '/api/v1/skills/match', headers: authHeaders, payload: { message: 'Draft copy' } });
  expect(match.statusCode).toBe(503);
  expect(match.json().error.code).toBe('SKILL_CATALOG_UNAVAILABLE');
});

it('matches skills through the protected strict endpoint without exposing paths', async () => {
  const candidate = {
    id: summary.id,
    name: summary.name,
    description: summary.description,
    folderName: summary.folderName,
    revision: summary.revision,
    reason: 'Skill 名称与当前任务匹配'
  };
  const { app, service } = fixture({
    matchDocuments: vi.fn(async () => [{ ...detail }])
  });
  const authHeaders = await sessionHeaders(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/skills/match',
    headers: authHeaders,
    payload: { message: '请用 Writer 写一份文案' }
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toEqual({ version: 1, data: { candidates: [candidate] } });
  expect(response.body).not.toContain('/private/path');
  expect(service.matchDocuments).toHaveBeenCalledOnce();
});

it('returns a stable readable 503 when the catalog directory is unavailable', async () => {
  const { app } = fixture({
    matchDocuments: vi.fn(async () => {
      throw new PublicApiError('SKILL_CATALOG_UNAVAILABLE', 'Skill catalog is unavailable.', 503);
    })
  });
  const authHeaders = await sessionHeaders(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/skills/match',
    headers: authHeaders,
    payload: { message: '写文案' }
  });
  expect(response.statusCode).toBe(503);
  expect(response.json().error).toMatchObject({
    code: 'SKILL_CATALOG_UNAVAILABLE',
    message: 'Skill catalog is unavailable.'
  });
});

it('previews, confirms, lists and restores personal Skill folders through strict protected endpoints', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const preview = { id, folderId: folder.id, name: folder.name, skillCount: 1, entryCount: 2, expiresAt: '2026-09-26T12:05:00Z' };
  const entry = { id, folderId: folder.id, name: folder.name, skillCount: 1, createdAt: '2026-09-26T12:00:00Z', status: 'trashed' as const };
  const { app, service } = fixture({
    previewFolderTrash: vi.fn(async () => preview), trashFolder: vi.fn(async () => entry),
    listFolderTrash: vi.fn(async () => ({ items: [entry] })), restoreFolder: vi.fn(async () => ({ ...entry, status: 'restored' as const }))
  });
  const auth = await sessionHeaders(app);
  const previewUrl = `/api/v1/skills/folders/${folder.id}/trash-preview`;
  expect((await app.inject({ method: 'POST', url: previewUrl, headers, payload: {} })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: previewUrl, headers: { ...auth, 'x-csrf-token': 'bad' }, payload: {} })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: previewUrl, headers: auth, payload: { path: '/tmp' } })).statusCode).toBe(400);
  const response = await app.inject({ method: 'POST', url: previewUrl, headers: auth, payload: {} });
  expect(response.statusCode).toBe(200); expect(response.json().data).toEqual(preview);
  expect(service.previewFolderTrash).toHaveBeenCalledExactlyOnceWith(folder.id);
  const committed = await app.inject({ method: 'POST', url: '/api/v1/skills/folder-trash', headers: auth, payload: { id } });
  expect(committed.statusCode).toBe(200); expect(committed.json().data).toEqual(entry);
  expect((await app.inject({ url: '/api/v1/skills/folder-trash', headers: auth })).json().data.items).toEqual([entry]);
  const restored = await app.inject({ method: 'POST', url: '/api/v1/skills/folder-trash/restore', headers: auth, payload: { id } });
  expect(restored.json().data.status).toBe('restored');
  expect((await app.inject({ method: 'POST', url: '/api/v1/skills/folder-trash/restore', headers: auth, payload: { id: '../outside' } })).statusCode).toBe(400);
});

it('does not expose folder recycling when the catalog lacks the personal capability', async () => {
  const { app } = fixture(); const auth = await sessionHeaders(app);
  expect((await app.inject({ method: 'POST', url: `/api/v1/skills/folders/${folder.id}/trash-preview`, headers: auth, payload: {} })).statusCode).toBe(503);
  expect((await app.inject({ url: '/api/v1/skills/folder-trash', headers: auth })).statusCode).toBe(503);
});

it('localizes known folder failures across the Electron/server bundle boundary without exposing raw paths', async () => {
  class ElectronBundleError extends Error {
    readonly code = 'SKILL_FOLDER_RESTORE_CONFLICT';
    readonly statusCode = 409;
  }
  const id = '11111111-1111-4111-8111-111111111111';
  const { app } = fixture({
    previewFolderTrash: vi.fn(), trashFolder: vi.fn(), listFolderTrash: vi.fn(),
    restoreFolder: vi.fn(async () => { throw new ElectronBundleError('private implementation /private/secret'); })
  });
  const response = await app.inject({ method: 'POST', url: '/api/v1/skills/folder-trash/restore', headers: await sessionHeaders(app), payload: { id } });
  expect(response.statusCode).toBe(409);
  expect(response.json().error).toMatchObject({ code: 'SKILL_FOLDER_RESTORE_CONFLICT', message: expect.stringContaining('请先重命名或移走同名文件夹') });
  expect(response.body).not.toContain('/private/secret');
});
