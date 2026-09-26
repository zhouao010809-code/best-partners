export type UpdateCheckResult =
  | { status: 'up-to-date'; currentVersion: string; checkedAt: string }
  | { status: 'available'; currentVersion: string; version: string; releaseUrl: string; assetUrl: string; publishedAt?: string; notes: string; download?: { sha256: string; size: number }; automaticUpdateUrl?: string }
  | { status: 'error'; currentVersion: string; code: 'UPDATE_FEED_UNAVAILABLE' | 'UPDATE_FEED_INVALID' | 'UPDATE_VERSION_INVALID'; message: string; releaseUrl: string };

export type UpdateTransferState =
  | { status: 'idle' }
  | { status: 'downloading'; version: string; mode: 'automatic' | 'installer'; receivedBytes?: number; totalBytes?: number }
  | { status: 'ready'; version: string; mode: 'automatic' | 'installer' }
  | { status: 'installing'; version: string }
  | { status: 'error'; message: string };

export interface UpdateSnapshot {
  result?: UpdateCheckResult;
  transfer: UpdateTransferState;
  automaticInstall: boolean;
}
