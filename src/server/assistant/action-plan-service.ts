import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  attachmentArchiveResultSchema,
  type Attachment,
  type AttachmentArchiveRequest,
  type AttachmentArchiveResult,
  type AttachmentPages
} from '../../shared/api/attachments.js';
import type { AssistantArchiveAction, AssistantAction, AssistantPlanAction } from '../../shared/api/assistant.js';
import { intakeFieldsSchema } from '../../shared/api/intake.js';
import { PublicApiError } from '../../shared/api/errors.js';
import type { AttachmentService } from '../attachments/service.js';
import type { AttachmentArchivePreview } from '../attachments/archive.js';
import {
  type ArchivePlanPayload,
  type AssistantActionPlanRecord,
  type AssistantActionPlanStore
} from './action-plan-store.js';

/** The confirmation window is deliberately short so a card cannot become an
 * unnoticed write permission after the source has been left unattended. */
export const ASSISTANT_ACTION_PLAN_TTL_MS = 30 * 60 * 1000;

export type AssistantAttachmentPlanPort = Pick<AttachmentService, 'get' | 'readPages' | 'preview' | 'archive'>;

export type ProposeArchiveInput = {
  conversationId: string;
  messageId: string;
  attachmentId: string;
  selection: { id: string; startPage: number; endPage: number };
  // Reuse the attachment request's exact-optional shape so this callback can
  // be passed directly from attachment-tools under `exactOptionalPropertyTypes`.
  fields?: AttachmentArchiveRequest['fields'];
};

export type ConfirmArchiveInput = {
  planId: string;
  conversationId: string;
  clientRequestId: string;
};

export type CancelArchiveInput = ConfirmArchiveInput;

/** Compatibility name used by the lifecycle contract; this remains a
 * server-only record and is never sent directly to the client. */
export type AssistantActionPlan = AssistantActionPlanRecord;

export type AssistantActionPlanResolution = {
  plan: AssistantActionPlan;
  result?: AttachmentArchiveResult;
};

export type AssistantActionPlanService = {
  proposeArchive(input: ProposeArchiveInput): Promise<AssistantPlanAction>;
  confirm(input: ConfirmArchiveInput): Promise<AssistantActionPlanResolution>;
  cancel(input: CancelArchiveInput): { plan: AssistantActionPlanRecord };
  /** Return the public card projection after re-reading the durable record. */
  get(planId: string, conversationId?: string): AssistantPlanAction;
  /** Internal projection used by the conversation service during refresh. */
  getRecord(planId: string, conversationId?: string): AssistantActionPlanRecord;
  /** Alias for callers that need the private record to resolve ownership. */
  getPlan(planId: string, conversationId?: string): AssistantActionPlanRecord;
  /** Project a completed archive into the existing archive receipt shape. */
  project(planId: string, conversationId?: string): AssistantAction | undefined;
  /** Refresh a saved action without exposing the server-owned payload. */
  refreshAction(action: AssistantAction, conversationId?: string): AssistantAction;
  /** Return the receipt when completed, otherwise the current plan card. */
  getAction(planId: string, conversationId?: string): AssistantAction;
  recover(): { stale: number; failed: number };
};

const nonEmptyId = z.string().min(1).max(255);
const sourceStaleCodes = new Set([
  'ATTACHMENT_NOT_FOUND', 'ATTACHMENT_CHANGED', 'ATTACHMENT_TEXT_MISSING', 'ATTACHMENT_PAGE_RANGE',
  'ATTACHMENT_SOURCE_CHANGED', 'ATTACHMENT_TITLE_CONFLICT', 'ATTACHMENT_ARCHIVE_MISSING', 'ATTACHMENT_ARCHIVE_ORIGINAL_CHANGED',
  'ATTACHMENT_ARCHIVE_PLAN_CHANGED', 'ATTACHMENT_ARCHIVE_CHANGED'
]);
const recoveryErrorCodes = new Set([
  'RECOVERY_REQUIRED',
  'INTAKE_RECOVERY_REQUIRED',
  'ARCHIVE_RECOVERY_REQUIRED',
  'ATTACHMENT_ARCHIVE_REVIEW',
  'ATTACHMENT_ARCHIVE_INCOMPLETE',
  'ATTACHMENT_ARCHIVE_COMMITTED_ORIGINAL_CHANGED',
  'ATTACHMENT_ARCHIVE_MISSING',
  'ATTACHMENT_ARCHIVE_ORIGINAL_CHANGED'
]);
/** Errors known to happen before this plan can publish or commit anything. An
 * unknown PublicApiError is deliberately recovery-required: a new native
 * error must not silently become an ordinary terminal failure after a partial
 * write. */
