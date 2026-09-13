import { z } from 'zod';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_GROUP_BYTES, attachmentSchema, attachmentSelectionSchema, attachmentUploadQuerySchema, type Attachment, type AttachmentPages, type AttachmentArchiveRequest, type AttachmentArchiveResult } from '../../shared/api/attachments.js';
import { PublicApiError } from '../../shared/api/errors.js';
import { sha256Bytes } from '../vault/raw-bytes.js';
import { createAttachmentFiles } from './private-store.js';
import { parseAttachment } from './parser.js';
import { createAttachmentArchive, type AttachmentArchivePort } from './archive.js';

const storedSchema = z.object({ attachment: attachmentSchema, groupId: z.uuid(), archivePlan: z.unknown().optional() });
export type StoredAttachment = z.infer<typeof storedSchema>;
const parsedSchema = z.object({ parser: z.string(), pages: z.array(z.object({ page: z.number().int().positive(), text: z.string() })).max(2000) });
function fail(code: string, message: string, status = 409): never { throw new PublicApiError(code, message, status); }
export function createAttachmentService(input: { directory: string; archive?: AttachmentArchivePort; parserWorkerPath?: string | URL; now?: () => Date }) {
  const files = createAttachmentFiles(input.directory), records = new Map<string, StoredAttachment>(), now = input.now ?? (() => new Date());
  const running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let closed = false, parseQueue = Promise.resolve();
  for (const filename of files.list()) {
    try {
      const bytes = files.read(filename, 128 * 1024); if (!bytes) continue;
      const item = storedSchema.parse(JSON.parse(bytes.toString('utf8')));
      if (`${item.attachment.id}.json` !== filename) throw Error('ATTACHMENT_RECORD_ID_CHANGED');
      records.set(item.attachment.id, item);
    } catch { throw Error('ATTACHMENT_STORE_INVALID'); }
  }
  function record(id: string): StoredAttachment { if (!z.uuid().safeParse(id).success) fail('ATTACHMENT_ID_INVALID', '附件编号无效。', 400); const item = records.get(id); if (!item) fail('ATTACHMENT_NOT_FOUND', '没有找到附件，请重新添加。', 404); return item; }
  function persist(item: StoredAttachment) { item.attachment.updatedAt = now().toISOString(); files.put(`${item.attachment.id}.json`, Buffer.from(JSON.stringify(storedSchema.parse(item)))); records.set(item.attachment.id, item); }
  function get(id: string): Attachment { return structuredClone(record(id).attachment); }
  function readOriginal(id: string): { attachment: Attachment; bytes: Buffer } {
    const item = get(id), bytes = files.read(`${id}.bin`, ATTACHMENT_MAX_FILE_BYTES);
    if (!bytes || bytes.length !== item.size || sha256Bytes(bytes) !== item.sha256) fail('ATTACHMENT_CHANGED', '本地附件原件已变化，未继续读取或归档。');
    return { attachment: item, bytes };
  }
  function parsed(id: string) {
    const item = get(id); if (!['ready', 'needs-ocr'].includes(item.status)) fail('ATTACHMENT_NOT_READY', item.problem ?? '附件尚未解析完成。');
    readOriginal(id); const bytes = files.read(`${id}.text.json`, 16 * 1024 * 1024);
    if (!bytes) fail('ATTACHMENT_TEXT_MISSING', '派生文本缺失，请重新解析附件。');
    return { ...parsedSchema.parse(JSON.parse(bytes.toString('utf8'))), textRevision: sha256Bytes(bytes) };
  }
  function schedule(id: string) {
    if (closed || running.has(id)) return;
    const controller = new AbortController();
    const done = parseQueue.catch(() => {}).then(async () => {
      if (controller.signal.aborted || closed) return;
      try {
        const original = readOriginal(id);
        const result = await parseAttachment(original.bytes, original.attachment.mediaType, controller.signal, input.parserWorkerPath);
        if (controller.signal.aborted || closed) return;
        const item = record(id), text = parsedSchema.parse({ pages: result.pages, parser: result.parser });
        files.put(`${id}.text.json`, Buffer.from(JSON.stringify(text)));
        item.attachment.status = result.status; item.attachment.pageCount = result.pages.length;
        item.attachment.textBytes = result.pages.reduce((sum, page) => sum + Buffer.byteLength(page.text), 0); delete item.attachment.problem;
        if (result.problem) item.attachment.problem = result.problem;
        else if (result.status === 'needs-ocr') item.attachment.problem = 'PDF 没有可用的文本层，需要识别文字。原件已保留，当前版本尚未提供 OCR。';
        else if (result.pages.some(page => !page.text.trim())) item.attachment.problem = '部分页面没有可用文字，可能包含扫描页；回答只依据已解析文字。';
        persist(item);
      } catch {
        if (!controller.signal.aborted && !closed) { const item = record(id); item.attachment.status = 'failed'; item.attachment.problem = '本地解析未完成，原件保留，请重试。'; persist(item); }
      }
    }).finally(() => { if (running.get(id)?.controller === controller) running.delete(id); });
    parseQueue = done; running.set(id, { controller, done });
  }
  async function upload(request: { name: string; uploadId: string; groupId: string; bytes: Buffer }, signal?: AbortSignal): Promise<Attachment> {
    if (closed) fail('ATTACHMENT_CLOSED', '应用正在关闭，请重新打开后添加文件。'); signal?.throwIfAborted();
    const { name, uploadId, groupId } = attachmentUploadQuerySchema.parse({ name: request.name, uploadId: request.uploadId, groupId: request.groupId });
    const bytes = request.bytes;
    if (!Buffer.isBuffer(bytes) || !bytes.length) fail('ATTACHMENT_EMPTY', '请选择有内容的文件。', 400);
    if (bytes.length > ATTACHMENT_MAX_FILE_BYTES) fail('ATTACHMENT_TOO_LARGE', '单个文件超过 10 MiB，未接收。', 413);
    const sha256 = sha256Bytes(bytes), existing = records.get(uploadId);
    if (existing) {
      if (existing.groupId !== groupId || existing.attachment.name !== name || existing.attachment.sha256 !== sha256) fail('ATTACHMENT_UPLOAD_CONFLICT', '该上传编号已有不同内容，请重新选择文件。');
      readOriginal(uploadId); return get(uploadId);
    }
    if ([...records.values()].filter(item => item.groupId === groupId).reduce((sum, item) => sum + item.attachment.size, 0) + bytes.length > ATTACHMENT_MAX_GROUP_BYTES) fail('ATTACHMENT_GROUP_TOO_LARGE', '本批文件合计超过 16 MiB，请分批添加。', 413);
    const extension = name.split('.').at(-1)?.toLowerCase();
    if (!['pdf', 'md', 'txt'].includes(extension ?? '')) fail('ATTACHMENT_TYPE_UNSUPPORTED', '当前支持 PDF、Markdown 和 TXT。', 415);
    if (extension === 'pdf' && !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) fail('ATTACHMENT_TYPE_MISMATCH', '文件内容与 PDF 格式不符。', 415);
    const mediaType = extension === 'pdf' ? 'application/pdf' : extension === 'md' ? 'text/markdown' : 'text/plain', createdAt = now().toISOString();
    const attachment: Attachment = { id: uploadId, name, mediaType, size: bytes.length, sha256, status: 'processing', textBytes: 0, createdAt, updatedAt: createdAt };
    const duplicate = [...records.values()].find(item => item.attachment.sha256 === sha256 && item.attachment.archive?.state === 'archived');
    if (duplicate) attachment.duplicateOf = duplicate.attachment.id;
    files.put(`${uploadId}.bin`, bytes, true); signal?.throwIfAborted(); persist({ attachment, groupId }); schedule(uploadId); return get(uploadId);
  }
  function readPages(selection: { id: string; startPage?: number; endPage?: number }, signal?: AbortSignal): AttachmentPages {
    signal?.throwIfAborted(); const request = attachmentSelectionSchema.parse(selection), item = get(request.id), text = parsed(request.id);
    const totalPages = text.pages.length, startPage = request.startPage ?? 1, requestedEnd = request.endPage ?? totalPages;
    if (startPage > totalPages || requestedEnd < startPage || requestedEnd > totalPages) fail('ATTACHMENT_PAGE_RANGE', '页码范围不在这份附件内。', 400);
    const end = Math.min(requestedEnd, startPage + 49), pages: AttachmentPages['pages'] = []; let remaining = 120_000, truncated = end < requestedEnd;
    for (const page of text.pages.slice(startPage - 1, end)) {
      if (!remaining) { truncated = true; break; }
      const content = page.text.slice(0, remaining); if (content.length < page.text.length) truncated = true;
      pages.push({ page: page.page, text: content }); remaining -= content.length;
    }
    return { id: item.id, sha256: item.sha256, textRevision: text.textRevision, pages, startPage, endPage: pages.at(-1)?.page ?? startPage, totalPages, truncated };
  }
  function cancel(id: string): Attachment { const item = record(id); if (item.attachment.status === 'processing') { running.get(id)?.controller.abort(); item.attachment.status = 'cancelled'; item.attachment.problem = '已停止读取，原件已保留。'; persist(item); } return get(id); }
  async function retry(id: string): Promise<Attachment> { if (closed) fail('ATTACHMENT_CLOSED', '应用正在关闭。'); await running.get(id)?.done; readOriginal(id); const item = record(id); item.attachment.status = 'processing'; delete item.attachment.problem; persist(item); schedule(id); return get(id); }
  const archiver = createAttachmentArchive({ stagingDirectory: join(realpathSync(input.directory), 'staging'), ...(input.archive ? { port: input.archive } : {}), record, persist, list: () => [...records.values()], readOriginal, parsed, now });
  return {
    ready: async () => { for (const item of records.values()) if (item.attachment.status === 'processing') schedule(item.attachment.id); },
    upload, get, list: (ids?: string[]) => ids ? ids.map(get) : [...records.keys()].map(get).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), readOriginal, readPages, retry, cancel,
    waitForParsing: async (id: string) => { await running.get(id)?.done; },
    archive: (request: AttachmentArchiveRequest, signal?: AbortSignal): Promise<AttachmentArchiveResult> => { if (closed) fail('ATTACHMENT_CLOSED', '应用正在关闭。'); return archiver.archive(request, signal); },
    close: async () => { closed = true; for (const active of running.values()) active.controller.abort(); await Promise.allSettled([...running.values()].map(item => item.done)); await archiver.close(); }
  };
}
export type AttachmentService = ReturnType<typeof createAttachmentService>;
