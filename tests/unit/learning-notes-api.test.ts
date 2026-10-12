import { expect, it, vi } from 'vitest';
import { createBrowserReadConsoleApi } from '../../src/client/api/client.js';
import { learningNoteSaveSchema, learningNoteQuerySchema } from '../../src/shared/api/learning-notes.js';
const id = '11111111-1111-4111-8111-111111111111';
const input = { expectedRevision: 0, title: '理解', body: '正文', selection: { path: '01图书馆/带空格的 路径.md', title: '文章', revision: 'a'.repeat(64), text: '选文' }, conversationId: id, messageId: id };
const note = { ...input, id, revision: 1, createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z' };
const { expectedRevision: _, ...saved } = note;
it('encodes note scope and sends a revision-bearing PUT through existing CSRF handling', async () => {
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ version: 1, data: { note: saved } }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const api = createBrowserReadConsoleApi(fetcher, { csrfToken: 'a'.repeat(43), runtimeMode: 'personal' });
  expect(await api.learningNotes!.save(id, input)).toEqual({ ok: true, value: { note: saved } });
  expect(fetcher.mock.calls[0]).toMatchObject([`/api/v1/learning-notes/${id}`, { method: 'PUT', headers: { 'x-csrf-token': 'a'.repeat(43) }, body: JSON.stringify(input) }]);
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ version: 1, data: { notes: [saved] } }), { status: 200 }));
  const signal = new AbortController().signal;
  expect((await api.learningNotes!.list({ path: input.selection.path, conversationId: id }, signal)).ok).toBe(true);
  const call = fetcher.mock.calls[1]!; const url = new URL(String(call[0]), 'http://localhost');
  expect(url.searchParams.get('path')).toBe(input.selection.path); expect(url.searchParams.get('conversationId')).toBe(id); expect(call[1]?.signal).toBe(signal);
});
it('rejects client vault fields and unscoped lists at the shared API boundary', () => {
  expect(learningNoteSaveSchema.safeParse({ ...input, vaultId: 'untrusted' }).success).toBe(false);
  expect(learningNoteQuerySchema.safeParse({}).success).toBe(false);
  expect(learningNoteQuerySchema.safeParse({ conversationId: id, vaultId: 'untrusted' }).success).toBe(false);
  expect(learningNoteSaveSchema.safeParse({ ...input, selection: { ...input.selection, path: '../outside.md' } }).success).toBe(false);
});
