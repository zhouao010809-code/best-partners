import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CONTRACT_ROOT = 'tests/contract/obsidian-local-rest-5.1.0';

export function selectContractFiles(arguments_: ReadonlyArray<string>): string[] {
  if (arguments_.length === 0) {
    return [
      `${CONTRACT_ROOT}/read.contract.test.ts`,
      `${CONTRACT_ROOT}/write-gate.contract.test.ts`
    ];
  }
  const selection = arguments_[0];
  if (arguments_.length !== 1 || (selection !== 'read' && selection !== 'write')) {
    throw new Error('CONTRACT_SELECTION_INVALID');
  }
  return [selection === 'read'
    ? `${CONTRACT_ROOT}/read.contract.test.ts`
    : `${CONTRACT_ROOT}/write-gate.contract.test.ts`];
}

async function main(): Promise<void> {
  let files: string[];
  try {
    files = selectContractFiles(process.argv.slice(2));
  } catch {
    process.stderr.write('CONTRACT_SELECTION_INVALID\n');
    process.exitCode = 1;
    return;
  }
  const vitest = join(process.cwd(), 'node_modules/vitest/vitest.mjs');
  const child = spawn(process.execPath, [
    vitest,
    'run',
    '--config',
    'vitest.contract.config.ts',
    '--no-file-parallelism',
    ...files
  ], { stdio: 'inherit' });
  await new Promise<void>((resolve) => {
    child.once('exit', (code) => {
      process.exitCode = code ?? 1;
      resolve();
    });
    child.once('error', () => {
      process.stderr.write('CONTRACT_RUNNER_FAILED\n');
      process.exitCode = 1;
      resolve();
    });
  });
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(invokedPath).href === import.meta.url) {
  void main();
}
