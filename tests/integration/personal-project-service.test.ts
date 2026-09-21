import Database from 'better-sqlite3';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createProjectService } from '../../src/server/projects/project-service.js';
import { scanProjectFolder, type ProjectScanResult } from '../../src/server/projects/project-scanner.js';

const databases: Database.Database[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'personal-project-service-'));
  directories.push(root);
  const vaultRoot = join(root, 'vault');
  const stateRoot = join(root, 'state');
  const projectRoot = join(root, 'client-project');
  await mkdir(vaultRoot); await mkdir(stateRoot); await mkdir(projectRoot);
  await writeFile(join(projectRoot, 'README.md'), '# 项目说明\n客户需要获客内容\n');
  await writeFile(join(projectRoot, 'brief.txt'), '第一版选题\n');
  await mkdir(join(projectRoot, 'AI工作区'));
  await writeFile(join(projectRoot, 'AI工作区', 'draft.md'), '# 草稿\n');
  const database = new Database(':memory:'); databases.push(database); applyMigrations(database);
  let clock = new Date('2026-09-22T00:00:00.000Z');
  const service = createProjectService({ database, vaultRoot, stateRoot, now: () => new Date(clock) });
  return { root, vaultRoot, stateRoot, projectRoot, database, service, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

describe('personal project registry and index', () => {
  it('scans, binds, searches and reads a project without exposing private fields', async () => {
    const f = await fixture();
    const preview = await f.service.scan(f.projectRoot);
    expect(Object.keys(preview).sort()).toEqual([
      'displayName', 'entries', 'expiresAt', 'fileCount', 'guidanceFiles', 'ignoredCount',
      'issueCount', 'issues', 'readableFileCount', 'scanId', 'sourceSha256', 'unsupportedCount'
    ]);
    expect(preview.displayName).toBe('client-project');
    expect(preview.fileCount).toBe(3);
    expect(preview.guidanceFiles).toEqual(['README.md', 'brief.txt']);
    expect(preview).not.toHaveProperty('root_path');
    expect(preview).not.toHaveProperty('sourceRoot');
    expect(preview).not.toHaveProperty('proposal_json');
    expect(preview).not.toHaveProperty('content_text');
    const summary = await f.service.bind(preview.scanId, { sourceSha256: preview.sourceSha256 });
    expect(summary).toEqual(expect.objectContaining({ displayName: 'client-project', sourceRevision: 1, availability: 'ready', fileCount: 3 }));
    expect(Object.keys(summary).sort()).toEqual(['availability', 'createdAt', 'displayName', 'fileCount', 'id', 'issueCount', 'lastScannedAt', 'outputRoot', 'readableFileCount', 'sourceRevision', 'updatedAt']);
    const files = await f.service.listFiles(summary.id, { search: '获客', limit: 10 });
    expect(files.items.map((item) => item.relativePath)).toEqual(['README.md']);
    expect((await f.service.listFiles(summary.id, { origin: 'output' })).items.map((item) => item.relativePath)).toEqual(['AI工作区', 'AI工作区/draft.md']);
    const detail = await f.service.readFile(summary.id, 'README.md');
    expect(detail.content).toContain('获客内容');
    expect(detail).not.toHaveProperty('absolutePath');
    expect(await f.service.context(summary.id)).toMatchObject({ id: summary.id, displayName: 'client-project', sourceRevision: 1 });
  });

  it('refreshes an edited source atomically and removes deleted files', async () => {
    const f = await fixture();
    const preview = await f.service.scan(f.projectRoot);
    const summary = await f.service.bind(preview.scanId, { sourceSha256: preview.sourceSha256 });
    await rm(join(f.projectRoot, 'brief.txt'));
    await writeFile(join(f.projectRoot, 'README.md'), '# 更新后的说明\n新的获客策略\n');
    const refreshed = await f.service.refresh(summary.id);
    expect(refreshed.sourceRevision).toBe(2);
    expect((await f.service.listFiles(summary.id, { search: '新的' })).total).toBe(1);
    await expect(f.service.readFile(summary.id, 'brief.txt')).rejects.toMatchObject({ code: 'PROJECT_FILE_NOT_FOUND' });
    const row = f.database.prepare('SELECT COUNT(*) AS count, MIN(indexed_revision) AS revision FROM personal_project_files WHERE project_id = ?').get(summary.id) as { count: number; revision: number };
    expect(row).toEqual({ count: 3, revision: 2 });
  });

  it('rejects stale, duplicate and overlapping bindings and supports reconnect', async () => {
    const f = await fixture();
    const first = await f.service.scan(f.projectRoot);
    const summary = await f.service.bind(first.scanId, { sourceSha256: first.sourceSha256 });
    const duplicate = await f.service.scan(f.projectRoot);
    await expect(f.service.bind(duplicate.scanId, { sourceSha256: duplicate.sourceSha256 })).rejects.toMatchObject({ code: 'PROJECT_ROOT_OVERLAP' });
    const nested = join(f.projectRoot, 'nested'); await mkdir(nested); await writeFile(join(nested, 'a.md'), 'nested');
    const nestedPreview = await f.service.scan(nested);
    await expect(f.service.bind(nestedPreview.scanId, { sourceSha256: nestedPreview.sourceSha256 })).rejects.toMatchObject({ code: 'PROJECT_ROOT_OVERLAP' });
    const moved = join(f.root, 'moved-client'); await mkdir(moved); await writeFile(join(moved, 'new.md'), '新目录');
    const reconnectPreview = await f.service.scan(moved);
    const reconnected = await f.service.reconnect(summary.id, reconnectPreview.scanId, { sourceSha256: reconnectPreview.sourceSha256 });
    expect(reconnected.id).toBe(summary.id);
    expect(reconnected.displayName).toBe(summary.displayName);
    expect(reconnected.sourceRevision).toBe(2);
  });

  it('marks missing roots as reconnect-required and throttles ensureFresh', async () => {
    const f = await fixture();
    const preview = await f.service.scan(f.projectRoot);
    const summary = await f.service.bind(preview.scanId, { sourceSha256: preview.sourceSha256 });
    await rm(f.projectRoot, { recursive: true, force: true });
    expect((await f.service.refresh(summary.id)).availability).toBe('reconnect-required');
    expect((await f.service.listFiles(summary.id, {})).items.length).toBeGreaterThan(0);
    expect((await f.service.ensureFresh(summary.id)).availability).toBe('reconnect-required');
    const count = f.database.prepare('SELECT COUNT(*) AS count FROM personal_project_operations WHERE project_id = ?').get(summary.id) as { count: number };
    expect(count.count).toBe(1);
  });

  it('rejects protected roots and expired or mismatched scan confirmations', async () => {
    const f = await fixture();
    await expect(f.service.scan(f.vaultRoot)).rejects.toMatchObject({ code: 'PROJECT_ROOT_PROTECTED' });
    const nestedProtectedRoot = join(f.vaultRoot, 'nested-project');
    await mkdir(nestedProtectedRoot);
    await expect(f.service.scan(nestedProtectedRoot)).rejects.toMatchObject({ code: 'PROJECT_ROOT_PROTECTED' });
    const preview = await f.service.scan(f.projectRoot);
    await expect(f.service.bind(preview.scanId, { sourceSha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'PROJECT_SCAN_HASH_MISMATCH' });
    await expect(f.service.bind(preview.scanId, { sourceSha256: preview.sourceSha256 })).resolves.toMatchObject({ sourceRevision: 1 });
    const expiring = await f.service.scan(f.projectRoot);
    f.advance(15 * 60 * 1000 + 1);
    await expect(f.service.bind(expiring.scanId, { sourceSha256: expiring.sourceSha256 })).rejects.toMatchObject({ code: 'PROJECT_SCAN_EXPIRED' });
  });

  it('maps missing and replaced scan roots to stable reconnect errors', async () => {
    const missing = await fixture();
    const missingPreview = await missing.service.scan(missing.projectRoot);
    await rm(missing.projectRoot, { recursive: true, force: true });
    await expect(missing.service.bind(missingPreview.scanId, { sourceSha256: missingPreview.sourceSha256 })).rejects.toMatchObject({ code: 'PROJECT_ROOT_RECONNECT_REQUIRED' });

    const replaced = await fixture();
    const replacement = join(replaced.root, 'replacement');
    await mkdir(replacement);
    await writeFile(join(replacement, 'new.md'), 'replacement');
    const replacedPreview = await replaced.service.scan(replaced.projectRoot);
    await rm(replaced.projectRoot, { recursive: true, force: true });
    await symlink(replacement, replaced.projectRoot);
    await expect(replaced.service.bind(replacedPreview.scanId, { sourceSha256: replacedPreview.sourceSha256 })).rejects.toMatchObject({ code: 'PROJECT_ROOT_RECONNECT_REQUIRED' });
  });

  it('reconnects in place, stales pending plans, and preserves project identity and operations', async () => {
    const f = await fixture();
    const preview = await f.service.scan(f.projectRoot);
    const summary = await f.service.bind(preview.scanId, { sourceSha256: preview.sourceSha256 });
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const planId = '22222222-2222-4222-8222-222222222222';
    f.database.prepare('INSERT INTO assistant_conversations (id, updated_at, payload) VALUES (?, ?, ?)').run(conversationId, '2026-09-22T00:00:00.000Z', '{}');
    f.database.prepare(`INSERT INTO personal_project_write_plans
      (id, project_id, conversation_id, message_id, category, title, summary, content, content_sha256, source_revision, target_path, status, created_at, expires_at, updated_at)
      VALUES (?, ?, ?, ?, '内容草稿', ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(planId, summary.id, conversationId, '33333333-3333-4333-8333-333333333333', '待确认', '待确认', '草稿内容', '0'.repeat(64), summary.sourceRevision, '内容草稿/待确认.md', '2026-09-22T00:00:00.000Z', '2026-09-23T00:00:00.000Z', '2026-09-22T00:00:00.000Z');
    const oldOperationCount = (f.database.prepare('SELECT COUNT(*) AS count FROM personal_project_operations WHERE project_id = ?').get(summary.id) as { count: number }).count;
    const moved = join(f.root, 'reconnect-target'); await mkdir(moved); await writeFile(join(moved, 'new.md'), '重连后的文件');
    const reconnectPreview = await f.service.scan(moved);
    const reconnected = await f.service.reconnect(summary.id, reconnectPreview.scanId, { sourceSha256: reconnectPreview.sourceSha256 });
    expect(reconnected.id).toBe(summary.id);
    expect((f.database.prepare('SELECT status FROM personal_project_write_plans WHERE id = ?').get(planId) as { status: string }).status).toBe('stale');
    expect((f.database.prepare('SELECT COUNT(*) AS count FROM personal_project_operations WHERE project_id = ?').get(summary.id) as { count: number }).count).toBeGreaterThan(oldOperationCount);
    expect((await f.service.context(summary.id)).id).toBe(summary.id);
  });

  it('serializes concurrent binds and refreshes without mixed indexed revisions', async () => {
    const f = await fixture();
    const secondRoot = join(f.root, 'second-project');
    await mkdir(secondRoot); await writeFile(join(secondRoot, 'second.md'), 'second');
    const firstPreview = await f.service.scan(f.projectRoot);
    const secondPreview = await f.service.scan(secondRoot);
    const bound = await Promise.all([
      f.service.bind(firstPreview.scanId, { sourceSha256: firstPreview.sourceSha256 }),
      f.service.bind(secondPreview.scanId, { sourceSha256: secondPreview.sourceSha256 })
    ]);
    expect(new Set(bound.map((item) => item.id)).size).toBe(2);
    expect(bound.every((item) => item.sourceRevision === 1)).toBe(true);
    const refreshed = await Promise.all([f.service.refresh(bound[0]!.id), f.service.refresh(bound[0]!.id)]);
    expect(refreshed.map((item) => item.sourceRevision)).toEqual([2, 3]);
    const rows = f.database.prepare('SELECT DISTINCT indexed_revision AS revision FROM personal_project_files WHERE project_id = ?').all(bound[0]!.id) as Array<{ revision: number }>;
    expect(rows).toEqual([{ revision: 3 }]);
  });

  it('keeps unreadable files searchable by metadata while indexing readable siblings', async () => {
    const f = await fixture();
    await writeFile(join(f.projectRoot, 'binary.md'), Buffer.from([0xff, 0xfe, 0xfd]));
    const preview = await f.service.scan(f.projectRoot);
    const summary = await f.service.bind(preview.scanId, { sourceSha256: preview.sourceSha256 });
    const binary = (await f.service.listFiles(summary.id, { search: 'binary.md' })).items[0];
    expect(binary).toMatchObject({ parseStatus: 'failed' });
    expect(binary?.problem).toBe('PARSE_FAILED');
    expect((await f.service.listFiles(summary.id, { search: '获客' })).total).toBe(1);
  });

  it('refreshes after the freshness throttle and exposes stable problems for unsupported and oversized files', async () => {
    const f = await fixture();
    await writeFile(join(f.projectRoot, 'archive.bin'), Buffer.from([1, 2, 3]));
    await writeFile(join(f.projectRoot, 'large.md'), Buffer.alloc(2 * 1024 * 1024 + 1, 'x'));
    const preview = await f.service.scan(f.projectRoot);
    const summary = await f.service.bind(preview.scanId, { sourceSha256: preview.sourceSha256 });
    await writeFile(join(f.projectRoot, 'brief.txt'), '外部编辑后的选题\n');
    f.advance(1_001);
    const refreshed = await f.service.ensureFresh(summary.id);
    expect(refreshed.sourceRevision).toBe(2);
    expect((await f.service.listFiles(summary.id, { search: '外部编辑' })).total).toBe(1);
    expect((await f.service.listFiles(summary.id, { search: 'archive.bin' })).items[0]).toMatchObject({ parseStatus: 'unsupported', problem: 'FILE_TYPE_UNSUPPORTED' });
    expect((await f.service.listFiles(summary.id, { search: 'large.md' })).items[0]).toMatchObject({ parseStatus: 'too-large', problem: 'FILE_TOO_LARGE_FOR_INDEX' });
    expect(await f.service.readFile(summary.id, 'archive.bin')).toMatchObject({ parseStatus: 'unsupported', problem: 'FILE_TYPE_UNSUPPORTED' });
    expect(await f.service.readFile(summary.id, 'large.md')).toMatchObject({ parseStatus: 'too-large', problem: 'FILE_TOO_LARGE_FOR_INDEX' });
  });

  it('does not read through a replaced project-root symlink', async () => {
    const f = await fixture();
    const preview = await f.service.scan(f.projectRoot);
    const summary = await f.service.bind(preview.scanId, { sourceSha256: preview.sourceSha256 });
    const external = join(f.root, 'external-target');
    await mkdir(external);
    await writeFile(join(external, 'README.md'), '外部目录绝不能被读取');
    await rm(f.projectRoot, { recursive: true, force: true });
    await symlink(external, f.projectRoot);
    const detail = await f.service.readFile(summary.id, 'README.md');
    expect(detail.problem).toBe('PROJECT_ROOT_RECONNECT_REQUIRED');
    expect(detail.content).toBeUndefined();
  });

  it('sanitizes scanner errors before exposing them from scan', async () => {
    const f = await fixture();
    const service = createProjectService({
      database: f.database,
      vaultRoot: f.vaultRoot,
      stateRoot: f.stateRoot,
      scan: async () => {
        const error = new Error(`permission denied: ${f.projectRoot}`) as Error & { code: string };
        error.code = 'EACCES';
        throw error;
      }
    });
    await expect(service.scan(f.projectRoot)).rejects.toSatisfy((error: unknown) => {
      expect(String(error)).not.toContain(f.projectRoot);
      expect(error).toMatchObject({ code: 'PROJECT_SCAN_FAILED' });
      return true;
    });
  });

  it('sanitizes proposal rescan races for bind and reconnect', async () => {
    const f = await fixture();
    let bindCalls = 0;
    const bindScanner = async (rootPath: string, options?: Parameters<typeof scanProjectFolder>[1]): Promise<ProjectScanResult> => {
      bindCalls += 1;
      if (bindCalls > 1) {
        const error = new Error(`source changed while scanning ${rootPath}`) as Error & { code: string };
        error.code = 'PROJECT_SOURCE_CHANGED';
        throw error;
      }
      return scanProjectFolder(rootPath, options);
    };
    const bindService = createProjectService({ database: f.database, vaultRoot: f.vaultRoot, stateRoot: f.stateRoot, scan: bindScanner });
    const bindPreview = await bindService.scan(f.projectRoot);
    await expect(bindService.bind(bindPreview.scanId, { sourceSha256: bindPreview.sourceSha256 })).rejects.toSatisfy((error: unknown) => {
      expect(String(error)).not.toContain(f.projectRoot);
      expect(error).toMatchObject({ code: 'PROJECT_SOURCE_CHANGED' });
      return true;
    });

    const basePreview = await f.service.scan(f.projectRoot);
    const summary = await f.service.bind(basePreview.scanId, { sourceSha256: basePreview.sourceSha256 });
    const moved = join(f.root, 'rescan-race-target'); await mkdir(moved); await writeFile(join(moved, 'new.md'), 'new');
    let reconnectCalls = 0;
    const reconnectScanner = async (rootPath: string, options?: Parameters<typeof scanProjectFolder>[1]): Promise<ProjectScanResult> => {
      reconnectCalls += 1;
      if (reconnectCalls > 1) {
        const error = new Error(`source changed while reconnecting ${rootPath}`) as Error & { code: string };
        error.code = 'PROJECT_SOURCE_CHANGED';
        throw error;
      }
      return scanProjectFolder(rootPath, options);
    };
    const reconnectService = createProjectService({ database: f.database, vaultRoot: f.vaultRoot, stateRoot: f.stateRoot, scan: reconnectScanner });
    const reconnectPreview = await reconnectService.scan(moved);
    await expect(reconnectService.reconnect(summary.id, reconnectPreview.scanId, { sourceSha256: reconnectPreview.sourceSha256 })).rejects.toSatisfy((error: unknown) => {
      expect(String(error)).not.toContain(moved);
      expect(error).toMatchObject({ code: 'PROJECT_SOURCE_CHANGED' });
      return true;
    });
  });

  it('guards refresh commits across two service instances', async () => {
    const f = await fixture();
    const preview = await f.service.scan(f.projectRoot);
    const summary = await f.service.bind(preview.scanId, { sourceSha256: preview.sourceSha256 });
    const secondService = createProjectService({ database: f.database, vaultRoot: f.vaultRoot, stateRoot: f.stateRoot });
    await writeFile(join(f.projectRoot, 'brief.txt'), '两个实例同时刷新');
    const results = await Promise.all([f.service.refresh(summary.id), secondService.refresh(summary.id)]);
    const final = await f.service.get(summary.id);
    const revisions = f.database.prepare('SELECT DISTINCT indexed_revision AS revision FROM personal_project_files WHERE project_id = ?').all(summary.id) as Array<{ revision: number }>;
    expect(final.sourceRevision).toBe(2);
    expect(revisions).toEqual([{ revision: 2 }]);
    expect(results.every((item) => item.sourceRevision === 2)).toBe(true);
  });

  it('bounds large search candidate sets before returning the requested page', async () => {
    const f = await fixture();
    const preview = await f.service.scan(f.projectRoot);
    const summary = await f.service.bind(preview.scanId, { sourceSha256: preview.sourceSha256 });
    const insert = f.database.prepare(`INSERT INTO personal_project_files
      (project_id, relative_path, kind, bytes, modified_at, sha256, parse_status, parse_problem, content_text, origin, indexed_revision)
      VALUES (?, ?, 'file', 6, ?, ?, 'readable', NULL, ?, 'source', ?)`);
    const timestamp = '2026-09-22T00:00:00.000Z';
    for (let index = 0; index < 5_005; index += 1) {
      insert.run(summary.id, `bulk/${String(index).padStart(5, '0')}.md`, timestamp, '0'.repeat(64), `needle-${index}`, summary.sourceRevision);
    }
    const page = await f.service.listFiles(summary.id, { search: 'needle', limit: 200 });
    expect(page.items).toHaveLength(200);
    expect(page.total).toBeLessThanOrEqual(5_000);
  });
});
