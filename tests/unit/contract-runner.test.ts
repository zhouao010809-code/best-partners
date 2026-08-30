import { describe, expect, it } from 'vitest';
import {
  runContractSelection,
  selectContractFiles
} from '../../scripts/run-obsidian-contract.js';

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
});
