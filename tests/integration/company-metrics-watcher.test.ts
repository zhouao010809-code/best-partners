import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createCompanyMetricsService } from '../../src/server/company/company-metrics-service.js';

const roots: string[] = [];
const databases: Database.Database[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  expect(check()).toBe(true);
}

describe('company metrics watcher', () => {
  it('imports stable official exports on startup, deduplicates, and preserves prior good data after a bad file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'company-metrics-watcher-'));
    roots.push(root);
    const database = new Database(':memory:');
    databases.push(database);
    database.pragma('foreign_keys = ON');
    applyMigrations(database);
    const now = '2026-09-19T12:00:00.000Z';
    database.prepare('INSERT INTO company_workspaces (id, display_name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('company', 'Company', root, now, now);
    database.prepare(`
      INSERT INTO company_projects (id, workspace_id, name, status, project_root, source_root, config_sha256, confidence_json, selected_skill_ids_json, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, '{}', '[]', ?, ?)
    `).run('project-1', 'company', '教育项目', join(root, 'projects/project-1'), join(root, 'incoming/project-1'), 'a'.repeat(64), now, now);

    const exports: Array<[string, string]> = [
      ['douyin', '作品ID,数据日期,播放量,点赞\ndy-1,2026-09-19,1200,8\n'],
      ['xiaohongshu', '笔记ID,数据日期,阅读量,收藏\nxhs-1,2026-09-19,300,4\n'],
      ['wechat-channels', '视频ID,数据日期,播放量,分享\nwx-1,2026-09-19,500,7\n']
    ];
    for (const [platform, content] of exports) {
      const directory = join(root, 'platform-data', platform, 'project-1');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'export.csv'), content, { mode: 0o600 });
    }

    const service = createCompanyMetricsService({
      database,
      workspace: { id: 'company', rootPath: root },
      stabilityDelayMs: 0,
      pollIntervalMs: 5_000,
      now: () => new Date(now)
    });
    const controller = service.start();
    try {
      await waitFor(() => Number((database.prepare('SELECT COUNT(*) AS count FROM company_platform_metric_imports WHERE state IN (\'imported\', \'partial\')').get() as { count: number }).count) === 3);
      const metrics = await service.listProjectMetrics('project-1');
      expect(metrics.coverage).toBe('connected');
      expect(metrics.totals).toMatchObject({ views: 2_000, likes: 8, saves: 4, shares: 7 });

      const raw = database.prepare('SELECT raw_relative_path FROM company_platform_metric_snapshots WHERE platform = ?').get('douyin') as { raw_relative_path: string };
      expect(await readFile(join(root, raw.raw_relative_path), 'utf8')).toContain('dy-1');

      await writeFile(join(root, 'platform-data/douyin/project-1/duplicate.csv'), exports[0]![1], { mode: 0o600 });
      const duplicate = await service.scanIncoming();
      expect(duplicate.duplicate).toBeGreaterThanOrEqual(1);
      expect(database.prepare('SELECT COUNT(*) AS count FROM company_platform_metric_snapshots').get()).toEqual({ count: 3 });

      await writeFile(join(root, 'platform-data/douyin/project-1/bad.csv'), '作品ID,数据日期,播放量\ndy-bad,不是日期,-1\n', { mode: 0o600 });
      const failed = await service.scanIncoming();
      expect(failed.failed).toBe(1);
      expect((await service.listProjectMetrics('project-1')).totals.views).toBe(2_000);

      await writeFile(join(root, 'outside.csv'), '作品ID,数据日期,播放量\noutside,2026-09-19,99\n', { mode: 0o600 });
      await symlink(join(root, 'outside.csv'), join(root, 'platform-data/douyin/project-1/escape.csv'));
      const rejected = await expect(service.importFile({ relativePath: 'platform-data/douyin/project-1/escape.csv' })).rejects.toMatchObject({ code: 'COMPANY_METRICS_PATH_INVALID' });
      void rejected;
    } finally {
      await controller.stop();
    }
  });
});
