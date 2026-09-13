# Phase 4 Formal Knowledge Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把用户选中的已接受候选作为一个可恢复批次正式新建或合并到 `02知识库`，允许剩余候选继续审阅，并在完整校验后准确推进来源的 `未提炼 / 部分入库 / 已入库` 状态。

**Architecture:** `FormalIngestionPlanner` 只读取当前 source、所选 candidate version 和目标知识，生成 Phase 1 `WritePlan` 的 extraction intent；它不要求整个 run 没有 pending。Phase 1 的同一个 `WriteCoordinator` 负责路径锁、外部 manifest、原子 create/swap、复读、冲突和恢复；`IngestionFinalizer` 在全部 disk/schema/link 验证后、core batch committed 前幂等推进所选候选、来源 current raw hash 和受影响索引。

**Tech Stack:** TypeScript, Fastify, Zod, better-sqlite3, `diff`, Phase 1 atomic write/recovery kernel, React, Vitest, Playwright

---

## File Structure

**Create:**

- `src/server/db/migrations/006_formal_ingestion.sql` — 写入计划与所选候选版本/处置的不可变关联。
- `src/shared/domain/ingestion.ts` — 新建/合并 disposition、候选选择、预览和 verified finalization 类型。
- `src/server/db/repositories/ingestion-repository.ts` — 计划候选关联、freeze/unfreeze/commit 投影。
- `src/server/rules/knowledge-template.ts` — 服务端控制的新知识 YAML 与正文模板。
- `src/server/rules/knowledge-frontmatter-patch.ts` — 合并时更新允许字段并保留其他 YAML bytes。
- `src/server/rules/knowledge-merge-renderer.ts` — `AI总结` 与显式 `AI待认` 合并内容。
- `src/server/rules/wikilink-set.ts` — old-first、去重、稳定双链集合。
- `src/server/workflow/formal-ingestion-planner.ts` — 候选子集 preflight、bytes、diff，并调用 Phase 1 `createWritePlan` 生成 canonical plan hash。
- `src/server/workflow/ingestion-finalizer.ts` — disk 验证后、core commit 前幂等完成候选/run/source baseline 与受影响索引。
- `src/server/workflow/ingestion-verifier.ts` — schema、hash、来源/知识双链和状态复读。
- `src/shared/domain/recovery.ts` — recovery-only 版本描述、逐路径 opaque 人工选择和最小运行态 API 类型；不公开 export lease/descriptor。
- `src/server/recovery/recovery-only-runtime.ts` — SQLite 不可用时只装配 scanner、manifest state kernel 和 recovery 路由。
- `src/server/recovery/manual-resolution-service.ts` — unknown-hash 的逐路径 keep-current / known-version 混合 resolve plan。
- `src/server/recovery/recovery-export-service.ts` — 复验并流式输出 recovery bundle，lease/descriptor 只留在 main/server 进程内，字节不经过普通 HTTP/renderer。
- `src/server/api/routes/write-plans.ts`
- `src/server/api/routes/write-batches.ts`
- `src/server/api/routes/recovery.ts`
- `src/client/pages/WriteConfirmationPage.tsx`
- `src/client/pages/RecoveryDetailPage.tsx`
- `src/client/components/write/DispositionControl.tsx`
- `src/client/components/write/FileDiffViewer.tsx`
- `src/client/components/write/WriteGate.tsx`
- `src/client/components/write/BatchTimeline.tsx`
- `src/client/components/write/RecoveryActions.tsx`
- `src/client/styles/write-workflow.css`
- `tests/integration/ingestion-repository.test.ts`
- `tests/unit/knowledge-template.test.ts`
- `tests/unit/knowledge-frontmatter-patch.test.ts`
- `tests/unit/knowledge-merge-renderer.test.ts`
- `tests/unit/formal-ingestion-planner.test.ts`
- `tests/integration/formal-ingestion-service.test.ts`
- `tests/integration/formal-ingestion-coordinator.test.ts`
- `tests/integration/formal-ingestion-crash.test.ts`
- `tests/integration/formal-ingestion-recovery.test.ts`
- `tests/integration/formal-ingestion-api.test.ts`
- `tests/integration/recovery-only-runtime.test.ts`
- `tests/integration/manual-recovery-resolution.test.ts`
- `tests/integration/recovery-export-service.test.ts`
- `tests/component/write-confirmation.test.tsx`
- `tests/component/recovery-ui.test.tsx`
- `tests/e2e/test-vault-partial-ingestion.spec.ts`
- `tests/e2e/test-vault-ingestion-conflict.spec.ts`
- `tests/e2e/test-vault-ingestion-recovery.spec.ts`

**Modify:**

- `src/server/db/migrate.ts` — 注册 migration 006。
- `scripts/copy-server-assets.ts` — 打包 migration 006。
- `src/shared/domain/write.ts` — 只增加 extraction batch intent 和 ingestion roles；不重新定义 WritePlan。
- `src/shared/domain/workflow.ts` — 给既有 `ExtractionRun` 增加受控的 manual-recovery issue code，不新增状态。
- `src/server/workflow/write-repository.ts` — 查询 batch/plan 供 verified finalization 使用。
- `src/server/workflow/write-coordinator.ts` — 透传可选的一次性 native grant 字段；Phase 4 不解释、不保存该字段。
- `src/server/workflow/write-intent-registry.ts` — 注册 ingestion verifier/finalizer；不创建另一套 coordinator 或 kind 分支。
- `src/server/workflow/recovery-service.ts` — continue/rollback/resolve 调用原 ingestion finalizer 并完成对应显式投影。
- `src/server/recovery/recovery-manifest.ts` — 复用 Phase 1 不可变 manifest：只通过完整 plan 绑定 `resolutionSha256` 并记录 intent-specific `domainProjectionCapsule`；完整 resolve selection 写入 pre-mutation hash-chain journal，export lease 不进入 manifest/共享/API 类型。
- `src/server/recovery/recovery-journal.ts` — 使用 Phase 1 已定义的完整 batch-level `projection-pending` payload，并实现 recovery-only 追加/重放；不改 step record 格式。
- `src/server/app.ts` — 注册 plan/batch/recovery 路由。
- `src/server/start-server.ts` — 构造 planner、finalizer 和 verifier。
- `src/electron/main.ts` — SQLite 打不开时仍启动最小 loopback recovery runtime；不启动普通服务。
- `src/shared/api/schemas.ts` — 写入计划、批次与恢复 schema。
- `src/shared/desktop/bridge.ts` — 先声明可选的单用途 recovery bundle export 方法；Phase 6 绑定 native save IPC。
- `src/client/api/client.ts` — 写入与恢复 API。
- `src/client/app/router.tsx` — 真实写入确认与恢复路由。
- `src/client/pages/ExtractionWorkbenchPage.tsx` — 从已接受候选中选择本批次。
- `src/client/pages/QueuePage.tsx` — 部分入库继续处理。
- `src/client/pages/OperationsPage.tsx` — batch timeline 和恢复入口。

## Cross-Phase Contracts and Non-Negotiable Safety

- Migration 003 已创建 Phase 1 write kernel；本阶段不得重新定义 `WritePlan`、`WriteCoordinator`、recovery manifest、path lock 或 atomic helper。
- `WritePlan.ruleBundleSha256` 使用 Phase 0 的全局五文件 bundle（`00_ / 01_ / 02_图书馆入馆规则 / 03_ / 05_`）；计划与执行前都重读比对。
- `FormalIngestionPlanner`、batch execution 和 recovery mutation 都依赖 Phase 0 注入的 `RuleCompatibilityGate` port/record；默认 deny，测试 fixture 可批准测试指纹，Phase 6 才实现 Electron production 审批，本阶段不另建实现。当前指纹未被明确批准时返回 `RULE_BUNDLE_UNAPPROVED`；重启或重新生成 diff 不得自动批准规则，读取、已有候选审阅和 recovery 只读诊断仍可用。
- 所有写测试必须先通过现有测试 vault guard，且 mutation root 必须是本测试用 `mkdtemp` 创建并带精确哨兵的目录。
- 本阶段自动化不得写 `~/我的大脑`；正式 vault 的首笔写入只属于最终人工监督验收。
- SQLite 可保存 plan JSON，但恢复所需的 before/after bytes 必须在第一次 mutation 前进入 Phase 1 自包含外部 manifest。
- SQLite 也不能是 intent finalizer 所需业务投影的唯一副本。任何可能进入 recovery 的 intake/extraction manifest 都必须在第一次 mutation 前携带 strict、版本化、哈希绑定且不含秘密的 `domainProjectionCapsule`；SQLite 删除后必须能仅凭 manifest/journal/vault 重建原 intent 的必要 rows、binding、finalization 与索引投影。
- 知识操作在前，来源操作唯一且永远最后；UI 只有 batch `committed` 才能显示成功。
- 复用 Phase 1 最终契约：recovery plan 自身 step ordinal 永远重新编号为 `0..n-1`，每步用 `recoveryOfOrdinal` 绑定 original step；continue 按 original ordinal 升序 suffix，rollback 按 original ordinal 严格降序。普通 `create` 的 rollback 使用 recovery-only `retire-created-file`，按 recorded dev/ino/hash 排他移入 appData retained/quarantine 并 fsync，使 vault 路径 absent；禁止 unlink。
- unknown hash 使用 Phase 1 `KernelRecoveryWriteIntent.direction: 'resolve'` 和 core state `manually-resolved`。原 batch 绝不伪装成 `committed` 或 `rolled-back`；file resolve 只能选择 scanner 已复验的 current/before/after/retained bytes，目录漂移只能用 fresh full-tree snapshot 明确 `keep_current_topology`，不能选择未保存的旧目录树；零 step 保留 current 仍需完整 resolution 记录。完成后解除该 batch 的 recovery lock。本阶段绝不清理事故证据，并把保留状态交给 Phase 5 retention policy；未解决或 `manual-only` 永不自动清理。Extraction run 放回已有 `reviewing` state，同时记录独立 `issueCode: 'MANUAL_RECOVERY_CONFLICT'`。

### Task 1: Implement immutable candidate-subset plan bindings

**Files:**

- Create: `src/server/db/migrations/006_formal_ingestion.sql`
- Create: `src/shared/domain/ingestion.ts`
- Create: `src/server/db/repositories/ingestion-repository.ts`
- Modify: `src/server/db/migrate.ts`
- Modify: `src/shared/domain/workflow.ts`
- Modify: `scripts/copy-server-assets.ts`
- Test: `tests/integration/ingestion-repository.test.ts`

- [ ] **Step 1: Add failing subset and freeze tests**

Create one run with three candidates: accepted A/B and pending C. Bind only A to a plan:

```ts
const binding = repository.persistAndBindPlan({
  plan: makeSchemaValidWritePlan({ id: 'plan-1' }),
  runId,
  sourceRawSha256: source.rawSha256,
  candidates: [{
    candidateId: candidateA.id,
    candidateVersion: candidateA.version,
    draftSha256: candidateA.draftSha256,
    disposition: { kind: 'create', targetPath: '02知识库/方法/article-a.md' }
  }]
});
expect(binding.candidates).toHaveLength(1);
expect(extractionRepository.getCandidate(candidateA.id)?.writeState).toBe('planned');
expect(() => extractionRepository.updateCandidate(candidateA.id, candidateA.version, edit))
  .toThrowError('CANDIDATE_FROZEN');
expect(() => extractionRepository.updateCandidate(candidateB.id, candidateB.version, edit))
  .not.toThrow();
expect(() => extractionRepository.updateCandidate(candidateC.id, candidateC.version, edit))
  .not.toThrow();
```

