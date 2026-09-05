import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// Validate before setPath/whenReady: Electron itself writes cache and session data.
export function validateDesktopTestRoots(input: { vaultRoot: string; userDataDir: string }) {
  try {
    const temporary = realpathSync(tmpdir());
    const identities = [];
    for (const [path, prefix] of [[input.vaultRoot, 'xiaozhao-vault-'], [input.userDataDir, 'xiaozhao-user-data-']] as const) {
      if (resolve(path) !== path || dirname(path) !== temporary || !basename(path).startsWith(prefix)) throw new Error();
      const status = lstatSync(path);
      if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o777) !== 0o700 || status.uid !== process.getuid?.()) throw new Error();
      if (realpathSync(path) !== path) throw new Error();
      identities.push(`${status.dev}:${status.ino}`);
    }
    if (identities[0] === identities[1]) throw new Error();
    const sentinel = openSync(join(input.vaultRoot, '.xiaozhao-read-test-vault.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const status = fstatSync(sentinel);
      if (!status.isFile() || status.size !== Buffer.byteLength('{"purpose":"read-test"}\n') || status.nlink !== 1) throw new Error();
      if (readFileSync(sentinel, 'utf8') !== '{"purpose":"read-test"}\n') throw new Error();
    } finally { closeSync(sentinel); }
    return input;
  } catch { throw new Error('TEST_ROOTS_INVALID'); }
}
