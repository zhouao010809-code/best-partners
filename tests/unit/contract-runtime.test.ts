import { describe, expect, it } from 'vitest';
import {
  assertSandboxVaultPath,
  contractSandboxRoots,
  requireContractEnvironment
} from '../helpers/contract-runtime.js';

const RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('contract runtime path guard', () => {
  it('constructs only the two approved ULID sandbox roots', () => {
    expect(contractSandboxRoots(RUN_ID)).toEqual({
      library: `01图书馆/来自其他/__xiaozhao_contract__/${RUN_ID}`,
      knowledge: `02知识库/99其他/__xiaozhao_contract__/${RUN_ID}`
    });
  });

  it('accepts descendants and rejects traversal, sibling, malformed ULID, and root files', () => {
    const roots = contractSandboxRoots(RUN_ID);
    expect(assertSandboxVaultPath(`${roots.library}/note.md`, RUN_ID)).toBe(`${roots.library}/note.md`);
    expect(assertSandboxVaultPath(`${roots.knowledge}/nested/note.md`, RUN_ID))
      .toBe(`${roots.knowledge}/nested/note.md`);
    for (const path of [
      roots.library,
      `${roots.library}/../escape.md`,
      `01图书馆/来自其他/__xiaozhao_contract__/OTHER/note.md`,
      '__XIAOZHAO_TEST_VAULT__'
    ]) {
      expect(() => assertSandboxVaultPath(path, RUN_ID)).toThrowError('CONTRACT_PATH_NOT_ALLOWED');
    }
    expect(() => contractSandboxRoots('not-a-ulid')).toThrowError('CONTRACT_RUN_ID_INVALID');
  });
});

describe('contract environment', () => {
  it('fails with one sanitized code when any required context is absent', () => {
    expect(() => requireContractEnvironment({})).toThrowError('CONTRACT_CONTEXT_MISSING');
    expect(() => requireContractEnvironment({ OBSIDIAN_API_KEY: 'secret-only' }))
      .toThrowError('CONTRACT_CONTEXT_MISSING');
  });
});
