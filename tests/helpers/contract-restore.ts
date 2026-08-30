import { createHash } from 'node:crypto';
import type { VersionedBytes } from '../../src/server/vault/VaultGateway.js';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function prepareConditionalRestore(input: {
  readonly beforeBytes: Uint8Array;
  readonly after: VersionedBytes;
  readonly current: VersionedBytes;
}): { readonly version: string; readonly content: string; readonly beforeRawSha256: string } | undefined {
  const beforeRawSha256 = sha256(input.beforeBytes);
  if (
    input.after.upstreamVersion === undefined
    || input.after.rawSha256 === beforeRawSha256
    || input.current.rawSha256 !== input.after.rawSha256
    || input.current.upstreamVersion !== input.after.upstreamVersion
    || sha256(input.current.bytes) !== input.current.rawSha256
  ) {
    return undefined;
  }
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(input.beforeBytes);
    if (!sameBytes(new TextEncoder().encode(content), input.beforeBytes)) return undefined;
    return { version: input.after.upstreamVersion, content, beforeRawSha256 };
  } catch {
    return undefined;
  }
}
