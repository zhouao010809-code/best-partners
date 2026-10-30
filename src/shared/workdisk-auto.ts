export interface WorkdiskAutoReceipt {
  id: string;
  sourceName: string;
  savedName?: string;
  path?: string;
  status: 'saved' | 'failed' | 'uncertain';
  reason: string;
  receivedAt: string;
}

export interface WorkdiskAutoState {
  source: { rootPath: string; displayName: string } | null;
  enabled: boolean;
  nameFromContent: boolean;
  phase: 'off' | 'watching' | 'processing' | 'waiting' | 'paused' | 'error';
  pendingCount: number;
  message?: string;
  receipts: WorkdiskAutoReceipt[];
}
