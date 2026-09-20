import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import { PublicApiError } from '../../shared/api/errors.js';
import {
  companyDataCoverageSchema,
  companyMetricImportStateSchema,
  companyMetricUploadMetadataSchema,
  companyMetricValuesSchema,
  companyPlatformSchema,
  type CompanyDataCoverage,
  type CompanyMetricImportState,
  type CompanyMetricUploadMetadata,
  type CompanyMetricValues,
  type CompanyPlatform
} from '../../shared/company/metrics.js';
import type {
  CompanyMetricImport,
  CompanyMetricImportIssue,
  CompanyMetricsStatus,
  CompanyPlatformMetricsSummary,
  CompanyProjectMetrics,
  CompanyMetricScanResponseData
} from '../../shared/api/company-metrics.js';
import { assertCompanyRelativePath } from './company-paths.js';
import { ensurePrivateDirectory, secureExistingPrivateFile } from '../db/permissions.js';
import {
  MetricsImportError,
  COMPANY_METRICS_MAX_BYTES,
  parsePlatformExport,
  type PlatformExportIssue,
} from './metrics-importer.js';

const PLATFORM_DATA_DIRECTORY = 'platform-data';
const RAW_DIRECTORY = `${PLATFORM_DATA_DIRECTORY}/raw`;
const DEFAULT_POLL_MS = 30_000;
const MAX_POLL_MS = 86_400_000;
const STALE_AFTER_MS = 48 * 60 * 60 * 1000;
const SUPPORTED_EXTENSIONS = new Set(['.csv', '.xlsx', '.xls']);

/**
 * Resolve the optional environment value at the composition boundary.  An
 * invalid value deliberately falls back to the service default instead of
 * allowing a typo to disable the watcher or create a tight busy loop.
 */
export function resolveCompanyMetricsPollInterval(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 5_000 && value <= MAX_POLL_MS ? value : undefined;
}

export interface CompanyMetricsWorkspace {
  readonly id: string;
  readonly rootPath: string;
}

export interface CompanyMetricImportResult extends CompanyMetricImport {
  /** Compatibility alias used by local callers to point at immutable evidence. */
  readonly sourcePath: string;
  readonly errorCode?: string;
}

export interface CompanyMetricScanResult extends Omit<CompanyMetricScanResponseData, 'scanned' | 'imported' | 'partial' | 'duplicate' | 'conflict' | 'failed' | 'imports'> {
  readonly processed: number;
  readonly scanned: number;
  readonly imported: number;
  readonly partial: number;
  readonly duplicate: number;
  readonly conflict: number;
  readonly failed: number;
  readonly imports: readonly CompanyMetricImportResult[];
}

export interface CompanyMetricsService {
  importFile(input: { readonly relativePath: string }): Promise<CompanyMetricImportResult>;
  uploadFile(input: CompanyMetricUploadInput): Promise<CompanyMetricImportResult>;
  scanIncoming(): Promise<CompanyMetricScanResult>;
  listProjectMetrics(projectId: string, range?: { readonly from?: string; readonly to?: string }): Promise<CompanyProjectMetrics>;
  getStatus(projectId?: string): Promise<CompanyMetricsStatus>;
  start(): { stop(): Promise<void> };
}

export interface CompanyMetricUploadInput extends CompanyMetricUploadMetadata {
  readonly projectId: string;
  readonly bytes: Uint8Array;
}

export interface CompanyMetricsServiceOptions {
  readonly database: Database.Database;
  readonly workspace: CompanyMetricsWorkspace;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly pollIntervalMs?: number;
  readonly stabilityDelayMs?: number;
}

interface ImportRow {
  id: string;
  workspace_id: string;
  project_id: string;
  platform: CompanyPlatform;
  source_relative_path: string;
  raw_relative_path: string | null;
  source_sha256: string;
  source_type: 'official-export';
  state: CompanyMetricImportState;
  row_count: number;
  imported_count: number;
  rejected_count: number;
  error_json: string;
  created_at: string;
  updated_at: string;
  imported_at: string | null;
}

interface SnapshotRow {
  id: string;
  workspace_id: string;
  project_id: string;
  platform: CompanyPlatform;
  account_ref: string | null;
  content_id: string;
  content_title: string | null;
  metric_date: string;
  metric_kind: 'cumulative';
  observed_at: string;
  metrics_json: string;
  source_type: 'official-export';
  source_relative_path: string;
  raw_relative_path: string;
  source_sha256: string;
  source_row: number;
  header_row: number;
  sheet_name: string;
  raw_row_sha256: string;
  created_at: string;
}

