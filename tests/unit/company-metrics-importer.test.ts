import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  MetricsImportError,
  parsePlatformExport,
  type PlatformExportParseResult
} from '../../src/server/company/metrics-importer.js';

function workbookBytes(rows: readonly (readonly unknown[])[], sheetName = '数据'): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', cellDates: true }));
}

function errorCode(error: unknown): string | undefined {
  return error instanceof MetricsImportError ? error.code : undefined;
}

describe('company platform export importer', () => {
  it('parses quoted UTF-8 CSV with Chinese aliases and normalizes metrics', async () => {
    const result = await parsePlatformExport({
      platform: 'douyin',
      fileName: '作品数据.csv',
      bytes: Buffer.from('\uFEFF导出说明\n作品ID,作品标题,数据日期,播放量,点赞,评论,分享\nitem-1,"试听,公开课",2026-09-19,"1,200",8,3,1\n')
    });

    expect(result.status).toBe('imported');
    expect(result.header.headerRow).toBe(2);
    expect(result.rows).toEqual([expect.objectContaining({
      contentId: 'item-1',
      contentTitle: '试听,公开课',
      metricDate: '2026-09-19',
      metricKind: 'cumulative',
      metrics: { views: 1200, likes: 8, comments: 3, shares: 1 },
      sourceRow: 3,
      headerRow: 2,
      sheetName: 'CSV'
    })]);
    expect(result.rows[0]?.rawRowSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('parses the first worksheet of an XLSX export using the same contract', async () => {
    const bytes = workbookBytes([
      ['导出时间', '2026/09/19'],
      ['笔记ID', '笔记标题', '数据日期', '阅读量', '收藏'],
      ['note-1', '课程笔记', '2026/09/19', 321, 12]
    ]);

    const result = await parsePlatformExport({
      platform: 'xiaohongshu',
      fileName: '笔记.xlsx',
      bytes
    });

    expect(result.format).toBe('xlsx');
    expect(result.header).toMatchObject({ headerRow: 2, sheetName: '数据' });
    expect(result.rows[0]).toMatchObject({
      contentId: 'note-1',
      metricDate: '2026-09-19',
      metrics: { views: 321, saves: 12 }
    });
  });

  it('normalizes an Excel Date using the Asia/Shanghai business date', async () => {
    const bytes = workbookBytes([
      ['视频ID', '数据日期', '播放量'],
      ['item-1', new Date('2026-09-18T16:00:00.000Z'), 7]
    ]);
    const result = await parsePlatformExport({ platform: 'wechat-channels', fileName: '视频.xls', bytes });
    expect(result.rows[0]?.metricDate).toBe('2026-09-19');
  });

  it('returns partial for unknown extra columns while retaining usable rows', async () => {
    const result = await parsePlatformExport({
      platform: 'douyin',
      fileName: 'partial.csv',
      bytes: Buffer.from('作品ID,数据日期,播放量,平台内部实验字段\nitem-1,2026/09/19,4,variant-a\n')
    });
    expect(result.status).toBe('partial');
    expect(result.acceptedCount).toBe(1);
    expect(result.rejectedCount).toBe(0);
    expect(result.issues).toEqual([expect.objectContaining({
      code: 'COMPANY_METRICS_UNKNOWN_COLUMN',
      row: 1,
      column: '平台内部实验字段'
    })]);
  });

  it('rejects unsupported columns, negative values, and malformed dates with typed errors', async () => {
    await expect(parsePlatformExport({
      platform: 'wechat-channels',
      fileName: 'unknown.csv',
      bytes: Buffer.from('日期,神秘指标\n2026-09-19,3\n')
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === 'COMPANY_METRICS_COLUMNS_UNSUPPORTED');

    await expect(parsePlatformExport({
      platform: 'douyin',
      fileName: 'negative.csv',
      bytes: Buffer.from('数据日期,播放量\n2026-09-19,-1\n')
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === 'COMPANY_METRICS_VALUE_INVALID');

    await expect(parsePlatformExport({
      platform: 'douyin',
      fileName: 'bad-date.csv',
      bytes: Buffer.from('作品ID,数据日期,播放量\nitem-1,2026-02-31,1\n')
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === 'COMPANY_METRICS_DATE_INVALID');
  });

  it('quarantines rows without content IDs instead of exposing them as metrics', async () => {
    const result = await parsePlatformExport({
      platform: 'douyin',
      fileName: 'missing-id.csv',
      bytes: Buffer.from('作品ID,数据日期,播放量\n,2026-09-19,1\nitem-2,2026-09-19,2\n')
    });
    expect(result.status).toBe('partial');
    expect(result.rows.map((row) => row.contentId)).toEqual(['item-2']);
    expect(result.issues).toEqual([expect.objectContaining({
      code: 'COMPANY_METRICS_CONTENT_ID_MISSING',
      row: 2
    })]);
  });

  it('is deterministic and enforces input and table limits', async () => {
    const input = {
      platform: 'douyin' as const,
      fileName: 'data.csv',
      bytes: Buffer.from('作品ID,数据日期,播放量\nitem-1,2026-09-19,2\n')
    };
    const first = await parsePlatformExport(input);
    const second = await parsePlatformExport(input);
    expect(second).toEqual(first);

    await expect(parsePlatformExport({ ...input, maxBytes: 2 })).rejects.toSatisfy((error: unknown) => errorCode(error) === 'COMPANY_METRICS_TOO_LARGE');
    await expect(parsePlatformExport({ ...input, maxRows: 1 })).rejects.toSatisfy((error: unknown) => errorCode(error) === 'COMPANY_METRICS_TOO_LARGE');
  });

  it('rejects ambiguous duplicate recognized headers', async () => {
    await expect(parsePlatformExport({
      platform: 'douyin',
      fileName: 'ambiguous.csv',
      bytes: Buffer.from('作品ID,数据日期,播放量,播放量\nitem-1,2026-09-19,1,2\n')
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === 'COMPANY_METRICS_AMBIGUOUS_HEADER');
  });
});

// Keep this type import exercised in editor builds when a test is narrowed to
// a single assertion while still documenting the public result shape.
const _resultTypeCheck: PlatformExportParseResult | undefined = undefined;
void _resultTypeCheck;

