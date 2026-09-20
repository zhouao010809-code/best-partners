import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  CompanyOperationsError,
  snapshotLabel,
  verifyCompanyBackup
} from '../src/server/company/company-operations.js';

function snapshot(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== '--snapshot' || !argv[1]) {
    throw new CompanyOperationsError('COMPANY_RESTORE_CHECK_ARGUMENTS_INVALID');
  }
  return argv[1];
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const result = await verifyCompanyBackup(snapshot(argv));
    process.stdout.write(`${JSON.stringify({
      snapshot: snapshotLabel(result),
      verified: true,
      fileCount: result.manifest.fileCount,
      totalBytes: result.manifest.totalBytes
    })}\n`);
  } catch (error) {
    const code = error instanceof CompanyOperationsError ? error.code : 'COMPANY_RESTORE_CHECK_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && fileURLToPath(import.meta.url) === resolve(invokedPath)) void main();