interface ProjectRow {
  id: string;
  workspace_id: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function safeFileName(value: string): string {
  const cleaned = basename(value).replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return cleaned.length > 0 ? cleaned.slice(-180) : 'export.bin';
}

function pathInside(parent: string, candidate: string): boolean {
  const value = relative(parent, candidate);
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !value.startsWith(sep);
}

function parseErrorIssue(error: unknown, row = 1): CompanyMetricImportIssue {
  if (error instanceof MetricsImportError) {
    return { row: error.details.sourceRow ?? row, code: error.code, message: error.message.slice(0, 1000) };
  }
  return { row, code: 'COMPANY_METRICS_IMPORT_FAILED', message: '导入文件失败。' };
}

function convertIssue(issue: PlatformExportIssue): CompanyMetricImportIssue {
  return {
    row: issue.row,
    code: issue.code,
    message: issue.message.slice(0, 1000)
  };
}

function parseIssues(value: string): CompanyMetricImportIssue[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is CompanyMetricImportIssue => {
      if (item === null || typeof item !== 'object') return false;
      const candidate = item as Record<string, unknown>;
      return typeof candidate.row === 'number'
        && typeof candidate.code === 'string'
        && typeof candidate.message === 'string';
    }).slice(0, 1000);
  } catch {
    return [];
  }
}

function rowToImport(row: ImportRow, stateOverride?: CompanyMetricImportState): CompanyMetricImportResult {
  const issues = parseIssues(row.error_json);
  const rawRelativePath = row.raw_relative_path;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    platform: row.platform,
    sourceRelativePath: row.source_relative_path,
    rawRelativePath,
    sourcePath: rawRelativePath ?? row.source_relative_path,
    sourceSha256: row.source_sha256,
    sourceType: row.source_type,
    state: stateOverride ?? row.state,
    rowCount: row.row_count,
    importedCount: row.imported_count,
    rejectedCount: row.rejected_count,
    issues,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    importedAt: row.imported_at ?? null,
    ...(issues[0] === undefined ? {} : { errorCode: issues[0].code })
  };
}

function apiImport(row: ImportRow): CompanyMetricImport {
  const value = rowToImport(row);
  const { sourcePath: _sourcePath, errorCode: _errorCode, ...publicValue } = value;
  return publicValue;
}

function normalizeMetrics(value: unknown): CompanyMetricValues {
  return companyMetricValuesSchema.parse(value);
}

function metricValuesEqual(left: CompanyMetricValues, right: CompanyMetricValues): boolean {
  return stableJson(left) === stableJson(right);
}

function choosePollInterval(value: number | undefined): number {
  if (value === undefined) return DEFAULT_POLL_MS;
  return Number.isInteger(value) && value >= 5_000 && value <= MAX_POLL_MS ? value : DEFAULT_POLL_MS;
}

function coverageForImports(rows: readonly ImportRow[], now: Date): CompanyDataCoverage {
  if (rows.length === 0) return 'import_required';
  const latest = rows[0];
  // Surface the newest bad batch even when an older successful snapshot still
  // exists.  Otherwise an operator can keep seeing a green dashboard while
  // the latest official export is malformed or attached to another project.
  if (latest?.state === 'conflict') return 'attention';
  if (latest?.state === 'failed') return 'error';
  const latestSuccessful = rows.find(row => row.state === 'imported' || row.state === 'partial' || row.state === 'duplicate');
  if (latestSuccessful !== undefined) {
    const updated = Date.parse(latestSuccessful.updated_at);
    if (Number.isFinite(updated) && now.getTime() - updated > STALE_AFTER_MS) return 'stale';
    return 'connected';
  }
  return 'error';
}

function addMetric(target: Record<string, number>, key: string, value: number): void {
  target[key] = (target[key] ?? 0) + value;
}

function parseSnapshotMetrics(row: SnapshotRow): CompanyMetricValues {
  try {
    return normalizeMetrics(JSON.parse(row.metrics_json));
  } catch {
    return {} as CompanyMetricValues;
  }
}

function latestSnapshots(rows: readonly SnapshotRow[]): SnapshotRow[] {
  const latest = new Map<string, SnapshotRow>();
  for (const row of rows) {
    const key = `${row.platform}\0${row.account_ref ?? ''}\0${row.content_id}\0${row.metric_kind}`;
    const existing = latest.get(key);
    // Cumulative exports are observations of a content item over time.  The
    // business date is the primary ordering key; an older export can be
    // copied into the drop folder after a newer one and must not roll the
    // dashboard backwards merely because it was observed later.
    if (existing === undefined || existing.metric_date < row.metric_date
      || (existing.metric_date === row.metric_date && (existing.observed_at < row.observed_at
        || (existing.observed_at === row.observed_at && existing.id < row.id)))) {
      latest.set(key, row);
    }
  }
  return [...latest.values()];
}

