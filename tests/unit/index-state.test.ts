import { describe, expect, it } from 'vitest';
import type { IndexRefreshResult } from '../../src/server/index/SearchIndexer.js';
import {
  INDEX_STALE_AFTER_FAILURES,
  INDEX_STALE_AFTER_MS,
  IndexStateController,
  type IndexState
} from '../../src/server/index/index-state.js';
import {
  INDEX_REFRESH_INTERVAL_MS,
  IndexScheduler,
  type DeadlineScheduler,
  type IntervalScheduler
} from '../../src/server/index/index-scheduler.js';

class FakeClock {
  constructor(private current: number) {}

  now = (): Date => new Date(this.current);

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

class FakeIntervals implements IntervalScheduler {
  readonly scheduled: Array<{ milliseconds: number; task: () => void }> = [];
  cancelCount = 0;

  every(milliseconds: number, task: () => void): () => void {
    this.scheduled.push({ milliseconds, task });
    return () => {
      this.cancelCount += 1;
    };
  }
}

class FakeDeadlines implements DeadlineScheduler {
  readonly scheduled: Array<{
    milliseconds: number;
    task: () => void;
    cancelled: boolean;
    fired: boolean;
  }> = [];

  after(milliseconds: number, task: () => void): () => void {
    const deadline = { milliseconds, task, cancelled: false, fired: false };
    this.scheduled.push(deadline);
    return () => {
      deadline.cancelled = true;
    };
  }

