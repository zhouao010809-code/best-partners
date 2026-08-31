import type Database from 'better-sqlite3';

const UTC_MILLISECOND_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export type IndexMetadata = {
  readonly version: number;
  readonly updatedAt: string;
};

export function assertIndexMetadata(value: IndexMetadata): void {
  const parsedUpdatedAt = new Date(value.updatedAt);
  if (
    !Number.isSafeInteger(value.version)
    || value.version < 0
    || !UTC_MILLISECOND_INSTANT.test(value.updatedAt)
    || !Number.isFinite(parsedUpdatedAt.getTime())
    || parsedUpdatedAt.toISOString() !== value.updatedAt
  ) {
    throw new Error('INDEX_METADATA_INVALID');
  }
}

export function loadIndexMetadata(database: Database.Database): IndexMetadata | undefined {
  const row = database.prepare(`
    SELECT version, updated_at AS updatedAt
    FROM index_metadata
    WHERE singleton = 1
  `).get() as IndexMetadata | undefined;
  if (row === undefined) return undefined;
  assertIndexMetadata(row);
  return row;
}
