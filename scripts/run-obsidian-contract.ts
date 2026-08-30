import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CONTRACT_ROOT = 'tests/contract/obsidian-local-rest-5.1.0';
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

type ForwardedSignal = typeof FORWARDED_SIGNALS[number];

interface ContractChildProcess {
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  once(event: 'error', listener: (error: Error) => void): this;
  kill(signal: ForwardedSignal): boolean;
}

interface ContractSignalSource {
  on(signal: ForwardedSignal, listener: () => void): unknown;
  removeListener(signal: ForwardedSignal, listener: () => void): unknown;
}

interface VitestFileRunnerDependencies {
  spawnProcess?: (
    command: string,
    arguments_: string[],
    options: { stdio: 'inherit' }
  ) => ContractChildProcess;
  signalSource?: ContractSignalSource;
  writeStderr?: (message: string) => void;
}

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

export async function runVitestFile(
  file: string,
  dependencies: VitestFileRunnerDependencies = {}
): Promise<number> {
  const vitest = join(process.cwd(), 'node_modules/vitest/vitest.mjs');
  const spawnProcess: NonNullable<VitestFileRunnerDependencies['spawnProcess']> =
    dependencies.spawnProcess ?? ((command, arguments_, options) => (
      spawn(command, arguments_, options)
    ));
  const signalSource = dependencies.signalSource ?? process;
  const writeStderr = dependencies.writeStderr ?? ((message: string) => {
    process.stderr.write(message);
  });
  const child = spawnProcess(process.execPath, [
    vitest,
    'run',
    '--config',
    'vitest.contract.config.ts',
    '--no-file-parallelism',
    file
  ], { stdio: 'inherit' });
  return new Promise<number>((resolve) => {
    let settled = false;
    let runnerFailed = false;
    const signalListeners = new Map<ForwardedSignal, () => void>();
    const removeSignalListeners = (): void => {
      for (const [signal, listener] of signalListeners) {
        signalSource.removeListener(signal, listener);
      }
      signalListeners.clear();
    };
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      removeSignalListeners();
      resolve(code);
    };
    const finishFromChild = (code: number | null): void => {
      finish(runnerFailed ? 1 : code ?? 1);
    };
    child.once('exit', finishFromChild);
    child.once('close', finishFromChild);
    child.once('error', () => {
      runnerFailed = true;
      writeStderr('CONTRACT_RUNNER_FAILED\n');
    });
    for (const signal of FORWARDED_SIGNALS) {
      const listener = (): void => {
        child.kill(signal);
      };
      signalListeners.set(signal, listener);
      signalSource.on(signal, listener);
    }
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
