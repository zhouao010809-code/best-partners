import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import { stringify } from 'yaml';
import { PublicApiError } from '../../shared/api/errors.js';
import type { CompanyProjectConfig } from '../../shared/company/project.js';
import {
  assertCompanyRelativePath
} from './company-paths.js';
import {
  scanProjectFolder,
  stageProjectSource,
  type ProjectScanProposal,
  type StageProjectSourceOptions
} from './project-ingestion.js';

const PROJECT_STATUSES = ['active', 'acceptance', 'draft', 'paused', 'completed', 'archived'] as const;
type ProjectStatus = CompanyProjectConfig['status'];

export interface CompanyProjectWorkspace {
  readonly id: string;
  readonly rootPath: string;
  readonly incomingPath: string;
  readonly projectsPath: string;
  readonly skillsPath?: string;
  readonly systemPath?: string;
}

export interface ProjectServiceOptions {
  readonly database: Database.Database;
  readonly workspace: CompanyProjectWorkspace;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly operationIdFactory?: () => string;
  readonly scanProjectFolder?: typeof scanProjectFolder;
  readonly stageProjectSource?: (options: StageProjectSourceOptions) => ReturnType<typeof stageProjectSource>;
  /** A testable interruption point before files are published. */
  readonly beforeConfirm?: (input: { readonly runId: string; readonly projectId: string }) => void | Promise<void>;
  readonly refreshIndex?: () => void | Promise<void>;
}

export interface ProjectScanInput {
  readonly sourceRoot: string;
  readonly actorId?: string;
}

export interface ProjectConfirmInput {
  readonly sourceSha256: string;
  readonly name: string;
  readonly clientName?: string;
  readonly status: 'draft' | 'active';
  readonly serviceStart?: string;
  readonly serviceEnd?: string;
  readonly selectedSkillIds?: readonly string[];
  readonly actorId?: string;
}

export interface ProjectRunProjection {
  readonly id: string;
  readonly projectId: string;
  readonly sourceSha256: string;
  readonly state: 'scanning' | 'proposed' | 'confirmed' | 'failed' | 'superseded';
  readonly proposal: ProjectScanProposal;
  readonly operationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CompanyProjectProjection {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly clientName?: string;
  readonly status: ProjectStatus;
  readonly projectRoot: string;
  readonly sourceRoot: string;
  readonly configSha256: string;
  readonly confidence: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dataCoverage: 'not_configured';
}

export interface ProjectScanResult {
  readonly reused: boolean;
  readonly run: ProjectRunProjection;
  readonly project: CompanyProjectProjection;
  readonly proposal: ProjectScanProposal;
}

export interface ProjectConfirmResult {
  readonly project: CompanyProjectProjection;
  readonly run: ProjectRunProjection;
  readonly operationId: string;
}

export interface ProjectService {
  scan(input: ProjectScanInput): Promise<ProjectScanResult>;
  getDraft(runId: string): Promise<{ readonly run: ProjectRunProjection; readonly project: CompanyProjectProjection }>;
  confirm(runId: string, input: ProjectConfirmInput): Promise<ProjectConfirmResult>;
  list(): Promise<readonly CompanyProjectProjection[]>;
  get(projectId: string): Promise<CompanyProjectProjection>;
}

interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  client_name: string | null;
  status: ProjectStatus;
  project_root: string;
  source_root: string;
  config_sha256: string;
  confidence_json: string;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  project_id: string | null;
  source_sha256: string;
  state: ProjectRunProjection['state'];
  proposal_json: string;
  operation_id: string;
  created_at: string;
  updated_at: string;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseProposal(value: string): ProjectScanProposal {
  const proposal = JSON.parse(value) as ProjectScanProposal;
  if (
    proposal === null
    || typeof proposal !== 'object'
    || typeof proposal.sourceRoot !== 'string'
    || typeof proposal.sourceSha256 !== 'string'
    || typeof proposal.suggestedName !== 'string'
    || !Array.isArray(proposal.entries)
  ) {
    throw new Error('Stored company project proposal is invalid');
  }
  return proposal;
}

function parseConfidence(value: string): Readonly<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Readonly<Record<string, unknown>>
      : {};
  } catch {
    return {};
  }
}

