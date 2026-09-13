# 问问受控知识动作确认层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 让问问对明确的附件归档请求先生成持久化动作计划，用户确认后才调用现有归档事务，并在取消、失效、重启、重复请求和失败时保持可追溯、可恢复且不重复写入。

**Architecture:** 保留现有只读问答、引用和候选审阅链路。新增独立的 AssistantActionPlanStore/Service 保存服务端生成的归档计划；附件归档层拆出纯预览入口，确认 API 重新校验预览指纹后复用原有 AttachmentService.archive。前端把计划作为新的 assistant action 卡片展示，确认和取消均通过现有 CSRF 保护的 API 完成。

**Tech Stack:** TypeScript, Zod, Fastify, better-sqlite3, React, Vitest, Playwright, existing native personal archive and intake services.

---

## 现状和执行约束

- 工作目录：/Users/ao/Desktop/AO/04AI应用/xiaozhao-brain-console/.worktrees/desktop-read。
- 当前分支：desktop-read；设计文档提交为 ce78190。
- 不新增任意路径写入、终端、浏览器或多 Agent 执行能力。
- 所有文件变化继续经过 AttachmentService、IntakeService 和既有原生归档恢复协议。
- 不修改候选正式入库边界；prepare_attachment_extraction 和候选审阅保持现有行为。
- 每个任务都先写失败测试、运行确认失败，再写最小实现；每个任务完成后单独提交并做规范审查和代码质量审查。

## 文件变更总览

### 新增

- src/server/db/migrations/016_assistant_action_plans.sql：动作计划表和索引。
- src/server/assistant/action-plan-store.ts：SQLite 计划记录的 schema、读写和状态转换。
- src/server/assistant/action-plan-service.ts：归档计划创建、确认、取消、恢复和幂等执行。
- src/client/components/assistant/AssistantActionPlanCard.tsx：计划卡及确认对话框。
- tests/unit/assistant-action-plan-store.test.ts：存储状态机和幂等测试。
- tests/integration/assistant-action-plan.test.ts：服务端动作计划集成测试。
- tests/electron/assistant-action-plan.test.ts：桌面完整流程。

### 修改

- src/server/db/migrate.ts、src/shared/api/assistant.ts
- src/server/assistant/types.ts、attachment-tools.ts、service.ts、deepseek-adapter.ts、presentation.ts
- src/server/attachments/archive.ts、service.ts
- src/server/api/routes/assistant.ts、src/server/app.ts
- src/client/api/client.ts、AssistantMessageView.tsx、AssistantPanel.tsx、styles/assistant.css
- 现有 assistant、attachment、migration 测试和产品文档。

---

### Task 1: 建立动作计划共享契约和持久化存储

**Files:**

- Create: src/server/db/migrations/016_assistant_action_plans.sql
- Modify: src/server/db/migrate.ts
- Modify: src/shared/api/assistant.ts
- Create: src/server/assistant/action-plan-store.ts
- Create: tests/unit/assistant-action-plan-store.test.ts
- Modify: tests/integration/personal-trash-service.test.ts
- Modify: tests/integration/database-kernel.test.ts

- [ ] **Step 1: Write the failing store tests**

在 tests/unit/assistant-action-plan-store.test.ts 建立内存 SQLite fixture，覆盖创建、状态转换、重复确认和确认编号冲突：

~~~ts
it('creates a pending archive plan with server-owned payload', () => {
  const plan = store.create({
    id: randomUUID(), conversationId, messageId, kind: 'archive',
    payload: {
      attachmentId, attachmentName: '资料.pdf', attachmentSha256: 'a'.repeat(64),
      archiveFields: { title: '资料' }, targetPath: '01图书馆/来自个人/2026-09/资料',
      mainName: '原文.md', mainSha256: 'b'.repeat(64)
    },
    fingerprint: 'c'.repeat(64), createdAt, expiresAt
  });
  expect(plan).toMatchObject({ status: 'pending', kind: 'archive', conversationId, messageId });
  expect(store.get(plan.id)?.payload.attachmentSha256).toBe('a'.repeat(64));
});

it('allows one confirmation transition and returns its result on retry', () => {
  const plan = fixturePlan();
  const requestId = randomUUID();
  expect(store.markRunning(plan.id, requestId, 'fingerprint-1').status).toBe('running');
  store.markCompleted(plan.id, 'archive-action-1', { state: 'archived' });
  expect(store.findConfirmation(requestId)).toMatchObject({ planId: plan.id, resultActionId: 'archive-action-1' });
  expect(() => store.markRunning(plan.id, randomUUID(), 'fingerprint-2')).toThrow();
});

it('rejects a different fingerprint for an existing confirmation id', () => {
  const plan = fixturePlan();
  const requestId = randomUUID();
  store.markRunning(plan.id, requestId, 'fingerprint-1');
  expect(() => store.assertConfirmationRequest(requestId, 'different')).toThrow(/conflict/i);
});
~~~

- [ ] **Step 2: Run the focused test and verify it fails**

Run: npm run test:unit -- tests/unit/assistant-action-plan-store.test.ts

Expected: FAIL because migration 016, the store module, and the plan schema do not exist. Fix only test setup errors; do not add production code before this failure is observed.

- [ ] **Step 3: Add migration 016 and register it**

Create the migration with the exact columns needed for plan payload, confirmation idempotency, result projection, and conversation lookup:

