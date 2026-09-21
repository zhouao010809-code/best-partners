import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, relative, sep } from 'node:path';
import {
  projectContextSchema,
  projectFileDetailSchema,
  projectFilePageSchema,
  projectScanPreviewSchema,
  projectSummarySchema,
  type ProjectContext,
  type ProjectFile,
  type ProjectFileDetail,
  type ProjectFilePage,
  type ProjectScanPreview,
  type ProjectService,
  type ProjectSummary
} from '../../shared/api/projects.js';
import { scanProjectFolder, type ProjectScanEntry, type ProjectScanResult } from './project-scanner.js';
import { canonicalProjectRoot, resolveProjectPath } from './project-paths.js';

type CodedError = Error & { code: string };
type ProjectScanFunction = typeof scanProjectFolder;

interface ScanProposal extends ProjectScanResult {
  readonly scanId: string;
  readonly expiresAt: string;
  readonly guidanceFiles: readonly string[];
}

interface ProjectRow {
  id: string;
  root_path: string;
  display_name: string;
  source_revision: number;
  source_sha256: string;
  availability: 'ready' | 'scanning' | 'unavailable' | 'reconnect-required';
  output_root: string;
  created_at: string;
  updated_at: string;
  last_scanned_at: string | null;
}

interface ScanRow {
  id: string;
  project_id: string | null;
  root_path: string;
  source_sha256: string;
  state: 'scanning' | 'proposed' | 'confirmed' | 'failed' | 'superseded';
  proposal_json: string;
  created_at: string;
  updated_at: string;
}

interface FileRow {
  project_id: string;
  relative_path: string;
  kind: 'file' | 'directory';
  bytes: number | null;
  modified_at: string | null;
  sha256: string | null;
  parse_status: ProjectFile['parseStatus'] | null;
  parse_problem: string | null;
  content_text: string | null;
  origin: 'source' | 'output';
  indexed_revision: number;
}

const MAX_CONTENT_CHARACTERS = 200_000;
const SCAN_TTL_MS = 15 * 60 * 1000;
const FRESHNESS_TTL_MS = 1_000;

function coded(code: string, message: string, cause?: unknown): CodedError {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as CodedError;
  error.code = code;
  return error;
}

function isCoded(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && String((error as CodedError).code) === code;
}

function dateText(value: Date): string {
  return value.toISOString();
}

function protectedRoots(vaultRoot: string, stateRoot: string): readonly string[] {
  return [vaultRoot, stateRoot];
}

function contained(parent: string, candidate: string): boolean {
  const value = relative(parent, candidate);
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !value.startsWith('/') && !/^[A-Za-z]:/u.test(value));
}

function publicFile(row: FileRow): ProjectFile {
  const persistedProblem = row.parse_problem !== null && /^[A-Z][A-Z0-9_]{1,127}$/u.test(row.parse_problem) ? row.parse_problem : undefined;
  const problem = persistedProblem ?? (
    row.parse_status === 'unsupported' ? 'FILE_TYPE_UNSUPPORTED' :
      row.parse_status === 'too-large' ? 'FILE_TOO_LARGE_FOR_INDEX' :
        row.parse_status === 'failed' ? 'PARSE_FAILED' : undefined
  );
  return {
    relativePath: row.relative_path,
    kind: row.kind,
    ...(row.bytes === null ? {} : { bytes: row.bytes }),
    ...(row.modified_at === null ? {} : { modifiedAt: row.modified_at }),
    ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
    ...(row.parse_status === null ? {} : { parseStatus: row.parse_status }),
    ...(problem === undefined ? {} : { problem }),
    origin: row.origin
  };
}

function projectSummary(row: ProjectRow, database: Database.Database): ProjectSummary {
  const counts = database.prepare(`
    SELECT
      SUM(CASE WHEN kind = 'file' THEN 1 ELSE 0 END) AS file_count,
      SUM(CASE WHEN kind = 'file' AND parse_status = 'readable' THEN 1 ELSE 0 END) AS readable_file_count,
      SUM(CASE WHEN kind = 'file' AND parse_status IN ('unsupported', 'too-large', 'failed') THEN 1 ELSE 0 END) AS issue_count
    FROM personal_project_files WHERE project_id = ?
  `).get(row.id) as { file_count: number; readable_file_count: number | null; issue_count: number | null };
  return projectSummarySchema.parse({
    id: row.id,
    displayName: row.display_name,
    sourceRevision: row.source_revision,
    availability: row.availability,
    outputRoot: 'AI工作区',
    fileCount: counts.file_count ?? 0,
    readableFileCount: counts.readable_file_count ?? 0,
    issueCount: counts.issue_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_scanned_at === null ? {} : { lastScannedAt: row.last_scanned_at })
  });
}

