import type Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';

export interface Migration {
  readonly version: number;
  readonly sql: string;
  readonly requiresForeignKeysOff?: boolean;
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
    { version: 16, sql: readFileSync(bundledMigrationPath('016_assistant_action_plans.sql'), 'utf8') },
    { version: 17, sql: readFileSync(bundledMigrationPath('017_company_workspace.sql'), 'utf8') },
    {
      version: 18,
      sql: readFileSync(bundledMigrationPath('018_company_workspace_constraints.sql'), 'utf8'),
      requiresForeignKeysOff: true
    },
    { version: 19, sql: readFileSync(bundledMigrationPath('019_company_project_skill_bindings.sql'), 'utf8') },
    { version: 20, sql: readFileSync(bundledMigrationPath('020_company_platform_metrics.sql'), 'utf8') },
    { version: 21, sql: readFileSync(bundledMigrationPath('021_personal_projects.sql'), 'utf8') },
    { version: 22, sql: readFileSync(bundledMigrationPath('022_project_creations.sql'), 'utf8') },
    { version: 23, sql: readFileSync(bundledMigrationPath('023_project_creative_context.sql'), 'utf8') }
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
    const rebuildsTables = migration.requiresForeignKeysOff === true;
    let foreignKeysBefore: number | undefined;
    let legacyAlterTableBefore: number | undefined;
    try {
      if (rebuildsTables) {
        foreignKeysBefore = db.pragma('foreign_keys', { simple: true }) as number;
        legacyAlterTableBefore = db.pragma('legacy_alter_table', { simple: true }) as number;
        if (foreignKeysBefore === 1) db.pragma('foreign_keys = OFF');
        db.pragma('legacy_alter_table = ON');
      }
      db.transaction(() => {
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(migration.version, new Date().toISOString());
      }).immediate();
    } finally {
      if (rebuildsTables) {
        if (legacyAlterTableBefore !== undefined) {
          db.pragma(`legacy_alter_table = ${legacyAlterTableBefore === 1 ? 'ON' : 'OFF'}`);
        }
        if (foreignKeysBefore === 1) db.pragma('foreign_keys = ON');
      }
    }
  }
}
