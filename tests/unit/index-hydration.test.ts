import { describe, expect, it } from 'vitest';
import {
  INDEX_STALE_AFTER_MS,
  IndexStateController
} from '../../src/server/index/index-state.js';

const NOW = new Date('2026-09-01T12:00:00.000Z');

describe('IndexStateController startup hydration', () => {
  it('keeps a persisted version zero in building state', () => {
    const controller = new IndexStateController(() => NOW, {
      version: 0,
      updatedAt: '2026-09-01T11:59:59.000Z'
    });

    expect(controller.snapshot()).toEqual({
      status: 'building',
      version: 0,
      startedAt: NOW.toISOString()
    });
  });

  it('restores a fresh persisted success as the current ready version', () => {
    const updatedAt = '2026-09-01T11:59:59.000Z';
    const controller = new IndexStateController(() => NOW, {
      version: 12,
      updatedAt
    });

    expect(controller.snapshot()).toEqual({
      status: 'ready',
      version: 12,
      refreshedAt: updatedAt
    });
  });

  it('restores a success at the 60-second boundary as stale with its version intact', () => {
    const updatedAt = new Date(NOW.getTime() - INDEX_STALE_AFTER_MS).toISOString();
    const controller = new IndexStateController(() => NOW, {
      version: 12,
      updatedAt
    });

    expect(controller.snapshot()).toEqual({
      status: 'stale',
      version: 12,
      lastSuccessAt: updatedAt,
      reason: 'INDEX_REFRESH_TIMEOUT'
    });
  });

  it('turns the first failed startup refresh stale without losing the hydrated version', () => {
    const updatedAt = '2026-09-01T11:59:59.000Z';
    const controller = new IndexStateController(() => NOW, {
      version: 12,
      updatedAt
    });

    controller.recordFailure('Authorization: Bearer must-not-leak');

    expect(controller.snapshot()).toEqual({
      status: 'stale',
      version: 12,
      lastSuccessAt: updatedAt,
      reason: 'Authorization: Bearer must-not-leak'
    });
  });

  it.each([
    { version: -1, updatedAt: '2026-09-01T11:59:59.000Z' },
    { version: 1.5, updatedAt: '2026-09-01T11:59:59.000Z' },
    { version: 1, updatedAt: 'not-an-instant' },
    { version: 1, updatedAt: '2026-09-01T11:59:59Z' },
    { version: 1, updatedAt: '2026-09-01T11:59:59.000+08:00' }
  ])('rejects invalid hydrated metadata %#', (metadata) => {
    expect(() => new IndexStateController(() => NOW, metadata))
      .toThrowError('INDEX_METADATA_INVALID');
  });
});
