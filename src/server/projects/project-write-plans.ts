import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink, link } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { projectCategorySchema, projectWriteActionSchema, projectOperationSchema, type ProjectCategory, type ProjectOperation, type ProjectWriteAction, type ProjectWritePlanService } from '../../shared/api/projects.js';
import { resolveProjectOutputPath } from './project-paths.js';
import { parseAttachment } from '../attachments/parser.js';
import { withProjectLock } from './project-lock.js';

type CodedError = Error & { code: string };
type ProjectRow = { id: string; root_path: string; display_name: string; source_revision: number; availability: string };
type PlanRow = {
  id: string; project_id: string; conversation_id: string; message_id: string; category: ProjectCategory;
  title: string; summary: string; content: string; content_sha256: string; source_revision: number;
  target_path: string; status: ProjectWriteAction['status']; created_at: string; expires_at: string;
  updated_at: string; confirm_request_id: string | null; result_path: string | null; problem: string | null;
};
type Confirmation = {
  planId: string; clientRequestId: string; targetPath: string; contentSha256: string;
  sourceRevision: number; rootPath: string; rootDev: number; rootIno: number;
  ruleFingerprint?: string;
};
type OperationRow = { id: string; target_path: string; new_sha256: string | null; payload_json: string };
type FileIdentity = { dev: number; ino: number };

const MAX_CONTENT_BYTES = 160_000;
const TTL_MS = 30 * 60 * 1000;
const SAFE_COMPONENT = /[^\p{L}\p{N} _-]+/gu;
const OUTPUT_INDEX_PENDING = '文件已保存，但列表尚未更新。请点击“更新资料”后查看。';