~~~sql
CREATE TABLE assistant_action_plans (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id),
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'archive'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'stale')),
  payload TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirm_request_id TEXT UNIQUE,
  confirm_fingerprint TEXT,
  result_action_id TEXT,
  result_payload TEXT,
  problem TEXT
);
CREATE INDEX assistant_action_plans_conversation_idx
  ON assistant_action_plans(conversation_id, created_at);
~~~

Append version 16 after version 15 in initialMigrations() in src/server/db/migrate.ts.

- [ ] **Step 4: Add strict shared schemas and types**

In src/shared/api/assistant.ts add assistantPlanActionSchema and include it in assistantActionSchema. The client action exposes status, attachment ID, source title/hash, server target, summary, timestamps and result ID; it does not expose confirmation fingerprints or raw result payload.

~~~ts
export const assistantPlanActionSchema = z.strictObject({
  id: z.uuid(), type: z.literal('plan'), kind: z.literal('archive'),
  label: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'stale']),
  attachmentId: z.uuid(), sourceTitle: z.string().max(255), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  targetPath: z.string().min(1).max(4096), mainName: z.string().min(1).max(255), summary: z.string().max(2000),
  createdAt: z.string(), expiresAt: z.string(),
  resultActionId: z.string().optional(), problem: z.string().optional()
});
export type AssistantPlanAction = z.infer<typeof assistantPlanActionSchema>;
export const assistantActionSchema = z.discriminatedUnion('type', [assistantReviewActionSchema, assistantArchiveActionSchema, assistantPlanActionSchema]);
~~~

- [ ] **Step 5: Implement the store with explicit transitions**

Create `src/server/assistant/action-plan-store.ts` with this boundary (the implementation may use prepared statements, but callers must not issue SQL directly):

~~~ts
import type Database from 'better-sqlite3';
type AssistantActionPlan = {
  id: string; conversationId: string; messageId: string; kind: 'archive'; status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stale';
  payload: ArchivePlanPayload; fingerprint: string; createdAt: string; expiresAt: string; updatedAt: string;
  confirmRequestId?: string; confirmFingerprint?: string; resultActionId?: string; resultPayload?: unknown; problem?: string;
};
type NewAssistantActionPlan = Omit<AssistantActionPlan, 'status' | 'updatedAt'> & { status?: 'pending'; updatedAt?: string };

export type AssistantActionPlanStore = {
  create(input: NewAssistantActionPlan): AssistantActionPlan;
  get(id: string): AssistantActionPlan | undefined;
  listForConversation(conversationId: string): AssistantActionPlan[];
  markRunning(id: string, requestId: string, requestFingerprint: string): AssistantActionPlan;
  markCompleted(id: string, resultActionId: string, resultPayload: unknown): AssistantActionPlan;
  markFailed(id: string, problem: string): AssistantActionPlan;
  markCancelled(id: string): AssistantActionPlan;
  markStale(id: string, problem: string): AssistantActionPlan;
  findConfirmation(requestId: string): AssistantActionPlan | undefined;
  assertConfirmationRequest(requestId: string, fingerprint: string): AssistantActionPlan | undefined;
  recover(now: Date): void;
};
export function createAssistantActionPlanStore(database: Database.Database, now: () => Date): AssistantActionPlanStore;
~~~

Define a validated `ArchivePlanPayload` containing `attachmentId`, `attachmentName`, `attachmentSha256`, `archiveFields`, optional `textRevision`, optional `sourceRange` (`{ startPage, endPage, label }`), `targetPath`, `mainName`, `mainSha256` and optional `duplicateOf`.

Implement `create`, `get`, `listForConversation`, `markRunning`, `markCompleted`, `markFailed`, `markCancelled`, `markStale`, `findConfirmation`, `assertConfirmationRequest` and `recover` with one explicit transition guard:

~~~ts
const terminal = new Set<AssistantActionPlan['status']>(['completed', 'failed', 'cancelled', 'stale']);
function assertTransition(plan: AssistantActionPlan, next: AssistantActionPlan['status']): void {
  if (terminal.has(plan.status) || ((next === 'running' || next === 'cancelled') && plan.status !== 'pending')) {
    throw new PublicApiError('ASSISTANT_ACTION_ALREADY_RESOLVED', '该动作计划已处理，不能重复执行。', 409);
  }
}
~~~

Parse every row through Zod. Store `confirm_request_id` and its request fingerprint in the same update that changes `pending` to `running`; a duplicate request with the same fingerprint returns the existing plan, while a different fingerprint throws `ASSISTANT_ACTION_CONFLICT`. `recover(now)` marks expired pending plans `stale` and changes no files; it also changes abandoned `running` plans to `failed` with `ASSISTANT_ACTION_RECOVERY_REQUIRED` so restart cannot silently re-run a write.

- [ ] **Step 6: Update migration-version regression assertions and run green**

Add 16 to the expected version arrays in tests/integration/personal-trash-service.test.ts and tests/integration/database-kernel.test.ts.

Run: npm run test:unit -- tests/unit/assistant-action-plan-store.test.ts && npm run test:integration -- tests/integration/database-kernel.test.ts tests/integration/personal-trash-service.test.ts

Expected: PASS with zero failures.

- [ ] **Step 7: Commit Task 1**

~~~bash
git add src/server/db/migrations/016_assistant_action_plans.sql src/server/db/migrate.ts src/shared/api/assistant.ts src/server/assistant/action-plan-store.ts tests/unit/assistant-action-plan-store.test.ts tests/integration/personal-trash-service.test.ts tests/integration/database-kernel.test.ts
git commit -m "feat: add assistant action plan storage"
~~~

