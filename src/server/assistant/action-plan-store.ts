import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { intakeFieldsSchema } from '../../shared/api/intake.js';
import { assistantPlanActionSchema, type AssistantPlanAction } from '../../shared/api/assistant.js';
import { PublicApiError } from '../../shared/api/errors.js';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const sourceRangeSchema = z.strictObject({
  startPage: z.number().int().positive(), endPage: z.number().int().positive(), label: z.string().max(255)
}).refine(value => value.endPage >= value.startPage, '结束页码不能早于开始页码');

/** The archive payload deliberately stays on the server and is never exposed by the API. */
export const archivePlanPayloadSchema = z.strictObject({
  attachmentId: z.uuid(), attachmentName: z.string().min(1).max(255), attachmentSha256: sha256,
  archiveFields: intakeFieldsSchema, textRevision: z.string().max(1_000_000).optional(),
  sourceRange: sourceRangeSchema.optional(), targetPath: z.string().min(1).max(4096),
  mainName: z.string().min(1).max(255), mainSha256: sha256, duplicateOf: z.uuid().optional()
});
export type ArchivePlanPayload = z.infer<typeof archivePlanPayloadSchema>;

const planState = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'stale']);
const serverPayloadSchema = z.strictObject({
  label: z.string(), sourceTitle: z.string().max(255), summary: z.string().max(2000), archivePayload: archivePlanPayloadSchema
});
const createInputSchema = z.strictObject({
  id: z.uuid().optional(), conversationId: z.string().min(1), messageId: z.string().min(1).max(255),
  label: z.string(), sourceTitle: z.string().max(255), summary: z.string().max(2000),
  payload: archivePlanPayloadSchema, fingerprint: z.string().min(1).max(512).optional(),
  createdAt: z.string().optional(), expiresAt: z.string()
});
export type CreateAssistantActionPlanInput = z.input<typeof createInputSchema>;

type Row = {
  id: string; conversation_id: string; message_id: string; kind: string; status: string; payload: string;
  fingerprint: string; created_at: string; expires_at: string; updated_at: string; confirm_request_id: string | null;
  confirm_fingerprint: string | null; result_action_id: string | null; result_payload: string | null; problem: string | null;
};

const MAX_JSON_BYTES = 1_000_000;
const invalid = (message = '动作计划记录无效，请刷新后重试。') => new PublicApiError('ASSISTANT_ACTION_PLAN_INVALID', message, 500);
const notFound = () => new PublicApiError('ASSISTANT_ACTION_PLAN_NOT_FOUND', '没有找到这条动作计划。', 404);
const conflict = () => new PublicApiError('ASSISTANT_ACTION_CONFLICT', '这次确认标识已被使用，请重新确认。', 409);
const resolved = () => new PublicApiError('ASSISTANT_ACTION_ALREADY_RESOLVED', '这条动作计划已经处理，不能重复确认。', 409);
const parseJson = (value: string, label: string): unknown => {
  if (Buffer.byteLength(value, 'utf8') > MAX_JSON_BYTES) throw invalid(`${label}超过允许大小。`);
  try { return JSON.parse(value); } catch { throw invalid(`${label}格式无效。`); }
};
const iso = (value: string): string => {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw invalid('动作计划时间无效。');
  return new Date(time).toISOString();
};

export interface AssistantActionPlanStore {
  create(input: CreateAssistantActionPlanInput): AssistantPlanAction;
  get(id: string): AssistantPlanAction;
  listForConversation(conversationId: string): AssistantPlanAction[];
  markRunning(id: string, confirmRequestId: string, confirmFingerprint: string): AssistantPlanAction;
  markCompleted(id: string, resultActionId: string, resultPayload?: unknown): AssistantPlanAction;
  markFailed(id: string, problem: string): AssistantPlanAction;
  markCancelled(id: string, problem?: string): AssistantPlanAction;
  markStale(id: string, problem?: string): AssistantPlanAction;
  findConfirmation(confirmRequestId: string): AssistantPlanAction | undefined;
  assertConfirmationRequest(id: string, confirmRequestId: string, confirmFingerprint: string): AssistantPlanAction;
  recover(): { stale: number; failed: number };
}

