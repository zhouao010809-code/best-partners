// Prevent accidental company exposure or bypassing the application's mutation boundary.
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildServer } from '../../src/server/app.js';
import { API_VERSION } from '../../src/shared/api/schemas.js';
import type { AutoloopService } from '../../src/shared/api/autoloop.js';
const servers: ReturnType<typeof buildServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(app => app.close())); });
const headers = { host: '127.0.0.1:4317' };
const task = { id: randomUUID(), title: '任务', instructions: '写结果', createdAt: new Date().toISOString(), status: 'queued' as const, summary: '', runId: null, cards: [] };
const service: AutoloopService = { choices: async () => ({ workspaces: [], agents: [], skills: [], notificationsAvailable: false }), list: async () => ({ connection: { connected: true }, tasks: [task] }), create: vi.fn(async () => ({ task })), detail: async () => ({ connection: { connected: true }, task, result: '完整结果', timeline: [] }), answer: async () => ({ ok: true }), cancel: async () => ({ ok: true }) };
it('registers the personal API with the standard envelope and no-store response', async () => {
  const app = buildServer({ autoloopService: service }); servers.push(app);
  const response = await app.inject({ method: 'GET', url: '/api/v1/autoloop/tasks', headers });
  expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ version: API_VERSION, data: { connection: { connected: true }, tasks: [task] } });
  expect(response.headers['cache-control']).toBe('no-store');
});
it('uses session/CSRF and validates trusted user instructions before dispatch', async () => {
  const app = buildServer({ autoloopService: service }); servers.push(app);
  const url = '/api/v1/autoloop/tasks'; const origin = 'http://127.0.0.1:4317';
  expect((await app.inject({ method: 'POST', url, headers: { ...headers, origin }, payload: {} })).statusCode).toBe(401);
  const bootstrap = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers });
  const cookie = String(bootstrap.headers['set-cookie']).split(';')[0]!;
  const authorized = { ...headers, origin, cookie, 'x-csrf-token': bootstrap.json().data.csrfToken };
  expect((await app.inject({ method: 'POST', url, headers: authorized, payload: { requestId: task.id, title: 'x', instructions: 'x', cwd: '/escape' } })).statusCode).toBe(400);
  const response = await app.inject({ method: 'POST', url, headers: authorized, payload: { requestId: task.id, title: 'x', instructions: 'x' } });
  expect(response.statusCode).toBe(200); expect(response.json().data.task.id).toBe(task.id);
});
it('does not expose Autoloop in company mode', async () => {
  const app = buildServer({ runtimeMode: 'company', autoloopService: service }); servers.push(app);
  expect((await app.inject({ method: 'GET', url: '/api/v1/autoloop/tasks', headers })).statusCode).toBe(404);
});
