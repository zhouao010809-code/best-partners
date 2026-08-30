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

export async function runContractSelection(
  arguments_: ReadonlyArray<string>,
  runFile: (file: string) => Promise<number>
): Promise<number> {
  const files = selectContractFiles(arguments_);
  for (const file of files) {
    let exitCode: number;
    try {
      exitCode = await runFile(file);
    } catch {
      return 1;
    }
    if (exitCode !== 0) {
      return exitCode;
    }
  }
  return 0;
}

async function runVitestFile(file: string): Promise<number> {
  const vitest = join(process.cwd(), 'node_modules/vitest/vitest.mjs');
  const child = spawn(process.execPath, [
    vitest,
    'run',
    '--config',
    'vitest.contract.config.ts',
    '--no-file-parallelism',
    file
  ], { stdio: 'inherit' });
  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    child.once('exit', (code) => finish(code ?? 1));
    child.once('error', () => {
      process.stderr.write('CONTRACT_RUNNER_FAILED\n');
      finish(1);
    });
  });
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runContractSelection(process.argv.slice(2), runVitestFile);
  } catch {
    process.stderr.write('CONTRACT_SELECTION_INVALID\n');
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(invokedPath).href === import.meta.url) {
  void main();
}
