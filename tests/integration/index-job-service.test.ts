import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../../src/server/db/migrate.js';
import {
  IndexScheduler,
  type IndexRefreshAttempt
} from '../../src/server/index/index-scheduler.js';
import { IndexStateController } from '../../src/server/index/index-state.js';
import { IndexJobService, type IndexSchedulerPort } from '../../src/server/services/index-job-service.js';

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
});

function openDatabase(): Database.Database {
  const database = new Database(':memory:');
  databases.push(database);
  applyMigrations(database);
  return database;
}

describe('IndexJobService background persistence', () => {
  it.each([
    {
      name: 'completes from its successful attempt despite a later unrelated failure',
      targetFails: false,
      laterFails: true,
      expectedStatus: 'completed',
      expectedError: null
    },
    {
      name: 'fails from its failed attempt despite a later unrelated success',
      targetFails: true,
      laterFails: false,
      expectedStatus: 'failed',
      expectedError: 'INDEX_REBUILD_FAILED'
    }
  ])('$name', async ({ targetFails, laterFails, expectedStatus, expectedError }) => {
    const database = openDatabase();
    const releases: Array<() => void> = [];
    const started: Array<() => void> = [];
    const waits = [0, 1, 2].map((index) => new Promise<void>((resolve) => {
      releases[index] = resolve;
    }));
    const starts = [0, 1, 2].map((index) => new Promise<void>((resolve) => {
      started[index] = resolve;
    }));
    let attempts = 0;
    const now = () => new Date('2026-08-31T00:00:00.000Z');
    const scheduler = new IndexScheduler({
      refresh: async () => {
        const attempt = attempts++;
        started[attempt]?.();
        await waits[attempt];
        if ((attempt === 1 && targetFails) || (attempt === 2 && laterFails)) {
          throw new Error('attempt failed');
        }
        if (attempt > 0) {
          database.prepare(`
            UPDATE index_metadata SET version = 1, updated_at = ? WHERE singleton = 1
          `).run(now().toISOString());
        }
        return {
          status: 'ready' as const,
          checked: 1,
          total: 1,
          version: attempt > 0 ? 1 : 0
        };
      },
      state: new IndexStateController(now),
      intervals: { every: () => () => {} },
      deadlines: { after: () => () => {} },
      now
    });
    const service = new IndexJobService({
      database,
      scheduler,
      currentIndexVersion: () => 0,
      now: () => now().toISOString(),
      operationIdFactory: () => 'operation-1',
      jobIdFactory: () => 'job-1'
    });

    const first = scheduler.refreshNow();
    await starts[0];
    const created = service.createRebuild({ expectedIndexVersion: 0, idempotencyKey: 'attributed-job' });
    service.start(created.job.id);
    releases[0]?.();
    await starts[1];
    const unrelated = scheduler.refreshNow();
    releases[1]?.();

    await vi.waitFor(() => {
      expect(database.prepare(`
        SELECT status, error_code AS errorCode FROM index_jobs WHERE id = 'job-1'
      `).get()).toEqual({ status: expectedStatus, errorCode: expectedError });
    });
    await starts[2];
    releases[2]?.();
    await Promise.all([first, unrelated]);
    expect(database.prepare(`
      SELECT status, error_code AS errorCode FROM index_jobs WHERE id = 'job-1'
    `).get()).toEqual({ status: expectedStatus, errorCode: expectedError });
    await service.close();
  });

  it('does not publish partial refresh progress as the last successful index metadata time', async () => {
    const database = openDatabase();
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    let calls = 0;
    const scheduler: IndexSchedulerPort = {
      requestFocusRefresh: async (): Promise<IndexRefreshAttempt> => {
        calls += 1;
        if (calls === 1) {
          return {
            generation: 1,
            outcome: 'succeeded',
            refresh: { status: 'refreshing', checked: 1, total: 2, version: 0 }
          };
        }
        await ready;
        database.prepare(`
          UPDATE index_metadata
          SET version = 1, updated_at = '2026-08-31T00:01:00.000Z'
          WHERE singleton = 1
        `).run();
        return {
          generation: 2,
          outcome: 'succeeded',
          refresh: { status: 'ready', checked: 2, total: 2, version: 1 }
        };
      },
      snapshot: () => ({
        state: { status: 'building', version: 0, startedAt: '2026-08-31T00:00:00.000Z' }
      })
    };
    let tick = 0;
    const service = new IndexJobService({
      database,
      scheduler,
      currentIndexVersion: () => 0,
      now: () => new Date(Date.parse('2026-08-31T00:00:00.000Z') + tick++ * 1_000).toISOString(),
      operationIdFactory: () => 'operation-1',
      jobIdFactory: () => 'job-1'
    });
    const initialMetadata = database.prepare(`
      SELECT version, updated_at AS updatedAt FROM index_metadata WHERE singleton = 1
    `).get();
    const created = service.createRebuild({ expectedIndexVersion: 0, idempotencyKey: 'partial-refresh' });

    service.start(created.job.id);
    await vi.waitFor(() => {
      expect(database.prepare(`
        SELECT progress_completed AS completed, progress_total AS total
        FROM index_jobs WHERE id = 'job-1'
      `).get()).toEqual({ completed: 1, total: 2 });
    });

    expect(database.prepare(`
      SELECT version, updated_at AS updatedAt FROM index_metadata WHERE singleton = 1
    `).get()).toEqual(initialMetadata);

    releaseReady();
    await vi.waitFor(() => {
      expect(database.prepare(`SELECT status FROM index_jobs WHERE id = 'job-1'`).get())
        .toEqual({ status: 'completed' });
    });
    expect(database.prepare(`
      SELECT version, updated_at AS updatedAt FROM index_metadata WHERE singleton = 1
    `).get()).toEqual({ version: 1, updatedAt: '2026-08-31T00:01:00.000Z' });
  });

  it('attaches an immediate rejection consumer even when failure persistence also throws', async () => {
    const database = openDatabase();
    let rejectRefresh!: (error: Error) => void;
    const refresh = new Promise<IndexRefreshAttempt>((_resolve, reject) => {
      rejectRefresh = reject;
    });
    const scheduler: IndexSchedulerPort = {
      requestFocusRefresh: () => refresh,
      snapshot: () => ({
        state: { status: 'building', version: 0, startedAt: '2026-08-31T00:00:00.000Z' }
      })
    };
    const service = new IndexJobService({
      database,
      scheduler,
      currentIndexVersion: () => 0,
      now: () => '2026-08-31T00:00:00.000Z',
      operationIdFactory: () => 'operation-1',
      jobIdFactory: () => 'job-1'
    });
    const created = service.createRebuild({ expectedIndexVersion: 0, idempotencyKey: 'faulted-failure-write' });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      service.start(created.job.id);
      database.exec('DROP TABLE index_jobs');
      rejectRefresh(new Error('refresh failed'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
