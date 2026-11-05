import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { link, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PublicApiError } from '../../shared/api/errors.js';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function reapAbandonedLock(file: string) {
  // Keep inspection/removal in one event-loop turn, so local contenders cannot
  // remove a new owner's lock after observing the same dead owner concurrently.
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 32) return;
    const pid = Number(readFileSync(fd, 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return; }
    } else if (Date.now() - info.mtimeMs < 30_000) return;
    // Legacy versions could crash between exclusive creation and writing a PID.
    const current = lstatSync(file);
    if (current.dev === info.dev && current.ino === info.ino && current.mtimeMs === info.mtimeMs) unlinkSync(file);
  } catch { /* Another owner may have already released or replaced the lock. */ }
  finally { if (fd !== undefined) closeSync(fd); }
}

// The lock is shared by all app instances writing this hub, never the agent process.
export async function withAutoloopLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const candidate = `${file}.${randomUUID()}.tmp`;
  try {
    // Publish an already initialized owner atomically. A crash before link()
    // leaves only an unused candidate, never an empty authoritative lock.
    await openWrite(candidate, String(process.pid));
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await link(candidate, file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        reapAbandonedLock(file);
        await pause(25); continue;
      }
      try { return await action(); }
      finally { await unlink(file); }
    }
    throw new PublicApiError('AUTOLOOP_BUSY', '自动任务配置正在更新，请稍后重试。', 409);
  } finally { await unlink(candidate).catch(() => undefined); }
}

export async function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await openWrite(temporary, JSON.stringify(value, null, 2) + '\n'); await rename(temporary, file); }
  finally { await unlink(temporary).catch(() => undefined); }
}
async function openWrite(file: string, text: string) {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
}
