export type UpdateCheckResult =
  | { status: 'up-to-date'; currentVersion: string; checkedAt: string }
  | { status: 'available'; currentVersion: string; version: string; releaseUrl: string; assetUrl: string; publishedAt?: string; notes: string }
  | { status: 'error'; currentVersion: string; code: 'UPDATE_FEED_UNAVAILABLE' | 'UPDATE_FEED_INVALID' | 'UPDATE_VERSION_INVALID'; message: string; releaseUrl: string };
