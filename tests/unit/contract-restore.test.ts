import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { VersionedBytes } from '../../src/server/vault/VaultGateway.js';
import { prepareConditionalRestore } from '../helpers/contract-restore.js';

function state(bytes: Uint8Array, version: string): VersionedBytes {
  return {
    path: 'note.md',
    bytes,
    rawSha256: createHash('sha256').update(bytes).digest('hex'),
    upstreamVersion: version
  };
}

describe('prepareConditionalRestore', () => {
  it('returns the complete original text only when current still exactly matches the after state', () => {
    const beforeBytes = new TextEncoder().encode('# Contract\nbefore\n');
    const after = state(new TextEncoder().encode('# Contract\nwinner\n'), 'version-2');
    const prepared = prepareConditionalRestore({ beforeBytes, after, current: after });

    expect(prepared).toEqual({
      version: 'version-2',
      content: '# Contract\nbefore\n',
      beforeRawSha256: createHash('sha256').update(beforeBytes).digest('hex')
    });
    expect(prepared?.content).not.toBe('before');
  });

  it('refuses an unchanged before/after state or a changed current hash/version', () => {
    const beforeBytes = new TextEncoder().encode('# Contract\nbefore\n');
    const before = state(beforeBytes, 'version-1');
    const after = state(new TextEncoder().encode('# Contract\nwinner\n'), 'version-2');
    expect(prepareConditionalRestore({ beforeBytes, after: before, current: before })).toBeUndefined();
    expect(prepareConditionalRestore({
      beforeBytes,
      after,
      current: state(new TextEncoder().encode('# Contract\nexternal\n'), 'version-2')
    })).toBeUndefined();
    expect(prepareConditionalRestore({
      beforeBytes,
      after,
      current: { ...after, upstreamVersion: 'version-3' }
    })).toBeUndefined();
  });
});
