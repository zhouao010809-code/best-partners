import { createHash } from 'node:crypto';
import XLSX from 'xlsx';
import type {
  CompanyMetricName,
  CompanyMetricValues,
  CompanyPlatform
} from '../../shared/company/metrics.js';

/**
 * The importer deliberately accepts bytes, rather than a path.  Reading and
 * validating a path belongs to the company metrics service; keeping this
 * module byte-only makes it impossible for a parser call to follow a
 * symlink, read outside the workspace, or accidentally mutate an input file.
 */

export const COMPANY_METRICS_MAX_BYTES = 20 * 1024 * 1024;
export const COMPANY_METRICS_MAX_ROWS = 100_000;
export const COMPANY_METRICS_MAX_CELLS = 1_000_000;
export const COMPANY_METRICS_MAX_SHEETS = 20;

export type CompanyMetricCanonicalField =
  | 'contentId'
  | 'contentTitle'
  | 'accountRef'
  | 'metricDate'
  | CompanyMetricName;

export type PlatformExportFormat = 'csv' | 'xlsx' | 'xls';

export type MetricsImportErrorCode =
  | 'COMPANY_METRICS_FILE_UNSUPPORTED'
  | 'COMPANY_METRICS_COLUMNS_UNSUPPORTED'
  | 'COMPANY_METRICS_DATE_INVALID'
  | 'COMPANY_METRICS_VALUE_INVALID'
  | 'COMPANY_METRICS_ENCODING_UNSUPPORTED'
  | 'COMPANY_METRICS_TOO_LARGE'
  | 'COMPANY_METRICS_AMBIGUOUS_HEADER'
  | 'COMPANY_METRICS_CSV_INVALID'
  | 'COMPANY_METRICS_HEADER_NOT_FOUND'
  | 'COMPANY_METRICS_CONTENT_ID_MISSING'
  | 'COMPANY_METRICS_METRIC_MISSING'
  | 'COMPANY_METRICS_NO_DATA_ROWS'
  | 'COMPANY_METRICS_FILE_CHANGED';

export interface MetricsImportErrorDetails {
  readonly sourceRow?: number;
  readonly column?: string;
  readonly headerRow?: number;
  readonly issues?: readonly PlatformExportIssue[];
  readonly [key: string]: unknown;
}

export class MetricsImportError extends Error {
  readonly code: MetricsImportErrorCode;
  readonly details: MetricsImportErrorDetails;

  constructor(code: MetricsImportErrorCode, message: string, details: MetricsImportErrorDetails = {}) {
    super(message);
    this.name = 'MetricsImportError';
    this.code = code;
    this.details = details;
  }
}

export interface PlatformExportParseInput {
  readonly platform: CompanyPlatform;
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly maxBytes?: number;
  readonly maxRows?: number;
  readonly maxCells?: number;
  readonly maxSheets?: number;
}

export interface PlatformExportRow {
  readonly platform: CompanyPlatform;
  readonly contentId: string;
  readonly contentTitle?: string;
  readonly accountRef?: string;
  readonly metricDate: string;
  readonly metricKind: 'cumulative';
  /** Parsing is deterministic; the service may supply its ingestion clock. */
  readonly observedAt?: string;
  readonly metrics: CompanyMetricValues;
  /** One-based source row, including the header and any preamble rows. */
  readonly sourceRow: number;
  /** One-based row containing the recognized header. */
  readonly headerRow: number;
  readonly sheetName: string;
  /** Stringified raw cells, useful for audit/debugging without retaining a workbook object. */
  readonly rawRow: readonly string[];
  readonly rawRowSha256: string;
}

export type PlatformExportIssueCode =
  | MetricsImportErrorCode
  | 'COMPANY_METRICS_UNKNOWN_COLUMN'
  | 'COMPANY_METRICS_ROW_INVALID';