function projection(row: ProjectRow): CompanyProjectProjection {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    ...(row.client_name === null ? {} : { clientName: row.client_name }),
    status: row.status,
    projectRoot: row.project_root,
    sourceRoot: row.source_root,
    configSha256: row.config_sha256,
    confidence: parseConfidence(row.confidence_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dataCoverage: 'not_configured'
  };
}

function runProjection(row: RunRow): ProjectRunProjection {
  return {
    id: row.id,
    projectId: row.project_id ?? '',
    sourceSha256: row.source_sha256,
    state: row.state,
    proposal: parseProposal(row.proposal_json),
    operationId: row.operation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function fail(code: string, message: string, statusCode = 400): never {
  throw new PublicApiError(code, message, statusCode);
}

function assertStatus(value: string): asserts value is 'draft' | 'active' {
  if (value !== 'draft' && value !== 'active') fail('COMPANY_INVALID_PROJECT_STATUS', 'Project status must be draft or active');
}

function assertName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > 200 || name.includes('\0') || name.includes('/') || name.includes('\\')) {
    fail('COMPANY_PROJECT_NAME_INVALID', 'Project name is invalid');
  }
  return name;
}

function assertId(value: string, label: string): string {
  try {
    const normalized = assertCompanyRelativePath(value);
    if (normalized.includes('/')) throw new Error('nested');
    return normalized;
  } catch {
    fail(`COMPANY_${label.toUpperCase()}_INVALID`, `${label} is invalid`);
  }
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a directory`);
}

async function writeAtomic(path: string, bytes: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${ulid()}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function copyStagedTree(stagingRoot: string, targetRoot: string, proposal: ProjectScanProposal): Promise<void> {
  await assertDirectory(stagingRoot, 'Staging root');
  const rawRoot = join(targetRoot, 'raw');
  await mkdir(rawRoot, { recursive: false, mode: 0o700 });
  for (const entry of proposal.entries) {
    const source = join(stagingRoot, ...entry.relativePath.split('/'));
    const target = join(rawRoot, ...entry.relativePath.split('/'));
    const sourceInfo = await lstat(source);
    if (sourceInfo.isSymbolicLink()) throw new Error(`Staged source contains a symlink: ${entry.relativePath}`);
    if (entry.kind === 'directory') {
      if (!sourceInfo.isDirectory()) throw new Error(`Staged source changed type: ${entry.relativePath}`);
      await mkdir(target, { recursive: false, mode: 0o700 });
      continue;
    }
    if (!sourceInfo.isFile()) throw new Error(`Staged source changed type: ${entry.relativePath}`);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const parentInfo = await lstat(dirname(target));
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error(`Unsafe staged parent: ${entry.relativePath}`);
    const temporary = `${target}.${ulid()}.tmp`;
    try {
      await copyFile(source, temporary);
      const copied = await readFile(temporary);
      if (entry.sha256 !== undefined && sha256(copied) !== entry.sha256) throw new Error(`Staged bytes changed: ${entry.relativePath}`);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  const manifestSource = join(stagingRoot, 'source-manifest.json');
  const manifestInfo = await lstat(manifestSource);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) throw new Error('Missing source manifest');
  await writeAtomic(join(targetRoot, 'source-manifest.json'), await readFile(manifestSource));
}

/** A prior publish may have committed files before the SQLite transaction. */
async function isCompletePublishedTree(root: string, proposal: ProjectScanProposal): Promise<boolean> {
  try {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return false;
    for (const required of ['项目配置.yaml', '项目说明.md', 'source-manifest.json']) {
      const info = await lstat(join(root, required));
      if (!info.isFile() || info.isSymbolicLink()) return false;
    }
    const manifest = JSON.parse(await readFile(join(root, 'source-manifest.json'), 'utf8')) as {
      sourceSha256?: unknown;
      entries?: unknown;
    };
    if (manifest.sourceSha256 !== proposal.sourceSha256 || !Array.isArray(manifest.entries)) return false;
    for (const entry of proposal.entries) {
      const info = await lstat(join(root, 'raw', ...entry.relativePath.split('/')));
      if (entry.kind === 'directory') {
        if (!info.isDirectory() || info.isSymbolicLink()) return false;
      } else if (!info.isFile() || info.isSymbolicLink()) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function projectConfig(input: {
  project: ProjectRow;
  name: string;
  clientName?: string;
  status: 'draft' | 'active';
  sourceRoot: string;
  projectRoot: string;
  selectedSkillIds: readonly string[];
  serviceStart?: string;
  serviceEnd?: string;
  now: string;
}): CompanyProjectConfig {
  return {
    id: input.project.id,
    ...(input.clientName === undefined ? {} : { clientName: input.clientName }),
    name: input.name,
    status: input.status,
    ...(input.serviceStart === undefined ? {} : { serviceStart: input.serviceStart }),
    ...(input.serviceEnd === undefined ? {} : { serviceEnd: input.serviceEnd }),
    sourceRoot: input.sourceRoot,
    projectRoot: input.projectRoot,
    selectedSkillIds: [...input.selectedSkillIds],
    platformAccountRefs: [],
    createdAt: input.project.created_at,
    updatedAt: input.now
  };
}

export function createProjectService(options: ProjectServiceOptions): ProjectService {
  const now = options.now ?? (() => new Date());
  const makeId = options.idFactory ?? ulid;
  const makeOperationId = options.operationIdFactory ?? ulid;
  const scan = options.scanProjectFolder ?? scanProjectFolder;
  const stage = options.stageProjectSource ?? stageProjectSource;

  options.database.prepare(`
    INSERT INTO company_workspaces (id, display_name, root_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET root_path = excluded.root_path, updated_at = excluded.updated_at
  `).run(options.workspace.id, 'Company workspace', options.workspace.rootPath, now().toISOString(), now().toISOString());

  const findProject = options.database.prepare('SELECT * FROM company_projects WHERE id = ? AND workspace_id = ?');
  const findRun = options.database.prepare('SELECT * FROM company_project_ingestion_runs WHERE id = ?');

  async function readProject(projectId: string): Promise<CompanyProjectProjection> {
    const row = findProject.get(projectId, options.workspace.id) as ProjectRow | undefined;
    if (row === undefined) fail('COMPANY_PROJECT_NOT_FOUND', 'Project not found', 404);
    return projection(row);
  }

  async function readRun(runId: string): Promise<{ row: RunRow; project: CompanyProjectProjection }> {
    const row = findRun.get(runId) as RunRow | undefined;
    if (row === undefined || row.project_id === null) fail('COMPANY_PROJECT_DRAFT_NOT_FOUND', 'Project draft not found', 404);
    return { row, project: await readProject(row.project_id) };
  }

  async function scanSource(input: ProjectScanInput): Promise<ProjectScanResult> {
    const proposal = await scan(input.sourceRoot);
    const open = options.database.prepare(`
      SELECT * FROM company_project_ingestion_runs
      WHERE source_sha256 = ? AND state IN ('scanning', 'proposed')
      ORDER BY created_at ASC, id ASC LIMIT 1
    `).get(proposal.sourceSha256) as RunRow | undefined;
    if (open !== undefined && open.project_id !== null) {
      return { reused: true, run: runProjection(open), project: await readProject(open.project_id), proposal: parseProposal(open.proposal_json) };
    }

    const runId = makeId();
    const projectId = makeId();
    const operationId = makeOperationId();
    const timestamp = now().toISOString();
    const staged = await stage({
      sourceRoot: input.sourceRoot,
      incomingRoot: options.workspace.incomingPath,
      runId
    });
    const stagedProposal = staged.proposal;
    const projectRoot = join(options.workspace.projectsPath, assertId(projectId, 'project_id'));
    const transaction = options.database.transaction(() => {
      options.database.prepare(`
        INSERT INTO company_projects (
          id, workspace_id, name, client_name, status, project_root, source_root,
          config_sha256, confidence_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)
      `).run(
        projectId,
        options.workspace.id,
        stagedProposal.suggestedName,
        stagedProposal.suggestedClientName ?? null,
        projectRoot,
        stagedProposal.sourceRoot,
        stagedProposal.sourceSha256,
        safeJson(stagedProposal.fields),
        timestamp,
        timestamp
      );
      options.database.prepare(`
        INSERT INTO company_project_ingestion_runs (
          id, project_id, source_sha256, state, proposal_json, operation_id, created_at, updated_at
        ) VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?)
      `).run(runId, projectId, stagedProposal.sourceSha256, safeJson(stagedProposal), operationId, timestamp, timestamp);
      return undefined;
    });
    try {
      transaction.immediate();
    } catch (error) {
      await rm(staged.stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      if (hasCode(error, 'SQLITE_CONSTRAINT_UNIQUE')) {
        const existing = options.database.prepare(`
          SELECT * FROM company_project_ingestion_runs
          WHERE source_sha256 = ? AND state IN ('scanning', 'proposed')
          ORDER BY created_at ASC, id ASC LIMIT 1
        `).get(stagedProposal.sourceSha256) as RunRow | undefined;
        if (existing?.project_id !== null && existing !== undefined) {
          return { reused: true, run: runProjection(existing), project: await readProject(existing.project_id), proposal: parseProposal(existing.proposal_json) };
        }
      }
      throw error;
    }
    const run = findRun.get(runId) as RunRow;
    const project = findProject.get(projectId, options.workspace.id) as ProjectRow;
    return { reused: false, run: runProjection(run), project: projection(project), proposal: stagedProposal };
  }

  async function getDraft(runIdInput: string): Promise<{ readonly run: ProjectRunProjection; readonly project: CompanyProjectProjection }> {
    const runId = assertId(runIdInput, 'run_id');
    const result = await readRun(runId);
    return { run: runProjection(result.row), project: result.project };
  }

  async function confirmProject(runIdInput: string, input: ProjectConfirmInput): Promise<ProjectConfirmResult> {
    const runId = assertId(runIdInput, 'run_id');
    const loaded = await readRun(runId);
    const run = loaded.row;
    if (run.state === 'confirmed') {
      const operationId = makeOperationId();
      return { project: loaded.project, run: runProjection(run), operationId };
    }
    if (run.state !== 'proposed') fail('COMPANY_PROJECT_DRAFT_NOT_RESUMABLE', 'Project draft is not resumable', 409);
    assertStatus(input.status);
    const name = assertName(input.name);
    if (input.sourceSha256 !== run.source_sha256) fail('COMPANY_SOURCE_HASH_MISMATCH', 'Source hash does not match proposal');
    const refreshed = await scan(runProjection(run).proposal.sourceRoot);
    if (refreshed.sourceSha256 !== run.source_sha256) fail('COMPANY_SOURCE_CHANGED', 'Source changed after proposal', 409);

    const projectId = assertId(run.project_id!, 'project_id');
    const stagingRoot = join(options.workspace.incomingPath, runId);
    try {
      await assertDirectory(stagingRoot, 'Project staging');
    } catch {
      const restaged = await stage({ sourceRoot: refreshed.sourceRoot, incomingRoot: options.workspace.incomingPath, runId });
      if (restaged.proposal.sourceSha256 !== run.source_sha256) fail('COMPANY_SOURCE_CHANGED', 'Source changed after proposal', 409);
    }
    await options.beforeConfirm?.({ runId, projectId });

    const finalRoot = join(options.workspace.projectsPath, projectId);
    const temporaryRoot = join(options.workspace.projectsPath, `.${projectId}.confirm-${makeId()}`);
    const timestamp = now().toISOString();
    const existingFinal = await lstat(finalRoot).catch(() => undefined);
    if (existingFinal?.isSymbolicLink() || (existingFinal !== undefined && !existingFinal.isDirectory())) {
      fail('COMPANY_PROJECT_ROOT_UNSAFE', 'Project destination is not a directory', 409);
    }
    let published = existingFinal !== undefined;
    if (published && !(await isCompletePublishedTree(finalRoot, runProjection(run).proposal))) {
      fail('COMPANY_PROJECT_ROOT_CONFLICT', 'Project destination already exists but is incomplete', 409);
    }
    try {
      if (!published) {
        await mkdir(temporaryRoot, { recursive: false, mode: 0o700 });
        await copyStagedTree(stagingRoot, temporaryRoot, runProjection(run).proposal);
        const previous = findProject.get(projectId, options.workspace.id) as ProjectRow;
        const config = projectConfig({
          project: previous,
          name,
          ...(input.clientName === undefined ? {} : { clientName: input.clientName }),
          status: input.status,
          sourceRoot: runProjection(run).proposal.sourceRoot,
          projectRoot: finalRoot,
          selectedSkillIds: input.selectedSkillIds ?? runProjection(run).proposal.selectedSkillIds,
          ...(input.serviceStart === undefined ? {} : { serviceStart: input.serviceStart }),
          ...(input.serviceEnd === undefined ? {} : { serviceEnd: input.serviceEnd }),
          now: timestamp
        });
        await writeAtomic(join(temporaryRoot, '项目配置.yaml'), stringify(config));
        await writeAtomic(join(temporaryRoot, '项目说明.md'), `# ${name}\n\n- 项目状态：${input.status}\n- 来源：${runProjection(run).proposal.sourceRoot}\n`);
        try {
          await rename(temporaryRoot, finalRoot);
          published = true;
        } catch (error) {
          if (!hasCode(error, 'EEXIST')) throw error;
          const finalInfo = await lstat(finalRoot);
          if (finalInfo.isSymbolicLink() || !finalInfo.isDirectory()) throw error;
          if (!(await isCompletePublishedTree(finalRoot, runProjection(run).proposal))) {
            fail('COMPANY_PROJECT_ROOT_CONFLICT', 'Project destination was claimed by another publish', 409);
          }
          published = true;
        }
      }

      const operationId = makeOperationId();
      const configBytes = await readFile(join(finalRoot, '项目配置.yaml'));
      const transaction = options.database.transaction(() => {
        const actorId = input.actorId === undefined
          ? null
          : ((options.database.prepare('SELECT id FROM company_users WHERE id = ? AND workspace_id = ?').get(input.actorId, options.workspace.id) as { id: string } | undefined)?.id ?? null);
        options.database.prepare(`
          UPDATE company_projects
          SET name = ?, client_name = ?, status = ?, project_root = ?, source_root = ?,
              config_sha256 = ?, confidence_json = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ?
        `).run(
          name,
          input.clientName ?? null,
          input.status,
          finalRoot,
          runProjection(run).proposal.sourceRoot,
          sha256(configBytes),
          safeJson(runProjection(run).proposal.fields),
          timestamp,
          projectId,
          options.workspace.id
        );
        options.database.prepare(`
          UPDATE company_project_ingestion_runs
          SET state = 'confirmed', updated_at = ?
          WHERE id = ? AND state = 'proposed'
        `).run(timestamp, runId);
        options.database.prepare(`
          INSERT INTO company_project_events (id, project_id, actor_id, operation_id, event_type, payload_json, created_at)
          VALUES (?, ?, ?, ?, 'project_confirmed', ?, ?)
        `).run(makeId(), projectId, actorId, operationId, safeJson({ runId, sourceSha256: run.source_sha256, status: input.status }), timestamp);
      });
      transaction.immediate();
      await options.refreshIndex?.();
      const updatedProject = findProject.get(projectId, options.workspace.id) as ProjectRow;
      const updatedRun = findRun.get(runId) as RunRow;
      return { project: projection(updatedProject), run: runProjection(updatedRun), operationId };
    } catch (error) {
      if (!published) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function listProjects(): Promise<readonly CompanyProjectProjection[]> {
    const rows = options.database.prepare('SELECT * FROM company_projects WHERE workspace_id = ?').all(options.workspace.id) as ProjectRow[];
    const order = new Map<string, number>(PROJECT_STATUSES.map((status, index) => [status, index]));
    return rows.sort((left, right) => {
      const statusDifference = (order.get(left.status) ?? 99) - (order.get(right.status) ?? 99);
      if (statusDifference !== 0) return statusDifference;
      const updatedDifference = right.updated_at.localeCompare(left.updated_at);
      return updatedDifference !== 0 ? updatedDifference : left.id.localeCompare(right.id);
    }).map(projection);
  }

  return {
    scan: scanSource,
    getDraft,
    confirm: confirmProject,
    list: listProjects,
    get: readProject
  } satisfies ProjectService;
}
