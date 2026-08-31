import Sqlite from 'better-sqlite3';
import type Database from 'better-sqlite3';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensurePrivateDirectory, secureExistingPrivateFile } from './permissions.js';

interface VerifiedBackup {
  readonly path: string;
  readonly mtimeMs: number;
}

function verifyBackup(path: string): void {
  secureExistingPrivateFile(path);
  const copy = new Sqlite(path, { readonly: true, fileMustExist: true });
  try {
    if (copy.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('backup integrity check failed');
    }
  } finally {
    copy.close();
  }
}

function verifiedBackups(backupsDir: string): VerifiedBackup[] {
  const verified: VerifiedBackup[] = [];
  for (const name of readdirSync(backupsDir)) {
    const path = join(backupsDir, name);
    const status = lstatSync(path);
    if (status.isSymbolicLink()) throw new Error('unsafe backup entry');
    if (!/^state-.*\.sqlite3$/.test(name)) continue;
    if (!status.isFile() || status.nlink !== 1) throw new Error('unsafe backup entry');
    verifyBackup(path);
    verified.push({ path, mtimeMs: statSync(path).mtimeMs });
  }
  return verified;
}

export function assertBackupStoreSafe(backupsDir: string): void {
  ensurePrivateDirectory(backupsDir);
  verifiedBackups(backupsDir);
}

function syncFile(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function removeTemporary(path: string): void {
  try {
    const status = lstatSync(path);
    if (!status.isSymbolicLink() && status.isFile() && status.nlink === 1) unlinkSync(path);
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
}

export async function createStateBackup(input: {
  readonly db: Database.Database;
  readonly backupsDir: string;
}): Promise<string> {
  if (!input.db.open) throw new Error('database is closed');
  ensurePrivateDirectory(input.backupsDir);
  const previous = verifiedBackups(input.backupsDir);
  const identity = `${Date.now()}-${randomUUID()}`;
  const finalPath = join(input.backupsDir, `state-${identity}.sqlite3`);
  const temporaryPath = join(input.backupsDir, `.state-${identity}.${randomUUID()}.tmp`);
  if (existsSync(finalPath) || existsSync(temporaryPath)) throw new Error('backup path collision');

  const descriptor = openSync(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  closeSync(descriptor);
  try {
    await input.db.backup(temporaryPath);
    secureExistingPrivateFile(temporaryPath);
    verifyBackup(temporaryPath);
    syncFile(temporaryPath);
    if (existsSync(finalPath)) throw new Error('backup path collision');
    renameSync(temporaryPath, finalPath);
    secureExistingPrivateFile(finalPath);
    syncDirectory(input.backupsDir);

    const keep = previous
      .sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path))
      .slice(0, 2)
      .map((backup) => backup.path);
    const stale = previous.filter((backup) => !keep.includes(backup.path));
    for (const backup of stale) {
      secureExistingPrivateFile(backup.path);
      unlinkSync(backup.path);
    }
    if (stale.length > 0) syncDirectory(input.backupsDir);
    return finalPath;
  } catch (error) {
    removeTemporary(temporaryPath);
    throw error;
  }
}
