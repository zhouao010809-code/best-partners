import { afterEach, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/server/app.js';
import type { AutoloopConnectionsService } from '../../src/shared/api/autoloop-connections.js';
const servers: ReturnType<typeof buildServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });
const headers = { host: '127.0.0.1:4317' };
const service: AutoloopConnectionsService = {
  list: async () => ({ connections: [], restartRequired: false }),
  save: vi.fn(async () => ({ ok: true as const, restartRequired: true })),
  probe: async id => ({ id, ok: false, message: '未外发消息', checks: [] }),
  lifecycle: vi.fn(async () => ({ ok: true as const, message: '已重启' }))
};
it('keeps connection configuration personal, uncached and protected by the standard mutation boundary', async () => {
  const app = buildServer({ autoloopConnectionsService: service }); servers.push(app);
  const response = await app.inject({ method: 'GET', url: '/api/v1/autoloop/connections', headers });
  expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  expect((await app.inject({ method: 'POST', url: '/api/v1/autoloop/connections/feishu/save', headers: { ...headers, origin: 'http://127.0.0.1:4317' }, payload: { enabled: true, user: 'ou_person' } })).statusCode).toBe(401);
  const bootstrap = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers });
  const authorized = { ...headers, origin: 'http://127.0.0.1:4317', cookie: String(bootstrap.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': bootstrap.json().data.csrfToken };
  const bad = await app.inject({ method: 'POST', url: '/api/v1/autoloop/connections/feishu/save', headers: authorized, payload: { enabled: true, user: 'ou_person', key: 'secret' } });
  expect(bad.statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/api/v1/autoloop/connections/feishu/save', headers: authorized, payload: { enabled: true, user: 'ou_person' } })).statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: '/api/v1/autoloop/lifecycle', headers: authorized, payload: { action: 'arbitrary-command' } })).statusCode).toBe(400);
});
it('does not register connection credentials or lifecycle APIs in company mode', async () => {
  const app = buildServer({ runtimeMode: 'company', autoloopConnectionsService: service }); servers.push(app);
  expect((await app.inject({ method: 'GET', url: '/api/v1/autoloop/connections', headers })).statusCode).toBe(404);
});
