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

  it('preserves the workbook calendar date regardless of the host timezone', async () => {
    const bytes = workbookBytes([
      ['视频ID', '数据日期', '播放量'],
      // Excel serials represent a local calendar date, not a UTC instant.
      // Generate the same calendar cell on both developer machines and CI.
      ['item-1', new Date(2026, 8, 19), 7]
    ]);
    const result = await parsePlatformExport({ platform: 'wechat-channels', fileName: '视频.xls', bytes });
    expect(result.rows[0]?.metricDate).toBe('2026-09-19');
  });

  it('quarantines unsafe numeric content IDs while preserving long text IDs', async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ['作品ID', '数据日期', '播放量'],
      ['numeric-one', '2026-09-19', 8],
      ['numeric-two', '2026-09-19', 9],
      ['7394857349183749234', '2026-09-19', 10]
    ]);
    // Keep distinct integer values in the source XML. Reading them as JS
    // numbers loses precision and must not merge two unrelated contents.
    sheet.A2 = { t: 'n', v: '7394857349183749234' };
    sheet.A3 = { t: 'n', v: '7394857349183749235' };
    XLSX.utils.book_append_sheet(workbook, sheet, '数据');
    const bytes = Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
    const result = await parsePlatformExport({ platform: 'douyin', fileName: 'numeric-ids.xlsx', bytes });
    expect(result).toMatchObject({ status: 'partial', acceptedCount: 1, rejectedCount: 2 });
    expect(result.rows.map(row => row.contentId)).toEqual(['7394857349183749234']);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'COMPANY_METRICS_VALUE_INVALID', sourceRow: 2, column: '作品ID' }),
      expect.objectContaining({ code: 'COMPANY_METRICS_VALUE_INVALID', sourceRow: 3, column: '作品ID' })
    ]);
  });

  it('keeps physical worksheet row numbers when the used range starts below the first row', async () => {
    const workbook = XLSX.utils.book_new();
    const sheet: XLSX.WorkSheet = {
      C5: { t: 's', v: '作品ID' }, D5: { t: 's', v: '数据日期' }, E5: { t: 's', v: '播放量' },
      C6: { t: 's', v: 'item-1' }, D6: { t: 's', v: '2026-09-19' }, E6: { t: 'n', v: 8 },
      C7: { t: 's', v: 'item-2' }, D7: { t: 's', v: 'invalid-date' }, E7: { t: 'n', v: 9 },
      '!ref': 'C5:E7'
    };
    XLSX.utils.book_append_sheet(workbook, sheet, '数据');
    const bytes = Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
    const result = await parsePlatformExport({ platform: 'douyin', fileName: 'offset.xlsx', bytes });
    expect(result.header.headerRow).toBe(5);
    expect(result.rows[0]).toMatchObject({ headerRow: 5, sourceRow: 6, contentId: 'item-1' });
    expect(result.issues).toEqual([expect.objectContaining({ code: 'COMPANY_METRICS_DATE_INVALID', sourceRow: 7, row: 7 })]);
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

  it('preserves Chinese headers and content in legacy XLS workbooks', async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['作品ID', '作品标题', '数据日期', '播放量'],
      ['item-1', '中文课程', '2026-09-19', 8]
    ]), '数据');
    const bytes = Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' }));
    const result = await parsePlatformExport({ platform: 'douyin', fileName: '旧版.xls', bytes });
    expect(result.rows[0]).toMatchObject({ contentId: 'item-1', contentTitle: '中文课程', metricDate: '2026-09-19', metrics: { views: 8 } });
  });

  it('respects the 1904 calendar and rejects the fictitious 1900 leap day', async () => {
    const workbook = XLSX.utils.book_new();
    workbook.Workbook = { WBProps: { date1904: true } };
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['作品ID', '数据日期', '播放量'], ['item-1', 0, 8], ['item-2', 60, 9]
    ]), '数据');
    const bytes = Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
    const result = await parsePlatformExport({ platform: 'douyin', fileName: '1904.xlsx', bytes });
    expect(result.rows.map((row) => row.metricDate)).toEqual(['1904-01-01', '1904-03-01']);

    await expect(parsePlatformExport({ platform: 'douyin', fileName: '1900.xlsx', bytes: workbookBytes([
      ['作品ID', '数据日期', '播放量'], ['item-1', 60, 8]
    ]) })).rejects.toSatisfy((error: unknown) => errorCode(error) === 'COMPANY_METRICS_DATE_INVALID');
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

  it('enforces workbook sheet and declared cell limits before materializing rows', async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['作品ID', '数据日期', '播放量'],
      ['item-1', '2026-09-19', 2]
    ]), '数据');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['备用']]), '备用');
    const multiSheetBytes = Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));

    await expect(parsePlatformExport({
      platform: 'douyin', fileName: 'multi-sheet.xlsx', bytes: multiSheetBytes, maxSheets: 1
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === 'COMPANY_METRICS_TOO_LARGE');

    const sparseWorkbook = XLSX.utils.book_new();
    const sparseSheet = XLSX.utils.aoa_to_sheet([['作品ID', '数据日期', '播放量'], ['item-1', '2026-09-19', 2]]);
    sparseSheet['!ref'] = 'A1:Z1000';
    XLSX.utils.book_append_sheet(sparseWorkbook, sparseSheet, '数据');
    const sparseBytes = Buffer.from(XLSX.write(sparseWorkbook, { type: 'buffer', bookType: 'xlsx' }));

    await expect(parsePlatformExport({
      platform: 'douyin', fileName: 'sparse.xlsx', bytes: sparseBytes, maxCells: 10
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === 'COMPANY_METRICS_TOO_LARGE');
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
