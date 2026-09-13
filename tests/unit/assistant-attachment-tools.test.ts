import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createAssistantTools } from '../../src/server/assistant/attachment-tools.js';
import type { Attachment } from '../../src/shared/api/attachments.js';
import type { AttachmentService } from '../../src/server/attachments/service.js';
import type { ExtractionService } from '../../src/server/services/extraction-service.js';
import type { ReadService } from '../../src/server/services/read-service.js';
import type { AssistantEvent } from '../../src/server/assistant/types.js';

function fixture(message = '总结这个文件', archived = false, selectedRange = { startPage: 2, endPage: 2 }) {
  const id = randomUUID(), operationId = randomUUID(), path = '01图书馆/来自个人/2026-09/资料/资料.md';
  const attachment: Attachment = { id, name: '资料.pdf', mediaType: 'application/pdf', size: 20, sha256: 'a'.repeat(64), status: 'ready', pageCount: 3, textBytes: 30, createdAt: '2026-09-10', updatedAt: '2026-09-10' };
  const marker = (page: number) => `<!-- xiaozhao-page:${attachment.sha256}:${page} -->`;
  const markdown = `# 资料\n${marker(1)}\n第一页面不应读取\n${marker(2)}\n第二页面证据\n${marker(3)}\n第三页面不应读取`;
  const archive = { state: 'archived' as const, operationId, materialPath: path, target: '01图书馆/来自个人/2026-09/资料', indexed: true };
  if (archived) attachment.archive = archive;
  const port = {
    get: vi.fn(() => structuredClone(attachment)),
    readPages: vi.fn(async () => ({ id, sha256: attachment.sha256, textRevision: 'b'.repeat(64), pages: [{ page: 2, text: '第二页面证据' }], startPage: 2, endPage: 2, totalPages: 3, truncated: false })),
    archive: vi.fn(async () => { attachment.archive = archive; return { id, ...archive, duplicate: false }; })
  };
  const read = { getDocumentDetail: vi.fn(async () => ({ path, title: '资料', markdown, versionMarker: { rawSha256: 'c'.repeat(64) } })) };
  const prepareAssistant = vi.fn(async () => ({ token: randomUUID(), materialPath: path, title: '资料', messages: [{ role: 'user', content: '第二页面证据' }] }));
  const events: AssistantEvent[] = []; const controller = new AbortController();
  const tools = createAssistantTools({ readService: read as unknown as ReadService, extractionService: { prepareAssistant, acceptAssistant: vi.fn() } as unknown as ExtractionService,
    attachmentService: port as unknown as AttachmentService, attachments: [{ id, ...selectedRange }], userMessage: message, scope: 'current', model: 'test', signal: controller.signal, emit: event => events.push(event) });
  return { id, path, markdown, marker, port, read, events, prepareAssistant, controller, run: (name: string, value: unknown) => tools.find(tool => tool.name === name)!.execute(value) };
}

