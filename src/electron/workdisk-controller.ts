import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { WorkdiskService } from '../server/workdisk/service.js';
import type { WorkdiskListRequest, WorkdiskPreview } from '../shared/workdisk.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value => {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
});
const relativePathSchema = z.string().min(1).max(4096).refine(value => !isAbsolute(value)
  && !/[\\\u0000-\u001f]/u.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
const kindSchema = z.enum(['video', 'audio', 'image', 'document', 'other']);
const listSchema = z.object({ query: z.string().max(1000).optional(), date: dateSchema.optional(), kind: kindSchema.optional(),
  plan: z.object({ terms: z.array(z.string().min(1).max(100)).max(12), startDate: dateSchema.optional(), endDate: dateSchema.optional(), kind: kindSchema.optional() }).strict().optional()
}).strict().optional();
const noteSchema = z.object({ title: z.string().trim().min(1).max(120).refine(value => !/[\\/\u0000-\u001f]/u.test(value) && value !== '.' && value !== '..'), body: z.string().max(250_000), date: dateSchema }).strict();
const selectedFilesSchema = z.array(z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes('\0'))).min(1).max(100);
const MEDIA: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aac': 'audio/aac', '.flac': 'audio/flac' };
const OPENABLE = new Set([...Object.keys(MEDIA), '.pdf', '.txt', '.md', '.markdown', '.csv', '.json', '.srt', '.vtt', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf', '.pages', '.numbers', '.key', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.mkv', '.avi', '.wmv', '.mpeg', '.mpg']);
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('输入不完整，请检查日期和文件名称。');
  return parsed.data;
}
async function safe<T>(action: () => Promise<T>, message: string): Promise<T> {
  try { return await action(); } catch { throw new Error(message); }
}

