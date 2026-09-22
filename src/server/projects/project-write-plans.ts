import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, unlink, link } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { projectCategorySchema, projectWriteActionSchema, projectOperationSchema, type ProjectCategory, type ProjectOperation, type ProjectWriteAction, type ProjectWritePlanService } from '../../shared/api/projects.js';
import { resolveProjectOutputPath } from './project-paths.js';

type CodedError = Error & { code: string };
type ProjectRow = { id: string; root_path: string; display_name: string; source_revision: number; availability: string };
type PlanRow = {
  id: string; project_id: string; conversation_id: string; message_id: string; category: ProjectCategory;
  title: string; summary: string; content: string; content_sha256: string; source_revision: number;
  target_path: string; status: ProjectWriteAction['status']; created_at: string; expires_at: string;
  updated_at: string; confirm_request_id: string | null; result_path: string | null; problem: string | null;
};

const MAX_CONTENT_BYTES = 160_000;
const TTL_MS = 30 * 60 * 1000;
const SAFE_COMPONENT = /[^\p{L}\p{N} _-]+/gu;

function coded(code: string, message: string): CodedError { const error = new Error(message) as CodedError; error.code = code; return error; }
function sha256(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex'); }
function iso(date: Date): string { return date.toISOString(); }
function safeSlug(title: string): string {
  const value = title.normalize('NFKC').replace(SAFE_COMPONENT, '').replace(/\s+/gu, ' ').trim().replace(/ +/gu, '-').slice(0, 80);
  return value || '内容草稿';
}
function contained(parent: string, candidate: string): boolean {
  const value = relative(parent, candidate);
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !value.startsWith('/') && !/^[A-Za-z]:/u.test(value));
}
function rowOrThrow(database: Database.Database, id: string): ProjectRow {
  const row = database.prepare('SELECT id,root_path,display_name,source_revision,availability FROM personal_projects WHERE id = ?').get(id) as ProjectRow | undefined;
  if (!row) throw coded('PROJECT_NOT_FOUND', 'Project not found');
  return row;
}
function planRow(database: Database.Database, id: string, conversationId?: string): PlanRow {
  const row = database.prepare('SELECT * FROM personal_project_write_plans WHERE id = ?').get(id) as PlanRow | undefined;
  if (!row || (conversationId !== undefined && row.conversation_id !== conversationId)) throw coded('PROJECT_WRITE_PLAN_NOT_FOUND', 'Project write plan not found');
  return row;
}
function ensureRelativeTarget(value: string): void {
  if (!value.startsWith('AI工作区/') || value.includes('\\') || value.includes('\0') || value.split('/').some(segment => !segment || segment === '.' || segment === '..')) throw coded('PROJECT_PATH_INVALID', 'Project output path is invalid');
}
function publicAction(database: Database.Database, row: PlanRow): ProjectWriteAction {
  const project = rowOrThrow(database, row.project_id);
  ensureRelativeTarget(row.target_path);
  return projectWriteActionSchema.parse({
    id: row.id, type: 'project-write', label: `保存到${row.category}`, status: row.status,
    projectId: row.project_id, projectName: project.display_name, category: row.category,
    targetPath: row.target_path, contentSha256: row.content_sha256, sourceRevision: row.source_revision,
    summary: row.summary, createdAt: row.created_at, expiresAt: row.expires_at,
    ...(row.result_path === null ? {} : { resultPath: row.result_path }),
    ...(row.problem === null ? {} : { problem: row.problem })
  });
}
async function assertNoSymlinkParents(root: string, targetDirectory: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) throw coded('PROJECT_ROOT_RECONNECT_REQUIRED', 'Project root identity changed');
  const target = targetDirectory;
  if (!contained(canonicalRoot, target)) throw coded('PROJECT_PATH_INVALID', 'Project output path escapes the project root');
  const segments = relative(canonicalRoot, target).split(sep).filter(Boolean);
  let current = canonicalRoot;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw coded('PROJECT_OUTPUT_UNAVAILABLE', 'Project output directory is unavailable');
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as CodedError).code) : '';
      if (code === 'ENOENT') { await mkdir(current, { mode: 0o700 }); continue; }
      throw error;
    }
  }
}
async function writeExclusive(root: string, targetPath: string, content: string, id: string): Promise<void> {
  const target = resolveProjectOutputPath(root, targetPath.split('/')[1] as ProjectCategory, basename(targetPath));
  const directory = dirname(target);
  await assertNoSymlinkParents(root, directory);
  try { const info = await lstat(target); if (info.isSymbolicLink() || info.isFile() || info.isDirectory()) throw coded('PROJECT_OUTPUT_EXISTS', 'Project output already exists'); }
  catch (error) { const code = error instanceof Error && 'code' in error ? String((error as CodedError).code) : ''; if (code !== 'ENOENT') throw error; }
  const temporary = join(directory, `.xiao-project-${id}.tmp`);
  const bytes = Buffer.from(content, 'utf8');
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.write(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    // link() is atomic and fails when another writer won the target first;
    // rename() is intentionally never used to overwrite user files.
    await link(temporary, target);
    await unlink(temporary);
    const directoryHandle = await open(directory, 'r'); try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (error instanceof Error && 'code' in error && String((error as CodedError).code) === 'EEXIST') throw coded('PROJECT_OUTPUT_EXISTS', 'Project output already exists');
    throw error;
  }
}

