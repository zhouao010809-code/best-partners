import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  CompanyOperationsError,
  createCompanyBackup,
  snapshotLabel
} from '../src/server/company/company-operations.js';

function options(argv: readonly string[]): { workspaceRoot: string; stateRoot: string; destinationRoot: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !value || !['--workspace', '--state', '--destination'].includes(flag) || values.has(flag)) {
      throw new CompanyOperationsError('COMPANY_BACKUP_ARGUMENTS_INVALID');
    }
    values.set(flag, value);
  }
  if (values.size !== 3) throw new CompanyOperationsError('COMPANY_BACKUP_ARGUMENTS_INVALID');
  return {
    workspaceRoot: values.get('--workspace')!,
    stateRoot: values.get('--state')!,
    destinationRoot: values.get('--destination')!
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const result = await createCompanyBackup(options(argv));
    process.stdout.write(`${JSON.stringify({
      snapshot: snapshotLabel(result),
      fileCount: result.manifest.fileCount,
      totalBytes: result.manifest.totalBytes
    })}\n`);
  } catch (error) {
    const code = error instanceof CompanyOperationsError ? error.code : 'COMPANY_BACKUP_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && fileURLToPath(import.meta.url) === resolve(invokedPath)) void main();