Assert the supplied plan is a complete schema-valid Phase 1 `WritePlan`. In one `BEGIN IMMEDIATE` transaction, an identical idempotent replay returns the same persisted plan/binding, a selected candidate must be accepted/unwritten, duplicate candidate IDs fail, and committed candidates cannot be rebound. Also cover an empty source-only binding, explicit cancellation and atomic supersession: only a binding with no batch at `prepared` or later may be cancelled/superseded, the exact expected plan hash and binding version are required, the old plan becomes permanently non-executable, and only its bound candidates return to `unwritten`. A superseding plan may reselect a candidate currently `planned` only when that exact candidate/version/hash is bound to the exact old plan being superseded; another plan's frozen candidate remains ineligible. A recovery-required batch remains frozen.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npm run test:integration -- ingestion-repository
```

Expected: migration 006 and repository are absent.

- [ ] **Step 3: Add ingestion domain types**

Create `src/shared/domain/ingestion.ts`:

```ts
export type CreateKnowledgeDisposition = {
  kind: 'create';
  targetPath: string;
};

export type MergeKnowledgeDisposition = {
  kind: 'merge';
  targetPath: string;
  protectedMode: 'none' | 'mark_ai_pending';
};

export type CandidateDisposition = CreateKnowledgeDisposition | MergeKnowledgeDisposition;

export type CandidateSelection = {
  candidateId: string;
  expectedDraftVersion: number;
  expectedDraftSha256: string;
  disposition: CandidateDisposition;
};

export type FormalIngestionRequest = {
  runId: string;
  expectedRunVersion: number;
  expectedSourceRawSha256: string;
  selected: CandidateSelection[];
  closeRun: boolean;
};

