import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { intakeFieldsSchema } from '../../shared/api/intake.js';
import { assistantPlanActionSchema, type AssistantPlanAction } from '../../shared/api/assistant.js';
import { PublicApiError } from '../../shared/api/errors.js';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const sourceRangeSchema = z.strictObject({
  startPage: z.number().int().positive(),
  endPage: z.number().int().positive(),
  label: z.string().max(255)
}).refine(value => value.endPage >= value.startPage, '结束页码不能早于开始页码');

/** Complete archive data is server-owned and must never be serialized into an API action. */
export const archivePlanPayloadSchema = z.strictObject({
  attachmentId: z.uuid(),
  attachmentName: z.string().min(1).max(255),
  attachmentSha256: sha256,
  archiveFields: intakeFieldsSchema,
  textRevision: z.string().max(1_000_000).optional(),
  sourceRange: sourceRangeSchema.optional(),
  targetPath: z.string().min(1).max(4096),
  mainName: z.string().min(1).max(255),
  mainSha256: sha256,
  duplicate: z.boolean().optional(),
  duplicateOf: z.uuid().optional()
});
export type ArchivePlanPayload = z.infer<typeof archivePlanPayloadSchema>;

export type AssistantActionPlanStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stale';

const planState = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'stale']);
const serverPayloadSchema = z.strictObject({
  label: z.string(),
  sourceTitle: z.string().max(255),
  summary: z.string().max(2000),
  archivePayload: archivePlanPayloadSchema
});
const createInputSchema = z.strictObject({
  id: z.uuid().optional(),
  conversationId: z.string().min(1),
  messageId: z.string().min(1).max(255),
  label: z.string(),
  sourceTitle: z.string().max(255),
  summary: z.string().max(2000),
  payload: archivePlanPayloadSchema,
  fingerprint: z.string().min(1).max(512).optional(),
  createdAt: z.string().optional(),
  expiresAt: z.string()
});
export type CreateAssistantActionPlanInput = z.input<typeof createInputSchema>;

type Row = {
  id: string;
  conversation_id: string;
  message_id: string;
  kind: string;
  status: string;
  payload: string;
  fingerprint: string;
  created_at: string;
  expires_at: string;
  updated_at: string;
  confirm_request_id: string | null;
  confirm_fingerprint: string | null;
  result_action_id: string | null;
  result_payload: string | null;
  problem: string | null;
};

const MAX_JSON_BYTES = 1_000_000;
const RECOVERY_PROBLEM_PREFIX = 'ASSISTANT_ACTION_RECOVERY_REQUIRED:';
const invalid = (message = '动作计划记录无效，请刷新后重试。') => new PublicApiError('ASSISTANT_ACTION_PLAN_INVALID', message, 500);
const notFound = () => new PublicApiError('ASSISTANT_ACTION_NOT_FOUND', '没有找到这条动作计划。', 404);
const expired = () => new PublicApiError('ASSISTANT_ACTION_EXPIRED', '这条动作计划已过期，请重新生成。', 409);
const stale = () => new PublicApiError('ASSISTANT_ACTION_STALE', '文件或解析结果已变化，请重新生成动作计划。', 409);
const recoveryRequired = () => new PublicApiError('ASSISTANT_ACTION_RECOVERY_REQUIRED', '上次归档未完成，请重新生成动作计划。', 409);
const conflict = () => new PublicApiError('ASSISTANT_ACTION_CONFLICT', '这次确认标识已被使用，请重新确认。', 409);
const resolved = () => new PublicApiError('ASSISTANT_ACTION_ALREADY_RESOLVED', '这条动作计划已经处理，不能重复确认。', 409);

const parseJson = (value: string, label: string): unknown => {
  if (Buffer.byteLength(value, 'utf8') > MAX_JSON_BYTES) throw invalid(`${label}超过允许大小。`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw invalid(`${label}格式无效。`);
  }
};
const iso = (value: string): string => {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw invalid('动作计划时间无效。');
  return new Date(time).toISOString();
};
const serializeResult = (value: unknown): string | null => {
  if (value === undefined) return null;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_JSON_BYTES) throw invalid('结果载荷超过允许大小。');
    return serialized;
  } catch (error) {
    if (error instanceof PublicApiError) throw error;
    throw invalid('结果载荷格式无效。');
  }
};

