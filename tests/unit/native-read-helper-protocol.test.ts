import { describe, expect, it } from 'vitest';
import { decodeNativeReadResponse, MAX_FILE_BYTES } from '../../src/server/vault/native-read-helper-protocol.js';

const root = { dev: '1', ino: '2' };
function frame(header: Record<string, unknown>, payload = Buffer.alloc(0)): Buffer {
  const json = Buffer.from(JSON.stringify({ v: 1, ok: true, command: 'read-file', root, payloadLength: payload.length, ...header }));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(json.length);
  return Buffer.concat([prefix, json, payload]);
}

describe('bounded native response protocol', () => {
  it('returns byte-exact data and validates bound root', () => {
    const bytes = Buffer.from('\ufeff中文\r\n末行');
    expect(decodeNativeReadResponse(frame({}, bytes), 'read-file', root).payload).toEqual(bytes);
    expect(() => decodeNativeReadResponse(frame({}, bytes), 'read-file', { dev: '1', ino: '3' })).toThrow('ROOT_IDENTITY_CHANGED');
  });
  it.each([
    Buffer.alloc(3),
    Buffer.from([0, 1, 0, 1]),
    frame({ payloadLength: 1 }),
    Buffer.concat([frame({}), Buffer.from('extra')]),
    frame({ extra: true }),
    frame({ root: { dev: 1, ino: '2' } }),
    frame({ command: 'write-file' }),
    frame({ payloadLength: MAX_FILE_BYTES + 1 })
  ])('rejects malformed/truncated/extra frames', (bytes) => {
    expect(() => decodeNativeReadResponse(bytes, 'read-file', root)).toThrow('NATIVE_PROTOCOL_INVALID');
  });
  it('decodes names from exact UTF-8 hex bytes sorted by those bytes', () => {
    const names = ['Cafe\u0301.md', 'Café.md', '转化率100%.md'];
    const entries = names.map((name) => ({ nameHex: Buffer.from(name).toString('hex'), kind: 'file' }));
    const decoded = decodeNativeReadResponse(frame({ command: 'list-dir' }, Buffer.from(JSON.stringify(entries))), 'list-dir', root);
    expect(decoded.entries?.map((entry) => entry.name)).toEqual(names);
  });
  it.each(['ff', 'c080', 'eda080', '2e', '2e68696464656e', '612f62', '615c62', '610062'])('rejects unsafe name bytes %s', (nameHex) => {
    const bytes = frame({ command: 'list-dir' }, Buffer.from(JSON.stringify([{ nameHex, kind: 'file' }])));
    expect(() => decodeNativeReadResponse(bytes, 'list-dir', root)).toThrow('NATIVE_PROTOCOL_INVALID');
  });
  it('rejects duplicate, unsorted, special, oversized list responses', () => {
    for (const entries of [
      [{ nameHex: '61', kind: 'file' }, { nameHex: '61', kind: 'file' }],
      [{ nameHex: '62', kind: 'file' }, { nameHex: '61', kind: 'file' }],
      [{ nameHex: '61', kind: 'symlink' }],
      Array.from({ length: 20_001 }, () => ({ nameHex: '61', kind: 'file' }))
    ]) {
      expect(() => decodeNativeReadResponse(frame({ command: 'list-dir' }, Buffer.from(JSON.stringify(entries))), 'list-dir', root)).toThrow('NATIVE_PROTOCOL_INVALID');
    }
  });
  it('accepts only bounded sanitized error codes', () => {
    const header = Buffer.from(JSON.stringify({ v: 1, ok: false, error: 'VERSION_CONFLICT', payloadLength: 0 }));
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(header.length);
    expect(() => decodeNativeReadResponse(Buffer.concat([prefix, header]), 'read-file', root)).toThrow('VERSION_CONFLICT');
    expect(() => decodeNativeReadResponse(frame({ ok: false, error: '/secret/path' }), 'read-file', root)).toThrow('NATIVE_PROTOCOL_INVALID');
  });
});
