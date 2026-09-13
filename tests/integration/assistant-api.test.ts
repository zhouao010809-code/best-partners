import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/server/app.js';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createIndexRepository } from '../../src/server/index/index-repository.js';
import { FakeVaultGateway } from '../../src/server/vault/FakeVaultGateway.js';
import type { AssistantRunInput } from '../../src/server/assistant/types.js';

const host = '127.0.0.1:4317'; const origin = `http://${host}`;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture(closeKernel = false) {
  const database = new Database(':memory:'); applyMigrations(database);
  const run = vi.fn(async (input: AssistantRunInput) => { input.emit({ type: 'text', text: '连接成功' }); });
  const gateway = Object.assign(new FakeVaultGateway({}), { openInObsidian: async () => {} });
  const finalStates: string[] = [];
  const app = buildServer({ assistantAdapters: [{ id: 'test', describe: async () => ({ id: 'test', name: 'Test', status: 'ready', models: [{ id: 'pro', name: 'Pro', reasoningEfforts: [] }] }), run }],
    ...(closeKernel ? { onClose: () => { for (const row of database.prepare('SELECT payload FROM assistant_conversations').all() as Array<{payload:string}>) finalStates.push(JSON.parse(row.payload).status); database.close(); } } : {}),
    readApi: { database, gateway, repository: createIndexRepository(database), currentIndexVersion: () => 1, indexScheduler: {
      requestFocusRefresh: async () => ({ generation: 1, outcome: 'succeeded', refresh: { status: 'ready', checked: 0, total: 0, version: 1 } }),
      snapshot: () => ({ state: { status: 'ready', version: 1, refreshedAt: '2026-09-09T00:00:00Z' }, refresh: { status: 'ready', checked: 0, total: 0, version: 1 } })
    } } });
  cleanup.push(async () => { await app.close(); if (database.open) database.close(); });
  const bootstrap = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: { host } });
  const headers = { host, origin, cookie: bootstrap.cookies[0]!.name + '=' + bootstrap.cookies[0]!.value, 'x-csrf-token': bootstrap.json().data.csrfToken };
  return { app, headers, run, finalStates };
}
it('protects AI calls with the existing origin/session/CSRF contract and validates messages', async () => {
  const f = await fixture(); const payload = { clientRequestId: randomUUID(), message: '只回复连接成功', providerId: 'test', model: 'pro', scope: 'brain' };
  expect((await f.app.inject({ method: 'POST', url: '/api/v1/assistant/messages', headers: { host, origin }, payload })).statusCode).toBe(401);
  expect((await f.app.inject({ method: 'POST', url: '/api/v1/assistant/messages', headers: { ...f.headers, 'x-csrf-token': 'bad' }, payload })).statusCode).toBe(403);
  expect((await f.app.inject({ method: 'POST', url: '/api/v1/assistant/messages', headers: f.headers, payload: { ...payload, unrestricted: true } })).statusCode).toBe(400);
  expect(f.run).not.toHaveBeenCalled();
  const response = await f.app.inject({ method: 'POST', url: '/api/v1/assistant/messages', headers: f.headers, payload });
  expect(response.statusCode).toBe(200);
  const id = response.json().data.id;
  await vi.waitFor(async () => { const result = await f.app.inject({ method: 'GET', url: `/api/v1/assistant/conversations/${id}`, headers: { host } }); expect(result.json().data.status).toBe('idle'); });
  expect(f.run).toHaveBeenCalledTimes(1);
  const history = await f.app.inject({ method: 'GET', url: '/api/v1/assistant/conversations', headers: { host } });
  expect(history.json().data.conversations).toHaveLength(1);
  const found = await f.app.inject({ method: 'GET', url: `/api/v1/assistant/conversations?${new URLSearchParams({ search: '连接成功', limit: '1' })}`, headers: { host } });
  expect(found.json().data).toMatchObject({ hasMore: false, conversations: [{ id }] });
  expect((await f.app.inject({ method: 'GET', url: '/api/v1/assistant/conversations?limit=101', headers: { host } })).statusCode).toBe(400);
  expect((await f.app.inject({ method: 'GET', url: '/api/v1/assistant/conversations?cursor=invalid', headers: { host } })).statusCode).toBe(400);
});
it('exposes provider choices without starting inference and returns unavailable cleanly without services', async () => {
  const f = await fixture();
  const response = await f.app.inject({ method: 'GET', url: '/api/v1/assistant/providers', headers: { host } });
  expect(response.json().data.providers[0]).toMatchObject({ id: 'test', status: 'ready' }); expect(f.run).not.toHaveBeenCalled();
  const empty = buildServer();
  expect((await empty.inject({ method: 'GET', url: '/api/v1/assistant/providers', headers: { host } })).statusCode).toBe(503);
  await empty.close();
});

it('stops and persists the active answer before closing the state kernel', async () => {
  const f = await fixture(true); f.run.mockImplementation(() => new Promise(() => {}));
  const response = await f.app.inject({ method: 'POST', url: '/api/v1/assistant/messages', headers: f.headers,
    payload: { clientRequestId: randomUUID(), message: 'test', providerId: 'test', model: 'pro', scope: 'brain' } });
  expect(response.statusCode).toBe(200);
  await f.app.close();
  expect(f.finalStates).toEqual(['stopped']);
  expect(f.run.mock.calls[0]?.[0].signal.aborted).toBe(true);
});
