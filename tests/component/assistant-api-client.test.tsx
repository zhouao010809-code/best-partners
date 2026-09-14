import { expect, it, vi } from 'vitest';
import { createBrowserReadConsoleApi } from '../../src/client/api/client.js';
const ok = (data: unknown) => new Response(JSON.stringify({ data, version: 1 }), { headers: { 'content-type': 'application/json' } });
const conversation = { id: '11c7a1d4-7cbf-4e92-9c64-ad175aa17d18', title: '问题', createdAt: '2026-09-09', updatedAt: '2026-09-09', status: 'running', providerId: 'deepseek', model: 'deepseek-v4-pro', scope: 'brain', messages: [] };
it('sends history search and cursor parameters with cancellation and reads the next-page marker', async () => {
  const fetcher = vi.fn().mockResolvedValue(ok({ conversations: [], hasMore: true, nextCursor: 'next' }));
  const signal = new AbortController().signal;
  expect(await createBrowserReadConsoleApi(fetcher).assistant!.history(signal, { search: '旧问题', cursor: 'prior', limit: 50 })).toEqual({ ok: true, value: { conversations: [], hasMore: true, nextCursor: 'next' } });
  const request = new URL(fetcher.mock.calls[0]![0] as string, 'http://localhost');
  expect(Object.fromEntries(request.searchParams)).toEqual({ search: '旧问题', cursor: 'prior', limit: '50' });
  expect(fetcher.mock.calls[0]![1]).toMatchObject({ signal });
});
it('sends assistant messages once with the existing CSRF transport and request id', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(ok({ csrfToken: 'a'.repeat(43) })).mockResolvedValueOnce(ok(conversation));
  const input = { clientRequestId: '447a699b-eae1-49d5-bd52-45a57f45e997', message: '找资料', providerId: 'deepseek', model: 'deepseek-v4-pro', scope: 'brain' as const };
  expect(await createBrowserReadConsoleApi(fetcher).assistant!.send(input)).toEqual({ ok: true, value: conversation });
  expect(fetcher).toHaveBeenNthCalledWith(2, '/api/v1/assistant/messages', expect.objectContaining({ method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'a'.repeat(43) }, body: JSON.stringify(input) }));
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('loads model catalogs with cancellation support and rejects malformed responses', async () => {
  const signal = new AbortController().signal; const fetcher = vi.fn().mockResolvedValueOnce(ok({ providers: [] })).mockResolvedValueOnce(ok({ providers: [{ id: 'bad' }] }));
  const service = createBrowserReadConsoleApi(fetcher).assistant!;
  expect(await service.providers(signal)).toEqual({ ok: true, value: { providers: [] } }); expect(fetcher).toHaveBeenCalledWith('/api/v1/assistant/providers', expect.objectContaining({ signal }));
  expect((await service.providers()).ok).toBe(false);
});
it('posts explicit stop and login requests to their own protected endpoints', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(ok({ csrfToken: 'a'.repeat(43) })).mockResolvedValueOnce(ok(conversation)).mockResolvedValueOnce(ok({ message: '已连接' }));
  const service = createBrowserReadConsoleApi(fetcher).assistant!;
  await service.stop(conversation.id); await service.login('deepseek');
  expect(fetcher).toHaveBeenNthCalledWith(2, `/api/v1/assistant/conversations/${conversation.id}/stop`, expect.objectContaining({ method: 'POST', body: '{}' }));
  expect(fetcher).toHaveBeenNthCalledWith(3, '/api/v1/assistant/providers/deepseek/login', expect.objectContaining({ method: 'POST', body: '{}' }));
});

