import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createProjectCreationService } from '../../src/server/projects/project-creations.js';

it('upgrades old draft/version references without changing immutable version or export bytes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'creative-migration-')));
  const database = new Database(':memory:');
  try {
    const migrationRoot = new URL('../../src/server/db/migrations/', import.meta.url);
    const files = (await readdir(migrationRoot)).filter(file => /^\d+_.*\.sql$/u.test(file) && Number(file.slice(0, 3)) <= 22).sort();
    const previous = await Promise.all(files.map(async file => ({ version: Number(file.slice(0, 3)), sql: await readFile(new URL(file, migrationRoot), 'utf8'), requiresForeignKeysOff: file.startsWith('018_') })));
    applyMigrations(database, previous);
    const projectId = randomUUID(); const creationId = randomUUID(); const versionId = randomUUID(); const timestamp = '2026-09-20T00:00:00.000Z';
    database.prepare(`INSERT INTO personal_projects (id,root_path,display_name,source_sha256,availability,created_at,updated_at) VALUES (?,?,?,?,'ready',?,?)`)
      .run(projectId, root, '旧项目', 'a'.repeat(64), timestamp, timestamp);
    database.prepare(`INSERT INTO personal_project_creations (id,project_id,kind,title,brief,body,audience,angle,rationale,sources_json,revision,created_at,updated_at) VALUES (?,?,'script','旧稿件','','旧正文','','','','[]',1,?,?)`)
      .run(creationId, projectId, timestamp, timestamp);
    const content = '# 旧版本\n\n必须保留的导出字节，不追加参考范围。\n';
    const digest = createHash('sha256').update(content).digest('hex');
    database.prepare(`INSERT INTO personal_project_creation_versions (id,creation_id,number,title,brief,body,sources_json,export_content,content_sha256,created_at) VALUES (?,?,1,'旧稿件','','旧正文','[]',?,?,?)`)
      .run(versionId, creationId, content, digest, timestamp);
    const before = database.prepare('SELECT * FROM personal_project_creation_versions WHERE id=?').get(versionId);
    applyMigrations(database); applyMigrations(database);
    const after = database.prepare('SELECT * FROM personal_project_creation_versions WHERE id=?').get(versionId) as Record<string, unknown>;
    const { reference_selection_json: selectionJson, ...unchanged } = after;
    expect(unchanged).toEqual(before); expect(JSON.parse(String(selectionJson))).toEqual({ mode: 'auto', paths: [] });
    expect(() => database.prepare('UPDATE personal_project_creation_versions SET body=? WHERE id=?').run('不可覆盖', versionId)).toThrow(/immutable/u);
    const service = createProjectCreationService({ database });
    const detail = await service.get(projectId, creationId);
    expect(detail.item.referenceSelection).toEqual({ mode: 'auto', paths: [] });
    expect(detail.versions[0]!.referenceSelection).toEqual({ mode: 'auto', paths: [] });
    const exported = await service.exportVersion(projectId, creationId, versionId);
    expect(await readFile(join(root, exported.path), 'utf8')).toBe(content);
    expect(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=23').get()).toEqual({ count: 1 });
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