function aggregate(rows: readonly SnapshotRow[]): { totals: CompanyMetricValues; contentCount: number } {
  const totals: Record<string, number> = {};
  const contentIds = new Set<string>();
  const followerByAccount = new Map<string, number>();
  for (const row of latestSnapshots(rows)) {
    contentIds.add(`${row.platform}\0${row.content_id}`);
    const metrics = parseSnapshotMetrics(row);
    for (const [key, rawValue] of Object.entries(metrics)) {
      if (typeof rawValue !== 'number') continue;
      if (key === 'followers') {
        // The same account label can legitimately exist on multiple
        // platforms.  Keep those populations independent when producing the
        // workspace-wide projection.
        const account = `${row.platform}\0${row.account_ref ?? `content:${row.content_id}`}`;
        followerByAccount.set(account, Math.max(followerByAccount.get(account) ?? 0, rawValue));
      } else {
        addMetric(totals, key, rawValue);
      }
    }
  }
  if (followerByAccount.size > 0) {
    totals.followers = [...followerByAccount.values()].reduce((sum, value) => sum + value, 0);
  }
  return { totals: (Object.keys(totals).length === 0 ? {} : normalizeMetrics(totals)) as CompanyMetricValues, contentCount: contentIds.size };
}

function latestDate(rows: readonly SnapshotRow[]): string | null {
  return rows.reduce<string | null>((latest, row) => latest === null || latest < row.metric_date ? row.metric_date : latest, null);
}

function latestObserved(rows: readonly SnapshotRow[]): string | null {
  return rows.reduce<string | null>((latest, row) => latest === null || latest < row.observed_at ? row.observed_at : latest, null);
}

function projectImportRows(
  database: Database.Database,
  workspaceId: string,
  projectId?: string,
  platform?: CompanyPlatform
): ImportRow[] {
  const clauses = ['workspace_id = ?'];
  const args: unknown[] = [workspaceId];
  if (projectId !== undefined) { clauses.push('project_id = ?'); args.push(projectId); }
  if (platform !== undefined) { clauses.push('platform = ?'); args.push(platform); }
  return database.prepare(`
    SELECT * FROM company_platform_metric_imports
    WHERE ${clauses.join(' AND ')}
    ORDER BY updated_at DESC, id DESC
  `).all(...args) as ImportRow[];
}

function projectSnapshotRows(
  database: Database.Database,
  workspaceId: string,
  projectId: string,
  platform?: CompanyPlatform,
  range?: { readonly from?: string; readonly to?: string }
): SnapshotRow[] {
  const clauses = ['workspace_id = ?', 'project_id = ?'];
  const args: unknown[] = [workspaceId, projectId];
  if (platform !== undefined) { clauses.push('platform = ?'); args.push(platform); }
  if (range?.from !== undefined) { clauses.push('metric_date >= ?'); args.push(range.from); }
  if (range?.to !== undefined) { clauses.push('metric_date <= ?'); args.push(range.to); }
  return database.prepare(`
    SELECT * FROM company_platform_metric_snapshots
    WHERE ${clauses.join(' AND ')}
    ORDER BY observed_at DESC, id DESC
  `).all(...args) as SnapshotRow[];
}