export type ExtractionProjectionCapsulePayload = {
  readonly capsuleSchemaVersion: 1;
  readonly runBefore: {
    readonly id: string;
    readonly materialPath: string;
    readonly sourceContentSha256: string;
    readonly currentSourceRawSha256: string;
    readonly readingState: ReadingState;
    readonly state: 'reviewing';
    readonly candidateSetHash: string;
    readonly ruleFingerprint: string;
    readonly recoveryMode: 'none' | 'historical_partial';
    readonly version: number;
    readonly issueCode: null;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly candidatesBefore: readonly {
    readonly draft: CandidateDraft;
    readonly updatedAt: string;
  }[];
  readonly briefingBefore: {
    readonly briefing: MaterialBriefing;
    readonly acknowledgedAt: string | null;
  } | null;
  readonly binding: {
    readonly planId: string;
    readonly runId: string;
    readonly sourceRawSha256: string;
    readonly version: number;
    readonly selected: readonly {
      readonly candidateId: string;
      readonly candidateVersion: number;
      readonly draftSha256: string;
      readonly disposition: CandidateDisposition;
    }[];
  };
  readonly reducers: {
    readonly forward: {
      readonly runState: 'reviewing' | 'completed';
      readonly sourceRawSha256: string;
      readonly knowledgeStatus: '部分入库' | '已入库';
      readonly generatedKnowledge: readonly string[];
      readonly selectedWriteState: 'committed';
    };
    readonly rollback: {
      readonly runState: 'reviewing';
      readonly sourceRawSha256: string;
      readonly knowledgeStatus: '未提炼' | '部分入库';
      readonly generatedKnowledge: readonly string[];
      readonly selectedWriteState: 'unwritten';
    };
    readonly resolve: {
      readonly runState: 'reviewing';
      readonly issueCode: 'MANUAL_RECOVERY_CONFLICT';
      readonly selectedWriteState: 'unwritten';
    };
  };
  readonly affectedIndexPaths: readonly string[];
};
```

- [ ] **Step 4: Add migration 006 and register it**

Create `006_formal_ingestion.sql`:

```sql
ALTER TABLE extraction_runs ADD COLUMN issue_code TEXT
CHECK (issue_code IS NULL OR issue_code = 'MANUAL_RECOVERY_CONFLICT');

CREATE TABLE ingestion_plan_bindings (
  plan_id TEXT PRIMARY KEY REFERENCES write_plans(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES extraction_runs(id),
  source_raw_sha256 TEXT NOT NULL CHECK (length(source_raw_sha256) = 64),
  state TEXT NOT NULL CHECK (state IN ('active', 'cancelled', 'superseded')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  cancellation_reason TEXT CHECK (
    cancellation_reason IS NULL OR cancellation_reason IN (
      'user_cancelled', 'superseded', 'rule_stale', 'source_stale', 'projection_stale'
    )
  ),
  superseded_by_plan_id TEXT REFERENCES write_plans(id),
  cancelled_at TEXT
);

CREATE TABLE extraction_plan_candidates (
  plan_id TEXT NOT NULL REFERENCES ingestion_plan_bindings(plan_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  candidate_id TEXT NOT NULL REFERENCES candidate_drafts(id),
  candidate_version INTEGER NOT NULL CHECK (candidate_version >= 1),
  draft_sha256 TEXT NOT NULL CHECK (length(draft_sha256) = 64),
  disposition_json TEXT NOT NULL,
  PRIMARY KEY (plan_id, position),
  UNIQUE (plan_id, candidate_id)
);

CREATE INDEX extraction_plan_candidates_by_candidate
ON extraction_plan_candidates(candidate_id, plan_id);

CREATE TABLE ingestion_finalizations (
  batch_id TEXT PRIMARY KEY REFERENCES write_batches(id),
  original_batch_id TEXT NOT NULL REFERENCES write_batches(id),
  run_id TEXT NOT NULL REFERENCES extraction_runs(id),
  direction TEXT NOT NULL CHECK (direction IN ('forward', 'continue', 'rollback', 'resolve')),
  plan_sha256 TEXT NOT NULL CHECK (length(plan_sha256) = 64),
  projection_capsule_sha256 TEXT NOT NULL CHECK (length(projection_capsule_sha256) = 64),
  source_before_sha256 TEXT NOT NULL CHECK (length(source_before_sha256) = 64),
  source_after_sha256 TEXT NOT NULL CHECK (length(source_after_sha256) = 64),
  finalized_at TEXT NOT NULL
);
```

Register version 6 after migrations 1–5 and add the SQL file to the server asset copy list. Extend the existing domain `ExtractionRun` type with optional `issueCode: 'MANUAL_RECOVERY_CONFLICT'`; normal generation/commit/rollback clears it, resolve sets it while retaining `state: 'reviewing'`. The matching public API schema change is deliberately deferred to Task 5, which already owns `src/shared/api/schemas.ts` and its route/client regression tests.

- [ ] **Step 5: Implement repository transactions**

Expose:

```ts
export interface IngestionRepository {
  persistAndBindPlan(input: PersistAndBindExtractionPlan): BoundExtractionPlan;
  cancelUnpreparedPlan(input: CancelExtractionPlan): BoundExtractionPlan;
  supersedeUnpreparedPlan(input: SupersedeExtractionPlan): BoundExtractionPlan;
  selectedCandidates(planId: string): BoundCandidate[];
  finalizeVerifiedBatch(input: VerifiedFinalizationInput): void;
  hasFinalization(batchId: string): boolean;
}
```

`persistAndBindPlan` receives the complete immutable `WritePlan`, validates all candidate versions/decisions/write states, and in one `BEGIN IMMEDIATE` transaction inserts the Phase 1 `write_plans` row, inserts the binding header (including a zero-candidate/source-only plan), inserts selected rows, and marks only those rows `planned`. There is no observable persisted plan without its extraction binding and no binding to a missing plan. Exact replay is idempotent only when plan JSON/hash, source binding and selected candidate rows are byte-for-byte equal.

`cancelUnpreparedPlan` requires exact `planId + expectedPlanSha256 + expectedBindingVersion + reason`. The service holds the same coordinator mutation mutex while checking that the binding is active, no linked batch has reached `prepared`, `executing`, `recovery-required`, or a terminal state, and the recovery scanner proves there is no manifest, journal, promoted batch directory or helper/staging effect for that plan. In the same critical section and one immediate transaction it marks the binding cancelled, increments its version, and releases exactly its still-`planned` candidates. It never deletes the plan, and the coordinator must reject cancelled/superseded plan IDs before manifest/helper effects. Exact replay returns the same cancelled binding; a mismatched replay is a conflict. `supersedeUnpreparedPlan` performs that cancellation plus persistence/binding of the complete replacement plan in one immediate transaction and records `superseded_by_plan_id`. Its final revalidation treats a `planned` candidate as eligible only when the old binding contains that exact ID/version/hash; it releases all old rows and binds the replacement selection without an intermediate observable `unwritten` state. It cannot create a replacement if the old plan is no longer cancellable.

`finalizeVerifiedBatch` is idempotent by `batch_id + original plan hash + projection capsule hash`: insert finalization, apply the direction-specific candidate/run state, append audit events, refresh affected source/knowledge index rows, and verify their raw hashes/recall projections equal reread disk bytes. A replay with either hash changed is corruption, not a second finalization. Forward/continue advances the run current hash and commits bound candidates; rollback restores them to unwritten and preserves the source before hash; resolve writes a `direction='resolve'` row, commits no candidate, returns the run to `reviewing` with `MANUAL_RECOVERY_CONFLICT`, and refreshes only parseable current paths. Repository tests cover all four values and replay the same resolve without a second event. The relevant core batch/recovery outcome must remain non-visible until this finishes.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
npm run test:integration -- ingestion-repository extraction-repository
npm run typecheck
```

Expected: candidate subset, freeze, cancel/supersede release, idempotent commit, reducer-neutral edit and reducer-stale rejection tests pass.

Commit:

```bash
git add src/server/db/migrations/006_formal_ingestion.sql src/server/db/migrate.ts src/server/db/repositories/ingestion-repository.ts src/shared/domain/ingestion.ts src/shared/domain/workflow.ts scripts/copy-server-assets.ts tests/integration/ingestion-repository.test.ts
git commit -m "feat: bind candidate subsets to write plans"
```

### Task 2: Implement deterministic knowledge and exact source updates

**Files:**

- Create: `src/server/rules/knowledge-template.ts`
- Create: `src/server/rules/knowledge-frontmatter-patch.ts`
- Create: `src/server/rules/knowledge-merge-renderer.ts`
- Create: `src/server/rules/wikilink-set.ts`
- Test: `tests/unit/knowledge-template.test.ts`
- Test: `tests/unit/knowledge-frontmatter-patch.test.ts`
- Test: `tests/unit/knowledge-merge-renderer.test.ts`
- Modify: `tests/fixtures/intake/frontmatter-golden/unknown-fields-comments-crlf.md`
- Modify: `tests/fixtures/intake/frontmatter-golden/bom-no-final-newline.md`
- Modify: `tests/fixtures/intake/frontmatter-golden/missing-required-keys.md`
- Modify: `tests/fixtures/intake/frontmatter-golden/no-frontmatter.md`

- [ ] **Step 1: Add failing new-knowledge template tests**

Assert exact field order and service-controlled values:

```yaml
类型: 知识笔记
来源类型: AI提炼
使用状态: AI总结
知识类型: 方法
所属主题: []
关键词: []
来源资料: []
适用场景: []
核心结论: ""
关键要点: []
使用边界: ""
创建日期: 2026-09-01
更新日期: 2026-09-01
备注: ""
```

Assert exact body headings:

```markdown
## 知识正文

## 可复用表达

### 原文引用

### 个人总结
```

The candidate supplies content beneath headings; the service supplies YAML delimiters, status, source type, source link and dates. Reject hidden/disallowed path segments, frontmatter delimiters in body, raw HTML, absent evidence and an existing create target.

- [ ] **Step 2: Add failing source and merge golden tests**

For source updates, reuse the Phase 2 byte patcher and assert only `生成知识` plus `知识入库状态` ranges change; BOM, CRLF, comments, unknown fields, key order and body remain exact. Existing generated links remain old-first and deduplicated.

For merge targets assert:

- `AI总结` accepts a normal merge proposal.
- `已优化` 的来源、例子或证据补充允许 `protectedMode: none`，保持 `已优化`；新增观点、步骤、边界、反例或修正要求 `protectedMode: mark_ai_pending`。
- `定论` 允许只补来源/出处且不改变原意的合并；其他内容返回 `PROTECTED_KNOWLEDGE` 并要求另建或进入显式解锁编辑流程。
- `过时` 一律返回 `PROTECTED_KNOWLEDGE`，不累积活跃内容。
- `mark_ai_pending` 对完整小节只在标题末尾追加一次 `==AI待认==`；零散段落或列表项在内容开头追加 `==AI待认==`；备注 old-first 追加 `AI待认: 2026-09-01`。
- creation date stays unchanged; update date advances.
- existing source links remain old-first; the new source is appended once.
- unrecognized body structure blocks rather than rewriting the file.

Use exact byte assertions rather than normalized strings:

```ts
const patched = patchSourceFrontmatter(before, {
  generatedKnowledge: ['[[旧知识]]', '[[新知识]]'],
  knowledgeStatus: '部分入库'
});
expect(patched.changedKeys).toEqual(['知识入库状态', '生成知识']);
expect(patched.bytes).toEqual(expectedGoldenBytes);
expect(renderKnowledgeMerge(mergeInput).afterBytes).toEqual(expectedMergeBytes);
```

- [ ] **Step 3: Run and verify RED**

Run:

```bash
npm run test:unit -- knowledge-template knowledge-frontmatter-patch knowledge-merge-renderer
```

Expected: rendering and golden preservation assertions fail.

- [ ] **Step 4: Implement the new-note renderer**

Export:

```ts
export function renderNewKnowledge(input: {
  candidate: CandidateDraft;
  sourcePath: string;
  targetPath: string;
  date: string;
  evidenceQuotes: readonly string[];
}): Uint8Array;
```

Use the current `KNOWLEDGE_TYPES`, normalized wikilinks and `yaml` only for a newly created document. Insert `bodyMarkdown` under `知识正文`, `value` under `可复用表达`, evidence quotes under `原文引用`, and `sourceContribution` under `个人总结`. Parse the result through `parseKnowledgeNote` before returning.

- [ ] **Step 5: Implement knowledge merge and exact YAML patches**

`knowledge-frontmatter-patch.ts` uses YAML CST byte ranges to update only approved knowledge keys while preserving all other bytes. `knowledge-merge-renderer.ts` locates the four required body sections, classifies the proposed change as `evidence_only` or `semantic_change`, applies the status rules above, inserts the exact `==AI待认==` marker and dated note only when required, appends the source contribution, and returns full before/after bytes. It never silently falls back to whole-document regeneration.

Export these narrow entry points:

```ts
export function patchKnowledgeFrontmatter(
  source: Uint8Array,
  patch: KnowledgeFrontmatterPatch
): PatchedKnowledge;

export function renderKnowledgeMerge(
  input: KnowledgeMergeInput
): { classification: 'evidence_only' | 'semantic_change'; afterBytes: Uint8Array };
```

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
npm run test:unit -- knowledge-template knowledge-frontmatter-patch knowledge-merge-renderer source-frontmatter-patch
npm run typecheck
```

Expected: deterministic template, state protection and all golden-byte cases pass.

Commit:

```bash
git add src/server/rules/knowledge-template.ts src/server/rules/knowledge-frontmatter-patch.ts src/server/rules/knowledge-merge-renderer.ts src/server/rules/wikilink-set.ts tests/unit/knowledge-template.test.ts tests/unit/knowledge-frontmatter-patch.test.ts tests/unit/knowledge-merge-renderer.test.ts tests/fixtures/intake/frontmatter-golden/unknown-fields-comments-crlf.md tests/fixtures/intake/frontmatter-golden/bom-no-final-newline.md tests/fixtures/intake/frontmatter-golden/missing-required-keys.md tests/fixtures/intake/frontmatter-golden/no-frontmatter.md
git commit -m "feat: render safe knowledge ingestion bytes"
```

### Task 3: Implement immutable candidate-subset write plans

**Files:**

- Create: `src/server/workflow/formal-ingestion-planner.ts`
- Modify: `src/shared/domain/write.ts`
- Test: `tests/unit/formal-ingestion-planner.test.ts`
- Test: `tests/integration/formal-ingestion-service.test.ts`

- [ ] **Step 1: Add failing planner tests**

Cover exact cases:

1. Selected candidates must be `accepted + unwritten` with matching version/hash.
2. Pending and unselected accepted candidates do not block a subset plan.
3. Every selected candidate has explicit create/merge disposition.
4. Duplicate target paths and target collisions block planning.
5. Knowledge operations precede one source operation; source is last.
6. One committed selection plus remaining candidates predicts `部分入库`.
7. Every candidate committed or abandoned predicts `已入库`.
8. All abandoned with `closeRun: true` creates a source-only plan.
9. A valid zero-candidate run with `selected: []` and `closeRun: true` creates the same source-only plan and predicts `已入库` after explicit user confirmation.
10. `selected: []` is rejected when `closeRun` is false or any pending/accepted unwritten candidate exists.
11. Same inputs/date/rule fingerprint produce the same plan hash.
12. Selected draft, source raw, target raw, path, disposition or rule fingerprint change invalidates the plan. An unselected draft-body edit that leaves the candidate decision/write state and projected source reducer unchanged does not; an unselected decision/write-state transition that changes the projected source status/link set does invalidate it.
13. Between preview and commit, abandon the last unselected unwritten candidate so the authoritative reducer changes from `部分入库` to `已入库`: `verifyPlan` returns stable `WRITE_PLAN_STALE` before manifest, staging, helper or vault effects, cancels the still-unprepared binding and releases its selected candidates.
14. Change a rule while the App is closed and restart: plan creation returns `RULE_BUNDLE_UNAPPROVED` across repeated restarts, creates no plan binding and writes no bytes until a separate compatibility approval is recorded.

Example assertion:

```ts
const { plan, preview } = await planner.create(request);
expect(plan.steps.map((step) => step.role)).toEqual([
  'knowledge',
  'source-status'
]);
expect(plan.intent).toMatchObject({
  kind: 'extraction_batch',
  selectedCandidates: [{ candidateId: accepted.id, candidateVersion: 4 }]
});
expect(preview.sourceAfter.knowledgeStatus).toBe('部分入库');
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npm run test:unit -- formal-ingestion-planner
npm run test:integration -- formal-ingestion-service
```

Expected: subset plan types and planner are absent.

- [ ] **Step 3: Add to, not replace, the Phase 1 write domain**

Add this union member to `src/shared/domain/write.ts`:

```ts
export type ExtractionBatchWriteIntent = {
  readonly kind: 'extraction_batch';
  readonly runId: string;
  readonly sourcePath: string;
  readonly sourceContentSha256: string;
  readonly expectedSourceRawSha256: string;
  readonly selectedCandidates: readonly {
    readonly candidateId: string;
    readonly candidateVersion: number;
    readonly draftSha256: string;
    readonly disposition: CandidateDisposition;
  }[];
  readonly closeRun: boolean;
};

export type WriteIntent =
  | KernelTestWriteIntent
  | KernelRecoveryWriteIntent
  | IntakeWriteIntent
  | ExtractionBatchWriteIntent;
```

Add `ExtractionBatchWriteIntent` to the existing `WriteIntent` union and store it in `WritePlan.intent`. Reuse the existing `knowledge` and `source-status` step roles and the existing `WritePlan`, `WriteStep`, `WriteBatch` and recovery types; do not rename their `steps` or `kind` fields.

- [ ] **Step 4: Implement planner preflight and preview**

Keep workflow preview outside the Phase 1 core type:

```ts
export type PlannedFormalIngestion = {
  readonly plan: WritePlan;
  readonly preview: WritePlanPreview;
};

create(input: FormalIngestionRequest): Promise<PlannedFormalIngestion>;
```

Import and call the existing Phase 1 `createWritePlan` from `src/server/workflow/write-planner.ts`; do not create a second hash module, copy canonicalization code or attach preview fields to `WritePlan`.

The planner performs in order:

```text
load current rule bundle and require RuleCompatibilityGate approval
load run and selected candidates
validate request snapshot version for user intent
reread and parse source
verify source content identity and current raw hash
reread every merge/create target
render all after bytes in memory
reparse every after document
build complete line diffs
build one source patch from old-first generated link union
place source operation last
canonical-hash intent, before versions, after hashes, rule fingerprint and date
in one BEGIN IMMEDIATE transaction persist the complete plan, binding header and selected candidate rows; optionally supersede one exact still-unprepared predecessor
```

For the explicitly confirmed zero-candidate/all-abandoned close case, render exactly one `source-status` replace step, no knowledge step, no fabricated `生成知识` link, and set `知识入库状态: 已入库`. Do not include global run version in execution validity after the plan exists; it is only request concurrency. Execution validity uses source raw hash, each selected candidate version/hash, and a fresh reducer projection across **all** authoritative candidates. A body edit to an unselected candidate is irrelevant only when its decision/write state and the resulting source status/link set are unchanged.

The ordinary planner accepts only `accepted + unwritten`. The supersede service supplies a server-internal old-plan context after validating its exact hash/version under the coordinator mutex; preflight may treat only candidates identically bound to that predecessor as logically unwritten. It never places a supersede ID in public `FormalIngestionRequest` or trusts a client candidate state. The repository repeats every old/new binding check inside the final immediate transaction so no preview-time exception can steal another plan's frozen candidate.

Before any batch/manifest/staging/helper/vault side effect, `verifyPlan` reloads the source and all candidates, overlays only the exact bound selection as committed, recomputes the authoritative source status and generated-link union, and requires the planned source after-bytes to encode that exact reducer result. A mismatch returns `WRITE_PLAN_STALE`; while the binding is still unprepared it is cancelled with `projection_stale` and its bound candidates are released. The verifier also rechecks both approved/current rule equality and equality with `plan.ruleBundleSha256`; unapproved and stale are distinct fail-closed errors.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
npm run test:unit -- formal-ingestion-planner
npm run test:integration -- formal-ingestion-service ingestion-repository
npm run typecheck
```

Expected: all subset, status, ordering, deterministic hash, reducer-neutral edit and reducer-changing stale cases pass.

Commit:

```bash
git add src/server/workflow/formal-ingestion-planner.ts src/shared/domain/write.ts tests/unit/formal-ingestion-planner.test.ts tests/integration/formal-ingestion-service.test.ts
git commit -m "feat: plan candidate subset ingestion"
```

### Task 4: Add ingestion verification and verified finalization

**Files:**

- Create: `src/server/workflow/ingestion-verifier.ts`
- Create: `src/server/workflow/ingestion-finalizer.ts`
- Modify: `src/server/workflow/write-intent-registry.ts`
- Modify: `src/server/workflow/recovery-service.ts`
- Modify: `src/server/workflow/write-coordinator.ts`
- Modify: `src/server/workflow/write-repository.ts`
- Test: `tests/integration/formal-ingestion-coordinator.test.ts`
- Test: `tests/integration/formal-ingestion-crash.test.ts`
- Test: `tests/integration/formal-ingestion-recovery.test.ts`

- [ ] **Step 1: Add failing normal execution tests**

Use a sentinel-protected temporary vault and assert exact trace:

```text
claim sorted paths
revalidate all selected candidate versions and file before versions
reload every candidate and verify the planned source reducer projection
persist self-contained manifest
create/swap each knowledge target with immediate reread
swap source last with immediate reread
verify knowledge schema and source backlinks
verify source generated links and status
idempotently finalize selected candidates, source raw hash and affected index rows
verify finalized index hashes/recall fields equal disk after-bytes
mark shared batch committed
archive recovery snapshot and release paths
```

Double submit returns the same batch; a lost HTTP response replay returns committed; UI/API success is impossible before both `finalizeVerified` and authoritative coordinator state `committed`.

- [ ] **Step 2: Add failing crash and conflict tests**

For every Phase 1 fault point, every operation index and the window after domain/index finalization but before core commit, terminate and restart. Assert current bytes classify as before/after/conflict, all observed versions are retained, continue or rollback uses the existing recovery service, and finalization is idempotently completed exactly once after full disk/schema/link verification but before core commit. Recovery plans own fresh ordinals `0..n-1` and bind originals through `recoveryOfOrdinal`; reject reused, descending-own-ordinal or mismatched mappings. For every newly created knowledge file, crash after create and roll back with `retire-created-file`; verify exact hash/dev/ino and original batch binding, exclusive move into the batch retained/quarantine area, fsync of both parents, absent vault target, and no unlink. Inject an external source/target change immediately before atomic swap and assert no silent overwrite.

Drive the shared fault matrix explicitly:

```ts
for (const faultPoint of WRITE_CHECKPOINTS) {
  for (const operationIndex of [0, 1, 2]) {
    await assertRestartOutcome({ faultPoint, operationIndex, direction: 'continue' });
    await assertRestartOutcome({ faultPoint, operationIndex, direction: 'rollback' });
  }
}
await assertRestartOutcome({ faultPoint: 'finalize-completed', direction: 'continue' });
```

- [ ] **Step 3: Run and verify RED**

Run:

```bash
npm run test:integration -- formal-ingestion-coordinator formal-ingestion-crash formal-ingestion-recovery
```

Expected: the shared registry lacks ingestion-specific final-state verification and finalization handlers.

- [ ] **Step 4: Implement verifier and finalizer hooks**

Implement the exact two handler contracts established by Phase 1 in `src/server/workflow/write-intent-registry.ts`:

```ts
const verifier: WriteIntentVerifierHandler<'extraction_batch'> = {
  kind: 'extraction_batch',
  buildProjectionCapsule({ intent, plan }) {
    return ingestionVerifier.buildProjectionCapsule({ intent, plan });
  },
  validateProjectionCapsule(capsule) {
    return ingestionVerifier.validateProjectionCapsule(capsule);
  },
  verifyPlan(intent, plan) { return ingestionVerifier.verifyPlan(intent, plan); },
  verifyStep(intent, step) { return ingestionVerifier.verifyStep(intent, step); },
  verifyFinalState(intent, plan) { return ingestionVerifier.verifyFinalState(intent, plan); }
};

const finalizer: WriteIntentFinalizerHandler<'extraction_batch'> = {
  kind: 'extraction_batch',
  finalizeVerified({ intent, plan, batchId, projectionCapsule }) {
    return ingestionFinalizer.finalizeVerified({ intent, plan, batchId, projectionCapsule });
  },
  finalizeRecoveryVerified(input) {
    return ingestionFinalizer.finalizeRecoveryVerified(input);
  }
};
```

Register those two handlers under `extraction_batch` while retaining the intake and kernel handlers. `buildProjectionCapsule` snapshots the complete strict extraction reducer input described in Task 5 before authorization; `validateProjectionCapsule` rejects wrong intent, unknown fields, secrets and payload-hash/binding mismatches. Do not add an ingestion branch to `WriteCoordinator`. `finalizeVerified` and `finalizeRecoveryVerified` receive the validated capsule and include `projectionCapsule.payloadSha256` in their idempotency keys/receipts exactly as Phase 1 requires. `finalizeRecoveryVerified({ originalIntent, originalPlan, originalBatchId, recoveryPlan, recoveryBatchId, direction, projectionCapsule })` dispatches by the original `extraction_batch` intent after recovery disk/journal/final-state verification and before the recovery outcome is visible: `continue` idempotently produces the same committed-candidate/source-hash/after-index finalization; `rollback` resets only originally bound candidates to `unwritten` and refreshes verified before-state index rows; `resolve` never projects a selected candidate as committed, unfreezes the original binding to accepted/unwritten where safe, returns the run to its existing `reviewing` state with `issueCode: 'MANUAL_RECOVERY_CONFLICT'`, refreshes only parseable current paths, and records schema issues for unparseable kept versions. Add repository/API tests for that exact state+issue pair and idempotent resolve replay. A crash may replay any direction by original/recovery batch IDs without duplicate events or index work. Recovery-required leaves candidates frozen until one outcome completes; rollback and resolve never mark the original batch committed, and resolve leaves core state `manually-resolved`.

- [ ] **Step 5: Implement graph and projected status verification**

`IngestionVerifier` reparses every knowledge and source, confirms target hashes, confirms every new knowledge has the source link, and confirms source has all old and new generated links. Its `verifyPlan` hook runs before repository batch creation, manifest persistence, staging or helper use. It reloads every candidate plus the binding, calls `projectCandidateStates({ intent, planBinding, currentCandidates })`, verifies every selected ID/version/hash against the immutable binding, overlays only those selected rows as `committed`, leaves every unselected row at its current `pending / accepted-unwritten / abandoned / committed` state, and derives the exact status and generated-link union. It then requires the planned source after-bytes to encode that projection; mismatch returns `WRITE_PLAN_STALE` and cancels/releases the still-unprepared binding. This prevents a plan previewed as `部分入库` from landing after a concurrent unselected-candidate transition makes `已入库` authoritative.

`verifyFinalState` repeats the same projection after filesystem work and before finalization, rather than reducing source status from stale repository rows while the selected rows are still `planned`. Continue recovery uses the projected after reducer; rollback verifies a before projection with the selected rows restored to their pre-plan `unwritten` state. Add tests proving a one-candidate subset reaches `部分入库` even though its row is still `planned` during `verifyFinalState`, a forged source status cannot self-validate by reading stale candidate rows, and a reducer-changing unselected transition is detected before the first mutation while a reducer-neutral draft edit remains valid.

Keep the reducer a pure, exhaustively typed helper used by both verification phases:

```ts
export function projectCandidateStates(input: {
  intent: ExtractionBatchWriteIntent;
  planBinding: BoundExtractionPlan;
  currentCandidates: readonly CandidateDraft[];
}): {
  knowledgeStatus: '部分入库' | '已入库';
  generatedKnowledge: readonly string[];
};
```

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
npm run test:integration -- formal-ingestion-coordinator formal-ingestion-crash formal-ingestion-recovery
npm run typecheck
```

Expected: normal, idempotent, external race, every crash point, continue and rollback tests pass using one coordinator and one recovery system.

Commit:

```bash
git add src/server/workflow/ingestion-verifier.ts src/server/workflow/ingestion-finalizer.ts src/server/workflow/write-intent-registry.ts src/server/workflow/recovery-service.ts src/server/workflow/write-coordinator.ts src/server/workflow/write-repository.ts tests/integration/formal-ingestion-coordinator.test.ts tests/integration/formal-ingestion-crash.test.ts tests/integration/formal-ingestion-recovery.test.ts
git commit -m "feat: commit and recover formal ingestion batches"
```

### Task 5: Add plan, batch and recovery APIs

**Files:**

- Create: `src/server/api/routes/write-plans.ts`
- Create: `src/server/api/routes/write-batches.ts`
- Create: `src/server/api/routes/recovery.ts`
- Create: `src/shared/domain/recovery.ts`
- Create: `src/server/recovery/recovery-only-runtime.ts`
- Create: `src/server/recovery/manual-resolution-service.ts`
- Create: `src/server/recovery/recovery-export-service.ts`
- Create: `src/server/workflow/mutation-summary-reader.ts`
- Create: `src/server/runtime/started-mutation-runtime.ts`
- Modify: `src/shared/api/schemas.ts`
- Modify: `src/shared/desktop/bridge.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/start-server.ts`
- Modify: `src/electron/main.ts`
- Modify: `src/server/recovery/recovery-manifest.ts`
- Modify: `src/server/recovery/recovery-journal.ts`
- Modify: `src/server/db/repositories/intake-repository.ts`
- Modify: `src/server/workflow/recovery-service.ts`
- Modify: `src/server/workflow/write-coordinator.ts`
- Modify: `src/client/api/client.ts`
- Test: `tests/integration/formal-ingestion-api.test.ts`
- Test: `tests/integration/recovery-only-runtime.test.ts`
- Test: `tests/integration/manual-recovery-resolution.test.ts`
- Test: `tests/integration/recovery-export-service.test.ts`
- Test: `tests/unit/recovery-journal.test.ts`
- Test: `tests/component/api-client.test.tsx`

- [ ] **Step 1: Add failing route tests**

Cover:

```text
POST /api/v1/write-plans
GET  /api/v1/write-plans/:id
POST /api/v1/write-plans/:id/cancel
POST /api/v1/write-plans/:id/supersede
POST /api/v1/write-batches
GET  /api/v1/write-batches/:id
GET  /api/v1/recovery
GET  /api/v1/recovery/:batchId
POST /api/v1/recovery/:batchId/continue
POST /api/v1/recovery/:batchId/rollback
GET  /api/v1/recovery/:batchId/versions
POST /api/v1/recovery/:batchId/resolution-plan
POST /api/v1/recovery/:batchId/resolve
POST /api/v1/recovery/rebuild-state
```

Plan request is a strict `FormalIngestionRequest`. Response includes all target relative paths, before/after hashes, full Markdown/YAML preview, line diffs, source status/link update, write gate, plan hash, binding version and binding state. Cancel requires exact expected plan hash/binding version and an idempotency key and returns the authoritative cancelled plan snapshot. Supersede requires those same old-plan expectations plus one strict replacement `FormalIngestionRequest`; the service builds the replacement and atomically cancels/releases the old still-unprepared binding while persisting the new plan/binding, then returns the new active preview plus the old plan ID. Either route returns 409 after any manifest/journal/helper evidence exists or a linked batch reaches `prepared`; cancelled/superseded plans can never be committed. After loading the immutable plan and before dispatching, consuming idempotency, changing a binding/plan/job or touching recovery state, both generic lifecycle routes reject every `intent.kind === 'intake'` plan with `INTAKE_PLAN_LIFECYCLE_ROUTE_REQUIRED`. Intake cancellation and supersession exist only at Phase 2's job-bound `/api/v1/intake-jobs/:id/confirmed-plan/cancel` and `/supersede` routes, which own the job-version and active-binding CAS; the generic plan routes can never substitute for them.

Task 5 also extends the strict `ExtractionRun` API schema with optional literal `issueCode:'MANUAL_RECOVERY_CONFLICT'` to match Task 1's domain type. Route and client tests cover absent on normal states, present only for resolved `reviewing`, rejection of an open string, and round-trip after rebuild.

Batch create requires expected plan hash/binding version, CSRF and idempotency. After loading the immutable plan and before token handling, coordinator construction, manifest creation or any other effect, `POST /api/v1/write-batches` rejects every `intent.kind === 'intake'` plan—both `automatic` and `user_confirmed`—with `INTAKE_EXECUTION_ROUTE_REQUIRED`. Automatic intake is server-internal through Phase 2's intake service, and user-confirmed intake executes only through Phase 2's strict `/api/v1/intake-jobs/:id/apply-confirmed`; the generic batch route can never substitute for either lifecycle. Continue/rollback/resolve require expected batch version, current scanner snapshot hash, CSRF and a fresh idempotency key. Their strict bodies, and the ordinary human commit body, accept only an optional `nativeGrantToken` matching 64 lowercase hex characters in Phase 4 so sentinel-contract tests can omit it. Phase 4 adds that optional field to the typed ordinary/recovery coordinator command solely as an opaque transport seam; the sentinel policy does not interpret it. Routes, schemas, errors, telemetry, audit events, plan/batch rows, manifests and journals never echo, persist or log it. Delete the former confirmation boolean: it is not mutation authority. Phase 6 must wire the field into `MutationPolicyInput`/one-use grant consumption and make it mandatory in normal-packaged mode for every human commit/continue/rollback/resolve, while automatic intake continues to reject a token.

Assert gate closed, unapproved rules, stale selected candidate, reducer-changing unselected candidate, source conflict, target conflict and recovery lock all return stable 409 codes before mutation. Use real persisted Phase 2 automatic and user-confirmed intake plans against `POST /api/v1/write-batches`; both return `INTAKE_EXECUTION_ROUTE_REQUIRED` before token consumption/coordinator/manifest/helper effects, while `/apply-confirmed` remains the only user-confirmed execution endpoint. Send those same plans with otherwise valid expectations to both generic cancel/supersede routes and require `INTAKE_PLAN_LIFECYCLE_ROUTE_REQUIRED`, an unchanged active binding/job/plan and zero idempotency, coordinator, manifest, journal or helper effects; only the job-bound confirmed-plan routes may perform the CAS. Assert `selected: []` returns 400 unless `closeRun: true` and the authoritative run has zero candidates or every candidate is abandoned; the allowed form returns a source-only preview and still requires the normal batch confirmation. Malformed tokens and legacy confirmation booleans are rejected; a valid injected token reaches only the coordinator input once and is absent from logs/errors/responses/persistence. Operation detail contains paths/hashes/status but no source bytes, before/after bytes, model prompt or key. Recovery version responses contain only batch-relative path, opaque choice IDs, role, hash, byte length, schema result and server-rendered bounded diff; ordinary HTTP never returns a recovery blob, retained file path, absolute path, export descriptor or export bytes, and the removed export-descriptor route returns 404.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npm run test:integration -- formal-ingestion-api
```

Expected: routes return 404.

- [ ] **Step 3: Add strict schemas and service adapters**

Define discriminated `candidateDispositionSchema`, `candidateSelectionSchema`, `formalIngestionRequestSchema`, `cancelWritePlanSchema`, `supersedeWritePlanSchema`, `writePlanPreviewSchema`, `writeBatchSchema`, `recoverySummarySchema`, `recoveryResolutionRequestSchema`, strict mutation-body schemas and response envelopes. The only token field is `nativeGrantToken?: string` with `^[a-f0-9]{64}$`; schemas reject the legacy mutation `confirmation` field, extra fields and tokens on non-mutation routes. The write-batch route resolves `planId` server-side and applies the fixed `intent.kind !== 'intake'` guard before it delegates; no body field may select or override intent kind. The resolution-plan request's `acknowledged: true` records that the user reviewed the choices but is never accepted by execute/continue/rollback/resolve as authority. `formalIngestionRequestSchema.selected` is an array without a schema-level minimum because the planner must inspect authoritative run state; a `superRefine` requires `closeRun === true` when empty, then service validation proves zero/all-abandoned. Routes depend on planner/coordinator/recovery service interfaces only; they never query SQLite or gateway directly. There is no HTTP export descriptor or export lease schema.

Use one strict field schema in each human mutation body:

```ts
const nativeGrantTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
const commitWriteBatchBodySchema = z.object({
  planId: z.string().min(1),
  expectedPlanSha256: sha256Schema,
  expectedBindingVersion: z.number().int().positive(),
  nativeGrantToken: nativeGrantTokenSchema.optional()
}).strict();
```

- [ ] **Step 4: Add renderer-safe, per-path manual-resolution choices**

Create `src/shared/domain/recovery.ts` with renderer-safe metadata only:

```ts
export type RecoveryChoiceDescriptor =
  | {
      affectedEntryId: string;
      choiceId: string;
      role: 'current' | 'before' | 'after' | 'retained';
      relativePath: string;
      entryKind: 'file';
      exists: true;
      rawSha256: string;
      byteLength: number;
      schema: 'valid' | 'invalid' | 'not-markdown';
      boundedDiff: string;
    }
  | {
      affectedEntryId: string;
      choiceId: string;
      role: 'current' | 'before' | 'after';
      relativePath: string;
      entryKind: 'directory';
      exists: true;
      treeSha256: string;
      entryCount: number;
      totalByteLength: number;
      boundedDiff: string;
    }
  | {
      affectedEntryId: string;
      choiceId: string;
      role: 'current' | 'before' | 'after';
      relativePath: string;
      entryKind: 'absent';
      exists: false;
      rawSha256: null;
      byteLength: 0;
      schema: 'not-markdown';
      boundedDiff: string;
      selectableAction: 'select_absent_before_create' | null;
    };

export type RecoveryResolutionChoiceInput =
  | {
      affectedEntryId: string;
      action: 'keep_current' | 'keep_current_topology';
    }
  | {
      affectedEntryId: string;
      action: 'select_version' | 'select_absent_before_create';
      choiceId: string;
    };

export type RecoveryResolutionRequest = {
  snapshotSha256: string;
  selections: readonly RecoveryResolutionChoiceInput[];
  acknowledged: true;
};
```

`RecoveryChoiceDescriptor` and `RecoveryResolutionChoiceInput` are renderer DTOs; do not reuse or widen Phase 1's server recovery observation/selection types. The server derives every 64-lowercase-hex `affectedEntryId` and `choiceId` from the validated batch/snapshot/path/version provenance; both are opaque, snapshot-bound lookup keys rather than filesystem paths or client authority. The request contains no relative path, current hash/tree, existence flag, original ordinal, role, raw bytes or arbitrary SHA. It must contain exactly one selection for every affected entry, with no missing/duplicate entry or choice IDs. File and absence entries permit `keep_current` plus only compatible enumerated choices; a directory entry permits only `keep_current_topology`. Therefore one request may mix, for example, a file `select_version`, another file `select_absent_before_create`, and a directory `keep_current_topology`. Cap every diff and response. Directory descriptors expose only the complete `DirectoryTreeVersion.treeSha256`, entry count, total bytes and bounded server diff—not member bytes. Invalid Markdown may be kept as current with a recorded schema issue, but it never becomes a successful candidate/source projection. No export descriptor, lease, filename, operation ID or byte source is exported from this shared module.

- [ ] **Step 5: Implement current-hash-bound manual resolution**

`ManualResolutionService.createPlan(batchId, request)` rescans the exact batch, requires the supplied `snapshotSha256`, and resolves every opaque `affectedEntryId`/`choiceId` only through the validated batch's current/before/after/retained choice table. It rereads every current file/tree/absence observation and rejects a changed snapshot, raw/tree hash or identity. The service requires exhaustive one-choice-per-path coverage and derives the complete relative path, current version, selected provenance, original ordinal and expected-before value server-side. It accepts no uploaded text, client path/hash/existence/ordinal, arbitrary SHA or browser-provided tree members. Per-path `keep_current` covers a current file or absence; `keep_current_topology` is the only V1 directory choice for an ambiguous directory move or nonempty created directory because unchanged package bytes were not copied into recovery blobs. A request may mix those decisions with selections on other paths. The UI must explain that retained directory topology remains for review. Do not synthesize a directory merge, remove a nonempty directory or pretend a retained directory version exists.

Resolve the renderer payload through a server-issued table, never through request fields:

```ts
const request = recoveryResolutionRequestSchema.parse(input);
const snapshot = await scanner.requireSnapshot(batchId, request.snapshotSha256);
const choiceTable = issueRecoveryChoiceTable(snapshot);
const selections = resolveExhaustiveSelections(choiceTable, request.selections);
return createWritePlan(buildResolvePlanInput(snapshot, selections));
```

For a file `select_version`, emit `replace` when current exists or `create` when current is absent, with expected-before bound to the server-observed current state and after bytes loaded only by validated content address. For `select_absent_before_create`, resolve its opaque choice to an original step that is exactly a file `create`, require its validated before state to be absent and current to be that created file with the recorded hash/dev/ino, then emit recovery-only `retire-created-file` with the server-derived `recoveryOfOrdinal`, moving it exclusively into this batch's retained/quarantine area. Absence is not a generic version and never authorizes unlinking an arbitrary current file. Canonicalize the complete UTF-8-path-sorted path/current-file-or-tree-or-absence/selected-source/action map into the Phase 1 resolve-only `resolutionSha256`, then call the existing `createWritePlan`; continue/rollback must not carry this field. Thus a mixed selection, including an all-keep-current zero-step plan, is bound into `planSha256`.

Execution uses `executeRecovery`, the same lock, journal, helper, verifier and native confirmation authority. The immutable recovery manifest contains the complete resolution `WritePlan`, whose `planSha256` binds `resolutionSha256`, plus the normal capsule/blob/staging reservations; it does not duplicate the selection payload or gain a result-like field. Before any mutation or zero-step finalization, append, fsync and reread the required Phase 1 `resolution` journal record containing the strict versioned complete server-derived selection map, and require its recomputed `resolutionSha256` to equal the immutable plan. A missing, duplicate, changed or post-intent resolution record is corrupt/manual-only. A crash after a resolve create or retire is recovered through the same journal; all recovery steps have new `0..n-1` ordinals and `recoveryOfOrdinal`. After verification, the original intent finalizer receives `direction: 'resolve'`: it rebuilds indexes only for parseable current files, records issues for invalid files or directory topology needing review, returns the extraction workflow to `reviewing` with `MANUAL_RECOVERY_CONFLICT`, commits no candidate, leaves the original batch `manually-resolved`, releases only that recovery lock, and retains the incident bundle for the Phase 5 retention service. Phase 4 itself never cleans it; unresolved/manual-only evidence remains non-auto-cleanable. Add sentinel tests for mixed keep/select decisions across file/directory/absence entries, missing/duplicate path choices, a conflicting directory move with both source/destination tree descriptors, a nonempty created directory, select-before, select-after, select-retained, absent-current create, selecting validated absent-before-create through `retire-created-file`, current raw/tree hash/identity races, forged path/tree/absence/original ordinal/choice ID, invalid schema, crash/replay and attempted force/new-byte injection.

- [ ] **Step 6: Implement a SQLite-independent recovery-only runtime**

`startServer` must make the recovery root and Phase 1 scanner/state kernel available before opening SQLite. If the state database cannot open or reports corruption, `src/electron/main.ts` still loads a loopback origin from `startRecoveryOnlyRuntime`; it must not instantiate the ordinary repositories, index scheduler, watcher, model client, intake/extraction/editor services or ordinary mutation routes. The minimal runtime mounts the existing session/CSRF/CSP/Host/Origin guards plus health, recovery list/detail/versions, continue, rollback, resolve-plan/execute and state-rebuild routes. It derives state only from validated manifest/blob/journal/disk evidence. Phase 5 will add a second, disjoint scanner input for immutable private retirement-control ledgers so a terminal batch already moved out of `recovery/` remains discoverable after SQLite loss; that extension may resume only an already-authorized ledger and never select a fresh cleanup candidate. It mounts no export-descriptor/download route; `startRecoveryOnlyRuntime` may return a main-process-private exporter port alongside the loopback origin, but never serializes an export lease into HTTP.

Before manifest persistence, the original intent handler must build and strictly parse the Phase 1 `DomainProjectionCapsule`. In Phase 4 the closed union is:

```ts
type Phase4ProjectionCapsulePayloads = {
  intake: IntakeProjectionCapsulePayload;
  extraction_batch: ExtractionProjectionCapsulePayload;
};
```

This is only the intent-to-payload mapping used by strict handler schemas; the runtime value remains the existing Phase 1 `DomainProjectionCapsule` envelope `{ schemaVersion: 1, intentKind, payload, payloadSha256 }`. `IntakeProjectionCapsulePayload` is imported unchanged from Phase 2, including its strict `confirmationBinding` branch; Phase 4 defines only `ExtractionProjectionCapsulePayload`. Do not add a second plan-hash field or parallel capsule type. Each nested object is recursively strict in Zod, not an open record. `candidatesBefore` contains every authoritative structured candidate draft for the affected run—not just the selected subset—and `briefingBefore` preserves its optional acknowledged briefing, so forward, rollback and resolve can reproduce all affected workflow rows and the source reducer after SQLite loss; `binding` contains the plan/source binding and exact selected IDs/versions/hashes/dispositions, including a source-only empty selection. For a `user_confirmed` intake capsule, `confirmationBinding` is mandatory and is the immutable source of `bindingId`, `bindingVersion`, canonical resolution, `resolutionSha256` and `resolvedAt`; its plan/capsule/job cross-bindings and post-confirmation ready version must validate exactly. `resolvedAt` remains metadata-resolution time, never native confirmation evidence. Both payloads contain stable domain IDs, pre-state/version fields, deterministic intended projection facts and normalized relative affected-index paths only. They contain no API/model key, prompt, raw provider response, native grant/session, absolute path, recovery byte, duplicate source body or renderer-provided value. `payloadSha256` hashes canonical `payload`; the Phase 1 manifest/authorization/terminal bindings cover the complete envelope and plan, and an intent/hash/schema mismatch blocks preparation.

When a recovery-only continue/rollback/resolve converges disk without SQLite, append and fsync an idempotent Phase 1 batch-level `projection-pending` record before exposing `磁盘恢复完成，等待重建状态库`; never claim the normal workflow committed. Use the existing discriminated journal union and exact Phase 1 payload `{ originalBatchId, recoveryBatchId, direction, originalIntentKind, originalPlanSha256, resolutionSha256?, affectedPathsSha256, observedOutcomeSha256 }`; do not create or extend another format. Step records `intent/staging-source/staged/result` retain mandatory `stepOrdinal`; batch records `authorization/resolution/projection-pending` have no step ordinal. The record contains no bytes/absolute paths and participates in the same previous-entry hash chain. Unit tests reject step records without ordinals, batch records with ordinals, duplicate/mismatched projection records, resolve without matching resolution provenance and any chain corruption.

After state rebuild, replay each validated `projection-pending` record through the original intent finalizer using only its manifest's matching capsule plus freshly verified disk outcome. Rebuild the plan, binding header (including zero-selection plans), candidates/run or intake job, finalization receipt and affected index rows in one immediate transaction; exact replay is idempotent by original/recovery batch IDs, plan hash, direction and capsule hash. For `user_confirmed` intake, rebuild `intake_resolutions` from the strict capsule's exact `bindingId`, `bindingVersion`, `resolution`, `resolutionSha256`, `resolvedAt`, `expectedJobVersion`, plan ID/hash and capsule JSON/hash—never from a path, current classifier result or a new timestamp. A matching durably promoted manifest proves that binding left `active`; restore it as the same historical `consumed` row (using the manifest persistence boundary for `state_updated_at`) for forward, continue, rollback and resolve. Forward/continue reconstruct `completed`; rollback reconstructs `ready` with the original mode but keeps the old binding consumed; resolve reconstructs `needs_confirmation` with `MANUAL_RECOVERY_CONFLICT` and keeps it consumed. Repository rebuild must preserve every independently evidenced binding version, enforce at most one active row, and reject duplicate-version/divergent-history or state/terminal contradictions. It must not reactivate a consumed binding. A missing/unknown/mismatched capsule, projection record, disk observation or future intent kind is `manual-only` and ordinary routes remain locked—recovery-only code must not invent domain rows from filenames.

If no unfinished manifest exists, show `重建本地索引与状态库`: build a new migrated database at a private appData sibling from a read-only vault scan plus every still-retained validated manifest/terminal/capsule projection and, after Phase 5, every strictly replayed retirement-control projection, fsync it, preserve the corrupt database as a timestamped appData backup, atomically install the new database and request relaunch. A Phase 5 nonterminal ledger rebuilds `retiring` with its exact derived cursor/head even when the bound batch now lives under `recovery-trash`; its terminal rebuilds `retired`. It is not fed into unfinished-write action derivation. Capsule/manifest evidence is retained and, only after Phase 5 eligibility/approval, has its original payload bytes retired as one incident unit while a minimal zero-byte audit tree and immutable control ledger remain; no member can be retired separately while a projection is pending or an export lease is active, and neither phase performs unlink/rmdir cleanup. An unexecuted `active` confirmed preview has no manifest/capsule outside SQLite and therefore is deliberately invalidated when SQLite is lost: do not claim to recover that plan or its cancelled/superseded no-manifest history, do not recreate an active row from vault paths, and clear all process-local native grants on relaunch. The next explicit confirmation may create only a fresh server-derived binding/plan/capsule whose version is one greater than the maximum binding version actually recovered from durable evidence; if no such history survives, it starts a new local lifecycle and no old token/plan can match it. Add integration tests that **delete as well as corrupt** SQLite after manifest persistence for both `intake` and `extraction_batch`, complete each available `continue`, `rollback`, and mixed-path `resolve` direction in recovery-only mode, rebuild, relaunch, and assert exact job/run/candidate/binding-history/finalization/index state with idempotent replay. For intake, assert the capsule's `resolutionSha256`, `bindingVersion` and `resolvedAt` round-trip byte-for-byte, the reconstructed state is `consumed`, rollback/resolve never reactivate it, duplicate/divergent binding history fails closed, and a separate no-manifest active preview is invalidated rather than fabricated. Also assert the minimal origin still serves recovery actions, every normal constructor stays unused, invalid/missing capsules fail closed, and a no-pending rebuild reads but never mutates the vault.

- [ ] **Step 7: Implement verified streaming export without HTTP bytes**

Create one server-internal `RecoveryEvidenceLeaseCoordinator` shared by export and, in Phase 5, retention cleanup. It grants at most one exclusive `export | cleanup` lease for a batch. Export acquires its lease before the first batch validation and retains it through the final destination result; cleanup must acquire the same coordinator's cleanup lease before its final eligibility recheck or treat the batch as held. This is an atomic acquire, never a `hasActiveLease()` check followed by work. A process crash drops only in-memory ownership when no exporter/cleanup worker remains alive; Phase 5's independently fsynced private retirement-control header/journal—not its SQLite projection—is the authority for resuming an interrupted cleanup.

`RecoveryExportService.createPrivateLease(batchId, snapshotSha256)` first acquires the batch export lease, then rechecks recovery-root containment, direct non-symlink batch directory, mode, realpath/dev/ino, manifest hash, journal chain, blobs and retained identities. On validation failure before a handle is returned it releases immediately. On success it stores the lease guard plus filename/length/hash/source identities in a short-lived main-process-private table and returns an opaque handle only through the in-process server/main port; the lease/descriptor type is module-private and is not part of `src/shared`, Fastify schemas, HTTP responses or preload. `streamVerifiedBundle(privateLeaseHandle, sink)` repeats validation, writes a deterministic archive in bounded chunks, computes/compares byte length and SHA-256, ends the generic sink and awaits its completion, but does not claim that `NodeJS.WritableStream` itself is durable and does not release the batch lease. Phase 6 supplies the writable side of one held native exclusive user destination; after this method has ended it, the destination's `seal()` only fsyncs/rereads/verifies the already-ended held descriptor and parent. No appData bundle copy is created. Once a handle exists, stream failure may mark it unusable for another stream but retains the underlying coordinator guard. Electron main calls idempotent `releasePrivateLease()` in `finally` only after the dialog/stream/native destination operation has settled and the held destination has closed; timeout and shutdown must first abort and await that active operation. It never materializes the archive in renderer or appData memory/storage and never logs filenames from recovered content. `startServer` and `startRecoveryOnlyRuntime` expose this narrow exporter port only to Electron main and inject the same coordinator into Phase 5 retention.

Keep the port main-only; do not export `PrivateRecoveryExportLease` from its module:

```ts
export interface RecoveryEvidenceLease {
  release(): void;
}
export interface RecoveryEvidenceLeaseCoordinator {
  acquire(batchId: string, purpose: 'export' | 'cleanup'): Promise<RecoveryEvidenceLease | undefined>;
}
export interface MainRecoveryExporterPort {
  createPrivateLease(batchId: string, snapshotSha256: string): Promise<string>;
  streamVerifiedBundle(privateLeaseHandle: string, sink: NodeJS.WritableStream): Promise<{
    bundleSha256: string;
  }>;
  releasePrivateLease(privateLeaseHandle: string): Promise<void>;
}
```

Keep one additive lifecycle type rather than returning ad-hoc objects from the two startup paths. `src/server/workflow/mutation-summary-reader.ts` owns the main-process-private request/material types below; they never enter HTTP, preload, renderer state, or `src/shared`. Normal startup resolves them from the immutable repository plan/capsule/binding, while recovery-only startup resolves them from the validated manifest/recovery graph:

```ts
export type MutationSummaryRequest = {
  readonly planId: string;
  readonly expectedPlanSha256: string;
  readonly operation: 'execute' | 'continue' | 'rollback' | 'resolve';
  readonly recoverySnapshotSha256?: string;
};
export type ServerMutationSummaryMaterial = {
  readonly plan: WritePlan;
  readonly projectionCapsule: DomainProjectionCapsule;
  readonly originalIntentKind: RecoverableOriginalIntentKind | null;
  readonly recoverySnapshotSha256: string | null;
  readonly resolutionSha256: string | null;
  readonly keepCurrentPaths: readonly NormalizedVaultRelativePath[];
};
export interface MainMutationSummaryReader {
  loadCurrent(input: MutationSummaryRequest): Promise<ServerMutationSummaryMaterial>;
}
export interface StartedMutationRuntime extends StartedServer {
  readonly mainRecoveryExporterPort: MainRecoveryExporterPort;
  readonly mutationSummaryReader: MainMutationSummaryReader;
}
```

`ServerMutationSummaryMaterial` deliberately contains only current server-domain plan/capsule/recovery facts. It does not pretend to carry live target/appData/recovery identities, capability profile or approved rule bytes. Phase 6 must inject a separate Electron-main-owned `NativeConfirmationScopeProvider` into the confirmation handler; that provider derives those values from the same held evidence authority used by production policy, both before the dialog and again after a positive response. Neither runtime interface nor summary DTO is widened with caller-supplied security evidence.

`StartedMutationRuntime` lives only in `src/server/runtime/started-mutation-runtime.ts` and imports the two main-private ports plus Phase 2's existing `StartedServer`; do not redeclare the same shape in Electron or the recovery-only module. Both `startServer()` and `startRecoveryOnlyRuntime()` return `Promise<StartedMutationRuntime>`, own exactly one exporter and one summary reader, and close them in the same ordered lifecycle. Recovery-only implements `requestFocusReconcile()` as an explicit resolved no-op because watcher/reconciler construction is forbidden. Integration/type tests assign both concrete results to this one interface, call both main-private ports, and prove `close()` makes subsequent reads/leases fail.

Tests hold `streamVerifiedBundle()` at an injected barrier and prove a cleanup acquire for the same batch fails without moving it; they hold a cleanup lease and prove export fails before reading the batch or opening a destination. They also prove explicit caller release after handle creation without streaming, validation error before handle return, stream error, destination seal error, destination error, timeout and shutdown release the underlying guard exactly once at the lifecycle boundary above, while unrelated batch IDs remain independent. They assert the generic service ends the sink exactly once and Phase 6 `seal()` does not end it again. Phase 6 owns the concrete native-dialog cancel test.

Declare optional `XiaozhaoDesktopApi.exportRecoveryBundle?: (input: { batchId: string; snapshotSha256: string }) => Promise<{ status: 'saved'; bundleSha256: string } | { status: 'cancelled' }>` as the single renderer boundary. Phase 4 component tests inject this exact optional port and assert the saved hash equals the main-private verified lease; no request/result contains a filename, path, lease ID or operation ID. Phase 6 must make the method required and implement the native save dialog/`0600` destination plus the main-process direct call to `streamVerifiedBundle`. No export-descriptor/download route, blob URL, base64 field or renderer-supplied destination path is allowed. The App shows `导出恢复包` if and only if the fresh server snapshot's `allowedActions` contains `export`: this may include a `manual-only` snapshot whose complete evidence remains valid and a `complete` batch with retained evidence, but never `partial-journal`, `missing-blob`, broken-chain, or another evidence-integrity `invalid` snapshot. It never infers export availability from `classification`. Export is auxiliary and never resolves the lock.

- [ ] **Step 8: Implement the browser client methods**

Add:

```ts
createWritePlan(input: FormalIngestionRequest, idempotencyKey: string): Promise<ApiClientResult<WritePlanPreview>>;
getWritePlan(id: string, signal?: AbortSignal): Promise<ApiClientResult<WritePlanPreview>>;
cancelWritePlan(id: string, input: { expectedPlanSha256: string; expectedBindingVersion: number }, idempotencyKey: string): Promise<ApiClientResult<WritePlanPreview>>;
supersedeWritePlan(id: string, input: { expectedPlanSha256: string; expectedBindingVersion: number; replacement: FormalIngestionRequest }, idempotencyKey: string): Promise<ApiClientResult<WritePlanPreview>>;
commitWritePlan(id: string, expectedPlanSha256: string, expectedBindingVersion: number, idempotencyKey: string, nativeGrantToken?: string): Promise<ApiClientResult<WriteBatchSnapshot>>;
getWriteBatch(id: string, signal?: AbortSignal): Promise<ApiClientResult<WriteBatchSnapshot>>;
continueRecovery(id: string, expectedVersion: number, snapshotSha256: string, idempotencyKey: string, nativeGrantToken?: string): Promise<ApiClientResult<WriteBatchSnapshot>>;
rollbackRecovery(id: string, expectedVersion: number, snapshotSha256: string, idempotencyKey: string, nativeGrantToken?: string): Promise<ApiClientResult<WriteBatchSnapshot>>;
getRecoveryVersions(id: string, snapshotSha256: string, signal?: AbortSignal): Promise<ApiClientResult<readonly RecoveryChoiceDescriptor[]>>;
createRecoveryResolutionPlan(id: string, input: RecoveryResolutionRequest, idempotencyKey: string): Promise<ApiClientResult<WritePlanPreview>>;
resolveRecovery(id: string, planId: string, expectedPlanSha256: string, expectedVersion: number, snapshotSha256: string, idempotencyKey: string, nativeGrantToken?: string): Promise<ApiClientResult<WriteBatchSnapshot>>;
```

The optional token exists only for Phase 4 sentinel/injected-policy compatibility. Phase 6 must explicitly modify `src/client/api/client.ts` so `nativeGrantToken` is required on the four human mutation methods above, obtain it only from `confirmWriteOperation`, post it once, and clear the local reference in `finally`; it must not add a confirmation boolean or token-bearing generic request helper. Automatic intake does not call these human client methods. Export remains bridge-only and has no browser-client method.

- [ ] **Step 9: Verify GREEN and commit**

Run:

```bash
npm run test:unit -- recovery-journal
npm run test:integration -- formal-ingestion-api recovery-only-runtime manual-recovery-resolution recovery-export-service local-http-security
npm run test:component -- api-client
npm run typecheck
```

Expected: validation, session, CSRF, idempotency, version, gate, plan lifecycle, token redaction, SQLite-independent capsule recovery, mixed manual resolution and absence of an HTTP export surface all pass.

Commit:

```bash
git add src/server/api/routes/write-plans.ts src/server/api/routes/write-batches.ts src/server/api/routes/recovery.ts src/shared/domain/recovery.ts src/server/recovery/recovery-only-runtime.ts src/server/recovery/manual-resolution-service.ts src/server/recovery/recovery-export-service.ts src/server/workflow/mutation-summary-reader.ts src/server/runtime/started-mutation-runtime.ts src/shared/api/schemas.ts src/shared/desktop/bridge.ts src/server/app.ts src/server/start-server.ts src/electron/main.ts src/server/recovery/recovery-manifest.ts src/server/recovery/recovery-journal.ts src/server/db/repositories/intake-repository.ts src/server/workflow/recovery-service.ts src/server/workflow/write-coordinator.ts src/client/api/client.ts tests/integration/formal-ingestion-api.test.ts tests/integration/recovery-only-runtime.test.ts tests/integration/manual-recovery-resolution.test.ts tests/integration/recovery-export-service.test.ts tests/unit/recovery-journal.test.ts tests/component/api-client.test.tsx
git commit -m "feat: expose formal ingestion and recovery APIs"
```

### Task 6: Implement candidate selection, full diff and recovery UI

**Files:**

- Create: `src/client/pages/WriteConfirmationPage.tsx`
- Create: `src/client/pages/RecoveryDetailPage.tsx`
- Create: `src/client/components/write/DispositionControl.tsx`
- Create: `src/client/components/write/FileDiffViewer.tsx`
- Create: `src/client/components/write/WriteGate.tsx`
- Create: `src/client/components/write/BatchTimeline.tsx`
- Create: `src/client/components/write/RecoveryActions.tsx`
- Create: `src/client/styles/write-workflow.css`
- Modify: `src/client/pages/ExtractionWorkbenchPage.tsx`
- Modify: `src/client/pages/QueuePage.tsx`
- Modify: `src/client/pages/OperationsPage.tsx`
- Modify: `src/client/app/router.tsx`
- Test: `tests/component/write-confirmation.test.tsx`
- Test: `tests/component/recovery-ui.test.tsx`

- [ ] **Step 1: Add failing selection and confirmation tests**

Assert the user can select any nonempty subset of accepted/unwritten candidates; pending candidates remain in the workbench; every selected row chooses create/merge; protected merge never silently defaults to create. `已优化` 的 evidence-only 合并不要求确认，semantic change 要求 `==AI待认==` 确认；`定论` 只允许不改变原意的来源/出处补充；`过时` 禁止合并。Preview shows target, complete YAML/Markdown, line diff, source update, ordered files and gate state.

For a valid zero-candidate run, assert the workbench says `未发现可入库候选`; `重新提炼` remains separate; `确认无候选并结案` opens a source-only diff showing only `知识入库状态: 已入库`. It requires its own acknowledgement plus `确认写入本批次`. The same empty selection is unavailable while any pending/accepted candidate exists.

Use an explicit commit control:

```ts
const commit = screen.getByRole('button', { name: '确认写入本批次' });
expect(commit).toBeDisabled();
await user.click(screen.getByRole('checkbox', { name: `选择 ${candidate.title}` }));
await user.click(screen.getByRole('radio', { name: '新建知识' }));
await user.click(screen.getByRole('button', { name: '生成写入差异' }));
expect(await screen.findByText('来源状态：部分入库')).toBeVisible();
expect(screen.getByRole('button', { name: '确认写入本批次' })).toBeEnabled();
```

- [ ] **Step 2: Add failing recovery UI tests**

Assert success appears only for `committed`; core batch state `recovery-required` routes to timeline; timeline shows recovery-plan ordinal plus `recoveryOfOrdinal` and hash prefixes; continue/rollback are separate, require a local second-confirmation interaction, send current batch version/snapshot hash plus the optional injected Phase 4 native grant, and become disabled while pending. The UI never serializes that acknowledgement as a confirmation boolean. For `manual-only`, render validated current/before/after/retained version cards with role, path, full hash, byte length, schema result and server-produced bounded diff. The user chooses exactly one action per affected path, so a single request can keep a directory topology while selecting an older file version elsewhere; the posted request contains only opaque `affectedEntryId`/`choiceId` values, action, snapshot and acknowledgement. Generate a new current-snapshot-bound resolve diff and commit only after a second explicit interaction; there is no editable bytes field or force-overwrite button. `保留当前版本` may warn about a schema issue and still finishes as `manually-resolved / 待复核`, never committed.

Assert `导出恢复包` is rendered only from fresh server `allowedActions.includes('export')` and calls only the injected single-purpose desktop exporter with batch ID and current snapshot hash; cover `manual-only` with fully valid evidence and `complete` with retained evidence, plus `partial-journal`, `missing-blob`, broken-chain, and another non-exportable snapshot whose button is absent. Neither API mock nor component receives archive bytes, an absolute recovery path, an export descriptor or a main-private lease ID. When export is allowed but the optional Phase 4 bridge method is unavailable, keep the button visible but disabled with `桌面安全导出将在最终验收阶段启用`; Phase 6 makes it available. In recovery-only mode, render the same server-advertised actions without normal navigation. With no pending manifest, show `重建本地索引与状态库`, require confirmation, preserve the damaged database and relaunch on success.

Assert the mixed request shape exactly:

```ts
expect(api.createRecoveryResolutionPlan).toHaveBeenCalledWith(batchId, {
  snapshotSha256,
  acknowledged: true,
  selections: [
    { affectedEntryId: fileEntryId, action: 'select_version', choiceId: beforeChoiceId },
    { affectedEntryId: directoryEntryId, action: 'keep_current_topology' }
  ]
}, expect.any(String));
```

Both component suites assert the existing visual contract instead of introducing a theme: every plan/batch/recovery state has visible Chinese text, a non-color icon and a `data-tone`; red is reserved for failure/conflict, amber for pending confirmation/recovery decision, blue for auxiliary timeline data, and fluorescent green for verified/committed. Styles reference the existing `--surface-void`, `--surface-glass`, `--border-*`, `--accent-primary`, `--status-amber`, `--status-red` and `--status-blue` tokens. Full Markdown/YAML diff and recovery-detail regions have no backdrop blur. With `prefers-reduced-motion: reduce`, progress and timeline components remove nonessential transition/transform animation.

- [ ] **Step 3: Run and verify RED**

Run:

```bash
npm run test:component -- write-confirmation recovery-ui
```

Expected: the current inert write/recovery routes lack confirmation and recovery controls, so the first behavioral assertions fail.

- [ ] **Step 4: Implement confirmation flow**

The browser never computes authoritative after bytes. An explicit back/cancel after preview calls the idempotent plan-cancel endpoint before releasing the UI; regenerating from changed candidate selections calls atomic supersede with the exact old plan hash/binding version instead of silently orphaning a frozen binding. If either returns a conflict because preparation began, the UI stays on the batch/recovery state and does not pretend cancellation succeeded. Final write requires an ordinary deliberate button click; Enter on a card, navigation, long press and keyboard selection cannot commit. Poll or resume events until server says `committed` or `recovery-required`.

Use the authoritative preview expectations for both lifecycle calls:

```ts
await api.cancelWritePlan(preview.planId, {
  expectedPlanSha256: preview.planSha256,
  expectedBindingVersion: preview.bindingVersion
}, idempotencyKey);

await api.supersedeWritePlan(preview.planId, {
  expectedPlanSha256: preview.planSha256,
  expectedBindingVersion: preview.bindingVersion,
  replacement: nextRequest
}, nextIdempotencyKey);
```

- [ ] **Step 5: Implement recovery and queue transitions**

`BatchTimeline` displays persisted steps and operation ID. `RecoveryActions` branches strictly on server actions: safe continue, safe rollback, manual resolve, export, or rebuild; it never derives safety from client hashes. A resolve preview uses `FileDiffViewer`, locks only the selected opaque choice IDs and snapshot hash, and discards itself when any server snapshot changes. Production commit/continue/rollback/resolve remain disabled until Phase 6 returns the corresponding one-shot native grant, while sentinel tests inject only `SentinelTestMutationPolicy`; each request posts the token once and clears it in `finally`. Reuse the existing near-black/glass/silver-border/fluorescent-green tokens; do not add alternate palette values. Every state uses text + icon + permitted token color, long diff/detail surfaces set `backdrop-filter: none`, and reduced-motion CSS disables nonessential animation. After partial commit, route to Queue where the material appears only as `继续处理`; it must not reappear in Dashboard deck. After all committed/abandoned, show `已入库` and remove the default task.

The Phase 6-enabled branch follows this one-use pattern (the Phase 4 bridge port may be absent):

```ts
let nativeGrantToken: string | undefined;
try {
  const confirmed = await window.xiaozhaoDesktop.confirmWriteOperation(request);
  if (confirmed.status === 'cancelled') return;
  nativeGrantToken = confirmed.nativeGrantToken;
  await api.continueRecovery(batchId, version, snapshotSha256, idempotencyKey, nativeGrantToken);
} finally {
  nativeGrantToken = undefined;
}
```

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
npm run test:component -- write-confirmation recovery-ui extraction-workbench read-pages
npm run typecheck
```

Expected: selection, full diff, protected states, submit lock, recovery actions and queue/deck state tests pass.

Commit:

```bash
git add src/client/pages/WriteConfirmationPage.tsx src/client/pages/RecoveryDetailPage.tsx src/client/components/write/DispositionControl.tsx src/client/components/write/FileDiffViewer.tsx src/client/components/write/WriteGate.tsx src/client/components/write/BatchTimeline.tsx src/client/components/write/RecoveryActions.tsx src/client/styles/write-workflow.css src/client/pages/ExtractionWorkbenchPage.tsx src/client/pages/QueuePage.tsx src/client/pages/OperationsPage.tsx src/client/app/router.tsx tests/component/write-confirmation.test.tsx tests/component/recovery-ui.test.tsx
git commit -m "feat: add formal ingestion confirmation and recovery UI"
```

### Task 7: Add test-vault proof for partial ingestion, conflict and crash recovery

**Files:**

- Create: `tests/e2e/test-vault-partial-ingestion.spec.ts`
- Create: `tests/e2e/test-vault-partial-ingestion.spec.ts-snapshots/formal-ingestion-confirmation-1440x900-chromium-darwin.png`
- Create: `tests/e2e/test-vault-ingestion-conflict.spec.ts`
- Create: `tests/e2e/test-vault-ingestion-recovery.spec.ts`
- Modify: `tests/helpers/atomic-test-vault.ts`

- [ ] **Step 1: Implement the stronger E2E write guard**

Assert the guard rejects the canonical formal vault, configured formal vault, equal/contained roots, symlink aliases, missing sentinel and any root not created by the current E2E fixture. Keep the exact arming value test-only; the packaged App does not expose it as a user setting.

```ts
for (const root of [formalRoot, configuredFormalRoot, containedRoot, symlinkAlias, missingSentinelRoot]) {
  await expect(assertAtomicTestVault(root)).rejects.toThrow('TEST_VAULT_REQUIRED');
}
await expect(assertAtomicTestVault(currentFixture.root)).resolves.toBeUndefined();
```

- [ ] **Step 2: Add the two-partial-batch closure test**

In one fresh sentinel vault:

```text
three candidates: A accepted, B accepted, C pending
→ select A/create → commit
→ knowledge A exists and source is 部分入库
→ B and C remain editable, A is committed/frozen
→ decide C abandoned, select B/merge → commit
→ source is 已入库 and generated links are old-first union
→ dashboard deck excludes source, queue default excludes source
```

Reread raw bytes after each batch and verify knowledge/source links, status, schemas, source body equality and verified finalization.

Before the first commit, set a fixed 1440×900 dark viewport, disable animations and capture `formal-ingestion-confirmation-1440x900.png` with `toHaveScreenshot`. The reviewed baseline must preserve the existing near-black glass shell, silver borders and fluorescent-green primary action; pending confirmation is amber, auxiliary diff metadata is blue, and red is absent from the healthy plan. Repeat the key layout assertion with reduced motion and require no nonessential animated transform.

- [ ] **Step 3: Add target/source/reducer race tests**

Create or edit a target after plan generation and edit source after plan generation. Separately change an unselected candidate from accepted-unwritten to abandoned after a partial preview; the reducer-changing case must return `WRITE_PLAN_STALE`, cancel the unprepared binding and release the selected candidate before any manifest/helper effect, while a reducer-neutral unselected body edit remains valid. Exercise explicit cancel and atomic supersede, including zero-candidate bindings, exact idempotent replay, stale version/hash conflicts and a race with preparation under the shared mutex. The atomic helper must preserve all observed versions, coordinator must enter conflict/recovery as specified, and no target may contain an unconfirmed overwrite.

```ts
await abandonCandidate(unselectedCandidate.id, unselectedCandidate.version);
await expect(commitPreview(preview)).rejects.toMatchObject({ code: 'WRITE_PLAN_STALE' });
expect(await recoveryStore.listActive()).toEqual([]);
expect(await candidateState(selectedCandidate.id)).toBe('unwritten');
await expect(supersedePreview(stalePreview, replacement)).rejects.toMatchObject({ code: 'WRITE_PLAN_VERSION_CONFLICT' });
```

- [ ] **Step 4: Add every fault-window recovery test**

Terminate at every Phase 1 fault point for create, merge and source-last operations, including continue, rollback and resolve finalization. Restart the service, exercise continue and rollback where hashes permit, and assert candidate/write-state/index finalization exactly matches verified final disk state before the recovery outcome becomes visible. Roll back a landed knowledge create through `retire-created-file`, proving fresh recovery ordinals plus original bindings and absence of unlink. If paths equal neither expected before nor after, submit one exhaustive mixed resolve that keeps a directory topology, keeps one current file and selects a validated retained version for another file through opaque choice IDs only. Reject missing/duplicate paths and any forged client path/hash/ordinal. Race the current path after resolve preview and require a fresh plan. Delete SQLite after each intake/extraction manifest case, finish continue/rollback/resolve in recovery-only mode, rebuild from the strict matching projection capsule, relaunch and compare all domain/binding/finalization/index rows; invalid or missing capsules remain manual-only. Verify forged/uploaded bytes are rejected, the incident bundle remains retained, and export yields the main-private described hash through the privileged streaming service only, with no export descriptor or bytes on HTTP.

```ts
for (const intentKind of ['intake', 'extraction_batch'] as const) {
  for (const direction of ['continue', 'rollback', 'resolve'] as const) {
    await deleteSqliteAfterManifest({ intentKind, direction });
    await finishInRecoveryOnlyMode(direction);
    await rebuildAndAssertExactProjection({ intentKind, direction });
  }
}
await expect(http.get(`/api/v1/recovery/${batchId}/export-descriptor`)).resolves.toMatchObject({ status: 404 });
```

- [ ] **Step 5: Run Phase 4 verification**

Run:

```bash
npm run test:unit -- knowledge-template knowledge-frontmatter-patch knowledge-merge-renderer formal-ingestion-planner
npm run test:integration -- ingestion-repository formal-ingestion-service formal-ingestion-coordinator formal-ingestion-crash formal-ingestion-recovery formal-ingestion-api recovery-only-runtime manual-recovery-resolution recovery-export-service
npm run test:component -- write-confirmation recovery-ui
npm run test:e2e -- test-vault-partial-ingestion test-vault-ingestion-conflict test-vault-ingestion-recovery
npm run build
```

Expected: all commands exit 0; write traces name only current-test temporary roots; no formal vault path is mutated.

- [ ] **Step 6: Commit**

```bash
git add tests/helpers/atomic-test-vault.ts tests/e2e/test-vault-partial-ingestion.spec.ts tests/e2e/test-vault-partial-ingestion.spec.ts-snapshots/formal-ingestion-confirmation-1440x900-chromium-darwin.png tests/e2e/test-vault-ingestion-conflict.spec.ts tests/e2e/test-vault-ingestion-recovery.spec.ts
git commit -m "test: prove recoverable partial knowledge ingestion"
```

## Phase 4 Exit Criteria

- User can commit any accepted candidate subset while pending/unselected candidates remain editable.
- A genuinely empty candidate result can be retried or explicitly closed through a confirmed source-only plan; it never fabricates knowledge.
- Only bound candidates freeze; committed candidates cannot be rewritten by later batches.
- Plan persistence plus candidate binding is one immediate transaction; explicit cancel/supersede releases only a proven-unprepared binding and leaves the old plan non-executable.
- Knowledge operations always precede one source-last operation.
- Source content identity stays stable while current raw hash advances after each internal source update.
- Status transitions are derived from committed/abandoned/unwritten candidates and verified from disk.
- New and merged knowledge contain bidirectional source links and pass current schemas.
- All writes use the Phase 1 coordinator, atomic helper, external manifest and recovery service.
- Conflict and every injected crash window preserve all versions and never silently overwrite.
- A reducer-changing unselected-candidate race is rejected before manifest/helper effects; reducer-neutral edits do not invalidate an immutable subset plan.
- SQLite deletion/corruption still opens the minimal recovery UI; intake/extraction recovery projections rebuild only from strict matching manifest capsules, manual resolution supports exhaustive mixed per-path opaque choices and ends as `manually-resolved/待复核`.
- Human mutation HTTP accepts only the optional Phase 4 one-use native token field and no confirmation boolean; Phase 6 must make that client argument mandatory in normal packaged mode.
- Privileged export never exposes recovery bytes, filenames, lease IDs or descriptors to HTTP or renderer, and state rebuild never writes the vault.
