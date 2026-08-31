import {
  assertIndexMetadata,
  type IndexMetadata
} from './index-metadata.js';

export const INDEX_STALE_AFTER_FAILURES = 2;
export const INDEX_STALE_AFTER_MS = 60_000;

export type IndexState =
  | { status: 'building'; version: number; startedAt: string }
  | { status: 'ready'; version: number; refreshedAt: string }
  | { status: 'stale'; version: number; lastSuccessAt: string; reason: string }
  | { status: 'failed'; version: number; lastSuccessAt?: string; reason: string };

type LastSuccess = {
  version: number;
  at: Date;
};

export class IndexStateController {
  private state: IndexState;
  private lastSuccess: LastSuccess | undefined;
  private consecutiveFailures = 0;
  private awaitingStartupRefresh = false;
  private currentVersion = 0;

  constructor(
    private readonly now: () => Date,
    metadata?: IndexMetadata
  ) {
    const startedAt = this.now();
    if (metadata !== undefined) {
      assertIndexMetadata(metadata);
      this.currentVersion = metadata.version;
    }
    this.state = {
      status: 'building',
      version: this.currentVersion,
      startedAt: startedAt.toISOString()
    };
    if (metadata === undefined) return;
    if (metadata.version === 0) return;

    const lastSuccessAt = new Date(metadata.updatedAt);
    this.lastSuccess = { version: metadata.version, at: lastSuccessAt };
    this.awaitingStartupRefresh = true;
    if (startedAt.getTime() - lastSuccessAt.getTime() >= INDEX_STALE_AFTER_MS) {
      this.state = {
        status: 'stale',
        version: metadata.version,
        lastSuccessAt: metadata.updatedAt,
        reason: 'INDEX_REFRESH_TIMEOUT'
      };
      return;
    }
    this.state = {
      status: 'ready',
      version: metadata.version,
      refreshedAt: metadata.updatedAt
    };
  }

  snapshot(): IndexState {
    return { ...this.state };
  }

  recordSuccess(version: number, at: Date = this.now()): void {
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new Error('INDEX_VERSION_INVALID');
    }
    this.currentVersion = version;
    this.lastSuccess = { version, at };
    this.consecutiveFailures = 0;
    this.awaitingStartupRefresh = false;
    this.state = { status: 'ready', version, refreshedAt: at.toISOString() };
  }

  recordFailure(reason: string, at: Date = this.now()): void {
    this.consecutiveFailures += 1;
    if (this.lastSuccess === undefined) {
      this.state = { status: 'failed', version: this.currentVersion, reason };
      return;
    }

    if (this.awaitingStartupRefresh) {
      this.awaitingStartupRefresh = false;
      this.state = {
        status: 'stale',
        version: this.lastSuccess.version,
        lastSuccessAt: this.lastSuccess.at.toISOString(),
        reason
      };
      return;
    }

    const elapsed = at.getTime() - this.lastSuccess.at.getTime();
    if (
      this.consecutiveFailures >= INDEX_STALE_AFTER_FAILURES
      || elapsed >= INDEX_STALE_AFTER_MS
    ) {
      this.state = {
        status: 'stale',
        version: this.lastSuccess.version,
        lastSuccessAt: this.lastSuccess.at.toISOString(),
        reason
      };
      return;
    }

    this.state = {
      status: 'ready',
      version: this.lastSuccess.version,
      refreshedAt: this.lastSuccess.at.toISOString()
    };
  }

  evaluateFreshness(at: Date = this.now()): IndexState {
    if (
      this.lastSuccess !== undefined
      && at.getTime() - this.lastSuccess.at.getTime() >= INDEX_STALE_AFTER_MS
      && this.state.status !== 'stale'
    ) {
      this.state = {
        status: 'stale',
        version: this.lastSuccess.version,
        lastSuccessAt: this.lastSuccess.at.toISOString(),
        reason: 'INDEX_REFRESH_TIMEOUT'
      };
    }
    return this.snapshot();
  }
}