Inspect git show --check --stat HEAD, then complete spec-compliance and code-quality reviews before Task 2.

---

### Task 2: Split attachment archive preview from execution

**Files:**

- Modify: src/server/attachments/archive.ts
- Modify: src/server/attachments/service.ts
- Modify: tests/integration/attachment-service.test.ts
- Modify: tests/unit/assistant-attachment-tools.test.ts

- [ ] **Step 1: Write failing preview tests**

Add a real temporary-vault case to tests/integration/attachment-service.test.ts:

~~~ts
it('previews a PDF archive without publishing or changing the ledger', async () => {
  const f = await fixture();
  const vault = createPersonalIntakeFixture();
  const port = openPersonalArchive(vault.root, vault.recovery, resolve('dist/native/personal-archive.node'));
  const intakeService = createIntakeService({
    port, ruleFingerprint: 'a'.repeat(64),
    getRuleFingerprint: async () => 'a'.repeat(64), refreshIndex: async () => true
  });
  await f.service.close();
  const service = createAttachmentService({ directory: f.directory, archive: { port, intakeService } });
  const bytes = createTextPdf(['PREVIEW ONLY']);
  const uploaded = await service.upload({ name: 'preview.pdf', bytes, uploadId: randomUUID(), groupId: randomUUID() });
  await service.waitForParsing(uploaded.id);
  const preview = await service.preview({ id: uploaded.id });
  expect(preview).toMatchObject({
    target: expect.stringContaining('01图书馆/来自个人'),
    mainName: '原文.md', attachmentSha256: uploaded.sha256
  });
  expect(service.get(uploaded.id).archive).toBeUndefined();
  expect(port.listRecovery()).toEqual([]);
  expect(port.stat('01图书馆/小兆clipper/' + uploaded.id)).toBeNull();
  expect(service.readOriginal(uploaded.id).bytes).toEqual(bytes);
});
~~~

Add a second test that changes the parsed text between two previews and asserts the two `mainSha256` values differ while both previews leave the attachment ledger, staging directory and vault unchanged.

- [ ] **Step 2: Run the tests and verify the missing-method failure**

Run: npm run test:integration -- tests/integration/attachment-service.test.ts

Expected: FAIL with `TypeError: service.preview is not a function` until the new preview method is added.

- [ ] **Step 3: Extract a side-effect-free archive plan builder**

In `src/server/attachments/archive.ts` extract the common reads and calculations from `execute()` into the following pure-with-respect-to-files builder:

~~~ts
type AttachmentArchivePreview = {
  attachmentId: string;
  attachmentSha256: string;
  attachmentName: string;
  archiveFields: z.infer<typeof intakeFieldsSchema>;
  textRevision: string;
  target: string;
  mainName: string;
  mainSha256: string;
  duplicate: boolean;
  existing?: AttachmentArchiveResult;
};
async function buildPreview(request: AttachmentArchiveRequest, signal?: AbortSignal): Promise<AttachmentArchivePreview>;
~~~

It may call `readOriginal`, `parsed`, duplicate checks, `inferIntakeFields` and `planIntakeMain`, but it must not call `persist`, `publishAttachmentPackage`, `intakeService.preview` or `intakeService.commit`.

Export `AttachmentArchivePreview` with `attachmentId`, `attachmentSha256`, `attachmentName`, `archiveFields`, `textRevision`, `target`, `mainName`, `mainSha256`, `duplicate` and optional `existing`; keep generated bytes private to `archive()` and expose only `mainSha256` to the action-plan layer. Preserve title conflict, path, parser warning and duplicate checks.

- [ ] **Step 4: Reuse the builder in execution and expose preview**

Change `createAttachmentArchive()` to return `{ preview, archive, close }`:

~~~ts
return {
  preview: (request, signal) => buildPreview(request, signal),
  archive: (request, signal) => execute(request, signal),
  close: async () => { try { await running?.done; } catch { /* durable recovery state remains readable */ } }
};
~~~

`archive()` must invoke the same builder, re-read the original, recompute the main hash immediately before publishing, and retain the current staging, native publish, `IntakeService` commit, recovery and duplicate semantics. Add `preview(request, signal?)` to the object returned by `createAttachmentService()`. Existing public attachment routes continue calling `archive()` and keep their response schema unchanged.

- [ ] **Step 5: Update assistant tool unit expectations**

Change the explicit archive test in tests/unit/assistant-attachment-tools.test.ts to inject a proposeArchive callback and assert that port.archive is not called. Add an assertion that the callback receives only the selected attachment ID, page selection and optional intake fields; no model-supplied target path is accepted. Keep all negative-intent and extraction tests.

- [ ] **Step 6: Run the focused archive regression suite**

Run: npm run test:integration -- tests/integration/attachment-service.test.ts && npm run test:unit -- tests/unit/assistant-attachment-tools.test.ts

Expected: all parser, duplicate, recovery, preview and existing direct attachment archive tests pass.

- [ ] **Step 7: Commit Task 2**

~~~bash
git add src/server/attachments/archive.ts src/server/attachments/service.ts tests/integration/attachment-service.test.ts tests/unit/assistant-attachment-tools.test.ts
git commit -m "refactor: separate attachment archive preview"
~~~

Inspect the diff and complete both reviews before Task 3.

---

### Task 3: Integrate the plan lifecycle with assistant tools, service and API

**Files:**