export interface PlatformExportIssue {
  readonly code: PlatformExportIssueCode;
  /** Service/API compatibility name for the one-based source row. */
  readonly row: number;
  readonly sourceRow: number;
  readonly column?: string;
  readonly message: string;
}

export interface PlatformExportHeader {
  readonly headerRow: number;
  readonly sheetName: string;
  readonly columns: Partial<Record<CompanyMetricCanonicalField, number>>;
  readonly labels: Partial<Record<CompanyMetricCanonicalField, string>>;
  readonly unknownColumns: readonly string[];
}

export interface PlatformExportParseResult {
  readonly platform: CompanyPlatform;
  readonly fileName: string;
  readonly format: PlatformExportFormat;
  readonly status: 'imported' | 'partial';
  readonly rows: readonly PlatformExportRow[];
  /** Alias kept for callers that use the domain term rather than `rows`. */
  readonly normalizedRows: readonly PlatformExportRow[];
  readonly header: PlatformExportHeader;
  readonly issues: readonly PlatformExportIssue[];
  readonly rowCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
}

type RawCell = unknown;
type RawTable = readonly (readonly RawCell[])[];

const FIELD_ORDER: readonly CompanyMetricCanonicalField[] = [
  'contentId', 'contentTitle', 'accountRef', 'metricDate',
  'views', 'likes', 'comments', 'shares', 'saves', 'followers', 'leads'
];

/**
 * Explicit aliases only.  In particular, a generic `id` or `数值` is not
 * accepted: guessing a column is worse than placing a file in the review
 * queue because a wrong metric can look plausible on a dashboard.
 */
const COMMON_ALIASES: Record<CompanyMetricCanonicalField, readonly string[]> = {
  contentId: [
    '内容ID', '内容编号', '作品ID', '作品编号', '视频ID', '视频编号',
    '笔记ID', '笔记编号', 'item_id', 'itemid', 'content_id', 'contentid',
    'video_id', 'videoid', 'note_id', 'noteid', 'aweme_id', 'awemeid', 'post_id', 'postid'
  ],
  contentTitle: [
    '内容标题', '内容名称', '作品标题', '作品名称', '视频标题', '视频名称',
    '笔记标题', '笔记名称', '标题', '名称', 'content_title', 'contenttitle',
    'item_title', 'itemtitle', 'video_title', 'videotitle', 'note_title', 'notetitle', 'title', 'name'
  ],
  accountRef: [
    '账号ID', '账号编号', '账号名称', '账号', '账户ID', '账户名称', '账户',
    'account_id', 'accountid', 'account_name', 'accountname', 'account',
    'user_id', 'userid', 'username', 'user_name', 'profile_id', 'profileid'
  ],
  metricDate: [
    '数据日期', '统计日期', '日期', '数据时间', '统计时间', 'metric_date',
    'metricdate', 'record_date', 'recorddate', 'date', 'day'
  ],
  views: [
    '播放量', '播放次数', '播放数', '播放', '观看量', '观看次数', '观看数',
    '阅读量', '阅读次数', '阅读数', '浏览量', '浏览次数', '曝光量',
    'views', 'view_count', 'viewcount', 'play_count', 'playcount', 'plays',
    'read_count', 'readcount', 'reads', 'impressions'
  ],
  likes: ['点赞', '点赞数', '点赞量', '喜欢', 'likes', 'like_count', 'likecount', 'digg_count', 'diggcount'],
  comments: ['评论', '评论数', '评论量', '留言', 'comments', 'comment_count', 'commentcount'],
  shares: ['分享', '分享数', '分享量', '转发', '转发数', 'shares', 'share_count', 'sharecount', 'reposts'],
  saves: ['收藏', '收藏数', '收藏量', '保存', 'saves', 'save_count', 'savecount', 'collect_count', 'collectcount'],
  followers: ['粉丝', '粉丝数', '粉丝量', '新增粉丝', '关注者', 'followers', 'follower_count', 'followercount', 'fans', 'fans_count', 'fanscount'],
  leads: ['咨询', '咨询量', '咨询数', '留资', '留资量', '线索', '线索量', 'leads', 'lead_count', 'leadcount', 'inquiries', 'inquiry_count', 'inquirycount']
};

