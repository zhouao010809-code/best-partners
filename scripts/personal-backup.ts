import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { createPersonalBackup, PersonalBackupError, type PersonalBackupOptions } from '../src/server/operations/personal-backup.js';

export function parseBackupArguments(argv: readonly string[]): PersonalBackupOptions {
  const values = new Map<string, string>(); let cold = false;
  const invalid = (): never => { throw new PersonalBackupError('PERSONAL_BACKUP_ARGUMENTS_INVALID'); };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === '--cold') { if (cold) invalid(); cold = true; continue; }
    const value = argv[++index];
    if (!['--vault', '--user-data', '--destination'].includes(flag) || values.has(flag)
      || !value || value.startsWith('--') || !isAbsolute(value) || value.includes('\0')) invalid();
    values.set(flag, value!);
  }
  if (!cold || values.size !== 3) invalid();
  return { vaultRoot: values.get('--vault')!, userDataRoot: values.get('--user-data')!, destinationRoot: values.get('--destination')!, cold: true };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const result = await createPersonalBackup(parseBackupArguments(argv));
    process.stdout.write(`${JSON.stringify({ snapshot: result.snapshotRoot, manifestVersion: result.manifest.version,
      sourceVault: result.manifest.source.vault,
      fileCount: result.manifest.fileCount, totalBytes: result.manifest.totalBytes,
      exclusions: result.manifest.exclusions, notCovered: result.manifest.notCovered,
      applicationRestore: 'unverified', requiresIdentityRebind: true })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof PersonalBackupError ? error.code : 'PERSONAL_BACKUP_FAILED'}\n`);
    process.exitCode = error instanceof PersonalBackupError && error.code === 'PERSONAL_BACKUP_ARGUMENTS_INVALID' ? 2 : 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && fileURLToPath(import.meta.url) === resolve(invokedPath)) void main();
