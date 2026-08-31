import { describe, expect, it, vi } from 'vitest';
import type {
  PreparedRestartPending,
  PreparingRestartPending,
  RestartPending
} from '../helpers/restart-pending.js';
import {
  selectRestartPreparation,
  confirmPreparedRestartBlocked,
  runRestartPrepareFlow
} from '../helpers/restart-prepare-flow.js';

function preparing(): PreparingRestartPending {
  return {
    schemaVersion: 1,
    phase: 'preparing',
    runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    root: 'library',
    noteId: 'restart.md',
    rawSha256: 'a'.repeat(64),
    profileKey: 'b'.repeat(64),
    manualCleanupReasonCode: 'MANUAL_CLEANUP_REQUIRED'
  };
}

function prepared(value: PreparingRestartPending): PreparedRestartPending {
  return { ...value, phase: 'prepared', upstreamVersion: 'version-token:1' };
}

describe('restart prepare flow', () => {
  it('does not announce a prepared restart until the current profile is blocked again', async () => {
    const announce = vi.fn();
    await expect(confirmPreparedRestartBlocked({
      blockProfile: async () => { throw new Error('CONTRACT_PROFILE_CONFLICT'); },
      announce
    })).rejects.toThrowError('CONTRACT_PROFILE_CONFLICT');
    expect(announce).not.toHaveBeenCalled();

    await expect(confirmPreparedRestartBlocked({
      blockProfile: async () => {},
      announce
    })).resolves.toBeUndefined();
    expect(announce).toHaveBeenCalledOnce();
  });

  it('reuses an exact active preparing identity instead of allocating a new run', () => {
    const active = preparing();
    const fresh = { ...preparing(), runId: '01ARZ3NDEKTSV4RRFFQ69G5FAW' };
    expect(selectRestartPreparation(active, fresh)).toEqual(active);
    expect(selectRestartPreparation(undefined, fresh)).toEqual(fresh);
  });

  it.each([
    { ...prepared(preparing()) },
    { ...preparing(), profileKey: 'c'.repeat(64) },
    { ...preparing(), rawSha256: 'c'.repeat(64) }
  ] as RestartPending[])(
    'refuses to replace another active restart identity',
    (active) => {
      expect(() => selectRestartPreparation(active, preparing()))
        .toThrowError('RESTART_PENDING_ALREADY_ACTIVE');
    }
  );

  it('blocks the profile, then durably records identity, before test-vault mutation', async () => {
    const order: string[] = [];
    const wal = preparing();
    await expect(runRestartPrepareFlow({
      preparing: wal,
      writePreparing: async () => { order.push('wal'); },
      blockProfile: async () => { order.push('profile-blocked'); },
      mutateAndObserve: async () => {
        order.push('mutate');
        return { rawSha256: wal.rawSha256, upstreamVersion: 'version-token:1' };
      },
      markPrepared: async (current) => {
        order.push('prepared');
        return prepared(current);
      }
    })).resolves.toMatchObject({ phase: 'prepared' });
    expect(order).toEqual(['profile-blocked', 'wal', 'mutate', 'prepared']);
  });

  it.each(['wal', 'profile-blocked', 'mutate', 'prepared'] as const)(
    'never runs a later phase when %s fails',
    async (failurePoint) => {
      const order: string[] = [];
      const step = async (name: typeof failurePoint): Promise<void> => {
        order.push(name);
        if (name === failurePoint) throw new Error(`FAIL_${name}`);
      };
      const wal = preparing();
      await expect(runRestartPrepareFlow({
        preparing: wal,
        writePreparing: async () => step('wal'),
        blockProfile: async () => step('profile-blocked'),
        mutateAndObserve: async () => {
          await step('mutate');
          return { rawSha256: wal.rawSha256, upstreamVersion: 'version-token:1' };
        },
        markPrepared: async (current) => {
          await step('prepared');
          return prepared(current);
        }
      })).rejects.toThrowError(`FAIL_${failurePoint}`);
      expect(order.at(-1)).toBe(failurePoint);
    }
  );

  it('retains the preparing identity when observation times out', async () => {
    const wal = preparing();
    const writePreparing = vi.fn(async () => {});
    const markPrepared = vi.fn(async () => prepared(wal));
    await expect(runRestartPrepareFlow({
      preparing: wal,
      writePreparing,
      blockProfile: async () => {},
      mutateAndObserve: async () => { throw new Error('CONTRACT_OBSERVATION_TIMEOUT'); },
      markPrepared
    })).rejects.toThrowError('CONTRACT_OBSERVATION_TIMEOUT');
    expect(writePreparing).toHaveBeenCalledWith(wal);
    expect(markPrepared).not.toHaveBeenCalled();
  });
});