export function createDesktopWorkdisk(input: {
  service: Pick<WorkdiskService, 'status' | 'bind' | 'list' | 'importFiles' | 'createNote' | 'resolveFile' | 'preview'>;
  chooseDirectory(): Promise<string | undefined>;
  chooseFiles(): Promise<string[] | undefined>;
  openPath(path: string): Promise<string>;
}) {
  let picking = false;
  const tickets = new Map<string, { bindingId: string; path: string }>();
  async function pick<T>(action: () => Promise<T>): Promise<T> {
    if (picking) throw new Error('请先完成已打开的文件选择窗口。');
    picking = true;
    try { return await action(); } finally { picking = false; }
  }
  return {
    status: () => safe(() => input.service.status(), '无法读取工作盘连接，请重试。'),
    connect: () => pick(async () => {
      const directory = await safe(input.chooseDirectory, '无法打开文件选择窗口。');
      if (!directory) return null;
      const binding = await safe(() => input.service.bind(directory), '无法连接这个文件夹。请选择独立于知识库、可读写的本地文件夹。');
      tickets.clear();
      return binding;
    }),
    list: async (request?: unknown) => {
      const parsed = parse(listSchema, request);
      const checkedRequest: WorkdiskListRequest | undefined = parsed === undefined ? undefined : {
        ...(parsed.query === undefined ? {} : { query: parsed.query }),
        ...(parsed.date === undefined ? {} : { date: parsed.date }),
        ...(parsed.kind === undefined ? {} : { kind: parsed.kind }),
        ...(parsed.plan === undefined ? {} : { plan: {
          terms: parsed.plan.terms,
          ...(parsed.plan.startDate === undefined ? {} : { startDate: parsed.plan.startDate }),
          ...(parsed.plan.endDate === undefined ? {} : { endDate: parsed.plan.endDate }),
          ...(parsed.plan.kind === undefined ? {} : { kind: parsed.plan.kind })
        } })
      };
      return safe(() => input.service.list(checkedRequest), '无法读取工作盘，请检查文件夹是否已连接。');
    },
    importFiles: async (date: unknown) => {
      const validDate = parse(dateSchema, date);
      return pick(async () => {
        const files = await safe(input.chooseFiles, '无法打开文件选择窗口。');
        if (!files?.length) return null;
        const paths = parse(selectedFilesSchema, files);
        return safe(() => input.service.importFiles(paths, validDate), '文件未能收纳，请检查工作盘后重试。');
      });
    },
    importDroppedFiles: async (files: unknown, date: unknown) => {
      const paths = parse(selectedFilesSchema, files); const validDate = parse(dateSchema, date);
      return safe(() => input.service.importFiles(paths, validDate), '文件未能收纳，请检查工作盘后重试。');
    },
    createNote: async (request: unknown) => {
      const parsed = parse(noteSchema, request);
      return safe(() => input.service.createNote(parsed), '文档未能保存，请检查工作盘后重试；编辑内容仍保留。');
    },
    async preview(path: unknown): Promise<WorkdiskPreview> {
      const validPath = parse(relativePathSchema, path);
      const initialBinding = await safe(() => input.service.status(), '工作盘暂时不可用。');
      const preview = await safe(() => input.service.preview(validPath), '暂时无法预览这个文件，请刷新后重试。');
      const currentBinding = await safe(() => input.service.status(), '工作盘暂时不可用。');
      if (!initialBinding || currentBinding?.id !== initialBinding.id) throw new Error('工作盘已切换，请重新选择文件。');
      if (preview.kind !== 'media') return preview;
      if (!MEDIA[extname(validPath).toLowerCase()]) return { kind: 'unsupported' };
      const binding = currentBinding;
      const token = randomUUID();
      tickets.set(token, { bindingId: binding.id, path: validPath });
      if (tickets.size > 1000) tickets.delete(tickets.keys().next().value!);
      return { kind: 'media', url: `workdisk://file/${token}` };
    },
    async openFile(path: unknown) {
      const validPath = parse(relativePathSchema, path);
      if (!OPENABLE.has(extname(validPath).toLowerCase())) throw new Error('此处仅支持打开常见文档、图片、音频和视频。');
      await safe(async () => {
        const binding = await input.service.status();
        if (!binding) throw new Error('BINDING_UNAVAILABLE');
        const absolute = await input.service.resolveFile(validPath);
        if ((await input.service.status())?.id !== binding.id) throw new Error('BINDING_CHANGED');
        const error = await input.openPath(absolute);
        if (error) throw new Error(error);
      }, '无法打开这个文件，请检查文件是否仍然存在。');
    },
    async media(request: Request): Promise<Response> {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        const url = new URL(request.url);
        if (url.protocol !== 'workdisk:' || url.hostname !== 'file' || url.port || url.username || url.password || url.search || url.hash || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 });
        const ticket = tickets.get(url.pathname.slice(1));
        const binding = await input.service.status();
        if (!ticket || !binding || ticket.bindingId !== binding.id) return new Response(null, { status: 404 });
        const contentType = MEDIA[extname(ticket.path).toLowerCase()];
        if (!contentType) return new Response(null, { status: 404 });
        const absolute = await input.service.resolveFile(ticket.path);
        handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await handle.stat();
        const verified = await stat(await input.service.resolveFile(ticket.path));
        if (!info.isFile() || info.dev !== verified.dev || info.ino !== verified.ino) throw new Error('FILE_CHANGED');
        if ((await input.service.status())?.id !== ticket.bindingId) throw new Error('BINDING_CHANGED');
        const headers = new Headers({ 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' });
        let start = 0; let end = info.size - 1; const range = request.headers.get('range');
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
          if (!match || (!match[1] && !match[2])) {
            await handle.close(); handle = undefined;
            headers.set('Content-Range', `bytes */${info.size}`);
            return new Response(null, { status: 416, headers });
          }
          if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
          else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
            await handle.close(); handle = undefined;
            headers.set('Content-Range', `bytes */${info.size}`);
            return new Response(null, { status: 416, headers });
          }
          headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
        }
        headers.set('Content-Length', String(Math.max(0, end - start + 1)));
        if (request.method === 'HEAD' || info.size === 0) { await handle.close(); handle = undefined; return new Response(null, { status: range ? 206 : 200, headers }); }
        const file = handle; handle = undefined; let cursor = start; let closed = false;
        const close = async () => { if (!closed) { closed = true; await file.close(); } };
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              if (cursor > end) { await close(); controller.close(); return; }
              const buffer = new Uint8Array(Math.min(64 * 1024, end - cursor + 1));
              const { bytesRead } = await file.read(buffer, 0, buffer.length, cursor);
              if (!bytesRead) { await close(); controller.close(); return; }
              cursor += bytesRead; controller.enqueue(buffer.subarray(0, bytesRead));
            } catch { await close(); controller.error(new Error('文件读取中断。')); }
          },
          cancel: close
        });
        return new Response(body, { status: range ? 206 : 200, headers });
      } catch {
        await handle?.close().catch(() => undefined);
        return new Response(null, { status: 404 });
      }
    }
  };
}