export function createAssistantActionPlanStore(database: Database.Database, now: () => Date = () => new Date()): AssistantActionPlanStore {
  const select = (id: string): Row | undefined => database.prepare('SELECT * FROM assistant_action_plans WHERE id=?').get(id) as Row | undefined;
  const project = (row: Row): AssistantPlanAction => {
    if (row.kind !== 'archive' || !planState.safeParse(row.status).success) throw invalid();
    const raw = serverPayloadSchema.safeParse(parseJson(row.payload, '动作计划载荷'));
    if (!raw.success) throw invalid();
    const resultActionId = row.result_action_id ? z.uuid().safeParse(row.result_action_id) : { success: true } as const;
    if (!resultActionId.success) throw invalid();
    if (row.problem !== null && row.problem.length > 2000) throw invalid();
    const value = assistantPlanActionSchema.safeParse({
      id: row.id, type: 'plan', kind: 'archive', label: raw.data.label, status: row.status,
      attachmentId: raw.data.archivePayload.attachmentId, sourceTitle: raw.data.sourceTitle,
      sourceSha256: raw.data.archivePayload.attachmentSha256, targetPath: raw.data.archivePayload.targetPath,
      mainName: raw.data.archivePayload.mainName, summary: raw.data.summary,
      createdAt: row.created_at, expiresAt: row.expires_at,
      ...(row.result_action_id ? { resultActionId: row.result_action_id } : {}), ...(row.problem ? { problem: row.problem } : {})
    });
    if (!value.success) throw invalid();
    return value.data;
  };
  const read = (id: string): { row: Row; action: AssistantPlanAction } => {
    const row = select(id); if (!row) throw notFound(); return { row, action: project(row) };
  };
  const ensureRequest = (row: Row, requestId: string, fingerprint: string): void => {
    if (row.confirm_request_id === requestId && row.confirm_fingerprint === fingerprint) return;
    if (row.confirm_request_id === requestId && row.confirm_fingerprint !== fingerprint) throw conflict();
    throw resolved();
  };
  const updateTerminal = (id: string, expected: string, status: string, problem?: string, resultActionId?: string, resultPayload?: unknown): AssistantPlanAction => database.transaction(() => {
    const current = read(id);
    if (current.row.status !== expected) throw resolved();
    if (resultActionId !== undefined && !z.uuid().safeParse(resultActionId).success) throw invalid('结果动作编号无效。');
    const serialized = resultPayload === undefined ? null : JSON.stringify(resultPayload);
    if (serialized !== null && Buffer.byteLength(serialized, 'utf8') > MAX_JSON_BYTES) throw invalid('结果载荷超过允许大小。');
    database.prepare('UPDATE assistant_action_plans SET status=?,updated_at=?,problem=?,result_action_id=?,result_payload=? WHERE id=? AND status=?')
      .run(status, now().toISOString(), problem ?? null, resultActionId ?? null, serialized, id, expected);
    return read(id).action;
  }).immediate();
  return {
    create(input) {
      const parsed = createInputSchema.parse(input);
      const payload = archivePlanPayloadSchema.parse(parsed.payload);
      const id = parsed.id ?? randomUUID();
      const createdAt = iso(parsed.createdAt ?? now().toISOString());
      const expiresAt = iso(parsed.expiresAt);
      if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new PublicApiError('ASSISTANT_ACTION_PLAN_EXPIRED', '动作计划有效期无效。', 400);
      const serverPayload = serverPayloadSchema.parse({ label: parsed.label, sourceTitle: parsed.sourceTitle, summary: parsed.summary, archivePayload: payload });
      const serialized = JSON.stringify(serverPayload);
      const fingerprint = parsed.fingerprint ?? createHash('sha256').update(serialized).digest('hex');
      database.prepare('INSERT INTO assistant_action_plans(id,conversation_id,message_id,kind,status,payload,fingerprint,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, parsed.conversationId, parsed.messageId, 'archive', 'pending', serialized, fingerprint, createdAt, expiresAt, createdAt);
      return read(id).action;
    },
    get(id) { return read(id).action; },
    listForConversation(conversationId) {
      return (database.prepare('SELECT * FROM assistant_action_plans WHERE conversation_id=? ORDER BY created_at,id').all(conversationId) as Row[]).map(project);
    },
    markRunning(id, requestId, requestFingerprint) {
      return database.transaction(() => {
        const current = read(id);
        if (current.row.status !== 'pending') {
          if (current.row.confirm_request_id === requestId && current.row.confirm_fingerprint === requestFingerprint && current.row.status === 'running') return current.action;
          if (current.row.confirm_request_id === requestId && current.row.confirm_fingerprint !== requestFingerprint) throw conflict();
          throw resolved();
        }
        if (Date.parse(current.row.expires_at) <= now().getTime()) {
          database.prepare('UPDATE assistant_action_plans SET status=\'stale\',updated_at=?,problem=? WHERE id=? AND status=\'pending\'').run(now().toISOString(), '确认已过期，未执行归档。', id);
          throw resolved();
        }
        if (current.row.confirm_request_id !== null) ensureRequest(current.row, requestId, requestFingerprint);
        database.prepare('UPDATE assistant_action_plans SET status=\'running\',confirm_request_id=?,confirm_fingerprint=?,updated_at=? WHERE id=? AND status=\'pending\'')
          .run(requestId, requestFingerprint, now().toISOString(), id);
        return read(id).action;
      }).immediate();
    },
    markCompleted(id, resultActionId, resultPayload) { return updateTerminal(id, 'running', 'completed', undefined, resultActionId, resultPayload); },
    markFailed(id, problem) { return updateTerminal(id, 'running', 'failed', problem); },
    markCancelled(id, problem) { return updateTerminal(id, 'pending', 'cancelled', problem); },
    markStale(id, problem) { return updateTerminal(id, 'pending', 'stale', problem); },
    findConfirmation(requestId) {
      const row = database.prepare('SELECT * FROM assistant_action_plans WHERE confirm_request_id=?').get(requestId) as Row | undefined;
      return row ? project(row) : undefined;
    },
    assertConfirmationRequest(id, requestId, requestFingerprint) {
      const current = read(id);
      ensureRequest(current.row, requestId, requestFingerprint);
      return current.action;
    },
    recover() {
      const current = now().toISOString();
      const stale = database.prepare("UPDATE assistant_action_plans SET status='stale',updated_at=?,problem=COALESCE(problem,?) WHERE status='pending' AND expires_at<=?").run(current, '确认已过期，未执行归档。', current).changes;
      const failed = database.prepare("UPDATE assistant_action_plans SET status='failed',updated_at=?,problem=COALESCE(problem,?) WHERE status='running'").run(current, '应用重启时发现未完成的归档，未重新执行文件写入。').changes;
      return { stale, failed };
    }
  };
}
