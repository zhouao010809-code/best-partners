import type { IndexRefreshResult } from './SearchIndexer.js';
import type { IndexState, IndexStateController } from './index-state.js';

export const INDEX_REFRESH_INTERVAL_MS = 15_000;

export interface IntervalScheduler {
  every(milliseconds: number, task: () => void): () => void;
}

export type IndexSchedulerSnapshot = {
  state: IndexState;
  refresh?: IndexRefreshResult;
};

export class IndexScheduler {
  private cancelInterval: (() => void) | undefined;
  private activeRefresh: Promise<void> | undefined;
  private followUpRequested = false;
  private lastRefresh: IndexRefreshResult | undefined;

  constructor(private readonly input: {
    refresh: () => Promise<IndexRefreshResult>;
    state: IndexStateController;
    intervals: IntervalScheduler;
    now: () => Date;
  }) {}

  start(): void {
    if (this.cancelInterval !== undefined) return;
    this.cancelInterval = this.input.intervals.every(INDEX_REFRESH_INTERVAL_MS, () => {
      void this.refreshNow();
    });
  }

  stop(): void {
    this.cancelInterval?.();
    this.cancelInterval = undefined;
  }

  requestFocusRefresh(): Promise<void> {
    return this.refreshNow();
  }

  refreshNow(): Promise<void> {
    if (this.activeRefresh !== undefined) {
      this.followUpRequested = true;
      return this.activeRefresh;
    }

    const run = async (): Promise<void> => {
      do {
        this.followUpRequested = false;
        await this.runOneRefresh();
      } while (this.followUpRequested);
      this.activeRefresh = undefined;
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
    try {
      const result = await this.input.refresh();
      this.lastRefresh = { ...result };
      if (result.status === 'ready') this.input.state.recordSuccess(result.version, this.input.now());
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'INDEX_REFRESH_FAILED';
      this.input.state.recordFailure(reason, this.input.now());
    }
  }
}
