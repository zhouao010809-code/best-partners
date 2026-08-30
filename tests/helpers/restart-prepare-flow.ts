import type { RestartPending } from './restart-pending.js';

export async function runRestartPrepareFlow(input: {
  readonly prepareObservedRecord: () => Promise<RestartPending>;
  readonly updateProfile: () => Promise<unknown>;
  readonly writePending: (pending: RestartPending) => Promise<unknown>;
  readonly writeCleanup: (
    pending: RestartPending,
    cleanup: { readonly status: 'unverified'; readonly reasonCode: 'MANUAL_CLEANUP_REQUIRED' }
  ) => Promise<unknown>;
}): Promise<RestartPending> {
  let pending: RestartPending | undefined;
  try {
    pending = await input.prepareObservedRecord();
    await input.updateProfile();
    await input.writePending(pending);
    return pending;
  } catch (error) {
    if (pending !== undefined) {
      try {
        await input.writeCleanup(pending, {
          status: 'unverified',
          reasonCode: 'MANUAL_CLEANUP_REQUIRED'
        });
      } catch {
        throw new Error('RESTART_PREPARE_ORPHAN_RECORD_FAILED');
      }
    }
    throw error;
  }
}