it('checks selected IDs and pages before reading original content', async () => {
  const f = fixture();
  await expect(f.run('read_attachment', { id: randomUUID(), page: 2 })).rejects.toMatchObject({ code: 'ASSISTANT_ATTACHMENT_SCOPE' });
  await expect(f.run('read_attachment', { id: f.id, page: 1 })).rejects.toMatchObject({ code: 'ASSISTANT_ATTACHMENT_SCOPE' });
  expect(f.port.readPages).not.toHaveBeenCalled();
});
it('returns an exact page citation and does not collide with vault source IDs', async () => {
  const f = fixture('总结', true);
  expect(await f.run('read_attachment', { id: f.id, page: 2 })).toMatchObject({ sourceId: 'S1', page: 2, text: '第二页面证据' });
  expect(f.events.find(event => event.type === 'source')).toMatchObject({ source: { attachmentId: f.id, evidence: [{ page: 2, excerpt: '第二页面证据' }] } });
  expect(await f.run('read_document', { path: f.path })).toMatchObject({ sourceId: 'S2' });
});
it('cannot use read_document to escape an archived attachment page selection', async () => {
  const f = fixture('总结', true);
  const value = await f.run('read_document', { path: f.path }) as { markdown: string; totalCharacters: number };
  expect(value.markdown).toContain('第二页面证据');
  expect(value.markdown).not.toContain('第一页面不应读取');
  expect(value.markdown).not.toContain('第三页面不应读取');
  await expect(f.run('read_document', { path: f.path, offset: value.totalCharacters })).rejects.toMatchObject({ code: 'ASSISTANT_ATTACHMENT_SCOPE' });
});
it('a reading turn cannot archive or prepare candidates even if a tool tries', async () => {
  const f = fixture('总结这个文件', true);
  await expect(f.run('archive_attachment', { id: f.id })).rejects.toMatchObject({ code: 'ASSISTANT_INTENT_REQUIRED' });
  await expect(f.run('prepare_attachment_extraction', { id: f.id })).rejects.toMatchObject({ code: 'ASSISTANT_INTENT_REQUIRED' });
  await expect(f.run('prepare_extraction', { path: f.path })).rejects.toMatchObject({ code: 'ASSISTANT_INTENT_REQUIRED' });
  expect(f.port.archive).not.toHaveBeenCalled(); expect(f.prepareAssistant).not.toHaveBeenCalled();
});
it('an explicit archive produces a real receipt without starting extraction', async () => {
  const f = fixture('把它归档');
  expect(await f.run('archive_attachment', { id: f.id })).toMatchObject({ state: 'archived', materialPath: f.path });
  expect(f.events.find(event => event.type === 'action')).toMatchObject({ action: { type: 'archive', materialPath: f.path, status: 'archived' } });
  expect(f.prepareAssistant).not.toHaveBeenCalled();
});
it('prepares selected pages only after source preservation and binds the full source revision', async () => {
  const f = fixture('把它提炼成知识候选');
  await f.run('prepare_attachment_extraction', { id: f.id });
  expect(f.port.archive).toHaveBeenCalledTimes(1);
  const request = f.prepareAssistant.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
  expect(request).toMatchObject({ materialPath: f.path, expectedSourceRawSha256: 'c'.repeat(64), sourceRange: { offset: f.markdown.indexOf(f.marker(2)), length: f.markdown.indexOf(f.marker(3)) - f.markdown.indexOf(f.marker(2)), label: '资料.pdf · 第 2–2 页', coversWholeSource: false } });
});
it('marks the source as fully covered only when every original page is selected', async () => {
  const f = fixture('提炼文件', false, { startPage: 1, endPage: 3 });
  await f.run('prepare_attachment_extraction', { id: f.id });
  expect(f.prepareAssistant.mock.calls[0]?.[0]).toMatchObject({ sourceRange: { coversWholeSource: true } });
});
it('does not start filesystem work after cancellation', async () => {
  const f = fixture('归档'); f.controller.abort();
  await expect(f.run('archive_attachment', { id: f.id })).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.port.archive).not.toHaveBeenCalled();
});
it('does not archive or prepare blank selected pages from an otherwise readable PDF', async () => {
  const f = fixture('提炼这个文件', true);
  f.port.readPages.mockImplementation(async () => ({ id: f.id, sha256: 'a'.repeat(64), textRevision: 'b'.repeat(64), pages: [{ page: 2, text: '  \n' }], startPage: 2, endPage: 2, totalPages: 3, truncated: false }));
  await expect(f.run('prepare_attachment_extraction', { id: f.id })).rejects.toMatchObject({ code: 'ATTACHMENT_SELECTION_EMPTY' });
  await expect(f.run('prepare_extraction', { path: f.path })).rejects.toMatchObject({ code: 'ATTACHMENT_SELECTION_EMPTY' });
  expect(f.port.archive).not.toHaveBeenCalled();
  expect(f.prepareAssistant).not.toHaveBeenCalled();
});
