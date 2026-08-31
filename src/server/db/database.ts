import Database from 'better-sqlite3';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertBackupStoreSafe } from './backup.js';
import { applyMigrations } from './migrate.js';
import {
  assertStateRootOutsideVault,
  ensurePrivateDirectory,
  secureExistingPrivateFile,
  secureSqliteFiles
} from './permissions.js';

export interface NormalStateKernel {
  readonly mode: 'normal';
  readonly db: Database.Database;
  readonly path: string;
  readonly backupsDir: string;
  readonly recoveryDir: string;
  close(): void;
}

export interface RecoveryOnlyStateKernel {
  readonly mode: 'recovery-only';
  readonly reason: 'database-corrupt';
  readonly recovery: {
    readonly entries: readonly string[];
    readonly count: number;
  };
}

export type StateKernel = NormalStateKernel | RecoveryOnlyStateKernel;

function isCorruptDatabaseError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'SQLITE_CORRUPT' || error.code === 'SQLITE_NOTADB');
}

function integrityIsValid(db: Database.Database): boolean {
  return db.pragma('integrity_check', { simple: true }) === 'ok';
}

function scanRecovery(recoveryDir: string): RecoveryOnlyStateKernel['recovery'] {
  const entries = readdirSync(recoveryDir).sort();
  for (const entry of entries) {
    const path = join(recoveryDir, entry);
    const status = lstatSync(path);
    if (status.isSymbolicLink()) throw new Error('unsafe recovery entry');
    if (status.isFile()) {
      secureExistingPrivateFile(path);
    } else if (!status.isDirectory()) {
      throw new Error('unsafe recovery entry');
    }
  }
  return { entries, count: entries.length };
}

function recoveryOnly(recoveryDir: string): RecoveryOnlyStateKernel {
  return {
    mode: 'recovery-only',
    reason: 'database-corrupt',
    recovery: scanRecovery(recoveryDir)
  };
}

export function openStateKernel(input: {
  readonly appDataDir: string;
  readonly vaultRealRoot: string;
}): StateKernel {
  assertStateRootOutsideVault(input.appDataDir, input.vaultRealRoot);
  ensurePrivateDirectory(input.appDataDir);
  const path = join(input.appDataDir, 'state.sqlite3');
  const backupsDir = join(input.appDataDir, 'backups');
  const recoveryDir = join(input.appDataDir, 'recovery');
  ensurePrivateDirectory(backupsDir);
  ensurePrivateDirectory(recoveryDir);
  assertBackupStoreSafe(backupsDir);
  const existed = secureExistingPrivateFile(path);
  secureExistingPrivateFile(`${path}-wal`);
  secureExistingPrivateFile(`${path}-shm`);

  let db: Database.Database | undefined;
  try {
    db = new Database(path);
    secureExistingPrivateFile(path);
    if (existed && !integrityIsValid(db)) {
      db.close();
      return recoveryOnly(recoveryDir);
    }

    if (db.pragma('journal_mode = WAL', { simple: true }) !== 'wal') {
      throw new Error('SQLite WAL mode unavailable');
    }
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    if (
      db.pragma('foreign_keys', { simple: true }) !== 1
      || db.pragma('busy_timeout', { simple: true }) !== 5000
    ) {
      throw new Error('SQLite connection pragmas unavailable');
    }

    applyMigrations(db);
    if (!integrityIsValid(db)) {
      db.close();
      return recoveryOnly(recoveryDir);
    }
    secureSqliteFiles(path);
    const opened = db;
    return {
      mode: 'normal',
      db: opened,
      path,
      backupsDir,
      recoveryDir,
      close: () => opened.close()
    };
  } catch (error) {
    if (db?.open) db.close();
    if (isCorruptDatabaseError(error)) return recoveryOnly(recoveryDir);
    throw error;
  }
}
