import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type {
  IndexRefreshAttempt,
  IndexSchedulerSnapshot
} from '../index/index-scheduler.js';
import { canonicalJson } from '../index/index-repository.js';
import { PublicApiError } from '../../shared/api/errors.js';

export type IndexJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';

export type IndexJobSnapshot = {
  id: string;
  operationId: string;
  status: IndexJobStatus;
  requestedIndexVersion: number;
  indexVersion: number;
  progress: { completed: number; total: number };
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
};

export interface IndexSchedulerPort {
  requestFocusRefresh(): Promise<IndexRefreshAttempt>;
  snapshot(): IndexSchedulerSnapshot;
  stopAndWait?(): Promise<void>;
}

type JobRow = {
  id: string;
  operationId: string;
  requestedIndexVersion: number;
  resultIndexVersion: number | null;
  status: IndexJobStatus;
  progressCompleted: number;
  progressTotal: number;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

type IdempotencyRow = {
  operation: string;
  requestHash: string;
  responseJson: string | null;
};

const INDEX_REBUILD_OPERATION = 'index.rebuild';

function requestHash(indexVersion: number): string {
  return createHash('sha256')
    .update(canonicalJson({ indexVersion }), 'utf8')
    .digest('hex');
}

function safeIdentifier(factory: () => string): string {
  try {
    const candidate = factory();
    if (
      candidate.length > 0
      && candidate.length <= 128
      && /^[a-z0-9._:-]+$/iu.test(candidate)
    ) {
      return candidate;
    }
  } catch {
    // Use a local identifier without exposing the factory failure.
  }
  return randomUUID();
}

function jobFromRow(row: JobRow): IndexJobSnapshot {
  return {
    id: row.id,
    operationId: row.operationId,
    status: row.status,
    requestedIndexVersion: row.requestedIndexVersion,
    indexVersion: row.resultIndexVersion ?? row.requestedIndexVersion,
    progress: {
      completed: row.progressCompleted,
      total: row.progressTotal
    },
    ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function isConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    && error.code.startsWith('SQLITE_CONSTRAINT');
}

export function loadPersistedIndexVersion(
  database: Database.Database,
  fallback = 0
): number {
  const row = database.prepare('SELECT version FROM index_metadata WHERE singleton = 1')
    .get() as { version: number } | undefined;
  return row?.version ?? fallback;
}

export class IndexJobService {
  private readonly activeTasks = new Set<Promise<void>>();
  private stopping = false;
  private readonly selectJob: Database.Statement<[string], JobRow>;

  constructor(private readonly input: {
    database: Database.Database;
    scheduler: IndexSchedulerPort;
    currentIndexVersion: () => number;
    now: () => string;
    operationIdFactory: () => string;
    jobIdFactory: () => string;
  }) {
    this.selectJob = input.database.prepare(`
      SELECT
        id,
        operation_id AS operationId,
        requested_index_version AS requestedIndexVersion,
        result_index_version AS resultIndexVersion,
        status,
        progress_completed AS progressCompleted,
        progress_total AS progressTotal,
        error_code AS errorCode,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM index_jobs
      WHERE id = ?
    `);
    const initialVersion = input.currentIndexVersion();
    if (!Number.isSafeInteger(initialVersion) || initialVersion < 0) {
      throw new Error('INDEX_VERSION_INVALID');
    }
    input.database.transaction(() => {
      input.database.prepare(`
        INSERT INTO index_metadata (singleton, version, updated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO NOTHING
      `).run(initialVersion, input.now());
      input.database.prepare(`
        UPDATE index_jobs
        SET status = 'interrupted', error_code = 'SERVER_RESTARTED', updated_at = ?
        WHERE status IN ('queued', 'running')
      `).run(input.now());
    }).immediate();
  }

  get(id: string): IndexJobSnapshot | undefined {
    const row = this.selectJob.get(id);
    return row === undefined ? undefined : jobFromRow(row);
  }

  createRebuild(input: {
    expectedIndexVersion: number;
    idempotencyKey: string;
  }): { job: IndexJobSnapshot; created: boolean } {
    const hash = requestHash(input.expectedIndexVersion);
    const create = this.input.database.transaction(() => {
      const existing = this.input.database.prepare(`
        SELECT
          operation,
          request_hash AS requestHash,
          response_json AS responseJson
        FROM idempotency_records
        WHERE key = ?
      `).get(input.idempotencyKey) as IdempotencyRow | undefined;
      if (existing !== undefined) {
        if (
          existing.operation !== INDEX_REBUILD_OPERATION
          || existing.requestHash !== hash
          || existing.responseJson === null
        ) {
          throw new PublicApiError(
            'IDEMPOTENCY_CONFLICT',
            'Idempotency key was already used for a different request',
            409
          );
        }
        let jobId: unknown;
        try {
          jobId = (JSON.parse(existing.responseJson) as { jobId?: unknown }).jobId;
        } catch {
          throw new Error('IDEMPOTENCY_RECORD_CORRUPT');
        }
        if (typeof jobId !== 'string') throw new Error('IDEMPOTENCY_RECORD_CORRUPT');
        const job = this.get(jobId);
        if (job === undefined) throw new Error('IDEMPOTENCY_JOB_MISSING');
        return { job, created: false };
      }

      const metadata = this.input.database.prepare(`
        SELECT version FROM index_metadata WHERE singleton = 1
      `).get() as { version: number } | undefined;
      if (metadata === undefined) throw new Error('INDEX_METADATA_MISSING');
      if (metadata.version !== input.expectedIndexVersion) {
        throw new PublicApiError('VERSION_CONFLICT', 'Index version changed', 409);
      }
      const active = this.input.database.prepare(`
        SELECT id FROM index_jobs WHERE status IN ('queued', 'running') LIMIT 1
      `).get();
      if (active !== undefined) {
        throw new PublicApiError('INDEX_BUSY', 'An index rebuild is already active', 409);
      }

      const id = safeIdentifier(this.input.jobIdFactory);
      const operationId = safeIdentifier(this.input.operationIdFactory);
      const now = this.input.now();
      this.input.database.prepare(`
        INSERT INTO index_jobs (
          id, operation_id, requested_index_version, result_index_version,
          status, progress_completed, progress_total, error_code, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, 'queued', 0, 0, NULL, ?, ?)
      `).run(id, operationId, input.expectedIndexVersion, now, now);
      this.input.database.prepare(`
        INSERT INTO idempotency_records (
          key, operation, request_hash, response_json, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        input.idempotencyKey,
        INDEX_REBUILD_OPERATION,
        hash,
        canonicalJson({ jobId: id }),
        now
      );
      const job = this.get(id);
      if (job === undefined) throw new Error('INDEX_JOB_CREATE_FAILED');
      return { job, created: true };
    });

    try {
      return create.immediate();
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      if (isConstraintError(error)) {
        throw new PublicApiError('INDEX_BUSY', 'An index rebuild is already active', 409);
      }
      throw error;
    }
  }

  start(id: string): IndexJobSnapshot {
    const now = this.input.now();
    const result = this.input.database.prepare(`
      UPDATE index_jobs
      SET status = 'running', updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(now, id);
    if (result.changes !== 1) {
      const existing = this.get(id);
      if (existing === undefined) throw new Error('INDEX_JOB_MISSING');
      return existing;
    }

    const task = this.drive(id).finally(() => {
      this.activeTasks.delete(task);
    });
    this.activeTasks.add(task);
    const job = this.get(id);
    if (job === undefined) throw new Error('INDEX_JOB_MISSING');
    return job;
  }

  recordIndexVersion(version: number): void {
    if (!Number.isSafeInteger(version) || version < 0) throw new Error('INDEX_VERSION_INVALID');
    this.input.database.prepare(`
      UPDATE index_metadata SET version = ?, updated_at = ? WHERE singleton = 1
    `).run(version, this.input.now());
  }

  async close(): Promise<void> {
    this.stopping = true;
    await this.input.scheduler.stopAndWait?.();
    await Promise.allSettled([...this.activeTasks]);
  }

  private async drive(id: string): Promise<void> {
    try {
      while (!this.stopping) {
        const attempt = await this.input.scheduler.requestFocusRefresh();
        if (this.stopping) break;
        if (attempt.outcome === 'failed') {
          this.fail(id, 'INDEX_REBUILD_FAILED');
          return;
        }
        if (attempt.outcome === 'stopped') {
          this.interrupt(id, 'SERVER_STOPPED');
          return;
        }
        const refresh = attempt.refresh;
        if (refresh.status === 'refreshing') {
          this.updateProgress(id, refresh.checked, refresh.total, refresh.version);
          continue;
        }
        this.complete(id, refresh.checked, refresh.total, refresh.version);
        return;
      }
      this.interrupt(id, 'SERVER_STOPPED');
    } catch {
      if (this.stopping) this.interrupt(id, 'SERVER_STOPPED');
      else this.fail(id, 'INDEX_REBUILD_FAILED');
    }
  }

  private updateProgress(id: string, completed: number, total: number, version: number): void {
    if (
      !Number.isSafeInteger(completed)
      || !Number.isSafeInteger(total)
      || completed < 0
      || total < completed
      || !Number.isSafeInteger(version)
      || version < 0
    ) {
      throw new Error('INDEX_PROGRESS_INVALID');
    }
    this.input.database.transaction(() => {
      this.input.database.prepare(`
        UPDATE index_jobs
        SET progress_completed = ?, progress_total = ?, result_index_version = ?, updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(completed, total, version, this.input.now(), id);
      this.recordIndexVersion(version);
    }).immediate();
  }

  private complete(id: string, completed: number, total: number, version: number): void {
    this.input.database.transaction(() => {
      this.updateProgress(id, completed, total, version);
      this.input.database.prepare(`
        UPDATE index_jobs
        SET status = 'completed', error_code = NULL, updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(this.input.now(), id);
    }).immediate();
  }

  private fail(id: string, code: string): void {
    this.input.database.prepare(`
      UPDATE index_jobs
      SET status = 'failed', error_code = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(code, this.input.now(), id);
  }

  private interrupt(id: string, code: string): void {
    this.input.database.prepare(`
      UPDATE index_jobs
      SET status = 'interrupted', error_code = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(code, this.input.now(), id);
  }
}
