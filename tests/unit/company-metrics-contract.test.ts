import { describe, expect, it } from 'vitest';
import {
  companyDataCoverageSchema,
  companyMetricSnapshotSchema,
  companyMetricUploadMetadataSchema,
  companyPlatformSchema
} from '../../src/shared/company/metrics.js';

describe('company metrics contracts', () => {
  it('accepts only the three company platforms and non-negative canonical metrics', () => {
    expect(companyPlatformSchema.parse('douyin')).toBe('douyin');
    expect(companyPlatformSchema.parse('xiaohongshu')).toBe('xiaohongshu');
    expect(companyPlatformSchema.parse('wechat-channels')).toBe('wechat-channels');
    expect(() => companyPlatformSchema.parse('bilibili')).toThrow();

    expect(companyMetricSnapshotSchema.parse({
      id: 'snapshot-1', workspaceId: 'company', projectId: 'project-1', platform: 'douyin',
      contentId: 'item-1', contentTitle: '试听课', metricDate: '2026-09-19', metricKind: 'cumulative',
      observedAt: '2026-09-19T12:00:00.000Z', metrics: { views: 120, likes: 8 },
      sourceType: 'official-export', sourceRelativePath: 'platform-data/douyin/project-1/a.csv',
      rawRelativePath: 'platform-data/raw/douyin/project-1/a.csv', sourceSha256: 'a'.repeat(64),
      sourceRow: 2, headerRow: 1, sheetName: 'CSV', rawRowSha256: 'b'.repeat(64),
      createdAt: '2026-09-19T12:00:01.000Z'
    })).toMatchObject({ platform: 'douyin', metricKind: 'cumulative' });

    expect(() => companyMetricSnapshotSchema.parse({
      id: 'snapshot-1', workspaceId: 'company', projectId: 'project-1', platform: 'douyin',
      contentId: 'item-1', metricDate: '2026-09-19', metricKind: 'cumulative',
      observedAt: '2026-09-19T12:00:00.000Z', metrics: { views: -1 },
      sourceType: 'official-export', sourceRelativePath: 'x', rawRelativePath: 'x',
      sourceSha256: 'a'.repeat(64), sourceRow: 2, headerRow: 1, sheetName: 'CSV',
      rawRowSha256: 'b'.repeat(64), createdAt: '2026-09-19T12:00:01.000Z'
    })).toThrow();
  });

  it('exposes truthful coverage states instead of forcing a number', () => {
    expect(companyDataCoverageSchema.parse('not_configured')).toBe('not_configured');
    expect(companyDataCoverageSchema.parse('connected')).toBe('connected');
    expect(companyDataCoverageSchema.parse('stale')).toBe('stale');
    expect(companyDataCoverageSchema.parse('import_required')).toBe('import_required');
    expect(() => companyDataCoverageSchema.parse('0')).toThrow();
  });

  it('accepts safe browser-upload metadata and rejects path-like filenames', () => {
    expect(companyMetricUploadMetadataSchema.parse({
      platform: 'douyin',
      fileName: '官方导出.csv'
    })).toEqual({ platform: 'douyin', fileName: '官方导出.csv' });
    expect(companyMetricUploadMetadataSchema.parse({
      platform: 'wechat-channels',
      fileName: 'metrics.XLSX'
    })).toEqual({ platform: 'wechat-channels', fileName: 'metrics.XLSX' });
    expect(() => companyMetricUploadMetadataSchema.parse({
      platform: 'douyin',
      fileName: '../secret.csv'
    })).toThrow();
    expect(() => companyMetricUploadMetadataSchema.parse({
      platform: 'douyin',
      fileName: 'nested/secret.csv'
    })).toThrow();
    expect(() => companyMetricUploadMetadataSchema.parse({
      platform: 'douyin',
      fileName: 'metrics.json'
    })).toThrow();
  });
});
