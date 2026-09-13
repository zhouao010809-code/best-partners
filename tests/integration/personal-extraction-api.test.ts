import { afterEach, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/server/app.js';
const servers: ReturnType<typeof buildServer>[] = [];
afterEach(async () => { for (const app of servers.splice(0)) await app.close(); });
const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
const settings = { available: true, configured: false, providerHost: 'api.deepseek.com' as const, model: 'deepseek-v4-flash' as const };
const stub = () => ({ settings: vi.fn(() => settings), setKey: vi.fn(() => ({ ...settings, configured: true })), clearKey: vi.fn(() => settings),
  verifyConnection: vi.fn(async () => ({ ...settings, configured: true, verification: { status: 'verified' as const,
    checkedAt: '2026-09-09T03:00:00.000Z', message: '连接验证成功，当前密钥和模型可以使用。' } })),
  queue: vi.fn(() => ({ items: [], counts: { pending: 0, generating: 0, ready: 0, unfinished: 0 } })), history: vi.fn(() => ({ items: [] })),
  source: vi.fn(() => ({ item: null })),
  setVisibility: vi.fn(() => ({ item: null })),
  list: vi.fn(() => ({ items: [] })), get: vi.fn(), preview: vi.fn(), start: vi.fn(), cancel: vi.fn(), close: vi.fn(async () => {}) });
it('makes missing desktop credential capability explicitly unavailable', async () => {
  const app = buildServer(); servers.push(app);
  const response = await app.inject({ url: '/api/v1/deepseek', headers });
  expect(response.statusCode).toBe(200); expect(response.json().data).toMatchObject({ available: false, configured: false });
  expect(response.headers['cache-control']).toBe('no-store');
});
it('requires origin, session and CSRF for key changes and never echoes the key', async () => {
  const service = stub(); const app = buildServer({ extractionService: service }); servers.push(app);
  const request = { method: 'POST' as const, url: '/api/v1/deepseek/key', payload: { apiKey: 'test-secret-never-echo' } };
  expect((await app.inject({ ...request, headers })).statusCode).toBe(401);
  const bootstrap = await app.inject({ url: '/api/v1/bootstrap', headers });
  const cookie = String(bootstrap.headers['set-cookie']).split(';')[0]!;
  expect((await app.inject({ ...request, headers: { ...headers, cookie } })).statusCode).toBe(403);
  const auth = { ...headers, cookie, 'x-csrf-token': bootstrap.json().data.csrfToken };
  expect((await app.inject({ ...request, headers: { ...auth, origin: 'https://evil.example' } })).statusCode).toBe(403);
  expect(service.setKey).not.toHaveBeenCalled();
  const response = await app.inject({ ...request, headers: auth });
  expect(response.statusCode).toBe(200); expect(response.body).not.toContain('test-secret-never-echo'); expect(response.json().data.configured).toBe(true);
  expect(service.setKey).toHaveBeenCalledExactlyOnceWith('test-secret-never-echo');
  expect((await app.inject({ ...request, payload: { ...request.payload, model: 'override' }, headers: auth })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/api/v1/extractions/start', payload: { token: '11111111-1111-4111-8111-111111111111', messages: [] }, headers: auth })).statusCode).toBe(400);
  expect(service.start).not.toHaveBeenCalled();
});
it('exposes saved results without starting remote work and closes extraction before outer shutdown', async () => {
  const service = stub(); const order: string[] = []; service.close.mockImplementation(async () => { order.push('extractions'); });
  const app = buildServer({ extractionService: service, onClose: () => { order.push('database'); } });
  const response = await app.inject({ url: '/api/v1/extractions?materialPath=01图书馆%2F来自个人%2F资料.md', headers });
  expect(response.statusCode).toBe(200); expect(service.list).toHaveBeenCalledWith('01图书馆/来自个人/资料.md');
  expect(service.start).not.toHaveBeenCalled(); await app.close(); expect(order).toEqual(['extractions', 'database']);
});

it('requires explicit protected verification and rejects any caller-controlled prompt or key', async () => {
  const service = stub(); const app = buildServer({ extractionService: service }); servers.push(app);
  await app.inject({ url: '/api/v1/deepseek', headers }); expect(service.verifyConnection).not.toHaveBeenCalled();
  const request = { method: 'POST' as const, url: '/api/v1/deepseek/verify', payload: {} };
  expect((await app.inject({ ...request, headers })).statusCode).toBe(401);
  const bootstrap = await app.inject({ url: '/api/v1/bootstrap', headers });
  const cookie = String(bootstrap.headers['set-cookie']).split(';')[0]!;
  const auth = { ...headers, cookie, 'x-csrf-token': bootstrap.json().data.csrfToken };
  expect((await app.inject({ ...request, headers: { ...headers, cookie } })).statusCode).toBe(403);
  expect((await app.inject({ ...request, headers: { ...auth, origin: 'https://evil.example' } })).statusCode).toBe(403);
  for (const payload of [{ apiKey: 'not-allowed' }, { messages: [{ role: 'user', content: 'private' }] }, { model: 'override' }]) {
    expect((await app.inject({ ...request, headers: auth, payload })).statusCode).toBe(400);
  }
  expect(service.verifyConnection).not.toHaveBeenCalled();
  const response = await app.inject({ ...request, headers: auth });
  expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json().data.verification).toMatchObject({ status: 'verified', checkedAt: '2026-09-09T03:00:00.000Z' });
  expect(service.verifyConnection).toHaveBeenCalledExactlyOnceWith(); expect(service.start).not.toHaveBeenCalled();
  expect(service.setKey).not.toHaveBeenCalled(); expect(service.clearKey).not.toHaveBeenCalled();
});