- Create: src/server/assistant/action-plan-service.ts
- Modify: src/server/assistant/types.ts
- Modify: src/server/assistant/attachment-tools.ts
- Modify: src/server/assistant/service.ts
- Modify: src/server/assistant/deepseek-adapter.ts
- Modify: src/server/assistant/presentation.ts
- Modify: src/server/api/routes/assistant.ts
- Modify: src/server/app.ts
- Create: tests/integration/assistant-action-plan.test.ts
- Modify: tests/integration/assistant-api.test.ts
- Modify: tests/integration/assistant-attachment-receipts.test.ts

- [ ] **Step 1: Write failing lifecycle and route tests**

Create a fake attachment service whose preview returns a server-owned target/hash and whose archive is a deferred function. Use an assistant adapter that invokes archive_attachment once. Cover:

~~~ts
it('creates a pending plan without calling archive during the model turn', async () => {
  const started = await f.service.send(f.request('请归档这个附件'));
  const result = await f.settled(started.id);
  expect(f.attachment.preview).toHaveBeenCalledOnce();
  expect(f.attachment.archive).not.toHaveBeenCalled();
  expect(result.messages[1]?.actions).toContainEqual(expect.objectContaining({
    type: 'plan', kind: 'archive', status: 'pending'
  }));
});

it('confirms once and projects the real archive receipt', async () => {
  const started = await f.service.send(f.request('请归档这个附件'));
  const pending = await f.settled(started.id);
  const plan = pending.messages[1]!.actions.find(action => action.type === 'plan')!;
  const requestId = randomUUID();
  const confirmed = await f.service.confirmAction(plan.id, requestId);
  expect(f.attachment.archive).toHaveBeenCalledOnce();
  expect(confirmed.messages[1]?.actions).toContainEqual(expect.objectContaining({
    type: 'archive', status: 'archived'
  }));
  await f.service.confirmAction(plan.id, requestId);
  expect(f.attachment.archive).toHaveBeenCalledOnce();
  await expect(f.service.confirmAction(plan.id, randomUUID())).rejects.toMatchObject({ code: 'ASSISTANT_ACTION_ALREADY_RESOLVED' });
});

it('marks a plan stale and never writes when the source hash changes', async () => {
  const started = await f.service.send(f.request('请归档这个附件'));
  const pending = await f.settled(started.id);
  f.attachment.get.mockReturnValue({ ...f.attachmentRecord, sha256: 'd'.repeat(64) });
  const plan = pending.messages[1]!.actions.find(action => action.type === 'plan')!;
  await expect(f.service.confirmAction(plan.id, randomUUID())).rejects.toMatchObject({
    code: 'ASSISTANT_ACTION_STALE'
  });
  expect(f.attachment.archive).not.toHaveBeenCalled();
});

it('cancels a pending plan without touching the attachment', async () => {
  const started = await f.service.send(f.request('请归档这个附件'));
  const pending = await f.settled(started.id);
  const plan = pending.messages[1]!.actions.find(action => action.type === 'plan')!;
  const cancelled = await f.service.cancelAction(plan.id, randomUUID());
  expect(cancelled.messages[1]?.actions).toContainEqual(expect.objectContaining({
    type: 'plan', status: 'cancelled'
  }));
  expect(f.attachment.archive).not.toHaveBeenCalled();
});
~~~

Also add restart recovery, route CSRF/auth, duplicate confirmation and “ordinary summary creates no plan” cases.

- [ ] **Step 2: Run the tests and verify the missing lifecycle failure**

Run: npm run test:integration -- tests/integration/assistant-action-plan.test.ts tests/integration/assistant-api.test.ts

Expected: FAIL because confirmAction, the plan service and the new routes do not exist.

- [ ] **Step 3: Define tool effect and plan callback types**

In `src/server/assistant/types.ts` add the following exact contracts:

~~~ts
export type AssistantToolEffect = 'read' | 'propose-write';
export interface AssistantTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect?: AssistantToolEffect;
  execute(input: unknown): Promise<unknown>;
}
export interface AssistantRunInput {
  model: string;
  effort?: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools: AssistantTool[];
  capacity?: AssistantModelCapacity;
  outputReserveTokens?: number;
  signal: AbortSignal;
  emit(event: AssistantEvent): void;
  shouldStopAfterTool?: () => boolean;
}
~~~

Reuse the existing imports from `src/shared/api/assistant.ts`, `src/shared/api/attachments.ts`, `src/shared/api/intake.ts` and `src/shared/api/extraction.ts`; do not duplicate client schemas in the server type file.

Extend the tool-factory input used by `service.ts` with `conversationId`, `messageId`, `proposeArchive(request)`, and `markActionPending()`:

~~~ts
proposeArchive(input: {
  id: string;
  selection: { id: string; startPage: number; endPage: number };
  fields?: Partial<IntakePreviewRequest['fields']>;
}): Promise<AssistantPlanAction>;
markActionPending(): void;
~~~

`proposeArchive` never accepts `targetPath`, hashes or an operation ID.

- [ ] **Step 4: Implement action-plan-service.ts**

Create `createAssistantActionPlanService` with this public surface:

~~~ts
export type AssistantActionPlanService = {
  proposeArchive(input: { conversationId: string; messageId: string; attachmentId: string; selection: { id: string; startPage: number; endPage: number }; fields?: Partial<IntakePreviewRequest['fields']> }): Promise<AssistantPlanAction>;
  confirm(input: { planId: string; conversationId: string; clientRequestId: string }): Promise<{ plan: AssistantActionPlan; result?: AttachmentArchiveResult }>;
  cancel(input: { planId: string; conversationId: string; clientRequestId: string }): { plan: AssistantActionPlan };
  recover(): void;
};
~~~

