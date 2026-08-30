import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  runContractSelection,
  runVitestFile,
  selectContractFiles
} from '../../scripts/run-obsidian-contract.js';

class FakeChildProcess extends EventEmitter {
  readonly forwardedSignals: NodeJS.Signals[] = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    if (typeof signal === 'string') {
      this.forwardedSignals.push(signal);
    }
    return true;
  }
}

describe('Obsidian contract runner selection', () => {
  it('selects read plus guarded write, but no restart files, when no filter is supplied', () => {
    expect(selectContractFiles([])).toEqual([
      'tests/contract/obsidian-local-rest-5.1.0/read.contract.test.ts',
      'tests/contract/obsidian-local-rest-5.1.0/write-gate.contract.test.ts'
    ]);
  });

  it('selects only the read contract for the documented read filter', () => {
    expect(selectContractFiles(['read'])).toEqual([
      'tests/contract/obsidian-local-rest-5.1.0/read.contract.test.ts'
    ]);
  });

  it('selects the guarded write file explicitly and rejects unknown filters', () => {
    expect(selectContractFiles(['write'])).toEqual([
      'tests/contract/obsidian-local-rest-5.1.0/write-gate.contract.test.ts'
    ]);
    expect(() => selectContractFiles(['unknown'])).toThrowError('CONTRACT_SELECTION_INVALID');
    expect(() => selectContractFiles(['read', 'write'])).toThrowError('CONTRACT_SELECTION_INVALID');
  });

  it('runs read then write as separate fail-stop invocations in no-argument mode', async () => {
    const calls: string[] = [];
    const exitCode = await runContractSelection([], async (file) => {
      calls.push(file);
      return file.includes('read.contract') ? 7 : 0;
    });
    expect(exitCode).toBe(7);
    expect(calls).toEqual([
      'tests/contract/obsidian-local-rest-5.1.0/read.contract.test.ts'
    ]);
  });

  it('starts write only after read succeeds and propagates the write exit code', async () => {
    const calls: string[] = [];
    const exitCode = await runContractSelection([], async (file) => {
      calls.push(file);
      return file.includes('write-gate') ? 9 : 0;
    });
    expect(exitCode).toBe(9);
    expect(calls).toEqual(selectContractFiles([]));
  });

  it('runs a single selected file and turns runner errors into exit 1', async () => {
    const readCalls: string[] = [];
    await expect(runContractSelection(['read'], async (file) => {
      readCalls.push(file);
      return 0;
    })).resolves.toBe(0);
    expect(readCalls).toEqual(selectContractFiles(['read']));

    const failedCalls: string[] = [];
    await expect(runContractSelection([], async (file) => {
      failedCalls.push(file);
      throw new Error('private runner failure');
    })).resolves.toBe(1);
    expect(failedCalls).toEqual(selectContractFiles(['read']));
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
    'forwards %s to the active child and waits for its exit before resolving',
    async (signal) => {
      const child = new FakeChildProcess();
      const signalSource = new EventEmitter();
      const resultPromise = runVitestFile('read.contract.test.ts', {
        spawnProcess: () => child,
        signalSource,
        writeStderr: vi.fn()
      });
      let settled = false;
      void resultPromise.then(() => {
        settled = true;
      });

      signalSource.emit(signal);
      await Promise.resolve();

      expect(child.forwardedSignals).toEqual([signal]);
      expect(settled).toBe(false);

      child.emit('exit', null, signal);

      await expect(resultPromise).resolves.toBe(1);
      expect(signalSource.listenerCount('SIGINT')).toBe(0);
      expect(signalSource.listenerCount('SIGTERM')).toBe(0);
      expect(signalSource.listenerCount('SIGHUP')).toBe(0);

      signalSource.emit(signal);
      expect(child.forwardedSignals).toEqual([signal]);
    }
  );

  it('propagates a child nonzero exit and never spawns write after read fails', async () => {
    const child = new FakeChildProcess();
    const signalSource = new EventEmitter();
    const spawnProcess = vi.fn(() => child);
    const resultPromise = runContractSelection([], (file) => runVitestFile(file, {
      spawnProcess,
      signalSource,
      writeStderr: vi.fn()
    }));

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    child.emit('exit', 7, null);

    await expect(resultPromise).resolves.toBe(7);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it('turns a child runner error into exit 1, cleans listeners, and never starts write', async () => {
    const child = new FakeChildProcess();
    const signalSource = new EventEmitter();
    const spawnProcess = vi.fn(() => child);
    const writeStderr = vi.fn();
    const resultPromise = runContractSelection([], (file) => runVitestFile(file, {
      spawnProcess,
      signalSource,
      writeStderr
    }));
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });

    child.emit('error', new Error('private spawn failure'));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(settled).toBe(false);
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    child.emit('close', 0, null);

    await expect(resultPromise).resolves.toBe(1);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(writeStderr).toHaveBeenCalledWith('CONTRACT_RUNNER_FAILED\n');
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
    expect(signalSource.listenerCount('SIGHUP')).toBe(0);
  });
});
