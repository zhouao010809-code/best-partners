import { expect, it, vi } from 'vitest';
import { createBrowserReadConsoleApi } from '../../src/client/api/client.js';

const id = '62b6b258-8469-45ac-ae2e-a3c6a46af160';
const path = '01图书馆/来自个人/原始 #资料.md';
const entry = { id, materialPath: path, title: '原始资料', createdAt: '2026-09-07T00:00:00Z', status: 'trashed', indexed: true };
const envelope = (data: unknown) => new Response(JSON.stringify({ data, version: 1 }));

it('retains the explicit deletion origin in a document preview request', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(envelope({ csrfToken: 'c'.repeat(43), runtimeMode: 'personal' })).mockResolvedValueOnce(envelope({ id, materialPath: path, title: entry.title, origin: 'queue', bytes: 512, referencedKnowledge: [], expiresAt: '2099-01-01T00:00:00Z' }));
  await createBrowserReadConsoleApi(fetcher).trash!.preview(path, 'queue');
  expect(fetcher).toHaveBeenLastCalledWith('/api/v1/trash/preview', expect.objectContaining({ body: JSON.stringify({ materialPath: path, origin: 'queue' }) }));
});

it('provides authenticated trash reads with encoded ids and cancellation', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(envelope({ items: [entry] })).mockResolvedValueOnce(envelope(entry));
  const api = createBrowserReadConsoleApi(fetcher); const signal = new AbortController().signal;
  expect(api.trash).toBeDefined();
  expect(await api.trash!.list(signal)).toEqual({ ok: true, value: { items: [entry] } });
  expect(fetcher).toHaveBeenLastCalledWith('/api/v1/trash', { method: 'GET', credentials: 'same-origin', signal });
  expect(await api.trash!.get('id /#', signal)).toEqual({ ok: true, value: entry });
  expect(fetcher).toHaveBeenLastCalledWith('/api/v1/trash/id%20%2F%23', { method: 'GET', credentials: 'same-origin', signal });
});

it('serializes only the explicit operation inputs and shares the CSRF bootstrap', async () => {
  const preview = { id, materialPath: path, title: entry.title, bytes: 512, referencedKnowledge: [], expiresAt: '2099-01-01T00:00:00Z' };
  const fetcher = vi.fn().mockResolvedValueOnce(envelope({ csrfToken: 'c'.repeat(43), runtimeMode: 'personal' }))
    .mockResolvedValueOnce(envelope(preview)).mockResolvedValue(envelope(entry));
  const api = createBrowserReadConsoleApi(fetcher); expect(api.trash).toBeDefined();
  expect(await api.trash!.preview(path)).toEqual({ ok: true, value: preview });
  await api.trash!.commit(id); await api.trash!.restore(id); await api.trash!.retry(id);
  expect(fetcher.mock.calls.slice(1).map(([url, init]) => [url, JSON.parse(init.body)])).toEqual([
    ['/api/v1/trash/preview', { materialPath: path }], ['/api/v1/trash/commit', { id }],
    [`/api/v1/trash/${id}/restore`, {}], [`/api/v1/trash/${id}/retry`, {}],
  ]);
  for (const [, init] of fetcher.mock.calls.slice(1)) expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': 'c'.repeat(43) } });
  expect(fetcher).toHaveBeenCalledTimes(5);
});

it('preserves server conflict codes and rejects malformed success envelopes', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'TRASH_NOT_FOUND', message: '该回收操作尚未登记', operationId: '01J7K5GABQH6HNCWN8RB9X56S3' } }), { status: 404 }))
    .mockResolvedValueOnce(envelope({ items: [{ ...entry, status: 'unknown-state' }] }));
  const api = createBrowserReadConsoleApi(fetcher); expect(api.trash).toBeDefined();
  expect(await api.trash!.get(id)).toMatchObject({ ok: false, code: 'TRASH_NOT_FOUND', state: { message: '该回收操作尚未登记' } });
  expect(await api.trash!.list()).toMatchObject({ ok: false, state: { status: 'validation-error' } });
});

it('previews deletion with cancellation and sends only the confirmed token through the authenticated endpoint', async () => {
  const token = '6e2553b8-5a80-41c6-858b-30f98e7a91c0';
  const preview = { id, token, materialPath: path, title: entry.title, bytes: 512, referencedKnowledge: [], expiresAt: '2099-01-01T00:00:00Z' };
  const deleted = { ...entry, status: 'deleted', deletedAt: '2026-09-07T02:00:00Z' };
  const fetcher = vi.fn().mockResolvedValueOnce(envelope({ csrfToken: 'c'.repeat(43), runtimeMode: 'personal' })).mockResolvedValueOnce(envelope(preview)).mockResolvedValueOnce(envelope(deleted));
  const api = createBrowserReadConsoleApi(fetcher); const signal = new AbortController().signal;
  expect(api.trash?.previewDelete).toBeTypeOf('function'); expect(api.trash?.delete).toBeTypeOf('function');
  expect(await api.trash!.previewDelete('id /#', signal)).toEqual({ ok: true, value: preview });
  expect(fetcher).toHaveBeenLastCalledWith('/api/v1/trash/id%20%2F%23/delete-preview', { method: 'POST', credentials: 'same-origin', signal, body: '{}', headers: { 'content-type': 'application/json', 'x-csrf-token': 'c'.repeat(43) } });
  expect(await api.trash!.delete(id, token)).toEqual({ ok: true, value: deleted });
  expect(fetcher).toHaveBeenLastCalledWith(`/api/v1/trash/${id}/delete`, expect.objectContaining({ method: 'POST', credentials: 'same-origin', body: JSON.stringify({ token }), headers: { 'content-type': 'application/json', 'x-csrf-token': 'c'.repeat(43) } }));
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('rejects a deletion preview without a valid confirmation token and retains deletion failure codes', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(envelope({ csrfToken: 'c'.repeat(43), runtimeMode: 'personal' }))
    .mockResolvedValueOnce(envelope({ id, materialPath: path, title: entry.title, bytes: 512, referencedKnowledge: [], expiresAt: '2099-01-01T00:00:00Z', token: 'invalid' }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'TRASH_BUSY', message: '正在核验本次删除', operationId: '01J7K5GABQH6HNCWN8RB9X56S3' } }), { status: 409 }));
  const api = createBrowserReadConsoleApi(fetcher); expect(api.trash?.previewDelete).toBeTypeOf('function');
  expect(await api.trash!.previewDelete(id)).toMatchObject({ ok: false, state: { status: 'validation-error' } });
  expect(await api.trash!.delete(id, '6e2553b8-5a80-41c6-858b-30f98e7a91c0')).toMatchObject({ ok: false, code: 'TRASH_BUSY', state: { message: '正在核验本次删除' } });
});

it('posts queue visibility without modifying material paths', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(envelope({ csrfToken: 'c'.repeat(43), runtimeMode: 'personal' })).mockResolvedValueOnce(envelope({ item: null }));
  const api = createBrowserReadConsoleApi(fetcher); expect(api.extractionQueue?.setVisibility).toBeDefined();
  await api.extractionQueue!.setVisibility!(path, true);
  expect(fetcher).toHaveBeenLastCalledWith('/api/v1/extraction-queue/visibility', expect.objectContaining({ method: 'POST', body: JSON.stringify({ materialPath: path, removed: true }) }));
});