The implementation imports `AssistantPlanAction` from `src/shared/api/assistant.ts`, `AttachmentArchiveResult` from `src/shared/api/attachments.ts` and `IntakePreviewRequest` from `src/shared/api/intake.ts`; `AssistantActionPlan` remains an internal store type and is never serialized directly.

The service dependency is `Pick<AttachmentService, 'get' | 'readPages' | 'preview' | 'archive'>`; implement `proposeArchive` to call `preview({ id: attachmentId, fields })`, call `readPages(selection)` for the selected text revision, save canonical `archiveFields`, source selection, target and hashes, and return the client-safe `AssistantPlanAction`. `confirm` returns an internal resolution so `AssistantService` can project the conversation without a circular service reference.

Implement `confirm` with this ordering (the `archive()` call must remain outside the SQLite transaction):

Define the helpers in the same module before using them: `sha256(value: string): string` wraps `createHash('sha256')`, `assertPlanBelongsToConversation(plan, conversationId)` throws `ASSISTANT_ACTION_NOT_FOUND` for a missing/mismatched plan, `assertPendingAndUnexpired(plan, now)` throws `ASSISTANT_ACTION_ALREADY_RESOLVED` or `ASSISTANT_ACTION_EXPIRED`, `wholeAttachment(attachment)` returns `{ id, startPage: 1, endPage: attachment.pageCount ?? 1 }`, `parseArchiveResult(value)` parses `attachmentArchiveResultSchema`, and `publicActionProblem(error)` strips upstream details to a bounded user-facing message.

~~~ts
const plan = store.get(planId);
assertPlanBelongsToConversation(plan, conversationId);
const requestFingerprint = sha256(JSON.stringify({ planId, action: 'confirm' }));
const prior = store.assertConfirmationRequest(clientRequestId, requestFingerprint);
if (prior?.status === 'completed') return { plan: prior, result: parseArchiveResult(prior.resultPayload) };
assertPendingAndUnexpired(plan, clock());
const current = attachmentService.get(plan.payload.attachmentId);
const selected = attachmentService.readPages(plan.payload.sourceRange ?? wholeAttachment(current));
const currentPreview = await attachmentService.preview({ id: current.id, fields: plan.payload.archiveFields });
if (current.sha256 !== plan.payload.attachmentSha256 || selected.textRevision !== plan.payload.textRevision
    || currentPreview.mainSha256 !== plan.payload.mainSha256 || currentPreview.target !== plan.payload.targetPath) {
  store.markStale(plan.id, '文件或解析版本已变化，未写入资料。');
  throw new PublicApiError('ASSISTANT_ACTION_STALE', '文件或解析版本已变化，未写入资料。', 409);
}
store.markRunning(plan.id, clientRequestId, requestFingerprint);
try {
  const result = await attachmentService.archive({ id: current.id, fields: plan.payload.archiveFields });
  const completed = store.markCompleted(plan.id, `archive:${result.operationId}:${current.id}`, result);
  return { plan: completed, result };
} catch (error) {
  store.markFailed(plan.id, publicActionProblem(error));
  throw error;
}
~~~

`cancel` verifies ownership, stores the same request fingerprint, and calls `markCancelled` only while the plan is pending. On retry, return the existing result by confirmation ID or stored operation ID; a different request ID after a terminal state returns `ASSISTANT_ACTION_ALREADY_RESOLVED`. Run `recover()` on service construction and map failures to the approved public error codes.

- [ ] **Step 5: Make archive_attachment propose instead of execute**

In src/server/assistant/attachment-tools.ts keep attachmentIntent and selected-ID checks. Replace the assistant archive body with:

~~~ts
const item = chosen(request.id);
const action = await input.proposeArchive({
  id: request.id,
  selection: { id: request.id, startPage: item.startPage, endPage: item.endPage },
  fields: request.fields
});
input.emit({ type: 'action', action });
input.markActionPending();
return {
  status: 'awaiting_confirmation',
  actionId: action.id,
  message: '归档计划已生成，等待用户确认；尚未写入资料。'
};
~~~

Mark the returned `AssistantTool` with `effect: 'propose-write'`. Do not emit `attachment-archive-started` and do not call `attachmentService.archive` from this tool. Keep `prepare_attachment_extraction`’s existing source-preservation behavior and its explicit extraction-intent gate.

- [ ] **Step 6: Project plan actions in assistant service**

In `src/server/assistant/service.ts`:

1. Add optional actionPlans to the factory input.
2. Pass conversation ID and assistant message ID into createTools.
3. Pass markActionPending and shouldStopAfterTool to the adapter.
4. Refresh plan action status from the store in `get()`; for a completed plan replace the `type: 'plan'` card with the existing `type: 'archive'` receipt keyed by `resultActionId`, and never append a second receipt on repeated reads.
5. Add confirmAction(planId, clientRequestId) and cancelAction(planId, clientRequestId), returning get(plan.conversationId).
6. If actionPlans is absent, explicit assistant archive requests return ASSISTANT_ACTION_UNAVAILABLE and never call the attachment archive port.

Use one per-run flag and pass it to both the tool factory and adapter:

~~~ts
const actionPending = { value: false };
const tools = input.createTools({
  ...existingContext,
  conversationId: conversation.id,
  messageId: answer.id,
  ...(input.actionPlans ? {
    proposeArchive: request => input.actionPlans!.proposeArchive({ conversationId: conversation.id, messageId: answer.id, ...request }),
    markActionPending: () => { actionPending.value = true; }
  } : {})
});
await adapter.run({ ...runInput, shouldStopAfterTool: () => actionPending.value });
~~~

