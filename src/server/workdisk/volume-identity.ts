import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const MAX_OUTPUT = 128 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export type VolumeIdentityResolver = (rootPath: string) => Promise<string | undefined>;
export function normalizeVolumeUuid(value: unknown): string | undefined { return typeof value === 'string' && UUID.test(value) ? value.toUpperCase() : undefined; }

/** Parse only a literal VolumeUUID; never evaluate plist entities, scripts or other keys. */
export function parseVolumeUuid(plist: string): string | undefined {
  if (Buffer.byteLength(plist) > MAX_OUTPUT || [...plist.matchAll(/<key>VolumeUUID<\/key>/gu)].length !== 1) return undefined;
  return normalizeVolumeUuid(/<key>VolumeUUID<\/key>\s*<string>([^<]*)<\/string>/u.exec(plist)?.[1]);
}

/** macOS device numbers change on remount. diskutil accepts a mount root, not arbitrary subdirectories. */
export const resolveVolumeIdentity: VolumeIdentityResolver = async rootPath => {
  if (process.platform !== 'darwin' || !isAbsolute(rootPath) || rootPath.length > 4096 || rootPath.includes('\0')) return undefined;
  try {
    const original = await lstat(rootPath);
    if (!original.isDirectory() || original.isSymbolicLink() || await realpath(rootPath) !== rootPath) return undefined;
    let mountRoot = rootPath;
    const dataRoot = '/System/Volumes/Data';
    const data = await lstat(dataRoot).catch(() => undefined);
    if (data?.isDirectory() && !data.isSymbolicLink() && data.dev === original.dev && await realpath(dataRoot) === dataRoot) mountRoot = dataRoot;
    else {
      for (let depth = 0; depth < 128; depth++) {
        const parent = dirname(mountRoot); if (parent === mountRoot) break;
        const info = await lstat(parent);
        if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== original.dev) break;
        mountRoot = parent;
        if (depth === 127) return undefined;
      }
    }
    const result = await execute('/usr/sbin/diskutil', ['info', '-plist', mountRoot], { encoding: 'utf8', timeout: 1500, maxBuffer: MAX_OUTPUT, windowsHide: true });
    const after = await lstat(rootPath);
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== original.dev || after.ino !== original.ino || after.birthtimeMs !== original.birthtimeMs || await realpath(rootPath) !== rootPath) return undefined;
    return parseVolumeUuid(result.stdout);
  } catch { return undefined; }
};
