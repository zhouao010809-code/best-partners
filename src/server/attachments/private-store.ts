import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensurePrivateDirectory } from '../db/permissions.js';

/** Only service-generated UUID filenames, under this vault's private app-data root. */
export function createAttachmentFiles(directory: string) {
  ensurePrivateDirectory(directory);
  const root = lstatSync(directory);
  function checkRoot() { const current = lstatSync(directory); if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== root.dev || current.ino !== root.ino) throw Error('ATTACHMENT_STORE_CHANGED'); }
  function path(name: string) { if (!/^[a-f0-9-]{36}\.(?:json|bin|text\.json|[a-f0-9-]{36}\.part)$/u.test(name)) throw Error('ATTACHMENT_STORE_NAME'); checkRoot(); return join(directory, name); }
  function read(name: string, max: number): Buffer | null {
    const filename = path(name); let fd: number;
    try { fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    try {
      const before = fstatSync(fd); if (!before.isFile() || before.nlink !== 1 || before.size > max || before.uid !== process.getuid?.()) throw Error('ATTACHMENT_STORE_UNSAFE');
      const bytes = readFileSync(fd), after = fstatSync(fd), current = lstatSync(filename);
      if (before.size !== bytes.length || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== current.ino || before.dev !== current.dev) throw Error('ATTACHMENT_STORE_CHANGED');
      checkRoot(); return bytes;
    } finally { closeSync(fd); }
  }
  function put(name: string, bytes: Buffer, immutable = false) {
    const target = path(name);
    const existing = read(name, Math.max(bytes.length, 32 * 1024 * 1024));
    if (immutable && existing) { if (!existing.equals(bytes)) throw Error('ATTACHMENT_STORE_CONFLICT'); return; }
    const temporary = path(`${name.slice(0, 36)}.${randomUUID()}.part`);
    let fd = -1;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = -1; checkRoot();
      renameSync(temporary, target);
      const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { const current = fstatSync(parent); if (current.dev !== root.dev || current.ino !== root.ino) throw Error('ATTACHMENT_STORE_CHANGED'); fsyncSync(parent); } finally { closeSync(parent); }
      if (!read(name, bytes.length)?.equals(bytes)) throw Error('ATTACHMENT_STORE_CHANGED');
    } finally {
      if (fd >= 0) closeSync(fd);
      try { checkRoot(); unlinkSync(temporary); } catch { /* Only this uncommitted private .part may remain. */ }
    }
  }
  return { read, put, list: () => { checkRoot(); return readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/u.test(name)); } };
}
