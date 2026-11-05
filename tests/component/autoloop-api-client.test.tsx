import { expect, it, vi } from 'vitest';
import { createBrowserReadConsoleApi } from '../../src/client/api/client.js';
const ok = (data: unknown) => new Response(JSON.stringify({ version: 1, data }), { headers: { 'content-type': 'application/json' } });
const bootstrap = { csrfToken: 'a'.repeat(43), runtimeMode: 'personal' as const };
it('protects configuration and rule trigger writes with CSRF and preserves revision and request identity', async () => {
  const input = { revision: 'r1', document: { sources: {}, agents: {}, rules: [] }, disabledRules: [] };
  const fetcher = vi.fn().mockResolvedValueOnce(ok({ revision: 'r2', loaded: true, message: '已应用' })).mockResolvedValueOnce(ok({ event: 8, duplicate: false, routed: ['每日/整理'] }));
  const api = createBrowserReadConsoleApi(fetcher, bootstrap).autoloopManagement!;
  expect((await api.saveConfiguration(input)).ok).toBe(true);
  expect((await api.trigger('每日/整理', 'stable-id')).ok).toBe(true);
  expect(fetcher.mock.calls[0]).toEqual(['/api/v1/autoloop/manage/configuration', expect.objectContaining({ method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': bootstrap.csrfToken }, body: JSON.stringify(input) })]);
  expect(fetcher.mock.calls[1]).toEqual([`/api/v1/autoloop/manage/rules/${encodeURIComponent('每日/整理')}/trigger`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ id: 'stable-id' }) })]);
});
it('validates state responses and forwards pagination and abort signals', async () => {
  const fetcher = vi.fn().mockResolvedValue(ok({ connection: { connected: true }, runs: [] }));
  const signal = new AbortController().signal;
  expect((await createBrowserReadConsoleApi(fetcher).autoloopManagement!.state(24, signal)).ok).toBe(false);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/v1/autoloop/manage/state?before=24', expect.objectContaining({ signal }));
});
it('uses protected POST endpoints for credentials, probes and lifecycle without returning credentials', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(ok({ ok: true, restartRequired: true })).mockResolvedValueOnce(ok({ id: 'slack', ok: false, message: '未验证送达', checks: [] })).mockResolvedValueOnce(ok({ ok: true, message: '已启动' }));
  const api = createBrowserReadConsoleApi(fetcher, bootstrap).autoloopConnections!;
  const input = { enabled: true, url: 'https://hooks.slack.com/services/private-token' };
  expect((await api.save('slack', input)).ok).toBe(true); await api.probe('slack'); await api.lifecycle('start');
  expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/v1/autoloop/connections/slack/save', '/api/v1/autoloop/connections/slack/probe', '/api/v1/autoloop/lifecycle']);
  for (const call of fetcher.mock.calls) expect(call[1]).toMatchObject({ method: 'POST', headers: { 'x-csrf-token': bootstrap.csrfToken } });
});