const PLATFORM_ALIASES: Record<CompanyPlatform, Partial<Record<CompanyMetricCanonicalField, readonly string[]>>> = {
  douyin: {
    contentId: ['抖音号作品ID', '抖音作品ID', '短视频ID'],
    contentTitle: ['作品标题文本', '视频标题文本'],
    views: ['视频播放量', '有效播放量'],
    likes: ['获赞数', '获赞量']
  },
  xiaohongshu: {
    contentId: ['小红书笔记ID', '笔记编号'],
    contentTitle: ['笔记标题文本'],
    views: ['阅读', '阅读人数', '笔记阅读量'],
    likes: ['点赞人数', '获赞数'],
    saves: ['收藏人数']
  },
  'wechat-channels': {
    contentId: ['视频号作品ID', '视频号视频ID', '视频号ID'],
    contentTitle: ['视频号标题'],
    views: ['播放人数', '视频播放次数'],
    likes: ['点赞人数'],
    shares: ['转发人数']
  }
};

const DATE_ONLY = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/u;
const CHINESE_DATE = /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:.*)?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function normalizeHeader(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/^\uFEFF/u, '')
    .replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]|【[^】]*】/gu, '')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function asDisplayString(value: RawCell): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value).trim();
}

function stableRawCell(value: RawCell): string {
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function issue(code: PlatformExportIssueCode, message: string, sourceRow = 1, column?: string): PlatformExportIssue {
  return {
    code,
    row: sourceRow,
    sourceRow,
    ...(column === undefined ? {} : { column }),
    message
  };
}

function errorFromIssue(item: PlatformExportIssue, details: MetricsImportErrorDetails = {}): MetricsImportError {
  const code = item.code as MetricsImportErrorCode;
  return new MetricsImportError(code, item.message, {
    ...details,
    sourceRow: item.sourceRow,
    ...(item.column === undefined ? {} : { column: item.column })
  });
}

function formatDateParts(year: number, month: number, day: number): string | undefined {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return undefined;
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function businessDateFromDate(value: Date): string | undefined {
  if (Number.isNaN(value.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(value);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);
  return formatDateParts(year, month, day);
}

function normalizeDate(value: RawCell, allowExcelSerial: boolean, date1904: boolean): string | undefined {
  if (value instanceof Date) return businessDateFromDate(value);
  if (typeof value === 'number') {
    if (!allowExcelSerial || !Number.isFinite(value) || value < 1 || value > 3_000_000) return undefined;
    const parsed = XLSX.SSF.parse_date_code(value, { date1904 });
    if (!parsed) return undefined;
    return formatDateParts(parsed.y, parsed.m, parsed.d);
  }
  const text = asDisplayString(value);
  if (!text) return undefined;
  const match = text.match(DATE_ONLY) ?? text.match(CHINESE_DATE);
  if (!match) return undefined;
  return formatDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
}

function buildAliasMap(platform: CompanyPlatform): Map<string, CompanyMetricCanonicalField[]> {
  const result = new Map<string, CompanyMetricCanonicalField[]>();
  for (const field of FIELD_ORDER) {
    const aliases = [...COMMON_ALIASES[field], ...(PLATFORM_ALIASES[platform][field] ?? [])];
    for (const alias of aliases) {
      const normalized = normalizeHeader(alias);
      if (!normalized) continue;
      const current = result.get(normalized) ?? [];
      if (!current.includes(field)) current.push(field);
      result.set(normalized, current);
    }
  }
  return result;
}

interface HeaderMappingInternal {
  readonly columns: Partial<Record<CompanyMetricCanonicalField, number>>;
  readonly labels: Partial<Record<CompanyMetricCanonicalField, string>>;
  readonly unknownColumns: string[];
  readonly metricCount: number;
}

function mapHeader(row: readonly RawCell[], aliases: Map<string, CompanyMetricCanonicalField[]>): HeaderMappingInternal {
  const columns: Partial<Record<CompanyMetricCanonicalField, number>> = {};
  const labels: Partial<Record<CompanyMetricCanonicalField, string>> = {};
  const unknownColumns: string[] = [];
  for (let index = 0; index < row.length; index += 1) {
    const label = asDisplayString(row[index]);
    if (!label) continue;
    const candidates = aliases.get(normalizeHeader(label));
    if (!candidates || candidates.length === 0) {
      unknownColumns.push(label);
      continue;
    }
    if (candidates.length > 1) {
      throw new MetricsImportError(
        'COMPANY_METRICS_AMBIGUOUS_HEADER',
        `表头“${label}”同时匹配多个字段：${candidates.join(', ')}`,
        { column: label }
      );
    }
    const field = candidates[0]!;
    if (columns[field] !== undefined) {
      throw new MetricsImportError(
        'COMPANY_METRICS_AMBIGUOUS_HEADER',
        `表头包含重复字段“${field}”`,
        { column: label }
      );
    }
    columns[field] = index;
    labels[field] = label;
  }
  const metricCount = FIELD_ORDER.filter((field) => ['views', 'likes', 'comments', 'shares', 'saves', 'followers', 'leads'].includes(field) && columns[field] !== undefined).length;
  return { columns, labels, unknownColumns, metricCount };
}

function isBlankRow(row: readonly RawCell[]): boolean {
  return row.every((cell) => asDisplayString(cell).length === 0);
}

function parseCsv(text: string, maxRows: number, maxCells: number): RawTable {
  const rows: RawCell[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let sawAny = false;
  let cells = 0;

  const pushField = () => {
    row.push(field);
    field = '';
    cells += 1;
    if (cells > maxCells) {
      throw new MetricsImportError('COMPANY_METRICS_TOO_LARGE', `CSV 单元格数量超过 ${maxCells}`);
    }
  };
  const pushRow = () => {
    // A final newline is not a data row; rows containing an explicit blank
    // field in the middle are retained so source row numbers remain stable.
    if (row.length > 0) rows.push(row);
    row = [];
    if (rows.length > maxRows) {
      throw new MetricsImportError('COMPANY_METRICS_TOO_LARGE', `CSV 行数超过 ${maxRows}`);
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    sawAny = true;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field.length === 0) {
      quoted = true;
      continue;
    }
    if (char === ',') {
      pushField();
      continue;
    }
    if (char === '\r' || char === '\n') {
      pushField();
      pushRow();
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      continue;
    }
    field += char;
  }
  if (quoted) throw new MetricsImportError('COMPANY_METRICS_CSV_INVALID', 'CSV 存在未闭合的引号');
  if (sawAny && (field.length > 0 || row.length > 0)) {
    pushField();
    pushRow();
  }
  return rows;
}

function decodeDelimitedBytes(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '');
    if (text.includes('\u0000')) throw new Error('NUL');
    return text;
  } catch {
    try {
      const text = new TextDecoder('gb18030', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '');
      if (text.includes('\u0000')) throw new Error('NUL');
      return text;
    } catch {
      throw new MetricsImportError('COMPANY_METRICS_ENCODING_UNSUPPORTED', '文件不是可识别的 UTF-8 或 GB18030 文本');
    }
  }
}

function formatWorkbookDate1904(workbook: XLSX.WorkBook): boolean {
  return Boolean(workbook.Workbook?.WBProps?.date1904);
}

function parseWorkbook(bytes: Uint8Array, maxRows: number, maxCells: number, maxSheets: number): { rows: RawTable; sheetName: string; date1904: boolean } {
  let workbook: XLSX.WorkBook;
  try {
    // Keep Excel dates as serials.  SheetJS converts a midnight Date to a
    // JavaScript value one millisecond before midnight in some timezone
    // combinations; serials let us use the workbook's calendar date without
    // depending on the host timezone.
    workbook = XLSX.read(bytes, { type: 'buffer', cellDates: false, dense: true, WTF: false });
  } catch (error) {
    throw new MetricsImportError('COMPANY_METRICS_FILE_UNSUPPORTED', 'Excel 文件无法读取', { cause: error });
  }
  if (workbook.SheetNames.length === 0) throw new MetricsImportError('COMPANY_METRICS_HEADER_NOT_FOUND', 'Excel 文件没有工作表');
  if (workbook.SheetNames.length > maxSheets) throw new MetricsImportError('COMPANY_METRICS_TOO_LARGE', `工作表数量超过 ${maxSheets}`);

  // Check declared ranges before materializing cells.  This limits a small
  // zip file that expands into a very large sparse worksheet.
  let declaredCells = 0;
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const ref = sheet['!ref'];
    if (!ref) continue;
    try {
      const range = XLSX.utils.decode_range(ref);
      const rows = range.e.r - range.s.r + 1;
      const cols = range.e.c - range.s.c + 1;
      if (rows > maxRows || rows * cols > maxCells) throw new MetricsImportError('COMPANY_METRICS_TOO_LARGE', `工作表 ${name} 超过行列上限`);
      declaredCells += rows * cols;
      if (declaredCells > maxCells) throw new MetricsImportError('COMPANY_METRICS_TOO_LARGE', `Excel 单元格数量超过 ${maxCells}`);
    } catch (error) {
      if (error instanceof MetricsImportError) throw error;
      throw new MetricsImportError('COMPANY_METRICS_FILE_UNSUPPORTED', `工作表 ${name} 的范围无法读取`, { cause: error });
    }
  }

  const sheetName = workbook.SheetNames[0]!;
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new MetricsImportError('COMPANY_METRICS_HEADER_NOT_FOUND', 'Excel 首个工作表为空');
  const rows = XLSX.utils.sheet_to_json<RawCell[]>(sheet, { header: 1, raw: true, defval: '' });
  if (rows.length > maxRows) throw new MetricsImportError('COMPANY_METRICS_TOO_LARGE', `Excel 行数超过 ${maxRows}`);
  let actualCells = 0;
  for (const row of rows) {
    actualCells += row.length;
    if (actualCells > maxCells) throw new MetricsImportError('COMPANY_METRICS_TOO_LARGE', `Excel 单元格数量超过 ${maxCells}`);
  }
  return { rows, sheetName, date1904: formatWorkbookDate1904(workbook) };
}

function parseMetricValue(value: RawCell): number | undefined | MetricsImportError {
  const text = asDisplayString(value);
  if (!text) return undefined;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return new MetricsImportError('COMPANY_METRICS_VALUE_INVALID', `指标值必须是非负整数：“${text}”`);
    return value;
  }
  const normalized = text.replace(/[\s,，]/gu, '');
  if (!/^\d+$/u.test(normalized)) return new MetricsImportError('COMPANY_METRICS_VALUE_INVALID', `指标值必须是非负整数：“${text}”`);
  const result = Number(normalized);
  if (!Number.isSafeInteger(result)) return new MetricsImportError('COMPANY_METRICS_VALUE_INVALID', `指标值超出安全整数范围：“${text}”`);
  return result;
}

