import Database from 'better-sqlite3';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createProjectService } from '../../src/server/projects/project-service.js';

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
    expect(preview.displayName).toBe('client-project');
    expect(preview.fileCount).toBe(3);
    expect(preview.guidanceFiles).toEqual(['README.md', 'brief.txt']);
    expect(preview).not.toHaveProperty('root_path');
    expect(preview).not.toHaveProperty('proposal_json');
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
    expect((await f.service.ensureFresh(summary.id)).availability).toBe('reconnect-required');
    const count = f.database.prepare('SELECT COUNT(*) AS count FROM personal_project_operations WHERE project_id = ?').get(summary.id) as { count: number };
    expect(count.count).toBe(1);
  });

  it('rejects protected roots and expired or mismatched scan confirmations', async () => {
    const f = await fixture();
    await expect(f.service.scan(f.vaultRoot)).rejects.toMatchObject({ code: 'PROJECT_ROOT_PROTECTED' });
    const preview = await f.service.scan(f.projectRoot);
    await expect(f.service.bind(preview.scanId, { sourceSha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'PROJECT_SCAN_HASH_MISMATCH' });
    await expect(f.service.bind(preview.scanId, { sourceSha256: preview.sourceSha256 })).resolves.toMatchObject({ sourceRevision: 1 });
    const expiring = await f.service.scan(f.projectRoot);
    f.advance(15 * 60 * 1000 + 1);
    await expect(f.service.bind(expiring.scanId, { sourceSha256: expiring.sourceSha256 })).rejects.toMatchObject({ code: 'PROJECT_SCAN_EXPIRED' });
  });

  it('keeps unreadable files searchable by metadata while indexing readable siblings', async () => {
    const f = await fixture();
    await writeFile(join(f.projectRoot, 'binary.md'), Buffer.from([0xff, 0xfe, 0xfd]));
    const preview = await f.service.scan(f.projectRoot);
    const summary = await f.service.bind(preview.scanId, { sourceSha256: preview.sourceSha256 });
    const binary = (await f.service.listFiles(summary.id, { search: 'binary.md' })).items[0];
    expect(binary).toMatchObject({ parseStatus: 'failed' });
    expect((await f.service.listFiles(summary.id, { search: '获客' })).total).toBe(1);
  });
});
