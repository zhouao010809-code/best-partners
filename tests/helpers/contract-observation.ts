import type { VaultGateway, VersionedBytes } from '../../src/server/vault/VaultGateway.js';

type DeadlineResult<T> =
  | { readonly settled: true; readonly value: T }
  | { readonly settled: false };

function settleBeforeDeadline<T>(
  operation: () => Promise<T>,
  remainingMs: number
): Promise<DeadlineResult<T>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ settled: false });
    }, Math.max(0, remainingMs));
    Promise.resolve()
      .then(operation)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ settled: true, value });
      }, (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

function readBeforeDeadline(
  read: () => Promise<VersionedBytes>,
  remainingMs: number
): Promise<VersionedBytes | undefined> {
  return settleBeforeDeadline(read, remainingMs).then((result) => (
    result.settled ? result.value : undefined
  ));
}

export async function pollForObservation(input: {
  readonly check: () => Promise<boolean>;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}): Promise<boolean> {
  const deadline = Date.now() + (input.timeoutMs ?? 15_000);
  const intervalMs = input.intervalMs ?? 200;

  while (true) {
    const remainingForCheck = deadline - Date.now();
    if (remainingForCheck <= 0) return false;
    try {
      const checked = await settleBeforeDeadline(input.check, remainingForCheck);
      if (!checked.settled) return false;
      if (checked.value) return true;
    } catch {
      // The external watcher may not have observed the change yet.
    }

    const remainingForWait = deadline - Date.now();
    if (remainingForWait <= 0) return false;
    const waited = await settleBeforeDeadline(
      () => new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(intervalMs, remainingForWait));
      }),
      remainingForWait
    );
    if (!waited.settled) return false;
  }
}

export async function waitForRawObservation(input: {
  readonly gateway: VaultGateway;
  readonly path: string;
  readonly expectedRawSha256: string;
  readonly requireVersion?: boolean;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}): Promise<VersionedBytes> {
  const now = input.now ?? Date.now;
  const intervalMs = input.intervalMs ?? 200;
  const deadline = now() + (input.timeoutMs ?? 15_000);
  const wait = input.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));

  while (true) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw new Error('CONTRACT_OBSERVATION_TIMEOUT');
    try {
      const observed = await readBeforeDeadline(
        () => input.gateway.readRaw(input.path),
        remainingMs
      );
      if (observed === undefined) throw new Error('CONTRACT_OBSERVATION_TIMEOUT');
      if (
        observed.rawSha256 === input.expectedRawSha256
        && (!input.requireVersion || observed.upstreamVersion !== undefined)
      ) {
        return observed;
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'CONTRACT_OBSERVATION_TIMEOUT') throw error;
      // The REST watcher may not have observed a direct disk mutation yet.
    }
    const remainingForWait = deadline - now();
    if (remainingForWait <= 0) throw new Error('CONTRACT_OBSERVATION_TIMEOUT');
    const waited = await settleBeforeDeadline(
      () => wait(Math.min(intervalMs, remainingForWait)),
      remainingForWait
    );
    if (!waited.settled) throw new Error('CONTRACT_OBSERVATION_TIMEOUT');
  }
}
