import { AppError } from '../../shared/api/errors.js';

export const MAX_HEADER_BYTES = 64 * 1024;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_LIST_BYTES = 12 * 1024 * 1024;
export const MAX_FRAME_BYTES = 4 + MAX_HEADER_BYTES + MAX_LIST_BYTES;
export type NativeReadCommand = 'probe-root' | 'list-dir' | 'read-file' | 'stat-file';
export type RootIdentity = { readonly dev: string; readonly ino: string };
export type NativeDirectoryEntry = { readonly name: string; readonly kind: 'file' | 'directory' };
export type NativeReadResponse = {
  readonly root: RootIdentity;
  readonly payload: Buffer;
  readonly entries?: readonly NativeDirectoryEntry[];
  readonly kind?: 'file' | 'directory';
};

const ERRORS = new Set(['PATH_NOT_ALLOWED', 'ROOT_IDENTITY_CHANGED', 'VERSION_CONFLICT',
  'NOT_FOUND', 'TYPE_MISMATCH', 'FILE_TOO_LARGE', 'DIRECTORY_TOO_LARGE', 'READ_FAILED', 'INVALID_ARGUMENT']);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function invalid(): never {
  throw new AppError('NATIVE_PROTOCOL_INVALID', 'NATIVE_PROTOCOL_INVALID', 502);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function canonicalJson(bytes: Uint8Array): unknown {
  try {
    const text = decoder.decode(bytes);
    const parsed: unknown = JSON.parse(text);
    // The helper emits canonical compact JSON. This also rejects duplicate keys.
    if (JSON.stringify(parsed) !== text) invalid();
    return parsed;
  } catch { return invalid(); }
}

function identity(value: unknown): value is RootIdentity {
  return object(value) && keys(value, ['dev', 'ino'])
    && [value.dev, value.ino].every((part) => typeof part === 'string'
      && /^(0|[1-9][0-9]{0,19})$/u.test(part) && BigInt(part) <= 18_446_744_073_709_551_615n);
}

export function decodeNativeReadResponse(
  frame: Buffer,
  command: NativeReadCommand,
  expectedRoot?: RootIdentity
): NativeReadResponse {
  if (frame.length < 4 || frame.length > MAX_FRAME_BYTES) invalid();
  const headerLength = frame.readUInt32BE(0);
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES || frame.length < 4 + headerLength) invalid();
  const header = canonicalJson(frame.subarray(4, 4 + headerLength));
  if (!object(header) || header.v !== 1 || !Number.isSafeInteger(header.payloadLength)
    || (header.payloadLength as number) < 0 || frame.length !== 4 + headerLength + Number(header.payloadLength)) invalid();
  if (header.ok === false) {
    if (!keys(header, ['v', 'ok', 'error', 'payloadLength']) || header.payloadLength !== 0
      || typeof header.error !== 'string' || !ERRORS.has(header.error)) invalid();
    throw new AppError(header.error, header.error, header.error === 'VERSION_CONFLICT' ? 409 : 400);
  }
  const expectedKeys = ['v', 'ok', 'command', 'root', 'payloadLength', ...(command === 'stat-file' ? ['kind'] : [])];
  if (header.ok !== true || !keys(header, expectedKeys) || header.command !== command || !identity(header.root)) invalid();
  if (expectedRoot && (header.root.dev !== expectedRoot.dev || header.root.ino !== expectedRoot.ino)) {
    throw new AppError('ROOT_IDENTITY_CHANGED', 'ROOT_IDENTITY_CHANGED', 409);
  }
  const payload = frame.subarray(4 + headerLength);
  if (command === 'read-file') {
    if (payload.length > MAX_FILE_BYTES) invalid();
    return { root: header.root, payload };
  }
  if (command === 'list-dir') {
    if (payload.length > MAX_LIST_BYTES) invalid();
    const list = canonicalJson(payload);
    if (!Array.isArray(list) || list.length > 20_000) invalid();
    let previous: Buffer | undefined;
    const entries = list.map((entry: unknown): NativeDirectoryEntry => {
      if (!object(entry) || !keys(entry, ['nameHex', 'kind']) || typeof entry.nameHex !== 'string'
        || !/^(?:[0-9a-f]{2}){1,255}$/u.test(entry.nameHex)
        || (entry.kind !== 'file' && entry.kind !== 'directory')) invalid();
      const bytes = Buffer.from(entry.nameHex, 'hex');
      if (previous && Buffer.compare(previous, bytes) >= 0) invalid();
      previous = bytes;
      let name: string;
      try { name = decoder.decode(bytes); } catch { return invalid(); }
      if (name.startsWith('.') || name.includes('/') || name.includes('\\') || name.includes('\0')) invalid();
      return { name, kind: entry.kind };
    });
    return { root: header.root, payload, entries };
  }
  if (payload.length !== 0) invalid();
  if (command === 'stat-file') {
    if (header.kind !== 'file' && header.kind !== 'directory') invalid();
    return { root: header.root, payload, kind: header.kind };
  }
  return { root: header.root, payload };
}
