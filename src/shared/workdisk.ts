export type WorkdiskKind = 'video' | 'audio' | 'image' | 'document' | 'other';
export interface WorkdiskSearchPlan { terms: string[]; startDate?: string; endDate?: string; kind?: WorkdiskKind }
export interface WorkdiskBinding { id: string; rootPath: string; displayName: string; connectedAt: string }
export interface WorkdiskFile { path: string; name: string; kind: WorkdiskKind; size: number; modifiedAt: string; date: string; excerpt?: string; matchedBy?: 'name' | 'content' | 'path' }
export interface WorkdiskSnapshot { binding: WorkdiskBinding | null; files: WorkdiskFile[]; scannedAt: string; truncated: boolean; skippedCount: number }
export interface WorkdiskListRequest { query?: string; plan?: WorkdiskSearchPlan; date?: string; kind?: WorkdiskKind }
export interface WorkdiskImportResult { files: WorkdiskFile[]; failures: { name: string; message: string }[] }
export interface WorkdiskPreview { kind: 'text' | 'image' | 'media' | 'unsupported'; text?: string; url?: string; truncated?: boolean }
