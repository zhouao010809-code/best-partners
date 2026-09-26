import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { PublicApiError } from '../../shared/api/errors.js';
import {
  creationCreateSchema, creationExchangeSchema, creationSaveSchema, creationSnapshotSchema,
  projectCreationSchema, creationVersionSchema,
  type CreationDetail, type CreationExchange, type CreationVersion, type ProjectCreation,
  type ProjectCreationService
} from '../../shared/api/project-creations.js';
import { resolveProjectOutputPath } from './project-paths.js';

type ProjectRow = { id: string; root_path: string; availability: string };
type CreationRow = { id: string; project_id: string; kind: string; title: string; brief: string; body: string; audience: string; angle: string; rationale: string; sources_json: string; revision: number; final_version_id: string | null; created_at: string; updated_at: string };
type VersionRow = { id: string; creation_id: string; number: number; title: string; brief: string; body: string; sources_json: string; export_content: string; content_sha256: string; created_at: string };
type ExchangeRow = { id: string; instruction: string; suggestion_json: string; created_at: string };
type ExportRow = { version_id: string; root_path: string; relative_path: string; content_sha256: string; status: 'pending' | 'completed' };
type DirectoryIdentity = { path: string; dev: number; ino: number };
const MAX_CREATIONS = 200;
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const codeOf = (error: unknown) => error instanceof Error && 'code' in error ? String(error.code) : '';
function failure(code: string, message: string, status = 400): never { throw new PublicApiError(code, message, status); }
function parsed<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) failure('CREATION_INVALID', '创作内容或版本号无效，请检查后重试。');
  return result.data;
}
function publicItem(row: CreationRow): ProjectCreation {
  return projectCreationSchema.parse({ id: row.id, projectId: row.project_id, kind: row.kind, title: row.title, brief: row.brief, body: row.body,
    audience: row.audience, angle: row.angle, rationale: row.rationale, sources: JSON.parse(row.sources_json), revision: row.revision,
    ...(row.final_version_id ? { finalVersionId: row.final_version_id } : {}), createdAt: row.created_at, updatedAt: row.updated_at });
}
function publicVersion(row: VersionRow): CreationVersion {
  return creationVersionSchema.parse({ id: row.id, creationId: row.creation_id, number: row.number, title: row.title,
    brief: row.brief, body: row.body, sources: JSON.parse(row.sources_json), createdAt: row.created_at });
}
function slug(title: string): string {
  const cleaned = title.normalize('NFKC').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/gu, '-');
  let value = '';
  for (const letter of cleaned) { if (Buffer.byteLength(value + letter) > 80) break; value += letter; }
  return value || '创作稿件';
}
function exportContent(item: ProjectCreation, version: { id: string; number: number; createdAt: string }, exchanges: CreationExchange[]): string {
  return `# ${item.title}\n\n${item.body}\n\n---\n\n## 创作要求\n\n${item.brief || '未填写'}\n\n## 来源依据\n\n\`\`\`json\n${JSON.stringify(item.sources, null, 2)}\n\`\`\`\n\n## 版本记录\n\n- 创作编号：${item.id}\n- 版本：${version.number}\n- 版本编号：${version.id}\n- 保存时间：${version.createdAt}\n\n## 相关讨论\n\n${exchanges.length ? exchanges.map(entry => `- ${entry.createdAt} · ${entry.id}\n  ${entry.instruction.replace(/\n/gu, '\n  ')}`).join('\n') : '此版本没有关联讨论。'}\n`;
}
async function directories(root: string): Promise<DirectoryIdentity[]> {
  const paths = [root, join(root, 'AI工作区'), join(root, 'AI工作区', '内容草稿')];
  const identities: DirectoryIdentity[] = [];
  for (const [index, path] of paths.entries()) {
    if (index > 0) { try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (codeOf(error) !== 'EEXIST') throw error; } }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) failure('CREATION_EXPORT_UNAVAILABLE', '项目输出目录已变化，请重新连接项目后再导出。', 409);
    identities.push({ path, dev: info.dev, ino: info.ino });
  }
  return identities;
}
async function verifyDirectories(identities: DirectoryIdentity[]): Promise<void> {
  for (const identity of identities) {
    const info = await lstat(identity.path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== identity.dev || info.ino !== identity.ino || await realpath(identity.path) !== identity.path) failure('CREATION_EXPORT_UNAVAILABLE', '项目输出目录已变化，未继续导出。', 409);
  }
}
async function existingDigest(path: string): Promise<string | undefined> {
  let info;
  try { info = await lstat(path); } catch (error) { if (codeOf(error) === 'ENOENT') return undefined; throw error; }
  if (info.isSymbolicLink() || !info.isFile()) failure('CREATION_EXPORT_CONFLICT', '目标位置已存在其他文件，未覆盖。', 409);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino || !opened.isFile()) failure('CREATION_EXPORT_CONFLICT', '导出文件已变化，未覆盖。', 409);
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest('hex');
  } finally { await handle.close(); }
}

