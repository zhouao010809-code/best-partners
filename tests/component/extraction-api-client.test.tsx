import { expect, it, vi } from 'vitest';
import { createBrowserReadConsoleApi } from '../../src/client/api/client.js';
const ok = (data: unknown) => new Response(JSON.stringify({ data, version: 1 }), { headers: { 'content-type': 'application/json' } });
const settings = { available: true, configured: true, providerHost: 'api.deepseek.com', model: 'deepseek-v4-flash' };

it('protects key saving with bootstrap + CSRF, puts it only in the POST body and never auto-retries', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(ok({ csrfToken: 'c'.repeat(43), runtimeMode: 'personal' })).mockResolvedValueOnce(ok(settings));
  const api = createBrowserReadConsoleApi(fetcher);
  expect(api.deepSeek).toBeDefined();
  const result = await api.deepSeek!.setKey('sk-fixture-only');
  expect(result).toEqual({ ok: true, value: settings });
  expect(fetcher).toHaveBeenNthCalledWith(2, '/api/v1/deepseek/key', expect.objectContaining({ method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': 'c'.repeat(43) }, body: JSON.stringify({ apiKey: 'sk-fixture-only' }) }));
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('loads source-filtered saved results with encoded paths and abort support', async () => {
  const fetcher = vi.fn().mockResolvedValue(ok({ items: [] })); const signal = new AbortController().signal;
  const api = createBrowserReadConsoleApi(fetcher); expect(api.extraction).toBeDefined();
  expect(await api.extraction!.list('01图书馆/文章 #1.md', signal)).toEqual({ ok: true, value: { items: [] } });
  expect(fetcher).toHaveBeenCalledWith('/api/v1/extractions?materialPath=01%E5%9B%BE%E4%B9%A6%E9%A6%86%2F%E6%96%87%E7%AB%A0+%231.md', expect.objectContaining({ method: 'GET', signal }));
});

it('rejects a secret-bearing model status response instead of exposing it', async () => {
  const api = createBrowserReadConsoleApi(vi.fn().mockResolvedValue(ok({ ...settings, apiKey: 'should-not-return' })));
  expect(api.deepSeek).toBeDefined();
  const result = await api.deepSeek!.get();
  expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('should-not-return');
});

it('reads queue summaries and paginated history with encoded filters and no bootstrap writes', async () => {
  const counts = { pending: 0, generating: 0, ready: 0, unfinished: 0 };
  const fetcher = vi.fn().mockResolvedValueOnce(ok({ items: [], counts })).mockResolvedValueOnce(ok({ items: [] }));
  const api = createBrowserReadConsoleApi(fetcher); const signal = new AbortController().signal;
  expect(await api.extractionQueue!.list({ view: 'ready', title: '标题 #1', limit: 40 }, signal)).toEqual({ ok: true, value: { items: [], counts } });
  expect(await api.extractionQueue!.history({ materialPath: '01图书馆/文件 #1.md', limit: 10 }, signal)).toEqual({ ok: true, value: { items: [] } });
  expect(fetcher).toHaveBeenNthCalledWith(1, '/api/v1/extraction-queue?view=ready&title=%E6%A0%87%E9%A2%98+%231&limit=40', expect.objectContaining({ method: 'GET', signal }));
  expect(fetcher).toHaveBeenNthCalledWith(2, '/api/v1/extraction-history?materialPath=01%E5%9B%BE%E4%B9%A6%E9%A6%86%2F%E6%96%87%E4%BB%B6+%231.md&limit=10', expect.objectContaining({ method: 'GET', signal }));
});

it('rejects a malformed summary rather than labelling it as pending', async () => {
  const api = createBrowserReadConsoleApi(vi.fn().mockResolvedValue(ok({ items: [], counts: { pending: 'unknown' } })));
  expect((await api.extractionQueue!.list({})).ok).toBe(false);
});

it('verifies only the saved configuration with explicit CSRF POST and keeps failure feedback distinct', async () => {
  const verified = { ...settings, verification: { status: 'failed', checkedAt: '2026-09-09T03:00:00.000Z', message: 'DeepSeek 账户余额不足，请补充余额后重新验证。' } };
  const fetcher = vi.fn().mockResolvedValueOnce(ok({ csrfToken: 'c'.repeat(43), runtimeMode: 'personal' })).mockResolvedValueOnce(ok(verified));
  const api = createBrowserReadConsoleApi(fetcher);
  expect(await api.deepSeek!.verifyConnection!()).toEqual({ ok: true, value: verified });
  expect(fetcher).toHaveBeenNthCalledWith(2, '/api/v1/deepseek/verify', expect.objectContaining({ method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': 'c'.repeat(43) }, body: '{}' }));
  expect(fetcher).toHaveBeenCalledTimes(2);
});
