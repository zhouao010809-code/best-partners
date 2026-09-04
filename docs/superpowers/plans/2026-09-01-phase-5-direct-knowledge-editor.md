# Phase 5 Direct Knowledge Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在 App 内用受控 YAML 表单和 Markdown 编辑器修改现有知识，自动保存 vault 外草稿，确认完整差异后通过同一个安全写入内核提交，并在外部变化、受保护状态和恢复场景中安全停机。

**Architecture:** `KnowledgeEditorService` 打开知识时记录完整 raw hash，并把草稿保存在 SQLite/userData 权限边界内；`KnowledgeEditPolicy` 根据原状态、字段和正文 diff 决定允许、要求 `AI待认`、要求解除 `定论` 或阻断。`KnowledgeEditPlanner` 生成 Phase 1 `WritePlan` 的 knowledge-edit intent，`EditorFinalizer` 在最终文件验证后、core commit 前幂等更新草稿与索引；执行、恢复和反向恢复都复用唯一 `WriteCoordinator` 与 recovery service。

**Tech Stack:** TypeScript, Fastify, Zod, better-sqlite3, React, `react-markdown`, `diff`, Phase 1 atomic write/recovery kernel, Vitest, Playwright

---

## File Structure

**Create:**

- `src/server/db/migrations/007_editor_workflow.sql` — 编辑草稿、plan 绑定与 verified finalization。
- `src/shared/domain/editor.ts` — 受控字段、草稿、保护确认、冲突与 API 类型。
- `src/server/db/repositories/editor-draft-repository.ts` — 一知识一活动草稿、版本化自动保存和冲突状态。
- `src/server/rules/knowledge-edit-policy.ts` — `AI总结 / 已优化 / 定论 / 过时` 规则。
- `src/server/rules/knowledge-edit-renderer.ts` — 从原始 bytes 和受控草稿确定性生成 after bytes。
- `src/server/workflow/knowledge-editor-service.ts` — 打开、保存草稿、重载和放弃。
- `src/server/workflow/knowledge-edit-planner.ts` — 完整 diff、政策检查和 knowledge-edit WritePlan。
- `src/server/workflow/editor-finalizer.ts` — disk 验证后、core outcome 可见前幂等更新草稿状态与索引。
- `src/server/workflow/knowledge-edit-verifier.ts` — 复读 schema、hash、状态与保护标记。
- `src/server/recovery/recovery-retention-service.ts` — 30 天成功快照保留、引用 hold 和受限载荷退役。
- `src/server/recovery/recovery-retirement-ledger.ts` — SQLite 外不可变退役授权/inventory 与 append-only 进度真源。
- `src/server/db/repositories/recovery-retention-repository.ts` — verified completion 分类、版本化批准与退役状态。
- `src/server/recovery/recovery-retention-completion-recorder.ts` — 对所有 intent 的 core terminal outcome 做统一幂等保留记录。
- `src/server/api/routes/editor-drafts.ts`
- `src/client/pages/KnowledgeEditorPage.tsx`
- `src/client/components/editor/KnowledgeYamlForm.tsx`
- `src/client/components/editor/MarkdownEditor.tsx`
- `src/client/components/editor/MarkdownPreview.tsx`
- `src/client/components/editor/EditPolicyNotice.tsx`
- `src/client/components/editor/EditDiffConfirmation.tsx`
- `src/client/styles/knowledge-editor.css`
- `tests/integration/editor-draft-repository.test.ts`
- `tests/unit/knowledge-edit-policy.test.ts`
- `tests/unit/knowledge-edit-renderer.test.ts`
- `tests/integration/knowledge-editor-service.test.ts`
- `tests/unit/knowledge-edit-planner.test.ts`
- `tests/integration/knowledge-edit-coordinator.test.ts`
- `tests/integration/knowledge-edit-recovery.test.ts`
- `tests/integration/editor-api.test.ts`
- `tests/integration/recovery-retention-service.test.ts`
- `tests/unit/recovery-retirement-ledger.test.ts`
- `tests/integration/recovery-retention-completion-recorder.test.ts`
- `tests/component/recovery-retention.test.tsx`
- `tests/component/knowledge-editor.test.tsx`
- `tests/component/knowledge-editor-conflict.test.tsx`
- `tests/e2e/test-vault-knowledge-editor.spec.ts`
- `tests/e2e/test-vault-editor-conflict-recovery.spec.ts`

**Modify:**

- `src/server/db/migrate.ts` — 注册 migration 007。
- `scripts/copy-server-assets.ts` — 打包 migration 007。
- `src/shared/domain/records.ts` — 导出现有知识类型枚举的 `KnowledgeType`，不新建字符串真源。
- `src/server/rules/knowledge-schema.ts` — 复用 shared `KNOWLEDGE_TYPES/KnowledgeType` 继续严格解析。
- `src/shared/domain/write.ts` — 只增加 `knowledge_edit` intent；不重新定义 core write types。
- `src/server/workflow/write-repository.ts` — 暴露 editor verified finalization 所需只读查询。
- `src/server/workflow/write-intent-registry.ts` — 注册 knowledge-edit verifier/finalizer，不给 coordinator 加 kind 分支。
- `src/server/workflow/recovery-service.ts` — 按 original knowledge-edit intent 完成 continue/rollback/resolve recovery finalization。
- `native/macos/atomic-file-helper.c` — 增加只针对已绑定私有 recovery-trash 文件 inode 的有界载荷退役命令；不增加删除 opcode。
- `src/server/vault/atomic-helper-protocol.ts` — 编解码严格的私有载荷退役命令及无路径结果。
- `src/server/vault/AtomicFileHelper.ts` — 只接受服务端退役授权和持久化 inventory 条目的窄客户端方法。
- `src/server/vault/PrivateRecoveryStore.ts` — 增加固定私有 retirement-control preparing/active 根的 descriptor-bound 创建、追加、扫描与复读。
- `src/server/vault/native-capability-profile.ts` — 把有界 recovery 载荷退役加入不可变 helper capability profile。
- `src/server/vault/native-capability-probe.ts` — 在私有测试 appData 中验证有界、非删除的退役能力。
- `src/server/api/routes/recovery.ts` — 已恢复 batch 的显式清理确认与保留状态。
- `src/server/recovery/recovery-scanner.ts` — 独立扫描 active recovery batch 与 retirement-control ledger，不把已移走 batch 丢失。
- `src/server/recovery/recovery-only-runtime.ts` — SQLite 不可用时只恢复已授权的进行中退役并输出可重建投影，不启动新 sweep。
- `src/server/app.ts` — 注册 editor routes。
- `src/server/start-server.ts` — 构造 editor service/planner/handler。
- `src/shared/api/schemas.ts` — editor draft/plan/conflict schemas。
- `src/client/api/client.ts` — editor API 方法。
- `src/client/app/router.tsx` — `/knowledge/edit/:draftId`。
- `src/client/pages/KnowledgePage.tsx` — 从详情打开编辑器。
- `src/client/components/KnowledgeDetail.tsx` — “编辑”主动作；保留可选 Obsidian 打开。
- `src/client/pages/OperationsPage.tsx` — 编辑事务和恢复为写入前版本入口。
- `src/client/pages/RecoveryDetailPage.tsx` — 显示保留期/hold，并仅为已安全完成的 recovery 提供显式清理。
- `tests/native/atomic-file-helper.contract.test.ts` — 证明私有退役命令不跟随链接、不越界、只清空精确身份文件的载荷且绝不删除条目。
- `tests/unit/atomic-helper-protocol.test.ts` — 证明退役命令参数/结果严格、无路径泄露且不存在 unlink/rmdir opcode。
- `tests/unit/native-capability-profile.test.ts` — 证明 helper 变化和未验证的有界载荷退役能力都会阻断旧 profile。
- `tests/integration/native-capability-gate.test.ts` — 证明只有真实通过私有载荷退役 probe 的新 profile 可用。
- `tests/integration/recovery-only-runtime.test.ts` — 证明每个退役崩溃点删除/损坏 SQLite 后仍从私有 ledger 恢复。

## Cross-Phase Contracts

- Migration 003–006 已存在，本阶段只新增 007。
- 正式数据始终是 vault 中 Markdown/YAML；草稿可丢弃、可重建且不得伪装成已提交知识。
- 不新增第二套 `WritePlan`、`WriteCoordinator`、path lock、manifest 或 recovery service。
- 编辑计划继承 Phase 0 的全局五文件 rule bundle（`00_ / 01_ / 02_ / 03_ / 05_`）指纹，计划与执行前均重读比对。
- 编辑与草稿读取/自动保存保持可用，但 direct/restore write-plan creation 和 execution 必须通过 Phase 0 注入的 `RuleCompatibilityGate` port/record；默认 deny，测试 fixture 可批准测试指纹，Phase 6 才实现 Electron production 审批。本阶段不另建 gate。App 关闭期间规则变化后，重启持续返回 `RULE_BUNDLE_UNAPPROVED`，重新打开或保存草稿不得自动批准。
- 不提供永久删除 API、按钮或快捷键；停用走 `使用状态: 过时`。
- 所有自动化写入只允许当前测试创建、带哨兵且与正式 vault/appData 隔离的临时 vault。
- V1 的“恢复为写入前版本”只接受原计划 `intent.kind === 'knowledge_edit'` 且计划恰好包含一个 `replace`/`knowledge` step；入馆、提炼、内核测试/恢复、create/move/mkdir 或多 step batch 一律返回 `RESTORE_SOURCE_UNSUPPORTED`，不得靠挑一个 before blob 绕过其领域投影。

### Task 1: Persist private, versioned editor drafts

**Files:**

- Create: `src/server/db/migrations/007_editor_workflow.sql`
- Create: `src/shared/domain/editor.ts`
- Create: `src/server/db/repositories/editor-draft-repository.ts`
- Create: `src/server/db/repositories/recovery-retention-repository.ts`
- Modify: `src/server/db/migrate.ts`
- Modify: `src/shared/domain/records.ts`
- Modify: `src/server/rules/knowledge-schema.ts`
- Modify: `scripts/copy-server-assets.ts`
- Test: `tests/integration/editor-draft-repository.test.ts`

- [ ] **Step 1: Write failing repository tests**

Assert one active draft per knowledge path/base hash, versioned save, conflict, plan freeze and restart persistence:

```ts
const draft = repository.createOrGet({
  knowledgePath: '02知识库/方法/example.md',
  baseRawSha256: 'a'.repeat(64),
  baseUsageStatus: 'AI总结',
  origin: { kind: 'direct' },
  fields,
  bodyMarkdown: '原始正文'
});
const saved = repository.save(draft.id, draft.version, {
  fields: { ...fields, conclusion: '修改后的结论' },
  bodyMarkdown: '修改后的正文',
  protection: { acknowledgements: [] }
});
expect(saved.version).toBe(draft.version + 1);
expect(saved.draftSha256).not.toBe(draft.draftSha256);
expect(repository.createOrGet({
  knowledgePath: draft.knowledgePath,
  baseRawSha256: draft.baseRawSha256,
  baseUsageStatus: 'AI总结',
  origin: { kind: 'direct' },
  fields,
  bodyMarkdown: '原始正文'
}).id).toBe(draft.id);
```

Assert stale save returns `EDITOR_VERSION_CONFLICT`, a new live raw hash marks old active draft conflict rather than overwriting it, planned drafts reject edits, committed/abandoned drafts no longer block a new draft, and draft rows survive database reopen. Create a restore-origin draft and round-trip its source batch, step ordinal, manifest hash and retained raw hash; binding any restore plan to a direct draft or mismatched restore origin must fail before finalization. Bind an immutable plan, then prove `releaseUnpreparedPlan` succeeds only for exact plan ID/SHA/binding version while no `write_batches` row or recovery evidence exists; it marks only that audit binding cancelled, increments binding and draft versions, and chooses `editing` when the live base still matches or `conflict` when it drifted. Once the coordinator has created any batch row or manifest evidence, cancellation is rejected with `WRITE_PLAN_ALREADY_PREPARED`. Exercise `RecoveryRetentionRepository.ensureVerifiedCompletion` idempotently for all four completion kinds, reject an earlier/different verified timestamp for the same batch, and require an active retained row before a restore-origin draft can bind.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npm run test:integration -- editor-draft-repository
```

Expected: migration and repository are absent.

- [ ] **Step 3: Define the editor domain**

Create `src/shared/domain/editor.ts`:

```ts
import type { KnowledgeType } from './records.js';

export type EditableKnowledgeFields = {
  usageStatus: 'AI总结' | '已优化' | '定论' | '过时';
  knowledgeType: KnowledgeType;
  topics: string[];
  keywords: string[];
  sourceMaterials: string[];
  scenarios: string[];
  conclusion: string;
  keyPoints: string[];
  boundary: string;
  note: string;
};

