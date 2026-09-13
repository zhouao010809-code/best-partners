import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { clipperMessageSchema, type ClipperMessage } from '../shared/api/clipper.js';
export const MAX_NATIVE_MESSAGE_BYTES = 12 * 1024 * 1024;
export type ClipperHostConfig = { vaultRoot: string; token: string; extensionId: string };
export function encodeNativeMessage(value: unknown): Buffer { const body = Buffer.from(JSON.stringify(value)); if (body.length > MAX_NATIVE_MESSAGE_BYTES) throw new Error('消息太大'); const out = Buffer.alloc(4 + body.length); out.writeUInt32LE(body.length); body.copy(out, 4); return out; }
export function decodeNativeMessage(frame: Buffer): unknown { if (frame.length < 4) throw new Error('消息格式无效'); const n = frame.readUInt32LE(0); if (n > MAX_NATIVE_MESSAGE_BYTES || frame.length !== n + 4) throw new Error('消息格式无效'); return JSON.parse(frame.subarray(4).toString('utf8')); }
export async function handleClipperMessage(message: unknown, config: ClipperHostConfig) {
  const parsed = clipperMessageSchema.safeParse(message); if (!parsed.success) throw new Error('收藏消息格式无效');
  const m = parsed.data; if (m.extensionId !== config.extensionId || m.token !== config.token) throw new Error('浏览器插件未配对，请重新连接');
  const root = resolve(config.vaultRoot); const dir = join(root, '01图书馆', '小兆clipper', m.payload.packetId); if (!dir.startsWith(join(root, '01图书馆', '小兆clipper') + '/')) throw new Error('保存位置无效');
  await fs.mkdir(dir, { recursive: true }); const md = `# ${m.payload.title}\n\n来源：${m.payload.url}\n采集时间：${m.payload.clippedAt}\n\n${m.payload.content}\n`; const hash = Buffer.from(md).toString('base64');
  const existing = await fs.readFile(join(dir, 'index.md'), 'utf8').catch(() => undefined); if (existing !== undefined) { if (existing !== md) throw new Error('packetId 已存在但内容不同'); return { ok: true, packetId: m.payload.packetId, duplicate: true }; }
  const tmp = join(dir, `.index.${process.pid}.tmp`); await fs.writeFile(tmp, md, { mode: 0o600 }); await fs.rename(tmp, join(dir, 'index.md')); const metaTmp = join(dir, `.metadata.${process.pid}.tmp`); await fs.writeFile(metaTmp, JSON.stringify({ ...m.payload, hash }, null, 2), { mode: 0o600 }); await fs.rename(metaTmp, join(dir, 'metadata.json'));
  return { ok: true, packetId: m.payload.packetId, duplicate: false };
}
export async function runClipperHost(opts: { configPath: string; input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }) {
  const config = JSON.parse(await fs.readFile(opts.configPath, 'utf8')) as ClipperHostConfig; const input = opts.input ?? process.stdin; const output = opts.output ?? process.stdout; let data = Buffer.alloc(0);
  for await (const chunk of input) { data = Buffer.concat([data, Buffer.from(chunk as Uint8Array)]); while (data.length >= 4) { const n = data.readUInt32LE(0); if (n > MAX_NATIVE_MESSAGE_BYTES || data.length < n + 4) break; const frame = data.subarray(0, n + 4); data = data.subarray(n + 4); let response; try { response = await handleClipperMessage(decodeNativeMessage(frame), config); } catch (e) { response = { ok: false, error: e instanceof Error ? e.message : '保存失败' }; } output.write(encodeNativeMessage(response)); } }
}
