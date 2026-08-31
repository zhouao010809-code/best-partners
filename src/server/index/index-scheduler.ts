import type { IndexRefreshResult } from './SearchIndexer.js';
import type { IndexState, IndexStateController } from './index-state.js';

export const INDEX_REFRESH_INTERVAL_MS = 15_000;
export const INDEX_REFRESH_DEADLINE_MS = 60_000;

export interface IntervalScheduler {
  every(milliseconds: number, task: () => void): () => void;
}

export interface DeadlineScheduler {
  after(milliseconds: number, task: () => void): () => void;
}

export type IndexSchedulerSnapshot = {
  state: IndexState;
  refresh?: IndexRefreshResult;
};

export class IndexScheduler {
  private cancelInterval: (() => void) | undefined;
  private activeRefresh: Promise<void> | undefined;
  private activeAbortController: AbortController | undefined;
  private followUpRequested = false;
  private lastRefresh: IndexRefreshResult | undefined;
  private stopped = false;

  constructor(private readonly input: {
    refresh: (signal: AbortSignal) => Promise<IndexRefreshResult>;
    state: IndexStateController;
    intervals: IntervalScheduler;
    deadlines: DeadlineScheduler;
    now: () => Date;
  }) {}

  start(): void {
    if (this.stopped || this.cancelInterval !== undefined) return;
    this.cancelInterval = this.input.intervals.every(INDEX_REFRESH_INTERVAL_MS, () => {
      void this.refreshNow();
    });
  }

  stop(): void {
    this.stopped = true;
    this.followUpRequested = false;
    this.cancelInterval?.();
    this.cancelInterval = undefined;
    this.activeAbortController?.abort(new Error('INDEX_REFRESH_STOPPED'));
  }

  async stopAndWait(): Promise<void> {
    const active = this.activeRefresh;
    this.stop();
    await active;
  }

  requestFocusRefresh(): Promise<void> {
    return this.refreshNow();
  }

  refreshNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.activeRefresh !== undefined) {
      this.followUpRequested = true;
      return this.activeRefresh;
    }

    const run = async (): Promise<void> => {
      try {
        do {
          this.followUpRequested = false;
          await this.runOneRefresh();
        } while (!this.stopped && this.followUpRequested);
      } finally {
        this.activeRefresh = undefined;
      }
    };
    this.activeRefresh = run();
    return this.activeRefresh;
  }

  snapshot(): IndexSchedulerSnapshot {
    const state = this.input.state.evaluateFreshness(this.input.now());
    return {
      state,
      ...(this.lastRefresh === undefined ? {} : { refresh: { ...this.lastRefresh } })
    };
  }

  private async runOneRefresh(): Promise<void> {
    const controller = new AbortController();
    this.activeAbortController = controller;
    let timedOut = false;
    let cancelDeadline = (): void => {};

    try {
      cancelDeadline = this.input.deadlines.after(INDEX_REFRESH_DEADLINE_MS, () => {
        if (this.stopped || controller.signal.aborted) return;
        timedOut = true;
        this.input.state.recordFailure('INDEX_REFRESH_TIMEOUT', this.input.now());
        controller.abort(new Error('INDEX_REFRESH_TIMEOUT'));
      });
      let result: IndexRefreshResult;
      try {
        result = await this.input.refresh(controller.signal);
      } catch (error) {
        if (!this.stopped && !timedOut && !controller.signal.aborted) {
          const reason = error instanceof Error ? error.message : 'INDEX_REFRESH_FAILED';
          this.input.state.recordFailure(reason, this.input.now());
        }
        return;
      }

      if (this.stopped || timedOut || controller.signal.aborted) return;
      this.lastRefresh = { ...result };
      if (result.status === 'ready') {
        this.input.state.recordSuccess(result.version, this.input.now());
      }
    } finally {
      try {
        cancelDeadline();
      } finally {
        if (this.activeAbortController === controller) this.activeAbortController = undefined;
      }
    }
  }
}
