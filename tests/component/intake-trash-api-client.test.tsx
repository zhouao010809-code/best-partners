import { expect, it, vi } from 'vitest';
import { createBrowserReadConsoleApi } from '../../src/client/api/client.js';
const id = '12345678-1234-4123-8123-123456789abc';
const entry = { id, name: '资料 #1', title: '资料 #1', kind: 'directory', bytes: 20, fileCount: 2, createdAt: '2026-09-07T00:00:00.000Z', status: 'trashed' };
const envelope = (data: unknown) => new Response(JSON.stringify({ version: 1, data }));
it('exposes separate packet endpoints and retains authenticated explicit operation ids', async () => {
  const fetcher = vi.fn().mockImplementation(async (url: string) => url.endsWith('bootstrap') ? envelope({ csrfToken: 'c'.repeat(43), runtimeMode: 'personal' })
    : url.endsWith('/preview') ? envelope({ id, name: entry.name, title: entry.title, kind: entry.kind, bytes: 20, fileCount: 2, expiresAt: '2099-01-01T00:00:00.000Z' }) : envelope(entry));
  const api = createBrowserReadConsoleApi(fetcher); expect(api.intakeTrash).toBeDefined();
  const signal = new AbortController().signal;
  expect((await api.intakeTrash!.preview(entry.name, signal)).ok).toBe(true);
  await api.intakeTrash!.commit(id); await api.intakeTrash!.restore(id); await api.intakeTrash!.retry(id);
  expect(fetcher.mock.calls.slice(1).map(([url, init]) => [url, JSON.parse(init.body)])).toEqual([
    ['/api/v1/intake-trash/preview', { name: entry.name }], [`/api/v1/intake-trash/${id}/commit`, {}],
    [`/api/v1/intake-trash/${id}/restore`, {}], [`/api/v1/intake-trash/${id}/retry`, {}]
  ]);
  for (const [, init] of fetcher.mock.calls.slice(1)) expect(init).toMatchObject({ headers: { 'x-csrf-token': 'c'.repeat(43) }, credentials: 'same-origin' });
  await api.intakeTrash!.get('a /#', signal);
  expect(fetcher).toHaveBeenLastCalledWith('/api/v1/intake-trash/a%20%2F%23', { method: 'GET', credentials: 'same-origin', signal });
});
it('preserves not-found codes needed to resolve uncertain submissions', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'INTAKE_TRASH_NOT_FOUND', message: '未登记', operationId: '01J7K5GABQH6HNCWN8RB9X56S3' } }), { status: 404 }));
  const api = createBrowserReadConsoleApi(fetcher); expect(api.intakeTrash).toBeDefined();
  expect(await api.intakeTrash!.get(id)).toMatchObject({ ok: false, code: 'INTAKE_TRASH_NOT_FOUND' });
});
