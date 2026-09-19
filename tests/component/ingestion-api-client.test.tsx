import { expect, it, vi } from 'vitest';
import { createBrowserReadConsoleApi } from '../../src/client/api/client.js';
const envelope = (data: unknown) => new Response(JSON.stringify({ data, version: 1 }), { headers: { 'content-type': 'application/json' } });
const id = 'e52917bc-a9df-482f-aae8-8c4b6da4301d';
it('exposes ingestion reads, encodes match queries and preserves cancellation', async () => {
  const fetcher = vi.fn().mockResolvedValue(envelope({ items: [] }));
  const api = createBrowserReadConsoleApi(fetcher); const signal = new AbortController().signal;
  expect(api.ingestion).toBeDefined();
  expect(await api.ingestion!.matches(id, 'candidate-1', '标题 #1', signal)).toEqual({ ok: true, value: { items: [] } });
  expect(fetcher).toHaveBeenCalledWith(`/api/v1/ingestion/reviews/${id}/matches?candidateId=candidate-1&search=%E6%A0%87%E9%A2%98+%231`, expect.objectContaining({ method: 'GET', signal }));
});
it('confirms a durable preview id once with CSRF and validates batch response', async () => {
  const batch = { id, runId: id, status: 'committed', indexed: false, createdAt: '2026-09-07T00:00:00Z', knowledgePaths: ['02知识库/知识.md'], pendingCount: 1, sourceStatus: '部分入库' };
  const fetcher = vi.fn().mockResolvedValueOnce(envelope({ csrfToken: 'c'.repeat(43), runtimeMode: 'personal' })).mockResolvedValueOnce(envelope(batch));
  const api = createBrowserReadConsoleApi(fetcher);
  expect(api.ingestion).toBeDefined();
  expect(await api.ingestion!.commit(id)).toEqual({ ok: true, value: batch });
  expect(fetcher).toHaveBeenLastCalledWith('/api/v1/ingestion/commit', expect.objectContaining({ method: 'POST', body: JSON.stringify({ id }), headers: { 'content-type': 'application/json', 'x-csrf-token': 'c'.repeat(43) } }));
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('keeps the ingestion error code so a missing batch can be distinguished from a lost response', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'BATCH_NOT_FOUND', message: '本批尚未开始写入', operationId: '01J7K5GABQH6HNCWN8RB9X56S3' } }), { status: 404 }));
  const result = await createBrowserReadConsoleApi(fetcher).ingestion!.batch(id);
  expect(result).toMatchObject({ ok: false, code: 'BATCH_NOT_FOUND', state: { message: '本批尚未开始写入' } });
});
it('requests a recovery source choice without resolving the batch', async () => {
  const data = { id, batchId: id, expiresAt: '2099-01-01T00:00:00Z', files: [], sourceChoice: 'preserved', hasPreservedSource: true };
  const fetcher = vi.fn().mockResolvedValueOnce(envelope({ csrfToken: 'c'.repeat(43), runtimeMode: 'personal' })).mockResolvedValueOnce(envelope(data));
  const result = await createBrowserReadConsoleApi(fetcher).ingestion!.recoveryPreview(id, 'preserved');
  expect(result).toEqual({ ok: true, value: data });
  expect(fetcher).toHaveBeenLastCalledWith(`/api/v1/ingestion/batches/${id}/recovery-preview`, expect.objectContaining({ body: JSON.stringify({ sourceChoice: 'preserved' }) }));
});
it('sends only explicitly chosen replacement paths in a recovery preview request', async () => {
  const data = { id, batchId: id, expiresAt: '2099-01-01T00:00:00Z', files: [], sourceChoice: 'current', hasPreservedSource: false };
  const fetcher = vi.fn().mockResolvedValueOnce(envelope({ csrfToken: 'c'.repeat(43), runtimeMode: 'personal' })).mockResolvedValueOnce(envelope(data));
  const newTargets = { '02知识库/09学习/旧笔记.md': '02知识库/09学习/核对后的新笔记.md' };
  await createBrowserReadConsoleApi(fetcher).ingestion!.recoveryPreview(id, undefined, newTargets);
  expect(fetcher).toHaveBeenLastCalledWith(`/api/v1/ingestion/batches/${id}/recovery-preview`, expect.objectContaining({ body: JSON.stringify({ newTargets }) }));
});
