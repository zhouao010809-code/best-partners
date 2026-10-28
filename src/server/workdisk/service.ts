import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { WorkdiskBinding, WorkdiskFile, WorkdiskImportOptions, WorkdiskImportResult, WorkdiskKind, WorkdiskListRequest, WorkdiskPreview, WorkdiskSnapshot } from '../../shared/workdisk.js';
import { assertRoot, contained, directory, problem, readBounded, regularFile, safeRelative, sameIdentity, type FileIdentity } from './paths.js';
import { copyExclusive } from './publication.js';
import type { WorkdiskContentNamer } from './content-namer.js';

const TEXT_LIMIT = 512 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_FILES = 2_000;
const TEXT_SCAN_LIMIT = 32 * 1024 * 1024;
const NAMING_INPUT_LIMIT = 20 * 1024 * 1024;
const NAMING_SHUTDOWN_REASON = '应用正在关闭，本次已按原名保存。';
const textExtensions = new Set(['.md', '.markdown', '.txt', '.csv', '.json', '.srt', '.vtt', '.log', '.yaml', '.yml']);
const kinds = z.enum(['video', 'audio', 'image', 'document', 'other']);
const category: Record<WorkdiskKind, string> = { video: '视频', audio: '音频', image: '图片', document: '文档', other: '其他' };
const imageTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' };
function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number(value.slice(0, 4)) >= 1900 && Number(value.slice(0, 4)) <= 9999
    && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}
