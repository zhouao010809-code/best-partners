import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { createStateBackup } from '../../src/server/db/backup.js';
import { openStateKernel, type StateKernel } from '../../src/server/db/database.js';
import { applyMigrations } from '../../src/server/db/migrate.js';

const roots: string[] = [];
const normalKernels: Array<Extract<StateKernel, { mode: 'normal' }>> = [];

afterEach(() => {
  for (const kernel of normalKernels.splice(0)) {
    if (kernel.db.open) kernel.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function makeRoots(): { root: string; appDataDir: string; vaultRealRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'xiaozhao-state-kernel-'));
  roots.push(root);
  const appDataDir = join(root, 'app-data');
  const vaultRealRoot = join(root, 'vault');
  mkdirSync(appDataDir, { mode: 0o755 });
  mkdirSync(vaultRealRoot, { mode: 0o700 });
  chmodSync(appDataDir, 0o755);
  return { root, appDataDir, vaultRealRoot };
}

function requireNormal(input: { appDataDir: string; vaultRealRoot: string }) {
  const kernel = openStateKernel(input);
  expect(kernel.mode).toBe('normal');
  if (kernel.mode !== 'normal') throw new Error('expected normal state kernel');
  normalKernels.push(kernel);
  return kernel;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function insertRun(
  db: Database.Database,
  input: { id: string; materialPath?: string; sourceHash?: string; state?: string }
): void {
  db.prepare(`
    INSERT INTO extraction_runs (
      id, material_path, source_raw_sha256, reading_state, state,
      created_at, updated_at
    ) VALUES (?, ?, ?, '未看', ?, ?, ?)
  `).run(
    input.id,
    input.materialPath ?? '01图书馆/测试.md',
    input.sourceHash ?? 'source-hash',
    input.state ?? 'draft',
    '2026-08-31T00:00:00.000Z',
    '2026-08-31T00:00:00.000Z'
  );
}

function migrationsThrough017() {
  const files = [
    [1, '001_initial.sql'],
    [2, '002_read_api_jobs.sql'],
    [8, '008_personal_extraction.sql'],
    [9, '009_personal_ingestion.sql'],
    [10, '010_personal_material_management.sql'],
    [11, '011_personal_trash_delete.sql'],
    [12, '012_assistant_conversations.sql'],
    [14, '014_assistant_drafts.sql'],
    [15, '015_extraction_source_range.sql'],
    [16, '016_assistant_action_plans.sql'],
    [17, '017_company_workspace.sql']
  ] as const;
  return files.map(([version, filename]) => ({
    version,
    sql: readFileSync(new URL(`../../src/server/db/migrations/${filename}`, import.meta.url), 'utf8')
  }));
}

describe('SQLite state kernel', () => {
  it('reserves a new database as 0600 before SQLite opens it', async () => {
    const input = makeRoots();
    const databasePath = join(input.appDataDir, 'state.sqlite3');
    let modeSeenBySqlite: number | undefined;
    const previousUmask = process.umask(0);
    try {
      vi.resetModules();
      vi.doMock('better-sqlite3', async (importOriginal) => {
        const actual = await importOriginal<{ default: typeof Database }>();
        const ActualDatabase = actual.default;
        function ObservedDatabase(...args: ConstructorParameters<typeof Database>) {
          if (args[0] === databasePath && existsSync(databasePath)) {
            modeSeenBySqlite = mode(databasePath);
          }
          return Reflect.construct(ActualDatabase, args) as Database.Database;
        }
        Object.setPrototypeOf(ObservedDatabase, ActualDatabase);
        ObservedDatabase.prototype = ActualDatabase.prototype;
        return { default: ObservedDatabase };
      });
      const { openStateKernel: openIsolatedKernel } = await import('../../src/server/db/database.js');

      const kernel = openIsolatedKernel(input);
      if (kernel.mode === 'normal') normalKernels.push(kernel);

      expect(modeSeenBySqlite).toBe(0o600);
    } finally {
      process.umask(previousUmask);
      vi.doUnmock('better-sqlite3');
      vi.resetModules();
    }
  });

  it('opens fixed external roots with restrictive modes and required pragmas', () => {
    const input = makeRoots();
    const databasePath = join(input.appDataDir, 'state.sqlite3');
    const preexisting = new Database(databasePath);
    preexisting.close();
    chmodSync(databasePath, 0o644);

    const kernel = requireNormal(input);

    expect(kernel.path).toBe(databasePath);
    expect(kernel.backupsDir).toBe(join(input.appDataDir, 'backups'));
    expect(kernel.recoveryDir).toBe(join(input.appDataDir, 'recovery'));
    expect(existsSync(kernel.backupsDir)).toBe(true);
    expect(existsSync(kernel.recoveryDir)).toBe(true);
    expect(mode(input.appDataDir)).toBe(0o700);
    expect(mode(kernel.backupsDir)).toBe(0o700);
    expect(mode(kernel.recoveryDir)).toBe(0o700);
    expect(mode(kernel.path)).toBe(0o600);
    expect(kernel.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(kernel.db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(kernel.db.pragma('busy_timeout', { simple: true })).toBe(5000);
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${kernel.path}${suffix}`;
      if (existsSync(sidecar)) expect(mode(sidecar)).toBe(0o600);
    }
  });

  it('applies published migrations including assistant conversations once across repeated startup', () => {
    const input = makeRoots();
    const first = requireNormal(input);

    const expectedVersions = [1, 2, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21].map((version) => ({ version }));
    expect(first.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual(expectedVersions);
    const extractionColumns = first.db.pragma('table_info(extraction_runs)') as Array<{ name: string }>;
    expect(extractionColumns.map((column) => column.name)).toEqual([
      'id',
      'material_path',
      'source_raw_sha256',
      'reading_state',
      'state',
      'candidate_set_hash',
      'version',
      'created_at',
      'updated_at'
    ]);
    const indexJobColumns = first.db.pragma('table_info(index_jobs)') as Array<{ name: string }>;
    expect(indexJobColumns.map((column) => column.name)).toEqual([
      'id',
      'operation_id',
      'requested_index_version',
      'result_index_version',
      'status',
      'progress_completed',
      'progress_total',
      'error_code',
      'created_at',
      'updated_at'
    ]);
    expect((first.db.pragma('table_info(personal_extraction_runs)') as Array<{ name: string }>).map((column) => column.name))
      .toContain('preview_token');
    expect((first.db.pragma('table_info(personal_ingestion_batches)') as Array<{ name: string }>).map((column) => column.name))
      .toContain('plan_json');
    expect(first.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'company_%' ORDER BY name").all())
      .toEqual([
        { name: 'company_platform_metric_imports' },
        { name: 'company_platform_metric_snapshots' },
        { name: 'company_project_events' },
        { name: 'company_project_ingestion_runs' },
        { name: 'company_projects' },
        { name: 'company_sessions' },
        { name: 'company_users' },
        { name: 'company_workspaces' }
      ]);
    expect(first.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'personal_project_%' ORDER BY name").all())
      .toEqual([
        { name: 'personal_project_files' },
        { name: 'personal_project_operations' },
        { name: 'personal_project_scan_runs' },
        { name: 'personal_project_write_plans' },
        { name: 'personal_projects' }
      ]);
    expect(first.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'personal_projects'").get())
      .toEqual({ name: 'personal_projects' });
    expect(first.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 21").get())
      .toEqual({ count: 1 });
    const projectColumns = first.db.pragma('table_info(personal_projects)') as Array<{ name: string }>;
    expect(projectColumns.map(column => column.name)).toEqual(expect.arrayContaining([
      'id', 'root_path', 'display_name', 'source_revision', 'availability', 'output_root',
      'file_count', 'readable_file_count', 'issue_count', 'created_at', 'updated_at', 'last_scanned_at'
    ]));
    expect(first.db.pragma('foreign_keys', { simple: true })).toBe(1);
    first.close();

    const second = requireNormal(input);
    expect(second.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual(expectedVersions);
  });

  it('upgrades databases recorded at 017 without changing published 017 semantics', () => {
    const migration017 = readFileSync(
      new URL('../../src/server/db/migrations/017_company_workspace.sql', import.meta.url),
      'utf8'
    );
    expect(migration017).toContain('id TEXT PRIMARY KEY');
    expect(migration017).toContain('project_id TEXT NOT NULL REFERENCES company_projects(id) ON DELETE CASCADE');
    expect(migration017).toContain("WHERE state IN ('scanning', 'proposed', 'confirmed')");
    expect(migration017).not.toMatch(/CREATE TABLE company_project_events[\s\S]*operation_id TEXT NOT NULL/);
    expect(migration017).not.toContain('company_project_events_operation_idx');

    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      applyMigrations(db, migrationsThrough017());
      expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
        .toEqual([1, 2, 8, 9, 10, 11, 12, 14, 15, 16, 17].map((version) => ({ version })));

      const now = '2026-09-16T00:00:00.000Z';
      db.prepare('INSERT INTO company_workspaces (id, display_name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('workspace-1', 'Workspace', '/srv/workspace', now, now);
      db.prepare('INSERT INTO company_users (id, workspace_id, display_name, role, password_salt, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('user-1', 'workspace-1', 'Owner', 'owner', 'salt', 'hash', now, now);
      db.prepare('INSERT INTO company_projects (id, workspace_id, name, status, project_root, source_root, config_sha256, confidence_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('project-1', 'workspace-1', 'Project', 'draft', '/srv/workspace/projects/p1', '/srv/workspace/incoming/p1', 'sha', '{}', now, now);
      db.prepare('INSERT INTO company_project_ingestion_runs (id, project_id, source_sha256, state, proposal_json, operation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('run-1', 'project-1', 'source-sha', 'confirmed', '{}', 'op-1', now, now);
      db.prepare('INSERT INTO company_project_events (id, project_id, actor_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('event-1', 'project-1', 'user-1', 'system', '{}', now);

      applyMigrations(db);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
        .toEqual([1, 2, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21].map((version) => ({ version })));
      expect(db.prepare('SELECT project_id, state, operation_id FROM company_project_ingestion_runs WHERE id = ?').get('run-1'))
        .toEqual({ project_id: 'project-1', state: 'confirmed', operation_id: 'op-1' });
      // 017 had no event operation_id; 018 derives a traceable migration value from the legacy event id.
      expect(db.prepare('SELECT project_id, actor_id, operation_id FROM company_project_events WHERE id = ?').get('event-1'))
        .toEqual({ project_id: 'project-1', actor_id: 'user-1', operation_id: 'migration-018:event-1' });
      expect(() => db.prepare('DELETE FROM company_users WHERE id = ?').run('user-1')).toThrow(/FOREIGN KEY/);

      const fresh = new Database(':memory:');
      try {
        fresh.pragma('foreign_keys = ON');
        applyMigrations(fresh);
        const schema = (database: Database.Database) => database.prepare(`
          SELECT type, name, sql
          FROM sqlite_master
          WHERE (type = 'table' OR type = 'index') AND name LIKE 'company_%'
          ORDER BY type, name
        `).all();
        expect(schema(db)).toEqual(schema(fresh));
      } finally {
        fresh.close();
      }

      const insertRun = db.prepare('INSERT INTO company_project_ingestion_runs (id, project_id, source_sha256, state, proposal_json, operation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      insertRun.run('run-2', null, 'source-sha', 'confirmed', '{}', 'op-2', now, now);
      insertRun.run('run-3', null, 'source-open', 'scanning', '{}', 'op-3', now, now);
      expect(() => insertRun.run('run-4', null, 'source-open', 'proposed', '{}', 'op-4', now, now)).toThrow(/UNIQUE/);
      db.prepare('UPDATE company_project_ingestion_runs SET project_id = ? WHERE id = ?').run('project-1', 'run-3');
      applyMigrations(db);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
        .toEqual([1, 2, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21].map((version) => ({ version })));
    } finally {
      db.close();
    }
  });

  it('keeps personal project roots private and constrains project records', () => {
    const db = new Database(':memory:');
    try {
      applyMigrations(db);
      const now = '2026-09-22T00:00:00.000Z';
      const projectId = '11111111-1111-4111-8111-111111111111';
      const conversationId = '22222222-2222-4222-8222-222222222222';
      db.prepare(`INSERT INTO personal_projects
        (id, root_path, display_name, source_revision, availability, output_root, file_count, readable_file_count, issue_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(projectId, '/private/project', '项目 A', 1, 'ready', 'AI工作区', 1, 1, 0, now, now);
      db.prepare('INSERT INTO assistant_conversations (id, updated_at, payload) VALUES (?, ?, ?)')
        .run(conversationId, now, JSON.stringify({}));
      db.prepare(`INSERT INTO personal_project_files
        (id, project_id, relative_path, origin, parse_status, bytes, sha256, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('file-1', projectId, '资料.md', 'source', 'readable', 10, 'a'.repeat(64), now, now);
      db.prepare(`INSERT INTO personal_project_write_plans
        (id, project_id, conversation_id, status, category, target_path, project_revision, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('plan-1', projectId, conversationId, 'pending', '内容草稿', 'AI工作区/内容草稿/稿件.md', 1, '{}', now, now);
      expect(db.prepare('SELECT root_path FROM personal_projects WHERE id = ?').get(projectId))
        .toEqual({ root_path: '/private/project' });
      expect(() => db.prepare(`INSERT INTO personal_project_files
        (id, project_id, relative_path, origin, parse_status, bytes, sha256, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('file-2', projectId, '/escape.md', 'source', 'readable', 10, 'b'.repeat(64), now, now)).toThrow(/CHECK/);
      expect(() => db.prepare(`INSERT INTO personal_project_files
        (id, project_id, relative_path, origin, parse_status, bytes, sha256, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('file-3', projectId, 'bad.md', 'source', 'readable', 10, 'A'.repeat(64), now, now)).toThrow(/CHECK/);
      expect(() => db.prepare(`INSERT INTO personal_project_write_plans
        (id, project_id, conversation_id, status, category, target_path, project_revision, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('plan-2', projectId, conversationId, 'pending', '内容草稿', '../escape.md', 1, '{}', now, now)).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });

  it('fails closed before rebuilding 018 when a generated legacy ID collides', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      applyMigrations(db, migrationsThrough017());
      const now = '2026-09-16T00:00:00.000Z';
      db.prepare('INSERT INTO company_workspaces (id, display_name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('workspace-1', 'Workspace', '/srv/workspace', now, now);
      const insertUser = db.prepare('INSERT INTO company_users (id, workspace_id, display_name, role, password_salt, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      insertUser.run(null, 'workspace-1', 'Null ID', 'operator', 'salt', 'hash', now, now);
      const nullUser = db.prepare('SELECT rowid FROM company_users WHERE display_name = ?').get('Null ID') as { rowid: number };
      const collisionId = `migration-018:company_users:${nullUser.rowid}`;
      insertUser.run(collisionId, 'workspace-1', 'Collision ID', 'reviewer', 'salt', 'hash', now, now);
      const beforeUsers = db.prepare('SELECT id, display_name FROM company_users ORDER BY rowid').all();

      expect(() => applyMigrations(db)).toThrow(/migration 018 legacy ID collision.*company_users/i);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('legacy_alter_table', { simple: true })).toBe(0);
      expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
        .toEqual([1, 2, 8, 9, 10, 11, 12, 14, 15, 16, 17].map((version) => ({ version })));
      expect(db.prepare('SELECT id, display_name FROM company_users ORDER BY rowid').all()).toEqual(beforeUsers);
      expect((db.pragma('table_info(company_users)') as Array<{ name: string; notnull: number; pk: number }>)
        .find((column) => column.name === 'id')).toMatchObject({ notnull: 0, pk: 1 });
      expect(db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE name LIKE '%_018_old'
      `).all()).toEqual([]);
      expect(db.prepare(`
        SELECT name
        FROM sqlite_temp_master
        WHERE type IN ('table', 'trigger') AND name LIKE '%company_migration_018%'
      `).all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('rejects a second active run for one material version but permits terminal history', () => {
    const kernel = requireNormal(makeRoots());
    insertRun(kernel.db, { id: 'run-1' });

    expect(() => insertRun(kernel.db, { id: 'run-2' })).toThrow(/UNIQUE/);
    insertRun(kernel.db, { id: 'run-3', state: 'completed' });
    insertRun(kernel.db, { id: 'run-4', state: 'invalidated' });
  });

  it('enforces company workspace projection constraints without changing personal tables', () => {
    const kernel = requireNormal(makeRoots());
    const tableColumns = (table: string) => (kernel.db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(column => column.name);
    expect(tableColumns('company_workspaces')).toEqual(['id', 'display_name', 'root_path', 'created_at', 'updated_at']);
    expect(tableColumns('company_users')).toEqual(['id', 'workspace_id', 'display_name', 'role', 'password_salt', 'password_hash', 'disabled', 'created_at', 'updated_at']);
    expect(tableColumns('company_sessions')).toEqual(['id_hash', 'user_id', 'expires_at', 'created_at', 'last_seen_at']);
    expect(tableColumns('company_projects')).toEqual(['id', 'workspace_id', 'name', 'client_name', 'status', 'project_root', 'source_root', 'config_sha256', 'confidence_json', 'created_at', 'updated_at', 'selected_skill_ids_json']);
    expect(tableColumns('company_project_ingestion_runs')).toEqual(['id', 'project_id', 'source_sha256', 'state', 'proposal_json', 'operation_id', 'created_at', 'updated_at']);
    expect(tableColumns('company_project_events')).toEqual(['id', 'project_id', 'actor_id', 'operation_id', 'event_type', 'payload_json', 'created_at']);
    expect(tableColumns('company_platform_metric_imports')).toEqual([
      'id', 'workspace_id', 'project_id', 'platform', 'source_relative_path', 'source_sha256',
      'raw_relative_path', 'source_type', 'state', 'row_count', 'imported_count', 'rejected_count',
      'error_json', 'created_at', 'updated_at', 'imported_at'
    ]);
    expect(tableColumns('company_platform_metric_snapshots')).toEqual([
      'id', 'workspace_id', 'project_id', 'platform', 'account_ref', 'content_id', 'content_title',
      'metric_date', 'metric_kind', 'observed_at', 'metrics_json', 'source_type',
      'source_relative_path', 'raw_relative_path', 'source_sha256', 'source_row', 'header_row',
      'sheet_name', 'raw_row_sha256', 'created_at'
    ]);
    expect(kernel.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND name = 'company_project_events_operation_idx'
    `).get()).toEqual({ name: 'company_project_events_operation_idx' });

    const now = '2026-09-16T00:00:00.000Z';
    kernel.db.prepare('INSERT INTO company_workspaces (id, display_name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('workspace-1', 'Workspace', '/srv/workspace', now, now);
    expect(() => kernel.db.prepare('INSERT INTO company_workspaces (id, display_name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('workspace-2', 'Other', '/srv/workspace', now, now)).toThrow(/UNIQUE/);
    kernel.db.prepare('INSERT INTO company_users (id, workspace_id, display_name, role, password_salt, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('user-1', 'workspace-1', 'Owner', 'owner', 'salt', 'hash', now, now);
    expect(() => kernel.db.prepare('INSERT INTO company_users (id, workspace_id, display_name, role, password_salt, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(null, 'workspace-1', 'No ID', 'operator', 'salt', 'hash', now, now)).toThrow(/NOT NULL/);
    expect(() => kernel.db.prepare('INSERT INTO company_users (id, workspace_id, display_name, role, password_salt, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('user-2', 'workspace-1', 'Reviewer', 'reviewer', 'salt', 'hash', now, now)).not.toThrow();
    kernel.db.prepare('INSERT INTO company_projects (id, workspace_id, name, status, project_root, source_root, config_sha256, confidence_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('project-1', 'workspace-1', 'Project', 'draft', '/srv/workspace/projects/p1', '/srv/workspace/incoming/p1', 'sha', '{}', now, now);
    expect(() => kernel.db.prepare('INSERT INTO company_projects (id, workspace_id, name, status, project_root, source_root, config_sha256, confidence_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('project-2', 'workspace-1', 'Duplicate root', 'active', '/srv/workspace/projects/p1', '/srv/workspace/incoming/p2', 'sha2', '{}', now, now)).toThrow(/UNIQUE/);
    const insertRun = kernel.db.prepare('INSERT INTO company_project_ingestion_runs (id, project_id, source_sha256, state, proposal_json, operation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insertRun.run('run-1', null, 'source-sha', 'scanning', '{}', 'op-1', now, now);
    kernel.db.prepare('UPDATE company_project_ingestion_runs SET project_id = ? WHERE id = ?').run('project-1', 'run-1');
    expect(() => insertRun.run('run-2', null, 'source-sha', 'proposed', '{}', 'op-2', now, now)).toThrow(/UNIQUE/);
    insertRun.run('run-3', 'project-1', 'source-sha', 'confirmed', '{}', 'op-3', now, now);
    insertRun.run('run-4', 'project-1', 'source-sha', 'failed', '{}', 'op-4', now, now);
    insertRun.run('run-5', 'project-1', 'source-sha', 'superseded', '{}', 'op-5', now, now);
    insertRun.run('run-6', 'project-1', 'source-sha', 'confirmed', '{}', 'op-6', now, now);
    expect(() => insertRun.run('run-7', 'project-1', 'source-sha', 'not-a-state', '{}', 'op-7', now, now)).toThrow(/CHECK/);
    expect(() => kernel.db.prepare('INSERT INTO company_project_events (id, project_id, actor_id, operation_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('event-1', 'missing-project', null, 'op-missing', 'system', '{}', now)).toThrow(/FOREIGN KEY/);
    kernel.db.prepare('INSERT INTO company_project_events (id, project_id, actor_id, operation_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('event-2', 'project-1', 'user-1', 'op-event', 'system', '{}', now);
    expect(() => kernel.db.prepare('DELETE FROM company_users WHERE id = ?').run('user-1')).toThrow(/FOREIGN KEY/);
    expect(kernel.db.prepare('SELECT actor_id FROM company_project_events WHERE id = ?').get('event-2'))
      .toEqual({ actor_id: 'user-1' });
    expect(kernel.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'extraction_runs'").get())
      .toEqual({ name: 'extraction_runs' });
  });

  it('rejects NULL identifiers across company projection tables', () => {
    const kernel = requireNormal(makeRoots());
    const now = '2026-09-16T00:00:00.000Z';

    kernel.db.prepare('INSERT INTO company_workspaces (id, display_name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('workspace-1', 'Workspace', '/srv/workspace', now, now);
    kernel.db.prepare('INSERT INTO company_users (id, workspace_id, display_name, role, password_salt, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('user-1', 'workspace-1', 'Owner', 'owner', 'salt', 'hash', now, now);
    kernel.db.prepare('INSERT INTO company_projects (id, workspace_id, name, status, project_root, source_root, config_sha256, confidence_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('project-1', 'workspace-1', 'Project', 'draft', '/srv/workspace/projects/p1', '/srv/workspace/incoming/p1', 'sha', '{}', now, now);

    expect(() => kernel.db.prepare('INSERT INTO company_workspaces (id, display_name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(null, 'No ID', '/srv/other-workspace', now, now)).toThrow(/NOT NULL/);
    expect(() => kernel.db.prepare('INSERT INTO company_users (id, workspace_id, display_name, role, password_salt, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(null, 'workspace-1', 'No ID', 'operator', 'salt', 'hash', now, now)).toThrow(/NOT NULL/);
    expect(() => kernel.db.prepare('INSERT INTO company_sessions (id_hash, user_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
      .run(null, 'user-1', now, now, now)).toThrow(/NOT NULL/);
    expect(() => kernel.db.prepare('INSERT INTO company_projects (id, workspace_id, name, status, project_root, source_root, config_sha256, confidence_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(null, 'workspace-1', 'No ID', 'draft', '/srv/workspace/projects/p2', '/srv/workspace/incoming/p2', 'sha-2', '{}', now, now)).toThrow(/NOT NULL/);
    expect(() => kernel.db.prepare('INSERT INTO company_project_ingestion_runs (id, project_id, source_sha256, state, proposal_json, operation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(null, null, 'source-null-id', 'scanning', '{}', 'op-null-id', now, now)).toThrow(/NOT NULL/);
    expect(() => kernel.db.prepare('INSERT INTO company_project_events (id, project_id, actor_id, operation_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(null, 'project-1', null, 'op-null-id', 'system', '{}', now)).toThrow(/NOT NULL/);
  });

  it('rejects duplicate idempotency keys', () => {
    const kernel = requireNormal(makeRoots());
    const insert = kernel.db.prepare(`
      INSERT INTO idempotency_records (
        key, operation, request_hash, response_json, created_at
      ) VALUES (?, 'extract', 'request-hash', NULL, '2026-08-31T00:00:00.000Z')
    `);

    insert.run('stable-key');
    expect(() => insert.run('stable-key')).toThrow(/UNIQUE/);
  });

  it('finishes startup with a valid database', () => {
    const kernel = requireNormal(makeRoots());
    expect(kernel.db.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('backs up uncheckpointed WAL data and retains three verified snapshots', async () => {
    const kernel = requireNormal(makeRoots());
    kernel.db.pragma('wal_autocheckpoint = 0');
    kernel.db.prepare(`
      INSERT INTO audit_events (operation_id, event_type, payload_json, created_at)
      VALUES (?, 'checkpoint-test', '{}', '2026-08-31T00:00:00.000Z')
    `).run('operation-1');
    expect(existsSync(`${kernel.path}-wal`)).toBe(true);
    expect(statSync(`${kernel.path}-wal`).size).toBeGreaterThan(0);

    const firstBackup = await createStateBackup({ db: kernel.db, backupsDir: kernel.backupsDir });
    const copied = new Database(firstBackup, { readonly: true, fileMustExist: true });
    try {
      expect(copied.prepare('SELECT operation_id FROM audit_events').get())
        .toEqual({ operation_id: 'operation-1' });
    } finally {
      copied.close();
    }

    const promoted = [firstBackup];
    for (let index = 2; index <= 5; index += 1) {
      kernel.db.prepare(`
        INSERT INTO audit_events (operation_id, event_type, payload_json, created_at)
        VALUES (?, 'rotation-test', '{}', '2026-08-31T00:00:00.000Z')
      `).run(`operation-${index}`);
      promoted.push(await createStateBackup({ db: kernel.db, backupsDir: kernel.backupsDir }));
    }

    const backups = readdirSync(kernel.backupsDir)
      .filter((name) => name.endsWith('.sqlite3'));
    expect(backups).toHaveLength(3);
    expect(backups).toContain(basename(promoted.at(-1)!));
    expect(readdirSync(kernel.backupsDir).some((name) => name.endsWith('.tmp'))).toBe(false);
    for (const name of backups) {
      const path = join(kernel.backupsDir, name);
      const status = lstatSync(path);
      expect(status.isFile()).toBe(true);
      expect(status.isSymbolicLink()).toBe(false);
      expect(status.nlink).toBe(1);
      expect(mode(path)).toBe(0o600);
      const snapshot = new Database(path, { readonly: true, fileMustExist: true });
      try {
        expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok');
      } finally {
        snapshot.close();
      }
    }
  });

  it('does not rotate verified backups when a new backup fails', async () => {
    const kernel = requireNormal(makeRoots());
    for (let index = 1; index <= 3; index += 1) {
      kernel.db.prepare(`
        INSERT INTO audit_events (operation_id, event_type, payload_json, created_at)
        VALUES (?, 'failure-test', '{}', '2026-08-31T00:00:00.000Z')
      `).run(`operation-${index}`);
      await createStateBackup({ db: kernel.db, backupsDir: kernel.backupsDir });
    }
    const before = readdirSync(kernel.backupsDir).sort();
    kernel.close();

    await expect(createStateBackup({ db: kernel.db, backupsDir: kernel.backupsDir }))
      .rejects.toThrow();
    expect(readdirSync(kernel.backupsDir).sort()).toEqual(before);
  });

  it('keeps database and recovery roots as external siblings outside the vault', () => {
    const input = makeRoots();
    const kernel = requireNormal(input);

    expect(dirname(kernel.path)).toBe(input.appDataDir);
    expect(dirname(kernel.recoveryDir)).toBe(input.appDataDir);
    expect(kernel.recoveryDir).not.toBe(kernel.path);
    const fromVault = relative(input.vaultRealRoot, kernel.recoveryDir);
    expect(fromVault === '..' || fromVault.startsWith('../')).toBe(true);
    expect(isAbsolute(fromVault)).toBe(false);
  });

  it('rejects application data contained by the vault before creating state', () => {
    const input = makeRoots();
    const nestedAppData = join(input.vaultRealRoot, 'app-data');

    expect(() => openStateKernel({
      appDataDir: nestedAppData,
      vaultRealRoot: input.vaultRealRoot
    })).toThrow(/outside/i);
    expect(existsSync(nestedAppData)).toBe(false);
  });

  it('preserves corrupt database bytes and enters a database-free recovery-only mode', () => {
    const input = makeRoots();
    const databasePath = join(input.appDataDir, 'state.sqlite3');
    const recoveryDir = join(input.appDataDir, 'recovery');
    mkdirSync(recoveryDir, { mode: 0o700 });
    mkdirSync(join(recoveryDir, 'batch-2'), { mode: 0o700 });
    mkdirSync(join(recoveryDir, 'batch-1'), { mode: 0o700 });
    const corruptBytes = Buffer.from('this is deliberately not a sqlite database\n'.repeat(8));
    writeFileSync(databasePath, corruptBytes, { mode: 0o600 });
    const backupsDir = join(input.appDataDir, 'backups');
    mkdirSync(backupsDir, { mode: 0o700 });
    writeFileSync(join(backupsDir, 'preserve-me.txt'), 'unchanged', { mode: 0o600 });

    const kernel = openStateKernel(input);

    expect(kernel).toEqual({
      mode: 'recovery-only',
      reason: 'database-corrupt',
      recovery: { entries: ['batch-1', 'batch-2'], count: 2 }
    });
    expect('db' in kernel).toBe(false);
    expect('close' in kernel).toBe(false);
    expect('path' in kernel).toBe(false);
    expect(readFileSync(databasePath)).toEqual(corruptBytes);
    expect(readdirSync(backupsDir)).toEqual(['preserve-me.txt']);
  });

  it('prioritizes corrupt main-database recovery over validating a corrupt old backup', () => {
    const input = makeRoots();
    const databasePath = join(input.appDataDir, 'state.sqlite3');
    const backupsDir = join(input.appDataDir, 'backups');
    const recoveryDir = join(input.appDataDir, 'recovery');
    mkdirSync(backupsDir, { mode: 0o700 });
    mkdirSync(recoveryDir, { mode: 0o700 });
    mkdirSync(join(recoveryDir, 'pending-batch'), { mode: 0o700 });
    const corruptDatabase = Buffer.from('corrupt main database\n'.repeat(16));
    const corruptBackup = Buffer.from('corrupt old backup\n'.repeat(16));
    const backupPath = join(backupsDir, 'state-existing.sqlite3');
    writeFileSync(databasePath, corruptDatabase, { mode: 0o600 });
    writeFileSync(backupPath, corruptBackup, { mode: 0o600 });

    const kernel = openStateKernel(input);

    expect(kernel).toEqual({
      mode: 'recovery-only',
      reason: 'database-corrupt',
      recovery: { entries: ['pending-batch'], count: 1 }
    });
    expect('db' in kernel).toBe(false);
    expect(readFileSync(databasePath)).toEqual(corruptDatabase);
    expect(readFileSync(backupPath)).toEqual(corruptBackup);
  });

  it('still rejects a corrupt named backup when the main database is healthy', () => {
    const input = makeRoots();
    const databasePath = join(input.appDataDir, 'state.sqlite3');
    const seed = new Database(databasePath);
    seed.close();
    const backupsDir = join(input.appDataDir, 'backups');
    mkdirSync(backupsDir, { mode: 0o700 });
    const backupPath = join(backupsDir, 'state-existing.sqlite3');
    const corruptBackup = Buffer.from('corrupt old backup\n'.repeat(16));
    writeFileSync(backupPath, corruptBackup, { mode: 0o600 });

    expect(() => openStateKernel(input)).toThrow();
    expect(readFileSync(backupPath)).toEqual(corruptBackup);
  });

  it.each(['state.sqlite3', 'backups', 'recovery'])(
    'fails closed on a symlinked %s target without touching its sentinel',
    (targetName) => {
      const input = makeRoots();
      const outside = join(input.root, `outside-${targetName.replace('.', '-')}`);
      const sentinel = targetName === 'state.sqlite3' ? outside : join(outside, 'sentinel.txt');
      if (targetName === 'state.sqlite3') {
        writeFileSync(outside, 'external-sentinel', { mode: 0o600 });
      } else {
        mkdirSync(outside, { mode: 0o700 });
        writeFileSync(sentinel, 'external-sentinel', { mode: 0o600 });
      }
      symlinkSync(outside, join(input.appDataDir, targetName));

      expect(() => openStateKernel(input)).toThrow(/unsafe/i);
      expect(readFileSync(sentinel, 'utf8')).toBe('external-sentinel');
    }
  );

  it('fails closed on a hard-linked database without changing either link', () => {
    const input = makeRoots();
    const outside = join(input.root, 'outside-state.sqlite3');
    const outsideDb = new Database(outside);
    outsideDb.exec('CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel VALUES (\'safe\');');
    outsideDb.close();
    const before = readFileSync(outside);
    linkSync(outside, join(input.appDataDir, 'state.sqlite3'));

    expect(() => openStateKernel(input)).toThrow(/unsafe/i);
    expect(readFileSync(outside)).toEqual(before);
    expect(readFileSync(join(input.appDataDir, 'state.sqlite3'))).toEqual(before);
  });

  it.each(['symlink', 'hardlink'] as const)(
    'rejects a %s backup entry during startup before trusting local state',
    (linkKind) => {
      const input = makeRoots();
      const backupsDir = join(input.appDataDir, 'backups');
      mkdirSync(backupsDir, { mode: 0o700 });
      const outside = join(input.root, `outside-${linkKind}.sqlite3`);
      const outsideDb = new Database(outside);
      outsideDb.exec('CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel VALUES (\'safe\');');
      outsideDb.close();
      const before = readFileSync(outside);
      const backupPath = join(backupsDir, 'state-existing.sqlite3');
      if (linkKind === 'symlink') symlinkSync(outside, backupPath);
      else linkSync(outside, backupPath);

      expect(() => {
        const kernel = openStateKernel(input);
        if (kernel.mode === 'normal') normalKernels.push(kernel);
      }).toThrow(/unsafe/i);
      expect(readFileSync(outside)).toEqual(before);
    }
  );

  it.each(['-wal', '-shm'])(
    'fails closed on a symlinked SQLite %s sidecar',
    (suffix) => {
      const input = makeRoots();
      const databasePath = join(input.appDataDir, 'state.sqlite3');
      const seed = new Database(databasePath);
      seed.close();
      const sentinel = join(input.root, `outside${suffix}`);
      writeFileSync(sentinel, 'external-sentinel', { mode: 0o600 });
      symlinkSync(sentinel, `${databasePath}${suffix}`);

      expect(() => openStateKernel(input)).toThrow(/unsafe/i);
      expect(readFileSync(sentinel, 'utf8')).toBe('external-sentinel');
    }
  );

  it('rolls back all SQL from a failed migration transaction', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
      `);
      expect(() => applyMigrations(db, [{
        version: 99,
        sql: `
          CREATE TABLE rollback_probe (id INTEGER PRIMARY KEY);
          INSERT INTO table_that_does_not_exist VALUES (1);
        `
      }])).toThrow();
      expect(db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'rollback_probe'
      `).get()).toBeUndefined();
      expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get())
        .toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});
