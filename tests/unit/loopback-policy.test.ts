import { describe, expect, it } from 'vitest';
import { createLoopbackPolicy } from '../../src/server/security/loopback-policy.js';

describe('bound loopback HTTP authority', () => {
  it('rejects all hosts and explicit origins until a runtime origin is bound', () => {
    const policy = createLoopbackPolicy();
    expect(policy.isAllowedHost('127.0.0.1:43210')).toBe(false);
    expect(policy.isAllowedOrigin('http://127.0.0.1:43210')).toBe(false);
    expect(policy.isAllowedOrigin(undefined)).toBe(true);
    expect(policy.isAllowedOrigin(undefined, true)).toBe(false);
    policy.bind('http://127.0.0.1:43210');
    expect(policy.isAllowedHost('127.0.0.1:43210')).toBe(true);
    expect(policy.isAllowedOrigin('http://127.0.0.1:43210', true)).toBe(true);
    expect(policy.isAllowedHost('127.0.0.1:4317')).toBe(false);
    expect(policy.isAllowedOrigin('http://127.0.0.1:5173')).toBe(false);
    expect(() => policy.bind('http://127.0.0.1:43210')).toThrow('LOOPBACK_POLICY_ALREADY_BOUND');
  });

  it.each([
    'http://localhost:1234', 'http://192.168.1.1:1234', 'https://127.0.0.1:1234',
    'http://127.0.0.1', 'http://127.0.0.1:0', 'http://user@127.0.0.1:1234',
    'http://127.0.0.1:1234/', 'http://127.0.0.1:1234/path',
    'http://127.0.0.1:1234?query', 'http://127.0.0.1:1234#hash',
    'http://127.0.0.1:0012', 'http://127.0.0.1:65536'
  ])('rejects an invalid runtime origin %s', (origin) => {
    expect(() => createLoopbackPolicy().bind(origin)).toThrow('INVALID_LOOPBACK_ORIGIN');
  });
});