function normalizeContentId(value: RawCell): string | undefined {
  const text = asDisplayString(value);
  return text.length > 0 ? text : undefined;
}

function normalizeOptionalText(value: RawCell): string | undefined {
  const text = asDisplayString(value);
  return text.length > 0 ? text : undefined;
}

function validateLimits(input: PlatformExportParseInput): Required<Pick<PlatformExportParseInput, 'maxBytes' | 'maxRows' | 'maxCells' | 'maxSheets'>> {
  const limits = {
    maxBytes: input.maxBytes ?? COMPANY_METRICS_MAX_BYTES,
    maxRows: input.maxRows ?? COMPANY_METRICS_MAX_ROWS,
    maxCells: input.maxCells ?? COMPANY_METRICS_MAX_CELLS,
    maxSheets: input.maxSheets ?? COMPANY_METRICS_MAX_SHEETS
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  }
  return limits;
}

function extensionFor(fileName: string): PlatformExportFormat {
  if (!fileName || fileName.includes('\u0000')) throw new MetricsImportError('COMPANY_METRICS_FILE_UNSUPPORTED', '文件名无效');
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLocaleLowerCase();
  if (extension === 'csv') return 'csv';
  if (extension === 'xlsx') return 'xlsx';
  if (extension === 'xls') return 'xls';
  throw new MetricsImportError('COMPANY_METRICS_FILE_UNSUPPORTED', `不支持的导出格式：.${extension || '(无扩展名)'}`);
}