const dateSchema = z.string().refine(validDate);
const planSchema = z.object({ terms: z.array(z.string().trim().min(1).max(100)).max(12), startDate: dateSchema.optional(), endDate: dateSchema.optional(), kind: kinds.optional() }).strict();
const requestSchema = z.object({ query: z.string().max(1000).optional(), plan: planSchema.optional(), date: dateSchema.optional(), kind: kinds.optional() }).strict();
const storedSchema = z.object({ id: z.uuid(), rootPath: z.string().min(1), displayName: z.string(), connectedAt: z.string(), dev: z.number(), ino: z.number() }).strict();
type StoredBinding = z.infer<typeof storedSchema>;
const noteSchema = z.object({ title: z.string().trim().min(1).max(120), body: z.string().max(250_000), date: dateSchema }).strict();
const importOptionsSchema = z.object({ nameFromContent: z.boolean().optional() }).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) throw problem('填写的内容或日期无效，请检查后重试。'); return result.data;
}
function fileKind(name: string): WorkdiskKind {
  const extension = extname(name).toLowerCase();
  if (['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv'].includes(extension)) return 'video';
  if (['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus'].includes(extension)) return 'audio';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.heic', '.svg', '.bmp', '.tiff'].includes(extension)) return 'image';
  if (textExtensions.has(extension) || ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pages', '.numbers', '.key'].includes(extension)) return 'document';
  return 'other';
}
function localDate(value: Date): string { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`; }
function fileRecord(path: string, info: { size: number; mtime: Date }): WorkdiskFile {
  return { path, name: basename(path), kind: fileKind(path), size: info.size, modifiedAt: info.mtime.toISOString(), date: path.split('/').slice(0, -1).find(validDate) ?? localDate(info.mtime) };
}
function publicBinding(binding: StoredBinding): WorkdiskBinding { const { dev: _dev, ino: _ino, ...result } = binding; return result; }
function normalize(value: string): string { return value.normalize('NFKC').toLocaleLowerCase(); }
function snippet(text: string, terms: string[]): string {
  const normalized = normalize(text); const positions = terms.map(term => normalized.indexOf(term)).filter(index => index >= 0);
  const start = Math.max(0, Math.min(...positions) - 45); return `${start ? '…' : ''}${text.slice(start, start + 200).replace(/\s+/gu, ' ')}${text.length > start + 200 ? '…' : ''}`;
}
function safeName(name: string): string {
  if (typeof name !== 'string' || !name.trim() || Buffer.byteLength(name) > 220 || /[\\/:\x00-\x1f]/u.test(name) || name.startsWith('.') || name.endsWith('.')) throw problem('文件名不能包含路径或特殊控制字符。');
  return name;
}

function namingTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value.normalize('NFKC').trim();
  if (!title || [...title].length > 60 || Buffer.byteLength(title) > 180 || /^[.]/u.test(title) || /[. ]$/u.test(title)
    || /[\\/:*?"<>|\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u.test(title)
    || /\.[a-z0-9]{1,12}$/iu.test(title) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(title)) return undefined;
  return title;
}
async function verifySource(source: string, handle: Awaited<ReturnType<typeof open>>, expected: Stats): Promise<void> {
  const after = await handle.stat(); const current = await lstat(source);
  if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(expected, current) || !sameIdentity(expected, after)
    || after.size !== expected.size || after.mtimeMs !== expected.mtimeMs || after.ctimeMs !== expected.ctimeMs) {
    throw problem('读取或命名期间原文件发生变化，请重新导入。');
  }
}
async function nameContent(namer: WorkdiskContentNamer, input: Parameters<WorkdiskContentNamer>[0], signal: AbortSignal): Promise<Awaited<ReturnType<WorkdiskContentNamer>>> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    // A provider may ignore its signal. Stop awaiting it without cancelling the authorized file copies.
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return namer(input, signal); }), cancelled]);
  } finally { signal.removeEventListener('abort', abort); }
}

export function createWorkdiskService(config: { stateDirectory: string; protectedRoots: string[]; contentNamer?: WorkdiskContentNamer }) {
  let loaded = false; let binding: StoredBinding | null = null; let stateRoot: string | undefined;
  let loading: Promise<StoredBinding | null> | undefined;
  let closing = false;
  const namingShutdown = new AbortController();
  let tail: Promise<unknown> = Promise.resolve();
  function exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(problem('应用正在关闭，请重新打开后再保存。'));
    const operation = tail.then(action); tail = operation.catch(() => undefined); return operation;
  }
  async function state(): Promise<string> {
    if (stateRoot) return stateRoot;
    await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
    if ((await lstat(config.stateDirectory)).isSymbolicLink()) throw problem('工作盘设置目录无法使用。');
    stateRoot = await realpath(config.stateDirectory); return stateRoot;
  }
  async function load(): Promise<StoredBinding | null> {
    if (loaded) return binding;
    if (loading) return loading;
    loading = readStored();
    try { return await loading; } finally { loading = undefined; }
  }
  async function readStored(): Promise<StoredBinding | null> {
    const root = await state(); const path = join(root, 'workdisk.json');
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw problem('invalid');
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { binding = storedSchema.parse(JSON.parse(await handle.readFile('utf8'))); }
      finally { await handle.close(); }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw problem('工作盘连接记录无法读取，请重新连接文件夹。');
    }
    loaded = true; return binding;
  }
  async function active(): Promise<StoredBinding> {
    const current = await load(); if (!current) throw problem('请先连接一个工作盘文件夹。');
    await assertRoot(current.rootPath, current); return current;
  }
  async function persist(value: StoredBinding): Promise<void> {
    const root = await state(); const temporary = join(root, `.workdisk-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, join(root, 'workdisk.json'));
    } finally { await unlink(temporary).catch(() => undefined); }
    binding = value; loaded = true;
  }
  async function publish(current: StoredBinding, name: string, date: string, fill: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>): Promise<WorkdiskFile> {
    safeName(name);
    const parts = [date, category[fileKind(name)]]; const dir = await directory(current.rootPath, parts, current, true);
    const temp = join(dir, `.workdisk-${randomUUID()}.tmp`); let owned: FileIdentity | undefined;
    try {
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { owned = await handle.stat(); await fill(handle); await handle.sync(); }
      finally { await handle.close(); }
      await directory(current.rootPath, parts, current);
      const tempInfo = await lstat(temp); if (!sameIdentity(owned, tempInfo) || tempInfo.isSymbolicLink()) throw problem('保存位置已改变，请刷新后重试。');
      const ext = extname(name); const stem = name.slice(0, name.length - ext.length);
      for (let number = 0; number < 10_000; number++) {
        const filename = number ? `${stem} (${number})${ext}` : name; const target = join(dir, filename);
        let publishedIdentity = owned;
        try {
          try { await link(temp, target); }
          catch (error) {
            if (!(error instanceof Error && 'code' in error && ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'].includes(String(error.code)))) throw error;
            publishedIdentity = await copyExclusive(temp, target, owned, () => directory(current.rootPath, parts, current));
          }
        }
        catch (error) { if (error instanceof Error && 'code' in error && error.code === 'EEXIST') continue; throw error; }
        const path = [...parts, filename].join('/'); await regularFile(current.rootPath, path, current);
        const result = await lstat(target); if (!sameIdentity(publishedIdentity, result)) throw problem('文件保存结果无法确认，请刷新工作盘查看。');
        return fileRecord(path, result);
      }
      throw problem('同名文件过多，请更换文件名后重试。');
    } finally {
      if (owned) { const info = await lstat(temp).catch(() => undefined); if (info && sameIdentity(owned, info) && !info.isSymbolicLink()) await unlink(temp); }
    }
  }
  return {
    async close(): Promise<void> { closing = true; namingShutdown.abort(); await tail; },
    async status(): Promise<WorkdiskBinding | null> { const current = await load(); return current ? publicBinding(current) : null; },
    bind(selectedPath: string): Promise<WorkdiskBinding> { return exclusive(async () => {
      // A pending status read must finish before replacing the remembered root.
      // An explicit folder choice also repairs a damaged connection record.
      await load().catch(() => null);
      if (typeof selectedPath !== 'string' || !isAbsolute(selectedPath)) throw problem('请选择一个本地文件夹。');
      const before = await lstat(selectedPath); if (before.isSymbolicLink() || !before.isDirectory()) throw problem('请选择普通文件夹，不能使用快捷链接。');
      const rootPath = await realpath(selectedPath); const info = await lstat(rootPath);
      if (!sameIdentity(before, info)) throw problem('文件夹发生变化，请重新选择。');
      for (const path of [...config.protectedRoots, await state()]) {
        const protectedRoot = await realpath(path);
        if (contained(rootPath, protectedRoot) || contained(protectedRoot, rootPath)) throw problem('工作盘需要使用独立文件夹，不能与知识库或应用设置目录重叠。');
      }
      const current: StoredBinding = { id: randomUUID(), rootPath, displayName: basename(rootPath), connectedAt: new Date().toISOString(), dev: info.dev, ino: info.ino };
      await persist(current); return publicBinding(current);
    }); },
    async list(input: WorkdiskListRequest = {}): Promise<WorkdiskSnapshot> {
      const request = parse(requestSchema, input); const current = await load();
      const snapshot: WorkdiskSnapshot = { binding: current ? publicBinding(current) : null, files: [], scannedAt: new Date().toISOString(), truncated: false, skippedCount: 0 };
      if (!current) return snapshot;
      await assertRoot(current.rootPath, current);
      if (request.plan?.startDate && request.plan.endDate && request.plan.startDate > request.plan.endDate) throw problem('开始日期不能晚于结束日期。');
      const terms = (request.plan ? request.plan.terms : (request.query?.trim().split(/\s+/u).filter(Boolean) ?? [])).map(normalize);
      let entries = 0; let readBytes = 0;
      const pending: string[][] = [[]];
      while (pending.length && !snapshot.truncated) {
        const parts = pending.shift()!;
        const dir = await directory(current.rootPath, parts, current);
        let children;
        try { children = await readdir(dir, { withFileTypes: true }); }
        catch { snapshot.skippedCount++; continue; }
        children.sort((a, b) => b.name.localeCompare(a.name, 'zh-CN', { numeric: true }));
        for (const child of children) {
          if (++entries > MAX_ENTRIES) { snapshot.truncated = true; break; }
          if (child.name.startsWith('.')) continue;
          if (child.isSymbolicLink()) { snapshot.skippedCount++; continue; }
          if (child.isDirectory()) { if (parts.length < 15) pending.push([...parts, child.name]); else snapshot.skippedCount++; continue; }
          if (!child.isFile()) { snapshot.skippedCount++; continue; }
          try {
            const path = [...parts, child.name].join('/'); const target = await regularFile(current.rootPath, path, current); const info = await lstat(target);
            const file = fileRecord(path, info); const kind = request.kind ?? request.plan?.kind;
            if ((request.date && file.date !== request.date) || (kind && file.kind !== kind)
              || (request.plan?.startDate && file.date < request.plan.startDate) || (request.plan?.endDate && file.date > request.plan.endDate)) continue;
            if (terms.length) {
              if (terms.some(term => normalize(file.name).includes(term))) file.matchedBy = 'name';
              else if (terms.some(term => normalize(path).includes(term))) file.matchedBy = 'path';
              else if (textExtensions.has(extname(path).toLowerCase())) {
                if (readBytes >= TEXT_SCAN_LIMIT) { snapshot.skippedCount++; continue; }
                const content = await readBounded(current.rootPath, path, current, TEXT_LIMIT); readBytes += content.bytes.length;
                const text = new TextDecoder('utf-8', { fatal: false }).decode(content.bytes);
                if (terms.some(term => normalize(text).includes(term))) { file.matchedBy = 'content'; file.excerpt = snippet(text, terms); }
                if (content.truncated) snapshot.skippedCount++;
              }
              if (!file.matchedBy) continue;
            }
            snapshot.files.push(file);
            if (snapshot.files.length >= MAX_FILES) { snapshot.truncated = true; break; }
          } catch { snapshot.skippedCount++; }
        }
      }
      await assertRoot(current.rootPath, current);
      snapshot.files.sort((a, b) => b.date.localeCompare(a.date) || b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path));
      return snapshot;
    },
    importFiles(paths: string[], date: string, options: WorkdiskImportOptions = {}): Promise<WorkdiskImportResult> { return exclusive(async () => {
      parse(dateSchema, date); parse(z.array(z.string().min(1).max(4096)).min(1).max(100), paths); const requested = parse(importOptionsSchema, options); const current = await active();
      const result: WorkdiskImportResult = { files: [], failures: [], ...(requested.nameFromContent ? { naming: [] } : {}) };
      for (const source of paths) {
        try {
          if (!isAbsolute(source)) throw problem('请选择本地文件。');
          const before = await lstat(source); if (!before.isFile() || before.isSymbolicLink()) throw problem('仅支持普通文件，请勿选择文件夹或快捷链接。');
          const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const opened = await input.stat(); if (!opened.isFile() || !sameIdentity(before, opened)) throw problem('原文件已改变，请重试。');
            const originalName = basename(source); const extension = extname(originalName);
            let filename = originalName; let reason = '';
            if (requested.nameFromContent) {
              if (closing) reason = NAMING_SHUTDOWN_REASON;
              else if (!textExtensions.has(extension.toLowerCase()) && extension.toLowerCase() !== '.pdf') reason = '这个格式暂不支持读取正文命名，已保留原名。';
              else if (opened.size > NAMING_INPUT_LIMIT) reason = '文件超过 20 MiB 的正文命名范围，已保留原名。';
              else if (!config.contentNamer) reason = 'AI 未连接，已保留原名。';
              else {
                const bytes = Buffer.alloc(opened.size); let position = 0;
                while (position < bytes.length) {
                  const { bytesRead } = await input.read(bytes, position, bytes.length - position, position);
                  if (!bytesRead) break; position += bytesRead;
                }
                if (position !== opened.size) throw problem('读取期间原文件发生变化，请重新导入。');
                await verifySource(source, input, opened);
                try {
                  const suggested = await nameContent(config.contentNamer, { name: originalName, bytes }, namingShutdown.signal);
                  const title = namingTitle(suggested.title);
                  if (title) { filename = `${title}${extension}`; reason = typeof suggested.reason === 'string' ? suggested.reason.trim().slice(0, 300) : ''; reason ||= '已根据可读正文生成名称。'; }
                  else if (suggested.title !== undefined) reason = 'AI 返回的文件名不适用，已保留原名。';
                  else reason = typeof suggested.reason === 'string' && suggested.reason.trim() ? suggested.reason.trim().slice(0, 300) : '没有足够的可读正文生成名称，已保留原名。';
                } catch { reason = closing ? NAMING_SHUTDOWN_REASON : 'AI 本次未能完成内容命名，已保留原名。'; }
                await verifySource(source, input, opened);
              }
            }
            const saved = await publish(current, filename, date, async output => {
              const buffer = Buffer.alloc(1024 * 1024); let position = 0;
              while (position < opened.size) {
                const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, opened.size - position), position);
                if (!bytesRead) break;
                let written = 0;
                while (written < bytesRead) { const result = await output.write(buffer, written, bytesRead - written, position + written); if (!result.bytesWritten) throw problem('文件保存中断，请重试。'); written += result.bytesWritten; }
                position += bytesRead;
              }
              if (position !== opened.size) throw problem('复制期间原文件发生变化，请重试。');
              await verifySource(source, input, opened);
            });
            result.files.push(saved);
            result.naming?.push({ originalName, savedName: saved.name, status: filename === originalName ? 'kept' : 'renamed', reason });
          } finally { await input.close(); }
        } catch (error) { result.failures.push({ name: basename(source), message: error instanceof Error && !('code' in error) ? error.message : '这个文件暂时无法保存，请检查文件是否仍存在及磁盘空间。' }); }
      }
      return result;
    }); },
    createNote(input: { title: string; body: string; date: string }): Promise<WorkdiskFile> { return exclusive(async () => {
      const request = parse(noteSchema, input); safeName(request.title); const current = await active();
      const name = request.title.endsWith('.md') ? request.title : `${request.title}.md`;
      return publish(current, name, request.date, async handle => { await handle.writeFile(request.body, 'utf8'); });
    }); },
    async resolveFile(path: string): Promise<string> { safeRelative(path); const current = await active(); return regularFile(current.rootPath, path, current); },
    async preview(path: string): Promise<WorkdiskPreview> {
      const current = await active(); const target = await regularFile(current.rootPath, path, current); const extension = extname(path).toLowerCase();
      if (textExtensions.has(extension)) {
        const result = await readBounded(current.rootPath, path, current, TEXT_LIMIT);
        return { kind: 'text', text: new TextDecoder('utf-8', { fatal: false }).decode(result.bytes), truncated: result.truncated };
      }
      if (imageTypes[extension] && (await lstat(target)).size <= IMAGE_LIMIT) {
        const result = await readBounded(current.rootPath, path, current, IMAGE_LIMIT);
        if (!result.truncated) return { kind: 'image', url: `data:${imageTypes[extension]};base64,${result.bytes.toString('base64')}` };
      }
      const kind = fileKind(path); return { kind: kind === 'video' || kind === 'audio' ? 'media' : 'unsupported' };
    }
  };
}
export type WorkdiskService = ReturnType<typeof createWorkdiskService>;
