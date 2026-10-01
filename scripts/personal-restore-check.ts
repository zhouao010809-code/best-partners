import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { PersonalBackupError, verifyPersonalBackup } from '../src/server/operations/personal-backup.js';

export function parseRestoreArguments(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== '--snapshot' || !argv[1] || argv[1].startsWith('--') || !isAbsolute(argv[1]) || argv[1].includes('\0')) {
    throw new PersonalBackupError('PERSONAL_RESTORE_CHECK_ARGUMENTS_INVALID');
  }
  return argv[1];
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const result = await verifyPersonalBackup(parseRestoreArguments(argv));
    process.stdout.write(`${JSON.stringify({ snapshot: result.snapshotRoot,
      manifestVersion: result.manifest.version, sourceVault: result.manifest.source.vault,
      snapshotIntegrity: result.snapshotIntegrity, sqliteIntegrity: result.sqliteIntegrity,
      applicationRestore: result.applicationRestore, requiresIdentityRebind: result.requiresIdentityRebind,
      fileCount: result.manifest.fileCount, totalBytes: result.manifest.totalBytes,
      databases: result.databases, notCovered: result.manifest.notCovered })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof PersonalBackupError ? error.code : 'PERSONAL_RESTORE_CHECK_FAILED'}\n`);
    process.exitCode = error instanceof PersonalBackupError && error.code === 'PERSONAL_RESTORE_CHECK_ARGUMENTS_INVALID' ? 2 : 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && fileURLToPath(import.meta.url) === resolve(invokedPath)) void main();