function canonicalMetrics(mapping: HeaderMappingInternal, row: readonly RawCell[], sourceRow: number): { metrics: CompanyMetricValues; problem?: PlatformExportIssue } {
  const metrics: Partial<Record<CompanyMetricName, number>> = {};
  for (const field of ['views', 'likes', 'comments', 'shares', 'saves', 'followers', 'leads'] as const) {
    const index = mapping.columns[field];
    if (index === undefined) continue;
    const parsed = parseMetricValue(row[index]);
    if (parsed instanceof MetricsImportError) {
      return { metrics: {}, problem: issue(parsed.code, parsed.message, sourceRow, mapping.labels[field]) };
    }
    if (parsed !== undefined) metrics[field] = parsed;
  }
  if (Object.keys(metrics).length === 0) {
    return { metrics: {}, problem: issue('COMPANY_METRICS_METRIC_MISSING', '该行没有可用的指标值', sourceRow) };
  }
  return { metrics: metrics as CompanyMetricValues };
}

function firstHeader(rows: RawTable, aliases: Map<string, CompanyMetricCanonicalField[]>): { mapping: HeaderMappingInternal; index: number } {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (isBlankRow(row)) continue;
    const mapping = mapHeader(row, aliases);
    if (mapping.metricCount > 0) return { mapping, index };
  }
  throw new MetricsImportError('COMPANY_METRICS_COLUMNS_UNSUPPORTED', '没有识别到平台指标列');
}

