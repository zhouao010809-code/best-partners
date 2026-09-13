import type { PersonalArchivePort } from '../archive/sandbox-native.js';
import type { IntakeService } from '../services/intake-service.js';
import { mkdtempSync, mkdirSync, openSync, closeSync, constants, fsyncSync, writeFileSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ensurePrivateDirectory } from '../db/permissions.js';
import { attachmentArchiveRequestSchema, type Attachment, type AttachmentArchiveRequest, type AttachmentArchiveResult } from '../../shared/api/attachments.js';
import { intakeFieldsSchema } from '../../shared/api/intake.js';
import { PublicApiError } from '../../shared/api/errors.js';
import { inferIntakeFields, planIntakeMain } from '../archive/intake-plan.js';
import { parseArchiveIntent } from '../archive/archive-snapshot.js';
import { sha256Bytes } from '../vault/raw-bytes.js';
import type { StoredAttachment } from './service.js';
export type AttachmentArchivePort = { port: PersonalArchivePort; intakeService: IntakeService };
const planSchema = z.object({ fields: intakeFieldsSchema, intakeName: z.uuid(), mainName: z.string(), target: z.string(), mainSha: z.string(), published: z.boolean() });
type Text = { parser: string; pages: { page: number; text: string }[]; textRevision: string };
function fail(code: string, message: string): never { throw new PublicApiError(code, message, 409); }
export function createAttachmentArchive(input: {
  stagingDirectory: string; port?: AttachmentArchivePort; record(id: string): StoredAttachment; persist(record: StoredAttachment): void;
  list(): StoredAttachment[]; readOriginal(id: string): { attachment: Attachment; bytes: Buffer }; parsed(id: string): Text; now(): Date;
}) {
  let running: { id: string; done: Promise<AttachmentArchiveResult> } | undefined;
  function storedResult(item: Attachment, duplicate: boolean): AttachmentArchiveResult {
    const value = item.archive;
    if (!value?.operationId || !value.materialPath || !value.target) fail('ATTACHMENT_ARCHIVE_INCOMPLETE', '归档回执不完整，请继续核验。');
    return { id: item.id, state: value.state === 'archived' ? 'archived' : 'needs-review', operationId: value.operationId, materialPath: value.materialPath, target: value.target, indexed: value.indexed ?? false, duplicate };
  }
  function publish(staged: ReturnType<typeof planIntakeMain>, id: string, originalName: string, original: Buffer, port: PersonalArchivePort) {
    if (!port.publishAttachmentPackage) fail('ATTACHMENT_ARCHIVE_UNAVAILABLE', '请更新桌面归档模块后重试，原件仍保留。');
    ensurePrivateDirectory(input.stagingDirectory);
    const attempt = mkdtempSync(join(input.stagingDirectory, 'attempt-'));
    const folder = join(attempt, id); mkdirSync(folder, { mode: 0o700 }); mkdirSync(join(folder, '附件'), { mode: 0o700 });
    for (const [path, bytes] of [[join(folder, staged.mainName), staged.bytes], [join(folder, '附件', originalName), original]] as const) {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    }
    port.publishAttachmentPackage(attempt, id, staged.mainName, staged.bytes, originalName, original);
    // The package moved, so only this now-empty, generated attempt directory is removed.
    try { rmdirSync(attempt); } catch { /* Keep unexpected contents for inspection. */ }
  }
  async function execute(request: AttachmentArchiveRequest, signal?: AbortSignal): Promise<AttachmentArchiveResult> {
    signal?.throwIfAborted(); attachmentArchiveRequestSchema.parse(request);
    if (!input.port) fail('ATTACHMENT_ARCHIVE_UNAVAILABLE', '当前连接不能归档附件；原件已保留。');
    const { port, intakeService } = input.port, item = input.record(request.id), original = input.readOriginal(request.id);
    function exists(path: string): boolean { try { return port.stat(path) !== null; } catch (error) { if (error instanceof Error && error.message === 'NOT_FOUND') return false; throw error; } }
    function verifyArchivedOriginal(attachment: Attachment) {
      const archive = attachment.archive;
      const name = `原件.${attachment.mediaType === 'application/pdf' ? 'pdf' : attachment.mediaType === 'text/markdown' ? 'md' : 'txt'}`;
      try {
        if (!archive?.target || sha256Bytes(port.read(`${archive.target}/附件/${name}`)) !== attachment.sha256) throw Error('changed');
      } catch { fail('ATTACHMENT_ARCHIVE_ORIGINAL_CHANGED', '已归档原件缺失或已变化，请先恢复或核对原件；未重复创建。'); }
    }
    if (item.attachment.archive?.state === 'archived') {
      if (!item.attachment.archive.materialPath || !exists(item.attachment.archive.materialPath)) fail('ATTACHMENT_ARCHIVE_MISSING', '曾归档的资料已移走或回收；请先恢复，未重复创建。');
      verifyArchivedOriginal(item.attachment);
      return storedResult(item.attachment, true);
    }
    const duplicate = input.list().find(other => other.attachment.id !== request.id && other.attachment.sha256 === item.attachment.sha256 && other.attachment.archive?.state === 'archived');
    if (duplicate?.attachment.archive?.materialPath && exists(duplicate.attachment.archive.materialPath)) {
      verifyArchivedOriginal(duplicate.attachment);
      item.attachment.archive = structuredClone(duplicate.attachment.archive); item.attachment.duplicateOf = duplicate.attachment.id; input.persist(item); return storedResult(item.attachment, true);
    }
    if (item.attachment.status === 'processing' || item.attachment.status === 'cancelled') fail('ATTACHMENT_NOT_READY', '请先完成读取，或重试解析后再归档。');
    const text: Text = ['ready', 'needs-ocr'].includes(item.attachment.status) ? input.parsed(request.id) : { parser: 'unavailable', pages: [], textRevision: '' };
    const originalName = `原件.${item.attachment.mediaType === 'application/pdf' ? 'pdf' : item.attachment.mediaType === 'text/markdown' ? 'md' : 'txt'}`;
    let inferred: ReturnType<typeof inferIntakeFields> = {};
    if (item.attachment.mediaType === 'text/markdown') { try { inferred = inferIntakeFields(item.attachment.name, original.bytes); } catch { /* Original metadata remains in the original file and parsed text. */ } }
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(input.now());
    let fields = item.archivePlan ? planSchema.parse(item.archivePlan).fields : intakeFieldsSchema.parse({ platform: inferred.platform ?? '个人', title: inferred.title ?? item.attachment.name.replace(/\.(pdf|md|txt)$/iu, ''), collectedAt: inferred.collectedAt ?? date, ...inferred, ...request.fields });
    const body = Buffer.from(`## 原件与解析来源\n\n原文件：${JSON.stringify(item.attachment.name)}\n\n[查看原件](附件/${originalName})\n\nSHA-256：${item.attachment.sha256}\n\n解析器：${text.parser}；原件保真保存，以下为派生文本。${item.attachment.problem ? `\n\n读取提示：${item.attachment.problem}` : ''}\n\n${text.pages.map(page => `<!-- xiaozhao-page:${item.attachment.sha256}:${page.page} -->\n## 第 ${page.page} 页\n\n${page.text}\n\n`).join('')}`);
    let staged = planIntakeMain({ packageName: request.id, mainName: '原文.md', bytes: body, fields });
    if (!item.archivePlan && exists(`01图书馆/来自${staged.platform}/${staged.month}/${staged.packageName}`)) {
      if (request.fields?.title !== undefined) fail('ATTACHMENT_TITLE_CONFLICT', '归档位置已有同名资料，没有覆盖；请修改标题后重试。');
      // Intake names retain only 20 title characters; keep the version hash inside that boundary.
      fields = { ...fields, title: `${Array.from(fields.title).slice(0, 6).join('')} · 版本${item.attachment.sha256.slice(0, 8)}` };
      staged = planIntakeMain({ packageName: request.id, mainName: '原文.md', bytes: body, fields });
      if (exists(`01图书馆/来自${staged.platform}/${staged.month}/${staged.packageName}`)) fail('ATTACHMENT_TITLE_CONFLICT', '该版本的归档位置已有资料，没有覆盖；请指定不同标题。');
    }
    const target = `01图书馆/来自${staged.platform}/${staged.month}/${staged.packageName}`;
    const plan = item.archivePlan ? planSchema.parse(item.archivePlan) : { fields, intakeName: request.id, mainName: staged.mainName, target, mainSha: sha256Bytes(staged.bytes), published: false };
    if (plan.mainSha !== sha256Bytes(staged.bytes)) fail('ATTACHMENT_ARCHIVE_PLAN_CHANGED', '解析文本或归档资料已变化，请核对已有归档记录，未覆盖文件。');
    item.archivePlan = plan; item.attachment.archive ??= { state: 'preparing' }; input.persist(item);
    try {
      // A process can exit after intake persisted its ID but before our receipt.
      // Recover only an intent bound to this UUID package and approved target.
      let operationId = item.attachment.archive.operationId;
      if (!operationId) for (const name of port.listRecovery().filter(name => name.endsWith('.intent.json'))) {
        try {
          const envelope = JSON.parse(port.readRecovery(name)!.toString('utf8')) as { payload: { base?: string } };
          if (!envelope.payload.base) continue;
          const base = parseArchiveIntent(Buffer.from(envelope.payload.base));
          if (base.source === `01图书馆/小兆clipper/${plan.intakeName}` && base.target === plan.target) { operationId = base.id; break; }
        } catch { /* IntakeService independently refuses unknown recovery records before mutation. */ }
      }
      let outcome;
      if (operationId) outcome = await intakeService.resume(operationId, signal);
      else {
        const source = `01图书馆/小兆clipper/${plan.intakeName}`;
        if (!port.stat(source)) {
          if (plan.published) fail('ATTACHMENT_ARCHIVE_INCOMPLETE', '已发布的资料包暂时无法定位，请核对归档记录，未重复生成。');
          signal?.throwIfAborted(); publish(staged, plan.intakeName, originalName, original.bytes, port);
        }
        if (!port.read(`${source}/${plan.mainName}`).equals(staged.bytes) || !port.read(`${source}/附件/${originalName}`).equals(original.bytes)) fail('ATTACHMENT_ARCHIVE_CHANGED', '暂存资料包发生变化，未继续归档。');
        plan.published = true; item.archivePlan = plan; input.persist(item);
        const preview = await intakeService.preview({ name: plan.intakeName, mainName: plan.mainName, fields: plan.fields });
        signal?.throwIfAborted(); outcome = await intakeService.commit(preview.token, signal);
      }
      item.attachment.archive = { state: outcome.state === 'archived' ? 'archived' : 'needs-review', operationId: outcome.id, target: outcome.target, materialPath: `${outcome.target}/${plan.mainName}`, indexed: outcome.indexed };
      if (outcome.state === 'archived') verifyArchivedOriginal(item.attachment);
      input.persist(item); return storedResult(item.attachment, false);
    } catch (error) {
      item.attachment.archive = { ...item.attachment.archive, state: 'needs-review', problem: '本次归档尚未确认完成，原件和进度已保留；重试会先核对同一操作。' }; input.persist(item); throw error;
    }
  }
  function archive(request: AttachmentArchiveRequest, signal?: AbortSignal): Promise<AttachmentArchiveResult> {
    if (running) { if (running.id === request.id) return running.done; return Promise.reject(new PublicApiError('ATTACHMENT_ARCHIVE_BUSY', '另一份附件正在归档，请稍后重试。', 409)); }
    const done = Promise.resolve().then(() => execute(request, signal)).finally(() => { if (running?.done === done) running = undefined; }); running = { id: request.id, done }; return done;
  }
  return { archive, close: async () => { try { await running?.done; } catch { /* Confirmed progress stays durable. */ } } };
}