export function createProjectWritePlanService(input: {
  database: Database.Database;
  now?: () => Date;
  idFactory?: () => string;
  ttlMs?: number;
}): ProjectWritePlanService {
  const database = input.database; const now = input.now ?? (() => new Date()); const makeId = input.idFactory ?? randomUUID; const ttl = input.ttlMs ?? TTL_MS;
  function proposeDraft(value: { projectId: string; conversationId: string; messageId: string; category: ProjectCategory; title: string; summary: string; content: string; expectedRevision: number }): Promise<ProjectWriteAction> {
    const category = projectCategorySchema.safeParse(value.category); if (!category.success) throw coded('PROJECT_CATEGORY_INVALID', 'Project output category is invalid');
    if (Buffer.byteLength(value.content, 'utf8') > MAX_CONTENT_BYTES) throw coded('PROJECT_OUTPUT_TOO_LARGE', 'Project output is too large');
    const project = rowOrThrow(database, value.projectId);
    if (project.availability !== 'ready') throw coded('PROJECT_UNAVAILABLE', 'Project is unavailable');
    if (project.source_revision !== value.expectedRevision) throw coded('PROJECT_SOURCE_STALE', 'Project source has changed');
    const created = now(); const createdAt = iso(created); const expiresAt = iso(new Date(created.getTime() + ttl));
    const targetPath = `AI工作区/${category.data}/${createdAt.slice(0, 10)}-${safeSlug(value.title)}.md`;
    const row: PlanRow = { id: makeId(), project_id: value.projectId, conversation_id: value.conversationId, message_id: value.messageId, category: category.data, title: value.title.trim().slice(0, 255), summary: value.summary.slice(0, 2000), content: value.content, content_sha256: sha256(value.content), source_revision: value.expectedRevision, target_path: targetPath, status: 'pending', created_at: createdAt, expires_at: expiresAt, updated_at: createdAt, confirm_request_id: null, result_path: null, problem: null };
    database.prepare(`INSERT INTO personal_project_write_plans
      (id, project_id, conversation_id, message_id, category, title, summary, content, content_sha256, source_revision, target_path, status, created_at, expires_at, updated_at, confirm_request_id, result_path, problem)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`).run(row.id, row.project_id, row.conversation_id, row.message_id, row.category, row.title, row.summary, row.content, row.content_sha256, row.source_revision, row.target_path, row.status, row.created_at, row.expires_at, row.updated_at);
    return Promise.resolve(publicAction(database, row));
  }
  function mark(id: string, status: PlanRow['status'], requestId: string, problem?: string, resultPath?: string): ProjectWriteAction {
    const timestamp = iso(now());
    database.prepare(`UPDATE personal_project_write_plans SET status = ?, confirm_request_id = ?, problem = ?, result_path = ?, updated_at = ? WHERE id = ?`).run(status, requestId, problem ?? null, resultPath ?? null, timestamp, id);
    return publicAction(database, planRow(database, id));
  }
  async function confirm(planId: string, conversationId: string, clientRequestId: string): Promise<ProjectWriteAction> {
    let plan = planRow(database, planId, conversationId);
    if (plan.confirm_request_id !== null) { if (plan.confirm_request_id === clientRequestId) return publicAction(database, plan); throw coded('PROJECT_WRITE_PLAN_RESOLVED', 'Project write plan already resolved'); }
    if (plan.status !== 'pending') throw coded('PROJECT_WRITE_PLAN_RESOLVED', 'Project write plan already resolved');
    const project = rowOrThrow(database, plan.project_id);
    if (Date.parse(plan.expires_at) <= now().getTime() || project.availability !== 'ready' || project.source_revision !== plan.source_revision) {
      return mark(plan.id, 'stale', clientRequestId, '项目内容已变化，计划已失效');
    }
    database.prepare('UPDATE personal_project_write_plans SET status = \'running\', confirm_request_id = ?, updated_at = ? WHERE id = ? AND status = \'pending\'').run(clientRequestId, iso(now()), plan.id);
    plan = planRow(database, plan.id, conversationId);
    try {
      await writeExclusive(project.root_path, plan.target_path, plan.content, plan.id);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as CodedError).code) : 'PROJECT_OUTPUT_WRITE_FAILED';
      if (code === 'PROJECT_OUTPUT_EXISTS') {
        database.prepare(`UPDATE personal_project_write_plans SET status = 'stale', problem = ?, updated_at = ? WHERE id = ?`).run('目标文件已存在，未覆盖', iso(now()), plan.id);
        database.prepare(`INSERT INTO personal_project_operations (id, project_id, plan_id, event_type, target_path, old_sha256, new_sha256, payload_json, created_at) VALUES (?, ?, ?, 'project-write', ?, NULL, NULL, ?, ?)`).run(makeId(), plan.project_id, plan.id, plan.target_path, JSON.stringify({ status: 'stale', code }), iso(now()));
        throw coded(code, 'Project output already exists');
      }
      const problem = '项目输出写入未完成，已保留恢复记录';
      database.prepare(`UPDATE personal_project_write_plans SET status = 'failed', problem = ?, updated_at = ? WHERE id = ?`).run(problem, iso(now()), plan.id);
      database.prepare(`INSERT INTO personal_project_operations (id, project_id, plan_id, event_type, target_path, old_sha256, new_sha256, payload_json, created_at) VALUES (?, ?, ?, 'project-write', ?, NULL, NULL, ?, ?)`).run(makeId(), plan.project_id, plan.id, plan.target_path, JSON.stringify({ status: 'failed', code }), iso(now()));
      throw coded('PROJECT_OUTPUT_WRITE_FAILED', problem);
    }
    const bytes = Buffer.from(plan.content, 'utf8'); const digest = sha256(bytes); const timestamp = iso(now());
    const transaction = database.transaction(() => {
      const changed = database.prepare(`UPDATE personal_project_write_plans SET status = 'completed', result_path = target_path, problem = NULL, updated_at = ? WHERE id = ? AND status = 'running'`).run(timestamp, plan.id);
      if (changed.changes !== 1) throw coded('PROJECT_WRITE_PLAN_RESOLVED', 'Project write plan already resolved');
      database.prepare(`INSERT INTO personal_project_operations (id, project_id, plan_id, event_type, target_path, old_sha256, new_sha256, payload_json, created_at) VALUES (?, ?, ?, 'project-write', ?, NULL, ?, ?, ?)`).run(makeId(), plan.project_id, plan.id, plan.target_path, digest, JSON.stringify({ status: 'completed', sourceRevision: plan.source_revision }), timestamp);
    });
    transaction.immediate();
    return publicAction(database, planRow(database, plan.id, conversationId));
  }
  function cancel(planId: string, conversationId: string, clientRequestId: string): ProjectWriteAction {
    const plan = planRow(database, planId, conversationId);
    if (plan.confirm_request_id !== null) { if (plan.confirm_request_id === clientRequestId) return publicAction(database, plan); throw coded('PROJECT_WRITE_PLAN_RESOLVED', 'Project write plan already resolved'); }
    if (plan.status !== 'pending') throw coded('PROJECT_WRITE_PLAN_RESOLVED', 'Project write plan already resolved');
    return mark(plan.id, 'cancelled', clientRequestId);
  }
  async function confirmForProject(planId: string, projectId: string, clientRequestId: string): Promise<ProjectWriteAction> {
    const plan = planRow(database, planId);
    if (plan.project_id !== projectId) throw coded('PROJECT_WRITE_PLAN_PROJECT_MISMATCH', 'Project write plan does not belong to this project');
    return confirm(planId, plan.conversation_id, clientRequestId);
  }
  function cancelForProject(planId: string, projectId: string, clientRequestId: string): ProjectWriteAction {
    const plan = planRow(database, planId);
    if (plan.project_id !== projectId) throw coded('PROJECT_WRITE_PLAN_PROJECT_MISMATCH', 'Project write plan does not belong to this project');
    return cancel(planId, plan.conversation_id, clientRequestId);
  }
  function project(planId: string, conversationId?: string): ProjectWriteAction | undefined { try { return publicAction(database, planRow(database, planId, conversationId)); } catch (error) { if (error instanceof Error && 'code' in error && String((error as CodedError).code) === 'PROJECT_WRITE_PLAN_NOT_FOUND') return undefined; throw error; } }
  async function operations(projectId: string): Promise<readonly ProjectOperation[]> {
    rowOrThrow(database, projectId);
    const rows = database.prepare('SELECT id,project_id,event_type,target_path,old_sha256,new_sha256,created_at,payload_json FROM personal_project_operations WHERE project_id = ? ORDER BY created_at DESC, rowid DESC').all(projectId) as Array<{ id: string; project_id: string; event_type: string; target_path: string; old_sha256: string | null; new_sha256: string | null; created_at: string; payload_json: string }>;
    return rows.map(row => { let status: ProjectOperation['status'] = 'completed'; try { const parsed = JSON.parse(row.payload_json) as { status?: string }; if (parsed.status === 'failed' || parsed.status === 'stale') status = parsed.status; } catch { status = 'failed'; } return projectOperationSchema.parse({ id: row.id, projectId: row.project_id, eventType: row.event_type, targetPath: row.target_path, ...(row.old_sha256 === null ? {} : { oldSha256: row.old_sha256 }), ...(row.new_sha256 === null ? {} : { newSha256: row.new_sha256 }), createdAt: row.created_at, status }); });
  }
  return { proposeDraft, confirm, cancel, confirmForProject, cancelForProject, project, operations };
}