export type EditAcknowledgement =
  | { kind: 'mark_ai_pending'; acknowledged: true }
  | { kind: 'approve_ai_summary'; acknowledged: true }
  | { kind: 'set_conclusion'; acknowledged: true }
  | { kind: 'downgrade_optimized'; acknowledged: true; reason: string }
  | { kind: 'unlock_conclusion'; acknowledged: true; reason: string; resultingStatus: 'AI总结' | '已优化' }
  | { kind: 'mark_obsolete'; acknowledged: true; reason: string; replacementPath: string };

export type EditProtection = {
  acknowledgements: readonly EditAcknowledgement[];
};

export type EditorDraftState =
  | 'editing'
  | 'conflict'
  | 'planned'
  | 'committed'
  | 'abandoned'
  | 'recovery_required';

export type EditorDraftOrigin =
  | { kind: 'direct' }
  | {
      kind: 'restore';
      sourceBatchId: string;
      sourceStepOrdinal: number;
      sourceManifestSha256: string;
      restoreRawSha256: string;
    };

export type EditorDraft = {
  id: string;
  knowledgePath: string;
  baseRawSha256: string;
  baseUsageStatus: EditableKnowledgeFields['usageStatus'];
  origin: EditorDraftOrigin;
  fields: EditableKnowledgeFields;
  bodyMarkdown: string;
  protection: EditProtection;
  state: EditorDraftState;
  draftSha256: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};
```

Move no enum values: export the current `KNOWLEDGE_TYPES` tuple and `KnowledgeType = (typeof KNOWLEDGE_TYPES)[number]` from the shared records domain, then have the existing knowledge parser and editor API Zod schema import that same tuple. TypeScript narrowing is not authorization: every save/plan still validates `knowledgeType`, topics, source paths and replacement paths against the live rules/index, rejecting unknown enum values, nonexistent topic nodes and disallowed vault paths.

`类型`, `来源类型`, `创建日期` and raw YAML keys are intentionally absent from editable fields. `更新日期` is server-controlled at plan time. `acknowledgements` is a canonical, unique-by-kind set sorted by `kind`; there is no `none` member. This allows independent confirmations to coexist—for example an `已优化` semantic edit combined with downgrade to `AI总结` must carry both `mark_ai_pending` and `downgrade_optimized`, and a simultaneous transition to `定论` also carries its independent `set_conclusion` acknowledgement. Duplicate, irrelevant or browser-invented acknowledgement kinds fail validation.

- [ ] **Step 4: Add migration 007 and register it**

Create `007_editor_workflow.sql`:

```sql
CREATE TABLE editor_drafts (
  id TEXT PRIMARY KEY,
  knowledge_path TEXT NOT NULL,
  base_raw_sha256 TEXT NOT NULL CHECK (length(base_raw_sha256) = 64),
  base_usage_status TEXT NOT NULL CHECK (base_usage_status IN ('AI总结', '已优化', '定论', '过时')),
  origin_json TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  protection_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('editing', 'conflict', 'planned', 'committed', 'abandoned', 'recovery_required')),
  draft_sha256 TEXT NOT NULL CHECK (length(draft_sha256) = 64),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX one_active_editor_draft_per_path
ON editor_drafts(knowledge_path)
WHERE state IN ('editing', 'conflict', 'planned', 'recovery_required');

