import { afterEach, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/server/app.js';
const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
const id = '12345678-1234-4123-8123-123456789abc';
const token = '87654321-1234-4123-8123-123456789abc';
const entry = { id, name: '资料', title: '资料', kind: 'directory' as const, bytes: 20, fileCount: 2, createdAt: '2026-09-07T00:00:00.000Z', status: 'trashed' as const };
const servers: ReturnType<typeof buildServer>[] = [];
afterEach(async () => { for (const app of servers.splice(0)) await app.close(); });
function fixture() {
  const service = { list: vi.fn(() => ({ items: [entry] })), get: vi.fn(() => entry),
    preview: vi.fn(async () => ({ id, name: entry.name, title: entry.title, kind: entry.kind, bytes: 20, fileCount: 2, expiresAt: '2099-01-01T00:00:00.000Z' })),
    previewDelete: vi.fn(async () => ({ id, token, name: entry.name, title: entry.title, kind: entry.kind, bytes: 20, fileCount: 2, expiresAt: '2099-01-01T00:00:00.000Z' })),
    delete: vi.fn(async () => ({ ...entry, status: 'deleted' as const, deletedAt: '2026-09-07T00:00:00.000Z' })),
    commit: vi.fn(async () => entry), restore: vi.fn(async () => ({ ...entry, status: 'restored' as const })), retry: vi.fn(async () => entry), recover: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const app = buildServer({ intakeTrashService: service }); servers.push(app); return { app, service };
}
it('reads packet records without invoking any mutation or recovery', async () => {
  const { app, service } = fixture();
  for (const url of ['/api/v1/intake-trash', `/api/v1/intake-trash/${id}`]) {
    const result = await app.inject({ url, headers }); expect(result.statusCode).toBe(200); expect(result.headers['cache-control']).toBe('no-store');
  }
  expect(service.commit).not.toHaveBeenCalled(); expect(service.restore).not.toHaveBeenCalled(); expect(service.recover).not.toHaveBeenCalled();
});
it.each(['preview', 'commit', 'restore', 'retry'] as const)('protects and validates %s', async action => {
  const { app, service } = fixture(); const url = action === 'preview' ? '/api/v1/intake-trash/preview' : `/api/v1/intake-trash/${id}/${action}`;
  const payload = action === 'preview' ? { name: '资料' } : {};
  expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(401);
  const b = await app.inject({ url: '/api/v1/bootstrap', headers });
  const auth = { ...headers, cookie: String(b.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': b.json().data.csrfToken as string };
  expect((await app.inject({ method: 'POST', url, headers: { ...auth, 'x-csrf-token': 'bad' }, payload })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url, headers: auth, payload: { ...payload, force: true } })).statusCode).toBe(400);
  expect(service[action]).not.toHaveBeenCalled();
  expect((await app.inject({ method: 'POST', url, headers: auth, payload })).statusCode).toBe(200);
  expect(service[action]).toHaveBeenCalledWith(action === 'preview' ? '资料' : id);
});
it.each(['delete-preview', 'delete'] as const)('requires authenticated explicit confirmation and strict input for %s', async action => {
  const { app, service } = fixture(); const url = `/api/v1/intake-trash/${id}/${action}`, payload = action === 'delete' ? { token } : {};
  expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(401);
  const b = await app.inject({ url: '/api/v1/bootstrap', headers });
  const auth = { ...headers, cookie: String(b.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': b.json().data.csrfToken as string };
  expect((await app.inject({ method: 'POST', url, headers: auth, payload: { ...payload, force: true } })).statusCode).toBe(400);
  if (action === 'delete') expect((await app.inject({ method: 'POST', url, headers: auth, payload: {} })).statusCode).toBe(400);
  const response = await app.inject({ method: 'POST', url, headers: auth, payload });
  expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  if (action === 'delete') expect(service.delete).toHaveBeenCalledWith(id, token);
  else expect(service.previewDelete).toHaveBeenCalledWith(id);
});
it('reports unavailable writer', async () => {
  const app = buildServer(); servers.push(app);
  expect((await app.inject({ url: '/api/v1/intake-trash', headers })).statusCode).toBe(503);
});
