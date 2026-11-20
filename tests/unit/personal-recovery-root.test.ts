import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { selectPersonalRecoveryRoot } from '../../src/server/archive/personal-recovery-root.js';

vi.mock('node:fs', async importActual => {
  const actual = await importActual<typeof import('node:fs')>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});

const temporary: string[] = [];
function fixture() {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'vault-recovery-test-'));
  temporary.push(parent);
  const vault = join(parent, 'vault'), data = join(parent, 'data');
  for (const path of [vault, data]) mkdirSync(path);
  return { parent, vault, data };
}
function otherDevice(data: string) {
  // Simulate just the application's device number; verify all vault-volume operations on disk.
  vi.mocked(lstatSync).mockImplementation((path, options) => {
    const entry = statOriginal(path, options);
    if (path === data && options && 'bigint' in options && options.bigint) {
      return Object.assign(entry, { dev: BigInt(entry.dev) + 1n });
    }
    return entry;
  });
}
const { lstatSync: statOriginal } = await vi.importActual<typeof import('node:fs')>('node:fs');
afterEach(() => {
  vi.mocked(lstatSync).mockImplementation(statOriginal);
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true });
});

describe('personal recovery placement', () => {
  it('keeps existing same-volume journals at their current location', () => {
    const { vault, data } = fixture();
    expect(selectPersonalRecoveryRoot(vault, data)).toBe(data);
  });

  it('uses a private, stable sibling per vault on a different volume', () => {
    const { parent, vault, data } = fixture();
    otherDevice(data);
    const sibling = selectPersonalRecoveryRoot(vault, data);
    expect(dirname(sibling)).toBe(join(parent, '.xiaozhao-personal-recovery'));
    expect(statSync(sibling).mode & 0o777).toBe(0o700);
    expect(selectPersonalRecoveryRoot(vault, data)).toBe(sibling);
    const next = join(parent, 'second-vault'); mkdirSync(next);
    expect(selectPersonalRecoveryRoot(next, data)).not.toBe(sibling);
  });

  it('rejects an existing recovery link', () => {
    const { parent, vault, data } = fixture();
    otherDevice(data);
    symlinkSync(data, join(parent, '.xiaozhao-personal-recovery'));
    expect(() => selectPersonalRecoveryRoot(vault, data)).toThrow('UNSAFE_RECOVERY_DIRECTORY');
  });
});
