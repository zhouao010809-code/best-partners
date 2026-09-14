import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { clipperMessageSchema, CLIPPER_EXTENSION_ID, type ClipperMessage } from '../shared/api/clipper.js';

export const MAX_NATIVE_MESSAGE_BYTES = 12 * 1024 * 1024;
export type ClipperHostConfig = { vaultRoot: string; token: string; extensionId: string; version?: 1 };
function fail(message: string): never { throw new Error(message); }
function isMissing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
function isInside(root: string, candidate: string): boolean { return candidate === root || candidate.startsWith(`${root}${sep}`); }
async function assertNoSymlinkPath(path: string, boundary?: string): Promise<void> {
  // Check every component beneath the configured boundary, not only the final
  // directory. Walking only the final path would allow a symlink such as
  // `01图书馆 -> /outside` to escape the vault before realpath containment is
  // checked.
  const normalizedPath = resolve(path);
  const normalizedBoundary = boundary === undefined ? undefined : resolve(boundary);
  if (normalizedBoundary !== undefined && !isInside(normalizedBoundary, normalizedPath)) fail('保存位置无效');
  const relative = normalizedBoundary === undefined ? normalizedPath : normalizedPath.slice(normalizedBoundary.length).replace(/^[/\\]/, '');
  const components = relative ? relative.split(/[\\/]+/u) : [];
  let current = normalizedBoundary ?? normalizedPath.slice(0, normalizedPath.indexOf(sep) + 1);
  if (normalizedBoundary === undefined) {
    const stat = await fs.lstat(normalizedPath).catch((error) => { if (isMissing(error)) fail('保存位置无效'); throw error; });
    if (stat.isSymbolicLink()) fail('保存位置无效');
    return;
  }
  for (const component of components) {
    current = join(current, component);
    const stat = await fs.lstat(current).catch((error) => { if (isMissing(error)) fail('保存位置无效'); throw error; });
    if (stat.isSymbolicLink()) fail('保存位置无效');
  }
}

