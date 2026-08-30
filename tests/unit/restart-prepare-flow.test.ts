import { describe, expect, it, vi } from 'vitest';
import type { RestartPending } from '../helpers/restart-pending.js';
import { runRestartPrepareFlow } from '../helpers/restart-prepare-flow.js';

function pending(): RestartPending {
  return {
    schemaVersion: 1,
    phase: 'prepared',
    runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    root: 'library',
    noteId: 'restart.md',
    rawSha256: 'a'.repeat(64),
    upstreamVersion: 'version-token:1',
    profileKey: 'b'.repeat(64)
  };
}

describe('restart prepare flow', () => {
  it.each(['profile update', 'pending write'] as const)(
    'persists a sanitized cleanup record when %s fails after note observation',
    async (failurePoint) => {
      const record = pending();
      const writeCleanup = vi.fn(async () => {});
      const writePending = vi.fn(async () => {
        if (failurePoint === 'pending write') throw new Error('PENDING_WRITE_FAILED');
      });

      await expect(runRestartPrepareFlow({
        prepareObservedRecord: async () => record,
        updateProfile: async () => {
          if (failurePoint === 'profile update') throw new Error('CONTRACT_PROFILE_CONFLICT');
        },
        writePending,
        writeCleanup
      })).rejects.toThrowError(
        failurePoint === 'profile update' ? 'CONTRACT_PROFILE_CONFLICT' : 'PENDING_WRITE_FAILED'
      );
      expect(writeCleanup).toHaveBeenCalledWith(record, {
        status: 'unverified',
        reasonCode: 'MANUAL_CLEANUP_REQUIRED'
      });
    }
  );

  it('does not invent an orphan record when note observation fails before identifiers exist', async () => {
    const writeCleanup = vi.fn(async () => {});
    await expect(runRestartPrepareFlow({
      prepareObservedRecord: async () => { throw new Error('CONTRACT_OBSERVATION_TIMEOUT'); },
      updateProfile: async () => {},
      writePending: async () => {},
      writeCleanup
    })).rejects.toThrowError('CONTRACT_OBSERVATION_TIMEOUT');
    expect(writeCleanup).not.toHaveBeenCalled();
  });

  it('fails with a stable code if the orphan cleanup record cannot be persisted', async () => {
    await expect(runRestartPrepareFlow({
      prepareObservedRecord: async () => pending(),
      updateProfile: async () => { throw new Error('CONTRACT_PROFILE_CONFLICT'); },
      writePending: async () => {},
      writeCleanup: async () => { throw new Error('/private/secret path'); }
    })).rejects.toThrowError('RESTART_PREPARE_ORPHAN_RECORD_FAILED');
  });
});