const safeNoWriteErrorCodes = new Set([
  'ATTACHMENT_NOT_FOUND',
  'ATTACHMENT_CHANGED',
  'ATTACHMENT_TEXT_MISSING',
  'ATTACHMENT_PAGE_RANGE',
  'ATTACHMENT_SOURCE_CHANGED',
  'ATTACHMENT_TITLE_CONFLICT',
  'ATTACHMENT_ARCHIVE_MISSING',
  'ATTACHMENT_ARCHIVE_ORIGINAL_CHANGED',
  'ATTACHMENT_ARCHIVE_PLAN_CHANGED',
  'ATTACHMENT_ARCHIVE_CHANGED',
  'ATTACHMENT_NOT_READY',
  'ATTACHMENT_ARCHIVE_UNAVAILABLE',
  'ATTACHMENT_ARCHIVE_BUSY',
  'ATTACHMENT_CLOSED'
]);
const pageSelectionSchema = z.strictObject({
  id: z.uuid(),
  startPage: z.number().int().positive(),
  endPage: z.number().int().positive()
}).refine(value => value.endPage >= value.startPage, '结束页码不能早于开始页码');

function fail(code: string, message: string, status = 409): never {
  throw new PublicApiError(code, message, status);
}

/** Hash only server-created canonical values; client request IDs are separate
 * idempotency keys and are never treated as a content fingerprint. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function actionNotFound(): never {
  return fail('ASSISTANT_ACTION_NOT_FOUND', '没有找到这条动作计划。', 404);
}

function actionConflict(): never {
  return fail('ASSISTANT_ACTION_CONFLICT', '这次确认标识已被使用，请重新确认。', 409);
}

function actionResolved(): never {
  return fail('ASSISTANT_ACTION_ALREADY_RESOLVED', '这条动作计划已经处理，不能重复确认。', 409);
}

function actionExpired(): never {
  return fail('ASSISTANT_ACTION_EXPIRED', '这条动作计划已过期，请重新生成。', 409);
}

function actionStale(): never {
  return fail('ASSISTANT_ACTION_STALE', '文件或解析结果已变化，未写入资料。', 409);
}

function actionRecoveryRequired(): never {
  return fail('ASSISTANT_ACTION_RECOVERY_REQUIRED', '上次归档未完成，请重新生成动作计划。', 409);
}

/** Keep the result parser at the service boundary. A malformed persisted
 * result must never be projected as a successful archive receipt. */
export function parseArchiveResult(value: unknown): AttachmentArchiveResult {
  const parsed = attachmentArchiveResultSchema.safeParse(value);
  if (!parsed.success) fail('ASSISTANT_ACTION_PLAN_INVALID', '归档回执无效，请刷新后重试。', 500);
  return parsed.data;
}

/** Upstream archive errors can contain paths or native details. Store only a
 * bounded, user-facing problem on the plan. */
export function publicActionProblem(error: unknown): string {
  const known: Record<string, string> = {
    ATTACHMENT_ARCHIVE_PLAN_CHANGED: '文件或解析版本已变化，未写入资料。',
    ATTACHMENT_ARCHIVE_CHANGED: '附件原件或暂存资料发生变化，未写入资料。',
    ATTACHMENT_TITLE_CONFLICT: '归档位置已有同名资料，未覆盖。',
    ATTACHMENT_NOT_READY: '附件尚未完成读取，未写入资料。',
    ATTACHMENT_ARCHIVE_UNAVAILABLE: '当前连接不能完成归档，原件已保留。',
    ATTACHMENT_ARCHIVE_BUSY: '另一份附件正在归档，请稍后重试。',
    ATTACHMENT_ARCHIVE_REVIEW: '归档已进入待核验状态，原件和恢复记录已保留。',
    ATTACHMENT_ARCHIVE_INCOMPLETE: '归档回执不完整，原件和恢复记录已保留。',
    ATTACHMENT_ARCHIVE_COMMITTED_ORIGINAL_CHANGED: '归档操作已有回执，但原件校验未完成；原件和恢复记录已保留，请继续核验。',
    ATTACHMENT_ARCHIVE_MISSING: '已有归档资料无法定位，未重复写入。',
    ATTACHMENT_ARCHIVE_ORIGINAL_CHANGED: '已归档原件发生变化，未重复写入。',
    ATTACHMENT_CLOSED: '应用正在关闭，原件已保留。',
    RECOVERY_REQUIRED: '归档需要继续核验，原件和恢复记录已保留。',
    INTAKE_RECOVERY_REQUIRED: '归档需要继续核验，原件和恢复记录已保留。'
  };
  const code = error instanceof PublicApiError ? error.code : error instanceof Error ? error.message : '';
  const message = known[code]
    ?? '归档未完成，原件和已完成步骤已保留。';
  return message.slice(0, 2000);
}