it('confirms and cancels action plans with the same UUID as body and idempotency key', async () => {
  const requestId = '447a699b-eae1-49d5-bd52-45a57f45e997';
  const fetcher = vi.fn()
    .mockResolvedValueOnce(ok({ csrfToken: 'a'.repeat(43) }))
    .mockResolvedValueOnce(ok(conversation))
    .mockResolvedValueOnce(ok(conversation));
  const service = createBrowserReadConsoleApi(fetcher).assistant!;
  await service.confirmAction('73c8cd22-39f0-4574-a1b5-d2b034949543', requestId);
  await service.cancelAction('73c8cd22-39f0-4574-a1b5-d2b034949543', requestId);
  expect(fetcher.mock.calls[1]![0]).toBe('/api/v1/assistant/action-plans/73c8cd22-39f0-4574-a1b5-d2b034949543/confirm');
  expect(fetcher.mock.calls[1]![1]).toMatchObject({ headers: { 'x-csrf-token': 'a'.repeat(43), 'idempotency-key': requestId }, body: JSON.stringify({ clientRequestId: requestId }) });
  expect(fetcher.mock.calls[2]![0]).toBe('/api/v1/assistant/action-plans/73c8cd22-39f0-4574-a1b5-d2b034949543/cancel');
});

it('uploads a binary File with stable batch and upload ids through CSRF without JSON encoding', async () => {
  const id = '73c8cd22-39f0-4574-a1b5-d2b034949543'; const groupId = 'de5d2436-dd14-4f6c-9282-ea1ffde199c1';
  const attachment = { id, name: '资料.pdf', mediaType: 'application/pdf', size: 3, sha256: 'a'.repeat(64), textBytes: 0, status: 'processing', createdAt: '2026-09-10', updatedAt: '2026-09-10' };
  const fetcher = vi.fn().mockResolvedValueOnce(ok({ csrfToken: 'a'.repeat(43) })).mockResolvedValueOnce(ok({ attachment }));
  const file = new File(['pdf'], '资料.pdf', { type: 'application/pdf' });
  expect(await createBrowserReadConsoleApi(fetcher).attachments!.upload(file, id, groupId)).toEqual({ ok: true, value: { attachment } });
  const [url, init] = fetcher.mock.calls[1]!; expect(Object.fromEntries(new URL(url, 'http://localhost').searchParams)).toEqual({ name: file.name, uploadId: id, groupId });
  expect(init).toMatchObject({ method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': 'a'.repeat(43) } });
});

it('uses revision-bearing draft writes and exposes conflict codes without discarding the current draft', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(ok({ csrfToken: 'a'.repeat(43) })).mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'ASSISTANT_DRAFT_CONFLICT', message: '其他窗口已更新', operationId: '73c8cd22-39f0-4574-a1b5-d2b034949543' } }), { status: 409 }));
  const input = { expectedRevision: 3, active: true as const, text: '本窗口内容', attachments: [], groupId: 'de5d2436-dd14-4f6c-9282-ea1ffde199c1', scope: 'brain' as const };
  const result = await createBrowserReadConsoleApi(fetcher).assistantDrafts!.save('73c8cd22-39f0-4574-a1b5-d2b034949543', input);
  expect(result).toMatchObject({ ok: false, code: 'ASSISTANT_DRAFT_CONFLICT', state: { status: 'conflict' } });
  expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'PUT', body: JSON.stringify(input) }); expect(fetcher).toHaveBeenCalledTimes(2);
});

it('deletes a specific draft revision without declaring an empty JSON body', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(ok({ csrfToken: 'a'.repeat(43) })).mockResolvedValueOnce(ok({ deleted: true }));
  expect(await createBrowserReadConsoleApi(fetcher).assistantDrafts!.delete('73c8cd22-39f0-4574-a1b5-d2b034949543', 4)).toEqual({ ok: true, value: { deleted: true } });
  expect(fetcher.mock.calls[1]![0]).toMatch(/\?revision=4$/u);
  expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'DELETE', headers: { 'x-csrf-token': 'a'.repeat(43) } });
  expect(fetcher.mock.calls[1]![1].headers).not.toHaveProperty('content-type');
});