/** Server-only representation; the public action intentionally omits these fields. */
export type AssistantActionPlanRecord = {
  id: string;
  conversationId: string;
  messageId: string;
  kind: 'archive';
  status: AssistantActionPlanStatus;
  payload: ArchivePlanPayload;
  fingerprint: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  confirmRequestId?: string;
  confirmFingerprint?: string;
  resultActionId?: string;
  resultPayload?: unknown;
  problem?: string;
  recoveryRequired: boolean;
  action: AssistantPlanAction;
};
/** Internal lifecycle name retained for service/tests; never serialize this record. */
export type AssistantActionPlan = AssistantActionPlanRecord;

export interface AssistantActionPlanStore {
  create(input: CreateAssistantActionPlanInput): AssistantPlanAction;
  /** Public projection; private payload and confirmation data are omitted. */
  get(id: string): AssistantPlanAction;
  /** Server-only record for the confirmation service. */
  getServerRecord(id: string, conversationId?: string): AssistantActionPlanRecord;
  /** Server-only scan used during startup reconciliation. */
  listServerRecords(): AssistantActionPlanRecord[];
  listForConversation(conversationId: string): AssistantPlanAction[];
  listServerRecordsForConversation(conversationId: string): AssistantActionPlanRecord[];
  markRunning(id: string, confirmRequestId: string, confirmFingerprint: string): AssistantPlanAction;
  markCompleted(id: string, resultActionId: string, resultPayload?: unknown): AssistantPlanAction;
  markFailed(id: string, problem: string): AssistantPlanAction;
  /** Persist a failed outcome while retaining a native/recovery result. */
  markFailedWithResult(id: string, problem: string, resultActionId?: string, resultPayload?: unknown): AssistantPlanAction;
  /** Reconcile a durable attachment receipt after a process restart. */
  markRecoveredCompleted(id: string, resultActionId: string, resultPayload: unknown): AssistantPlanAction;
  markCancelled(id: string, problem?: string): AssistantPlanAction;
  /** Persist cancellation idempotency in the same transition as the terminal state. */
  markCancelledWithRequest?(id: string, confirmRequestId: string, confirmFingerprint: string, problem?: string): AssistantPlanAction;
  markStale(id: string, problem?: string): AssistantPlanAction;
  /** Used when archive revalidation detects a source change after pending->running. */
  markStaleRunning?(id: string, problem?: string): AssistantPlanAction;
  findConfirmation(confirmRequestId: string): AssistantPlanAction | undefined;
  findConfirmationRecord(confirmRequestId: string): AssistantActionPlanRecord | undefined;
  assertConfirmationRequest(id: string, confirmRequestId: string, confirmFingerprint: string): AssistantPlanAction;
  recover(): { stale: number; failed: number };
}