export function assertPlanBelongsToConversation(
  plan: AssistantActionPlanRecord | undefined,
  conversationId: string
): AssistantActionPlanRecord {
  if (!plan || plan.conversationId !== conversationId) return actionNotFound();
  return plan;
}

export function assertPendingAndUnexpired(plan: AssistantActionPlanRecord, now: Date): void {
  if (plan.recoveryRequired) return actionRecoveryRequired();
  if (plan.status === 'stale') return actionStale();
  if (plan.status !== 'pending') return actionResolved();
  if (Date.parse(plan.expiresAt) <= now.getTime()) return actionExpired();
}

export function wholeAttachment(attachment: Attachment): { id: string; startPage: number; endPage: number } {
  return { id: attachment.id, startPage: 1, endPage: attachment.pageCount ?? 1 };
}

function titleForSource(attachment: Attachment): string {
  return attachment.name.slice(0, 255);
}

function boundedSummary(attachment: Attachment, preview: AttachmentArchivePreview): string {
  const duplicate = preview.duplicate ? '（检测到相同内容，确认后将复用已有归档）' : '';
  return `将《${attachment.name}》归档到 ${preview.target}/${preview.mainName}${duplicate}`.slice(0, 2000);
}

function requestFingerprint(planId: string, action: 'confirm' | 'cancel'): string {
  return sha256(JSON.stringify({ planId, action }));
}

function requiresRecovery(error: unknown): boolean {
  const code = error instanceof PublicApiError ? error.code : error instanceof Error ? error.message : '';
  if (!(error instanceof PublicApiError)) return true;
  if (safeNoWriteErrorCodes.has(code)) return false;
  if (recoveryErrorCodes.has(code)) return true;
  return true;
}

