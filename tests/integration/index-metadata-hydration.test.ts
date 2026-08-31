import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { loadIndexMetadata } from '../../src/server/index/index-metadata.js';

const databases: Database.Database[] = [];

function database(): Database.Database {
  const db = new Database(':memory:');
  databases.push(db);
  applyMigrations(db);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('loadIndexMetadata', () => {
  it('returns no hydration input before the first published index', () => {
    expect(loadIndexMetadata(database())).toBeUndefined();
  });

  it('loads an exact persisted version and UTC millisecond timestamp', () => {
    const db = database();
    db.prepare(`
      INSERT INTO index_metadata (singleton, version, updated_at) VALUES (1, 8, ?)
    `).run('2026-09-01T12:00:00.000Z');

    expect(loadIndexMetadata(db)).toEqual({
      version: 8,
      updatedAt: '2026-09-01T12:00:00.000Z'
    });
  });

  it.each([
    'not-an-instant',
    '2026-09-01T12:00:00Z',
    '2026-09-01T12:00:00.000+08:00'
  ])('rejects a non-canonical updated_at value %s', (updatedAt) => {
    const db = database();
    db.prepare(`
      INSERT INTO index_metadata (singleton, version, updated_at) VALUES (1, 8, ?)
    `).run(updatedAt);

    expect(() => loadIndexMetadata(db)).toThrowError('INDEX_METADATA_INVALID');
  });

  it('rejects a non-integer version even when SQLite accepts the stored value', () => {
    const db = database();
    db.pragma('ignore_check_constraints = ON');
    db.prepare(`
      INSERT INTO index_metadata (singleton, version, updated_at) VALUES (1, 1.5, ?)
    `).run('2026-09-01T12:00:00.000Z');

    expect(() => loadIndexMetadata(db)).toThrowError('INDEX_METADATA_INVALID');
  });
});