export function createAssistantActionPlanStore(database: Database.Database, now: () => Date = () => new Date()): AssistantActionPlanStore {
  const select = (id: string): Row | undefined => database.prepare('SELECT * FROM assistant_action_plans WHERE id=?').get(id) as Row | undefined;

  const parseRow = (row: Row): AssistantActionPlanRecord => {
    if (row.kind !== 'archive' || !planState.safeParse(row.status).success) throw invalid();
    const raw = serverPayloadSchema.safeParse(parseJson(row.payload, '动作计划载荷'));
    if (!raw.success) throw invalid();
    const resultActionId = row.result_action_id === null ? undefined : z.string().min(1).max(255).safeParse(row.result_action_id);
    if (row.result_action_id !== null && !resultActionId?.success) throw invalid('结果动作编号无效。');
    const resultPayload = row.result_payload === null ? undefined : parseJson(row.result_payload, '结果载荷');
    const recovery = row.problem?.startsWith(RECOVERY_PROBLEM_PREFIX) ?? false;
    const publicProblem = row.problem === null ? undefined : recovery ? row.problem.slice(RECOVERY_PROBLEM_PREFIX.length).trim() : row.problem;
    if (publicProblem !== undefined && publicProblem.length > 2000) throw invalid();
    const actionResult = assistantPlanActionSchema.safeParse({
      id: row.id,
      type: 'plan',
      kind: 'archive',
      label: raw.data.label,
      status: row.status,
      attachmentId: raw.data.archivePayload.attachmentId,
      sourceTitle: raw.data.sourceTitle,
      sourceSha256: raw.data.archivePayload.attachmentSha256,
      targetPath: raw.data.archivePayload.targetPath,
      mainName: raw.data.archivePayload.mainName,
      summary: raw.data.summary,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      ...(row.result_action_id === null ? {} : { resultActionId: row.result_action_id }),
      ...(publicProblem === undefined ? {} : { problem: publicProblem })
    });
    if (!actionResult.success) throw invalid();
    return {
      id: row.id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      kind: 'archive',
      status: row.status as AssistantActionPlanStatus,
      payload: raw.data.archivePayload,
      fingerprint: row.fingerprint,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      updatedAt: row.updated_at,
      ...(row.confirm_request_id === null ? {} : { confirmRequestId: row.confirm_request_id }),
      ...(row.confirm_fingerprint === null ? {} : { confirmFingerprint: row.confirm_fingerprint }),
      ...(row.result_action_id === null ? {} : { resultActionId: row.result_action_id }),
      ...(resultPayload === undefined ? {} : { resultPayload }),
      ...(publicProblem === undefined ? {} : { problem: publicProblem }),
      recoveryRequired: recovery,
      action: actionResult.data
    };
  };

  const readRecord = (id: string, conversationId?: string): AssistantActionPlanRecord => {
    const row = select(id);
    if (!row || (conversationId !== undefined && row.conversation_id !== conversationId)) throw notFound();
    return parseRow(row);
  };
  const ensureRequest = (record: AssistantActionPlanRecord, requestId: string, fingerprint: string): void => {
    if (record.confirmRequestId === requestId && record.confirmFingerprint === fingerprint) return;
    if (record.confirmRequestId === requestId && record.confirmFingerprint !== fingerprint) throw conflict();
    throw resolved();
  };
  const updateTerminal = (
    id: string,
    expected: AssistantActionPlanStatus,
    status: AssistantActionPlanStatus,
    problem?: string,
    resultActionId?: string,
    resultPayload?: unknown
  ): AssistantPlanAction => database.transaction(() => {
    const current = readRecord(id);
    if (current.status !== expected) throw resolved();
    if (resultActionId !== undefined && !z.string().min(1).max(255).safeParse(resultActionId).success) throw invalid('结果动作编号无效。');
    if (problem !== undefined && problem.length > 2000) throw invalid('问题描述过长。');
    const serialized = serializeResult(resultPayload);
    database.prepare('UPDATE assistant_action_plans SET status=?,updated_at=?,problem=?,result_action_id=?,result_payload=? WHERE id=? AND status=?')
      .run(status, now().toISOString(), problem ?? null, resultActionId ?? null, serialized, id, expected);
    return readRecord(id).action;
  }).immediate();

  const recoverCompleted = (id: string, resultActionId: string, resultPayload: unknown): AssistantPlanAction => database.transaction(() => {
    const current = readRecord(id);
    if (current.status === 'completed') {
      if (current.resultActionId === resultActionId) return current.action;
      throw resolved();
    }
    const recoverable = current.status === 'running' || (current.status === 'failed' && current.recoveryRequired);
    if (!recoverable) throw resolved();
    if (!z.string().min(1).max(255).safeParse(resultActionId).success) throw invalid('结果动作编号无效。');
    const serialized = serializeResult(resultPayload);
    database.prepare('UPDATE assistant_action_plans SET status=\'completed\',updated_at=?,problem=NULL,result_action_id=?,result_payload=? WHERE id=? AND status IN (\'running\',\'failed\')')
      .run(now().toISOString(), resultActionId, serialized, id);
    return readRecord(id).action;
  }).immediate();

  const failWithResult = (id: string, problem: string, resultActionId?: string, resultPayload?: unknown): AssistantPlanAction => database.transaction(() => {
    const current = readRecord(id);
    if (current.status === 'failed' && current.recoveryRequired) {
      if (resultActionId !== undefined && current.resultActionId !== undefined && current.resultActionId !== resultActionId) throw resolved();
      if (problem.length > 2000) throw invalid('问题描述过长。');
      if (resultActionId !== undefined && !z.string().min(1).max(255).safeParse(resultActionId).success) throw invalid('结果动作编号无效。');
      const serialized = serializeResult(resultPayload);
      database.prepare('UPDATE assistant_action_plans SET updated_at=?,problem=?,result_action_id=COALESCE(?,result_action_id),result_payload=COALESCE(?,result_payload) WHERE id=? AND status=\'failed\'')
        .run(now().toISOString(), problem, resultActionId ?? null, serialized, id);
      return readRecord(id).action;
    }
    if (current.status !== 'running') throw resolved();
    if (resultActionId !== undefined && !z.string().min(1).max(255).safeParse(resultActionId).success) throw invalid('结果动作编号无效。');
    if (problem.length > 2000) throw invalid('问题描述过长。');
    const serialized = serializeResult(resultPayload);
    database.prepare('UPDATE assistant_action_plans SET status=\'failed\',updated_at=?,problem=?,result_action_id=?,result_payload=? WHERE id=? AND status=\'running\'')
      .run(now().toISOString(), problem, resultActionId ?? null, serialized, id);
    return readRecord(id).action;
  }).immediate();

  return {
    create(input) {
      const parsed = createInputSchema.parse(input);
      const payload = archivePlanPayloadSchema.parse(parsed.payload);
      const id = parsed.id ?? randomUUID();
      const createdAt = iso(parsed.createdAt ?? now().toISOString());
      const expiresAt = iso(parsed.expiresAt);
      if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new PublicApiError('ASSISTANT_ACTION_EXPIRED', '动作计划有效期无效。', 400);
      const serverPayload = serverPayloadSchema.parse({ label: parsed.label, sourceTitle: parsed.sourceTitle, summary: parsed.summary, archivePayload: payload });
      const serialized = JSON.stringify(serverPayload);
      const fingerprint = parsed.fingerprint ?? createHash('sha256').update(serialized).digest('hex');
      database.prepare('INSERT INTO assistant_action_plans(id,conversation_id,message_id,kind,status,payload,fingerprint,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, parsed.conversationId, parsed.messageId, 'archive', 'pending', serialized, fingerprint, createdAt, expiresAt, createdAt);
      return readRecord(id).action;
    },
    get(id) { return readRecord(id).action; },
    getServerRecord(id, conversationId) { return readRecord(id, conversationId); },
    listServerRecords() {
      return (database.prepare('SELECT * FROM assistant_action_plans ORDER BY created_at,id').all() as Row[]).map(parseRow);
    },
    listForConversation(conversationId) {
      return (database.prepare('SELECT * FROM assistant_action_plans WHERE conversation_id=? ORDER BY created_at,id').all(conversationId) as Row[]).map(row => parseRow(row).action);
    },
    listServerRecordsForConversation(conversationId) {
      return (database.prepare('SELECT * FROM assistant_action_plans WHERE conversation_id=? ORDER BY created_at,id').all(conversationId) as Row[]).map(parseRow);
    },
    markRunning(id, requestId, requestFingerprint) {
      const outcome = database.transaction((): { action: AssistantPlanAction; expired: boolean } => {
        const current = readRecord(id);
        if (current.status !== 'pending') {
          if (current.recoveryRequired) throw recoveryRequired();
          if (current.confirmRequestId === requestId) {
            if (current.confirmFingerprint !== requestFingerprint) throw conflict();
            return { action: current.action, expired: false };
          }
          if (current.status === 'stale') throw stale();
          throw resolved();
        }
        if (Date.parse(current.expiresAt) <= now().getTime()) {
          database.prepare('UPDATE assistant_action_plans SET status=\'stale\',updated_at=?,problem=? WHERE id=? AND status=\'pending\'')
            .run(now().toISOString(), '确认已过期，未执行归档。', id);
          return { action: readRecord(id).action, expired: true };
        }
        const existingConfirmation = database.prepare('SELECT id FROM assistant_action_plans WHERE confirm_request_id=?').get(requestId) as { id: string } | undefined;
        if (existingConfirmation && existingConfirmation.id !== id) throw conflict();
        database.prepare('UPDATE assistant_action_plans SET status=\'running\',confirm_request_id=?,confirm_fingerprint=?,updated_at=? WHERE id=? AND status=\'pending\'')
          .run(requestId, requestFingerprint, now().toISOString(), id);
        return { action: readRecord(id).action, expired: false };
      }).immediate();
      if (outcome.expired) throw expired();
      return outcome.action;
    },
    markCompleted(id, resultActionId, resultPayload) { return updateTerminal(id, 'running', 'completed', undefined, resultActionId, resultPayload); },
    markFailed(id, problem) { return updateTerminal(id, 'running', 'failed', problem); },
    markFailedWithResult(id, problem, resultActionId, resultPayload) { return failWithResult(id, problem, resultActionId, resultPayload); },
    markRecoveredCompleted(id, resultActionId, resultPayload) { return recoverCompleted(id, resultActionId, resultPayload); },
    markCancelled(id, problem) { return updateTerminal(id, 'pending', 'cancelled', problem); },
    markCancelledWithRequest(id, requestId, requestFingerprint, problem) {
      const outcome = database.transaction((): { action: AssistantPlanAction; expired: boolean } => {
        const current = readRecord(id);
        if (current.status !== 'pending') {
          if (current.confirmRequestId === requestId) {
            if (current.confirmFingerprint !== requestFingerprint) throw conflict();
            if (current.status === 'cancelled') return { action: current.action, expired: false };
          }
          throw resolved();
        }
        if (Date.parse(current.expiresAt) <= now().getTime()) {
          database.prepare('UPDATE assistant_action_plans SET status=\'stale\',updated_at=?,problem=? WHERE id=? AND status=\'pending\'')
            .run(now().toISOString(), '确认已过期，未执行归档。', id);
          return { action: readRecord(id).action, expired: true };
        }
        const existingConfirmation = database.prepare('SELECT id FROM assistant_action_plans WHERE confirm_request_id=?').get(requestId) as { id: string } | undefined;
        if (existingConfirmation && existingConfirmation.id !== id) throw conflict();
        if (problem !== undefined && problem.length > 2000) throw invalid('问题描述过长。');
        database.prepare('UPDATE assistant_action_plans SET status=\'cancelled\',updated_at=?,problem=?,confirm_request_id=?,confirm_fingerprint=? WHERE id=? AND status=\'pending\'')
          .run(now().toISOString(), problem ?? null, requestId, requestFingerprint, id);
        return { action: readRecord(id).action, expired: false };
      }).immediate();
      if (outcome.expired) throw expired();
      return outcome.action;
    },
    markStale(id, problem) { return updateTerminal(id, 'pending', 'stale', problem); },
    markStaleRunning(id, problem) { return updateTerminal(id, 'running', 'stale', problem); },
    findConfirmation(requestId) {
      const row = database.prepare('SELECT * FROM assistant_action_plans WHERE confirm_request_id=?').get(requestId) as Row | undefined;
      return row ? parseRow(row).action : undefined;
    },
    findConfirmationRecord(requestId) {
      const row = database.prepare('SELECT * FROM assistant_action_plans WHERE confirm_request_id=?').get(requestId) as Row | undefined;
      return row ? parseRow(row) : undefined;
    },
    assertConfirmationRequest(id, requestId, requestFingerprint) {
      const current = readRecord(id);
      ensureRequest(current, requestId, requestFingerprint);
      return current.action;
    },
    recover() {
      const current = now().toISOString();
      const staleCount = database.prepare("UPDATE assistant_action_plans SET status='stale',updated_at=?,problem=COALESCE(problem,?) WHERE status='pending' AND expires_at<=?")
        .run(current, '确认已过期，未执行归档。', current).changes;
      const failedCount = database.prepare("UPDATE assistant_action_plans SET status='failed',updated_at=?,problem=COALESCE(problem,?) WHERE status='running'")
        .run(current, `${RECOVERY_PROBLEM_PREFIX} 应用重启时发现未完成的归档，未重新执行文件写入。`).changes;
      return { stale: staleCount, failed: failedCount };
    }
  };
}
