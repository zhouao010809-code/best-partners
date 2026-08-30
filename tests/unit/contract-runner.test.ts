import { describe, expect, it } from 'vitest';
import { selectContractFiles } from '../../scripts/run-obsidian-contract.js';

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
});
