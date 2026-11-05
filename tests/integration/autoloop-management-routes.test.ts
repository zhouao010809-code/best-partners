import { afterEach, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/server/app.js';
import type { AutoloopManagementService } from '../../src/shared/api/autoloop-management.js';
const servers: ReturnType<typeof buildServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(app => app.close())); });
const headers = { host: '127.0.0.1:4317' };
const service = { configuration: vi.fn(async () => ({ revision: 'r1', document: { sources: {}, agents: {}, rules: [] }, disabledRules: [], localWorker: null })), save: vi.fn(async () => ({ revision: 'r2', loaded: true, message: '已保存' })), trigger: vi.fn(async () => ({ event: 1, duplicate: false, routed: ['日报'] })) } as unknown as AutoloopManagementService;
it('registers management only in personal mode with no-store and standard envelopes', async () => {
  const app = buildServer({ autoloopManagementService: service }); servers.push(app);
  const response = await app.inject({ method: 'GET', url: '/api/v1/autoloop/manage/configuration', headers });
  expect(response.statusCode).toBe(200); expect(response.json().data.revision).toBe('r1'); expect(response.headers['cache-control']).toBe('no-store');
  const company = buildServer({ runtimeMode: 'company', autoloopManagementService: service }); servers.push(company);
  expect((await company.inject({ method: 'GET', url: '/api/v1/autoloop/manage/configuration', headers })).statusCode).toBe(404);
});
it('requires session/CSRF and rejects raw keys or invalid trigger input before service calls', async () => {
  const app = buildServer({ autoloopManagementService: service }); servers.push(app);
  const url = '/api/v1/autoloop/manage/configuration'; const origin = 'http://127.0.0.1:4317';
  expect((await app.inject({ method: 'POST', url, headers: { ...headers, origin }, payload: {} })).statusCode).toBe(401);
  const bootstrap = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers });
  const authorized = { ...headers, origin, cookie: String(bootstrap.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': bootstrap.json().data.csrfToken };
  expect((await app.inject({ method: 'POST', url, headers: authorized, payload: { revision: 'r1', document: { sources: {}, agents: {}, rules: [] }, owner: 'secret' } })).statusCode).toBe(400);
  const response = await app.inject({ method: 'POST', url, headers: authorized, payload: { revision: 'r1', document: { sources: {}, agents: {}, rules: [] }, disabledRules: [] } });
  expect(response.statusCode).toBe(200); expect(response.json().data.revision).toBe('r2');
  expect((await app.inject({ method: 'POST', url: '/api/v1/autoloop/manage/rules/' + encodeURIComponent('日报') + '/trigger', headers: authorized, payload: { id: 'test-id' } })).statusCode).toBe(200);
});