function rowOrThrow(database: Database.Database, id: string): ProjectRow {
  const row = database.prepare('SELECT * FROM personal_projects WHERE id = ?').get(id) as ProjectRow | undefined;
  if (row === undefined) throw coded('PROJECT_NOT_FOUND', 'Project not found');
  return row;
}

function scanRowOrThrow(database: Database.Database, id: string): ScanRow {
  const row = database.prepare('SELECT * FROM personal_project_scan_runs WHERE id = ?').get(id) as ScanRow | undefined;
  if (row === undefined) throw coded('PROJECT_SCAN_NOT_FOUND', 'Project scan proposal not found');
  return row;
}

function parseScan(row: ScanRow): ScanProposal {
  const parsed = JSON.parse(row.proposal_json) as ScanProposal;
  if (parsed.scanId !== row.id || parsed.sourceSha256 !== row.source_sha256 || typeof parsed.sourceRoot !== 'string' || typeof parsed.expiresAt !== 'string') {
    throw coded('PROJECT_SCAN_INVALID', 'Project scan proposal is invalid');
  }
  return parsed;
}

function isExpired(proposal: ScanProposal, now: Date): boolean {
  return Date.parse(proposal.expiresAt) <= now.getTime();
}

function guidanceFiles(entries: readonly ProjectScanEntry[]): string[] {
  return entries.filter((entry) => entry.kind === 'file' && /(^|\/)(readme|project|context|brief|指南|说明|需求)/iu.test(entry.relativePath))
    .map((entry) => entry.relativePath).slice(0, 20);
}

function outputOrigin(path: string): 'source' | 'output' {
  return path === 'AI工作区' || path.startsWith('AI工作区/') ? 'output' : 'source';
}

function previewFromProposal(proposal: ScanProposal): ProjectScanPreview {
  const files = proposal.entries.filter((entry) => entry.kind === 'file');
  const publicEntries = proposal.entries.slice(0, 20_000).map((entry) => ({
    relativePath: entry.relativePath,
    kind: entry.kind,
    ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }),
    ...(entry.modifiedAt === undefined ? {} : { modifiedAt: entry.modifiedAt }),
    ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }),
    ...(entry.parseStatus === undefined ? {} : { parseStatus: entry.parseStatus }),
    ...(entry.problem === undefined ? {} : { problem: entry.problem }),
    origin: outputOrigin(entry.relativePath)
  }));
  return projectScanPreviewSchema.parse({
    scanId: proposal.scanId,
    displayName: proposal.suggestedName,
    sourceSha256: proposal.sourceSha256,
    fileCount: files.length,
    readableFileCount: files.filter((entry) => entry.parseStatus === 'readable').length,
    unsupportedCount: files.filter((entry) => entry.parseStatus === 'unsupported').length,
    ignoredCount: proposal.ignoredCount,
    issueCount: files.filter((entry) => entry.parseStatus === 'failed' || entry.parseStatus === 'too-large').length + proposal.issues.length,
    guidanceFiles: proposal.guidanceFiles,
    entries: publicEntries,
    issues: proposal.issues,
    expiresAt: proposal.expiresAt
  });
}

function entryToRow(projectId: string, revision: number, entry: ProjectScanEntry): readonly [string, string, string, number | null, string | null, string | null, string | null, string | null, string | null, string, number] {
  return [
    projectId,
    entry.relativePath,
    entry.kind,
    entry.bytes ?? null,
    entry.modifiedAt ?? null,
    entry.sha256 ?? null,
    entry.parseStatus ?? null,
    entry.problem ?? null,
    entry.content?.slice(0, MAX_CONTENT_CHARACTERS) ?? null,
    outputOrigin(entry.relativePath),
    revision
  ];
}

