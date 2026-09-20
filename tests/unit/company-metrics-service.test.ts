import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations } from '../../src/server/db/migrate.js';
import {
  createCompanyMetricsService,
  resolveCompanyMetricsPollInterval
} from '../../src/server/company/company-metrics-service.js';

const roots: string[] = [];
const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; database: Database.Database } {
  const root = mkdtempSync(join(tmpdir(), 'company-metrics-'));
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
  `).run('project-1', 'company', '教育项目', join(root, 'projects', 'project-1'), join(root, 'incoming', 'project-1'), 'a'.repeat(64), now, now);
  return { root, database };
}

function writeExport(root: string, name = 'data.csv', content = '作品ID,作品标题,数据日期,播放量,点赞\nitem-1,试听课,2026-09-19,1200,8\n'): string {
  const directory = join(root, 'platform-data', 'douyin', 'project-1');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name);
  writeFileSync(path, content, { mode: 0o600 });
  return 'platform-data/douyin/project-1/' + name;
}

describe('company metrics service', () => {
  it('imports a project-scoped export and keeps immutable raw evidence', async () => {
    const { root, database } = fixture();
    const sourcePath = writeExport(root);
    const service = createCompanyMetricsService({
      database,
      workspace: { id: 'company', rootPath: root },
      stabilityDelayMs: 0,
      now: () => new Date('2026-09-19T12:00:01.000Z')
    });

    const result = await service.importFile({ relativePath: sourcePath });
    expect(result.state).toBe('imported');
    expect(result.importedCount).toBe(1);
    expect(result.rawRelativePath).toMatch(/^platform-data\/raw\/douyin\/project-1\//u);
    expect(readFileSync(join(root, result.rawRelativePath!), 'utf8')).toContain('播放量');
    expect(database.prepare('SELECT COUNT(*) AS count FROM company_platform_metric_snapshots').get()).toEqual({ count: 1 });
  });

  it('is idempotent by source hash and does not duplicate snapshots', async () => {
    const { root, database } = fixture();
    const sourcePath = writeExport(root);
    const service = createCompanyMetricsService({ database, workspace: { id: 'company', rootPath: root }, stabilityDelayMs: 0 });
    const first = await service.importFile({ relativePath: sourcePath });
    const second = await service.importFile({ relativePath: sourcePath });
    expect(first.state).toBe('imported');
    expect(second.state).toBe('duplicate');
    expect(database.prepare('SELECT COUNT(*) AS count FROM company_platform_metric_snapshots').get()).toEqual({ count: 1 });
  });

  it('records parser failures and rejects paths outside the platform drop root', async () => {
    const { root, database } = fixture();
    writeExport(root, 'bad.csv', '日期,神秘指标\n2026-09-19,3\n');
    const service = createCompanyMetricsService({ database, workspace: { id: 'company', rootPath: root }, stabilityDelayMs: 0 });
    await expect(service.importFile({ relativePath: '../../secret.csv' })).rejects.toMatchObject({ code: 'COMPANY_METRICS_PATH_INVALID' });
    const failure = await service.importFile({ relativePath: 'platform-data/douyin/project-1/bad.csv' });
    expect(failure.state).toBe('failed');
    expect(failure.errorCode).toBe('COMPANY_METRICS_COLUMNS_UNSUPPORTED');
  });

  it('aggregates the latest cumulative snapshot per content without inventing missing values', async () => {
    const { root, database } = fixture();
    writeExport(root, 'first.csv', '作品ID,数据日期,播放量,点赞\nitem-1,2026-09-18,100,2\n');
    const service = createCompanyMetricsService({ database, workspace: { id: 'company', rootPath: root }, stabilityDelayMs: 0, now: () => new Date('2026-09-19T12:00:00.000Z') });
    await service.importFile({ relativePath: 'platform-data/douyin/project-1/first.csv' });
    const metrics = await service.listProjectMetrics('project-1');
    expect(metrics.coverage).toBe('connected');
    expect(metrics.totals).toMatchObject({ views: 100, likes: 2 });
    expect(metrics.totals.comments).toBeUndefined();
  });

  it('uses the newest metric date even when an older export is imported later', async () => {
    const { root, database } = fixture();
    writeExport(root, 'newer.csv', '作品ID,数据日期,播放量\nitem-1,2026-09-19,900\n');
    writeExport(root, 'older.csv', '作品ID,数据日期,播放量\nitem-1,2026-09-18,100\n');
    const service = createCompanyMetricsService({
      database,
      workspace: { id: 'company', rootPath: root },
      stabilityDelayMs: 0,
      now: () => new Date('2026-09-19T12:00:00.000Z')
    });
    await service.importFile({ relativePath: 'platform-data/douyin/project-1/newer.csv' });
    await service.importFile({ relativePath: 'platform-data/douyin/project-1/older.csv' });
    const metrics = await service.listProjectMetrics('project-1');
    expect(metrics.totals).toMatchObject({ views: 900 });
    expect(metrics.latestMetricDate).toBe('2026-09-19');
  });

  it('marks the same bytes attached to another project as a source conflict', async () => {
    const { root, database } = fixture();
    const now = '2026-09-19T12:00:00.000Z';
    database.prepare(`
      INSERT INTO company_projects (id, workspace_id, name, status, project_root, source_root, config_sha256, confidence_json, selected_skill_ids_json, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, '{}', '[]', ?, ?)
    `).run('project-2', 'company', '餐饮项目', join(root, 'projects', 'project-2'), join(root, 'incoming', 'project-2'), 'b'.repeat(64), now, now);
    const firstPath = writeExport(root, 'shared.csv');
    const secondDirectory = join(root, 'platform-data', 'douyin', 'project-2');
    mkdirSync(secondDirectory, { recursive: true, mode: 0o700 });
    copyFileSync(join(root, firstPath), join(secondDirectory, 'shared.csv'));
    const service = createCompanyMetricsService({ database, workspace: { id: 'company', rootPath: root }, stabilityDelayMs: 0 });

    expect((await service.importFile({ relativePath: firstPath })).state).toBe('imported');
    const conflict = await service.importFile({ relativePath: 'platform-data/douyin/project-2/shared.csv' });
    expect(conflict.state).toBe('conflict');
    expect(conflict.errorCode).toBe('COMPANY_METRICS_SOURCE_CONFLICT');
    expect(database.prepare('SELECT COUNT(*) AS count FROM company_platform_metric_snapshots').get()).toEqual({ count: 1 });
  });

  it('marks a logical value change as attention without overwriting history', async () => {
    const { root, database } = fixture();
    writeExport(root, 'first.csv', '作品ID,数据日期,播放量\nitem-1,2026-09-19,100\n');
    writeExport(root, 'second.csv', '作品ID,数据日期,播放量\nitem-1,2026-09-19,200\n');
    const service = createCompanyMetricsService({ database, workspace: { id: 'company', rootPath: root }, stabilityDelayMs: 0 });
    await service.importFile({ relativePath: 'platform-data/douyin/project-1/first.csv' });
    const conflict = await service.importFile({ relativePath: 'platform-data/douyin/project-1/second.csv' });
    expect(conflict.state).toBe('conflict');
    expect(conflict.errorCode).toBe('COMPANY_METRICS_LOGICAL_CONFLICT');
    expect((await service.listProjectMetrics('project-1')).totals.views).toBe(100);
    expect((await service.listProjectMetrics('project-1')).coverage).toBe('attention');
  });

  it('keeps invalid poll intervals on the safe default path', () => {
    expect(resolveCompanyMetricsPollInterval(undefined)).toBeUndefined();
    expect(resolveCompanyMetricsPollInterval('5000')).toBe(5000);
    expect(resolveCompanyMetricsPollInterval('86400000')).toBe(86400000);
    expect(resolveCompanyMetricsPollInterval('4999')).toBeUndefined();
    expect(resolveCompanyMetricsPollInterval('not-a-number')).toBeUndefined();
  });
});
