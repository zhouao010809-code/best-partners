import { afterEach, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/server/app.js';
const servers: ReturnType<typeof buildServer>[] = [];
afterEach(async () => { for (const app of servers.splice(0)) await app.close(); });
const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
const data = { available: true, automaticArchive: false as const, items: [], operations: [] };
const stub = () => ({ list: vi.fn(async () => data), preview: vi.fn(), commit: vi.fn(), resume: vi.fn() });
it('makes absent personal capability explicitly unavailable, without exposing write operations', async () => {
  const app = buildServer(); servers.push(app);
  const response = await app.inject({ url: '/api/v1/intake', headers });
  expect(response.statusCode).toBe(200);
  expect(response.json().data).toMatchObject({ available: false, automaticArchive: false });
});
it('lists intake with no-store and no mutation', async () => {
  const service = stub(); const app = buildServer({ intakeService: service }); servers.push(app);
  const response = await app.inject({ url: '/api/v1/intake', headers });
  expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json().data).toEqual(data); expect(service.commit).not.toHaveBeenCalled();
});
it('requires session and CSRF, rejects arbitrary replacement content, and accepts only preview token', async () => {
  const service = stub(); const app = buildServer({ intakeService: service }); servers.push(app);
  expect((await app.inject({ method: 'POST', url: '/api/v1/intake/commit', headers, payload: { token: 'x' } })).statusCode).toBe(401);
  const bootstrap = await app.inject({ url: '/api/v1/bootstrap', headers });
  const cookie = String(bootstrap.headers['set-cookie']).split(';')[0]!;
  const auth = { ...headers, cookie, 'x-csrf-token': bootstrap.json().data.csrfToken };
  const token = 'e52917bc-a9df-482f-aae8-8c4b6da4301d';
  expect((await app.inject({ method: 'POST', url: '/api/v1/intake/commit', headers: auth, payload: { token, bytes: 'replacement' } })).statusCode).toBe(400);
  expect(service.commit).not.toHaveBeenCalled();
  service.commit.mockResolvedValue({ id: token, target: '01图书馆/来自个人/2026-09/资料', state: 'archived', indexed: true });
  const result = await app.inject({ method: 'POST', url: '/api/v1/intake/commit', headers: auth, payload: { token } });
  expect(result.statusCode).toBe(200); expect(service.commit).toHaveBeenCalledWith(token);
});
