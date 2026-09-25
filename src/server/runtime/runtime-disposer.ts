export interface RuntimeDisposer {
  add(cleanup: () => void | Promise<void>): void;
  dispose(): Promise<void>;
}

export function createRuntimeDisposer(): RuntimeDisposer {
  const cleanups: Array<() => void | Promise<void>> = [];
  let disposal: Promise<void> | undefined;

  return {
    add(cleanup) {
      if (disposal !== undefined) throw new Error('RUNTIME_DISPOSE_ALREADY_STARTED');
      cleanups.push(cleanup);
    },
    dispose() {
      // Assign the promise before invoking any user cleanup, including a
      // synchronous cleanup that calls dispose() or tries to register work.
      disposal ??= Promise.resolve().then(async () => {
        const errors: unknown[] = [];
        while (cleanups.length > 0) {
          const cleanup = cleanups.pop();
          if (cleanup === undefined) continue;
          try {
            await cleanup();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) throw new AggregateError(errors, 'RUNTIME_DISPOSE_FAILED');
      });
      return disposal;
    }
  };
}

/** Keep the startup cause available even when releasing resources also fails. */
export async function disposeAfterStartupFailure(disposer: RuntimeDisposer, failure: unknown): Promise<void> {
  try {
    await disposer.dispose();
  } catch (cleanupFailure) {
    throw new AggregateError([failure, cleanupFailure], 'RUNTIME_STARTUP_CLEANUP_FAILED', { cause: failure });
  }
}