CREATE TABLE editor_plan_drafts (
  plan_id TEXT PRIMARY KEY REFERENCES write_plans(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL REFERENCES editor_drafts(id),
  draft_version INTEGER NOT NULL CHECK (draft_version >= 1),
  draft_sha256 TEXT NOT NULL CHECK (length(draft_sha256) = 64),
  state TEXT NOT NULL CHECK (state IN ('active', 'cancelled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  cancellation_reason TEXT CHECK (
    cancellation_reason IS NULL OR cancellation_reason IN (
      'user_cancelled', 'rule_stale', 'source_stale', 'policy_stale'
    )
  ),
  cancelled_at TEXT
);

CREATE UNIQUE INDEX one_active_editor_plan_per_draft
ON editor_plan_drafts(draft_id)
WHERE state = 'active';

CREATE TABLE editor_finalizations (
  batch_id TEXT PRIMARY KEY REFERENCES write_batches(id),
  original_batch_id TEXT NOT NULL REFERENCES write_batches(id),
  draft_id TEXT NOT NULL REFERENCES editor_drafts(id),
  direction TEXT NOT NULL CHECK (direction IN ('forward', 'continue', 'rollback', 'resolve')),
  plan_sha256 TEXT NOT NULL CHECK (length(plan_sha256) = 64),
  projection_capsule_sha256 TEXT NOT NULL CHECK (length(projection_capsule_sha256) = 64),
  finalized_state TEXT NOT NULL CHECK (finalized_state IN ('committed', 'abandoned', 'conflict')),
  finalized_at TEXT NOT NULL
);

CREATE TABLE recovery_retention_records (
  batch_id TEXT PRIMARY KEY REFERENCES write_batches(id),
  completion_kind TEXT NOT NULL CHECK (completion_kind IN (
    'clean_commit', 'recovery_continue', 'recovery_rollback', 'manual_resolve'
  )),
  verified_completed_at TEXT NOT NULL,
  retain_until TEXT NOT NULL,
  cleanup_approved_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
);

CREATE TABLE recovery_retirement_projections (
  batch_id TEXT PRIMARY KEY,
  completion_kind TEXT NOT NULL CHECK (completion_kind IN (
    'clean_commit', 'recovery_continue', 'recovery_rollback', 'manual_resolve'
  )),
  verified_completed_at TEXT NOT NULL,
  retain_until TEXT NOT NULL,
  cleanup_approved_at TEXT,
  cleanup_state TEXT NOT NULL CHECK (cleanup_state IN ('retiring', 'retired')),
  cleanup_lease_id TEXT UNIQUE,
  cleanup_control_basename TEXT UNIQUE,
  cleanup_control_header_sha256 TEXT CHECK (
    cleanup_control_header_sha256 IS NULL OR length(cleanup_control_header_sha256) = 64
  ),
  cleanup_control_journal_head_sha256 TEXT CHECK (
    cleanup_control_journal_head_sha256 IS NULL OR length(cleanup_control_journal_head_sha256) = 64
  ),
  cleanup_trash_basename TEXT UNIQUE,
  cleanup_source_dev TEXT,
  cleanup_source_ino TEXT,
  cleanup_trash_parent_dev TEXT,
  cleanup_trash_parent_ino TEXT,
  cleanup_inventory_json TEXT,
  cleanup_inventory_sha256 TEXT CHECK (
    cleanup_inventory_sha256 IS NULL OR length(cleanup_inventory_sha256) = 64
  ),
  cleanup_cursor INTEGER CHECK (cleanup_cursor IS NULL OR cleanup_cursor >= 0),
  retired_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK (
    cleanup_lease_id IS NOT NULL
      AND cleanup_control_basename IS NOT NULL
      AND cleanup_control_header_sha256 IS NOT NULL
      AND cleanup_control_journal_head_sha256 IS NOT NULL
      AND cleanup_trash_basename IS NOT NULL
      AND cleanup_source_dev IS NOT NULL
      AND cleanup_source_ino IS NOT NULL
      AND cleanup_trash_parent_dev IS NOT NULL
      AND cleanup_trash_parent_ino IS NOT NULL
      AND cleanup_inventory_json IS NOT NULL
      AND cleanup_inventory_sha256 IS NOT NULL
      AND cleanup_cursor IS NOT NULL
      AND ((cleanup_state = 'retiring' AND retired_at IS NULL)
        OR (cleanup_state = 'retired' AND retired_at IS NOT NULL))
  )
);
```

Register version 7 after migrations 1–6 and include it in server assets. `recovery_retention_records` represents only still-retained evidence and keeps its normal `write_batches` foreign key. `recovery_retirement_projections` is an explicit ledger tombstone/progress projection with **no** `write_batches` or `write_plans` foreign key, because payload retirement intentionally destroys the manifest bytes needed to reconstruct those parents after total SQLite loss. The latter can be rebuilt from a valid private control ledger alone and cannot authorize a new retirement. The retention repository backfills only from a validated manifest plus a core terminal outcome; it never infers eligibility from directory age.

- [ ] **Step 5: Implement the repository**

Expose:

```ts
export interface EditorDraftRepository {
  createOrGet(input: CreateEditorDraft): EditorDraft;
  save(id: string, expectedVersion: number, update: EditorDraftUpdate): EditorDraft;
  markConflict(id: string, expectedVersion: number): EditorDraft;
  bindPlan(id: string, expectedVersion: number, planId: string): EditorDraft;
  releaseUnpreparedPlan(input: {
    planId: string;
    expectedPlanSha256: string;
    expectedBindingVersion: number;
    reason: 'user_cancelled' | 'rule_stale' | 'source_stale' | 'policy_stale';
    nextDraftState: 'editing' | 'conflict';
  }): EditorDraft;
  markRecoveryRequired(id: string, expectedVersion: number): EditorDraft;
  finalizeCommitted(batchId: string, draftId: string): void;
  finalizeRolledBack(recoveryBatchId: string, draftId: string): void;
  finalizeResolved(recoveryBatchId: string, draftId: string): void;
  abandon(id: string, expectedVersion: number): EditorDraft;
  get(id: string): EditorDraft | undefined;
}
```

Compute `draftSha256` from canonical fields/body/protection, not timestamps or row ID. Every change is an immediate transaction with expected version. `bindPlan` stores the immutable plan and active `editor_plan_drafts` binding in one immediate transaction. `releaseUnpreparedPlan` joins the binding to `write_plans.plan_sha256`, requires exact `planId + expectedPlanSha256 + expectedBindingVersion`, the binding's captured draft version/hash still match the planned draft, and the absence of every `write_batches` row or manifest/journal/helper evidence for that plan. In one immediate transaction it marks only that binding `cancelled`, records the reason/time, increments binding version, changes the planned draft to the supplied server-derived next state, and increments draft version; it retains the immutable plan/binding audit record. Exact idempotent replay returns the same cancelled result, while mismatched replay conflicts. Implement `RecoveryRetentionRepository.ensureVerifiedCompletion` and `getActive(batchId)` in the same task: the former inserts once under batch ID/manifest-backed verified timestamp and the latter returns the still-retained row only when no independent retirement projection exists for that batch; neither decides filesystem cleanup eligibility.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
npm run test:integration -- editor-draft-repository database-kernel
npm run typecheck
```

Expected: version, conflict, freeze, restore-origin binding, idempotent forward/continue/rollback/resolve finalization, reopen and private state database tests pass.

Commit:

```bash
git add src/server/db/migrations/007_editor_workflow.sql src/server/db/migrate.ts src/server/db/repositories/editor-draft-repository.ts src/server/db/repositories/recovery-retention-repository.ts src/shared/domain/editor.ts src/shared/domain/records.ts src/server/rules/knowledge-schema.ts scripts/copy-server-assets.ts tests/integration/editor-draft-repository.test.ts
git commit -m "feat: persist versioned knowledge editor drafts"
```

### Task 2: Encode knowledge status policies and deterministic rendering

**Files:**

- Create: `src/server/rules/knowledge-edit-policy.ts`
- Create: `src/server/rules/knowledge-edit-renderer.ts`
- Test: `tests/unit/knowledge-edit-policy.test.ts`
- Test: `tests/unit/knowledge-edit-renderer.test.ts`

- [ ] **Step 1: Write failing policy tests**

Assert exact behavior:

```ts
expect(evaluateKnowledgeEdit(aiSummary, ordinaryEdit)).toEqual({ status: 'allowed' });
expect(evaluateKnowledgeEdit(optimized, evidenceOnlyEdit)).toEqual({ status: 'allowed' });
expect(evaluateKnowledgeEdit(optimized, changedClaimWithoutAck)).toMatchObject({
  status: 'requires_confirmation',
  required: ['mark_ai_pending']
});
expect(evaluateKnowledgeEdit(conclusion, evidenceOnlyEdit)).toEqual({ status: 'allowed' });
expect(evaluateKnowledgeEdit(conclusion, semanticEdit)).toMatchObject({
  status: 'requires_confirmation',
  required: ['unlock_conclusion']
});
expect(evaluateKnowledgeEdit(obsolete, accumulativeEdit)).toEqual({
  status: 'blocked',
  code: 'OBSOLETE_KNOWLEDGE_READ_ONLY'
});
```

Also assert:

- `AI总结 → 已优化` requires `approve_ai_summary`, meaning “认可当前内容”。
- Any transition to `定论` requires `set_conclusion` independently of ordinary field changes.
- `已优化 → AI总结` requires `downgrade_optimized` with a reason; changing an unrelated field cannot silently downgrade it.
- A semantic edit to `已优化` combined with downgrade to `AI总结` requires the canonical set `['downgrade_optimized', 'mark_ai_pending']`; acknowledging either one alone remains blocked. Add the same combination test for another independent transition confirmation so policy evaluation never collapses acknowledgements into a single union value.
- A semantic edit to `定论` requires `unlock_conclusion.resultingStatus` and the rendered result must be `AI总结` or `已优化`, never remain `定论`.
- A source/provenance-only addition to `定论` may preserve `定论`.
- `过时 → AI总结/已优化/定论` is blocked in this editor; future reactivation requires a dedicated source-reread workflow.

Classify evidence-only mechanically, not by prose semantics: only an old-first append to `来源资料`, a structured append inside the exact `### 原文引用` section, or a pure provenance note append is evidence-only. Any free Markdown body edit is conservatively a claim change. If the UI offers “补充例子/证据”, it sends a structured append command with exact base section hash; the service verifies the only changed byte range is the target evidence section before granting evidence-only policy.

- [ ] **Step 2: Write failing renderer golden tests**

Use BOM/CRLF/comments/unknown YAML field fixtures. Assert controlled YAML fields update while `类型`, `来源类型`, `创建日期`, unknown fields, comments and key order remain. `更新日期` changes server-side. Body is exactly the editor Markdown after line-ending normalization chosen by the original file.

For optimized semantic changes, assert the renderer uses the exact current-rule markers:

```markdown
## 被修改的小节 ==AI待认==

==AI待认== 被修改的零散段落或列表项
```

完整小节只在标题末尾标记一次，零散段落或列表项在开头标记；备注 old-first 追加 `AI待认: 2026-09-01`。For `定论`, source/provenance-only additions that preserve meaning remain allowed, while semantic changes require `unlock_conclusion`. For `mark_obsolete`, assert the reason and replacement wikilink are present in the controlled note/body output and the replacement resolves to an active indexed note.

- [ ] **Step 3: Run and verify RED**

Run:

```bash
npm run test:unit -- knowledge-edit-policy knowledge-edit-renderer
```

Expected: policy and rendering modules are absent.

- [ ] **Step 4: Implement deterministic policy classification**

Export:

```ts
export type KnowledgeEditPolicyResult =
  | { status: 'allowed' }
  | { status: 'requires_confirmation'; required: readonly EditAcknowledgement['kind'][]; reasons: string[] }
  | { status: 'blocked'; code: 'OBSOLETE_KNOWLEDGE_READ_ONLY' | 'OBSOLETE_REACTIVATION_REQUIRES_REREAD' | 'INVALID_REPLACEMENT'; reasons: string[] };

export function evaluateKnowledgeEdit(input: {
  before: ParsedKnowledgeForEdit;
  draft: EditorDraft;
  changedSections: readonly string[];
  replacement?: KnowledgeRecord;
}): KnowledgeEditPolicyResult;
```

The server derives changed fields and exact byte ranges from before and draft, derives the complete required acknowledgement set, canonicalizes it, and requires exact coverage from `draft.protection.acknowledgements`; extra acknowledgements are rejected rather than used as blanket consent. It does not trust a browser-provided `evidenceOnly` boolean or change-category label; a structured evidence append is revalidated against the base section hash and resulting ranges.

- [ ] **Step 5: Implement exact rendering**

`renderKnowledgeEdit(beforeBytes, draft, date)` locates approved YAML ranges, patches them from highest byte offset downward, preserves server-owned values, renders body with the original newline convention, injects required protection blocks deterministically, enforces status-transition confirmations, reparses through `parseKnowledgeNote`, and returns `{ bytes, rawSha256, changedFields, changedSections }`. An unlocked semantic change to `定论` writes the selected `AI总结` or `已优化` result; it cannot retain `定论`. Unsafe YAML locations return `KNOWLEDGE_EDIT_PATCH_UNSAFE`.

```ts
export function renderKnowledgeEdit(
  beforeBytes: Uint8Array,
  draft: EditorDraft,
  plannedUpdateDate: string
): {
  readonly bytes: Uint8Array;
  readonly rawSha256: string;
  readonly changedFields: readonly (keyof EditableKnowledgeFields)[];
  readonly changedSections: readonly string[];
};
```

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
npm run test:unit -- knowledge-edit-policy knowledge-edit-renderer knowledge-frontmatter-patch
npm run typecheck
```

Expected: all status, confirmation, obsolete-transition and golden-byte tests pass.

Commit:

```bash
git add src/server/rules/knowledge-edit-policy.ts src/server/rules/knowledge-edit-renderer.ts tests/unit/knowledge-edit-policy.test.ts tests/unit/knowledge-edit-renderer.test.ts
git commit -m "feat: enforce knowledge editor policies"
```

### Task 3: Implement open, autosave, reload and conflict services

**Files:**

- Create: `src/server/workflow/knowledge-editor-service.ts`
- Test: `tests/integration/knowledge-editor-service.test.ts`

- [ ] **Step 1: Write failing service tests**

Cover:

1. Open rereads the live knowledge and creates/resumes a matching active draft.
2. Open rejects paths outside `02知识库` and schema-invalid notes.
3. Autosave validates controlled fields and does not touch the vault.
4. Live raw hash change marks the draft conflict before save/plan.
5. Reload abandons the conflicting draft and creates a new draft from live bytes.
6. Discard marks abandoned and leaves formal bytes unchanged.
7. Planned/recovery drafts cannot be discarded.

Example:

```ts
const opened = await service.open({ path, expectedRawSha256: indexed.rawSha256 });
await gateway.replaceOutsideApp(path, externallyEditedBytes);
await expect(service.save(opened.id, opened.version, edit))
  .rejects.toMatchObject({ code: 'EDITOR_SOURCE_CONFLICT' });
expect(repository.get(opened.id)?.state).toBe('conflict');
expect(await gateway.readRaw(path)).toMatchObject({ rawSha256: sha256Bytes(externallyEditedBytes) });
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npm run test:integration -- knowledge-editor-service
```

Expected: service is absent.

- [ ] **Step 3: Implement the service API**

Expose:

```ts
export interface KnowledgeEditorService {
  open(input: { path: string; expectedRawSha256: string }): Promise<EditorDraft>;
  get(id: string): EditorDraft;
  save(id: string, expectedVersion: number, update: EditorDraftUpdate): Promise<EditorDraft>;
  reload(id: string, expectedVersion: number): Promise<EditorDraft>;
  abandon(id: string, expectedVersion: number): EditorDraft;
}
```

Every open/save/reload reads live bytes through `FileSystemVaultGateway`. Draft storage contains body/fields but no API key, recovery bytes or unrelated knowledge body. Audit payloads contain path/hash/version/action only.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
npm run test:integration -- knowledge-editor-service
npm run typecheck
```

Expected: open, restart resume, autosave, conflict, reload and no-vault-mutation tests pass.

Commit:

```bash
git add src/server/workflow/knowledge-editor-service.ts tests/integration/knowledge-editor-service.test.ts
git commit -m "feat: manage local knowledge editor drafts"
```

### Task 4: Plan, commit and recover edits through the shared write kernel

**Files:**

- Create: `src/server/workflow/knowledge-edit-planner.ts`
- Create: `src/server/workflow/editor-finalizer.ts`
- Create: `src/server/workflow/knowledge-edit-verifier.ts`
- Create: `src/server/recovery/recovery-retention-completion-recorder.ts`
- Modify: `src/shared/domain/editor.ts`
- Modify: `src/shared/domain/write.ts`
- Modify: `src/server/workflow/write-intent-registry.ts`
- Modify: `src/server/workflow/recovery-service.ts`
- Modify: `src/server/workflow/write-repository.ts`
- Modify: `src/server/workflow/write-coordinator.ts`
- Modify: `src/server/start-server.ts`
- Modify: `src/server/db/repositories/recovery-retention-repository.ts`
- Test: `tests/unit/knowledge-edit-planner.test.ts`
- Test: `tests/integration/knowledge-edit-coordinator.test.ts`
- Test: `tests/integration/knowledge-edit-recovery.test.ts`
- Test: `tests/integration/recovery-retention-completion-recorder.test.ts`

- [ ] **Step 1: Write failing planner tests**

Assert planner rereads current bytes, checks exact base raw hash/draft version/hash, evaluates policy, renders/reparses after bytes and produces one `replace` knowledge step with full line diff. Same before/draft/date/rule fingerprint yields the same plan hash; any live change, draft change, policy acknowledgement or rule change invalidates it. Plan persistence plus draft binding is one immediate transaction: inject a crash between the two SQL statements and prove neither row commits. Persist an approved rule fingerprint, stop the runtime, change a bundle file and restart: draft open/save still work, but both direct and restore plan creation return `RULE_BUNDLE_UNAPPROVED`, bind no plan and write no vault bytes across repeated restarts until separate compatibility approval.

```ts
const { plan, preview } = await planner.create(draft.id, request);
expect(plan.intent).toEqual({
  kind: 'knowledge_edit',
  mode: 'draft',
  draftId: draft.id,
  draftVersion: draft.version,
  draftSha256: draft.draftSha256,
  knowledgePath: draft.knowledgePath,
  expectedRawSha256: draft.baseRawSha256
});
expect(plan.steps).toHaveLength(1);
expect(plan.steps[0]).toMatchObject({ kind: 'replace', role: 'knowledge' });
expect(preview.fullDiff).toContain('新的核心结论');
```

- [ ] **Step 2: Write failing coordinator/recovery tests**

In a sentinel temporary vault, commit an edit and assert manifest-before-mutation, atomic swap, reread, schema/hash/policy final-state verification, idempotent draft/index finalization, core committed transition, then idempotent retention completion recording before coordinator success returns. Inject a crash after core terminal persistence but before the recorder: cleanup/restore remains fail-closed, and replay records the same durable `terminal.completedAt` before returning success. Continue/rollback must use the existing recovery service and original knowledge-edit finalizer; after each core terminal outcome the shared recorder writes its recovery completion kind, which remains held pending explicit cleanup approval. Unresolved hash conflict must preserve all versions and offer Phase 4 manual resolve. Assert every recovery plan owns fresh ordinals `0..n-1` while `recoveryOfOrdinal` binds the original edit step; reject a recovery plan that reuses/reverses original ordinals or whose original mapping is not an ascending continue suffix/strictly descending rollback sequence. Keep a shared regression proving an original `create` is rolled back only by `retire-created-file` into appData quarantine, never unlink, even though ordinary direct editor plans themselves replace existing notes.

Add plan-lifecycle cases around a frozen draft:

```ts
const planned = await planner.create(draft.id, request);
const released = await planner.cancelUnpreparedPlan({
  planId: planned.plan.id,
  expectedPlanSha256: planned.plan.planSha256,
  expectedBindingVersion: planned.bindingVersion
});
expect(released.state).toBe('editing');
expect(released.version).toBe(planned.boundDraftVersion + 1);

const preparedPlan = await planner.create(secondDraft.id, secondRequest);
faultInjector.failOnceAt('manifest-persisted');
await expect(coordinator.execute({
  authorization: testAuthorization,
  plan: preparedPlan.plan,
  projectionCapsule: preparedPlan.projectionCapsule,
  bytesBySha256: preparedPlan.bytesBySha256
})).rejects.toMatchObject({ code: 'INJECTED_CRASH' });
await expect(planner.cancelUnpreparedPlan({
  planId: preparedPlan.plan.id,
  expectedPlanSha256: preparedPlan.plan.planSha256,
  expectedBindingVersion: preparedPlan.bindingVersion
})).rejects.toMatchObject({ code: 'WRITE_PLAN_ALREADY_PREPARED' });
```

Repeat cancellation after an external live-file change and require `conflict`, not `editing`. A stale binding version, wrong plan ID/SHA, already-cancelled mismatched replay, or already prepared/executing/recovery batch changes no rows. A plan rejected by the rule gate or verifier before manifest preparation calls the same internal `releaseUnpreparedPlan` path with the specific stale reason; a prepared plan is owned only by coordinator/recovery and cannot be released by editor lifecycle code.

Assert the knowledge-edit handler builds a strict `DomainProjectionCapsule` before authorization and the first vault mutation. It binds the draft ID/version/hash, direct-or-restore origin, source-batch binding where applicable, knowledge path/base version, policy/rule references, required acknowledgements and the exact before/after index projection hashes below. Reject wrong kind, unknown fields, wrong plan/draft/source binding, noncanonical acknowledgement order, altered payload digest, absolute paths, API/model keys, auth/session/CSRF tokens, raw Markdown/YAML/source bodies, or embedded before/after bytes before manifest preparation.

For ordinary clean commit, recovery continue, recovery rollback and manual resolve, delete or corrupt SQLite after disk convergence but before finalization and restart in a fresh process. The scanner must load the original immutable manifest capsule and handler schema, reconstruct exactly one draft, plan binding/finalization, affected index row and retention completion projection, then replay idempotently. Forward/continue produce `committed`; rollback produces `abandoned`; resolve produces `conflict`. Draft controlled fields/body are reparsed from the verified current disk or manifest-owned planned/before blob appropriate to that direction; they are never duplicated inside the capsule. Missing or tampered capsule/blob leaves recovery manual-only and must not synthesize a draft from path names.

- [ ] **Step 3: Run and verify RED**

Run:

```bash
npm run test:unit -- knowledge-edit-planner
npm run test:integration -- knowledge-edit-coordinator knowledge-edit-recovery recovery-retention-completion-recorder
```

Expected: knowledge-edit intent and handler are absent.

- [ ] **Step 4: Extend the existing write intent union**

Add only this intent member and union append to `src/shared/domain/write.ts`:

```ts
export type KnowledgeEditWriteIntent =
  | {
      readonly kind: 'knowledge_edit';
      readonly mode: 'draft';
      readonly draftId: string;
      readonly draftVersion: number;
      readonly draftSha256: string;
      readonly knowledgePath: string;
      readonly expectedRawSha256: string;
    }
  | {
      readonly kind: 'knowledge_edit';
      readonly mode: 'restore';
      readonly draftId: string;
      readonly draftVersion: number;
      readonly draftSha256: string;
      readonly sourceBatchId: string;
      readonly sourceStepOrdinal: number;
      readonly sourceManifestSha256: string;
      readonly knowledgePath: string;
      readonly expectedRawSha256: string;
      readonly restoreRawSha256: string;
    };

export type WriteIntent =
  | KernelTestWriteIntent
  | KernelRecoveryWriteIntent
  | IntakeWriteIntent
  | ExtractionBatchWriteIntent
  | KnowledgeEditWriteIntent;
```

Add the intent-owned projection payload types to `src/shared/domain/editor.ts`, beside the existing editor types:

```ts

export type KnowledgeIndexProjectionCapsule = {
  readonly rawSha256: string;
  readonly knowledgeType: KnowledgeType;
  readonly usageStatus: EditableKnowledgeFields['usageStatus'];
  readonly conclusionSha256: string;
  readonly topicPaths: readonly string[];
  readonly sourcePaths: readonly string[];
  readonly replacementPath?: string;
  readonly projectionSha256: string;
};

export type KnowledgeEditProjectionCapsulePayload = {
  readonly capsuleSchemaVersion: 1;
  readonly binding: {
    readonly planId: string;
    readonly planSha256: string;
    readonly boundDraftVersion: number;
    readonly bindingVersion: number;
  };
  readonly draft: {
    readonly id: string;
    readonly expectedVersion: number;
    readonly draftSha256: string;
    readonly createdAt: string;
    readonly knowledgePath: string;
    readonly baseRawSha256: string;
    readonly baseUsageStatus: EditableKnowledgeFields['usageStatus'];
    readonly origin:
      | { readonly kind: 'direct' }
      | {
          readonly kind: 'restore';
          readonly sourceBatchId: string;
          readonly sourceStepOrdinal: number;
          readonly sourceManifestSha256: string;
          readonly restoreRawSha256: string;
        };
  };
  readonly policy: {
    readonly policyId: 'knowledge-edit-v1';
    readonly ruleBundleSha256: string;
    readonly policyInputSha256: string;
    readonly requiredAcknowledgements: readonly EditAcknowledgement['kind'][];
    readonly plannedUpdateDate: string;
  };
  readonly projections: {
    readonly before: KnowledgeIndexProjectionCapsule;
    readonly after: KnowledgeIndexProjectionCapsule;
    readonly forward: { readonly draftState: 'committed'; readonly draftVersion: number };
    readonly rollback: { readonly draftState: 'abandoned'; readonly draftVersion: number };
    readonly resolve: { readonly draftState: 'conflict'; readonly draftVersion: number };
  };
};
```

Add `KnowledgeEditWriteIntent` to the existing `WriteIntent` union and store it in `WritePlan.intent`; reuse the existing `knowledge` step role. Do not duplicate or rename `WritePlan`, `WriteStep`, `FileVersion`, `WriteBatch`, manifest or recovery types.

Define recursively `.strict()` runtime schemas for `KnowledgeIndexProjectionCapsule` and `KnowledgeEditProjectionCapsulePayload`. All paths use the normalized vault-relative path schema; topic paths stay under the configured topic-node namespace, source paths stay under `01图书馆`, the knowledge path stays under `02知识库`, arrays are unique and UTF-8 sorted, hashes are 64 lowercase hex, acknowledgement kinds are unique/canonical, and binding/draft versions are positive integers. Recompute both projection hashes from canonical controlled projections and the payload hash from the complete payload. Strictly require `binding.planId/planSha256` to equal the immutable manifest plan, `boundDraftVersion` to equal the plan intent's draft version, and `bindingVersion` to equal the persisted active binding captured before preparation. The core wrapper is exactly `{ schemaVersion: 1, intentKind: 'knowledge_edit', payload, payloadSha256 }`; strict parsing excludes raw bodies, absolute roots and secrets.

- [ ] **Step 5: Implement planner and existing-kernel handler**

Keep editor diff outside the core write plan:

```ts
export type PlannedKnowledgeEdit = {
  readonly plan: WritePlan;
  readonly projectionCapsule: DomainProjectionCapsule;
  readonly bytesBySha256: ReadonlyMap<string, Uint8Array>;
  readonly boundDraftVersion: number;
  readonly bindingVersion: number;
  readonly preview: {
    readonly knowledgePath: string;
    readonly beforeRawSha256: string;
    readonly afterRawSha256: string;
    readonly fullDiff: string;
    readonly policy: KnowledgeEditPolicyResult;
  };
};

const verifier: WriteIntentVerifierHandler<'knowledge_edit'> = {
  kind: 'knowledge_edit',
  buildProjectionCapsule(input) {
    return knowledgeEditVerifier.buildProjectionCapsule(input);
  },
  validateProjectionCapsule(capsule) {
    return knowledgeEditVerifier.validateProjectionCapsule(capsule);
  },
  verifyPlan(intent, plan) { return knowledgeEditVerifier.verifyPlan(intent, plan); },
  verifyStep(intent, step) { return knowledgeEditVerifier.verifyStep(intent, step); },
  verifyFinalState(intent, plan) {
    return knowledgeEditVerifier.verifyFinalState(intent, plan);
  }
};

const finalizer: WriteIntentFinalizerHandler<'knowledge_edit'> = {
  kind: 'knowledge_edit',
  finalizeVerified(input) { return editorFinalizer.finalizeVerified(input); },
  finalizeRecoveryVerified(input) {
    return editorFinalizer.finalizeRecoveryVerified(input);
  }
};
```

`projectionCapsule` and `bytesBySha256` remain server-internal execution inputs. API responses contain the public preview and immutable plan/binding identifiers only; the route must not serialize the capsule, planned bytes, retained bytes or raw document bodies to HTTP, logs or renderer state.

`KnowledgeEditPlanner.create(...): Promise<PlannedKnowledgeEdit>` receives Phase 1's process-wide `WorkflowMutationMutex` from `startServer()` and holds it from the first live draft/origin/rule/recovery read through final plan persistence and draft binding. For restore mode this includes retention eligibility, retained-version descriptor read, current-target comparison and the final immediate transaction; cleanup therefore cannot move the source batch between preflight and binding. It first reloads the full rule bundle and requires the injected `RuleCompatibilityGate` approves that exact fingerprint, then persists the immutable plan and binds the draft only after all other preflight checks pass, in the repository's one immediate transaction. A barrier test starts restore planning, pauses after the retained-version read, starts retention cleanup, and proves cleanup cannot acquire the same mutex or move evidence until the restore plan is bound; after release cleanup must recheck and observe the new hold. It exposes `cancelUnpreparedPlan({ planId, expectedPlanSha256, expectedBindingVersion })`: under that same workflow mutation mutex it rechecks the live base and recovery scanner, derives `editing` or `conflict` plus the precise cancellation reason, and delegates the exact binding release to `EditorDraftRepository.releaseUnpreparedPlan`. Register `WriteIntentVerifierHandler<'knowledge_edit'>` and `WriteIntentFinalizerHandler<'knowledge_edit'>` in the existing `WriteIntentHandlerRegistry`; do not branch `WriteCoordinator`. `buildProjectionCapsule` derives the payload from the validated draft/origin, exact plan, deterministic policy result and reparsed before/after controlled projections; `validateProjectionCapsule` strictly checks every cross-field hash/binding before policy authorization. `KnowledgeEditVerifier` implements `verifyPlan(intent, plan)`, `verifyStep(intent, step)` and `verifyFinalState(intent, plan)`, confirming gate approval, path/hash/schema, policy-required markers, capsule projections and final reread bytes. A current-but-unapproved bundle returns `RULE_BUNDLE_UNAPPROVED`; an approved fingerprint different from the plan returns `RULE_BUNDLE_STALE`, both before mutation. Any pre-manifest rejection releases the exact binding through the same lifecycle method; after any batch/manifest evidence exists, only coordinator/recovery may transition it. `EditorFinalizer.finalizeVerified({ intent, plan, batchId, projectionCapsule })` is idempotent under `(batchId, plan.planSha256, projectionCapsule.payloadSha256)`: strictly validate the capsule, reparse verified after bytes, refresh or reconstruct the affected knowledge index row, verify its raw hash and recall projection equals the capsule's after projection, then reconstruct/mark the bound direct/restore draft finalized. Only after it resolves may the core batch become committed; the shared completion recorder below must also finish before coordinator/API/UI success returns.

The same finalizer implements `finalizeRecoveryVerified({ originalIntent, originalPlan, originalBatchId, recoveryPlan, recoveryBatchId, direction, projectionCapsule })`. After recovery disk/journal/capsule/final-state verification and before the recovery outcome is visible, `continue` produces the same capsule-checked after-state index/draft finalization; `rollback` checks the restored parse projection against capsule `before`, refreshes/reconstructs the index row and marks the reconstructed draft abandoned/retriable so a new draft may open; `resolve` refreshes only a parseable kept/selected current version, otherwise records a schema issue, and reconstructs the draft in `conflict` rather than committed. All directions are idempotent by original/recovery batch IDs plus capsule hash; none dispatches domain work from the `kernel_recovery` intent. Rollback never marks the original batch committed, and resolve leaves it `manually-resolved`, with the editor requiring a fresh draft/review before any further formal write.

Create one `RecoveryRetentionCompletionRecorder` and inject it into the existing coordinator/recovery service as a generic terminal-outcome hook, not an intent branch. After the core terminal transition is durable, but before locks release or success returns, call `record({ originalBatchId, coreState, completionKind, verifiedCompletedAt: terminal.completedAt })`. `completedAt` comes from the validated fsynced terminal journal record; neither SQLite transition time, finalizer time, process time nor directory mtime may replace it. Ordinary `committed` maps to `clean_commit`; recovery directions map to `recovery_continue`, `recovery_rollback` or `manual_resolve`. The recorder is independent of `kernel_test/intake/extraction_batch/knowledge_edit`: test every current intent kind plus every recovery direction. If recording fails after the terminal transition, return a stable `RETENTION_RECORD_PENDING`, keep cleanup/restore unavailable, and retry the same idempotent record on the next status request/startup before exposing success. Startup backfill in Task 6 is the repair path, not the primary live wiring.

- [ ] **Step 6: Add reverse-plan restoration for committed edits**

Resolve the requested operation to one committed source batch and strictly parse its immutable original plan from the validated manifest. Before loading any before blob, require `originalPlan.intent.kind === 'knowledge_edit'`, `originalPlan.steps.length === 1`, and that sole step is `{ kind: 'replace', role: 'knowledge' }` whose path equals the intent knowledge path. Reject `kernel_test`, `kernel_recovery`, `intake`, `extraction_batch`, create, move, mkdir, zero-step, multi-step and mixed-role plans with `RESTORE_SOURCE_UNSUPPORTED`; V1 never restores one selected step from a domain transaction whose other projections would be left stale. Then resolve the exact original knowledge step ordinal/path, validated manifest hash and retained before blob. Require the batch is `committed`, final-state verified, not pending recovery or manual resolution, the retained blob hash equals the original step's expected-before hash, and the 30-day retention record is still active. A missing/expired/corrupt/mismatched snapshot returns `RESTORE_SNAPSHOT_UNAVAILABLE`; never accept a renderer path or raw bytes.

Create a dedicated `EditorDraft` with `origin.kind: 'restore'`, the source batch/step/manifest/blob binding above, current live bytes as its base, and the retained historical bytes parsed into controlled fields/body. The restore draft is reviewed through the same policy, acknowledgement-set and full-diff UI and then frozen like a direct draft. Its `knowledge_edit` intent with `mode: 'restore'` repeats `draftId`, version/hash and the immutable source binding, uses current live raw hash as expected before and historical raw hash as after. `EditorFinalizer` can therefore write the existing non-null `draft_id` finalization row for forward, restore, replay and rollback; restore never depends on a nullable or fabricated draft. If the live note, retained manifest/blob, draft or retention eligibility changes after preview, plan creation/execution returns a conflict. No direct overwrite API is added.

```ts
function requireV1RestoreSource(plan: WritePlan): ReplaceStep {
  if (plan.intent.kind !== 'knowledge_edit' || plan.steps.length !== 1) {
    throw new DomainError('RESTORE_SOURCE_UNSUPPORTED');
  }
  const [step] = plan.steps;
  if (step.kind !== 'replace' || step.role !== 'knowledge' ||
      step.path !== plan.intent.knowledgePath) {
    throw new DomainError('RESTORE_SOURCE_UNSUPPORTED');
  }
  return step;
}
```

- [ ] **Step 7: Verify GREEN and commit**

Run:

```bash
npm run test:unit -- knowledge-edit-planner
npm run test:integration -- knowledge-edit-coordinator knowledge-edit-recovery recovery-retention-completion-recorder
npm run typecheck
```

Expected: normal edit, index finalization, external race, crash including finalize-to-commit, continue, rollback and reverse-plan tests pass through one shared kernel.

Commit:

```bash
git add src/server/workflow/knowledge-edit-planner.ts src/server/workflow/editor-finalizer.ts src/server/workflow/knowledge-edit-verifier.ts src/server/recovery/recovery-retention-completion-recorder.ts src/shared/domain/editor.ts src/shared/domain/write.ts src/server/workflow/write-intent-registry.ts src/server/workflow/recovery-service.ts src/server/workflow/write-repository.ts src/server/workflow/write-coordinator.ts src/server/start-server.ts src/server/db/repositories/recovery-retention-repository.ts tests/unit/knowledge-edit-planner.test.ts tests/integration/knowledge-edit-coordinator.test.ts tests/integration/knowledge-edit-recovery.test.ts tests/integration/recovery-retention-completion-recorder.test.ts
git commit -m "feat: commit knowledge edits through the write kernel"
```

### Task 5: Expose strict editor APIs

**Files:**

- Create: `src/server/api/routes/editor-drafts.ts`
- Modify: `src/shared/api/schemas.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/start-server.ts`
- Modify: `src/client/api/client.ts`
- Test: `tests/integration/editor-api.test.ts`
- Test: `tests/component/api-client.test.tsx`

- [ ] **Step 1: Write failing API tests**

Cover:

```text
POST   /api/v1/editor-drafts
GET    /api/v1/editor-drafts/:id
PATCH  /api/v1/editor-drafts/:id
POST   /api/v1/editor-drafts/:id/reload
DELETE /api/v1/editor-drafts/:id
POST   /api/v1/editor-drafts/:id/write-plan
POST   /api/v1/write-plans/:planId/cancel
POST   /api/v1/write-batches/:batchId/restore-plan
```

The DELETE route abandons a local draft only; it never deletes vault content. Reuse Phase 4's one generic plan-cancel route—do not add an editor-specific duplicate. For a `knowledge_edit` binding it accepts exact plan SHA/binding version, dispatches to `cancelUnpreparedPlan`, and returns the authoritative released draft/binding; it cannot cancel once any batch or recovery evidence exists. Preserve the Phase 4 pre-dispatch guard on both generic cancel/supersede routes: every intake plan returns `INTAKE_PLAN_LIFECYCLE_ROUTE_REQUIRED` with no idempotency or lifecycle effect and must use only its Phase 2 job-bound confirmed-plan route. Mutations require session/CSRF, expected version and idempotency where an operation may be replayed. Unknown YAML fields, attempts to edit `类型/来源类型/创建日期`, stale draft/live hashes and invalid protection objects fail before plan creation. `restore-plan` returns `RESTORE_SOURCE_UNSUPPORTED` before blob access for every source whose strictly parsed original plan is not exactly one `knowledge_edit` replace step.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npm run test:integration -- editor-api
```

Expected: routes are absent.

- [ ] **Step 3: Add strict schemas**

Define `.strict()` schemas for editable fields, protection discriminated union, draft summary/detail, open/save/reload/abandon, plan preview and editor conflict. The conflict response includes current hash, base hash, changed-at metadata and safe actions, never raw server bytes from unrelated versions.

Save body is exactly:

```ts
z.object({
  expectedVersion: z.number().int().positive(),
  fields: editableKnowledgeFieldsSchema,
  bodyMarkdown: z.string().max(2_000_000),
  protection: editProtectionSchema
}).strict();
```

Plan cancellation is exactly:

```ts
z.object({
  expectedPlanSha256: sha256Schema,
  expectedBindingVersion: z.number().int().positive()
}).strict();
```

- [ ] **Step 4: Implement service-only routes and client methods**

Routes call editor service/planner/shared coordinator only. Extend the client with `openEditorDraft`, `getEditorDraft`, `saveEditorDraft`, `reloadEditorDraft`, `abandonEditorDraft`, `createEditorWritePlan` and `createRestorePlan`, and reuse Phase 4's `cancelWritePlan`. The reused generic `POST /api/v1/write-batches` path accepts the intended `knowledge_edit` create/restore plans but preserves Phase 4's fixed pre-effect rejection of every `intake` plan with `INTAKE_EXECUTION_ROUTE_REQUIRED`; the generic write-plan cancel/supersede routes likewise preserve `INTAKE_PLAN_LIFECYCLE_ROUTE_REQUIRED`, and editor wiring must not widen either boundary. Map `EDITOR_SOURCE_CONFLICT`, `KNOWLEDGE_PROTECTED`, `INVALID_REPLACEMENT`, `WRITE_PLAN_ALREADY_PREPARED`, `RESTORE_SOURCE_UNSUPPORTED` and `RECOVERY_REQUIRED` to distinct Chinese UI states.

```ts
cancelWritePlan(
  planId: string,
  body: { expectedPlanSha256: string; expectedBindingVersion: number },
  idempotencyKey: string
): Promise<ApiClientResult<WritePlanPreview>>;
```

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
npm run test:integration -- editor-api local-http-security
npm run test:component -- api-client
npm run typecheck
```

Expected: validation, concurrency, security, conflict and no-delete-vault tests pass.

Commit:

```bash
git add src/server/api/routes/editor-drafts.ts src/shared/api/schemas.ts src/server/app.ts src/server/start-server.ts src/client/api/client.ts tests/integration/editor-api.test.ts tests/component/api-client.test.tsx
git commit -m "feat: expose knowledge editor APIs"
```

### Task 6: Enforce 30-day recovery retention with identity-bound, non-deleting payload retirement

**Files:**

- Modify: `src/server/db/repositories/recovery-retention-repository.ts`
- Create: `src/server/recovery/recovery-retention-service.ts`
- Create: `src/server/recovery/recovery-retirement-ledger.ts`
- Modify: `src/server/recovery/recovery-export-service.ts`
- Modify: `src/server/recovery/recovery-scanner.ts`
- Modify: `src/server/recovery/recovery-only-runtime.ts`
- Modify: `src/server/vault/PrivateRecoveryStore.ts`
- Modify: `native/macos/atomic-file-helper.c`
- Modify: `src/server/vault/atomic-helper-protocol.ts`
- Modify: `src/server/vault/AtomicFileHelper.ts`
- Modify: `src/server/vault/native-capability-profile.ts`
- Modify: `src/server/vault/native-capability-probe.ts`
- Modify: `src/server/api/routes/recovery.ts`
- Modify: `src/server/start-server.ts`
- Modify: `src/shared/api/schemas.ts`
- Modify: `src/client/api/client.ts`
- Modify: `src/client/pages/RecoveryDetailPage.tsx`
- Test: `tests/native/atomic-file-helper.contract.test.ts`
- Test: `tests/unit/atomic-helper-protocol.test.ts`
- Test: `tests/unit/native-capability-profile.test.ts`
- Test: `tests/integration/native-capability-gate.test.ts`
- Test: `tests/integration/recovery-retention-service.test.ts`
- Test: `tests/unit/recovery-retirement-ledger.test.ts`
- Test: `tests/integration/recovery-only-runtime.test.ts`
- Test: `tests/component/recovery-retention.test.tsx`

- [ ] **Step 1: Write failing eligibility and hold tests**

Use an injected UTC clock and fresh private appData/recovery fixture. Assert a clean, fully verified `committed` batch is retained through `verifiedCompletedAt + 30 days`, becomes auto-eligible for payload retirement one instant after the boundary, and remains retained when any of these holds exists:

```text
pending/incomplete recovery
active direct or restore draft referencing sourceBatchId
planned or recovery-required restore batch
active main-private export lease or cleanup lease
manifest/journal/blob/retained validation failure
batch directory realpath/dev/ino/mode mismatch
completion kind recovery_continue/recovery_rollback/manual_resolve without user approval
```

Assert `manual-only`, unknown, damaged and nonterminal batches are never auto-eligible. An unfinished batch cannot be approved; after verified continue/rollback/resolve, an explicit user approval may make that exact terminal batch eligible, but it still must pass every reference/integrity check. Simulate a restore draft created immediately before cleanup lock acquisition and require cleanup to abort without moving the batch directory.

Use Phase 4's one shared `RecoveryEvidenceLeaseCoordinator` in the export and retention fixtures. Hold an export after its first validated batch read and assert cleanup cannot acquire its lease, cannot persist `retiring`, and cannot move the batch. Hold cleanup after its exclusive lease acquisition and assert export fails before reading the batch or opening a destination. Release each barrier and prove the waiting operation must start again from a fresh snapshot/eligibility check; it may not continue a stale check. Export validation/stream/destination failure and cleanup eligibility/move failure each release the in-memory guard exactly once.

For an eligible batch, crash at each boundary below and start a fresh process:

```ts
const cleanupCheckpoints = [
  'control-ledger-promoted-before-sqlite-projection',
  'sqlite-projected-before-batch-move',
  'batch-moved-to-trash',
  'entry-payload-retired-before-cursor-update',
  'cursor-updated',
  'control-terminal-appended-before-sqlite-projection',
  'retired-state-projected'
] as const;
```

Before `batch-moved-to-trash`, assert an immutable header and initial hash-chained journal are already exclusively promoted beneath the fixed private `recovery-retirement-control` root and fsynced through descriptor-bound operations. That ledger—not SQLite—contains one random lease ID, its exact control/trash basenames, source batch-directory and all private-root identities, the validated terminal/completion/approval proof, canonical bounded inventory plus its SHA-256, and cursor `0`. The SQLite `retiring` row is only a cross-bound projection of the same header/journal head and must also be durable before the move during a healthy run. While durable cursor `<= inventory.length`, permit only these two resumable locations for that same source identity: source present/trash absent, or source absent/trash present. Both, neither, a different root inode, changed inventory, a cursor greater than `inventory.length`, an unlisted entry, symlink, special file, cross-device child or limit overflow fails closed without deleting anything. A crash after a file payload is truncated but before its ledger result may advance only when an fsynced ledger intent exists and that exact persisted dev/ino/mode still occupies the same basename with length zero; an absent, replacement, or zero-length inode without the matching intent is a manual hold and is never treated as success. Directory inventory entries are verification-only: restart requires the same directory inode/mode and exact persisted direct-child identity set, then may append its result without mutating it. No state permits removing the trash root or the control ledger.

At every checkpoint, delete and separately corrupt the SQLite files before starting a fresh process. The recovery-only scan must discover the active control ledger even when the source batch has already moved out of `recovery/`, reconstruct the exact cursor from the append-only chain, and either resume the already-authorized lease or recognize its terminal record; it must never choose a new batch for retirement. Also reject a DB-only `retiring` row, an unjournaled moved batch, missing/partial/tampered/duplicated control header or chain, a ledger/root/header identity mismatch, a cursor gap, a result without its matching intent, and a control file accidentally included in the payload inventory. None of those corruptions may truncate, move, delete, or silently adopt an entry.

Native contract tests call the one new command directly and prove it truncates only one exact regular-file inode under a descriptor-bound private trash directory, leaves the same zero-byte inode and every directory entry in place, and contains no unlink/rmdir/remove opcode. They reject `nlink != 1`, wrong dev/ino/mode/length/hash, symlink, swapped parent/root, malformed basename, stale authorization and paths outside the private test appData. At a barrier after the last identity check, replace the basename and prove the held expected inode may be retired but the foreign replacement is never truncated, deleted or moved; the operation fails closed before cursor advancement. Stdout contains only the strict result object, never absolute/relative paths, file names or bytes.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npm run test:integration -- recovery-retention-service
npm run test:integration -- recovery-only-runtime
npm exec -- vitest run --config vitest.config.ts tests/unit/atomic-helper-protocol.test.ts tests/unit/native-capability-profile.test.ts tests/unit/recovery-retirement-ledger.test.ts
npm exec -- vitest run --config vitest.native.config.ts tests/native/atomic-file-helper.contract.test.ts --no-file-parallelism
```

Expected: the Task 1 repository record exists, but retention eligibility, SQLite-independent retirement ledger/resume, private native payload-retirement command and scheduler behavior are absent.

- [ ] **Step 3: Implement deterministic retention records and reference checks**

Expose:

```ts
export interface RecoveryRetentionService {
  backfillValidatedTerminalRecords(): Promise<{ insertedBatchIds: readonly string[] }>;
  resumeRetiringLeases(): Promise<{
    resumedBatchIds: readonly string[];
    terminalBatchIds: readonly string[];
    heldBatchIds: readonly string[];
  }>;
  recordVerifiedCompletion(input: {
    batchId: string;
    completionKind: 'clean_commit' | 'recovery_continue' | 'recovery_rollback' | 'manual_resolve';
    verifiedCompletedAt: string;
  }): Promise<void>;
  inspect(batchId: string): Promise<RecoveryRetentionSnapshot>;
  approveCompletedRecoveryCleanup(input: {
    batchId: string;
    expectedVersion: number;
    acknowledged: true;
  }): Promise<RecoveryRetentionSnapshot>;
  sweep(): Promise<{ inspected: number; retiredBatchIds: readonly string[] }>;
  close(): Promise<void>;
}

export type RecoveryRetentionDependencies = {
  readonly evidenceLeases: RecoveryEvidenceLeaseCoordinator;
  readonly workflowMutationMutex: WorkflowMutationMutex;
  readonly repository: RecoveryRetentionRepository;
  readonly recoveryStore: PrivateRecoveryStore;
  readonly retirementLedger: RecoveryRetirementLedger;
  readonly helper: AtomicFileHelper;
  readonly clock: UtcClock;
};
```

Extend the repository with a durable lease state machine; only the service may construct these inputs:

```ts
export type RecoveryRetirementInventoryEntry =
  | {
      readonly ordinal: number;
      readonly kind: 'file';
      readonly parentRelativePath: string;
      readonly parentDev: string;
      readonly parentIno: string;
      readonly basename: string;
      readonly dev: string;
      readonly ino: string;
      readonly mode: 0o600;
      readonly byteLength: number;
      readonly rawSha256: string;
    }
  | {
      readonly ordinal: number;
      readonly kind: 'directory';
      readonly parentRelativePath: string;
      readonly parentDev: string;
      readonly parentIno: string;
      readonly basename: string;
      readonly dev: string;
      readonly ino: string;
      readonly mode: 0o700;
      readonly children: readonly {
        readonly basename: string;
        readonly kind: 'file' | 'directory';
        readonly dev: string;
        readonly ino: string;
      }[];
    };

export type RecoveryRetirementHeader = {
  readonly schemaVersion: 1;
  readonly batchId: string;
  readonly cleanupLeaseId: string;
  readonly cleanupControlBasename: string;
  readonly cleanupTrashBasename: string;
  readonly createdAt: string;
  readonly appDataIdentity: DirectoryIdentity;
  readonly recoveryRootIdentity: DirectoryIdentity;
  readonly trashRootIdentity: DirectoryIdentity;
  readonly controlRootIdentity: DirectoryIdentity;
  readonly controlDirectoryIdentity: DirectoryIdentity;
  readonly sourceIdentity: DirectoryIdentity;
  readonly completionKind:
    | 'clean_commit' | 'recovery_continue' | 'recovery_rollback' | 'manual_resolve';
  readonly verifiedCompletedAt: string;
  readonly retainUntil: string;
  readonly cleanupApprovedAt: string | null;
  readonly retentionRecordVersion: number;
  readonly validatedEvidenceSha256: string;
  readonly emptyHoldSetSha256: string;
  readonly inventory: readonly RecoveryRetirementInventoryEntry[];
  readonly cleanupInventorySha256: string;
  readonly originalByteCount: number;
  readonly headerSha256: string;
};

export type RecoveryRetirementJournalBody = {
  readonly batchId: string;
  readonly cleanupLeaseId: string;
  readonly headerSha256: string;
  readonly seq: number;
  readonly previousEntrySha256: string | null;
  readonly recordedAt: string;
} & (
  | {
      readonly kind: 'entry-intent';
      readonly ordinal: number;
      readonly inventoryEntrySha256: string;
    }
  | {
      readonly kind: 'entry-result';
      readonly ordinal: number;
      readonly inventoryEntrySha256: string;
      readonly outcome: 'file-payload-retired' | 'directory-verified';
      readonly observedEntrySha256: string;
      readonly nextCursor: number;
    }
  | {
      readonly kind: 'terminal';
      readonly cursor: number;
      readonly zeroPayloadTreeSha256: string;
      readonly retiredFileCount: number;
      readonly originalByteCount: number;
      readonly retiredAt: string;
  }
);

export type RecoveryRetirementJournalEntry = RecoveryRetirementJournalBody & {
  readonly entrySha256: string;
};
export type RecoveryRetirementHeaderInput = Omit<
  RecoveryRetirementHeader,
  'controlDirectoryIdentity' | 'headerSha256'
>;
export type RecoveryRetirementLedgerSnapshot = {
  readonly header: RecoveryRetirementHeader;
  readonly journal: readonly RecoveryRetirementJournalEntry[];
  readonly journalHeadSha256: string;
  readonly cursor: number;
  readonly pendingIntentOrdinal: number | null;
  readonly terminal: Extract<RecoveryRetirementJournalEntry, { kind: 'terminal' }> | null;
  readonly controlDirectoryIdentity: DirectoryIdentity;
};
export type RetirementEntryIntentInput = {
  readonly controlBasename: string;
  readonly headerSha256: string;
  readonly expectedJournalHeadSha256: string;
  readonly ordinal: number;
  readonly inventoryEntrySha256: string;
};
export type RetirementEntryResultInput = RetirementEntryIntentInput & {
  readonly outcome: 'file-payload-retired' | 'directory-verified';
  readonly observedEntrySha256: string;
  readonly nextCursor: number;
};
export type RetirementTerminalInput = {
  readonly controlBasename: string;
  readonly headerSha256: string;
  readonly expectedJournalHeadSha256: string;
  readonly cursor: number;
  readonly zeroPayloadTreeSha256: string;
  readonly retiredFileCount: number;
  readonly originalByteCount: number;
  readonly retiredAt: string;
};

export interface RecoveryRetirementLedger {
  prepareAndPromote(input: RecoveryRetirementHeaderInput): Promise<RecoveryRetirementLedgerSnapshot>;
  loadActive(controlBasename: string): Promise<RecoveryRetirementLedgerSnapshot>;
  scanActive(): Promise<readonly RecoveryRetirementLedgerSnapshot[]>;
  appendEntryIntent(input: RetirementEntryIntentInput): Promise<string>;
  appendEntryResult(input: RetirementEntryResultInput): Promise<string>;
  appendTerminal(input: RetirementTerminalInput): Promise<string>;
}

declare const privateRecoveryRetirementAuthorizationBrand: unique symbol;
export type PrivateRecoveryRetirementAuthorization = {
  readonly [privateRecoveryRetirementAuthorizationBrand]: true;
  readonly cleanupLeaseId: string;
  readonly cleanupTrashBasename: string;
  readonly cleanupInventorySha256: string;
  readonly appDataIdentity: DirectoryIdentity;
  readonly recoveryIdentity: DirectoryIdentity;
  readonly trashParentIdentity: DirectoryIdentity;
  readonly sourceIdentity: DirectoryIdentity;
};

export type RecoveryRetentionRecord = {
  readonly batchId: string;
  readonly completionKind:
    | 'clean_commit' | 'recovery_continue' | 'recovery_rollback' | 'manual_resolve';
  readonly verifiedCompletedAt: string;
  readonly retainUntil: string;
  readonly cleanupApprovedAt: string | null;
  readonly version: number;
};
export type RecoveryRetirementProjection = {
  readonly batchId: string;
  readonly completionKind: RecoveryRetentionRecord['completionKind'];
  readonly verifiedCompletedAt: string;
  readonly retainUntil: string;
  readonly cleanupApprovedAt: string | null;
  readonly cleanupState: 'retiring' | 'retired';
  readonly cleanupLeaseId: string;
  readonly cleanupControlBasename: string;
  readonly cleanupControlHeaderSha256: string;
  readonly cleanupControlJournalHeadSha256: string;
  readonly cleanupTrashBasename: string;
  readonly cleanupSourceIdentity: DirectoryIdentity;
  readonly cleanupTrashParentIdentity: DirectoryIdentity;
  readonly cleanupInventory: readonly RecoveryRetirementInventoryEntry[];
  readonly cleanupInventorySha256: string;
  readonly cleanupCursor: number;
  readonly retiredAt: string | null;
  readonly version: number;
};

export interface RecoveryRetentionRepository {
  ensureVerifiedCompletion(input: {
    batchId: string;
    completionKind:
      | 'clean_commit' | 'recovery_continue' | 'recovery_rollback' | 'manual_resolve';
    verifiedCompletedAt: string;
    retainUntil: string;
  }): RecoveryRetentionRecord;
  getActive(batchId: string): RecoveryRetentionRecord | undefined;
  getRetention(batchId: string): RecoveryRetentionRecord | undefined;
  getRetirementProjection(batchId: string): RecoveryRetirementProjection | undefined;
  listRetainedCandidateIds(input: {
    now: string;
    limit: number;
  }): readonly string[];
  listRetirementProjections(): readonly RecoveryRetirementProjection[];
  approveCompletedRecoveryCleanup(input: {
    batchId: string;
    expectedVersion: number;
    approvedAt: string;
  }): RecoveryRetentionRecord;
  beginRetirement(input: {
    batchId: string;
    expectedVersion: number;
    cleanupLeaseId: string;
    cleanupControlBasename: string;
    cleanupControlHeaderSha256: string;
    cleanupControlJournalHeadSha256: string;
    cleanupTrashBasename: string;
    cleanupSourceIdentity: DirectoryIdentity;
    cleanupTrashParentIdentity: DirectoryIdentity;
    cleanupInventory: readonly RecoveryRetirementInventoryEntry[];
    cleanupInventorySha256: string;
    cleanupCursor: 0;
  }): RecoveryRetirementProjection;
  reconcileRetirementProjectionFromLedger(input: {
    snapshot: RecoveryRetirementLedgerSnapshot;
    expectedExistingVersion?: number;
  }): RecoveryRetirementProjection;
  advanceRetirementCursor(input: {
    batchId: string;
    cleanupLeaseId: string;
    expectedControlJournalHeadSha256: string;
    nextControlJournalHeadSha256: string;
    expectedCursor: number;
    nextCursor: number;
  }): RecoveryRetirementProjection;
  markRetired(input: {
    batchId: string;
    cleanupLeaseId: string;
    expectedControlJournalHeadSha256: string;
    terminalControlJournalHeadSha256: string;
    expectedCursor: number;
    retiredAt: string;
  }): RecoveryRetirementProjection;
}
```

`RecoveryRetirementLedger` is the sole crash-recovery truth source once retirement starts. `PrivateRecoveryStore` owns two fixed private siblings, `<userData>/recovery-retirement-control-preparing` and `<userData>/recovery-retirement-control`, both `0700`; neither is beneath the source batch or `recovery-trash`, and neither may appear in a payload inventory. For a newly authorized lease it creates one unpredictable directory under the preparing root, captures that inode, exclusively writes `header.json` and the initial empty `journal.ndjson` as `0600`, fsyncs/rereads both files and directory, then identity-bound moves the complete directory to the strict active basename `<batchId>.<cleanupLeaseId>` and fsyncs both control parents. An active name without a complete strict header is corruption, never an adoptable lease. `headerSha256` hashes the exact canonical header excluding only itself; `cleanupInventorySha256` hashes the exact ordered inventory; `validatedEvidenceSha256` binds the validated source manifest hash, terminal journal head/core outcome, retention completion row, explicit approval where required, and the empty hold set observed under the shared mutex. The header contains no source bytes, token, absolute path or secret.

Every control journal line is newline-terminated canonical JSON with `entrySha256 = SHA-256(canonical body)` and the exact previous hash, is appended/fsynced/reread through one held control-directory descriptor, and is strictly replayed from sequence zero. For each cursor ordinal, append `entry-intent` before any native truncation or directory verification, then append exactly one matching `entry-result`; only the result advances durable cursor by one. Duplicate-identical append retries are idempotent, while divergent duplicate, gap, result without intent, second pending intent, out-of-range ordinal, wrong entry digest, or a record after terminal is corrupt/manual hold. After a full descriptor-bound zero-payload-tree verification, append one terminal and fsync it before projecting `retired` to SQLite. The SQLite row caches the header hash, latest control-chain head and derived cursor using expected-version/head CAS, but it never authorizes resume and may be deleted entirely without losing the lease.

The repository interface above is the complete additive Phase 5 surface; it preserves Task 1's `ensureVerifiedCompletion()`/`getActive()` and declares every inspection, approval, candidate enumeration, ledger reconciliation and CAS method used by the service. `beginRetirement()` verifies the retained row/version against the promoted header, inserts the no-FK `recovery_retirement_projections` row and removes the now-obsolete retained row in one immediate transaction. If a crash leaves both or neither SQLite projection, `reconcileRetirementProjectionFromLedger()` treats the valid ledger as authoritative, deterministically upserts the tombstone/progress row and removes any stale retained row. A DB-only projection never works in the opposite direction. After the ledger terminal, deleting every SQLite file and rebuilding must create only the independent `retired` projection; it does not fabricate `write_plans`, `write_batches`, manifests or parent rows from a hash.

Set `retainUntil` to exact UTC `verifiedCompletedAt + 30 * 24 hours`; timestamps and directory mtimes cannot substitute for verified completion. `clean_commit` may be auto-retired after that instant. The three recovery completion kinds require `cleanupApprovedAt` from the explicit route even after 30 days. Query `editor_drafts.origin_json`, active editor/write plans, core recovery state, durable retirement state and all other persisted holds inside one read transaction. Before trusting that result, atomically acquire the shared coordinator's exclusive `cleanup` lease, then enter Phase 1's single injected `WorkflowMutationMutex` and rerun the complete transaction plus disk validation. Failure to acquire means an export is active and this sweep skips the batch without side effects; there is no separate `hasActiveExportLease()` check. Direct/restore plan creation, plan cancel/supersede, coordinator execution, recovery and retention retirement all receive this exact same mutex from `startServer()`, so none can win on a stale eligibility or binding check.

On first Phase 5 startup, backfill missing rows for older Phase 2/4 batches only by combining a validated manifest/journal, the exact core terminal state and the domain finalization row. A direct verified commit becomes `clean_commit`; a journaled continue/rollback/resolve becomes its matching recovery kind. Use the validated terminal record's `completedAt`, not scan time, SQLite transition time, finalizer time or directory mtime. Missing finalization, ambiguous outcome, damaged manifest or unknown journal remains unrecorded and therefore non-cleanable. Backfill is idempotent and emits only batch IDs/counts.

- [ ] **Step 4: Retire only one revalidated batch directory**

`sweep()` enumerates a repository-provided batch ID and uses the Phase 1 private descriptor port to bind the exact direct child under `appDataRecoveryRoot`; it rejects separators/dot segments before I/O and never authorizes a pathname-derived recursive operation. Revalidate the appData root, recovery root, private `recovery-trash` sibling and exact batch directory as non-symlinks with expected dev/ino and `0700`, then validate manifest hash, journal chain, every `0600` blob/retained file, terminal core outcome and lack of holds. Unknown extra entries, damaged metadata or `manual-only` state stop cleanup.

Acquire and hold the coordinator lease around the complete recheck, persistent retirement, held-inode payload retirement and final state transition; always release it in `finally`:

```ts
const cleanupGuard = await evidenceLeases.acquire(batchId, 'cleanup');
if (!cleanupGuard) continue;
try {
  await workflowMutationMutex.runExclusive(async () => {
    await revalidateAllRetentionHoldsAndEvidence(batchId);
    await retireOrResumeExactBatch(batchId);
  });
} finally {
  cleanupGuard.release();
}
```

Under the export/cleanup guard and workflow mutation mutex, enumerate only regular `0600` files and `0700` directories without following links. Build a canonical, unique, bottom-up `RecoveryRetirementInventoryEntry[]` whose ordinals are `0..n-1`, whose parent and entry identities are captured from held descriptors, whose directory entries also bind their exact sorted direct-child names/dev/ino/kinds, and whose total entries/bytes are within fixed constants. Derive the strict shared basename `<batchId>.<cleanupLeaseId>`, hash the canonical inventory and complete eligibility proof, then call `retirementLedger.prepareAndPromote(...)` before any source move or payload mutation. Only after rereading that promoted ledger may `beginRetirement(...)` project its basename/header/head/inventory/cursor into SQLite in an immediate transaction. During a healthy run the row must be fsynced with `cleanup_state='retiring'` and cursor `0` before the first source rename, but after a database failure the independently promoted ledger is sufficient to reconstruct that projection and resume the exact already-authorized lease. The in-memory coordinator guard prevents a live export race and never substitutes for the control ledger.

```ts
const MAX_RECOVERY_RETIREMENT_ENTRIES = 10_000;
const MAX_RECOVERY_RETIREMENT_BYTES = 20 * 1024 * 1024 * 1024;
```

Crossing either bound returns `RECOVERY_RETIREMENT_LIMIT_EXCEEDED` and leaves the batch retained; the service never truncates an inventory and never partially retires an over-limit batch.

Move the exact source directory with Phase 1's identity-bound exclusive native move into the header-bound `recovery-trash/<batchId>.<cleanupLeaseId>` name and fsync both parent directories. Resume always starts from the active control ledger, strictly replays its header/chain, then treats any matching SQLite row as a disposable corroborating projection. It accepts only the header-bound source inode at exactly one of the source/trash names. Never generate a second lease, trust a DB-only `retiring` row, or rescan/adopt a different directory. A promoted ledger whose source is still in `recovery/` resumes the same move; one whose source is already in `recovery-trash` continues at its durable journal cursor.

Extend the existing native helper and strict protocol with exactly this leaf operation:

```text
retire-private-file-payload <bound-trash-parent> <basename> <expected-dev> <expected-ino> <expected-mode> <expected-length> <expected-sha256>
```

`AtomicFileHelper.retirePrivateFilePayload(authorization, inventoryEntry)` opens the persisted parent descriptor without following links, opens the exact leaf with `O_RDWR | O_NOFOLLOW`, and through that held descriptor rechecks regular type/dev/ino/mode/length/hash plus `nlink === 1`. It then `ftruncate`s only that held expected inode to zero, fsyncs and rereads it, verifies the same descriptor identity and zero length, and finally requires the basename still resolve without following links to the same dev/ino before returning `{ ok: true, retiredDev, retiredIno, byteLength: 0 }`. A basename replacement after open can never redirect truncation to the foreign inode; it makes the final name check fail and forbids cursor advancement. The method accepts only a branded `PrivateRecoveryRetirementAuthorization` derived from the current appData/recovery/recovery-trash identities plus the persisted lease/inventory hash and never accepts an arbitrary root/path/basename from HTTP or renderer input. The helper does no recursion and exposes no unlink, rmdir, remove, or general-delete command.

Consume entries in header ordinal order. At the current ledger cursor, first append/reread its exact `entry-intent`. An exact file inode with the original length/hash is then eligible for the held-descriptor operation; after a crash with a pending intent, that same expected inode already at zero length is the sole idempotent result-reconstruction state. An absent file, a different inode, mode/link-count drift, or any zero-length entry without the matching pending intent is a manual hold and is never accepted as prior success. A directory entry is never mutated: validate its persisted identity/mode and exact direct-child identity set after its intent. Append/reread the matching `entry-result` before updating SQLite's cached `cleanup_cursor` and control-chain head with expected-cursor/head CAS; loss or corruption of that DB update changes no durable truth. When ledger cursor equals inventory length, repeat a complete descriptor-bound inventory pass and require every original file identity to be zero length and every original directory identity to remain present; any foreign or missing entry raises a durable integrity hold. Append/fsync/reread the ledger terminal first, then call `markRetired` with the terminal chain head and expected cursor `inventory.length`, and leave both the complete minimal zero-byte audit tree under `recovery-trash` and immutable control ledger under `recovery-retirement-control`. The retired state attests only that the original inventory's payload bytes were removed from their held inodes; it never claims either namespace is empty and never authorizes a later broad cleanup. Do not call Node or native `rm`, `rm -rf`, `unlink`, `rmdir`, follow links, expand globs, accept an HTTP path, or remove the batch/trash/control directory. Public audit contains batch ID, completion kind, original-byte count and retired-file count only—no source path, bytes, inventory or recovered filenames; the private ledger retains its exact identity inventory solely for verification.

Extend the existing capability key union without weakening any Phase 1 key:

```ts
readonly capabilities: Readonly<Record<
  | 'renameSwap'
  | 'renameExclusive'
  | 'mkdirExclusive'
  | 'rmdirCreatedEmpty'
  | 'hiddenInspection'
  | 'privateRecoveryIO'
  | 'noFollow'
  | 'fileFsync'
  | 'directoryFsync'
  | 'conflictPreservation'
  | 'crashRecovery'
  | 'boundedRecoveryRetirement',
  'passed' | 'failed' | 'unverified'
>>;
```

The probe creates only a private sentinel test appData tree, exercises exact held-inode payload retirement plus every refusal above, proves a raced foreign basename remains byte-for-byte intact, and records passed evidence. It also proves the helper protocol contains no delete opcode. Because the helper SHA changes, every earlier profile becomes stale automatically; no retirement or vault write is enabled until a fresh profile, including the existing crash matrix, is promoted for the same helper/OS/architecture/volume.

- [ ] **Step 5: Add explicit cleanup API, UI and lifecycle scheduling**

Add `GET /api/v1/recovery/:batchId/retention` and `POST /api/v1/recovery/:batchId/cleanup-approval`. The POST schema is strict and requires expected retention version, `acknowledged: true`, session, CSRF and idempotency. It is unavailable for nonterminal, invalid, manual-only or held batches. `RecoveryDetailPage` shows `保留至 YYYY-MM-DD`, active hold reasons and, only for a verified recovery completion, `清理已完成恢复材料`; the dialog states that original restore payload bytes will no longer be available, while a minimal zero-byte audit tree remains to avoid unsafe deletion, and requires a second confirmation. A clean commit is never presented as user cleanup before its 30-day boundary.

Construct one service in `startServer`, call `resumeRetiringLeases()` first to scan/replay every active control ledger, rebuild or correct its disposable SQLite projection and resume every valid existing lease, then call `backfillValidatedTerminalRecords()` for still-active terminal recovery batches, and only then select a new eligible batch through `sweep()`. Run later sweeps every 24 hours through an injected scheduler; unref the timer and close it before SQLite. The declared `backfillValidatedTerminalRecords()` performs only terminal-to-retention-row backfill; `resumeRetiringLeases()` owns control-ledger discovery/reconciliation/resume and must finish before both backfill and sweep. Tests assert this order and prove no new row is retired in the same pass unless its durable 30-day boundary was already exceeded. Concurrent sweeps coalesce.

`startRecoveryOnlyRuntime()` constructs a no-repository `RecoveryRetirementLedgerRecovery` from the same private store, helper, evidence coordinator and its one runtime-wide workflow mutex. It may scan and resume only ledgers already durably promoted before database loss, or expose a redacted hold; it cannot approve cleanup, calculate fresh eligibility, create a ledger, or choose a new batch. Its scanner emits a separate retirement projection for database rebuild even when the original batch now exists only under `recovery-trash`; a valid terminal ledger reconstructs `retired`, while a nonterminal ledger reconstructs `retiring` plus the exact derived cursor/head. Normal write-recovery actions never treat those moved terminal batches as missing manifests. Startup treats any DB-only row or invalid ledger/inventory/cursor/location as a hold, surfaces a redacted error, and never abandons it or starts another lease.

```ts
await retention.resumeRetiringLeases();
await retention.backfillValidatedTerminalRecords();
await retention.sweep();
const retentionTimer = scheduler.every(24 * 60 * 60 * 1_000, () => retention.sweep());
retentionTimer.unref();
```

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/atomic-helper-protocol.test.ts tests/unit/native-capability-profile.test.ts tests/unit/recovery-retirement-ledger.test.ts
npm run test:native
npm run test:integration -- native-capability-gate recovery-retention-service recovery-only-runtime knowledge-edit-recovery
npm run test:component -- recovery-retention recovery-ui
npm run typecheck
```

Expected: helper/protocol/profile tests, existing write crash matrix, 30-day boundary, terminal classifications, restore/export holds, TOCTOU rechecks, every retirement crash resume—including fresh-process SQLite deletion/corruption at every checkpoint—bounded native held-inode retirement, foreign-replacement preservation, no-delete opcode, explicit recovery approval, redacted audit and timer shutdown tests pass. A profile for the pre-Phase-5 helper SHA remains blocked.

Commit:

```bash
git add native/macos/atomic-file-helper.c src/server/vault/atomic-helper-protocol.ts src/server/vault/AtomicFileHelper.ts src/server/vault/PrivateRecoveryStore.ts src/server/vault/native-capability-profile.ts src/server/vault/native-capability-probe.ts src/server/db/repositories/recovery-retention-repository.ts src/server/recovery/recovery-retention-service.ts src/server/recovery/recovery-retirement-ledger.ts src/server/recovery/recovery-export-service.ts src/server/recovery/recovery-scanner.ts src/server/recovery/recovery-only-runtime.ts src/server/api/routes/recovery.ts src/server/start-server.ts src/shared/api/schemas.ts src/client/api/client.ts src/client/pages/RecoveryDetailPage.tsx tests/native/atomic-file-helper.contract.test.ts tests/unit/atomic-helper-protocol.test.ts tests/unit/native-capability-profile.test.ts tests/unit/recovery-retirement-ledger.test.ts tests/integration/native-capability-gate.test.ts tests/integration/recovery-retention-service.test.ts tests/integration/recovery-only-runtime.test.ts tests/component/recovery-retention.test.tsx
git commit -m "feat: retain and safely retire recovery snapshots"
```

### Task 7: Build the controlled YAML and Markdown editor

**Files:**

- Create: `src/client/pages/KnowledgeEditorPage.tsx`
- Create: `src/client/components/editor/KnowledgeYamlForm.tsx`
- Create: `src/client/components/editor/MarkdownEditor.tsx`
- Create: `src/client/components/editor/MarkdownPreview.tsx`
- Create: `src/client/components/editor/EditPolicyNotice.tsx`
- Create: `src/client/components/editor/EditDiffConfirmation.tsx`
- Create: `src/client/styles/knowledge-editor.css`
- Modify: `src/client/pages/KnowledgePage.tsx`
- Modify: `src/client/components/KnowledgeDetail.tsx`
- Modify: `src/client/pages/OperationsPage.tsx`
- Modify: `src/client/app/router.tsx`
- Test: `tests/component/knowledge-editor.test.tsx`
- Test: `tests/component/knowledge-editor-conflict.test.tsx`

- [ ] **Step 1: Write failing editor component tests**

Assert KnowledgeDetail has an `编辑` button; editor shows controlled selects/lists/text fields without arbitrary YAML text; fixed fields are read-only labels; Markdown editing and safe preview update together; autosave is debounced and sends expected version; unsaved state is announced; diff confirmation contains full YAML/body diff; final submit is explicit and disabled until preview is current.

```ts
await user.click(screen.getByRole('button', { name: '编辑' }));
expect(await screen.findByRole('heading', { name: '编辑知识' })).toBeVisible();
expect(screen.getByLabelText('知识类型')).toBeInstanceOf(HTMLSelectElement);
expect(screen.queryByLabelText('原始 YAML')).not.toBeInTheDocument();
await user.clear(screen.getByLabelText('核心结论'));
await user.type(screen.getByLabelText('核心结论'), '新的核心结论');
await waitFor(() => expect(api.saveEditorDraft).toHaveBeenCalledTimes(1));
```

- [ ] **Step 2: Write failing protected/conflict tests**

For `已优化`, mechanically verified source/provenance additions preserve status without a marker; free body or conclusion changes show the `==AI待认==` explanation and require checkbox confirmation. Provide a structured `补充例子/证据` action instead of inferring ordinary textarea edits as evidence-only. `AI总结 → 已优化` shows “认可当前内容”; any `→ 定论` has a separate confirmation; `已优化 → AI总结` requires a downgrade reason. When one edit triggers multiple rules, render every independent acknowledgement and send the canonical acknowledgement set; specifically test semantic change plus downgrade requires both `mark_ai_pending` and `downgrade_optimized`, and removing either disables preview/commit. For `定论`, source/provenance-only additions remain available, while meaning-changing edits require unlock, reason and a resulting status of `AI总结` or `已优化`. `过时` has no normal accumulation or reactivation action. Transition to 过时 requires reason/replacement and a second confirmation. External conflict shows `重新载入最新版本`, `复制我的草稿` and `返回知识库`; it has no force-save button.

```ts
expect(screen.getByRole('button', { name: '确认保存到知识库' })).toBeDisabled();
await user.click(screen.getByRole('checkbox', { name: /标记 AI 待认/ }));
await user.type(screen.getByLabelText('降级原因'), '结论需要重新核验');
await user.click(screen.getByRole('checkbox', { name: /确认降级/ }));
expect(screen.getByRole('button', { name: '确认保存到知识库' })).toBeEnabled();
expect(screen.queryByRole('button', { name: /强制保存/ })).not.toBeInTheDocument();
```

Add visual-contract assertions to both suites: reuse the current near-black/glass/silver-border/fluorescent-green tokens and no alternate theme values; every save/policy/conflict state has Chinese text, an icon and a `data-tone`. Red is only failure/conflict, amber is confirmation-required, blue is auxiliary draft/diff information, and green is saved/verified. Long editor, preview and diff surfaces have no backdrop blur. Stub `prefers-reduced-motion: reduce` and assert nonessential autosave pulse, panel and diff transitions are disabled while focus and progress text remain visible.

- [ ] **Step 3: Run and verify RED**

Run:

```bash
npm run test:component -- knowledge-editor knowledge-editor-conflict
```

Expected: editor route and controls are absent.

- [ ] **Step 4: Implement form, editor, preview and autosave**

Use accessible native controls and labels. Keep working state in the authoritative draft response. Debounce autosave by 500ms, abort superseded requests, and never navigate away while a save or commit is unresolved without an explicit choice. Markdown preview uses existing `SafeMarkdown` and does not render raw HTML. `knowledge-editor.css` consumes `--surface-void`, `--surface-glass`, `--border-*`, `--accent-primary`, `--status-amber`, `--status-red` and `--status-blue`; long-form surfaces set `backdrop-filter: none`, and a reduced-motion media query removes nonessential animation.

```tsx
<KnowledgeYamlForm draft={draft} onChange={queueAutosave} />
<MarkdownEditor value={draft.bodyMarkdown} onChange={queueAutosaveBody} />
<MarkdownPreview markdown={draft.bodyMarkdown} />
```

- [ ] **Step 5: Implement policy and diff confirmation UI**

Render server policy reasons, required acknowledgement and replacement lookup. `EditDiffConfirmation` renders server-produced diff only. The final button is named `确认保存到知识库`; route navigation, Enter in textarea and preview clicks cannot execute a batch.

```tsx
<EditDiffConfirmation
  diff={preview.fullDiff}
  policy={preview.policy}
  onCancel={() => cancelWritePlan(preview.planId, {
    expectedPlanSha256: preview.planSha256,
    expectedBindingVersion: preview.bindingVersion
  })}
  onConfirm={confirmPreparedWrite}
/>
```

`onCancel` sends the exact binding version and plan SHA, waits for the authoritative released draft/binding, and only then returns to editing. A replacement preview cannot be created until the prior unprepared binding has been cancelled through the generic route. Once commit preparation begins, disable cancel; `WRITE_PLAN_ALREADY_PREPARED` transitions to operation/recovery status instead of pretending the draft is editable.

- [ ] **Step 6: Wire operation restore**

Operations detail exposes `恢复为写入前版本` only when the server declares `restoreEligibility: 'supported_knowledge_replace'`. It first requests a reverse plan, shows the reverse full diff, and uses the same confirmation component. `RESTORE_SOURCE_UNSUPPORTED` renders `此操作不是单文件知识编辑，V1 不支持整批反向恢复` and no retry/force action. Do not expose delete or direct rollback of a historical committed transaction.

```tsx
{operation.restoreEligibility === 'supported_knowledge_replace' && (
  <button type="button" onClick={openRestorePreview}>恢复为写入前版本</button>
)}
```

- [ ] **Step 7: Verify GREEN and commit**

Run:

```bash
npm run test:component -- knowledge-editor knowledge-editor-conflict safe-markdown read-pages
npm run typecheck
```

Expected: form, autosave, policy, conflict, diff, keyboard and restore UI tests pass.

Commit:

```bash
git add src/client/pages/KnowledgeEditorPage.tsx src/client/components/editor/KnowledgeYamlForm.tsx src/client/components/editor/MarkdownEditor.tsx src/client/components/editor/MarkdownPreview.tsx src/client/components/editor/EditPolicyNotice.tsx src/client/components/editor/EditDiffConfirmation.tsx src/client/styles/knowledge-editor.css src/client/pages/KnowledgePage.tsx src/client/components/KnowledgeDetail.tsx src/client/pages/OperationsPage.tsx src/client/app/router.tsx tests/component/knowledge-editor.test.tsx tests/component/knowledge-editor-conflict.test.tsx
git commit -m "feat: add the direct knowledge editor"
```

### Task 8: Prove edit, conflict, recovery and reverse restoration in a test vault

**Files:**

- Create: `tests/e2e/test-vault-knowledge-editor.spec.ts`
- Create: `tests/e2e/test-vault-knowledge-editor.spec.ts-snapshots/knowledge-editor-diff-1440x900-chromium-darwin.png`
- Create: `tests/e2e/test-vault-editor-conflict-recovery.spec.ts`

- [ ] **Step 1: Create a guarded editor fixture matrix**

For each test, create a fresh sentinel-protected temporary vault with valid `AI总结`, `已优化`, `定论` and `过时` notes. Copy golden BOM/CRLF variants. Store pretest bytes/hashes in the test process only.

```ts
const fixture = await createAtomicTestVault();
await fixture.writeKnowledge('02知识库/方法/example.md', goldenAiSummaryBytes);
const before = await fixture.readAndHash('02知识库/方法/example.md');
expect(fixture.vaultRoot).not.toBe('/Users/ao/我的大脑');
```

- [ ] **Step 2: Prove normal and protected edits**

Drive:

```text
Knowledge → detail → 编辑 → change controlled YAML/body
→ autosave → full diff → confirm
→ committed → search/index shows new values
```

Repeat for `AI总结 → 已优化` recognition, `已优化` evidence-only and `==AI待认==` claim changes, `定论` provenance-only preservation and semantic unlock to a non-定论 status, and transition to `过时` with reason/replacement. Assert `过时 → 活跃` is blocked. Reread bytes and verify schema, hash, controlled fields and preserved unknown YAML bytes.

At the full-diff gate, set a fixed 1440×900 dark viewport, disable animations and capture `knowledge-editor-diff-1440x900.png` with `toHaveScreenshot`. The reviewed baseline must preserve the existing near-black glass shell, silver borders, fluorescent-green confirmed action, amber policy acknowledgement and blue auxiliary diff metadata, with no red in a healthy save. Repeat the layout check with reduced motion and assert no nonessential animated transform.

- [ ] **Step 3: Prove external conflict and crash recovery**

Externally change a note after draft open and after plan creation; both must stop before overwrite. A pre-manifest stale preview releases its exact binding and reconstructs the draft as `conflict`; a user-cancelled current preview returns to `editing`, and the released plan SHA can no longer execute. Once any batch/manifest evidence exists, cancellation returns `WRITE_PLAN_ALREADY_PREPARED` and leaves recovery ownership intact. Terminate at every shared coordinator fault point, restart, then continue or rollback where hashes allow. Verify draft state, disk bytes and operation timeline remain consistent.

```ts
await page.getByRole('button', { name: '取消本次预览' }).click();
await expect(page.getByRole('heading', { name: '编辑知识' })).toBeVisible();
const replay = await api.commitWritePlan(
  releasedPlanId,
  releasedPlanSha256,
  releasedBindingVersion,
  crypto.randomUUID()
);
expect(replay).toMatchObject({ ok: false, error: { code: 'WRITE_PLAN_NOT_BOUND' } });
```

- [ ] **Step 4: Prove reverse restoration is a new transaction**

After a committed edit, create a reverse plan, inspect its full diff and commit it. Assert a new operation ID/batch exists and current bytes equal the original bytes. Then edit the note externally and assert the same reverse request is rejected rather than overwriting the newer file.

```ts
for (const unsupported of [
  intakeBatchId,
  extractionBatchId,
  kernelBatchId,
  multiStepKnowledgeBatchId
]) {
  await expect(createRestorePlan(unsupported)).rejects.toMatchObject({
    code: 'RESTORE_SOURCE_UNSUPPORTED'
  });
}
```

Keep the restore draft active while advancing the injected retention clock past 30 days and assert its source batch snapshot is retained. Abandon the restore draft, rerun the sweep and assert only that exact eligible batch directory is retired; the vault bytes and neighboring recovery batches remain unchanged. A recovery-completed batch remains until the user approves cleanup.

- [ ] **Step 5: Run Phase 5 verification**

Run:

```bash
npm run test:unit -- knowledge-edit-policy knowledge-edit-renderer knowledge-edit-planner
npm run test:integration -- editor-draft-repository knowledge-editor-service knowledge-edit-coordinator knowledge-edit-recovery editor-api
npm run test:integration -- recovery-retention-service
npm run test:component -- knowledge-editor knowledge-editor-conflict
npm run test:e2e -- test-vault-knowledge-editor test-vault-editor-conflict-recovery
npm run build
```

Expected: all commands exit 0; all mutations target current-test sentinel roots; no permanent delete route or formal-vault mutation appears.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/test-vault-knowledge-editor.spec.ts tests/e2e/test-vault-knowledge-editor.spec.ts-snapshots/knowledge-editor-diff-1440x900-chromium-darwin.png tests/e2e/test-vault-editor-conflict-recovery.spec.ts
git commit -m "test: prove safe direct knowledge editing"
```

## Phase 5 Exit Criteria

- Any valid existing knowledge opens in a controlled YAML + Markdown editor without requiring Obsidian.
- Drafts autosave outside the vault and resume after restart; formal files change only after full diff confirmation.
- External file changes produce a conflict and never a force overwrite.
- `AI总结`, `已优化`, `定论` and `过时` follow explicit, server-enforced policies.
- A committed edit, interrupted edit and reverse restoration all use the same Phase 1 WriteCoordinator and recovery manifest.
- “恢复为写入前版本” is a new checked transaction, not destructive history rewriting.
- Clean committed before snapshots remain available for 30 days; active restore/recovery/export references hold them, and recovered incidents require explicit cleanup approval.
- No product API or UI permanently deletes knowledge or original materials.
