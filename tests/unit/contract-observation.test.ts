import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VaultGateway, VersionedBytes } from '../../src/server/vault/VaultGateway.js';
import { pollForObservation, waitForRawObservation } from '../helpers/contract-observation.js';

function gateway(readRaw: () => Promise<VersionedBytes>): VaultGateway {
  return {
    fingerprint: async () => ({ pluginId: 'test', pluginVersion: '5.1.0', obsidianVersion: '1.0.0' }),
    listDirectory: async () => [],
    readOpenApi: async () => '',
    readRaw
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('pollForObservation', () => {
  it('retries transient errors and false checks until an observation succeeds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let attempts = 0;
    const result = pollForObservation({
      check: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('not visible');
        return attempts === 3;
      },
      timeoutMs: 100,
      intervalMs: 10
    });

    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe(true);
    expect(attempts).toBe(3);
    expect(Date.now()).toBe(20);
  });

  it('returns at the overall deadline when one check never settles', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let attempts = 0;
    const result = pollForObservation({
      check: () => {
        attempts += 1;
        return new Promise<boolean>(() => {});
      },
      timeoutMs: 15_000,
      intervalMs: 200
    });

    let settled = false;
    void result.finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(false);
    expect(attempts).toBe(1);
  });

  it('bounds the final wait by the remaining overall deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let attempts = 0;
    const result = pollForObservation({
      check: async () => {
        attempts += 1;
        return false;
      },
      timeoutMs: 250,
      intervalMs: 200
    });

    let settled = false;
    void result.finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(249);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(false);
    expect(attempts).toBe(2);
  });
});

describe('waitForRawObservation', () => {
  it('polls through missing/stale reads until the expected raw hash and version are observable', async () => {
    let attempt = 0;
    let clock = 0;
    const observed = await waitForRawObservation({
      gateway: gateway(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('not visible');
        return {
          path: 'note.md',
          bytes: new TextEncoder().encode(attempt === 2 ? 'old' : 'new'),
          rawSha256: attempt === 2 ? 'old-hash' : 'expected-hash',
          ...(attempt === 3 ? { upstreamVersion: 'version-1' } : {})
        };
      }),
      path: 'note.md',
      expectedRawSha256: 'expected-hash',
      requireVersion: true,
      timeoutMs: 10,
      intervalMs: 1,
      now: () => clock,
      wait: async (milliseconds) => { clock += milliseconds; }
    });

    expect(attempt).toBe(3);
    expect(observed.upstreamVersion).toBe('version-1');
  });

  it('fails with a sanitized stable code after the observation deadline', async () => {
    let clock = 0;
    await expect(waitForRawObservation({
      gateway: gateway(async () => { throw new Error('/private/formal/secret.md'); }),
      path: 'note.md',
      expectedRawSha256: 'expected-hash',
      timeoutMs: 2,
      intervalMs: 1,
      now: () => clock,
      wait: async (milliseconds) => { clock += milliseconds; }
    })).rejects.toEqual(new Error('CONTRACT_OBSERVATION_TIMEOUT'));
  });

  it('bounds a readRaw call that never settles', async () => {
    const result = waitForRawObservation({
      gateway: gateway(() => new Promise<VersionedBytes>(() => {})),
      path: 'note.md',
      expectedRawSha256: 'expected-hash',
      timeoutMs: 5,
      intervalMs: 1
    });

    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(Promise.race([
        result,
        new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(() => reject(new Error('TEST_TIMEOUT')), 100);
        })
      ])).rejects.toEqual(new Error('CONTRACT_OBSERVATION_TIMEOUT'));
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
    }
  });

  it('bounds the final raw-observation wait by the remaining deadline', async () => {
    let clock = 0;
    const waits: number[] = [];
    await expect(waitForRawObservation({
      gateway: gateway(async () => { throw new Error('not visible'); }),
      path: 'note.md',
      expectedRawSha256: 'expected-hash',
      timeoutMs: 250,
      intervalMs: 200,
      now: () => clock,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        clock += milliseconds;
      }
    })).rejects.toEqual(new Error('CONTRACT_OBSERVATION_TIMEOUT'));
    expect(waits).toEqual([200, 50]);
  });
});