/**
 * Parse one official platform export in memory.  The function never writes
 * files or databases.  If at least one row is valid, row-level problems are
 * returned as `partial`; if every data row is invalid, the first actionable
 * issue is thrown so callers can mark the whole import as failed.
 */
export async function parsePlatformExport(input: PlatformExportParseInput): Promise<PlatformExportParseResult> {
  const limits = validateLimits(input);
  const format = extensionFor(input.fileName);
  if (input.bytes.byteLength > limits.maxBytes) {
    throw new MetricsImportError('COMPANY_METRICS_TOO_LARGE', `文件大小超过 ${limits.maxBytes} 字节`);
  }
  const aliases = buildAliasMap(input.platform);
  let table: RawTable;
  let sheetName: string;
  let date1904 = false;
  if (format === 'csv') {
    const text = decodeDelimitedBytes(input.bytes);
    table = parseCsv(text, limits.maxRows, limits.maxCells);
    sheetName = 'CSV';
  } else {
    const workbook = parseWorkbook(input.bytes, limits.maxRows, limits.maxCells, limits.maxSheets);
    table = workbook.rows;
    sheetName = workbook.sheetName;
    date1904 = workbook.date1904;
  }
  if (table.length === 0) throw new MetricsImportError('COMPANY_METRICS_HEADER_NOT_FOUND', '文件没有可用表格行');

  let header: { mapping: HeaderMappingInternal; index: number };
  try {
    header = firstHeader(table, aliases);
  } catch (error) {
    if (error instanceof MetricsImportError) throw error;
    throw new MetricsImportError('COMPANY_METRICS_HEADER_NOT_FOUND', '没有识别到表头');
  }
  const headerRow = header.index + 1;
  const headerContract: PlatformExportHeader = {
    headerRow,
    sheetName,
    columns: header.mapping.columns,
    labels: header.mapping.labels,
    unknownColumns: header.mapping.unknownColumns
  };
  const rows: PlatformExportRow[] = [];
  const issues: PlatformExportIssue[] = header.mapping.unknownColumns.map((column) => issue('COMPANY_METRICS_UNKNOWN_COLUMN', `未识别的列“${column}”`, headerRow, column));
  let dataRowCount = 0;
  for (let index = header.index + 1; index < table.length; index += 1) {
    const raw = table[index]!;
    if (isBlankRow(raw)) continue;
    dataRowCount += 1;
    const sourceRow = index + 1;
    const rowIssues: PlatformExportIssue[] = [];
    const dateIndex = header.mapping.columns.metricDate;
    const metricDate = dateIndex === undefined ? undefined : normalizeDate(raw[dateIndex], format !== 'csv', date1904);
    if (!metricDate) rowIssues.push(issue('COMPANY_METRICS_DATE_INVALID', '缺少或无法识别数据日期', sourceRow, header.mapping.labels.metricDate));

    const canonical = canonicalMetrics(header.mapping, raw, sourceRow);
    if (canonical.problem) rowIssues.push(canonical.problem);

    const contentIndex = header.mapping.columns.contentId;
    const contentId = contentIndex === undefined ? undefined : normalizeContentId(raw[contentIndex]);
    if (!contentId) rowIssues.push(issue('COMPANY_METRICS_CONTENT_ID_MISSING', '缺少稳定的内容 ID，行已隔离', sourceRow, header.mapping.labels.contentId));

    if (rowIssues.length > 0) {
      issues.push(...rowIssues);
      continue;
    }

    const titleIndex = header.mapping.columns.contentTitle;
    const accountIndex = header.mapping.columns.accountRef;
    const rawRow = raw.map(stableRawCell);
    const rawRowSha256 = sha256(JSON.stringify(rawRow));
    rows.push({
      platform: input.platform,
      contentId: contentId!,
      ...(titleIndex === undefined ? {} : (() => {
        const value = normalizeOptionalText(raw[titleIndex]);
        return value === undefined ? {} : { contentTitle: value };
      })()),
      ...(accountIndex === undefined ? {} : (() => {
        const value = normalizeOptionalText(raw[accountIndex]);
        return value === undefined ? {} : { accountRef: value };
      })()),
      metricDate: metricDate!,
      metricKind: 'cumulative',
      metrics: canonical.metrics,
      sourceRow,
      headerRow,
      sheetName,
      rawRow,
      rawRowSha256
    });
  }

  if (dataRowCount === 0) throw new MetricsImportError('COMPANY_METRICS_NO_DATA_ROWS', '表头之后没有可用数据行', { headerRow });
  if (rows.length === 0 && issues.length > 0) {
    // Unknown columns are a structural error even when there are no rows. For
    // row-level errors, throwing the first one preserves a useful CLI/API code.
    const first = issues.find((item) => item.code !== 'COMPANY_METRICS_UNKNOWN_COLUMN') ?? issues[0]!;
    throw errorFromIssue(first, { headerRow, issues });
  }
  const status: PlatformExportParseResult['status'] = issues.length === 0 ? 'imported' : 'partial';
  return {
    platform: input.platform,
    fileName: input.fileName,
    format,
    status,
    rows,
    normalizedRows: rows,
    header: headerContract,
    issues,
    rowCount: dataRowCount,
    acceptedCount: rows.length,
    rejectedCount: dataRowCount - rows.length
  };
}

export { normalizeHeader };