function textRevisionMatches(expected: string | undefined, actual: string, allowEmptyExpected = false): boolean {
  if (expected === undefined) return true;
  return expected === actual || (allowEmptyExpected && expected === '');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

function archiveFieldsMatch(expected: ArchivePlanPayload['archiveFields'], actual: AttachmentArchivePreview['archiveFields']): boolean {
  return JSON.stringify(stableValue(expected)) === JSON.stringify(stableValue(actual));
}

function safeRequestId(value: string): string {
  const parsed = nonEmptyId.safeParse(value);
  if (!parsed.success) return fail('ASSISTANT_ACTION_REQUEST_INVALID', '确认编号无效，请重试。', 400);
  return parsed.data;
}

function sourceRangeFor(attachment: Attachment, selection: ProposeArchiveInput['selection']): ArchivePlanPayload['sourceRange'] {
  return {
    startPage: selection.startPage,
    endPage: selection.endPage,
    label: `${titleForSource(attachment)} · 第 ${selection.startPage}–${selection.endPage} 页`.slice(0, 255)
  };
}

function comparePlan(
  plan: AssistantActionPlanRecord,
  attachment: Attachment,
  selected: AttachmentPages,
  currentPreview: AttachmentArchivePreview
): boolean {
  const payload = plan.payload;
  const allowEmptyRevision = currentPreview.duplicate && payload.textRevision === '';
  return attachment.id === payload.attachmentId
    && attachment.name === payload.attachmentName
    && attachment.sha256 === payload.attachmentSha256
    && selected.id === payload.attachmentId
    && selected.sha256 === payload.attachmentSha256
    && textRevisionMatches(payload.textRevision, selected.textRevision, allowEmptyRevision)
    && (!payload.sourceRange || (selected.startPage === payload.sourceRange.startPage
      && (selected.endPage === payload.sourceRange.endPage || (selected.truncated && selected.endPage < payload.sourceRange.endPage && selected.totalPages >= payload.sourceRange.endPage))))
    && currentPreview.attachmentSha256 === payload.attachmentSha256
    && currentPreview.attachmentName === payload.attachmentName
    && currentPreview.mainSha256 === payload.mainSha256
    && currentPreview.target === payload.targetPath
    && currentPreview.mainName === payload.mainName
    && archiveFieldsMatch(payload.archiveFields, currentPreview.archiveFields)
    && textRevisionMatches(payload.textRevision, currentPreview.textRevision, allowEmptyRevision);
}

function assertLivePending(
  plan: AssistantActionPlanRecord,
  now: Date,
  markStale: (problem: string) => void
): void {
  try {
    assertPendingAndUnexpired(plan, now);
  } catch (error) {
    if (error instanceof PublicApiError && error.code === 'ASSISTANT_ACTION_EXPIRED') {
      try { markStale('确认已过期，未执行归档。'); } catch { /* The terminal transition is already authoritative. */ }
    }
    throw error;
  }
}

function resultFromRecord(record: AssistantActionPlanRecord): AttachmentArchiveResult | undefined {
  return record.resultPayload === undefined ? undefined : parseArchiveResult(record.resultPayload);
}

function isSourceStaleError(error: unknown): boolean {
  if (!(error instanceof PublicApiError)) return false;
  return sourceStaleCodes.has(error.code);
}

function archiveReceipt(record: AssistantActionPlanRecord): AssistantArchiveAction | undefined {
  const result = resultFromRecord(record);
  if (!result || result.state !== 'archived') return undefined;
  const resultActionId = record.resultActionId ?? `archive:${result.operationId}:${result.id}`;
  return {
    id: resultActionId,
    type: 'archive',
    label: '打开归档资料',
    attachmentId: result.id,
    materialPath: result.materialPath,
    materialTitle: record.payload.attachmentName,
    operationId: result.operationId,
    status: 'archived',
    duplicate: result.duplicate,
    indexed: result.indexed
  };
}

function ledgerResultForPlan(plan: AssistantActionPlanRecord, attachment: Attachment): AttachmentArchiveResult | undefined {
  const archive = attachment.archive;
  const payload = plan.payload;
  if (attachment.id !== payload.attachmentId || attachment.name !== payload.attachmentName || attachment.sha256 !== payload.attachmentSha256
    || (archive?.state !== 'archived' && archive?.state !== 'needs-review') || !archive.operationId || !archive.materialPath || !archive.target) return undefined;
  if (archive.target !== payload.targetPath || archive.materialPath !== `${payload.targetPath}/${payload.mainName}`) return undefined;
  const result = attachmentArchiveResultSchema.safeParse({
    id: attachment.id,
    state: archive.state,
    operationId: archive.operationId,
    materialPath: archive.materialPath,
    target: archive.target,
    indexed: archive.indexed ?? false,
    duplicate: payload.duplicate ?? Boolean(attachment.duplicateOf)
  });
  return result.success ? result.data : undefined;
}

export function createAssistantActionPlanService(input: {
  store: AssistantActionPlanStore;
  attachmentService: AssistantAttachmentPlanPort;
  now?: () => Date;
  clock?: () => Date;
  ttlMs?: number;
}): AssistantActionPlanService {
  const now = input.now ?? input.clock ?? (() => new Date());
  const ttlMs = input.ttlMs ?? ASSISTANT_ACTION_PLAN_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('ASSISTANT_ACTION_PLAN_TTL_INVALID');
  const inFlight = new Map<string, { requestId: string; promise: Promise<AssistantActionPlanResolution> }>();

  const getRecord = (planId: string, conversationId?: string): AssistantActionPlanRecord => {
    const id = safeRequestId(planId);
    try {
      return input.store.getServerRecord(id, conversationId);
    } catch (error) {
      if (error instanceof PublicApiError && (error.code === 'ASSISTANT_ACTION_NOT_FOUND' || error.code === 'ASSISTANT_ACTION_PLAN_NOT_FOUND')) return actionNotFound();
      throw error;
    }
  };

  const recover = (): { stale: number; failed: number } => {
    // First reconcile an archive ledger that was committed before the process
    // could persist the plan's completed state. This is read-only apart from
    // the plan row: it never calls archive() and therefore cannot duplicate a
    // file operation.
    let recoveredNeedsReview = 0;
    for (const record of input.store.listServerRecords()) {
      if (record.status !== 'running' && !(record.status === 'failed' && record.recoveryRequired)) continue;
      let attachment: Attachment;
      try { attachment = input.attachmentService.get(record.payload.attachmentId); }
      catch { continue; }
      const result = ledgerResultForPlan(record, attachment);
      if (!result) continue;
      try {
        const resultActionId = `archive:${result.operationId}:${result.id}`;
        if (result.state === 'archived') {
          input.store.markRecoveredCompleted(record.id, resultActionId, result);
        } else {
          input.store.markFailedWithResult(record.id, 'ASSISTANT_ACTION_RECOVERY_REQUIRED: 归档已进入待核验状态，原件和恢复记录已保留。', resultActionId, result);
          if (record.status === 'running') recoveredNeedsReview += 1;
        }
      } catch { /* A concurrent terminal transition remains authoritative. */ }
    }
    const outcome = input.store.recover();
    return { stale: outcome.stale, failed: outcome.failed + recoveredNeedsReview };
  };

  const priorForRequest = (clientRequestId: string, planId: string, fingerprint: string): AssistantActionPlanRecord | undefined => {
    const prior = input.store.findConfirmationRecord(clientRequestId);
    if (!prior) return undefined;
    if (prior.id !== planId || prior.confirmFingerprint !== fingerprint) return actionConflict();
    return prior;
  };

  const staleAndThrow = (planId: string, problem = '文件或解析版本已变化，未写入资料。'): never => {
    try { input.store.markStale(planId, problem); }
    catch {
      // The archive layer can perform one final revalidation after the plan is
      // marked running. Preserve the stale outcome in that narrow race rather
      // than leaving a running plan that recovery would mislabel as unknown.
      try {
        if (input.store.markStaleRunning) input.store.markStaleRunning(planId, problem);
        else input.store.markFailed(planId, problem);
      } catch {
        // A concurrent terminal transition remains authoritative. Re-read it
        // so a completed/cancelled/recovery plan is not reported as stale.
        try {
          const current = input.store.getServerRecord(planId);
          if (current.status === 'completed' || current.status === 'cancelled') return actionResolved();
          if (current.status === 'failed' && current.recoveryRequired) return actionRecoveryRequired();
          if (current.status === 'stale') return actionStale();
        } catch { /* Fall through to the conservative stale outcome. */ }
      }
    }
    return actionStale();
  };

  async function proposeArchive(value: ProposeArchiveInput): Promise<AssistantPlanAction> {
    const attachmentIdResult = z.uuid().safeParse(value.attachmentId);
    if (!attachmentIdResult.success) fail('ATTACHMENT_ID_INVALID', '附件编号无效，请重新选择文件。', 400);
    const attachmentId = attachmentIdResult.data;
    const selectionResult = pageSelectionSchema.safeParse(value.selection);
    if (!selectionResult.success) fail('ATTACHMENT_PAGE_RANGE', '所选页码无效，请重新选择。', 400);
    const selection = selectionResult.data;
    if (selection.id !== attachmentId) fail('ASSISTANT_ATTACHMENT_SCOPE', '只能为本轮选中的附件生成归档计划。', 403);
    const attachment = input.attachmentService.get(attachmentId);
    if (attachment.status !== 'ready' && attachment.status !== 'needs-ocr') {
      fail('ATTACHMENT_NOT_READY', attachment.problem || '文件尚未完成读取，请等待或重试。');
    }
    const totalPages = attachment.pageCount ?? 1;
    if (selection.startPage > totalPages || selection.endPage > totalPages) fail('ATTACHMENT_PAGE_RANGE', '所选页码超出文件范围，请重新选择。', 400);
    const fieldsResult = value.fields === undefined ? undefined : intakeFieldsSchema.partial().safeParse(value.fields);
    if (fieldsResult && !fieldsResult.success) fail('ASSISTANT_ACTION_FIELDS_INVALID', '归档字段无效，请重新生成计划。', 400);
    const fields = fieldsResult?.data;
    const request: AttachmentArchiveRequest = { id: attachmentId, ...(fields === undefined ? {} : { fields }) };
    const preview = await input.attachmentService.preview(request);
    const selected = input.attachmentService.readPages(selection);
    const previewRevisionMatches = textRevisionMatches(preview.textRevision, selected.textRevision, preview.duplicate && preview.textRevision === '');
    if (preview.attachmentId !== attachmentId || preview.attachmentSha256 !== attachment.sha256 || preview.attachmentName !== attachment.name
      || selected.id !== attachmentId || selected.sha256 !== attachment.sha256 || !previewRevisionMatches) return actionStale();
    const archiveFields = intakeFieldsSchema.parse(preview.archiveFields);
    const payload: ArchivePlanPayload = {
      attachmentId,
      attachmentName: attachment.name,
      attachmentSha256: attachment.sha256,
      archiveFields,
      textRevision: preview.duplicate && preview.textRevision === '' ? '' : selected.textRevision,
      sourceRange: sourceRangeFor(attachment, selection),
      targetPath: preview.target,
      mainName: preview.mainName,
      mainSha256: preview.mainSha256,
      duplicate: preview.duplicate,
      ...(attachment.duplicateOf ? { duplicateOf: attachment.duplicateOf } : {})
    };
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + ttlMs).toISOString();
    return input.store.create({
      conversationId: value.conversationId,
      messageId: value.messageId,
      label: '准备归档',
      sourceTitle: titleForSource(attachment),
      summary: boundedSummary(attachment, preview),
      payload,
      createdAt: createdAt.toISOString(),
      expiresAt
    });
  }

  async function runConfirm(value: ConfirmArchiveInput, plan: AssistantActionPlanRecord, fingerprint: string): Promise<AssistantActionPlanResolution> {
    assertLivePending(plan, now(), problem => input.store.markStale(plan.id, problem));
    let current: Attachment;
    try { current = input.attachmentService.get(plan.payload.attachmentId); }
    catch (error) {
      if (isSourceStaleError(error)) return staleAndThrow(plan.id);
      throw error;
    }
    const range = plan.payload.sourceRange
      ? { id: current.id, startPage: plan.payload.sourceRange.startPage, endPage: plan.payload.sourceRange.endPage }
      : wholeAttachment(current);
    let selected: AttachmentPages;
    let currentPreview: AttachmentArchivePreview;
    try {
      selected = input.attachmentService.readPages(range);
      const fields = intakeFieldsSchema.parse(plan.payload.archiveFields);
      currentPreview = await input.attachmentService.preview({ id: current.id, fields });
    } catch (error) {
      if (isSourceStaleError(error)) return staleAndThrow(plan.id);
      throw error;
    }
    if (!comparePlan(plan, current, selected, currentPreview)) return staleAndThrow(plan.id);
    let running: AssistantPlanAction;
    try {
      running = input.store.markRunning(plan.id, value.clientRequestId, fingerprint);
    } catch (error) {
      if (error instanceof PublicApiError && error.code === 'ASSISTANT_ACTION_EXPIRED') return actionExpired();
      if (error instanceof PublicApiError && error.code === 'ASSISTANT_ACTION_STALE') return actionStale();
      throw error;
    }
    // A same-request retry can observe the transition made by another caller.
    // Only the caller that owns the in-flight slot performs the file write.
    if (running.status !== 'running') {
      const persisted = getRecord(plan.id, value.conversationId);
      const result = resultFromRecord(persisted);
      return { plan: persisted, ...(result ? { result } : {}) };
    }
    let archiveResult: AttachmentArchiveResult | undefined;
    try {
      const fields = intakeFieldsSchema.parse(plan.payload.archiveFields);
      const request: AttachmentArchiveRequest = { id: current.id, fields };
      // Bind execution to the exact server preview that was revalidated above;
      // AttachmentService performs one more recomputation before its first
      // durable write and rejects a changed plan without publishing it.
      archiveResult = parseArchiveResult(await input.attachmentService.archive(request, undefined, currentPreview));
      if (archiveResult.state !== 'archived') {
        throw new PublicApiError('ATTACHMENT_ARCHIVE_REVIEW', '归档需要继续核验，原件和恢复记录已保留。', 409);
      }
      const resultActionId = `archive:${archiveResult.operationId}:${current.id}`;
      input.store.markCompleted(plan.id, resultActionId, archiveResult);
      const completed = getRecord(plan.id, value.conversationId);
      return { plan: completed, result: parseArchiveResult(completed.resultPayload ?? archiveResult) };
    } catch (error) {
      const code = error instanceof PublicApiError ? error.code : '';
      if (code === 'ATTACHMENT_ARCHIVE_PLAN_CHANGED' || code === 'ATTACHMENT_ARCHIVE_CHANGED' || code === 'ATTACHMENT_SOURCE_CHANGED'
        || code === 'ATTACHMENT_ARCHIVE_ORIGINAL_CHANGED' || code === 'ATTACHMENT_ARCHIVE_MISSING' || code === 'ATTACHMENT_TITLE_CONFLICT') return staleAndThrow(plan.id);
      try {
        const problem = publicActionProblem(error);
        const storedProblem = requiresRecovery(error) ? `ASSISTANT_ACTION_RECOVERY_REQUIRED: ${problem}` : problem;
        if (archiveResult !== undefined) {
          input.store.markFailedWithResult(plan.id, storedProblem, `archive:${archiveResult.operationId}:${current.id}`, archiveResult);
        } else {
          input.store.markFailed(plan.id, storedProblem);
        }
      } catch { /* Preserve the original failure and durable terminal state. */ }
      throw error;
    }
  }

  async function confirm(value: ConfirmArchiveInput): Promise<AssistantActionPlanResolution> {
    const clientRequestId = safeRequestId(value.clientRequestId);
    const plan = getRecord(value.planId, value.conversationId);
    const fingerprint = requestFingerprint(plan.id, 'confirm');
    const prior = priorForRequest(clientRequestId, plan.id, fingerprint);
    if (prior) {
      if (prior.status === 'completed' || prior.status === 'failed' || prior.status === 'cancelled' || prior.status === 'stale') {
        const result = resultFromRecord(prior);
        return { plan: prior, ...(result ? { result } : {}) };
      }
      const active = inFlight.get(plan.id);
      if (active && active.requestId === clientRequestId) return active.promise;
      if (prior.status === 'running') return actionRecoveryRequired();
    }
    const active = inFlight.get(plan.id);
    if (active) return active.requestId === clientRequestId ? active.promise : actionResolved();
    const work = runConfirm({ ...value, clientRequestId }, plan, fingerprint);
    const entry = { requestId: clientRequestId, promise: work };
    inFlight.set(plan.id, entry);
    try { return await work; } finally { if (inFlight.get(plan.id) === entry) inFlight.delete(plan.id); }
  }

  function cancel(value: CancelArchiveInput): { plan: AssistantActionPlanRecord } {
    const clientRequestId = safeRequestId(value.clientRequestId);
    const plan = getRecord(value.planId, value.conversationId);
    const fingerprint = requestFingerprint(plan.id, 'cancel');
    const prior = priorForRequest(clientRequestId, plan.id, fingerprint);
    if (prior) return { plan: prior };
    assertLivePending(plan, now(), problem => input.store.markStale(plan.id, problem));
    let cancelled: AssistantPlanAction;
    // Newer stores can persist cancellation idempotency in the same row. The
    // fallback keeps compatibility with the Task 1 store while the service is
    // usable in isolated unit fakes.
    const cancellable = input.store as AssistantActionPlanStore & {
      markCancelledWithRequest?: (id: string, requestId: string, requestFingerprint: string, problem?: string) => AssistantPlanAction;
    };
    if (cancellable.markCancelledWithRequest) cancelled = cancellable.markCancelledWithRequest(plan.id, clientRequestId, fingerprint);
    else cancelled = input.store.markCancelled(plan.id);
    const resolved = getRecord(plan.id, value.conversationId);
    // `cancelled` is intentionally read only to make a mocked store's return
    // value useful during tests; the fresh record is authoritative.
    void cancelled;
    return { plan: resolved };
  }

  function project(planId: string, conversationId?: string): AssistantAction | undefined {
    const record = getRecord(planId, conversationId);
    return archiveReceipt(record) ?? record.action;
  }

  function refreshAction(action: AssistantAction, conversationId?: string): AssistantAction {
    if (action.type !== 'plan') return action;
    try { return project(action.id, conversationId) ?? action; }
    catch (error) {
      // A deleted/foreign plan must not make an otherwise readable conversation
      // fail to load; retain the saved public card until the next refresh.
      if (error instanceof PublicApiError && error.code === 'ASSISTANT_ACTION_NOT_FOUND') return action;
      throw error;
    }
  }

  return {
    proposeArchive,
    confirm,
    cancel,
    get: (planId, conversationId) => getRecord(planId, conversationId).action,
    getRecord,
    getPlan: getRecord,
    project,
    refreshAction,
    getAction: (planId, conversationId) => project(planId, conversationId) ?? getRecord(planId, conversationId).action,
    recover
  };
}
