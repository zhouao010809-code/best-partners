import { randomUUID } from 'node:crypto';
import { intakeFieldsSchema, type IntakeList, type IntakePreview, type IntakePreviewRequest, type IntakeOutcome } from '../../shared/api/intake.js';
import { PublicApiError } from '../../shared/api/errors.js';
import { captureArchiveTree } from '../archive/archive-snapshot.js';
import { executeIntakeArchive, listIntakeArchives, prepareIntakeArchive, type IntakeArchiveOutcome } from '../archive/intake-archive.js';
import { inferIntakeFields, planIntakeMain, IntakePlanError } from '../archive/intake-plan.js';
import type { PersonalArchivePort } from '../archive/sandbox-native.js';

export interface IntakeService {
  history?(): IntakeArchiveOutcome[];
  list(): Promise<IntakeList>;
  preview(request: IntakePreviewRequest): Promise<IntakePreview>;
  commit(token: string, signal?: AbortSignal): Promise<IntakeOutcome>;
  resume(id: string, signal?: AbortSignal): Promise<IntakeOutcome>;
}
const INTAKE = '01图书馆/小兆clipper';
const unavailable = '收件暂不可用，原文件没有被自动修改。请检查文件夹连接或重新打开 App。';
function publicFailure(error: unknown): PublicApiError {
  if (error instanceof PublicApiError) return error;
  if (error instanceof IntakePlanError) return new PublicApiError('VALIDATION_ERROR', error.message, 400);
  const code = error instanceof Error ? error.message : '';
  const messages: Record<string, string> = {
    INTAKE_TARGET_EXISTS: '归档位置已有同名资料，没有覆盖。请调整标题后重新预览。',
    INTAKE_PREVIEW_STALE: '预览之后资料发生了变化。请重新预览，确认最新内容。',
    INTAKE_LINK_REVIEW_REQUIRED: '包内有多个 Markdown，改名可能影响互相引用。本次未归档，需先核对文件引用。',
    INTAKE_RECOVERY_REQUIRED: '有一项未完成的归档，请先在下方继续核验。',
    INTAKE_TOO_LARGE: '资料包超出当前安全处理大小，原文件已保留。'
  };
  return new PublicApiError('RECOVERY_REQUIRED', messages[code] ?? '归档未完成。原文件与恢复记录均保留，请刷新收件箱查看待处理项。', 409);
}