`confirmAction` and `cancelAction` call the plan service with the plan’s stored conversation ID, then call `get()` to project the updated message. A response containing a pending plan is an idle usable conversation, not a failed conversation.

- [ ] **Step 7: Stop the model loop after a proposed write**

In `src/server/assistant/deepseek-adapter.ts`, keep the existing `isStepCount(16)` limit and use `shouldStopAfterTool` to disable tools for the one final explanatory model step:

~~~ts
let proposedWrite = false;
const tools = Object.fromEntries(request.tools.map(entry => [entry.name, tool({
  description: entry.description,
  inputSchema: jsonSchema(entry.inputSchema),
  execute: async value => {
    const result = await entry.execute(value);
    if (entry.effect === 'propose-write') proposedWrite = true;
    return result;
  }
})]));
// Keep the proposed-write result, then force the next model step to be text-only.
prepareStep: ({ steps, ...rest }) => {
  const last = steps.at(-1);
  const proposed = proposedWrite && request.shouldStopAfterTool?.() === true
    && last?.toolCalls?.some(call => call.toolName === 'archive_attachment');
  const estimate = estimateAssistantContext({ system: request.system, messages: rest.messages,
    tools: request.tools, outputReserveTokens, ...(capacity ? { capacity } : {}) });
  request.emit({ type: 'context-estimate', estimate });
  assertAssistantContextBudget(estimate);
  return proposed ? { activeTools: [], toolChoice: 'none' } : undefined;
},
stopWhen: isStepCount(16),
~~~

The deterministic adapter test must assert that after `markActionPending()` the next provider request has `activeTools: []` and `toolChoice: 'none'`, so a second archive tool call cannot execute. Keep the step receipt as tool completed while the action card remains pending.

Add a deterministic adapter test proving that a second archive tool call is not executed after markActionPending() becomes true.

- [ ] **Step 8: Add routes and server wiring**

In `src/server/api/routes/assistant.ts` add the following handlers:

~~~text
POST /api/v1/assistant/action-plans/:id/confirm
POST /api/v1/assistant/action-plans/:id/cancel
~~~

~~~ts
const actionPlanRequestSchema = z.strictObject({ clientRequestId: z.uuid() });
app.post('/api/v1/assistant/action-plans/:id/confirm', async (request, reply) => {
  const { id } = parseApiInput(assistantIdSchema, request.params);
  const { clientRequestId } = parseApiInput(actionPlanRequestSchema, request.body);
  return parseApiOutput(assistantConversationResponseSchema, {
    version: API_VERSION,
    data: await required().confirmAction(id, clientRequestId)
  });
});
app.post('/api/v1/assistant/action-plans/:id/cancel', async (request, reply) => {
  const { id } = parseApiInput(assistantIdSchema, request.params);
  const { clientRequestId } = parseApiInput(actionPlanRequestSchema, request.body);
  return parseApiOutput(assistantConversationResponseSchema, {
    version: API_VERSION,
    data: required().cancelAction(id, clientRequestId)
  });
});
~~~

Add the analogous `cancel` handler. Use strict params and body schema `{ clientRequestId: z.uuid() }`, the existing session/origin/CSRF hooks, and `assistantConversationResponseSchema` responses.

In `src/server/app.ts` construct the plan service before the assistant service and pass the same instance into both the tool factory and `createAssistantService`:

~~~ts
const actionPlans = options.assistantAdapters && options.readApi && readService && options.attachmentService
  ? createAssistantActionPlanService({ database: options.readApi.database, attachmentService: options.attachmentService })
  : undefined;
const assistant = options.assistantAdapters && options.readApi && readService
  ? createAssistantService({
      database: options.readApi.database, adapters: options.assistantAdapters,
      ...(actionPlans ? { actionPlans } : {}),
      createTools: context => createAssistantTools({ ...context, readService,
        ...(options.attachmentService ? { attachmentService: options.attachmentService } : {})
      })
    })
  : undefined;
~~~

Call `actionPlans.recover()` during construction before registering routes. Keep the existing shutdown order and native recovery behavior; close the plan service only after any confirmation call has settled.

- [ ] **Step 9: Run backend regression tests**

Run: npm run test:unit -- tests/unit/assistant-attachment-tools.test.ts tests/unit/assistant-deepseek-adapter.test.ts && npm run test:integration -- tests/integration/assistant-action-plan.test.ts tests/integration/assistant-attachment-receipts.test.ts tests/integration/assistant-api.test.ts

Expected: zero failures; no direct archive call during a proposed-write turn, one archive call after confirmation, and correct stale/cancel/idempotent behavior.

- [ ] **Step 10: Commit Task 3**

~~~bash
git add src/server/assistant/action-plan-service.ts src/server/assistant/types.ts src/server/assistant/attachment-tools.ts src/server/assistant/service.ts src/server/assistant/deepseek-adapter.ts src/server/assistant/presentation.ts src/server/api/routes/assistant.ts src/server/app.ts tests/integration/assistant-action-plan.test.ts tests/integration/assistant-api.test.ts tests/integration/assistant-attachment-receipts.test.ts
git commit -m "feat: require confirmation for assistant archive actions"
~~~

Complete spec-compliance review first, then code-quality review, and fix every Important finding before Task 4.

---

### Task 4: Add the plan card and confirmation dialog to the desktop UI

**Files:**

