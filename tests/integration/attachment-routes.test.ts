import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { buildServer } from '../../src/server/app.js';
import { createAttachmentService } from '../../src/server/attachments/service.js';
import { attachmentListResponseSchema, attachmentResponseSchema } from '../../src/shared/api/attachments.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'xiaozhao-attachment-http-')); cleanups.push(() => rm(directory, { recursive: true }));
  const service = createAttachmentService({ directory }); cleanups.push(() => service.close());
  const app = buildServer({ attachmentService: service }); cleanups.push(() => app.close());
  const bootstrap = await app.inject({ url: '/api/v1/bootstrap', headers: { host: '127.0.0.1:4317' } });
  const cookie = String(bootstrap.headers['set-cookie']).split(';')[0]!;
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', cookie, 'x-csrf-token': bootstrap.json().data.csrfToken as string };
  const uploadId = randomUUID();
  const url = `/api/v1/assistant/attachments?${new URLSearchParams({ name: '笔记.txt', uploadId, groupId: randomUUID() })}`;
  return { app, service, headers, uploadId, url };
}
it('uploads binary beyond the JSON limit and lists durable metadata without parsed text', async () => {
  const f = await fixture(), bytes = Buffer.alloc(1100 * 1024, 65);
  const response = await f.app.inject({ method: 'POST', url: f.url, headers: { ...f.headers, 'content-type': 'application/octet-stream' }, payload: bytes });
  expect(response.statusCode).toBe(200); expect(attachmentResponseSchema.parse(response.json()).data.attachment.id).toBe(f.uploadId);
  await f.service.waitForParsing(f.uploadId);
  const list = await f.app.inject({ url: '/api/v1/assistant/attachments', headers: f.headers });
  expect(attachmentListResponseSchema.parse(list.json()).data.attachments).toHaveLength(1); expect(list.body.length).toBeLessThan(2000);
  const original = await f.app.inject({ url: `/api/v1/assistant/attachments/${f.uploadId}/content`, headers: f.headers });
  expect(original.rawPayload).toEqual(bytes); expect(original.headers['content-disposition']).toContain('attachment;');
  expect(original.headers['x-content-type-options']).toBe('nosniff');
  const pages = await f.app.inject({ url: `/api/v1/assistant/attachments/${f.uploadId}/pages?startPage=1&endPage=1`, headers: f.headers });
  expect(pages.json().data).toMatchObject({ totalPages: 1, truncated: true });
});
it('retains mutation authentication and the previous JSON body limit', async () => {
  const f = await fixture();
  const denied = await f.app.inject({ method: 'POST', url: f.url, headers: { host: f.headers.host, origin: f.headers.origin, 'content-type': 'application/octet-stream' }, payload: Buffer.from('secret') });
  expect(denied.statusCode).toBe(401); expect(f.service.list()).toEqual([]);
  const json = await f.app.inject({ method: 'POST', url: '/api/v1/assistant/messages', headers: { ...f.headers, 'content-type': 'application/json' }, payload: JSON.stringify({ content: 'a'.repeat(1100 * 1024) }) });
  expect(json.statusCode).toBe(413);
});
it('bounds a streamed binary body before persisting an attachment', async () => {
  const f = await fixture();
  const response = await f.app.inject({ method: 'POST', url: f.url, headers: { ...f.headers, 'content-type': 'application/octet-stream' }, payload: Readable.from([Buffer.alloc(6 * 1024 * 1024), Buffer.alloc(5 * 1024 * 1024)]) });
  expect(response.statusCode).toBe(413); expect(f.service.list()).toEqual([]);
});
it('rejects arbitrary path IDs, invalid page ranges, and unsupported body types', async () => {
  const f = await fixture();
  const badId = await f.app.inject({ url: '/api/v1/assistant/attachments/not-a-file-id/content', headers: f.headers }); expect(badId.statusCode).toBe(400);
  const wrongType = await f.app.inject({ method: 'POST', url: f.url, headers: { ...f.headers, 'content-type': 'application/json' }, payload: '{}' }); expect(wrongType.statusCode).toBe(415);
  await f.app.inject({ method: 'POST', url: f.url, headers: { ...f.headers, 'content-type': 'application/octet-stream' }, payload: Buffer.from('one') }); await f.service.waitForParsing(f.uploadId);
  const badRange = await f.app.inject({ url: `/api/v1/assistant/attachments/${f.uploadId}/pages?startPage=2&endPage=1`, headers: f.headers }); expect(badRange.statusCode).toBe(400);
});
