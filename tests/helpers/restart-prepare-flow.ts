import type {
  PreparedRestartPending,
  PreparingRestartPending,
  RestartPending
} from './restart-pending.js';

export type RestartObservation = {
  readonly rawSha256: string;
  readonly upstreamVersion: string;
};

export function selectRestartPreparation(
  active: RestartPending | undefined,
  fresh: PreparingRestartPending
): PreparingRestartPending {
  if (active === undefined) return fresh;
  if (
    active.phase === 'preparing'
    && active.profileKey === fresh.profileKey
    && active.root === fresh.root
    && active.noteId === fresh.noteId
    && active.rawSha256 === fresh.rawSha256
  ) {
    return active;
  }
  throw new Error('RESTART_PENDING_ALREADY_ACTIVE');
}

export async function confirmPreparedRestartBlocked(input: {
  readonly blockProfile: () => Promise<unknown>;
  readonly announce: () => void;
}): Promise<void> {
  await input.blockProfile();
  input.announce();
}

export async function runRestartPrepareFlow(input: {
  readonly preparing: PreparingRestartPending;
  readonly blockProfile: () => Promise<unknown>;
  readonly writePreparing: (pending: PreparingRestartPending) => Promise<unknown>;
  readonly mutateAndObserve: () => Promise<RestartObservation>;
  readonly markPrepared: (
    pending: PreparingRestartPending,
    observation: RestartObservation
  ) => Promise<PreparedRestartPending>;
}): Promise<PreparedRestartPending> {
  await input.blockProfile();
  await input.writePreparing(input.preparing);
  const observation = await input.mutateAndObserve();
  return input.markPrepared(input.preparing, observation);
}
