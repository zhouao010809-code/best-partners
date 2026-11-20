import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertStateRootOutsideVault } from '../db/permissions.js';

function ensureRecoveryDirectory(path: string, device: bigint): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const entry = lstatSync(path, { bigint: true });
  if (!entry.isDirectory() || entry.dev !== device || entry.uid !== BigInt(process.getuid!())
      || (entry.mode & 0o7777n) !== 0o700n || realpathSync(path) !== path) {
    throw new Error('UNSAFE_RECOVERY_DIRECTORY');
  }
}

export function selectPersonalRecoveryRoot(vaultRoot: string, appDataDir: string): string {
  assertStateRootOutsideVault(appDataDir, vaultRoot);
  const root = realpathSync(vaultRoot);
  const vault = lstatSync(root, { bigint: true });
  if (vault.dev === lstatSync(appDataDir, { bigint: true }).dev) return appDataDir;

  // Native recycle/restore uses atomic rename and needs a sibling on the vault volume.
  const parent = dirname(root);
  if (lstatSync(parent, { bigint: true }).dev !== vault.dev) throw new Error('NO_SAME_DEVICE_RECOVERY_PARENT');
  const shared = join(parent, '.xiaozhao-personal-recovery');
  assertStateRootOutsideVault(shared, root);
  ensureRecoveryDirectory(shared, vault.dev);
  // Keep journals bound to this folder across remounts, when device numbers may change.
  const key = createHash('sha256').update(JSON.stringify([root, String(vault.ino)])).digest('hex');
  const recovery = join(shared, key);
  ensureRecoveryDirectory(recovery, vault.dev);
  return recovery;
}
