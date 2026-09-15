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

    const expectedVersions = [1, 2, 8, 9, 10, 11, 12, 14, 15, 16, 17].map((version) => ({ version }));
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
        { name: 'company_project_events' },
        { name: 'company_project_ingestion_runs' },
        { name: 'company_projects' },
        { name: 'company_sessions' },
        { name: 'company_users' },
        { name: 'company_workspaces' }
      ]);
    first.close();

    const second = requireNormal(input);
    expect(second.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual(expectedVersions);
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
    expect(tableColumns('company_projects')).toEqual(['id', 'workspace_id', 'name', 'client_name', 'status', 'project_root', 'source_root', 'config_sha256', 'confidence_json', 'created_at', 'updated_at']);
    expect(tableColumns('company_project_ingestion_runs')).toEqual(['id', 'project_id', 'source_sha256', 'state', 'proposal_json', 'operation_id', 'created_at', 'updated_at']);
    expect(tableColumns('company_project_events')).toEqual(['id', 'project_id', 'actor_id', 'event_type', 'payload_json', 'created_at']);

    const now = '2026-09-16T00:00:00.000Z';
    kernel.db.prepare('INSERT INTO company_workspaces (id, display_name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('workspace-1', 'Workspace', '/srv/workspace', now, now);
    expect(() => kernel.db.prepare('INSERT INTO company_workspaces (id, display_name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('workspace-2', 'Other', '/srv/workspace', now, now)).toThrow(/UNIQUE/);
    kernel.db.prepare('INSERT INTO company_users (id, workspace_id, display_name, role, password_salt, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('user-1', 'workspace-1', 'Owner', 'owner', 'salt', 'hash', now, now);
    expect(() => kernel.db.prepare('INSERT INTO company_users (id, workspace_id, display_name, role, password_salt, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('user-2', 'workspace-1', 'Reviewer', 'reviewer', 'salt', 'hash', now, now)).not.toThrow();
    kernel.db.prepare('INSERT INTO company_projects (id, workspace_id, name, status, project_root, source_root, config_sha256, confidence_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('project-1', 'workspace-1', 'Project', 'draft', '/srv/workspace/projects/p1', '/srv/workspace/incoming/p1', 'sha', '{}', now, now);
    expect(() => kernel.db.prepare('INSERT INTO company_projects (id, workspace_id, name, status, project_root, source_root, config_sha256, confidence_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('project-2', 'workspace-1', 'Duplicate root', 'active', '/srv/workspace/projects/p1', '/srv/workspace/incoming/p2', 'sha2', '{}', now, now)).toThrow(/UNIQUE/);
    const insertRun = kernel.db.prepare('INSERT INTO company_project_ingestion_runs (id, project_id, source_sha256, state, proposal_json, operation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insertRun.run('run-1', 'project-1', 'source-sha', 'scanning', '{}', 'op-1', now, now);
    expect(() => insertRun.run('run-2', 'project-1', 'source-sha', 'proposed', '{}', 'op-2', now, now)).toThrow(/UNIQUE/);
    insertRun.run('run-3', 'project-1', 'source-sha', 'failed', '{}', 'op-3', now, now);
    expect(() => insertRun.run('run-4', 'project-1', 'source-sha', 'not-a-state', '{}', 'op-4', now, now)).toThrow(/CHECK/);
    expect(() => kernel.db.prepare('INSERT INTO company_project_events (id, project_id, actor_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('event-1', 'missing-project', null, 'system', '{}', now)).toThrow(/FOREIGN KEY/);
    expect(kernel.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'extraction_runs'").get())
      .toEqual({ name: 'extraction_runs' });
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