  fireNext(): void {
    const deadline = this.scheduled.find((candidate) => !candidate.cancelled && !candidate.fired);
    if (deadline === undefined) throw new Error('NO_PENDING_DEADLINE');
    deadline.fired = true;
    deadline.task();
  }
}

function status(state: IndexState): IndexState['status'] {
  return state.status;
}

describe('IndexStateController', () => {
  it('starts building and becomes versioned ready after a successful complete refresh', () => {
    const clock = new FakeClock(Date.parse('2026-08-31T00:00:00.000Z'));
    const controller = new IndexStateController(clock.now);

    expect(controller.snapshot()).toEqual({
      status: 'building',
      version: 0,
      startedAt: '2026-08-31T00:00:00.000Z'
    });

    controller.recordSuccess(4);
    expect(controller.snapshot()).toEqual({
      status: 'ready',
      version: 4,
      refreshedAt: '2026-08-31T00:00:00.000Z'
    });
  });

  it('marks a previously successful index stale on exactly the second failed poll', () => {
    const clock = new FakeClock(Date.parse('2026-08-31T00:00:00.000Z'));
    const controller = new IndexStateController(clock.now);
    controller.recordSuccess(7);

    clock.advance(1_000);
    controller.recordFailure('first poll failed');
    expect(status(controller.snapshot())).toBe('ready');

    clock.advance(1_000);
    controller.recordFailure('second poll failed');
    expect(controller.snapshot()).toEqual({
      status: 'stale',
      version: 7,
      lastSuccessAt: '2026-08-31T00:00:00.000Z',
      reason: 'second poll failed'
    });
    expect(INDEX_STALE_AFTER_FAILURES).toBe(2);
  });

  it('marks stale at 60 seconds without success but not one millisecond before', () => {
    const clock = new FakeClock(Date.parse('2026-08-31T00:00:00.000Z'));
    const controller = new IndexStateController(clock.now);
    controller.recordSuccess(3);

    clock.advance(INDEX_STALE_AFTER_MS - 1);
    expect(status(controller.evaluateFreshness())).toBe('ready');

    clock.advance(1);
    expect(controller.evaluateFreshness()).toEqual({
      status: 'stale',
      version: 3,
      lastSuccessAt: '2026-08-31T00:00:00.000Z',
      reason: 'INDEX_REFRESH_TIMEOUT'
    });
    expect(INDEX_STALE_AFTER_MS).toBe(60_000);
  });

  it('reports failed before any successful snapshot and resets failure history on success', () => {
    const clock = new FakeClock(Date.parse('2026-08-31T00:00:00.000Z'));
    const controller = new IndexStateController(clock.now);
    controller.recordFailure('startup failed');
    expect(controller.snapshot()).toEqual({ status: 'failed', version: 0, reason: 'startup failed' });

    controller.recordSuccess(1);
    clock.advance(1_000);
    controller.recordFailure('transient');
    expect(status(controller.snapshot())).toBe('ready');
  });

  it('never publishes an unsafe version from a successful refresh', () => {
    const controller = new IndexStateController(() => new Date('2026-08-31T00:00:00.000Z'));

    expect(() => controller.recordSuccess(-1)).toThrowError('INDEX_VERSION_INVALID');
    expect(() => controller.recordSuccess(Number.MAX_SAFE_INTEGER + 1))
      .toThrowError('INDEX_VERSION_INVALID');
    expect(controller.snapshot()).toMatchObject({ status: 'building', version: 0 });
  });
});

describe('IndexScheduler', () => {
  it('uses an injected 15-second scheduler and performs a focus refresh immediately', async () => {
    const clock = new FakeClock(Date.parse('2026-08-31T00:00:00.000Z'));
    const intervals = new FakeIntervals();
    const deadlines = new FakeDeadlines();
    let refreshes = 0;
    const scheduler = new IndexScheduler({
      refresh: async () => {
        refreshes += 1;
        return { status: 'ready' as const, checked: 1, total: 1, version: refreshes };
      },
      state: new IndexStateController(clock.now),
      intervals,
      deadlines,
      now: clock.now
    });

    expect(intervals.scheduled).toHaveLength(0);
    scheduler.start();
    expect(intervals.scheduled).toHaveLength(1);
    expect(intervals.scheduled[0]?.milliseconds).toBe(INDEX_REFRESH_INTERVAL_MS);
    expect(INDEX_REFRESH_INTERVAL_MS).toBe(15_000);
    expect(refreshes).toBe(0);

    await scheduler.requestFocusRefresh();
    expect(refreshes).toBe(1);
    expect(scheduler.snapshot().state).toMatchObject({ status: 'ready', version: 1 });

    scheduler.stop();
    expect(intervals.cancelCount).toBe(1);
  });

  it('keeps refresh progress explicit until the bounded full pass completes', async () => {
    const clock = new FakeClock(Date.parse('2026-08-31T00:00:00.000Z'));
    const results = [
      { status: 'refreshing' as const, checked: 2, total: 3, version: 0 },
      { status: 'ready' as const, checked: 3, total: 3, version: 1 }
    ];
    const scheduler = new IndexScheduler({
      refresh: async () => results.shift()!,
      state: new IndexStateController(clock.now),
      intervals: new FakeIntervals(),
      deadlines: new FakeDeadlines(),
      now: clock.now
    });

    await scheduler.refreshNow();
    expect(scheduler.snapshot()).toMatchObject({
      refresh: { status: 'refreshing', checked: 2, total: 3, version: 0 },
      state: { status: 'building' }
    });

    await scheduler.refreshNow();
    expect(scheduler.snapshot()).toMatchObject({
      refresh: { status: 'ready', checked: 3, total: 3, version: 1 },
      state: { status: 'ready', version: 1 }
    });
  });

  it('routes poll failures through the stale thresholds without real timers', async () => {
    const clock = new FakeClock(Date.parse('2026-08-31T00:00:00.000Z'));
    let fail = false;
    const scheduler = new IndexScheduler({
      refresh: async () => {
        if (fail) throw new Error('vault unavailable');
        return { status: 'ready' as const, checked: 1, total: 1, version: 1 };
      },
      state: new IndexStateController(clock.now),
      intervals: new FakeIntervals(),
      deadlines: new FakeDeadlines(),
      now: clock.now
    });

    await scheduler.refreshNow();
    fail = true;
    clock.advance(1_000);
    await expect(scheduler.refreshNow()).resolves.toMatchObject({ outcome: 'failed' });
    expect(status(scheduler.snapshot().state)).toBe('ready');

    clock.advance(1_000);
    await scheduler.refreshNow();
    expect(scheduler.snapshot().state).toMatchObject({
      status: 'stale',
      reason: 'vault unavailable'
    });
  });

  it('runs single-flight and coalesces any number of triggers during a poll into one follow-up', async () => {
    const clock = new FakeClock(Date.parse('2026-08-31T00:00:00.000Z'));
    let releaseFirst!: () => void;
    const firstRefresh = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let refreshes = 0;
    const scheduler = new IndexScheduler({
      refresh: async () => {
        refreshes += 1;
        if (refreshes === 1) await firstRefresh;
        return { status: 'ready' as const, checked: 1, total: 1, version: refreshes };
      },
      state: new IndexStateController(clock.now),
      intervals: new FakeIntervals(),
      deadlines: new FakeDeadlines(),
      now: clock.now
    });

    const scheduled = scheduler.refreshNow();
    const focusOne = scheduler.requestFocusRefresh();
    const focusTwo = scheduler.requestFocusRefresh();
    await Promise.resolve();
    expect(refreshes).toBe(1);

    releaseFirst();
    await Promise.all([scheduled, focusOne, focusTwo]);
    expect(refreshes).toBe(2);
    expect(scheduler.snapshot().state).toMatchObject({ status: 'ready', version: 2 });
  });

  it('returns a caller\'s successful target attempt even when a later unrelated attempt fails', async () => {
    const clock = new FakeClock(Date.parse('2026-08-31T00:00:00.000Z'));
    const releases: Array<() => void> = [];
    const started: Array<() => void> = [];
    const waits = [0, 1, 2].map((index) => new Promise<void>((resolve) => {
      releases[index] = resolve;
    }));
    const starts = [0, 1, 2].map((index) => new Promise<void>((resolve) => {
      started[index] = resolve;
    }));
    let refreshes = 0;
    const scheduler = new IndexScheduler({
      refresh: async () => {
        const attempt = refreshes++;
        started[attempt]?.();
        await waits[attempt];
        if (attempt === 2) throw new Error('unrelated later failure');
        return { status: 'ready' as const, checked: 1, total: 1, version: attempt + 1 };
      },
      state: new IndexStateController(clock.now),
      intervals: new FakeIntervals(),
      deadlines: new FakeDeadlines(),
      now: clock.now
    });

    const first = scheduler.refreshNow();
    await starts[0];
    const target = scheduler.requestFocusRefresh();
    releases[0]?.();
    await starts[1];
    const unrelated = scheduler.refreshNow();
    releases[1]?.();

    await expect(target).resolves.toMatchObject({ generation: 2, outcome: 'succeeded' });
    await starts[2];
    releases[2]?.();
    await expect(unrelated).resolves.toMatchObject({ generation: 3, outcome: 'failed' });
    await expect(first).resolves.toMatchObject({ generation: 1, outcome: 'succeeded' });
  });

  it('returns a caller\'s failed target attempt even when a later unrelated attempt succeeds', async () => {
    const clock = new FakeClock(Date.parse('2026-08-31T00:00:00.000Z'));
    const releases: Array<() => void> = [];
    const started: Array<() => void> = [];
    const waits = [0, 1, 2].map((index) => new Promise<void>((resolve) => {
      releases[index] = resolve;
    }));
    const starts = [0, 1, 2].map((index) => new Promise<void>((resolve) => {
      started[index] = resolve;
    }));
    let refreshes = 0;
    const scheduler = new IndexScheduler({
      refresh: async () => {
        const attempt = refreshes++;
        started[attempt]?.();
        await waits[attempt];
        if (attempt === 1) throw new Error('target failure');
        return { status: 'ready' as const, checked: 1, total: 1, version: attempt + 1 };
      },
      state: new IndexStateController(clock.now),
      intervals: new FakeIntervals(),
      deadlines: new FakeDeadlines(),
      now: clock.now
    });

    const first = scheduler.refreshNow();
    await starts[0];
    const target = scheduler.requestFocusRefresh();
    releases[0]?.();
    await starts[1];
    const unrelated = scheduler.refreshNow();
    releases[1]?.();

    await expect(target).resolves.toMatchObject({ generation: 2, outcome: 'failed' });
    await starts[2];
    releases[2]?.();
    await expect(unrelated).resolves.toMatchObject({ generation: 3, outcome: 'succeeded' });
    await expect(first).resolves.toMatchObject({ generation: 1, outcome: 'succeeded' });
  });

  it('aborts a timed-out poll but waits for its side effects to settle before starting the queued refresh', async () => {
    const clock = new FakeClock(Date.parse('2026-08-31T00:00:00.000Z'));
    const deadlines = new FakeDeadlines();
    let settleFirst!: () => void;
    let firstSignal: AbortSignal | undefined;
    let refreshes = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const scheduler = new IndexScheduler({
      refresh: async (signal?: AbortSignal) => {
        refreshes += 1;
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        if (refreshes === 1) {
          firstSignal = signal;
          return new Promise<IndexRefreshResult>((resolve) => {
            settleFirst = () => {
              concurrent -= 1;
              resolve({ status: 'ready', checked: 99, total: 99, version: 99 });
            };
          });
        }
        concurrent -= 1;
        return { status: 'ready' as const, checked: 1, total: 1, version: 1 };
      },
      state: new IndexStateController(clock.now),
      intervals: new FakeIntervals(),
      deadlines,
      now: clock.now
    });

    const hung = scheduler.refreshNow();
    await Promise.resolve();
    expect(refreshes).toBe(1);
    expect(deadlines.scheduled[0]?.milliseconds).toBe(60_000);
    clock.advance(60_000);
    deadlines.fireNext();
    const queued = scheduler.refreshNow();
    await Promise.resolve();
    expect(firstSignal?.aborted).toBe(true);
    expect(scheduler.snapshot().state).toEqual({
      status: 'failed',
      version: 0,
      reason: 'INDEX_REFRESH_TIMEOUT'
    });
    expect(refreshes).toBe(1);
    expect(maxConcurrent).toBe(1);

    settleFirst();
    await Promise.all([hung, queued]);
    expect(refreshes).toBe(2);
    expect(maxConcurrent).toBe(1);
    expect(scheduler.snapshot().state).toMatchObject({ status: 'ready', version: 1 });
  });

  it('marks an existing ready snapshot stale when its next poll hangs for 60 seconds', async () => {
    const clock = new FakeClock(Date.parse('2026-08-31T00:00:00.000Z'));
    const deadlines = new FakeDeadlines();
    let hang = false;
    let hungSignal: AbortSignal | undefined;
    const scheduler = new IndexScheduler({
      refresh: async (signal?: AbortSignal) => {
        if (!hang) return { status: 'ready' as const, checked: 1, total: 1, version: 8 };
        hungSignal = signal;
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted hung poll')), { once: true });
        });
      },
      state: new IndexStateController(clock.now),
      intervals: new FakeIntervals(),
      deadlines,
      now: clock.now
    });
    await scheduler.refreshNow();
    hang = true;
    const hung = scheduler.refreshNow();
    await Promise.resolve();

    clock.advance(59_999);
    expect(scheduler.snapshot().state).toMatchObject({ status: 'ready', version: 8 });
    clock.advance(1);
    deadlines.fireNext();
    await hung;
    expect(hungSignal?.aborted).toBe(true);
    expect(scheduler.snapshot().state).toEqual({
      status: 'stale',
      version: 8,
      lastSuccessAt: '2026-08-31T00:00:00.000Z',
      reason: 'INDEX_REFRESH_TIMEOUT'
    });
  });

