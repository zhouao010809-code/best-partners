import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function sameOrContainedBy(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return fromParent === ''
    || (fromParent !== '..' && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent));
}

function canonicalComparisonPath(path: string): string {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync(ancestor), ...suffix);
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

export function assertStateRootOutsideVault(appDataDir: string, vaultRealRoot: string): void {
  const appData = canonicalComparisonPath(appDataDir);
  const vault = canonicalComparisonPath(vaultRealRoot);
  if (sameOrContainedBy(vault, appData) || sameOrContainedBy(appData, vault)) {
    throw new Error('State data must remain outside the vault');
  }
}

export function ensurePrivateDirectory(path: string): void {
  if (
    typeof constants.O_NOFOLLOW !== 'number'
    || constants.O_NOFOLLOW === 0
    || typeof constants.O_DIRECTORY !== 'number'
    || constants.O_DIRECTORY === 0
  ) {
    throw new Error('unsafe directory: nofollow unavailable');
  }
  const absolute = resolve(path);
  const parent = realpathSync(dirname(absolute));
  const expectedRealPath = join(parent, basename(absolute));
  try {
    const status = lstatSync(absolute);
    if (status.isSymbolicLink() || !status.isDirectory()) throw new Error('unsafe directory');
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
    mkdirSync(absolute, { mode: 0o700 });
  }
  const status = lstatSync(absolute);
  if (status.isSymbolicLink() || !status.isDirectory()) throw new Error('unsafe directory');
  if (realpathSync(absolute) !== expectedRealPath) throw new Error('unsafe directory');
  const descriptor = openSync(
    absolute,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isDirectory()
      || opened.dev !== status.dev
      || opened.ino !== status.ino
    ) {
      throw new Error('unsafe directory');
    }
    fchmodSync(descriptor, 0o700);
    if ((fstatSync(descriptor).mode & 0o777) !== 0o700) {
      throw new Error('unsafe directory mode');
    }
  } finally {
    closeSync(descriptor);
  }
  const after = lstatSync(absolute);
  if (
    after.isSymbolicLink()
    || !after.isDirectory()
    || after.dev !== status.dev
    || after.ino !== status.ino
  ) {
    throw new Error('unsafe directory');
  }
}

export function secureExistingPrivateFile(path: string): boolean {
  if (typeof constants.O_NOFOLLOW !== 'number' || constants.O_NOFOLLOW === 0) {
    throw new Error('unsafe file: nofollow unavailable');
  }
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error('unsafe file');
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      throw new Error('unsafe file');
    }
    fchmodSync(descriptor, 0o600);
    if ((fstatSync(descriptor).mode & 0o777) !== 0o600) throw new Error('unsafe file mode');
  } finally {
    closeSync(descriptor);
  }
  const after = lstatSync(path);
  if (
    !after.isFile()
    || after.isSymbolicLink()
    || after.nlink !== 1
    || after.dev !== before.dev
    || after.ino !== before.ino
    || (after.mode & 0o777) !== 0o600
  ) {
    throw new Error('unsafe file');
  }
  return true;
}

export function createPrivateFileExclusive(path: string): void {
  if (typeof constants.O_NOFOLLOW !== 'number' || constants.O_NOFOLLOW === 0) {
    throw new Error('unsafe file: nofollow unavailable');
  }
  const descriptor = openSync(
    path,
    constants.O_CREAT
      | constants.O_EXCL
      | constants.O_RDWR
      | constants.O_NOFOLLOW,
    0o600
  );
  try {
    const created = fstatSync(descriptor);
    if (!created.isFile() || created.nlink !== 1) throw new Error('unsafe file');
    fchmodSync(descriptor, 0o600);
    const secured = fstatSync(descriptor);
    if (
      !secured.isFile()
      || secured.nlink !== 1
      || secured.dev !== created.dev
      || secured.ino !== created.ino
      || (secured.mode & 0o777) !== 0o600
    ) {
      throw new Error('unsafe file');
    }
    const atPath = lstatSync(path);
    if (
      atPath.isSymbolicLink()
      || !atPath.isFile()
      || atPath.nlink !== 1
      || atPath.dev !== secured.dev
      || atPath.ino !== secured.ino
      || (atPath.mode & 0o777) !== 0o600
    ) {
      throw new Error('unsafe file');
    }
  } finally {
    closeSync(descriptor);
  }
}

export function secureSqliteFiles(databasePath: string): void {
  secureExistingPrivateFile(databasePath);
  secureExistingPrivateFile(`${databasePath}-wal`);
  secureExistingPrivateFile(`${databasePath}-shm`);
}
