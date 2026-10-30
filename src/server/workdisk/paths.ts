import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

export interface FileIdentity { dev: number; ino: number; birthtimeMs?: number | undefined }
export class WorkdiskUnavailableError extends Error {
  readonly code = 'WORKDISK_UNAVAILABLE';
  constructor() { super('工作盘已断开或位置发生变化，请重新连接原文件夹。'); this.name = 'WorkdiskUnavailableError'; }
}
export function problem(message: string): Error { return new Error(message); }
export function sameIdentity(a: FileIdentity, b: FileIdentity): boolean { return a.dev === b.dev && a.ino === b.ino; }
export function contained(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return remainder === '' || (remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}
export function safeRelative(path: string): string[] {
  if (typeof path !== 'string' || path.length > 2048 || /[\\\x00-\x1f]/u.test(path) || isAbsolute(path)) throw problem('文件路径无效，请重新选择文件。');
  const parts = path.split('/');
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) throw problem('文件路径无效，请重新选择文件。');
  return parts;
}
export async function assertRoot(root: string, identity: FileIdentity): Promise<void> {
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || !sameIdentity(info, identity) || (identity.birthtimeMs !== undefined && info.birthtimeMs !== identity.birthtimeMs) || await realpath(root) !== root) throw problem('changed');
  } catch { throw new WorkdiskUnavailableError(); }
}
export async function directory(root: string, parts: string[], identity: FileIdentity, create = false): Promise<string> {
  await assertRoot(root, identity);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (create) {
      try { await mkdir(current); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    }
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(current) !== current) throw problem('此文件夹包含快捷链接或已改变，请重新连接工作盘。');
  }
  await assertRoot(root, identity);
  return current;
}
export async function regularFile(root: string, path: string, identity: FileIdentity): Promise<string> {
  const parts = safeRelative(path); const name = parts.pop()!;
  const parent = await directory(root, parts, identity);
  const target = join(parent, name); const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(target) !== target) throw problem('文件已移动或无法读取，请刷新后重试。');
  return target;
}
/** Read through a no-follow handle and verify the file was not replaced during the read. */
export async function readBounded(root: string, path: string, identity: FileIdentity, limit: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  const target = await regularFile(root, path, identity); const before = await lstat(target);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(before, opened)) throw problem('文件已改变，请刷新后重试。');
    const buffer = Buffer.alloc(Math.min(limit, opened.size)); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break; length += bytesRead;
    }
    const after = await handle.stat(); await regularFile(root, path, identity); const current = await lstat(target);
    if (!sameIdentity(opened, current) || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw problem('文件已改变，请刷新后重试。');
    return { bytes: buffer.subarray(0, length), truncated: opened.size > limit };
  } finally { await handle.close(); }
}