  it('stop cancels the active wait and prevents a queued follow-up, late rejection, and interval trigger', async () => {
    const clock = new FakeClock(Date.parse('2026-08-31T00:00:00.000Z'));
    const intervals = new FakeIntervals();
    const deadlines = new FakeDeadlines();
    let rejectFirst!: (error: Error) => void;
    let activeSignal: AbortSignal | undefined;
    const deferred = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    let refreshes = 0;
    const scheduler = new IndexScheduler({
      refresh: async (signal?: AbortSignal) => {
        refreshes += 1;
        if (refreshes === 1) {
          activeSignal = signal;
          return deferred;
        }
        return { status: 'ready' as const, checked: 1, total: 1, version: refreshes };
      },
      state: new IndexStateController(clock.now),
      intervals,
      deadlines,
      now: clock.now
    });
    scheduler.start();
    const active = scheduler.refreshNow();
    void scheduler.requestFocusRefresh();
    await Promise.resolve();
    expect(refreshes).toBe(1);

    let activeSettled = false;
    void active.then(() => {
      activeSettled = true;
    });
    const stopping = scheduler.stopAndWait();
    await Promise.resolve();
    expect(activeSignal?.aborted).toBe(true);
    expect(activeSettled).toBe(false);
    rejectFirst(new Error('late rejection after stop'));
    await Promise.all([active, stopping]);
    expect(activeSettled).toBe(true);
    intervals.scheduled[0]?.task();
    await Promise.resolve();

    expect(refreshes).toBe(1);
    expect(scheduler.snapshot().state).toMatchObject({ status: 'building' });
    expect(deadlines.scheduled.every((deadline) => deadline.cancelled || deadline.fired)).toBe(true);
  });
});