export function createProjectCreationService(input: { database: Database.Database; now?: () => Date; idFactory?: () => string }): ProjectCreationService {
  const database = input.database; const now = input.now ?? (() => new Date()); const makeId = input.idFactory ?? randomUUID;
  const exportLocks = new Map<string, Promise<unknown>>();
  function project(id: string): ProjectRow {
    const row = database.prepare('SELECT id,root_path,availability FROM personal_projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!row) failure('PROJECT_NOT_FOUND', '项目不存在，请重新打开项目。', 404);
    return row;
  }
  function owned(projectId: string, id: string): CreationRow {
    project(projectId);
    const row = database.prepare('SELECT * FROM personal_project_creations WHERE id = ? AND project_id = ?').get(id, projectId) as CreationRow | undefined;
    if (!row) failure('CREATION_NOT_FOUND', '当前项目中找不到这条创作。', 404);
    return row;
  }
  function exchanges(id: string): CreationExchange[] {
    return (database.prepare('SELECT id,instruction,suggestion_json,created_at FROM personal_project_creation_exchanges WHERE creation_id = ? ORDER BY rowid ASC').all(id) as ExchangeRow[])
      .map(row => creationExchangeSchema.parse({ id: row.id, instruction: row.instruction, suggestion: JSON.parse(row.suggestion_json), createdAt: row.created_at }));
  }
  function detail(projectId: string, id: string): CreationDetail {
    const row = owned(projectId, id);
    const versions = (database.prepare('SELECT * FROM personal_project_creation_versions WHERE creation_id = ? ORDER BY number DESC').all(id) as VersionRow[]).map(publicVersion);
    return { item: publicItem(row), versions, messages: exchanges(id) };
  }
  function assertRevision(row: CreationRow, revision: number): void {
    if (row.revision !== revision) failure('CREATION_REVISION_CONFLICT', '这条创作已有更新，已保留当前编辑。请重新读取后合并。', 409);
  }
  const service: ProjectCreationService = {
    async list(projectId) {
      project(projectId);
      return (database.prepare('SELECT * FROM personal_project_creations WHERE project_id = ? ORDER BY updated_at DESC, rowid DESC').all(projectId) as CreationRow[]).map(publicItem);
    },
    async get(projectId, id) { return detail(projectId, id); },
    async create(projectId, raw) {
      const value = parsed(creationCreateSchema, raw); const id = makeId(); const timestamp = now().toISOString();
      database.transaction(() => {
        project(projectId);
        const { count } = database.prepare('SELECT COUNT(*) AS count FROM personal_project_creations WHERE project_id = ?').get(projectId) as { count: number };
        if (count >= MAX_CREATIONS) failure('CREATION_LIMIT_EXCEEDED', '每个项目最多保存 200 条创作，现有内容已完整保留。', 409);
        database.prepare(`INSERT INTO personal_project_creations
          (id,project_id,kind,title,brief,body,audience,angle,rationale,sources_json,revision,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(id, projectId, value.kind, value.title, value.brief, value.body, value.audience, value.angle, value.rationale, JSON.stringify(value.sources), timestamp, timestamp);
      }).immediate();
      return detail(projectId, id);
    },
    async save(projectId, id, raw) {
      const value = parsed(creationSaveSchema, raw);
      database.transaction(() => {
        assertRevision(owned(projectId, id), value.expectedRevision);
        database.prepare(`UPDATE personal_project_creations SET kind=?,title=?,brief=?,body=?,audience=?,angle=?,rationale=?,sources_json=?,revision=revision+1,updated_at=? WHERE id=? AND project_id=? AND revision=?`)
          .run(value.kind, value.title, value.brief, value.body, value.audience, value.angle, value.rationale, JSON.stringify(value.sources), now().toISOString(), id, projectId, value.expectedRevision);
      }).immediate();
      return detail(projectId, id);
    },
    async snapshot(projectId, id, raw) {
      const value = parsed(creationSnapshotSchema, raw);
      database.transaction(() => {
        const row = owned(projectId, id); assertRevision(row, value.expectedRevision);
        const item = publicItem(row); const versionId = makeId(); const timestamp = now().toISOString();
        const { number } = database.prepare('SELECT COALESCE(MAX(number),0)+1 AS number FROM personal_project_creation_versions WHERE creation_id = ?').get(id) as { number: number };
        const content = exportContent(item, { id: versionId, number, createdAt: timestamp }, exchanges(id));
        database.prepare(`INSERT INTO personal_project_creation_versions (id,creation_id,number,title,brief,body,sources_json,export_content,content_sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(versionId, id, number, row.title, row.brief, row.body, row.sources_json, content, sha256(content), timestamp);
        database.prepare('UPDATE personal_project_creations SET revision=revision+1,final_version_id=?,updated_at=? WHERE id=? AND project_id=? AND revision=?')
          .run(value.finalize ? versionId : row.final_version_id, timestamp, id, projectId, value.expectedRevision);
      }).immediate();
      return detail(projectId, id);
    },
    async recordExchange(projectId, id, raw) {
      const entry = parsed(creationExchangeSchema, { ...raw, id: makeId(), createdAt: now().toISOString() });
      database.transaction(() => {
        owned(projectId, id);
        database.prepare('INSERT INTO personal_project_creation_exchanges (id,creation_id,instruction,suggestion_json,created_at) VALUES (?,?,?,?,?)').run(entry.id, id, entry.instruction, JSON.stringify(entry.suggestion), entry.createdAt);
        database.prepare('DELETE FROM personal_project_creation_exchanges WHERE creation_id = ? AND id NOT IN (SELECT id FROM personal_project_creation_exchanges WHERE creation_id = ? ORDER BY rowid DESC LIMIT 100)').run(id, id);
      }).immediate();
    },
    async exportVersion(projectId, id, versionId) {
      owned(projectId, id);
      const previous = exportLocks.get(versionId) ?? Promise.resolve();
      const operation = previous.catch(() => undefined).then(() => exportSnapshot(projectId, id, versionId));
      exportLocks.set(versionId, operation);
      try { return await operation; } finally { if (exportLocks.get(versionId) === operation) exportLocks.delete(versionId); }
    }
  };
  async function exportSnapshot(projectId: string, id: string, versionId: string) {
    owned(projectId, id);
    const version = database.prepare('SELECT * FROM personal_project_creation_versions WHERE id = ? AND creation_id = ?').get(versionId, id) as VersionRow | undefined;
    if (!version) failure('CREATION_VERSION_NOT_FOUND', '当前创作中找不到这个版本。', 404);
    const owner = project(projectId);
    if (owner.availability !== 'ready') failure('CREATION_EXPORT_UNAVAILABLE', '项目文件夹尚未连接，请重新连接后导出。', 409);
    const path = `AI工作区/内容草稿/${slug(version.title)}-${id}-v${version.number}-${version.id}.md`;
    const target = resolveProjectOutputPath(owner.root_path, '内容草稿', path.split('/').at(-1)!);
    let receipt = database.prepare('SELECT * FROM personal_project_creation_exports WHERE version_id = ?').get(versionId) as ExportRow | undefined;
    if (receipt && (receipt.root_path !== owner.root_path || receipt.relative_path !== path || receipt.content_sha256 !== version.content_sha256)) failure('CREATION_EXPORT_CONFLICT', '项目位置或导出记录已变化，请检查原导出文件。', 409);
    let temporary: string | undefined;
    try {
      const identities = await directories(owner.root_path);
      const digest = await existingDigest(target);
      if (digest !== undefined) {
        if (!receipt || digest !== version.content_sha256) failure('CREATION_EXPORT_CONFLICT', '目标文件已存在或被修改，未覆盖。', 409);
        database.prepare("UPDATE personal_project_creation_exports SET status='completed',completed_at=? WHERE version_id=?").run(now().toISOString(), versionId);
        return { path, versionId };
      }
      if (receipt?.status === 'completed') failure('CREATION_EXPORT_CONFLICT', '原导出文件已移动或删除，未自动重建。', 409);
      database.prepare("INSERT OR IGNORE INTO personal_project_creation_exports (version_id,root_path,relative_path,content_sha256,status,created_at) VALUES (?,?,?,?,'pending',?)").run(versionId, owner.root_path, path, version.content_sha256, now().toISOString());
      receipt = database.prepare('SELECT * FROM personal_project_creation_exports WHERE version_id = ?').get(versionId) as ExportRow | undefined;
      if (!receipt || receipt.root_path !== owner.root_path || receipt.relative_path !== path) failure('CREATION_EXPORT_CONFLICT', '这个版本已有其他导出任务，请重新读取。', 409);
      temporary = join(dirname(target), `.creation-${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(version.export_content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await verifyDirectories(identities);
      const currentOwner = project(projectId);
      if (currentOwner.root_path !== owner.root_path || currentOwner.availability !== 'ready') failure('CREATION_EXPORT_UNAVAILABLE', '项目连接已变化，未继续导出。', 409);
      try { await link(temporary, target); }
      catch (error) {
        if (codeOf(error) !== 'EEXIST') throw error;
        // Another instance may finish the same recorded version first.
        if (await existingDigest(target) !== version.content_sha256) failure('CREATION_EXPORT_CONFLICT', '目标文件已被其他操作创建，未覆盖。', 409);
      }
      await unlink(temporary); temporary = undefined;
      const directoryHandle = await open(dirname(target), 'r'); try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      database.prepare("UPDATE personal_project_creation_exports SET status='completed',completed_at=? WHERE version_id=?").run(now().toISOString(), versionId);
      return { path, versionId };
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      failure('CREATION_EXPORT_UNAVAILABLE', '导出未完成，请检查项目文件夹后重试。', 409);
    } finally { if (temporary) await unlink(temporary).catch(() => undefined); }
  }
  return service;
}
