import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { problem, sameIdentity, type FileIdentity } from './paths.js';

/** exFAT/FAT cannot link the staged file. Create exclusively and clean only our inode on failure. */
export async function copyExclusive(source: string, target: string, stagedIdentity: FileIdentity, checkDirectory: () => Promise<unknown>): Promise<FileIdentity> {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  let targetIdentity: FileIdentity | undefined;
  try {
    const before = await input.stat();
    if (!before.isFile() || !sameIdentity(before, stagedIdentity)) throw problem('待保存的文件已改变，请重试。');
    await checkDirectory();
    output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    targetIdentity = await output.stat();
    const buffer = Buffer.alloc(1024 * 1024); let position = 0;
    while (position < before.size) {
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (!bytesRead) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, position + written);
        if (!result.bytesWritten) throw problem('文件保存中断，请重试。');
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    const after = await input.stat();
    if (position !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw problem('待保存的文件已改变，请重试。');
    await output.sync();
    await checkDirectory();
    const published = await lstat(target);
    if (published.isSymbolicLink() || !sameIdentity(published, targetIdentity) || published.size !== before.size) throw problem('保存位置已改变，请刷新后重试。');
    await output.close(); output = undefined;
    return targetIdentity;
  } catch (error) {
    await output?.close().catch(() => undefined); output = undefined;
    if (targetIdentity) {
      // An EEXIST target was never opened and has no captured identity here.
      // Do not unlink a replacement, even when it uses the same filename.
      await checkDirectory().then(async () => {
        const current = await lstat(target).catch(() => undefined);
        if (current && current.isFile() && !current.isSymbolicLink() && sameIdentity(current, targetIdentity!)) await unlink(target);
      }).catch(() => undefined);
    }
    throw error;
  } finally { await input.close(); }
}