function coded(code: string, message: string): CodedError { const error = new Error(message) as CodedError; error.code = code; return error; }
function sha256(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex'); }
function iso(date: Date): string { return date.toISOString(); }
function safeSlug(title: string): string {
  const value = title.normalize('NFKC').replace(SAFE_COMPONENT, '').replace(/\s+/gu, ' ').trim().replace(/ +/gu, '-');
  let slug = '';
  for (const character of Array.from(value).slice(0, 80)) {
    if (Buffer.byteLength(slug + character, 'utf8') > 204) break;
    slug += character;
  }
  return slug || '内容草稿';
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
async function assertNoSymlinkParents(root: string, targetDirectory: string, createMissing = true): Promise<void> {
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
      if (code === 'ENOENT' && createMissing) { await mkdir(current, { mode: 0o700 }); continue; }
      throw error;
    }
  }
}
async function readSafeOutput(root: string, target: string): Promise<{ bytes: Buffer; modifiedAt: string; identity: FileIdentity } | undefined> {
  try {
    await assertNoSymlinkParents(root, dirname(target), false);
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CONTENT_BYTES || await realpath(target) !== target) throw coded('PROJECT_FILE_CHANGED', 'Project output is unavailable');
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_CONTENT_BYTES) throw coded('PROJECT_FILE_CHANGED', 'Project output was replaced');
      const buffer = Buffer.alloc(MAX_CONTENT_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat(); const current = await lstat(target);
      await assertNoSymlinkParents(root, dirname(target), false);
      if (length > MAX_CONTENT_BYTES || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
        || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino || await realpath(target) !== target) throw coded('PROJECT_FILE_CHANGED', 'Project output changed while reading');
      return { bytes: buffer.subarray(0, length), modifiedAt: after.mtime.toISOString(), identity: { dev: opened.dev, ino: opened.ino } };
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
async function unlinkOwned(path: string, identity: FileIdentity): Promise<void> {
  try {
    const current = await lstat(path);
    if (current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) await unlink(path);
    else throw coded('PROJECT_FILE_CHANGED', 'Project temporary output was replaced');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}
async function writeExclusive(root: string, targetPath: string, content: string, id: string): Promise<void> {
  const target = resolveProjectOutputPath(root, targetPath.split('/')[1] as ProjectCategory, basename(targetPath));
  const directory = dirname(target);
  await assertNoSymlinkParents(root, directory);
  try { const info = await lstat(target); if (info.isSymbolicLink() || info.isFile() || info.isDirectory()) throw coded('PROJECT_OUTPUT_EXISTS', 'Project output already exists'); }
  catch (error) { const code = error instanceof Error && 'code' in error ? String((error as CodedError).code) : ''; if (code !== 'ENOENT') throw error; }
  const temporary = join(directory, `.xiao-project-${id}.tmp`);
  const staged = join(directory, `.xiao-project-${id}.staged`);
  const bytes = Buffer.from(content, 'utf8');
  let identity: FileIdentity | undefined;
  let published = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { const info = await handle.stat(); identity = { dev: info.dev, ino: info.ino }; await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    // Both staging and publication are no-clobber links. A captured failure
    // cleans only the inode this call owns, including partial temporary writes.
    await assertNoSymlinkParents(root, directory, false);
    await link(temporary, staged);
    await unlinkOwned(temporary, identity);
    await link(staged, target);
    published = true;
    await assertNoSymlinkParents(root, directory, false);
    const saved = await readSafeOutput(root, target);
    if (!saved || !saved.bytes.equals(bytes)) throw coded('PROJECT_FILE_CHANGED', 'Published project output changed');
    await unlinkOwned(staged, identity);
    const directoryHandle = await open(directory, 'r'); try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    if (identity) {
      await unlinkOwned(temporary, identity).catch(() => undefined);
      await unlinkOwned(staged, identity).catch(() => undefined);
    }
    if (published) throw coded('PROJECT_OUTPUT_PUBLICATION_UNVERIFIED', 'Published project output needs verification');
    if (error instanceof Error && 'code' in error && String((error as CodedError).code) === 'EEXIST') throw coded('PROJECT_OUTPUT_EXISTS', 'Project output already exists');
    throw error;
  }
}

export function createProjectWritePlanService(input: {
  database: Database.Database;
  now?: () => Date;
  idFactory?: () => string;
  ttlMs?: number;
  getRuleFingerprint?: () => Promise<string>;
}): ProjectWritePlanService {
  const database = input.database; const now = input.now ?? (() => new Date()); const makeId = input.idFactory ?? randomUUID; const ttl = input.ttlMs ?? TTL_MS;

  async function indexCompletedOutput(plan: PlanRow): Promise<ProjectWriteAction> {
    try {
      const confirmation = confirmedIdentity(plan, 'completed');
      await assertConfirmedRoot(plan, confirmation);
      const project = rowOrThrow(database, plan.project_id);
      const target = resolveProjectOutputPath(project.root_path, plan.category, basename(plan.target_path));
      const saved = await readSafeOutput(project.root_path, target);
      if (!saved || sha256(saved.bytes) !== plan.content_sha256) throw coded('PROJECT_FILE_CHANGED', 'Saved output has been edited');
      const { bytes, modifiedAt } = saved;
      const parsed = await parseAttachment(bytes, 'text/markdown', new AbortController().signal);
      await assertConfirmedRoot(plan, confirmation);
      const content = parsed.status === 'ready' ? parsed.pages.map(page => page.text).join('\n') : '';
      const readable = parsed.status === 'ready' && content.trim().length > 0;
      const index = database.transaction(() => {
        const currentProject = rowOrThrow(database, plan.project_id);
        if (currentProject.root_path !== project.root_path || currentProject.source_revision !== project.source_revision || currentProject.availability !== 'ready') {
          throw coded('PROJECT_SOURCE_STALE', 'Project context changed while indexing the saved output');
        }
        // A confirmed new output is already known. Add that snapshot directly;
        // rescanning would advance sourceRevision and invalidate sibling plans.
        const insert = database.prepare(`INSERT INTO personal_project_files
          (project_id,relative_path,kind,bytes,modified_at,sha256,parse_status,parse_problem,content_text,origin,indexed_revision)
          VALUES (?,?,?,?,?,?,?,?,?,'output',?) ON CONFLICT(project_id,relative_path) DO UPDATE SET
          kind=excluded.kind,bytes=excluded.bytes,modified_at=excluded.modified_at,sha256=excluded.sha256,
          parse_status=excluded.parse_status,parse_problem=excluded.parse_problem,content_text=excluded.content_text,
          origin='output',indexed_revision=excluded.indexed_revision`);
        for (const path of ['AI工作区', `AI工作区/${plan.category}`]) {
          insert.run(plan.project_id, path, 'directory', null, null, null, null, null, null, project.source_revision);
        }
        insert.run(plan.project_id, plan.target_path, 'file', bytes.length, modifiedAt, plan.content_sha256,
          readable ? 'readable' : 'failed', readable ? null : parsed.status === 'ready' ? 'NO_READABLE_TEXT' : 'PARSE_FAILED', readable ? content : null, project.source_revision);
        database.prepare('UPDATE personal_project_write_plans SET problem = NULL WHERE id = ? AND status = \'completed\'').run(plan.id);
      });
      index.immediate();
    } catch {
      // The file and successful operation receipt were committed first. Index
      // failures must not masquerade as failed writes or cause another write.
      database.prepare('UPDATE personal_project_write_plans SET problem = ? WHERE id = ? AND status = \'completed\'').run(OUTPUT_INDEX_PENDING, plan.id);
    }
    return publicAction(database, planRow(database, plan.id));
  }

  async function proposeDraft(value: { projectId: string; conversationId: string; messageId: string; category: ProjectCategory; title: string; summary: string; content: string; expectedRevision: number }): Promise<ProjectWriteAction> {
    const category = projectCategorySchema.safeParse(value.category); if (!category.success) throw coded('PROJECT_CATEGORY_INVALID', 'Project output category is invalid');
    const title = value.title.trim(); if (title.length === 0) throw coded('PROJECT_TITLE_INVALID', 'Project output title is required');
    if (Buffer.byteLength(value.content, 'utf8') > MAX_CONTENT_BYTES) throw coded('PROJECT_OUTPUT_TOO_LARGE', 'Project output is too large');
    const project = rowOrThrow(database, value.projectId);
    if (project.availability !== 'ready') throw coded('PROJECT_UNAVAILABLE', 'Project is unavailable');
    if (project.source_revision !== value.expectedRevision) throw coded('PROJECT_SOURCE_STALE', 'Project source has changed');
    const created = now(); const createdAt = iso(created); const expiresAt = iso(new Date(created.getTime() + ttl));
    const id = makeId();
    const targetPath = `AI工作区/${category.data}/${createdAt.slice(0, 10)}-${safeSlug(title)}-${id}.md`;
    const row: PlanRow = { id, project_id: value.projectId, conversation_id: value.conversationId, message_id: value.messageId, category: category.data, title: title.slice(0, 255), summary: value.summary.slice(0, 2000), content: value.content, content_sha256: sha256(value.content), source_revision: value.expectedRevision, target_path: targetPath, status: 'pending', created_at: createdAt, expires_at: expiresAt, updated_at: createdAt, confirm_request_id: null, result_path: null, problem: null };
    database.prepare(`INSERT INTO personal_project_write_plans
      (id, project_id, conversation_id, message_id, category, title, summary, content, content_sha256, source_revision, target_path, status, created_at, expires_at, updated_at, confirm_request_id, result_path, problem)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`).run(row.id, row.project_id, row.conversation_id, row.message_id, row.category, row.title, row.summary, row.content, row.content_sha256, row.source_revision, row.target_path, row.status, row.created_at, row.expires_at, row.updated_at);
    return publicAction(database, row);
  }
  function mark(id: string, status: PlanRow['status'], requestId: string, problem?: string, resultPath?: string): ProjectWriteAction {
    const timestamp = iso(now());
    database.prepare(`UPDATE personal_project_write_plans SET status = ?, confirm_request_id = ?, problem = ?, result_path = ?, updated_at = ? WHERE id = ?`).run(status, requestId, problem ?? null, resultPath ?? null, timestamp, id);
    return publicAction(database, planRow(database, id));
  }
  async function confirm(planId: string, conversationId: string, clientRequestId: string): Promise<ProjectWriteAction> {
    const plan = planRow(database, planId, conversationId);
    return withProjectLock(database, plan.project_id, () => confirmUnlocked(planId, conversationId, clientRequestId));
  }
  function operationFor(plan: PlanRow): OperationRow | undefined {
    const rows = database.prepare("SELECT id,target_path,new_sha256,payload_json FROM personal_project_operations WHERE project_id = ? AND plan_id = ? AND event_type = 'project-write'").all(plan.project_id, plan.id) as OperationRow[];
    return rows.length === 1 ? rows[0] : undefined;
  }
  function confirmedIdentity(plan: PlanRow, status: 'running' | 'completed'): Confirmation {
    const operation = operationFor(plan);
    const payload = operation ? JSON.parse(operation.payload_json) as { status?: string; confirmation?: Confirmation } : undefined;
    const recorded = payload?.confirmation;
    // Legacy rows lack a durable root/operation identity. A matching hash alone
    // cannot grant permission to continue or claim their output in a new root.
    if (!operation || payload?.status !== status || !recorded || recorded.planId !== plan.id || recorded.clientRequestId !== plan.confirm_request_id
      || recorded.targetPath !== plan.target_path || operation.target_path !== plan.target_path || recorded.contentSha256 !== plan.content_sha256
      || operation.new_sha256 !== plan.content_sha256 || sha256(plan.content) !== plan.content_sha256 || Buffer.byteLength(plan.content, 'utf8') > MAX_CONTENT_BYTES
      || plan.target_path !== `AI工作区/${plan.category}/${basename(plan.target_path)}` || !basename(plan.target_path).endsWith(`-${plan.id}.md`)) {
      throw coded('PROJECT_WRITE_CONFIRMATION_INVALID', 'Confirmed operation identity is unavailable');
    }
    return recorded;
  }
  function assertProjectContext(plan: PlanRow, confirmation: Confirmation): ProjectRow {
    const project = rowOrThrow(database, plan.project_id);
    if (project.availability !== 'ready' || project.root_path !== confirmation.rootPath || project.source_revision !== confirmation.sourceRevision
      || plan.source_revision !== confirmation.sourceRevision) throw coded('PROJECT_SOURCE_STALE', 'Confirmed project context changed');
    return project;
  }
  async function currentRuleFingerprint(): Promise<string | undefined> {
    if (!input.getRuleFingerprint) return undefined;
    try { return await input.getRuleFingerprint(); }
    catch { throw coded('PROJECT_RULES_UNAVAILABLE', 'Project rules are temporarily unavailable'); }
  }
  async function assertConfirmedRoot(plan: PlanRow, confirmation: Confirmation): Promise<void> {
    if (input.getRuleFingerprint && await currentRuleFingerprint() !== confirmation.ruleFingerprint) throw coded('PROJECT_RULES_CHANGED', 'Rules changed since the project write was confirmed');
    const project = assertProjectContext(plan, confirmation);
    const root = await lstat(project.root_path);
    if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== confirmation.rootDev || root.ino !== confirmation.rootIno
      || await realpath(project.root_path) !== confirmation.rootPath) throw coded('PROJECT_ROOT_RECONNECT_REQUIRED', 'Confirmed project root was replaced');
    assertProjectContext(plan, confirmation);
  }
  function finish(plan: PlanRow, status: 'completed' | 'stale' | 'failed', problem?: string, code?: string): ProjectWriteAction {
    const timestamp = iso(now()); const operation = operationFor(plan);
    const transaction = database.transaction(() => {
      const changed = database.prepare("UPDATE personal_project_write_plans SET status = ?, result_path = ?, problem = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(status, status === 'completed' ? plan.target_path : null, problem ?? null, timestamp, plan.id);
      if (changed.changes !== 1) throw coded('PROJECT_WRITE_PLAN_RESOLVED', 'Project write plan already resolved');
      if (operation) {
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(operation.payload_json) as Record<string, unknown>; } catch { /* Keep the corrupt operation as a stopped receipt. */ }
        database.prepare('UPDATE personal_project_operations SET new_sha256 = ?, payload_json = ? WHERE id = ?').run(status === 'completed' ? plan.content_sha256 : null, JSON.stringify({ ...payload, status, ...(code ? { code } : {}), sourceRevision: plan.source_revision }), operation.id);
      }
    });
    transaction.immediate();
    return publicAction(database, planRow(database, plan.id));
  }
  function pause(plan: PlanRow, problem: string, verifyOnly = false): ProjectWriteAction {
    const operation = operationFor(plan);
    const transaction = database.transaction(() => {
      database.prepare("UPDATE personal_project_write_plans SET problem = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(problem, iso(now()), plan.id);
      if (operation && verifyOnly) {
        const payload = JSON.parse(operation.payload_json) as Record<string, unknown>;
        database.prepare('UPDATE personal_project_operations SET payload_json = ? WHERE id = ?').run(JSON.stringify({ ...payload, publication: 'linked' }), operation.id);
      }
    });
    transaction.immediate();
    return publicAction(database, planRow(database, plan.id));
  }
  async function resumeConfirmed(plan: PlanRow): Promise<ProjectWriteAction> {
    let confirmation: Confirmation;
    let linked = false;
    try {
      confirmation = confirmedIdentity(plan, 'running');
      await assertConfirmedRoot(plan, confirmation);
      const target = resolveProjectOutputPath(confirmation.rootPath, plan.category, basename(plan.target_path));
      const saved = await readSafeOutput(confirmation.rootPath, target);
      linked = saved !== undefined;
      if (saved && sha256(saved.bytes) !== plan.content_sha256) throw coded('PROJECT_FILE_CHANGED', 'Confirmed output differs from the saved file');
      const operation = operationFor(plan)!;
      const publication = (JSON.parse(operation.payload_json) as { publication?: string }).publication;
      if (!saved && publication === 'linked') throw coded('PROJECT_FILE_CHANGED', 'Previously published project output is missing');
      // Hard interruption may leave a private scratch file, including a staged
      // hard link after publication. Validate every artifact before removing
      // this plan's matching regular files (a temporary prefix is also valid).
      // Captured failed writes remain terminal and never retry.
      const bytes = Buffer.from(plan.content, 'utf8');
      const artifacts: Array<{ path: string; identity: FileIdentity }> = [];
      for (const suffix of ['tmp', 'staged'] as const) {
        const path = join(dirname(target), `.xiao-project-${plan.id}.${suffix}`);
        const artifact = await readSafeOutput(confirmation.rootPath, path);
        if (!artifact) continue;
        if (suffix === 'staged' ? !artifact.bytes.equals(bytes) : !artifact.bytes.equals(bytes.subarray(0, artifact.bytes.length))) throw coded('PROJECT_FILE_CHANGED', 'Confirmed temporary output differs');
        artifacts.push({ path, identity: artifact.identity });
      }
      for (const artifact of artifacts) {
        await assertConfirmedRoot(plan, confirmation);
        await unlinkOwned(artifact.path, artifact.identity);
      }
      if (!saved) {
        await assertConfirmedRoot(plan, confirmation);
        await writeExclusive(confirmation.rootPath, plan.target_path, plan.content, plan.id);
        linked = true;
      } else {
        const directory = await open(dirname(target), 'r'); try { await directory.sync(); } finally { await directory.close(); }
      }
      await assertConfirmedRoot(plan, confirmation);
      const verified = await readSafeOutput(confirmation.rootPath, target);
      if (!verified || sha256(verified.bytes) !== plan.content_sha256) throw coded('PROJECT_FILE_CHANGED', 'Confirmed output changed before its receipt');
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'PROJECT_WRITE_RECOVERY_CONFLICT';
      if (code === 'PROJECT_RULES_UNAVAILABLE') return pause(plan, '暂时无法核验大脑规则，保存操作已暂停；恢复连接后重新打开 App 继续核验', linked);
      if (code === 'PROJECT_OUTPUT_PUBLICATION_UNVERIFIED') return pause(plan, '目标可能已保存，结果尚待核验；请重新打开 App 继续核验', true);
      if (['EIO', 'EACCES', 'EPERM', 'EBUSY', 'EMFILE', 'ENFILE', 'ENOSPC'].includes(code)) return pause(plan, '暂时无法核验项目文件，保存操作已暂停；请检查目录访问后重新打开 App 继续核验', linked);
      return finish(plan, 'stale', '已确认的保存无法安全继续，请检查项目目录和目标文件后重新生成计划', code);
    }
    // Receipt commit failures deliberately leave the intent running. A retry
    // can verify the published bytes without producing a second operation.
    assertProjectContext(plan, confirmation);
    finish(plan, 'completed');
    return indexCompletedOutput(planRow(database, plan.id));
  }
  async function confirmUnlocked(planId: string, conversationId: string, clientRequestId: string): Promise<ProjectWriteAction> {
    let plan = planRow(database, planId, conversationId);
    if (plan.confirm_request_id !== null) {
      if (plan.confirm_request_id === clientRequestId) {
        if (plan.status === 'running') return resumeConfirmed(plan);
        return plan.status === 'completed' && plan.problem === OUTPUT_INDEX_PENDING ? indexCompletedOutput(plan) : publicAction(database, plan);
      }
      throw coded('PROJECT_WRITE_PLAN_RESOLVED', 'Project write plan already resolved');
    }
    if (plan.status !== 'pending') throw coded('PROJECT_WRITE_PLAN_RESOLVED', 'Project write plan already resolved');
    const project = rowOrThrow(database, plan.project_id);
    if (Date.parse(plan.expires_at) <= now().getTime() || project.availability !== 'ready' || project.source_revision !== plan.source_revision) {
      return mark(plan.id, 'stale', clientRequestId, '项目内容已变化，计划已失效');
    }
    const root = await lstat(project.root_path);
    if (!root.isDirectory() || root.isSymbolicLink() || await realpath(project.root_path) !== project.root_path) return mark(plan.id, 'stale', clientRequestId, '项目目录已变化，请重新连接项目');
    const ruleFingerprint = await currentRuleFingerprint();
    const confirmation: Confirmation = { planId: plan.id, clientRequestId, targetPath: plan.target_path, contentSha256: plan.content_sha256, sourceRevision: plan.source_revision, rootPath: project.root_path, rootDev: root.dev, rootIno: root.ino, ...(ruleFingerprint === undefined ? {} : { ruleFingerprint }) };
    const claim = database.transaction(() => {
      assertProjectContext(plan, confirmation);
      const claimed = database.prepare('UPDATE personal_project_write_plans SET status = \'running\', confirm_request_id = ?, updated_at = ? WHERE id = ? AND status = \'pending\'').run(clientRequestId, iso(now()), plan.id);
      if (claimed.changes !== 1) throw coded('PROJECT_WRITE_PLAN_RESOLVED', 'Project write plan already resolved');
      database.prepare(`INSERT INTO personal_project_operations (id, project_id, plan_id, event_type, target_path, old_sha256, new_sha256, payload_json, created_at) VALUES (?, ?, ?, 'project-write', ?, NULL, ?, ?, ?)`).run(makeId(), plan.project_id, plan.id, plan.target_path, plan.content_sha256, JSON.stringify({ status: 'running', confirmation }), iso(now()));
    });
    claim.immediate();
    plan = planRow(database, plan.id, conversationId);
    try {
      await assertConfirmedRoot(plan, confirmation);
      await writeExclusive(project.root_path, plan.target_path, plan.content, plan.id);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as CodedError).code) : 'PROJECT_OUTPUT_WRITE_FAILED';
      if (code === 'PROJECT_OUTPUT_PUBLICATION_UNVERIFIED') {
        const problem = '目标可能已保存，结果尚待核验；请重新打开 App 继续核验';
        pause(plan, problem, true);
        throw coded(code, problem);
      }
      if (code === 'PROJECT_RULES_UNAVAILABLE') {
        const problem = '暂时无法核验大脑规则，保存操作已暂停；恢复连接后重新打开 App 继续核验';
        pause(plan, problem);
        throw coded(code, problem);
      }
      if (code === 'PROJECT_OUTPUT_EXISTS') {
        finish(plan, 'stale', '目标文件已存在，未覆盖', code);
        throw coded(code, 'Project output already exists');
      }
      const problem = '项目输出写入未完成，已保留操作记录；请检查项目目录后重新生成计划';
      finish(plan, 'failed', problem, code);
      throw coded('PROJECT_OUTPUT_WRITE_FAILED', problem);
    }
    try {
      await assertConfirmedRoot(plan, confirmation);
      const saved = await readSafeOutput(project.root_path, resolveProjectOutputPath(project.root_path, plan.category, basename(plan.target_path)));
      if (!saved || sha256(saved.bytes) !== plan.content_sha256) throw coded('PROJECT_FILE_CHANGED', 'Published output changed before its receipt');
    } catch {
      const problem = '目标可能已保存，结果尚待核验；请重新打开 App 继续核验';
      pause(plan, problem, true);
      throw coded('PROJECT_OUTPUT_PUBLICATION_UNVERIFIED', problem);
    }
    finish(plan, 'completed');
    return indexCompletedOutput(planRow(database, plan.id, conversationId));
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
    return rows.flatMap(row => { let status: ProjectOperation['status'] = 'completed'; try { const parsed = JSON.parse(row.payload_json) as { status?: string }; if (parsed.status === 'running') return []; if (parsed.status === 'failed' || parsed.status === 'stale') status = parsed.status; } catch { status = 'failed'; } return [projectOperationSchema.parse({ id: row.id, projectId: row.project_id, eventType: row.event_type, targetPath: row.target_path, ...(row.old_sha256 === null ? {} : { oldSha256: row.old_sha256 }), ...(row.new_sha256 === null ? {} : { newSha256: row.new_sha256 }), createdAt: row.created_at, status })]; });
  }
  async function recoverConfirmedPlans(): Promise<void> {
    const running = database.prepare("SELECT id,conversation_id,confirm_request_id FROM personal_project_write_plans WHERE status = 'running' ORDER BY created_at,id").all() as Array<{ id: string; conversation_id: string; confirm_request_id: string | null }>;
    for (const row of running) {
      if (row.confirm_request_id === null) {
        const plan = planRow(database, row.id);
        await withProjectLock(database, plan.project_id, async () => { if (planRow(database, plan.id).status === 'running') finish(plan, 'stale', '保存缺少已确认的操作记录，请重新生成计划', 'PROJECT_WRITE_CONFIRMATION_INVALID'); });
      } else await confirm(row.id, row.conversation_id, row.confirm_request_id);
    }
  }
  return { proposeDraft, confirm, cancel, confirmForProject, cancelForProject, project, operations, recoverConfirmedPlans };
}
