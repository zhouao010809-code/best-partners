import { describe, expect, it } from 'vitest';
import { decodeNativeMessage, encodeNativeMessage } from '../../src/electron/clipper-host.js';

describe('clipper native messaging framing', () => {
  it('uses a little endian four byte length prefix', () => {
    const frame = encodeNativeMessage({ ok: true });
    expect(frame.readUInt32LE(0)).toBe(frame.length - 4);
    expect(decodeNativeMessage(frame)).toEqual({ ok: true });
  });
  it('rejects truncated frames', () => {
    expect(() => decodeNativeMessage(Buffer.from([1, 0, 0, 0]))).toThrow();
  });
});