export function createCompanyMetricsService(options: CompanyMetricsServiceOptions): CompanyMetricsService {
  const now = options.now ?? (() => new Date());
  const makeId = options.idFactory ?? ulid;
  const platformDataRoot = join(options.workspace.rootPath, PLATFORM_DATA_DIRECTORY);
  const rawRoot = join(options.workspace.rootPath, RAW_DIRECTORY);
  ensurePrivateDirectory(platformDataRoot);
  ensurePrivateDirectory(rawRoot);
  const pollIntervalMs = choosePollInterval(options.pollIntervalMs);
  const stabilityDelayMs = Math.max(0, options.stabilityDelayMs ?? 100);
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<CompanyMetricScanResult> | undefined;
  let stopped = false;
  let lastScanAt: string | null = null;

  function sourcePath(relativePathInput: string): {
    relativePath: string;
    absolutePath: string;
    platform: CompanyPlatform;
    projectId: string;
  } {
    let relativePath: string;
    try {
      relativePath = assertCompanyRelativePath(relativePathInput);
    } catch {
      throw new PublicApiError('COMPANY_METRICS_PATH_INVALID', 'Metrics source path is invalid', 400);
    }
    if (!relativePath.startsWith(`${PLATFORM_DATA_DIRECTORY}/`)) {
      throw new PublicApiError('COMPANY_METRICS_PATH_INVALID', 'Metrics source must be under platform-data', 400);
    }
    const segments = relativePath.split('/');
    if (segments.length < 4 || segments[0] !== PLATFORM_DATA_DIRECTORY || segments[1] === 'raw') {
      throw new PublicApiError('COMPANY_METRICS_PATH_INVALID', 'Metrics source path is invalid', 400);
    }
    const platform = companyPlatformSchema.safeParse(segments[1]);
    if (!platform.success) throw new PublicApiError('COMPANY_METRICS_PLATFORM_INVALID', 'Metrics platform is invalid', 400);
    const projectId = segments[2]!;
    if (!/^[A-Za-z0-9._:-]+$/u.test(projectId)) {
      throw new PublicApiError('COMPANY_METRICS_PROJECT_INVALID', 'Metrics project is invalid', 400);
    }
    const absolutePath = join(options.workspace.rootPath, ...segments);
    if (!pathInside(platformDataRoot, absolutePath)) {
      throw new PublicApiError('COMPANY_METRICS_PATH_INVALID', 'Metrics source path is invalid', 400);
    }
    return { relativePath, absolutePath, platform: platform.data, projectId };
  }

  async function assertSecureSource(path: string): Promise<void> {
    const segments = relative(platformDataRoot, path).split(sep).filter(Boolean);
    let current = platformDataRoot;
    for (const segment of segments) {
      current = join(current, segment);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new PublicApiError('COMPANY_METRICS_PATH_INVALID', 'Metrics source path is unsafe', 400);
    }
    const realRoot = realpathSync(platformDataRoot);
    const realCandidate = realpathSync(path);
    if (!pathInside(realRoot, realCandidate)) throw new PublicApiError('COMPANY_METRICS_PATH_INVALID', 'Metrics source path is unsafe', 400);
  }

  async function stableBytes(path: string): Promise<Uint8Array> {
    await assertSecureSource(path);
    const before = await stat(path);
    if (!before.isFile()) throw new PublicApiError('COMPANY_METRICS_FILE_INVALID', 'Metrics source is not a file', 400);
    const bytes = await readFile(path);
    if (stabilityDelayMs > 0) await new Promise<void>(resolvePromise => setTimeout(resolvePromise, stabilityDelayMs));
    // Re-check the path components after the stability window as well.  A
    // file can be replaced by a symlink while an operator is copying it.
    await assertSecureSource(path);
    const after = await stat(path);
    if (!after.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new MetricsImportError('COMPANY_METRICS_FILE_CHANGED', '导出文件仍在写入，请稍后重试。');
    }
    return bytes;
  }

  async function copyRaw(bytes: Uint8Array, platform: CompanyPlatform, projectId: string, sourceHash: string, originalName: string): Promise<string> {
    const destinationDirectory = join(rawRoot, platform, projectId);
    ensurePrivateDirectory(join(rawRoot, platform));
    ensurePrivateDirectory(destinationDirectory);
    const relativeDestination = `${RAW_DIRECTORY}/${platform}/${projectId}/${sourceHash}-${safeFileName(originalName)}`;
    const destination = join(options.workspace.rootPath, ...relativeDestination.split('/'));
    if (secureExistingPrivateFile(destination)) return relativeDestination;
    try {
      await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error;
      secureExistingPrivateFile(destination);
    }
    secureExistingPrivateFile(destination);
    return relativeDestination;
  }

  function findProject(projectId: string): ProjectRow {
    const row = options.database.prepare('SELECT id, workspace_id FROM company_projects WHERE id = ? AND workspace_id = ?')
      .get(projectId, options.workspace.id) as ProjectRow | undefined;
    if (row === undefined) throw new PublicApiError('COMPANY_PROJECT_NOT_FOUND', 'Project not found', 404);
    return row;
  }

  function saveFailure(input: {
    projectId: string;
    platform: CompanyPlatform;
    relativePath: string;
    sourceHash: string;
    rawRelativePath: string | null;
    rowCount: number;
    rejectedCount: number;
    issue: CompanyMetricImportIssue;
    state?: CompanyMetricImportState;
  }): CompanyMetricImportResult {
    const timestamp = now().toISOString();
    const existing = options.database.prepare(`
      SELECT * FROM company_platform_metric_imports
      WHERE workspace_id = ? AND project_id = ? AND source_sha256 = ?
    `).get(options.workspace.id, input.projectId, input.sourceHash) as ImportRow | undefined;
    if (existing !== undefined) return rowToImport(existing);
    const id = makeId();
    options.database.prepare(`
      INSERT INTO company_platform_metric_imports (
        id, workspace_id, project_id, platform, source_relative_path, source_sha256,
        raw_relative_path, source_type, state, row_count, imported_count, rejected_count,
        error_json, created_at, updated_at, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'official-export', ?, ?, 0, ?, ?, ?, ?, NULL)
    `).run(
      id, options.workspace.id, input.projectId, input.platform, input.relativePath, input.sourceHash,
      input.rawRelativePath, input.state ?? 'failed', input.rowCount, input.rejectedCount, JSON.stringify([input.issue]), timestamp, timestamp
    );
    return rowToImport(options.database.prepare('SELECT * FROM company_platform_metric_imports WHERE id = ?').get(id) as ImportRow);
  }

  async function importFile(input: { readonly relativePath: string }): Promise<CompanyMetricImportResult> {
    const source = sourcePath(input.relativePath);
    findProject(source.projectId);
    const extension = source.relativePath.slice(source.relativePath.lastIndexOf('.')).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      return saveFailure({
        projectId: source.projectId, platform: source.platform, relativePath: source.relativePath,
        sourceHash: createHash('sha256').update(source.relativePath).digest('hex'), rawRelativePath: null,
        rowCount: 0, rejectedCount: 0,
        issue: { row: 1, code: 'COMPANY_METRICS_FILE_UNSUPPORTED', message: '只支持 CSV、XLSX 或 XLS 导出文件。' }
      });
    }
    let bytes: Uint8Array;
    try {
      bytes = await stableBytes(source.absolutePath);
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      return saveFailure({
        projectId: source.projectId, platform: source.platform, relativePath: source.relativePath,
        sourceHash: createHash('sha256').update(source.relativePath).digest('hex'), rawRelativePath: null,
        rowCount: 0, rejectedCount: 0, issue: parseErrorIssue(error)
      });
    }
    const sourceHash = sha256(bytes);
    const sameProject = options.database.prepare(`
      SELECT * FROM company_platform_metric_imports
      WHERE workspace_id = ? AND project_id = ? AND source_sha256 = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(options.workspace.id, source.projectId, sourceHash) as ImportRow | undefined;
    if (sameProject !== undefined) {
      return sameProject.state === 'failed' || sameProject.state === 'conflict'
        ? rowToImport(sameProject)
        : rowToImport(sameProject, 'duplicate');
    }
    const otherProject = options.database.prepare(`
      SELECT * FROM company_platform_metric_imports
      WHERE workspace_id = ? AND source_sha256 = ?
      ORDER BY created_at ASC LIMIT 1
    `).get(options.workspace.id, sourceHash) as ImportRow | undefined;
    const rawRelativePath = await copyRaw(bytes, source.platform, source.projectId, sourceHash, basename(source.absolutePath));
    if (otherProject !== undefined && (otherProject.project_id !== source.projectId || otherProject.platform !== source.platform)) {
      return saveFailure({
        projectId: source.projectId, platform: source.platform, relativePath: source.relativePath,
        sourceHash, rawRelativePath, rowCount: 0, rejectedCount: 0,
        issue: { row: 1, code: 'COMPANY_METRICS_SOURCE_CONFLICT', message: '相同文件已绑定到另一个项目或平台。' },
        state: 'conflict'
      });
    }
    let parsed;
    try {
      parsed = await parsePlatformExport({ platform: source.platform, fileName: basename(source.absolutePath), bytes });
    } catch (error) {
      return saveFailure({
        projectId: source.projectId, platform: source.platform, relativePath: source.relativePath,
        sourceHash, rawRelativePath, rowCount: 0, rejectedCount: 0, issue: parseErrorIssue(error)
      });
    }
    const issues = parsed.issues.map(convertIssue);
    const timestamp = now().toISOString();
    const importId = makeId();
    let importedCount = 0;
    let duplicateCount = 0;
    let conflictCount = 0;
    const transaction = options.database.transaction(() => {
      options.database.prepare(`
        INSERT INTO company_platform_metric_imports (
          id, workspace_id, project_id, platform, source_relative_path, source_sha256,
          raw_relative_path, source_type, state, row_count, imported_count, rejected_count,
          error_json, created_at, updated_at, imported_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'official-export', 'partial', ?, 0, ?, ?, ?, ?, NULL)
      `).run(importId, options.workspace.id, source.projectId, source.platform, source.relativePath, sourceHash,
        rawRelativePath, parsed.rowCount, parsed.rejectedCount, JSON.stringify(issues), timestamp, timestamp);
      const findBySource = options.database.prepare(`
        SELECT * FROM company_platform_metric_snapshots
        WHERE workspace_id = ? AND project_id = ? AND source_sha256 = ? AND source_row = ?
      `);
      const findLogical = options.database.prepare(`
        SELECT * FROM company_platform_metric_snapshots
        WHERE workspace_id = ? AND project_id = ? AND platform = ?
          AND IFNULL(account_ref, '') = IFNULL(?, '') AND content_id = ?
          AND metric_date = ? AND metric_kind = ?
        ORDER BY observed_at DESC, id DESC LIMIT 1
      `);
      const insertSnapshot = options.database.prepare(`
        INSERT INTO company_platform_metric_snapshots (
          id, workspace_id, project_id, platform, account_ref, content_id, content_title,
          metric_date, metric_kind, observed_at, metrics_json, source_type, source_relative_path,
          raw_relative_path, source_sha256, source_row, header_row, sheet_name, raw_row_sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'cumulative', ?, ?, 'official-export', ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of parsed.rows) {
        const metrics = normalizeMetrics(row.metrics);
        const existingBySource = findBySource.get(options.workspace.id, source.projectId, sourceHash, row.sourceRow) as SnapshotRow | undefined;
        if (existingBySource !== undefined) {
          duplicateCount += 1;
          continue;
        }
        const existingLogical = findLogical.get(options.workspace.id, source.projectId, source.platform,
          row.accountRef ?? null, row.contentId, row.metricDate, row.metricKind) as SnapshotRow | undefined;
        if (existingLogical !== undefined) {
          if (metricValuesEqual(parseSnapshotMetrics(existingLogical), metrics)) duplicateCount += 1;
          else {
            conflictCount += 1;
            issues.push({ row: row.sourceRow, code: 'COMPANY_METRICS_LOGICAL_CONFLICT', message: '同一内容和日期已有不同指标，未覆盖历史快照。' });
          }
          continue;
        }
        insertSnapshot.run(
          makeId(), options.workspace.id, source.projectId, source.platform, row.accountRef ?? null,
          row.contentId, row.contentTitle ?? null, row.metricDate,
          timestamp, stableJson(metrics), source.relativePath, rawRelativePath,
          sourceHash, row.sourceRow, row.headerRow, row.sheetName, row.rawRowSha256, timestamp
        );
        importedCount += 1;
      }
      const state: CompanyMetricImportState = conflictCount > 0
        ? 'conflict'
        : importedCount === 0 && duplicateCount > 0 && parsed.rejectedCount === 0
          ? 'duplicate'
          : parsed.status === 'partial' || parsed.rejectedCount > 0
            ? 'partial'
            : 'imported';
      const importedAt = state === 'imported' || state === 'partial' || state === 'duplicate' ? timestamp : null;
      options.database.prepare(`
        UPDATE company_platform_metric_imports
        SET state = ?, imported_count = ?, rejected_count = ?, error_json = ?, updated_at = ?, imported_at = ?
        WHERE id = ?
      `).run(state, importedCount, parsed.rejectedCount + conflictCount, JSON.stringify(issues.slice(0, 1000)), timestamp, importedAt, importId);
    });
    try {
      transaction.immediate();
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const duplicate = options.database.prepare(`
          SELECT * FROM company_platform_metric_imports
          WHERE workspace_id = ? AND project_id = ? AND source_sha256 = ?
          ORDER BY created_at DESC LIMIT 1
        `).get(options.workspace.id, source.projectId, sourceHash) as ImportRow | undefined;
        if (duplicate !== undefined) {
          return duplicate.state === 'failed' || duplicate.state === 'conflict'
            ? rowToImport(duplicate)
            : rowToImport(duplicate, 'duplicate');
        }
      }
      throw error;
    }
    return rowToImport(options.database.prepare('SELECT * FROM company_platform_metric_imports WHERE id = ?').get(importId) as ImportRow);
  }

  async function uploadFile(input: CompanyMetricUploadInput): Promise<CompanyMetricImportResult> {
    const metadata = companyMetricUploadMetadataSchema.safeParse({
      platform: input.platform,
      fileName: input.fileName
    });
    if (!metadata.success) {
      throw new PublicApiError('COMPANY_METRICS_UPLOAD_INVALID', '导入文件名或平台无效。', 400);
    }
    if (!/^[A-Za-z0-9._:-]+$/u.test(input.projectId) || input.projectId === '.' || input.projectId === '..') {
      throw new PublicApiError('COMPANY_METRICS_PROJECT_INVALID', 'Metrics project is invalid', 400);
    }
    findProject(input.projectId);
    if (!(input.bytes instanceof Uint8Array)) {
      throw new PublicApiError('COMPANY_METRICS_FILE_INVALID', '导入内容不是有效文件。', 400);
    }
    if (input.bytes.byteLength > COMPANY_METRICS_MAX_BYTES) {
      throw new PublicApiError('COMPANY_METRICS_FILE_TOO_LARGE', '导入文件不能超过 20 MB。', 413);
    }

    const sourceHash = sha256(input.bytes);
    const destinationDirectory = join(platformDataRoot, metadata.data.platform, input.projectId);
    ensurePrivateDirectory(join(platformDataRoot, metadata.data.platform));
    ensurePrivateDirectory(destinationDirectory);
    const relativePath = `${PLATFORM_DATA_DIRECTORY}/${metadata.data.platform}/${input.projectId}/${sourceHash}-${safeFileName(metadata.data.fileName)}`;
    const destination = join(options.workspace.rootPath, ...relativePath.split('/'));
    if (!secureExistingPrivateFile(destination)) {
      try {
        await writeFile(destination, input.bytes, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error;
      }
      secureExistingPrivateFile(destination);
    }
    return importFile({ relativePath });
  }

  async function scanIncoming(): Promise<CompanyMetricScanResult> {
    if (inFlight !== undefined) return inFlight;
    const run = (async (): Promise<CompanyMetricScanResult> => {
      const files: string[] = [];
      for (const platform of companyPlatformSchema.options) {
        const platformRoot = join(platformDataRoot, platform);
        try {
          const platformInfo = await lstat(platformRoot);
          if (platformInfo.isSymbolicLink() || !platformInfo.isDirectory()) continue;
        } catch (error) {
          if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) continue;
          try {
            await mkdir(platformRoot, { recursive: false, mode: 0o700 });
          } catch (mkdirError) {
            if (!(typeof mkdirError === 'object' && mkdirError !== null && 'code' in mkdirError && mkdirError.code === 'EEXIST')) throw mkdirError;
            const replacement = await lstat(platformRoot);
            if (replacement.isSymbolicLink() || !replacement.isDirectory()) continue;
          }
        }
        try { ensurePrivateDirectory(platformRoot); } catch { continue; }
        let projectEntries;
        try { projectEntries = await readdir(platformRoot, { withFileTypes: true }); } catch { continue; }
        for (const projectEntry of projectEntries) {
          if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) continue;
          const projectRoot = join(platformRoot, projectEntry.name);
          try { ensurePrivateDirectory(projectRoot); } catch { continue; }
          let entries;
          try { entries = await readdir(projectRoot, { withFileTypes: true }); } catch { continue; }
          for (const entry of entries) {
            if (!entry.isFile() || entry.isSymbolicLink()) continue;
            const extension = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
            if (!SUPPORTED_EXTENSIONS.has(extension)) continue;
            files.push(`${PLATFORM_DATA_DIRECTORY}/${platform}/${projectEntry.name}/${entry.name}`);
          }
        }
      }
      files.sort((left, right) => left.localeCompare(right));
      const results: CompanyMetricImportResult[] = [];
      for (const file of files) {
        try { results.push(await importFile({ relativePath: file })); }
        catch (error) {
          const issue = parseErrorIssue(error);
          // Invalid paths/symlinks are intentionally not converted into a
          // database row: the scanner must never invent a project binding.
          results.push({
            id: makeId(), workspaceId: options.workspace.id, projectId: file.split('/')[2] ?? '',
            platform: (file.split('/')[1] ?? 'douyin') as CompanyPlatform,
            sourceRelativePath: file, rawRelativePath: null, sourcePath: file,
            sourceSha256: sha256(new TextEncoder().encode(file)), sourceType: 'official-export',
            state: 'failed', rowCount: 0, importedCount: 0, rejectedCount: 0, issues: [issue],
            createdAt: now().toISOString(), updatedAt: now().toISOString(), importedAt: null,
            errorCode: issue.code
          });
        }
      }
      const scannedAt = now().toISOString();
      lastScanAt = scannedAt;
      return {
        processed: results.length,
        scanned: results.length,
        imported: results.filter(result => result.state === 'imported').length,
        partial: results.filter(result => result.state === 'partial').length,
        duplicate: results.filter(result => result.state === 'duplicate').length,
        conflict: results.filter(result => result.state === 'conflict').length,
        failed: results.filter(result => result.state === 'failed').length,
        imports: results,
        scannedAt
      };
    })();
    inFlight = run;
    try { return await run; } finally { if (inFlight === run) inFlight = undefined; }
  }

  async function listProjectMetrics(projectIdInput: string, range?: { readonly from?: string; readonly to?: string }): Promise<CompanyProjectMetrics> {
    const project = findProject(projectIdInput);
    const platforms: CompanyPlatformMetricsSummary[] = [];
    const allRows = projectSnapshotRows(options.database, options.workspace.id, project.id, undefined, range);
    for (const platform of companyPlatformSchema.options) {
      const rows = allRows.filter(row => row.platform === platform);
      const imports = projectImportRows(options.database, options.workspace.id, project.id, platform);
      const aggregateResult = aggregate(rows);
      platforms.push({
        platform,
        coverage: coverageForImports(imports, now()),
        snapshotCount: rows.length,
        contentCount: aggregateResult.contentCount,
        totals: aggregateResult.totals,
        latestMetricDate: latestDate(rows),
        latestObservedAt: latestObserved(rows),
        lastImportedAt: imports.find(row => row.imported_at !== null)?.imported_at ?? null
      });
    }
    const aggregateResult = aggregate(allRows);
    const imports = projectImportRows(options.database, options.workspace.id, project.id);
    const coverage = coverageForImports(imports, now());
    return {
      projectId: project.id,
      coverage: companyDataCoverageSchema.parse(coverage),
      snapshotCount: allRows.length,
      contentCount: aggregateResult.contentCount,
      totals: aggregateResult.totals,
      latestMetricDate: latestDate(allRows),
      latestObservedAt: latestObserved(allRows),
      lastImportedAt: imports.find(row => row.imported_at !== null)?.imported_at ?? null,
      platforms,
      recentImports: imports.slice(0, 20).map(apiImport)
    };
  }

  async function getStatus(projectId?: string): Promise<CompanyMetricsStatus> {
    if (projectId !== undefined) findProject(projectId);
    const platforms: CompanyPlatformMetricsSummary[] = [];
    const allRows = projectId === undefined ? options.database.prepare('SELECT * FROM company_platform_metric_snapshots WHERE workspace_id = ? ORDER BY observed_at DESC').all(options.workspace.id) as SnapshotRow[] : projectSnapshotRows(options.database, options.workspace.id, projectId);
    for (const platform of companyPlatformSchema.options) {
      const rows = allRows.filter(row => row.platform === platform);
      const imports = projectImportRows(options.database, options.workspace.id, projectId, platform);
      const aggregateResult = aggregate(rows);
      platforms.push({
        platform, coverage: coverageForImports(imports, now()), snapshotCount: rows.length,
        contentCount: aggregateResult.contentCount, totals: aggregateResult.totals,
        latestMetricDate: latestDate(rows), latestObservedAt: latestObserved(rows),
        lastImportedAt: imports.find(row => row.imported_at !== null)?.imported_at ?? null
      });
    }
    const imports = projectImportRows(options.database, options.workspace.id, projectId);
    const successful = imports.find(row => row.imported_at !== null)?.imported_at ?? null;
    const coverage = coverageForImports(imports, now());
    return {
      coverage,
      platforms,
      recentImports: imports.slice(0, 20).map(apiImport),
      lastScanAt: lastScanAt ?? successful
    };
  }

  function start(): { stop(): Promise<void> } {
    if (timer !== undefined) clearInterval(timer);
    stopped = false;
    void scanIncoming().catch(() => undefined);
    timer = setInterval(() => {
      if (!stopped) void scanIncoming().catch(() => undefined);
    }, pollIntervalMs);
    timer.unref?.();
    return {
      stop: async () => {
        stopped = true;
        if (timer !== undefined) clearInterval(timer);
        timer = undefined;
        if (inFlight !== undefined) await inFlight.catch(() => undefined);
      }
    };
  }

  return { importFile, uploadFile, scanIncoming, listProjectMetrics, getStatus, start };
}

export function createUnavailableCompanyMetricsService(): CompanyMetricsService {
  const unavailable = () => Promise.reject(new PublicApiError('COMPANY_METRICS_UNAVAILABLE', 'Company metrics are unavailable', 503));
  return {
    importFile: unavailable,
    uploadFile: unavailable,
    scanIncoming: unavailable,
    listProjectMetrics: unavailable,
    getStatus: async () => ({ coverage: 'not_configured', platforms: [], recentImports: [], lastScanAt: null }),
    start: () => ({ stop: async () => undefined })
  };
}