async function canonicalBoundRoot(root: string): Promise<string> {
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink()) throw coded('PROJECT_ROOT_RECONNECT_REQUIRED', 'Project root became a symbolic link');
    if (!info.isDirectory()) throw coded('PROJECT_ROOT_RECONNECT_REQUIRED', 'Project root is no longer a directory');
    const canonical = await realpath(root);
    if (canonical !== root) throw coded('PROJECT_ROOT_RECONNECT_REQUIRED', 'Project root was replaced');
    return canonical;
  } catch (error) {
    if (isCoded(error, 'PROJECT_ROOT_RECONNECT_REQUIRED')) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') throw coded('PROJECT_ROOT_RECONNECT_REQUIRED', 'Project root is unavailable', error);
    throw error;
  }
}

async function canonicalProposalRoot(root: string, protectedRootPaths: readonly string[]): Promise<string> {
  try {
    return await canonicalProjectRoot(root, { protectedRoots: protectedRootPaths });
  } catch (error) {
    if (isCoded(error, 'PROJECT_ROOT_PROTECTED')) throw coded('PROJECT_ROOT_PROTECTED', 'Project root overlaps a protected root');
    if (isCoded(error, 'PROJECT_ROOT_RECONNECT_REQUIRED')) throw error;
    throw coded('PROJECT_ROOT_RECONNECT_REQUIRED', 'Project root is unavailable');
  }
}