export function encodeNativeMessage(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value)); if (body.length > MAX_NATIVE_MESSAGE_BYTES) fail('消息超过 12 MiB 限制');
  const out = Buffer.allocUnsafe(4 + body.length); out.writeUInt32LE(body.length, 0); body.copy(out, 4); return out;
}
export function decodeNativeMessage(frame: Buffer): unknown {
  if (frame.length < 4) fail('消息格式无效'); const n = frame.readUInt32LE(0);
  if (n > MAX_NATIVE_MESSAGE_BYTES) fail('消息超过 12 MiB 限制'); if (frame.length !== n + 4) fail('消息格式无效');
  try { return JSON.parse(frame.subarray(4).toString('utf8')); } catch { fail('消息 JSON 无效'); }
}
export function parseClipperHostConfig(value: unknown): ClipperHostConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Native host 配置无效');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['version', 'vaultRoot', 'token', 'extensionId'].includes(key))) fail('Native host 配置无效');
  if (input.version !== 1) fail('Native host 配置版本无效');
  if (typeof input.vaultRoot !== 'string' || !input.vaultRoot.startsWith('/') || input.vaultRoot.includes('\0')) fail('Native host 配置路径无效');
  if (typeof input.token !== 'string' || input.token.length < 32 || input.token.length > 256) fail('Native host 配置令牌无效');
  if (input.extensionId !== CLIPPER_EXTENSION_ID) fail('Native host 配置扩展无效');
  return { version: 1, vaultRoot: input.vaultRoot, token: input.token, extensionId: input.extensionId as string };
}
async function assertPrivateConfig(path: string): Promise<void> {
  const stat = await fs.lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 16_384) fail('Native host 配置权限无效');
}
async function safeRealDirectory(path: string, root?: string): Promise<string> {
  await assertNoSymlinkPath(path, root);
  const stat = await fs.lstat(path).catch((error) => { if (isMissing(error)) fail('保存位置无效'); throw error; });
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('保存位置无效'); const real = await fs.realpath(path);
  if (root !== undefined && !isInside(root, real)) fail('保存位置无效'); return real;
}
async function safeInbox(vaultRoot: string): Promise<{ inbox: string }> {
  const root = await safeRealDirectory(resolve(vaultRoot));
  const library = await safeRealDirectory(join(root, '01图书馆'), root);
  return { inbox: await safeRealDirectory(join(library, '小兆clipper'), root) };
}
function markdownFor(message: Extract<ClipperMessage, { payload: unknown }>): string {
  const p = message.payload; return `# ${p.title}\n\n来源：${p.url}\n采集时间：${p.clippedAt}\n\n${p.content}\n`;
}
async function findDuplicate(inbox: string, packetId: string, contentHash: string): Promise<boolean> {
  const readMetadata = async (directory: string): Promise<string | undefined> => {
    const metadataPath = join(directory, 'metadata.json');
    const stat = await fs.lstat(metadataPath).catch((error) => { if (isMissing(error)) return undefined; throw error; });
    if (!stat) return undefined;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) fail('保存位置无效');
    return fs.readFile(metadataPath, 'utf8');
  };
  const direct = join(inbox, packetId);
  try {
    const stat = await fs.lstat(direct); if (stat.isSymbolicLink() || !stat.isDirectory()) fail('保存位置无效');
    // An index without metadata is an incomplete/foreign directory, not proof of
    // a duplicate packet.  Never report a duplicate solely because index.md exists.
    const metadata = await readMetadata(direct);
    if (metadata !== undefined) {
      try {
        const parsed = JSON.parse(metadata) as Record<string, unknown>;
        if (parsed.packetId === packetId || parsed.contentHash === contentHash || parsed.hash === contentHash) return true;
      } catch { /* malformed metadata is ignored */ }
    }
  } catch (error) { if (!isMissing(error)) throw error; }
  for (const entry of await fs.readdir(inbox, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) fail('保存位置无效');
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const directory = join(inbox, entry.name); const stat = await fs.lstat(directory); if (stat.isSymbolicLink()) fail('保存位置无效');
    const metadata = await readMetadata(directory); if (metadata === undefined) continue;
    try { const parsed = JSON.parse(metadata) as Record<string, unknown>; if (parsed.contentHash === contentHash || parsed.hash === contentHash) return true; } catch { /* malformed metadata is ignored */ }
  }
  return false;
}
export async function handleClipperMessage(message: unknown, configInput: ClipperHostConfig) {
  const config = parseClipperHostConfig(configInput); const parsed = clipperMessageSchema.safeParse(message); if (!parsed.success) fail('收藏消息格式无效');
  const m = parsed.data; if (m.extensionId !== CLIPPER_EXTENSION_ID || m.extensionId !== config.extensionId || m.token !== config.token) fail('浏览器插件未配对，请重新连接');
  if (!('payload' in m)) return { ok: true, pong: true };
  const { inbox } = await safeInbox(config.vaultRoot); const md = markdownFor(m);
  const contentHash = createHash('sha256').update(md).digest('hex'); const lock = join(inbox, '.clipper.lock'); let lockHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    lockHandle = await fs.open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    if (await findDuplicate(inbox, m.payload.packetId, contentHash)) return { ok: true, packetId: m.payload.packetId, duplicate: true, contentHash };
    const temporary = await fs.mkdtemp(join(inbox, `.packet-${m.payload.packetId}-`));
    try {
      await fs.writeFile(join(temporary, 'index.md'), md, { mode: 0o600 }); await fs.writeFile(join(temporary, 'metadata.json'), `${JSON.stringify({ ...m.payload, contentHash }, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporary, join(inbox, m.payload.packetId)); return { ok: true, packetId: m.payload.packetId, duplicate: false, contentHash };
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST' && await findDuplicate(inbox, m.payload.packetId, contentHash)) return { ok: true, packetId: m.payload.packetId, duplicate: true, contentHash };
      throw error;
    }
  } finally { await lockHandle?.close().catch(() => undefined); await fs.unlink(lock).catch((error) => { if (!isMissing(error)) throw error; }); }
}
export async function runClipperHost(opts: { configPath: string; input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }) {
  await assertPrivateConfig(opts.configPath); const config = parseClipperHostConfig(JSON.parse(await fs.readFile(opts.configPath, 'utf8'))); const input = opts.input ?? process.stdin; const output = opts.output ?? process.stdout;
  let header = Buffer.alloc(0); let expected = -1; let bodyChunks: Buffer[] = []; let bodyBytes = 0;
  const rejectOversized = () => { output.write(encodeNativeMessage({ ok: false, error: '消息超过 12 MiB 限制' })); };
  for await (const chunk of input) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); let offset = 0;
    while (offset < part.length) {
      if (expected < 0) {
        const take = Math.min(4 - header.length, part.length - offset);
        header = Buffer.concat([header, part.subarray(offset, offset + take)]); offset += take;
        if (header.length < 4) continue;
        expected = header.readUInt32LE(0);
        if (expected > MAX_NATIVE_MESSAGE_BYTES) { rejectOversized(); return; }
        bodyChunks = []; bodyBytes = 0;
        if (expected === 0) {
          let response: unknown; try { response = await handleClipperMessage(decodeNativeMessage(header), config); } catch (error) { response = { ok: false, error: error instanceof Error ? error.message : '保存失败' }; }
          output.write(encodeNativeMessage(response)); header = Buffer.alloc(0); expected = -1;
        }
        continue;
      }
      const take = Math.min(expected - bodyBytes, part.length - offset);
      if (take > 0) { bodyChunks.push(part.subarray(offset, offset + take)); bodyBytes += take; offset += take; }
      if (bodyBytes < expected) continue;
      const frame = Buffer.concat([header, ...bodyChunks]);
      let response: unknown; try { response = await handleClipperMessage(decodeNativeMessage(frame), config); } catch (error) { response = { ok: false, error: error instanceof Error ? error.message : '保存失败' }; }
      output.write(encodeNativeMessage(response)); header = Buffer.alloc(0); expected = -1; bodyChunks = []; bodyBytes = 0;
    }
  }
  if (header.length > 0 || expected >= 0) output.write(encodeNativeMessage({ ok: false, error: '消息格式无效' }));
}
