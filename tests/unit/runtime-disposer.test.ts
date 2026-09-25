import { describe, expect, it, vi } from 'vitest';
import { createRuntimeDisposer, disposeAfterStartupFailure } from '../../src/server/runtime/runtime-disposer.js';

describe('runtime disposer', () => {
  it('disposes resources in reverse registration order', async () => {
    const order: string[] = [];
    const disposer = createRuntimeDisposer();
    disposer.add(async () => { order.push('first'); });
    disposer.add(() => { order.push('second'); });

    await disposer.dispose();

    expect(order).toEqual(['second', 'first']);
  });

  it('is idempotent and shares the first disposal promise', async () => {
    const close = vi.fn(async () => undefined);
    const disposer = createRuntimeDisposer();
    disposer.add(close);

    const first = disposer.dispose();
    const second = disposer.dispose();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('shares the disposal promise and refuses registration from a synchronous reentrant cleanup', async () => {
    const disposer = createRuntimeDisposer();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const close = vi.fn(() => pending), lateClose = vi.fn();
    let nested: Promise<void> | undefined, registrationFailure: unknown;
    disposer.add(close);
    disposer.add(() => {
      try { disposer.add(lateClose); } catch (error) { registrationFailure = error; }
      nested = disposer.dispose();
    });

    const first = disposer.dispose();
    try {
      await Promise.resolve();
      expect(nested).toBe(first);
      expect(registrationFailure).toMatchObject({ message: 'RUNTIME_DISPOSE_ALREADY_STARTED' });
      expect(lateClose).not.toHaveBeenCalled();
    } finally {
      release();
      await Promise.allSettled([first, nested]);
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it('continues cleanup and reports all failures', async () => {
    const order: string[] = [];
    const disposer = createRuntimeDisposer();
    disposer.add(() => { order.push('first'); throw new Error('first failure'); });
    disposer.add(async () => { order.push('second'); throw new Error('second failure'); });

    await expect(disposer.dispose()).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'RUNTIME_DISPOSE_FAILED',
      errors: [expect.objectContaining({ message: 'second failure' }), expect.objectContaining({ message: 'first failure' })]
    });
    expect(order).toEqual(['second', 'first']);
  });

  it('rejects registration after disposal starts', async () => {
    const disposer = createRuntimeDisposer();
    const closing = disposer.dispose();

    expect(() => disposer.add(() => undefined)).toThrow('RUNTIME_DISPOSE_ALREADY_STARTED');
    await closing;
  });

  it('retains the startup cause and still releases later resources when rollback fails', async () => {
    const disposer = createRuntimeDisposer();
    const failure = new Error('startup failed'), cleanupFailure = new Error('cleanup failed');
    const release = vi.fn();
    disposer.add(release);
    disposer.add(() => { throw cleanupFailure; });

    await expect(disposeAfterStartupFailure(disposer, failure)).rejects.toMatchObject({
      cause: failure,
      errors: [failure, expect.objectContaining({ errors: [cleanupFailure] })]
    });
    expect(release).toHaveBeenCalledOnce();
  });
});