- Create: src/client/components/assistant/AssistantActionPlanCard.tsx
- Modify: src/client/api/client.ts
- Modify: src/client/components/assistant/AssistantMessageView.tsx
- Modify: src/client/components/assistant/AssistantPanel.tsx
- Modify: src/client/styles/assistant.css
- Create: tests/component/assistant-action-plan-card.test.tsx
- Modify: tests/component/assistant-message-view.test.tsx
- Modify: tests/component/assistant-panel.test.tsx

- [ ] **Step 1: Write failing component tests**

Use a pending action fixture and fake confirm/cancel functions:

~~~tsx
it('shows the server target and confirms only after the final dialog button', async () => {
  const confirm = vi.fn(async () => ({ ok: true, value: conversationWithCompletedArchive() }));
  render(<AssistantActionPlanCard action={pendingAction()} onResolved={confirm} onCancelled={vi.fn()} />);
  expect(screen.getByText('准备归档')).toBeVisible();
  expect(screen.getByText(/01图书馆\/来自个人/)).toBeVisible();
  expect(screen.getByText('尚未写入资料')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '确认归档' }));
  expect(await screen.findByRole('dialog', { name: '确认归档' })).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '最终确认归档' }));
  expect(confirm).toHaveBeenCalledOnce();
});

it('shows stale state without a misleading success label', () => {
  render(<AssistantActionPlanCard action={staleAction()} onResolved={vi.fn()} onCancelled={vi.fn()} />);
  expect(screen.getByText('文件已变化，未写入')).toBeVisible();
  expect(screen.queryByText('已归档')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重新生成计划' })).toBeVisible();
});
~~~

Add message-view coverage for plan, archive and review action branches.

- [ ] **Step 2: Run component tests and verify the missing component failure**

Run: npm run test:component -- tests/component/assistant-action-plan-card.test.tsx tests/component/assistant-message-view.test.tsx

Expected: FAIL because the component, plan branch and client methods do not exist.

- [ ] **Step 3: Add client API methods**

Extend ReadConsoleApi.assistant in src/client/api/client.ts:

~~~ts
confirmAction(id: string, clientRequestId: string): Promise<ApiClientResult<AssistantConversation>>;
cancelAction(id: string, clientRequestId: string): Promise<ApiClientResult<AssistantConversation>>;
~~~

Use postWithCsrf with the strict body { clientRequestId } and the same UUID as the idempotency key. Never retry an unknown mutation result with a new UUID.

Add the returned methods beside the existing `send`, `stop` and `login` methods:

~~~ts
confirmAction: (id, clientRequestId) => postWithCsrf(
  `/api/v1/assistant/action-plans/${encodeURIComponent(id)}/confirm`,
  assistantConversationResponseSchema, { clientRequestId }, clientRequestId
),
cancelAction: (id, clientRequestId) => postWithCsrf(
  `/api/v1/assistant/action-plans/${encodeURIComponent(id)}/cancel`,
  assistantConversationResponseSchema, { clientRequestId }, clientRequestId
),
~~~

- [ ] **Step 4: Implement AssistantActionPlanCard.tsx**

Props are `action`, `onResolved`, `onCancelled` callbacks, plus optional `onRegenerate`:

~~~tsx
type Props = {
  action: AssistantPlanAction;
  onResolved: () => Promise<void>;
  onCancelled: () => Promise<void>;
  onRegenerate?: () => void;
};
export function AssistantActionPlanCard({ action, onResolved, onCancelled, onRegenerate }: Props) {
  const [confirming, setConfirming] = useState(false);
  // Render the server-provided target as text; never turn it into an href.
  return <article aria-label="待确认的归档计划">
    <h3>{action.label}</h3>
    <p>{action.sourceTitle}</p><p>{action.targetPath}</p>
    <small>原件 SHA-256：{action.sourceSha256.slice(0, 8)} · 计划有效至 {action.expiresAt}</small>
    <button type="button" onClick={() => setConfirming(true)}>确认归档</button>
    <button type="button" onClick={() => void onCancelled()}>取消</button>
    {confirming && <div role="dialog" aria-modal="true" aria-labelledby="assistant-plan-confirm-title">
      <h2 id="assistant-plan-confirm-title" tabIndex={-1}>确认归档</h2>
      <button type="button" onClick={() => void onResolved()}>最终确认归档</button>
    </div>}
  </article>;
}
~~~

Render server-provided path as text, source hash prefix, expiry, summary and duplicate warning. Use exact labels `查看计划`, `确认归档`, `取消`, `最终确认归档` and `重新生成计划`.

The dialog must have role dialog, aria-modal true, focus the heading on open, return focus to the trigger on close, close on Escape without confirming, disable buttons during the request, and show 正在归档….

- [ ] **Step 5: Wire message view and panel refresh**

In `AssistantMessageView.tsx` branch on `plan` before `archive`/`review`. In `AssistantPanel.tsx` use the existing `receive()` path:

~~~ts
const result = await api.assistant.confirmAction(action.id, randomUUID());
if (result.ok) receive(result.value);
else setActionError(result.state.message);
~~~

Use the analogous cancel callback, do not send a new assistant message on confirmation, and surface API failures as `role="alert"` while retaining the plan card.

- [ ] **Step 6: Add scoped styles**

Add the scoped rules below to `src/client/styles/assistant.css`, using the existing assistant card palette:

~~~css
.assistant-action-plan { overflow-wrap: anywhere; }
.assistant-action-plan__target { white-space: normal; }
.assistant-action-plan--pending { border-inline-start: 3px solid #6a747d; }
.assistant-action-plan--stale,
.assistant-action-plan--failed { border-inline-start: 3px solid #d98989; }
.assistant-action-plan__confirm { background: #e1e9f0; color: #1f2a33; }
~~~

Reuse task-card spacing, preserve narrow-width wrapping, distinguish pending/failed/stale states, and keep the final confirmation button primary. Do not hide target paths on mobile or introduce page-level horizontal scrolling.

- [ ] **Step 7: Run component and type checks**

Run: npm run test:component -- tests/component/assistant-action-plan-card.test.tsx tests/component/assistant-message-view.test.tsx tests/component/assistant-panel.test.tsx && npm run typecheck

Expected: zero failures and no regressions in panel race, draft, history or existing action-card tests.

- [ ] **Step 8: Commit Task 4**

~~~bash
git add src/client/api/client.ts src/client/components/assistant/AssistantActionPlanCard.tsx src/client/components/assistant/AssistantMessageView.tsx src/client/components/assistant/AssistantPanel.tsx src/client/styles/assistant.css tests/component/assistant-action-plan-card.test.tsx tests/component/assistant-message-view.test.tsx tests/component/assistant-panel.test.tsx
git commit -m "feat: add assistant archive confirmation card"
~~~

Complete spec and quality reviews before Task 5.

---

### Task 5: Add desktop acceptance coverage and update product documentation

**Files:**

- Create: tests/electron/assistant-action-plan.test.ts
- Modify: README.md
- Modify: docs/superpowers/specs/2026-09-14-assistant-action-plan-design.md status line after tests pass

- [ ] **Step 1: Write the failing Electron flow**

Use an isolated temporary brain and existing Electron fixtures. The test must upload a text PDF, send 请归档这个文件, assert the pending plan and 尚未写入资料, snapshot the vault before confirmation, click 确认归档 then 最终确认归档, assert 已归档 and the source link, compare original and archived SHA-256, reload the conversation, and assert one completed receipt.

Add separate cases for ordinary 总结一下 (no plan and no file mutation), cancel (no mutation), and a stale plan after changing the attachment ledger.

- [ ] **Step 2: Run the Electron test to observe the expected failure**

Run: npm run test:electron -- tests/electron/assistant-action-plan.test.ts

Expected: FAIL at the pending-plan selector before the implementation is wired; preserve this as the regression contract.

- [ ] **Step 3: Add the isolated fixture wiring**

In `tests/electron/assistant-action-plan.test.ts`, pass the existing isolated-vault fixture's API/server handle to the page and assert the route origin is the fixture origin before upload. Do not add production permissions, real-vault paths or a real model key; keep the test network and storage boundaries identical to the existing Electron fixtures.

- [ ] **Step 4: Update product documentation**

Add: “明确归档请求会先生成待确认计划；确认后才归档；普通问答和总结不写入；候选提炼仍需在审阅界面确认。” Do not claim generic terminal, browser, OCR, multi-agent or background execution support.

- [ ] **Step 5: Run focused full regression**

Run in order:

~~~bash
npm run test:unit -- tests/unit/assistant-action-plan-store.test.ts tests/unit/assistant-attachment-tools.test.ts tests/unit/assistant-deepseek-adapter.test.ts
npm run test:integration -- tests/integration/assistant-action-plan.test.ts tests/integration/assistant-attachment-receipts.test.ts tests/integration/assistant-api.test.ts tests/integration/attachment-service.test.ts
npm run test:component -- tests/component/assistant-action-plan-card.test.tsx tests/component/assistant-message-view.test.tsx tests/component/assistant-panel.test.tsx
npm run test:electron -- tests/electron/assistant-action-plan.test.ts
npm run typecheck
~~~

Expected: every command exits 0 with zero failed tests.

- [ ] **Step 6: Commit Task 5**

~~~bash
git add tests/electron/assistant-action-plan.test.ts README.md docs/superpowers/specs/2026-09-14-assistant-action-plan-design.md
git commit -m "test: verify assistant archive confirmation flow"
~~~

---

### Task 6: Final verification and review

**Files:**

- No new production files; inspect all changes from ce78190 through HEAD.

- [ ] **Step 1: Run the project verification command**

Run: npm run verify

Expected: unit, integration, component and desktop runtime build all exit 0. If a known flaky test appears, isolate and rerun it using the project’s documented serial command; report the exact failure rather than deleting or weakening the assertion.

- [ ] **Step 2: Run the desktop runtime build**

Run: npm run build:desktop-runtime

Expected: native helper, server, client, Electron bundles and copied assets build successfully, including migration 016 and the plan-card bundle.

- [ ] **Step 3: Inspect the final diff and invariants**

Run:

~~~bash
git diff --check ce78190..HEAD
git diff --name-only ce78190..HEAD
git status --short --branch
~~~

Verify manually that:

- no direct assistant call to attachmentService.archive remains in archive_attachment;
- no route accepts a model-supplied absolute path;
- confirmation rechecks SHA-256 and plan status;
- duplicate confirmation does not create another operation;
- ordinary Q&A never creates a plan;
- candidate review and native recovery paths are unchanged.

- [ ] **Step 4: Request final code review**

Dispatch a fresh reviewer with the design document, this plan, base ce78190 and final HEAD. Resolve every Critical or Important finding, rerun affected focused tests, then rerun npm run verify.

- [ ] **Step 5: Report completion only with fresh evidence**

Record the exact commit range, test commands and exit results. Do not call the feature complete if any required Electron, build, recovery or review item remains unresolved.