export function createIntakeService(input: {
  port: PersonalArchivePort; ruleFingerprint: string; getRuleFingerprint(): Promise<string>;
  refreshIndex(): Promise<boolean>; now?: () => number;
}): IntakeService {
  const port = input.port; const now = input.now ?? Date.now;
  type PreviewState = { expires: number; source: string; tree: ReturnType<typeof captureArchiveTree>;
    plan: ReturnType<typeof planIntakeMain>; operationId?: string };
  const previews = new Map<string, PreviewState>();
  let busy = false;
  function expire() { for (const [token, p] of previews) if (p.expires < now()) previews.delete(token); }
  async function currentRules() {
    if (await input.getRuleFingerprint() !== input.ruleFingerprint) {
      throw new PublicApiError('RECOVERY_REQUIRED', '大脑规则已变化，归档已暂停。请重新打开 App 后核对规则。', 409);
    }
  }
  async function finish(outcome: IntakeArchiveOutcome): Promise<IntakeOutcome> {
    let indexed = false;
    if (outcome.state === 'archived') { try { indexed = await input.refreshIndex(); } catch { /* File receipt remains authoritative. */ } }
    return { ...outcome, indexed };
  }
  async function exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (busy) throw new PublicApiError('INDEX_BUSY', '上一项归档正在核验，请稍等。', 409);
    busy = true;
    try { return await action(); } catch (error) { throw publicFailure(error); } finally { busy = false; }
  }
  return {
    history: () => listIntakeArchives(port),
    async list() {
      try {
        expire();
        const entries = port.listIntake().filter((entry) => entry.name !== '.gitkeep');
        const items: IntakeList['items'] = entries.slice(0, 200).map((entry) => {
          const item: IntakeList['items'][number] = { ...entry, mainCandidates: [], fields: {} };
          if (entry.kind !== 'directory') return { ...item, problem: '这是单个文件，当前需按资料包归档；尚未移动。' };
          try {
            const source = `${INTAKE}/${entry.name}`;
            item.mainCandidates = port.list(source).filter((child) => child.kind === 'file' && /\.md$/u.test(child.name)).map((child) => child.name).sort().slice(0, 100);
            if (!item.mainCandidates.length) item.problem = '没有找到主 Markdown，文件和附件均保持原样。';
            else if (item.mainCandidates.length === 1) {
              const path = `${source}/${item.mainCandidates[0]}`;
              if ((port.stat(path)?.size ?? Infinity) <= 256 * 1024) {
                const fields = intakeFieldsSchema.partial().safeParse(inferIntakeFields(item.mainCandidates[0]!, port.read(path)));
                if (fields.success) item.fields = fields.data;
                else item.problem = '资料信息超出显示范围，请在预览中核对并补充；原文件保持不变。';
              }
            }
          } catch (error) { item.problem = error instanceof IntakePlanError ? error.message : '资料正在写入或暂不能安全读取，请稍后刷新。'; }
          return item;
        });
        const operations = listIntakeArchives(port);
        const pending = operations.filter((op) => op.state !== 'archived');
        return { available: true, automaticArchive: false, items,
          operations: [...pending, ...operations.filter((op) => op.state === 'archived').slice(-Math.max(0, 200 - pending.length))].slice(0,200),
          ...(entries.length > 200 ? { problem: '当前显示前 200 项，处理后会显示余下资料。' } : {}) };
      } catch { return { available: false, automaticArchive: false, items: [], operations: [], problem: unavailable }; }
    },
    async preview(request) {
      try {
        await currentRules(); expire();
        if (previews.size >= 10) previews.delete(previews.keys().next().value!);
        const source = `${INTAKE}/${request.name}`;
        const tree = captureArchiveTree(port, source);
        const main = tree.find((entry) => entry.path === request.mainName);
        if (main?.kind !== 'file') throw new PublicApiError('VALIDATION_ERROR', '请选择资料包中的主 Markdown。', 400);
        const plan = planIntakeMain({ packageName: request.name, mainName: request.mainName,
          bytes: Buffer.from(main.bytesBase64, 'base64'), fields: request.fields });
        if (plan.mainName !== plan.sourceMainName && tree.some((e) => e.kind === 'file' && /\.md$/iu.test(e.path) && e.path !== plan.sourceMainName)) {
          throw new Error('INTAKE_LINK_REVIEW_REQUIRED');
        }
        const token = randomUUID(); const expires = now() + 5 * 60_000;
        previews.set(token, { source, tree, plan, expires });
        const markdown = new TextDecoder('utf-8', { fatal: true }).decode(plan.bytes);
        return { token, target: `01图书馆/来自${plan.platform}/${plan.month}/${plan.packageName}`, mainName: plan.mainName,
          markdown: markdown.slice(0, 30000), truncated: markdown.length > 30000, expiresAt: new Date(expires).toISOString() };
      } catch (error) { throw publicFailure(error); }
    },
    commit: (token, signal) => exclusive(async () => {
      signal?.throwIfAborted(); await currentRules(); signal?.throwIfAborted(); expire(); const preview = previews.get(token);
      if (!preview) throw new PublicApiError('VERSION_CONFLICT', '预览已过期或 App 已重启，请重新预览。', 409);
      preview.operationId ??= prepareIntakeArchive(port, { source: preview.source, tree: preview.tree,
        plan: preview.plan, ruleFingerprint: input.ruleFingerprint }).id;
      return finish(executeIntakeArchive(port, preview.operationId, input.ruleFingerprint));
    }),
    resume: (id, signal) => exclusive(async () => {
      signal?.throwIfAborted(); await currentRules(); signal?.throwIfAborted(); return finish(executeIntakeArchive(port, id, input.ruleFingerprint));
    })
  };
}