export function createProjectService(input: {
  database: Database.Database;
  vaultRoot: string;
  stateRoot: string;
  now?: () => Date;
  scan?: ProjectScanFunction;
  idFactory?: () => string;
}): ProjectService & { close(): Promise<void> } {
  const database = input.database;
  const now = input.now ?? (() => new Date());
  const scan = input.scan ?? scanProjectFolder;
  const makeId = input.idFactory ?? randomUUID;
  const serialized = new Map<string, Promise<unknown>>();
  const freshness = new Map<string, number>();

  async function scanWithOptions(rootPath: string, signal?: AbortSignal): Promise<ProjectScanResult> {
    const options = { protectedRoots: protectedRoots(input.vaultRoot, input.stateRoot), ...(signal === undefined ? {} : { signal }) };
    return scan(rootPath, options);
  }

  async function scanProposalRoot(rootPath: string): Promise<ProjectScanResult> {
    try {
      return await scanWithOptions(rootPath);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as CodedError).code) : '';
      if (['PROJECT_ROOT_INVALID', 'PROJECT_ROOT_SYMLINK', 'PROJECT_ROOT_PROTECTED', 'PROJECT_ROOT_RECONNECT_REQUIRED', 'ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES'].includes(code)) {
        throw coded('PROJECT_ROOT_RECONNECT_REQUIRED', 'Project root is unavailable');
      }
      throw error;
    }
  }

  function withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = serialized.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    serialized.set(key, next);
    void next.then(
      () => { if (serialized.get(key) === next) serialized.delete(key); },
      () => { if (serialized.get(key) === next) serialized.delete(key); }
    );
    return next;
  }

  async function scanFolder(rootPath: string, signal?: AbortSignal): Promise<ScanProposal> {
    const result = await scanWithOptions(rootPath, signal);
    const createdAt = now();
    const proposal: ScanProposal = {
      ...result,
      scanId: makeId(),
      expiresAt: dateText(new Date(createdAt.getTime() + SCAN_TTL_MS)),
      guidanceFiles: guidanceFiles(result.entries)
    };
    database.prepare(`
      INSERT INTO personal_project_scan_runs (id, project_id, root_path, source_sha256, state, proposal_json, created_at, updated_at)
      VALUES (?, NULL, ?, ?, 'proposed', ?, ?, ?)
    `).run(proposal.scanId, proposal.sourceRoot, proposal.sourceSha256, JSON.stringify(proposal), dateText(createdAt), dateText(createdAt));
    return proposal;
  }

  async function scanPublic(rootPath: string, signal?: AbortSignal): Promise<ProjectScanPreview> {
    return previewFromProposal(await scanFolder(rootPath, signal));
  }

  function assertAvailableScan(row: ScanRow, proposal: ScanProposal, sourceSha256: string): void {
    if (row.state !== 'proposed' || row.project_id !== null) throw coded('PROJECT_SCAN_ALREADY_USED', 'Project scan proposal is no longer available');
    if (isExpired(proposal, now())) throw coded('PROJECT_SCAN_EXPIRED', 'Project scan proposal has expired');
    if (sourceSha256 !== row.source_sha256 || sourceSha256 !== proposal.sourceSha256) throw coded('PROJECT_SCAN_HASH_MISMATCH', 'Project scan hash does not match');
  }

  function assertNoOverlap(root: string, excludeId?: string): void {
    const rows = database.prepare('SELECT id, root_path FROM personal_projects').all() as Array<{ id: string; root_path: string }>;
    for (const existing of rows) {
      if (existing.id === excludeId) continue;
      if (contained(existing.root_path, root) || contained(root, existing.root_path)) throw coded('PROJECT_ROOT_OVERLAP', 'Project root overlaps an existing project');
    }
  }

  function insertIndex(projectId: string, revision: number, entries: readonly ProjectScanEntry[]): void {
    const insert = database.prepare(`
      INSERT INTO personal_project_files
        (project_id, relative_path, kind, bytes, modified_at, sha256, parse_status, parse_problem, content_text, origin, indexed_revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of entries) {
      insert.run(...entryToRow(projectId, revision, entry));
    }
  }

  function markScanConfirmed(scanId: string, projectId: string, timestamp: string): void {
    database.prepare("UPDATE personal_project_scan_runs SET project_id = ?, state = 'confirmed', updated_at = ? WHERE id = ?").run(projectId, timestamp, scanId);
  }

  async function bind(scanId: string, bindInput: { sourceSha256: string; displayName?: string }): Promise<ProjectSummary> {
    return withLock('projects', async () => {
      const row = scanRowOrThrow(database, scanId);
      const proposal = parseScan(row);
      assertAvailableScan(row, proposal, bindInput.sourceSha256);
      const root = await canonicalProposalRoot(proposal.sourceRoot, protectedRoots(input.vaultRoot, input.stateRoot));
      if (root !== proposal.sourceRoot) throw coded('PROJECT_ROOT_CHANGED', 'Project root changed since scan');
      const rescanned = await scanProposalRoot(proposal.sourceRoot);
      if (rescanned.sourceSha256 !== proposal.sourceSha256) throw coded('PROJECT_SCAN_HASH_MISMATCH', 'Project source changed since scan');
      const timestamp = dateText(now());
      const id = makeId();
      const displayName = bindInput.displayName?.trim() || proposal.suggestedName || basename(root);
      const transaction = database.transaction(() => {
        assertNoOverlap(root);
        database.prepare(`
          INSERT INTO personal_projects
            (id, root_path, display_name, source_revision, source_sha256, availability, output_root, write_policy, created_at, updated_at, last_scanned_at)
          VALUES (?, ?, ?, 1, ?, 'ready', 'AI工作区', 'new-output-confirmed', ?, ?, ?)
        `).run(id, root, displayName, proposal.sourceSha256, timestamp, timestamp, timestamp);
        insertIndex(id, 1, rescanned.entries);
        markScanConfirmed(scanId, id, timestamp);
      });
      transaction.immediate();
      return projectSummary(rowOrThrow(database, id), database);
    });
  }

  async function setRefreshFailure(row: ProjectRow, availability: ProjectRow['availability'], error: unknown): Promise<ProjectSummary> {
    const timestamp = dateText(now());
    database.transaction(() => {
      database.prepare('UPDATE personal_projects SET availability = ?, updated_at = ? WHERE id = ?').run(availability, timestamp, row.id);
      database.prepare(`INSERT INTO personal_project_operations
        (id, project_id, plan_id, event_type, target_path, old_sha256, new_sha256, payload_json, created_at)
        VALUES (?, ?, NULL, 'project-refresh', '__refresh__', NULL, NULL, ?, ?)`)
        .run(makeId(), row.id, JSON.stringify({ status: 'failed', code: error instanceof Error && 'code' in error ? (error as CodedError).code : 'PROJECT_REFRESH_FAILED' }), timestamp);
    }).immediate();
    return projectSummary(rowOrThrow(database, row.id), database);
  }

  async function refreshUnlocked(id: string, signal?: AbortSignal): Promise<ProjectSummary> {
    const row = rowOrThrow(database, id);
    let root: string;
    try {
      root = await canonicalBoundRoot(row.root_path);
      if (root !== row.root_path) throw coded('PROJECT_ROOT_RECONNECT_REQUIRED', 'Project root identity changed');
    } catch (error) {
      return setRefreshFailure(row, 'reconnect-required', error);
    }
    let result: ProjectScanResult;
    try {
      result = await scanWithOptions(root, signal);
    } catch (error) {
      if (isCoded(error, 'PROJECT_ROOT_SYMLINK') || isCoded(error, 'PROJECT_ROOT_INVALID') || isCoded(error, 'PROJECT_ROOT_PROTECTED') || isCoded(error, 'PROJECT_SOURCE_CHANGED') || isCoded(error, 'PROJECT_ROOT_RECONNECT_REQUIRED')) {
        return setRefreshFailure(row, isCoded(error, 'PROJECT_SOURCE_CHANGED') ? 'unavailable' : 'reconnect-required', error);
      }
      return setRefreshFailure(row, 'unavailable', error);
    }
    const revision = row.source_revision + 1;
    const timestamp = dateText(now());
    const transaction = database.transaction(() => {
      database.prepare('DELETE FROM personal_project_files WHERE project_id = ?').run(id);
      insertIndex(id, revision, result.entries);
      database.prepare(`UPDATE personal_projects SET source_revision = ?, source_sha256 = ?, availability = 'ready', updated_at = ?, last_scanned_at = ? WHERE id = ?`)
        .run(revision, result.sourceSha256, timestamp, timestamp, id);
      database.prepare(`INSERT INTO personal_project_operations
        (id, project_id, plan_id, event_type, target_path, old_sha256, new_sha256, payload_json, created_at)
        VALUES (?, ?, NULL, 'project-refresh', '__refresh__', ?, ?, ?, ?)`)
        .run(makeId(), id, row.source_sha256, result.sourceSha256, JSON.stringify({ status: 'completed', revision }), timestamp);
    });
    transaction.immediate();
    return projectSummary(rowOrThrow(database, id), database);
  }

  async function refresh(id: string, signal?: AbortSignal): Promise<ProjectSummary> {
    freshness.set(id, now().getTime());
    return withLock(`project:${id}`, () => refreshUnlocked(id, signal));
  }

  async function ensureFresh(id: string, signal?: AbortSignal): Promise<ProjectSummary> {
    return withLock(`project:${id}`, async () => {
      const timestamp = now().getTime();
      const last = freshness.get(id) ?? 0;
      if (timestamp - last < FRESHNESS_TTL_MS) return projectSummary(rowOrThrow(database, id), database);
      freshness.set(id, timestamp);
      return refreshUnlocked(id, signal);
    });
  }

  async function reconnect(id: string, scanId: string, reconnectInput: { sourceSha256: string; displayName?: string }): Promise<ProjectSummary> {
    return withLock('projects', async () => {
      const project = rowOrThrow(database, id);
      const row = scanRowOrThrow(database, scanId);
      const proposal = parseScan(row);
      assertAvailableScan(row, proposal, reconnectInput.sourceSha256);
      const root = await canonicalProposalRoot(proposal.sourceRoot, protectedRoots(input.vaultRoot, input.stateRoot));
      const rescanned = await scanProposalRoot(root);
      if (rescanned.sourceSha256 !== proposal.sourceSha256) throw coded('PROJECT_SCAN_HASH_MISMATCH', 'Project source changed since scan');
      const revision = project.source_revision + 1;
      const timestamp = dateText(now());
      const transaction = database.transaction(() => {
        assertNoOverlap(root, id);
        database.prepare(`UPDATE personal_projects SET root_path = ?, display_name = ?, source_revision = ?, source_sha256 = ?, availability = 'ready', updated_at = ?, last_scanned_at = ? WHERE id = ?`)
          .run(root, reconnectInput.displayName?.trim() || project.display_name, revision, rescanned.sourceSha256, timestamp, timestamp, id);
        database.prepare('DELETE FROM personal_project_files WHERE project_id = ?').run(id);
        insertIndex(id, revision, rescanned.entries);
        database.prepare("UPDATE personal_project_write_plans SET status = 'stale', updated_at = ? WHERE project_id = ? AND status IN ('pending', 'running')").run(timestamp, id);
        database.prepare(`INSERT INTO personal_project_operations
          (id, project_id, plan_id, event_type, target_path, old_sha256, new_sha256, payload_json, created_at)
          VALUES (?, ?, NULL, 'project-reconnect', '__root__', ?, ?, ?, ?)`)
          .run(makeId(), id, project.source_sha256, rescanned.sourceSha256, JSON.stringify({ status: 'completed', revision }), timestamp);
        markScanConfirmed(scanId, id, timestamp);
      });
      transaction.immediate();
      return projectSummary(rowOrThrow(database, id), database);
    });
  }

  async function list(): Promise<readonly ProjectSummary[]> {
    return (database.prepare('SELECT * FROM personal_projects ORDER BY created_at ASC, id ASC').all() as ProjectRow[]).map((row) => projectSummary(row, database));
  }

  async function get(id: string): Promise<ProjectSummary> {
    return projectSummary(rowOrThrow(database, id), database);
  }

  async function listFiles(id: string, query: { search?: string; origin?: 'source' | 'output'; limit?: number }): Promise<ProjectFilePage> {
    const project = rowOrThrow(database, id);
    const limit = Math.min(200, Math.max(1, Math.trunc(query.limit ?? 50)));
    const tokens = (query.search ?? '').trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    const rows = database.prepare(`SELECT * FROM personal_project_files WHERE project_id = ?${query.origin === undefined ? '' : ' AND origin = ?'} ORDER BY relative_path ASC`)
      .all(...(query.origin === undefined ? [id] : [id, query.origin])) as FileRow[];
    const matched = rows.filter((row) => {
      if (tokens.length === 0) return true;
      const haystack = `${row.relative_path}\n${row.content_text ?? ''}`.toLocaleLowerCase();
      return tokens.every((token) => haystack.includes(token));
    });
    matched.sort((a, b) => {
      const score = (row: FileRow) => tokens.reduce((total, token) => total + (row.relative_path.toLocaleLowerCase().includes(token) ? 2 : 0) + (row.content_text?.toLocaleLowerCase().includes(token) ? 1 : 0), 0);
      return score(b) - score(a) || a.relative_path.localeCompare(b.relative_path);
    });
    return projectFilePageSchema.parse({ items: matched.slice(0, limit).map(publicFile), total: matched.length, revision: project.source_revision });
  }

  async function readFileForProject(id: string, relativePath: string): Promise<ProjectFileDetail> {
    const project = rowOrThrow(database, id);
    const row = database.prepare('SELECT * FROM personal_project_files WHERE project_id = ? AND relative_path = ?').get(id, relativePath) as FileRow | undefined;
    if (row === undefined) throw coded('PROJECT_FILE_NOT_FOUND', 'Project file not found');
    const metadata = publicFile(row);
    if (row.parse_status !== 'readable' || row.kind !== 'file') return projectFileDetailSchema.parse(metadata);
    let absolute: string;
    try {
      absolute = resolveProjectPath(project.root_path, relativePath);
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || !info.isFile()) throw coded('PROJECT_FILE_UNAVAILABLE', 'Project file is unavailable');
      const canonicalRoot = await realpath(project.root_path);
      const canonicalFile = await realpath(absolute);
      if (!contained(canonicalRoot, canonicalFile)) throw coded('PROJECT_FILE_UNAVAILABLE', 'Project file is outside the project root');
      const handle = await open(absolute, 'r');
      try {
        const buffer = Buffer.allocUnsafe(MAX_CONTENT_CHARACTERS * 4 + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const decoded = buffer.subarray(0, bytesRead).toString('utf8');
        const content = decoded.slice(0, MAX_CONTENT_CHARACTERS);
        return projectFileDetailSchema.parse({ ...metadata, content, totalCharacters: content.length, truncated: decoded.length > MAX_CONTENT_CHARACTERS || bytesRead === buffer.length });
      } finally {
        await handle.close();
      }
    } catch (error) {
      const problem = isCoded(error, 'PROJECT_FILE_UNAVAILABLE') ? 'PROJECT_FILE_UNAVAILABLE' : 'PROJECT_FILE_CHANGED';
      return projectFileDetailSchema.parse({ ...metadata, problem });
    }
  }

  async function context(id: string): Promise<ProjectContext> {
    const summary = await get(id);
    return projectContextSchema.parse({ id: summary.id, displayName: summary.displayName, sourceRevision: summary.sourceRevision, availability: summary.availability });
  }

  return {
    scan: scanPublic,
    bind,
    reconnect,
    list,
    get,
    refresh,
    ensureFresh,
    listFiles,
    readFile: readFileForProject,
    context,
    async close(): Promise<void> { serialized.clear(); freshness.clear(); }
  };
}
