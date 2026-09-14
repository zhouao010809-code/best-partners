import type Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

function bundledMigrationPath(filename: string): URL {
  const sourcePath = new URL(`./migrations/${filename}`, import.meta.url);
  if (existsSync(sourcePath)) return sourcePath;
  return new URL(`./db/migrations/${filename}`, import.meta.url);
}

function initialMigrations(): readonly Migration[] {
  return [
    { version: 1, sql: readFileSync(bundledMigrationPath('001_initial.sql'), 'utf8') },
    { version: 2, sql: readFileSync(bundledMigrationPath('002_read_api_jobs.sql'), 'utf8') },
    { version: 8, sql: readFileSync(bundledMigrationPath('008_personal_extraction.sql'), 'utf8') },
    { version: 9, sql: readFileSync(bundledMigrationPath('009_personal_ingestion.sql'), 'utf8') },
    { version: 10, sql: readFileSync(bundledMigrationPath('010_personal_material_management.sql'), 'utf8') },
    { version: 11, sql: readFileSync(bundledMigrationPath('011_personal_trash_delete.sql'), 'utf8') },
    { version: 12, sql: readFileSync(bundledMigrationPath('012_assistant_conversations.sql'), 'utf8') },
    { version: 14, sql: readFileSync(bundledMigrationPath('014_assistant_drafts.sql'), 'utf8') },
    { version: 15, sql: readFileSync(bundledMigrationPath('015_extraction_source_range.sql'), 'utf8') },
    { version: 16, sql: readFileSync(bundledMigrationPath('016_assistant_action_plans.sql'), 'utf8') }
  ];
}

function migrationTableExists(db: Database.Database): boolean {
  return db.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = 'schema_migrations'
  `).get() !== undefined;
}

function migrationApplied(db: Database.Database, version: number): boolean {
  if (!migrationTableExists(db)) return false;
  return db.prepare('SELECT 1 AS present FROM schema_migrations WHERE version = ?')
    .get(version) !== undefined;
}

export function applyMigrations(
  db: Database.Database,
  migrations: readonly Migration[] = initialMigrations()
): void {
  for (const migration of migrations) {
    if (migrationApplied(db, migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, new Date().toISOString());
    }).immediate();
  }
}
