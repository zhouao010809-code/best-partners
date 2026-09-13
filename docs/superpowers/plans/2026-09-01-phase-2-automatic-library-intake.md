# Phase 2 Automatic Library Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自动发现 `01图书馆/小兆clipper` 中已经稳定落盘的直属 Markdown 或子目录资料包，在不改写原始正文和附件的前提下按现行规则规范命名并完成可恢复入馆，并把无法确定的资料留在待确认队列。

**Architecture:** `IntakeReconciler` 负责启动、聚焦和文件事件后的全量对账，`PackageStabilityTracker` 只把连续两次快照一致的直属单文件或子目录资料包交给 `PackageClassifier`。`IntakePlanner` 生成不可变写入计划；高置信度自动判定可直接进入受限自动执行，而用户补全的判定只原子持久化 resolution、完整计划和投影胶囊绑定，必须再经 App 原生确认后显式 apply。正式 YAML 补丁、受控的月份/单文件包目录创建和排他重命名/移动统一交给 Phase 1 的 `WriteCoordinator`，SQLite 保存任务、判定、确认计划绑定和操作状态。

**Tech Stack:** TypeScript, Fastify, Zod, better-sqlite3, React, Vitest, Playwright, Electron 内嵌服务, Phase 1 `FileSystemVaultGateway` 与 `WriteCoordinator`

---

## File Structure

**Create:**

- `src/server/db/migrations/004_intake_workflow.sql` — 入馆任务、完整文件/目录包版本和用户确认记录。
- `src/shared/domain/intake.ts` — 入馆状态、Phase 1 文件/目录版本引用、分类结果和 API 共享类型。
- `src/server/db/repositories/intake-repository.ts` — 版本化任务持久化和合法状态迁移。
- `src/server/rules/source-frontmatter-patch.ts` — 只修改批准字段的 byte-range frontmatter 补丁器。
- `src/server/intake/package-stability.ts` — 连续快照稳定性判断。
- `src/server/intake/clipper-metadata-extractor.ts` — 从不完整插件 Markdown 容错提取标题、URL 和日期候选。
- `src/server/intake/package-classifier.ts` — 识别直属单文件/子目录包，并确定主 Markdown、来源、月份、规范包名和主文档名。
- `src/server/intake/intake-reconciler.ts` — 启动/聚焦/事件后的幂等对账。
- `src/server/intake/intake-watcher.ts` — 文件事件只作为加速信号的 watcher 适配器。
- `src/server/intake/intake-planner.ts` — 将分类结果转换为不可变 `WritePlan`。
- `src/server/intake/intake-verifier.ts` — committed 前复读入馆 schema、状态与附件 hash。
- `src/server/intake/intake-finalizer.ts` — final-state 验证后幂等更新入馆任务与受影响索引。
- `src/server/intake/intake-service.ts` — API 使用的入馆用例服务。
- `src/server/api/routes/intake-jobs.ts` — 入馆列表、详情、字段确认、已确认计划 apply 与手动对账 API。
- `src/client/components/intake/IntakeJobList.tsx` — 队列中的入馆任务列表。
- `src/client/components/intake/IntakeConfirmation.tsx` — 低置信度分类确认表单。
- `tests/fixtures/intake/clipper-single.md` — 插件直接投递到 clipper 根的单 Markdown 样本。
- `tests/fixtures/intake/clipper-package/source.md` — 实际插件形态的测试 Markdown。
- `tests/fixtures/intake/clipper-package/cover.png` — 固定附件 bytes。
- `tests/fixtures/intake/frontmatter-golden/unknown-fields-comments-crlf.md` — 未知字段、注释和 CRLF 样本。
- `tests/fixtures/intake/frontmatter-golden/bom-no-final-newline.md` — BOM 与无末尾换行样本。
- `tests/fixtures/intake/frontmatter-golden/missing-required-keys.md` — 缺少受控字段的样本。
- `tests/fixtures/intake/frontmatter-golden/no-frontmatter.md` — 无 frontmatter 样本。
- `tests/integration/intake-repository.test.ts`
- `tests/unit/source-frontmatter-patch.test.ts`
- `tests/unit/intake-package-stability.test.ts`
- `tests/unit/clipper-metadata-extractor.test.ts`
- `tests/unit/intake-package-classifier.test.ts`
- `tests/integration/intake-reconciler.test.ts`
- `tests/unit/electron-focus-reconcile.test.ts`
- `tests/integration/intake-service.test.ts`
- `tests/integration/intake-api.test.ts`
- `tests/component/intake-queue.test.tsx`
- `tests/e2e/automatic-intake-flow.spec.ts`

**Modify:**

- `src/server/db/migrate.ts` — 在 Phase 1 的 migration 003 之后注册 migration 004。
- `src/server/app.ts` — 注入并注册 intake service。
- `src/server/start-server.ts` — 启停 watcher，并在启动和聚焦时触发对账。
- `src/electron/main.ts` — 将窗口和 app focus 信号转发给 runtime 对账入口。
- `src/shared/api/schemas.ts` — 加入入馆请求/响应严格 schema。
- `src/client/api/client.ts` — 加入入馆 API 方法。
- `src/client/pages/QueuePage.tsx` — 展示待确认入馆和入馆失败任务。
- `src/client/pages/OperationsPage.tsx` — 显示入馆操作结果。
- `src/server/rules/frontmatter.ts` — 公开经过测试的 frontmatter byte-range 定位结果。
- `src/shared/domain/write.ts` — 扩展 Phase 1 的同一个 `WriteIntent` union。
- `src/server/workflow/write-intent-registry.ts` — 注册 intake verifier/finalizer，不给 coordinator 加 kind 分支。
- `src/server/workflow/write-coordinator.ts` — 在 manifest 持久化后调用通用 intent checkpoint hook，不加入 intake 分支。
- `tests/integration/write-kernel.test.ts` — 证明 checkpoint 在 coordinator mutex 内、manifest 后且 helper 前调用并可恢复。
- `tests/component/api-client.test.tsx` — 覆盖确认计划取消、替换与唯一 apply 客户端方法的严格请求体。
- `scripts/copy-server-assets.ts` — 将 migration 004 打包进服务产物。

## Prerequisites and Safety Gate

- Phase 1 已提供直接文件读取、排他移动、原子交换、恢复 manifest、路径锁和 `WriteCoordinator`。
- Phase 0 的全局规则 bundle 按 `00_ / 01_ / 02_图书馆入馆规则 / 03_ / 05_` 的固定顺序计算指纹；入馆不得构造一个排除 `02_图书馆入馆规则.md` 的局部指纹。
- 所有 reconcile、plan 和 execute 依赖 Phase 0 定义并注入的 `RuleCompatibilityGate` port/record；默认 deny，只有测试 fixture 可显式批准测试指纹，Phase 6 才实现 Electron production 审批。只有 `currentRuleBundleSha256 === approvedRuleBundleSha256` 才是 `approved`；首次无批准值或 App 关闭期间规则变化都返回 `RULE_BUNDLE_UNAPPROVED`，读取、搜索和诊断继续可用，但不得因重新分类而自动批准新规则。本阶段不另建 gate 实现。
- 自动化写入只接受 Phase 1 `tests/helpers/atomic-test-vault.ts` 创建、包含精确 `.xiaozhao-atomic-test-vault.json` 哨兵且与正式 vault/source/appData 相互隔离的 `mkdtemp` 临时 vault。
- `~/我的大脑`、配置中的正式 vault、符号链接别名和缺少哨兵的目录必须在任何 mutation 前被拒绝。
- 本计划执行期间不得向正式 vault 写入；正式入馆只在 Phase 6 的用户监督验收中开启。
- 本阶段在 sentinel test vault 中完整实现自动执行。正式 root 的无人值守执行仍保持关闭，直到 Phase 6 由 Electron 主进程持有的 production mutation authority 通过验收后启用。
- 该 authority 最终只能授权 `plan.intent.kind === 'intake'`，且所有 move 的 `from` 必须位于 `01图书馆/小兆clipper` 或同一入馆计划刚创建的精确包目录，`to` 必须位于预先存在且非 symlink 的 `01图书馆/来自<允许平台>` 下。它仅允许排他创建分类结果确定的单个 `YYYY-MM` 目录，以及 `single_file` 形态确定的单个规范包目录；禁止创建平台根、额外月份或任意目录。`extraction_batch`、`knowledge_edit`、restore/reverse intent 永远不能复用 intake authority。

### Task 1: Persist versioned intake jobs

**Files:**

- Create: `src/server/db/migrations/004_intake_workflow.sql`
- Create: `src/shared/domain/intake.ts`
- Create: `src/server/db/repositories/intake-repository.ts`
- Modify: `src/server/db/migrate.ts`
- Modify: `scripts/copy-server-assets.ts`
- Test: `tests/integration/intake-repository.test.ts`

- [ ] **Step 1: Write the failing repository tests**

Create repository tests with a temporary state database and assert exact transitions:

```ts
it('deduplicates the same package snapshot and versions user resolution', () => {
  const packageVersion: DirectoryTreeVersion = {
    path: '01图书馆/小兆clipper/article-1',
    exists: true,
    rootIdentity: { dev: '16777234', ino: '991' },
    entries: [
      { type: 'directory', relativePath: 'assets' },
      {
        type: 'file',
        relativePath: 'source.md',
        rawSha256: 'b'.repeat(64),
        byteLength: 128,
        modifiedAt: '2026-09-01T09:00:00.000Z'
      }
    ],
    treeSha256: 'a'.repeat(64)
  };
  const first = repository.createOrGetDetected({
    packageKey: '01图书馆/小兆clipper/article-1',
    snapshotSha256: packageVersion.treeSha256,
    ruleBundleSha256: 'c'.repeat(64),
    packageVersion
  });
  const duplicate = repository.createOrGetDetected({
    packageKey: first.packageKey,
    snapshotSha256: first.snapshotSha256,
    ruleBundleSha256: first.ruleBundleSha256,
    packageVersion: first.packageVersion
  });
  expect(duplicate.id).toBe(first.id);

  const waiting = repository.markNeedsConfirmation(first.id, first.version, {
    reason: 'SOURCE_PLATFORM_AMBIGUOUS',
    mainMarkdownCandidates: ['source.md']
  });
  const resolved = repository.resolveAndBindPlan({
    id: waiting.id,
    expectedVersion: waiting.version,
    projectedReadyVersion: waiting.version + 1,
    resolution: {
      packageKind: 'directory',
      mainMarkdownPath: '01图书馆/小兆clipper/article-1/source.md',
      sourcePlatform: '公众号',
      collectedAt: '2026-09-01',
      shortTitle: '示例文章'
    },
    classification: makeResolvedClassification({ authorizationMode: 'user_confirmed' }),
    bindingId: 'intake-binding-1',
    bindingVersion: 1,
    resolvedAt: '2026-09-01T09:10:00.000Z',
    plan: makeSchemaValidWritePlan({
      id: 'intake-plan-1',
      expectedJobVersion: waiting.version + 1,
      confirmationBinding: {
        jobId: waiting.id,
        bindingId: 'intake-binding-1',
        bindingVersion: 1,
        resolutionSha256: sha256Canonical(makeResolution()),
        resolvedAt: '2026-09-01T09:10:00.000Z'
      }
    }),
    projectionCapsule: makeSchemaValidProjectionCapsule({
      expectedJobVersion: waiting.version + 1,
      confirmationBinding: {
        jobId: waiting.id,
        bindingId: 'intake-binding-1',
        bindingVersion: 1,
        resolution: makeResolution(),
        resolutionSha256: sha256Canonical(makeResolution()),
        resolvedAt: '2026-09-01T09:10:00.000Z'
      }
    })
  });
  expect(resolved.job.state).toBe('ready');
  expect(resolved.job.classification?.authorizationMode).toBe('user_confirmed');
  expect(resolved.job.version).toBe(waiting.version + 1);
  expect(resolved.binding.state).toBe('active');
  expect(resolved.plan.intent.expectedJobVersion).toBe(resolved.job.version);
  expect(resolved.plan.planSha256).toBe(makeSchemaValidWritePlan({
    id: 'intake-plan-1',
    expectedJobVersion: waiting.version + 1,
    confirmationBinding: {
      jobId: waiting.id,
      bindingId: 'intake-binding-1',
      bindingVersion: 1,
      resolutionSha256: sha256Canonical(makeResolution()),
      resolvedAt: '2026-09-01T09:10:00.000Z'
    }
  }).planSha256);
});
```

Also assert stale versions throw `INTAKE_VERSION_CONFLICT`, terminal tasks are immutable, a changed snapshot supersedes rather than mutates an active task, and only one nonterminal job exists per `package_key`. Round-trip the complete discriminated `packageVersion`, including `DirectoryTreeVersion.rootIdentity` and directory entries that contain no files; reject a stored `snapshotSha256` that differs from `intakeSnapshotSha256(packageVersion)`. That function returns the already validated `DirectoryTreeVersion.treeSha256` for a directory and hashes the complete canonical `FileVersion` (path, exists, raw SHA, length and optional modified time) for a single file. Round-trip `rule_bundle_sha256` and reject any create/resolve transition whose supplied/current fingerprint is not 64 lowercase hex or differs from the job's bound fingerprint.

`resolveAndBindPlan` runs in one immediate transaction: it verifies the current job/version and server-derived `user_confirmed` classification, requires `projectedReadyVersion === expectedVersion + 1`, canonicalizes the complete server-validated resolution into `resolutionSha256`, inserts the immutable `write_plans` row, inserts a new immutable binding row, and advances the job to `ready` at exactly that projected version. The plan intent, capsule job and returned apply expectation must all use this post-transition ready version; using the pre-transition `needs_confirmation` version is invalid. No resolution, plan, capsule binding or ready state may be observable alone. `resolvedAt` records only when metadata ambiguity was resolved and is never native write authority or confirmation evidence. Exact request replay—including after response loss, process restart or native-dialog cancel—returns the same active plan/capsule/binding without regenerating IDs, timestamps or hashes; an explicit confirmed-plan cancel is a different lifecycle operation and makes that preview non-reusable.

Bindings are append-only and versioned per job. A job has at most one `active` binding. `cancelUnpreparedConfirmedPlan` may change only that exact active row to `cancelled`, with exact job version, binding ID/version, plan hash and capsule hash, while no linked batch has reached `prepared` and the recovery scanner proves no manifest, journal, staged inode or helper effect exists. A merely `planned` linked batch is terminalized together with the binding transition in the same immediate database transaction. The method then stores a fresh server-derived `needs_confirmation` classification; it never deletes the plan or binding. `supersedeUnpreparedConfirmedPlan` performs that terminalization/cancellation plus insertion of the next immutable plan/capsule row and the next ready job version in the same transaction, with no observable interval lacking the replacement; the replacement intent, capsule job and binding `expected_job_version` all use that new ready version. Exact cancel replay returns the same cancelled result, and exact supersede replay returns the same replacement binding; mismatched replay conflicts and neither appends another version. Both methods run beneath the same process-wide `WorkflowMutationMutex` used by confirmation and coordinator execution so batch creation or manifest preparation cannot race the proof. A different resolution, plan or capsule under the same binding version conflicts. An active preview lost with SQLite before manifest/journal/staging/helper evidence is not recoverable authority: reconciliation invalidates it and may create a freshly derived job/binding, while the lost preview ID remains unusable. Once the linked batch reaches `prepared` or the scanner sees such recovery evidence, cancellation/supersession is forbidden. The post-manifest checkpoint advances the exact job to `applying` but keeps its binding `active` solely so the ordinary coordinator's later `assertCurrent()` checks can corroborate the same authority; that prepared/evidence boundary makes the row non-cancellable and non-supersedable. The verified finalizer atomically changes it to `consumed`, which can never return to `active`. If any post-manifest forward path stops without verified completion, the coordinator invokes the intent finalizer's idempotent recovery-entry hook only after all ordinary helper/current checks have ended and before exposing recovery actions. Under the still-held shared mutex, it atomically changes the exact manifest/capsule/plan-backed binding to `consumed` and the job from its permitted `ready`/`applying` successor to `recovery_required`; a live recovery is therefore usable without a restart. RecoveryService uses its own bounded acquisition to replay the hook and derive an action, releases the non-reentrant mutex before calling the coordinator, and exposes none until the exact historical consumed tuple is present. `WriteCoordinator.executeRecovery()` then acquires the mutex itself and repeats the hook, authoritative scan, snapshot/action/plan and binding checks before effects, so a change between acquisitions fails rather than racing or deadlocking. A crash after manifest promotion, including before the SQLite checkpoint, recovery-entry hook or finalizer, is repaired from the manifest/capsule and marks the binding consumed before ordinary routes reopen.

Insert/replay finalization rows for `forward`, `continue`, `rollback` and `resolve`. A live `forward` finalization atomically records completion and changes the matching active binding to `consumed`; its exact replay accepts only that already-consumed terminal tuple. `enterConfirmedIntakeRecovery` is not a successful finalization: it requires the validated original batch/manifest plus the exact job, binding ID/version, plan hash and capsule hash, CASes only that active row and its permitted post-manifest job successor, and idempotently accepts only the matching `recovery_required`/consumed result. Recovery `continue`, `rollback` and `resolve` all require this manifest-backed historical binding already consumed before authorization or helper access. Rollback restores `ready` with the original `authorizationMode`, leaves the original binding consumed, and permits only a newly appended next-version `user_confirmed` binding after the user asks to retry; it never reactivates or overwrites the old row. Resolve must idempotently leave the job `needs_confirmation` with `MANUAL_RECOVERY_CONFLICT`, never `completed` or silently convert `user_confirmed` to `automatic`.

The Task 1 repository fixture uses Phase 1's schema-valid generic plan/capsule builders to test transaction mechanics; Task 5 supplies and validates the intake-specific intent and capsule schema before this repository method is reachable from a service.

- [ ] **Step 2: Run the repository test and verify RED**

Run:

```bash
npm run test:integration -- intake-repository
```

Expected: the suite loads and fails because migration 004 and the repository do not exist. Module resolution errors do not count as the intended RED; create empty modules only if required to reach the first behavioral assertion.

- [ ] **Step 3: Define the shared intake domain**

Create `src/shared/domain/intake.ts` with these exact public types:

```ts
import type { DirectoryTreeVersion, FileVersion } from './write';

export type IntakeState =
  | 'detected'
  | 'waiting_for_stability'
  | 'classifying'
  | 'ready'
  | 'needs_confirmation'
  | 'applying'
  | 'completed'
  | 'conflict'
  | 'recovery_required';

export type IntakePackageVersion = FileVersion | DirectoryTreeVersion;

export type IntakeResolution = {
  packageKind: 'single_file' | 'directory';
  mainMarkdownPath: string;
  sourcePlatform: string;
  collectedAt: string;
  shortTitle: string;
};

export type IntakeConfirmationBindingState = 'active' | 'cancelled' | 'consumed';
export type IntakeConfirmationCancellationReason =
  | 'user_cancelled'
  | 'superseded'
  | 'rule_stale'
  | 'package_stale';

export type IntakeClassification = IntakeResolution & {
  platformDirectory: string;
  targetMonthDirectory: string;
  targetPackageDirectory: string;
  normalizedPackageName: string;
  normalizedMainMarkdownName: string;
  monthDirectoryExists: boolean;
} & (
  | {
      confidence: 'high';
      authorizationMode: 'automatic';
      reason?: never;
    }
  | {
      confidence: 'high';
      authorizationMode: 'user_confirmed';
      reason?: never;
    }
  | {
      confidence: 'needs_confirmation';
      authorizationMode?: never;
      reason:
        | 'PACKAGE_SHAPE_AMBIGUOUS'
        | 'ROOT_ATTACHMENT_UNASSIGNED'
        | 'MAIN_MARKDOWN_AMBIGUOUS'
        | 'SOURCE_PLATFORM_AMBIGUOUS'
        | 'TITLE_AMBIGUOUS'
        | 'PLATFORM_DIRECTORY_MISSING_OR_UNSAFE'
        | 'MONTH_DIRECTORY_UNSAFE'
        | 'TARGET_CONFLICT'
        | 'MANUAL_RECOVERY_CONFLICT';
    }
);

export type IntakeJob = {
  id: string;
  packageKey: string;
  snapshotSha256: string;
  ruleBundleSha256: string;
  packageVersion: IntakePackageVersion;
  state: IntakeState;
  classification?: IntakeClassification;
  version: number;
  operationId: string;
  createdAt: string;
  updatedAt: string;
};
```

`normalizedPackageName` is exactly `YYYYMMDD｜来源平台｜短标题`; `normalizedMainMarkdownName` is that same string plus `.md`. `shortTitle` is readable, contains no cross-platform forbidden path characters and is at most 20 Chinese characters; if deterministic truncation would lose the distinguishing meaning, classification returns `TITLE_AMBIGUOUS` for user confirmation instead of inventing a title.

- [ ] **Step 4: Add migration 004 and register it after the write kernel**

Create `004_intake_workflow.sql`:

```sql
CREATE TABLE intake_jobs (
  id TEXT PRIMARY KEY,
  package_key TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
  rule_bundle_sha256 TEXT NOT NULL CHECK (length(rule_bundle_sha256) = 64),
  package_version_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'detected', 'waiting_for_stability', 'classifying', 'ready',
    'needs_confirmation', 'applying', 'completed', 'conflict', 'recovery_required'
  )),
  classification_json TEXT,
  reason_code TEXT,
  operation_id TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX one_active_intake_job_per_package
ON intake_jobs(package_key)
WHERE state NOT IN ('completed', 'conflict');

CREATE TABLE intake_resolutions (
  binding_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES intake_jobs(id) ON DELETE CASCADE,
  binding_version INTEGER NOT NULL CHECK (binding_version >= 1),
  expected_job_version INTEGER NOT NULL CHECK (expected_job_version >= 1),
  resolution_json TEXT NOT NULL,
  resolution_sha256 TEXT NOT NULL CHECK (length(resolution_sha256) = 64),
  plan_id TEXT NOT NULL UNIQUE REFERENCES write_plans(id),
  plan_sha256 TEXT NOT NULL CHECK (length(plan_sha256) = 64),
  projection_capsule_json TEXT NOT NULL,
  projection_capsule_sha256 TEXT NOT NULL CHECK (length(projection_capsule_sha256) = 64),
  state TEXT NOT NULL CHECK (state IN ('active', 'cancelled', 'consumed')),
  cancel_reason TEXT CHECK (
    cancel_reason IS NULL OR cancel_reason IN (
      'user_cancelled', 'superseded', 'rule_stale', 'package_stale'
    )
  ),
  resolved_at TEXT NOT NULL,
  state_updated_at TEXT NOT NULL,
  UNIQUE(job_id, binding_version),
  CHECK (
    (state = 'cancelled' AND cancel_reason IS NOT NULL)
    OR (state IN ('active', 'consumed') AND cancel_reason IS NULL)
  )
);

CREATE UNIQUE INDEX one_active_intake_binding_per_job
ON intake_resolutions(job_id)
WHERE state = 'active';

CREATE TABLE intake_finalizations (
  batch_id TEXT PRIMARY KEY REFERENCES write_batches(id),
  original_batch_id TEXT NOT NULL REFERENCES write_batches(id),
  job_id TEXT NOT NULL REFERENCES intake_jobs(id),
  direction TEXT NOT NULL CHECK (direction IN ('forward', 'continue', 'rollback', 'resolve')),
  plan_sha256 TEXT NOT NULL CHECK (length(plan_sha256) = 64),
  projection_capsule_sha256 TEXT NOT NULL CHECK (length(projection_capsule_sha256) = 64),
  finalized_at TEXT NOT NULL
);
```

Extend `initialMigrations()` in `src/server/db/migrate.ts`:

```ts
return [
  { version: 1, sql: readFileSync(bundledMigrationPath('001_initial.sql'), 'utf8') },
  { version: 2, sql: readFileSync(bundledMigrationPath('002_read_api_jobs.sql'), 'utf8') },
  { version: 3, sql: readFileSync(bundledMigrationPath('003_write_kernel.sql'), 'utf8') },
  { version: 4, sql: readFileSync(bundledMigrationPath('004_intake_workflow.sql'), 'utf8') }
];
```

Add `004_intake_workflow.sql` to the exact asset list in `scripts/copy-server-assets.ts` without removing `003_write_kernel.sql`.

- [ ] **Step 5: Implement repository transitions**

Expose this interface from `intake-repository.ts`:

```ts
export interface IntakeRepository {
  createOrGetDetected(input: DetectedPackage): IntakeJob;
  markWaiting(id: string, expectedVersion: number): IntakeJob;
  markClassifying(id: string, expectedVersion: number): IntakeJob;
  markReady(id: string, expectedVersion: number, result: IntakeClassification): IntakeJob;
  markNeedsConfirmation(id: string, expectedVersion: number, input: IntakeProblem): IntakeJob;
  resolveAndBindPlan(input: ResolveAndBindIntakePlan): BoundConfirmedIntakePlan;
  getActiveBoundConfirmedPlan(jobId: string): BoundConfirmedIntakePlan | undefined;
  getBoundConfirmedPlan(bindingId: string): BoundConfirmedIntakePlan | undefined;
  cancelUnpreparedConfirmedPlan(input: CancelConfirmedIntakePlan): BoundConfirmedIntakePlan;
  supersedeUnpreparedConfirmedPlan(input: SupersedeConfirmedIntakePlan): BoundConfirmedIntakePlan;
  markConfirmedExecutionApplying(input: StartConfirmedIntakeExecution): BoundConfirmedIntakePlan;
  enterConfirmedIntakeRecovery(input: EnterConfirmedIntakeRecovery): BoundConfirmedIntakePlan;
  markApplying(id: string, expectedVersion: number): IntakeJob;
  markCompleted(id: string, expectedVersion: number): IntakeJob;
  markConflict(id: string, expectedVersion: number, code: string): IntakeJob;
  requireRecovery(id: string, expectedVersion: number, code: string): IntakeJob;
  recordFinalization(input: IntakeFinalization): void;
  hasFinalization(batchId: string): boolean;
  get(id: string): IntakeJob | undefined;
  list(states?: readonly IntakeState[]): IntakeJob[];
}
```

Implement every job transition with `UPDATE ... WHERE id = ? AND version = ? AND state IN (...)`; require `changes === 1`, increment `version`, and reread the authoritative row in the same immediate transaction. Binding transitions use exact `binding_id + job_id + binding_version + state + plan_sha256 + projection_capsule_sha256` CAS predicates. `supersedeUnpreparedConfirmedPlan` assigns `bindingVersion = previous.bindingVersion + 1`, inserts rather than overwrites the replacement row, and relies on the partial unique index to forbid two active bindings. Test the fixed cancellation reasons `user_cancelled | superseded | rule_stale | package_stale`, reject open strings, and require the reason to be non-null only for `cancelled`. `markConfirmedExecutionApplying` accepts only the coordinator-owned post-manifest checkpoint and, in the same immediate transaction, CASes the bound job from `ready` at `expected_job_version` to `applying` at the next version while requiring and preserving the exact matching `active` binding; replay accepts only that already-applying/active tuple. A route, renderer or model cannot call it. `enterConfirmedIntakeRecovery` is likewise server-internal and requires the exact validated original batch ID, immutable manifest hash, job/binding/plan/capsule tuple. In one immediate transaction it accepts only the plan's `ready` version when the post-manifest hook failed before its transition, that exact deterministic `applying` successor, or the matching already-flagged `recovery_required` successor; it CASes the active binding to `consumed`, stores `recovery_required`, and exact replay accepts only the same consumed tuple. It rejects pre-manifest/planned batches, another version/binding, or absent/divergent manifest evidence. For a live user-confirmed forward path, `recordFinalization` uses one immediate transaction to CAS that same binding from `active` to `consumed`, advance the job from `applying` to `completed`, and insert the idempotent finalization row; replay accepts only the exact already-completed/already-consumed tuple. The automatic branch uses `markApplying` at the equivalent manifest checkpoint. Serialize JSON with the existing `canonicalJson` helper.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
npm run test:integration -- intake-repository
npm run typecheck
```

Expected: migration application, uniqueness, legal transitions, version conflicts and JSON round-trip tests pass.

Commit:

```bash
git add src/server/db/migrations/004_intake_workflow.sql src/shared/domain/intake.ts src/server/db/repositories/intake-repository.ts src/server/db/migrate.ts scripts/copy-server-assets.ts tests/integration/intake-repository.test.ts
git commit -m "feat: persist automatic intake jobs"
```

### Task 2: Patch approved source frontmatter fields without changing other bytes

**Files:**

- Create: `src/server/rules/source-frontmatter-patch.ts`
- Modify: `src/server/rules/frontmatter.ts`
- Create: `tests/fixtures/intake/frontmatter-golden/unknown-fields-comments-crlf.md`
- Create: `tests/fixtures/intake/frontmatter-golden/bom-no-final-newline.md`
- Create: `tests/fixtures/intake/frontmatter-golden/missing-required-keys.md`
- Create: `tests/fixtures/intake/frontmatter-golden/no-frontmatter.md`
- Test: `tests/unit/source-frontmatter-patch.test.ts`

- [ ] **Step 1: Add golden byte fixtures and a failing preservation test**

The CRLF fixture must contain comments, an unknown field and a body image link. The BOM fixture begins with `EF BB BF` and has no final newline. Test exact byte preservation outside approved values:

```ts
const result = patchSourceFrontmatter(inputBytes, {
  processingStatus: '已归档',
  sourcePlatform: '公众号',
  collectedAt: '2026-09-01',
  knowledgeStatus: '未提炼'
});

expect(parseLibraryNote(result.bytes, '01图书馆/来自公众号/2026-09/example.md').issues).toEqual([]);
expect(result.changedKeys).toEqual(['处理状态', '来源平台', '采集日期', '知识入库状态']);
for (const range of result.untouchedRanges) {
  expect(result.bytes.slice(range.afterStart, range.afterEnd))
    .toEqual(inputBytes.slice(range.beforeStart, range.beforeEnd));
}
expect(new TextDecoder().decode(parseFrontmatter(result.bytes).bodyBytes))
  .toBe(new TextDecoder().decode(parseFrontmatter(inputBytes).bodyBytes));
```

Add cases for YAML values containing `:` and `#`, list fields, duplicate keys, aliases, folded scalars on target keys and already-correct fields. A valid existing frontmatter that lacks required library keys must receive deterministic missing-key lines immediately before its closing delimiter without reserializing existing YAML. A Markdown file with no frontmatter must receive a complete service-controlled library template before its original body. Ambiguous or syntactically invalid existing YAML must return `FRONTMATTER_PATCH_UNSAFE` without bytes.

- [ ] **Step 2: Run the patcher test and verify RED**

Run:

```bash
npm run test:unit -- source-frontmatter-patch
```

Expected: the test fails because the byte-range patcher does not exist.

- [ ] **Step 3: Implement the byte-range patch contract**

Export this exact API:

```ts
export type SourceFrontmatterPatch = {
  processingStatus?: '未归档' | '已归档';
  sourcePlatform?: string;
  originalTitle?: string;
  author?: string;
  originalUrl?: string;
  collectedAt?: string;
  topics?: readonly string[];
  keywords?: readonly string[];
  knowledgeStatus?: '未提炼' | '部分入库' | '已入库';
  generatedKnowledge?: readonly string[];
  note?: string;
};

export type PatchedSource = {
  bytes: Uint8Array;
  changedKeys: string[];
  untouchedRanges: Array<{
    beforeStart: number;
    beforeEnd: number;
    afterStart: number;
    afterEnd: number;
  }>;
};

export function patchSourceFrontmatter(
  source: Uint8Array,
  patch: SourceFrontmatterPatch
): PatchedSource;
```

Export the existing frontmatter delimiter offsets from `frontmatter.ts`. For valid existing YAML, scan scalar/list node source ranges with `yaml` CST ranges, convert UTF-16 string offsets to UTF-8 byte offsets, replace only approved existing values, and insert absent required keys in current library-schema order immediately before the closing delimiter. Apply replacements from the highest byte offset downward; never reserialize the existing YAML slice.

For a file with no opening frontmatter delimiter, prepend this service-controlled template using classified values, then append the original Markdown body bytes unchanged:

```yaml
---
类型: 原始资料
处理状态: 已归档
来源平台: 公众号
原始标题: ""
作者: ""
原始链接: ""
采集日期: 2026-09-01
所属主题: []
关键词: []
知识入库状态: 未提炼
生成知识: []
备注: ""
---
```

Preserve a leading BOM at document start and append all following original body bytes exactly. Preserve delimiter bytes, comments, key order, newline convention and unknown fields for existing YAML. Reject aliases, duplicate keys, invalid existing YAML and target nodes whose exact byte range cannot be established.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
npm run test:unit -- source-frontmatter-patch frontmatter-rules
npm run typecheck
```

Expected: every golden fixture proves non-target/body bytes are identical, missing keys are inserted without rewriting existing YAML, no-frontmatter input gains a complete template, and every successful result passes `parseLibraryNote`.

Commit:

```bash
git add src/server/rules/source-frontmatter-patch.ts src/server/rules/frontmatter.ts tests/fixtures/intake/frontmatter-golden/unknown-fields-comments-crlf.md tests/fixtures/intake/frontmatter-golden/bom-no-final-newline.md tests/fixtures/intake/frontmatter-golden/missing-required-keys.md tests/fixtures/intake/frontmatter-golden/no-frontmatter.md tests/unit/source-frontmatter-patch.test.ts
git commit -m "feat: patch source metadata without rewriting bytes"
```

### Task 3: Detect stable packages and classify destinations

**Files:**

- Create: `src/server/intake/package-stability.ts`
- Create: `src/server/intake/clipper-metadata-extractor.ts`
- Create: `src/server/intake/package-classifier.ts`
- Create: `tests/fixtures/intake/clipper-single.md`
- Create: `tests/fixtures/intake/clipper-package/source.md`
- Create: `tests/fixtures/intake/clipper-package/cover.png`
- Test: `tests/unit/intake-package-stability.test.ts`
- Test: `tests/unit/clipper-metadata-extractor.test.ts`
- Test: `tests/unit/intake-package-classifier.test.ts`

- [ ] **Step 1: Write failing stability tests**

Use an injected clock and assert the package is stable only after two equal, existing `FileVersion | DirectoryTreeVersion` values separated by the configured quiet period. “Existing” does not mean a directory must contain a file: an empty root or an empty nested directory is still represented by `DirectoryTreeVersion` and must participate in stability.

```ts
const tracker = new PackageStabilityTracker({ quietPeriodMs: 1_500 });
expect(tracker.observe('pkg', firstSnapshot, 0).state).toBe('waiting');
expect(tracker.observe('pkg', firstSnapshot, 1_499).state).toBe('waiting');
expect(tracker.observe('pkg', firstSnapshot, 1_500)).toEqual({
  state: 'stable',
  snapshotSha256: expectedSnapshotSha256
});
expect(tracker.observe('pkg', changedSnapshot, 1_600).state).toBe('waiting');
```

For directory packages, obtain the values through Phase 1's descriptor-anchored `FileSystemVaultGateway.observeTree()` and prove empty-directory topology and the package-root inode reset the quiet window:

```ts
const first = await gateway.observeTree(packagePath);
expect(tracker.observe('pkg', first, 0).state).toBe('waiting');

await mkdir(join(packageAbsolutePath, 'empty-a'));
const emptyAdded = await gateway.observeTree(packagePath);
expect(emptyAdded.entries).toContainEqual({ type: 'directory', relativePath: 'empty-a' });
expect(tracker.observe('pkg', emptyAdded, 1_500).state).toBe('waiting');

await rename(
  join(packageAbsolutePath, 'empty-a'),
  join(packageAbsolutePath, 'empty-b')
);
const emptyRenamed = await gateway.observeTree(packagePath);
expect(tracker.observe('pkg', emptyRenamed, 3_000).state).toBe('waiting');

await rmdir(join(packageAbsolutePath, 'empty-b'));
const emptyRemoved = await gateway.observeTree(packagePath);
expect(tracker.observe('pkg', emptyRemoved, 4_500).state).toBe('waiting');

const originalRoot = `${packageAbsolutePath}.old`;
await rename(packageAbsolutePath, originalRoot);
const sourceStat = await stat(join(originalRoot, 'source.md'));
await mkdir(packageAbsolutePath);
await copyFile(
  join(originalRoot, 'source.md'),
  join(packageAbsolutePath, 'source.md')
);
await utimes(
  join(packageAbsolutePath, 'source.md'),
  sourceStat.atime,
  sourceStat.mtime
);
const replacedRoot = await gateway.observeTree(packagePath);
expect(replacedRoot.entries).toEqual(emptyRemoved.entries);
expect(replacedRoot.rootIdentity).not.toEqual(emptyRemoved.rootIdentity);
expect(tracker.observe('pkg', replacedRoot, 6_000).state).toBe('waiting');
```

Assert a repeated unchanged version becomes stable only after another full quiet period. For `FileVersion`, path, raw SHA-256, byte length and modified time all participate in the canonical snapshot comparison; for `DirectoryTreeVersion`, compare the already validated `rootIdentity`, complete sorted discriminated entries (including empty directories), and `treeSha256`. Event count and event order do not participate. Reject malformed directory versions rather than projecting them back into an intake-only file list.

- [ ] **Step 2: Write failing classifier tests from both plugin delivery shapes**

Provide complete library YAML, incomplete plugin frontmatter, and no-frontmatter variants with one trustworthy title/source URL/date. The tolerant extractor returns candidates rather than formal status fields. Model the clipper root deterministically:

- one direct non-symlink subdirectory is a `directory` package; one Markdown is immediately the main document, while multiple Markdown files use the current `02_图书馆入馆规则.md` priority and attachments remain inside that directory;
- exactly one direct `.md` and no other clipper-root entry is a `single_file` package when it has no unresolved local attachment reference;
- multiple direct Markdown files, any root-level scattered attachment, symlink/special entry, a tie after applying the directory-package main-document priority, or a local attachment reference that cannot be assigned to the same package returns `needs_confirmation` without moving bytes.

Assert the directory package classification normalizes both names:

```ts
expect(classifier.classify(stablePackage)).toEqual({
  packageKind: 'directory',
  mainMarkdownPath: '01图书馆/小兆clipper/article-1/source.md',
  sourcePlatform: '公众号',
  collectedAt: '2026-09-01',
  shortTitle: '示例文章',
  platformDirectory: '01图书馆/来自公众号',
  targetMonthDirectory: '01图书馆/来自公众号/2026-09',
  targetPackageDirectory: '01图书馆/来自公众号/2026-09/20260901｜公众号｜示例文章',
  normalizedPackageName: '20260901｜公众号｜示例文章',
  normalizedMainMarkdownName: '20260901｜公众号｜示例文章.md',
  monthDirectoryExists: false,
  confidence: 'high',
  authorizationMode: 'automatic'
});
```

Assert `clipper-single.md` produces the same normalized destination with `packageKind: 'single_file'`. For a directory containing multiple Markdown files, normalize candidate basenames with Unicode NFC and case-folding, then choose the unique first nonempty tier in this exact order: basename matching the trustworthy extracted title or current package title, `index`, `README`, `原文`, `正文`. If a tier contains more than one portable-name-equivalent candidate, or no tier identifies one file, return `MAIN_MARKDOWN_AMBIGUOUS`. Incomplete/no-frontmatter inputs classify when exactly one trustworthy URL/title/date candidate exists. Multiple competing URLs, an unrecognized source host, missing/invalid dates, unsafe title and an occupied target produce the corresponding `needs_confirmation` result and never invent a platform, suffix or attachment ownership.

Before any frontmatter patch or write plan is created, add target-name collision cases for both delivery shapes. If the normalized package path already exists, if another entry in a directory package already occupies `normalizedMainMarkdownName`, or if any sibling/target entry collides under Unicode NFC plus case-folded portable comparison, classification returns `needs_confirmation` with `TARGET_CONFLICT`. Assert every source and attachment hash remains unchanged; a collision is never deferred until `move-exclusive` or recovery and is never evaded with a numeric suffix.

Add filesystem-boundary cases: the selected platform root must already exist as a real non-symlink directory; a missing month is valid and sets `monthDirectoryExists: false`; an existing month must be a real non-symlink directory; a missing/symlink platform root or symlink month produces the exact unsafe reason. No classifier test creates directories. Every classifier-produced high-confidence result has `authorizationMode:'automatic'`; this field is server-owned and never accepted from a renderer or model. A resolvable user submission is revalidated by the server into a complete `confidence:'high'`, reason-free classification with `authorizationMode:'user_confirmed'`; it is never relabelled automatic. Lock the V1 fail-safe boundary: `ROOT_ATTACHMENT_UNASSIGNED` and root-level `PACKAGE_SHAPE_AMBIGUOUS` are diagnostic, non-resolvable jobs. They expose no confirmation candidate/member-set and can never become `ready`; the supported correction is a newly stable plugin delivery with Markdown plus assets inside one direct subdirectory. Tests prove neither the lone Markdown nor any loose sibling moves, and an unrelated root file can never be absorbed into a package.

- [ ] **Step 3: Run tests and verify RED**

Run:

```bash
npm run test:unit -- intake-package-stability clipper-metadata-extractor intake-package-classifier
```

Expected: suites load and fail at stability and classification assertions.

- [ ] **Step 4: Implement deterministic stability and classification**

`PackageStabilityTracker` must expose:

```ts
export class PackageStabilityTracker {
  constructor(input: { quietPeriodMs: number });
  observe(packageKey: string, packageVersion: IntakePackageVersion, observedAtMs: number):
    | { state: 'waiting' }
    | { state: 'stable'; snapshotSha256: string };
  forget(packageKey: string): void;
}

export function intakeSnapshotSha256(version: IntakePackageVersion): string {
  return 'treeSha256' in version
    ? version.treeSha256
    : sha256(canonicalJson(version));
}
```

`PackageStabilityTracker` parses with the shared Phase 1 runtime schemas, derives `snapshotSha256` through the exact `intakeSnapshotSha256(packageVersion)` rule above, and stores the complete immutable discriminated version for equality; it never flattens `DirectoryTreeVersion.entries` to files. `extractClipperMetadata(bytes)` tolerates complete, incomplete and absent frontmatter; it returns bounded title/URL/date candidates with evidence locations and never emits `处理状态` or `知识入库状态`. `PackageClassifier` receives the stable package shape and exact package version, reads candidate Markdown through `FileSystemVaultGateway`, uses that tolerant extractor, maps only recognized URL hosts to current `SOURCE_PLATFORMS`, derives `YYYY-MM` from the trusted date, and constructs the exact `YYYYMMDD｜平台｜短标题` names. For multiple Markdown files inside one directory package it implements the exact unique-tier order from Step 2; it does not treat every multi-Markdown package as ambiguous. It checks the pre-existing platform root and an existing month without following symlinks, but treats an absent month as a valid plan input. Before patching, it requires the target package path and the normalized main-document destination to be absent under exact and NFC/case-folded sibling comparison. It returns `needs_confirmation` rather than choosing among shape, Markdown, link, title or target ties. Classifier-owned complete results always set `authorizationMode:'automatic'`; the separate server-side resolution path validates the allowed candidate/metadata choices and emits `authorizationMode:'user_confirmed'`. Only after `source-frontmatter-patch` has produced bytes may `IntakePlanner` use `parseLibraryNote` as the formal acceptance check.

Recovery-entry clarification: extend `WriteIntentFinalizerHandler` with optional, idempotent `enterRecoveryRequired({ originalIntent, originalPlan, originalBatchId, projectionCapsule, manifestSha256 })`. After any post-manifest ambiguity, the generic coordinator first stops all ordinary `assertCurrent()` and helper work, marks the core batch recovery-required, then invokes this hook under its still-held `WorkflowMutationMutex` before returning. `IntakeFinalizer.enterRecoveryRequired()` calls `enterConfirmedIntakeRecovery` with the exact validated manifest-backed tuple. RecoveryService replays the same hook in a bounded shared-mutex segment before computing `allowedActions`, then releases the non-reentrant lock before delegating execution; `WriteCoordinator.executeRecovery()` acquires it and repeats hook plus authoritative scan/snapshot/action checks before effects. It exposes no recovery action until the original user-confirmed binding is historical `consumed`. Existing finalizers may omit the hook. This is distinct from `onManifestPersisted`: the active binding is used only by the ordinary forward coordinator through its last current check, never by a recovery plan. Hook failure reports no success and remains retryable through this gate or startup reconstruction. Test exact ordering, live idempotent entry, hook failure before `applying`, failure after `applying`, mutation between service/coordinator acquisitions, no nested-lock deadlock, and no invocation for a merely `planned` batch.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
npm run test:unit -- intake-package-stability clipper-metadata-extractor intake-package-classifier
npm run typecheck
```

Expected: stable/unstable snapshots and every confidence branch pass deterministically.

Commit:

```bash
git add src/server/intake/package-stability.ts src/server/intake/clipper-metadata-extractor.ts src/server/intake/package-classifier.ts tests/fixtures/intake/clipper-single.md tests/fixtures/intake/clipper-package/source.md tests/fixtures/intake/clipper-package/cover.png tests/unit/intake-package-stability.test.ts tests/unit/clipper-metadata-extractor.test.ts tests/unit/intake-package-classifier.test.ts
git commit -m "feat: classify stable clipper packages"
```

### Task 4: Reconcile startup, focus and watcher signals

**Files:**

- Create: `src/server/intake/intake-watcher.ts`
- Create: `src/server/intake/intake-reconciler.ts`
- Modify: `src/server/start-server.ts`
- Modify: `src/server/index.ts`
- Modify: `src/electron/main.ts`
- Test: `tests/integration/intake-reconciler.test.ts`
- Test: `tests/unit/electron-focus-reconcile.test.ts`

- [ ] **Step 1: Write failing reconciliation tests**

Build a sentinel-protected `mkdtemp` vault and assert:

```ts
await reconciler.reconcile('startup');
clock.advanceBy(1_500);
await reconciler.reconcile('timer');
expect(repository.list(['ready'])).toHaveLength(1);

watcher.emit({ kind: 'changed', path: '01图书馆/小兆clipper/article-1/cover.png' });
await reconciler.flushSignals();
expect(repository.list().filter((job) => job.packageKey.endsWith('article-1'))).toHaveLength(1);
```

Also assert a missed watcher event is recovered by startup reconciliation, a focus reconciliation detects files created while the App was closed, a file that keeps changing never classifies, abort stops traversal, and paths outside `01图书馆/小兆clipper` are ignored. Persist an approved rule fingerprint, stop the runtime, change one bundle file, and restart: reconciliation may report the current fingerprint and detected paths for diagnostics, but must not transition a job to auto-applying or call the coordinator; health/intake state reports `RULE_BUNDLE_UNAPPROVED` until a separate compatibility approval is persisted.

Mock Electron lifecycle ownership and assert focus calls only the runtime port:

```ts
windowEmitter.emit('focus');
expect(started.requestFocusReconcile).toHaveBeenCalledTimes(1);
expect(electronImports).not.toContain('intake-repository');
expect(electronImports).not.toContain('FileSystemVaultGateway');
```

Add reconciliation fixtures for both supported delivery shapes. A direct `clipper-single.md` is tracked by its exact Phase 1 `FileVersion` only when it is the sole clipper-root entry; a direct subdirectory is tracked by its exact Phase 1 `DirectoryTreeVersion`, including `rootIdentity` and empty-directory entries. Add, remove, and rename an empty nested directory between observations and replace the package root with a new inode containing byte-identical, timestamp-preserved entries; each case resets the quiet window and supersedes the prior job snapshot instead of classifying stale bytes. Two root Markdown files, a root Markdown plus loose image, a root symlink and a directory package with two unresolved main Markdown candidates each create `needs_confirmation` records and are never silently combined or moved.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npm run test:integration -- intake-reconciler
npm run test:unit -- electron-focus-reconcile
```

Expected: failures show that startup/focus/watcher signals are not wired.

- [ ] **Step 3: Implement watcher and reconciler ports**

Define the watcher boundary:

```ts
export interface IntakeWatcher {
  start(onSignal: (signal: IntakeFileSignal) => void): Promise<void>;
  close(): Promise<void>;
}

export type IntakeFileSignal = {
  kind: 'added' | 'changed' | 'removed' | 'renamed';
  path: string;
};
```

`IntakeReconciler.reconcile(reason, signal)` must first load the Phase 0 five-file rule bundle, query the injected `RuleCompatibilityGate`, and bind the current fingerprint to every detected/classified diagnostic, then list the clipper directory from disk without following symlinks. It treats each direct real subdirectory as a recursive directory-package candidate and recognizes a root-level single-file package only for the exact unambiguous shape defined in Task 3; ambiguous root entries are persisted for confirmation rather than discarded. It obtains `FileVersion` with the shared file observer and `DirectoryTreeVersion` only with Phase 1's descriptor-anchored `observeTree()`, passes that exact value to the stability tracker, and persists it without an intake-specific projection. It creates or updates jobs and classifies only stable versions. Only a `ready` job whose strict classification has `confidence:'high'`, no reason and `authorizationMode:'automatic'` may call automatic `IntakeService.applyAutomatic`; a `user_confirmed` job remains bound to its immutable preview until the explicit apply route receives App-native authority. If the bundle changes during reconciliation, discard the computed classification and rerun; never persist a result from mixed rule versions. When the gate is unapproved it may update diagnostic/detected state but cannot call either apply path, create a write plan or silently write the new fingerprint into the approved slot. Watcher callbacks enqueue one debounced reconciliation; they never mutate repository or vault directly.

- [ ] **Step 4: Wire lifecycle ownership**

In `start-server.ts`, start the reconciler after the first successful read index, expose `requestFocusReconcile()` to Electron, and close the watcher before the index scheduler, Fastify and SQLite. Resolve the Phase 0 ownership mismatch at the same seam by modifying the actual `EmbeddedServerConfig`/`startServer()` input—not the already gateway-free `DesktopServerConfig`: remove the injected `gateway`, retain the required `NativeReadVaultPortFactory` as a narrow dependency, add the already protocol-checked `openExternal(url)` callback beside `vaultRealRoot`, and construct `FileSystemVaultGateway.create({ vaultRoot: vaultRealRoot, nativeReader, openExternal })` inside `startServer`. Update `DesktopServerConfig` as the credential-free projection of that input; it contains the verified native-reader factory and narrow opener but no gateway, Obsidian URL or key. Update the independent `src/server/index.ts` CLI adapter to stop constructing `LocalRest51Gateway`, call this same direct-filesystem input with its explicit native-reader factory and a headless opener that rejects external opening, and retain only its signal/config ownership. In `src/electron/main.ts`, remove the `FileSystemVaultGateway` import; pass the verified native-reader factory plus narrow opener callback, and have BrowserWindow focus and app activation call only `started.requestFocusReconcile()`. Electron must not construct a repository, reconciler or vault gateway. Update the lifecycle test to assert the gateway factory is called once by `startServer`, every gateway receives the required native reader, focus never creates another instance, the CLI no longer imports Local REST, and ordered close still releases it. Coalesce concurrent focus signals inside the runtime. A startup recovery lock prevents automatic intake execution but still allows read-only detection.

Keep the exported lifecycle port narrow and deterministic:

```ts
export interface StartedServer {
  readonly origin: string;
  readonly port: number;
  requestFocusReconcile(): Promise<void>;
  close(): Promise<void>;
}

window.on('focus', () => void started.requestFocusReconcile());
app.on('activate', () => void started.requestFocusReconcile());
```

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
npm run test:integration -- intake-reconciler server-startup
npm run test:unit -- electron-focus-reconcile
npm run typecheck
```

Expected: startup, focus, missed event, dedupe, abort and shutdown tests pass without leaked handles.

Commit:

```bash
git add src/server/intake/intake-watcher.ts src/server/intake/intake-reconciler.ts src/server/start-server.ts src/server/index.ts src/electron/main.ts tests/integration/intake-reconciler.test.ts tests/unit/electron-focus-reconcile.test.ts
git commit -m "feat: reconcile clipper intake events"
```

### Task 5: Plan and execute recoverable automatic intake

**Files:**

- Create: `src/server/intake/intake-planner.ts`
- Create: `src/server/intake/intake-verifier.ts`
- Create: `src/server/intake/intake-finalizer.ts`
- Create: `src/server/intake/intake-service.ts`
- Test: `tests/integration/intake-service.test.ts`
- Modify: `src/shared/domain/intake.ts`
- Modify: `src/shared/domain/write.ts`
- Modify: `src/server/workflow/write-intent-registry.ts`
- Modify: `src/server/workflow/write-coordinator.ts`
- Modify: `src/server/db/repositories/intake-repository.ts`
- Modify: `src/server/start-server.ts`
- Test: `tests/integration/write-kernel.test.ts`

- [ ] **Step 1: Write failing planner and execution tests**

Run tests only inside a sentinel-protected temporary vault. For a directory package whose month does not yet exist, assert this exact ordered plan; Phase 1's shared `move-exclusive` path-version branch must support both a regular file and a complete directory tree, and Phase 2 must not add another move primitive:

```ts
const { plan, preview } = await planner.create(job);
expect(plan.intent.kind).toBe('intake');
expect(plan.steps.map((step) => [step.kind, step.role])).toEqual([
  ['replace', 'intake'],
  ['move-exclusive', 'intake'], // source.md -> normalized main Markdown name
  ['mkdir-exclusive', 'intake'], // exact missing YYYY-MM only
  ['move-exclusive', 'intake']
]);
expect(plan.steps.filter((step) => step.kind === 'move-exclusive').map((step) => step.entryKind))
  .toEqual(['file', 'directory']);
expect(preview.afterProjection).toMatchObject({
  processingStatus: '已归档',
  knowledgeStatus: '未提炼',
  sourcePlatform: '公众号',
  packagePath: '01图书馆/来自公众号/2026-09/20260901｜公众号｜示例文章',
  mainMarkdownPath: '01图书馆/来自公众号/2026-09/20260901｜公众号｜示例文章/20260901｜公众号｜示例文章.md'
});
```

Also assert the other three deterministic shapes:

```ts
expect(kinds(directoryPackageWithExistingMonth)).toEqual([
  'replace', 'move-exclusive', 'move-exclusive'
]);
expect(kinds(singleFileWithMissingMonth)).toEqual([
  'replace', 'mkdir-exclusive', 'mkdir-exclusive', 'move-exclusive'
]);
expect(kinds(singleFileWithExistingMonth)).toEqual([
  'replace', 'mkdir-exclusive', 'move-exclusive'
]);
```

The second `mkdir-exclusive` in the single-file case is exactly the normalized target package directory; directory packages instead arrive by the final directory move. Assert intent `expectedPackage` is byte-for-byte the persisted `FileVersion` for a root Markdown or the complete sorted Phase 1 `DirectoryTreeVersion` for a subdirectory package; the latter includes `rootIdentity` plus every file and directory entry, including empty directories. Add, remove, or rename an empty directory, or replace the package root inode after planning while preserving all file bytes/timestamps, and expect `VERSION_CONFLICT` before the first mutation. The plan also includes exact source/destination paths, current rule fingerprint and patched Markdown hash. The platform root must pre-exist and be a non-symlink; a missing month is planned, not rejected; an existing month is revalidated as a non-symlink directory. Inject platform/month/target replacement after planning and expect `VERSION_CONFLICT` with every source byte preserved.

Load the exact five-file rule bundle, assert it contains `00大脑规则/02_图书馆入馆规则.md`, and bind its fingerprint to the job and `WritePlan.ruleBundleSha256`. Change only that rule file (a) while the App is closed and then restart, (b) after classification but before user confirmation, (c) after confirmation but before plan creation, and (d) after plan creation but before coordinator execution. Before the changed current bundle is separately approved, every case returns `RULE_BUNDLE_UNAPPROVED`, stays blocked across restarts, leaves clipper/target bytes untouched, and never updates the approved record. After a user explicitly approves that new current bundle, replaying the older job or immutable plan returns `RULE_BUNDLE_STALE`, invalidates/discards it without mutation, and requires reclassification under the newly approved bundle.

Fault-inject after the metadata swap, main-document rename, month creation, single-file package-directory creation, file move and directory-package move. Every recovery plan has fresh step ordinals `0..n-1`; each step carries `recoveryOfOrdinal` for its original step. Continue accepts only the original unfinished suffix in ascending `recoveryOfOrdinal`; rollback accepts only durably landed originals in strictly descending `recoveryOfOrdinal`—it never reuses or reverses original ordinals as the recovery plan's own ordinals. Startup recovery must classify every before/after hash, continue or reverse in journal order, and remove a created directory only when it is still empty, has the recorded dev/ino identity and was created by that batch. If an external file appears inside it, recovery preserves the directory and enters manual recovery. Verify the normalized main Markdown body bytes and every attachment byte/hash remain unchanged; attachment names and package-relative links remain unchanged.

Assert the intake handler builds one strict, hash-bound `DomainProjectionCapsule` before authorization and before any vault mutation. It round-trips the job ID/post-transition expected version/operation ID, exact classification including the server-owned `authorizationMode`, `FileVersion | DirectoryTreeVersion` package binding, rule fingerprint, and deterministic forward/rollback/resolve reducer inputs below. `WritePlan.intent.authorizationMode` and the capsule classification mode must be equal, so both `planSha256` and `payloadSha256` bind the provenance. An automatic intent omits `confirmationBinding` and its capsule uses `confirmationBinding:null`; a user-confirmed intent and capsule contain the exact immutable binding identity/hash/timestamp, the capsule additionally contains the canonical resolution, and their expected job versions equal the ready version produced by confirmation. Automatic execution rejects `user_confirmed`; confirmed execution rejects `automatic` and must use the exact atomically bound plan/capsule. Reject a missing capsule, wrong `intentKind`, extra field, absent/unknown/renderer-selected authorization mode, plan/capsule mode mismatch, missing or altered confirmation binding, resolution/hash/version mismatch, absolute path, API/model key, auth/session token, raw Markdown/body/attachment bytes, package-version mismatch, classification mismatch, or altered payload hash before manifest preparation.

For each direction—ordinary clean commit, recovery continue, recovery rollback and manual resolve—delete or corrupt the SQLite state database after disk convergence but before domain finalization, start a fresh process, and require the scanner to load the immutable manifest capsule, strictly validate it through the intake handler, and reconstruct exactly one intake job/finalization plus affected index projection. For a user-confirmed plan it reconstructs the complete immutable binding row from `confirmationBinding`, including its ID/version, canonical resolution/hash and original `resolvedAt`; no timestamp or hash is regenerated. Forward/continue reconstruct `completed` and the matching binding as `consumed`. Rollback reconstructs `ready` under the original classification, preserves `authorizationMode` exactly, leaves the original binding `consumed`, and requires any retry to append the next binding version; a rolled-back user-confirmed plan can never become unattended or reactivate its former authority. Resolve reconstructs `needs_confirmation` with `MANUAL_RECOVERY_CONFLICT` and preserves the terminal binding evidence. Replaying the same capsule/terminal is idempotent and cannot create a second job, binding, binding version or operation ID.

Add lifecycle tests for an active user-confirmed binding before any prepared/recovery evidence exists: exact replay returns it unchanged; cancel changes it to `cancelled` and returns the job to a fresh server-derived `needs_confirmation`; supersede atomically cancels it and appends the next active binding with the next job/binding versions. A linked `planned` batch is terminalized atomically and does not block either action. Both operations hold `WorkflowMutationMutex`, reject a stale job version, binding ID/version, plan hash or capsule hash, and reject once a linked batch is `prepared` or later or the scanner finds a manifest, journal, staged inode or helper effect. Without restarting, inject a failure after manifest promotion at the hook, helper and final-verification windows; each path must run `enterConfirmedIntakeRecovery`, leave the exact original binding consumed, hide actions until that transition is durable, then permit independently tested continue, rollback and resolve. Race that recovery entry against cancel, supersede, finalization and the first recovery request and prove the shared mutex yields one legal idempotent outcome with no active manifest-backed binding. Delete SQLite while only an active preview or non-durable planned row exists and prove reconciliation invalidates/rebuilds it rather than claiming manifest-backed recovery. Separately simulate a crash after manifest promotion but before the SQLite checkpoint or recovery-entry hook and require startup recovery to reconstruct the capsule-bound row and mark the exact binding `consumed` before routes open. For a stale plan detected before manifest preparation, cancel the active binding and require a fresh confirmation/binding; after rollback, keep the old binding consumed and prove retry creates a new next-version binding rather than overwriting or reactivating it.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npm run test:integration -- intake-service
```

Expected: tests fail before any unguarded filesystem mutation occurs.

- [ ] **Step 3: Extend the shared write intent union**

Add one member to Phase 1's flat discriminated union in `src/shared/domain/write.ts`:

```ts
type IntakeWriteIntentBase = {
  readonly kind: 'intake';
  readonly intakeJobId: string;
  readonly expectedJobVersion: number;
  readonly packageKind: 'single_file' | 'directory';
  readonly packageKey: string;
  readonly originalMainMarkdownPath: string;
  readonly targetMonthDirectory: string;
  readonly targetPackageDirectory: string;
  readonly normalizedMainMarkdownName: string;
  readonly expectedPackage: FileVersion | DirectoryTreeVersion;
  readonly patchedMarkdownSha256: string;
};

export type IntakeWriteIntent = IntakeWriteIntentBase & (
  | {
      readonly authorizationMode: 'automatic';
      readonly confirmationBinding?: never;
    }
  | {
      readonly authorizationMode: 'user_confirmed';
      readonly confirmationBinding: {
        readonly jobId: string;
        readonly bindingId: string;
        readonly bindingVersion: number;
        readonly resolutionSha256: string;
        readonly resolvedAt: string;
      };
    }
);

export type WriteIntent =
  | KernelTestWriteIntent
  | KernelRecoveryWriteIntent
  | IntakeWriteIntent;
```

Add the intent-owned projection payload type to `src/shared/domain/intake.ts`:

```ts

type IntakeProjectionCapsulePayloadBase = {
  readonly capsuleSchemaVersion: 1;
  readonly job: {
    readonly id: string;
    readonly expectedVersion: number;
    readonly operationId: string;
    readonly createdAt: string;
    readonly packageKey: string;
    readonly snapshotSha256: string;
    readonly ruleBundleSha256: string;
    readonly packageVersion: FileVersion | DirectoryTreeVersion;
  };
  readonly reducers: {
    readonly forward: {
      readonly state: 'completed';
      readonly jobVersion: number;
      readonly processingStatus: '已归档';
      readonly knowledgeStatus: '未提炼';
      readonly packagePath: string;
      readonly mainMarkdownPath: string;
    };
    readonly rollback: {
      readonly state: 'ready';
      readonly jobVersion: number;
      readonly packagePath: string;
      readonly mainMarkdownPath: string;
    };
    readonly resolve: {
      readonly state: 'needs_confirmation';
      readonly jobVersion: number;
      readonly reason: 'MANUAL_RECOVERY_CONFLICT';
    };
  };
};

export type IntakeProjectionCapsulePayload = IntakeProjectionCapsulePayloadBase & (
  | {
      readonly classification: Extract<
        IntakeClassification,
        { readonly confidence: 'high'; readonly authorizationMode: 'automatic' }
      >;
      readonly confirmationBinding: null;
    }
  | {
      readonly classification: Extract<
        IntakeClassification,
        { readonly confidence: 'high'; readonly authorizationMode: 'user_confirmed' }
      >;
      readonly confirmationBinding: {
        readonly jobId: string;
        readonly bindingId: string;
        readonly bindingVersion: number;
        readonly resolution: IntakeResolution;
        readonly resolutionSha256: string;
        readonly resolvedAt: string;
      };
    }
);
```

`WritePlan.intent` remains this same `WriteIntent`; callers narrow `plan.intent.kind === 'intake'` and then read `plan.intent.intakeJobId`. `authorizationMode` is derived only from the authoritative classification transition and duplicated only across the two immutable, hash-bound security objects: the plan intent and its strict projection capsule; validation requires exact equality. It is never accepted from an API/model input. The intent's discriminated branch makes `confirmationBinding` absent for `automatic` and mandatory for `user_confirmed`; the capsule's discriminated branch makes it exactly `null` for `automatic` and requires the exact immutable job/binding ID/version, canonical resolution, `resolutionSha256` and `resolvedAt` for `user_confirmed`. The intent and capsule binding identities/hashes/timestamps must match each other and the row inserted with this plan. Phase 4 and Phase 5 append their flat intent members to that same union only when their own types are created, so no phase introduces another union or coordinator.

Define `intakeProjectionCapsulePayloadSchema` and the intake intent schema as strict discriminated unions matching the types above; do not model the branch rule only with optional fields plus a later policy check. Every path field uses the shared normalized vault-relative path schema, `packageKey` must stay under `01图书馆/小兆clipper`, target paths must stay under the classification's approved `01图书馆/来自<平台>` root, hashes are 64 lowercase hex, and `packageVersion` uses the exact Phase 1 discriminated runtime schema. Capsule creation requires a `ready`, high-confidence, reason-free classification and the exact server-owned `authorizationMode:'automatic'|'user_confirmed'`; that mode is inside the classification and therefore inside `payloadSha256`, not a mutable parallel flag. An automatic capsule must come only from classifier output and have `confirmationBinding:null`; its intent rejects any confirmation binding field. A user-confirmed capsule must have a non-null `confirmationBinding` matching the exact durable binding row: job/binding ID/version, canonical resolution, canonical `resolutionSha256` and immutable ISO `resolvedAt`; the user-confirmed intent binds the same identity/hash/timestamp. The capsule job ID, intent `intakeJobId` and binding job ID must be equal. The capsule job expected version, `WritePlan.intent.expectedJobVersion` and binding row `expected_job_version` must all equal the post-transition ready version, never the immediately stale pre-confirmation version. Missing, extra or mismatched confirmation evidence fails before authorization or manifest preparation. `resolvedAt` remains audit metadata and never substitutes for App-native write authority. Reducer `jobVersion` values are positive, deterministic outputs derived from the bound input version and cannot be supplied by the renderer. `payloadSha256` is the canonical hash of payload only. The core wrapper is exactly `{ schemaVersion: 1, intentKind: 'intake', payload, payloadSha256 }`; it contains no absolute root, secrets or duplicated source bytes.

- [ ] **Step 4: Implement planning and service orchestration**

Return workflow preview outside the core plan:

```ts
export type PlannedIntake = {
  readonly plan: WritePlan;
  readonly projectionCapsule: DomainProjectionCapsule;
  readonly bytesBySha256: ReadonlyMap<string, Uint8Array>;
  readonly preview: {
    readonly beforePackagePath: string;
    readonly afterPackagePath: string;
    readonly afterMainMarkdownPath: string;
    readonly afterProjection: {
      readonly processingStatus: '已归档';
      readonly knowledgeStatus: '未提炼';
      readonly sourcePlatform: string;
      readonly packagePath: string;
      readonly mainMarkdownPath: string;
    };
  };
};
```

`projectionCapsule` and `bytesBySha256` are server-internal execution inputs. The route maps only `preview` plus the public plan identifiers into its response schema; neither field is serialized to HTTP, logs or renderer state.

Register the handler with the complete Phase 1 capsule surface:

```ts
const verifier: WriteIntentVerifierHandler<'intake'> = {
  kind: 'intake',
  buildProjectionCapsule({ intent, plan }) {
    return intakeVerifier.buildProjectionCapsule({ intent, plan });
  },
  validateProjectionCapsule(capsule) {
    return intakeVerifier.validateProjectionCapsule(capsule);
  },
  verifyPlan(intent, plan) { return intakeVerifier.verifyPlan(intent, plan); },
  onManifestPersisted(context) {
    return intakeVerifier.onManifestPersisted(context);
  },
  verifyStep(intent, step) { return intakeVerifier.verifyStep(intent, step); },
  verifyFinalState(intent, plan) {
    return intakeVerifier.verifyFinalState(intent, plan);
  }
};
```

`IntakePlanner.create(job): Promise<PlannedIntake>` must first require the injected `RuleCompatibilityGate` is approved for the freshly loaded authoritative five-file bundle, then require its fingerprint equals the job classification, reread the package through the same Phase 1 observer, compare the complete `FileVersion | DirectoryTreeVersion` (including directory root identity and empty-directory topology), apply the byte-range patch in memory, reparse it, and generate the shape-specific ordered steps above with that fingerprint as `WritePlan.ruleBundleSha256`. It requires the classified platform root to exist and be a real directory; conditionally emits one `mkdir-exclusive` for the absent exact month; emits one additional target-package `mkdir-exclusive` only for `single_file`; and uses the shared discriminated file/directory `move-exclusive` steps to normalize the main Markdown filename and move the package. It never creates a platform root and never uses a suffix to evade a collision. Register `WriteIntentVerifierHandler<'intake'>` and `WriteIntentFinalizerHandler<'intake'>` in Phase 1's `WriteIntentHandlerRegistry`; do not branch `WriteCoordinator`. Extend the verifier handler contract with optional, idempotent `onManifestPersisted({ intent, plan, batchId, projectionCapsule, manifestSha256 })`. The generic coordinator invokes it for any registered intent immediately after pre-manifest authorization/current checks, active-manifest promotion and `prepared` persistence, while still holding `WorkflowMutationMutex`, and before staging/helper effects; a hook failure leaves the manifest recovery-required and reports no success. Existing handlers may omit it, so this adds no intent switch. Coordinator tests assert exact ordering, one live invocation, crash recovery and no invocation for a merely `planned` batch. `buildProjectionCapsule` derives the payload only from the already validated job/classification/package version and plan, and `validateProjectionCapsule` strictly rechecks every cross-field binding before policy authorization. The coordinator alone acquires the mutex for execution. Inside that lock and immediately before manifest preparation, `IntakeVerifier.verifyPlan` reloads the exact active user-confirmed binding plus authoritative bundle/package, checks job/binding/plan/capsule hashes and versions, and returns `RULE_BUNDLE_UNAPPROVED`, `RULE_BUNDLE_STALE` or `VERSION_CONFLICT` before mutation. A stale plan may then be cancelled/superseded only by a separate lifecycle call after the coordinator releases the lock; it is never mutated inside execution. After manifest promotion, the intake hook atomically advances the exact ready job from the plan's post-confirmation `expectedJobVersion` to `applying` while requiring and preserving the same `active` binding; replay accepts only that exact already-applying/active pair. Thus the plan version is checked before this intentional transition and is not treated as stale afterward, and later coordinator `assertCurrent()` checks can still require the immutable binding. `verifyStep` checks each landed step; `verifyFinalState` rereads the complete final package with `observeTree()`, reparses the normalized main Markdown, confirms `已归档 + 未提炼`, and checks every attachment hash plus empty-directory topology. `IntakeFinalizer.finalizeVerified({ intent, plan, batchId, projectionCapsule })` is idempotent under `(batchId, plan.planSha256, projectionCapsule.payloadSha256)`: it strictly validates the capsule, refreshes exactly the affected index paths, verifies the indexed raw hash/YAML projection equals disk after-bytes and capsule reducer, and in one immediate transaction records or reconstructs the intake job finalization, advances `applying` to `completed`, and changes the exact active binding to `consumed` before the core batch may become `committed`; replay accepts only the matching completed/consumed terminal tuple. Startup repairs any crash after manifest promotion before ordinary routes reopen and reconstructs the manifest-backed binding as consumed history rather than reusable authority. It also implements the shared `finalizeRecoveryVerified({ originalIntent, originalPlan, originalBatchId, recoveryPlan, recoveryBatchId, direction, projectionCapsule })`: `continue` idempotently produces the same completed/indexed after-state and preserves `consumed`; `rollback` uses the capsule's verified before reducer, reindexes restored clipper paths, reconstructs the job as `ready` with the same authorization mode and leaves the original binding `consumed`; `resolve` never marks intake completed, refreshes only parseable current paths, records any schema issue, and reconstructs the job in `needs_confirmation` with reason `MANUAL_RECOVERY_CONFLICT` while preserving binding evidence and core state becomes `manually-resolved`. All directions run only after recovery disk/journal/final-state verification and before the core recovery outcome is exposed; none dispatches through `kernel_recovery` as though it were the original intake intent. SQLite loss never permits inference from paths alone: an active preview or `planned` row without recovery evidence may be invalidated and rebuilt, while reconstruction after manifest promotion requires the validated manifest capsule plus converged disk/journal state. `IntakeService.applyAutomatic(...)` validates request shape and delegates to the shared coordinator without a user token or pre-acquiring its mutex. `IntakeService.confirm(...)` holds the mutex from the first live job/rule/package read through server-side resolution, plan/capsule creation and `resolveAndBindPlan`; it returns the redacted immutable preview only after the resolution, complete `write_plans` row, capsule and job transition are durably bound in one immediate transaction, and performs no coordinator/helper/vault mutation. When a rolled-back `user_confirmed` job has no active binding, a new confirmation appends `max(binding_version) + 1`; it never reuses the consumed row. `IntakeService.cancelConfirmedPlan(...)` and `supersedeConfirmedPlan(...)` hold that same mutex from live binding/batch/scanner proof through the immediate repository transition; they may terminalize an exact linked `planned` batch in that transaction, but reject `prepared` or later plus any manifest/journal/staging/helper evidence. They then rerun authoritative rule/package/classification validation before returning. `IntakeService.applyConfirmed(...)` only validates/parses the public binding/plan expectations and one-use token seam, then delegates without taking the mutex; the coordinator-owned intake verifier reloads the exact active binding, re-materializes private after-bytes and validates every equality inside its lock. The optional Phase 2 `nativeGrantToken` is opaque, never logged/persisted/echoed, and sentinel tests continue to use the injected Phase 1 test policy. Apply returns success only when the authoritative core batch is committed, then rereads only the final authoritative job/detail; it never rebuilds, refreshes or retries a plan/token after coordinator return. A crash during either finalizer is replayed idempotently and remains non-success in API/UI; a coordinator recovery result maps the job to `recovery_required`, while a pre-mutation mismatch maps it to `conflict`.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
npm run test:integration -- intake-service write-kernel
npm run typecheck
```

Expected: both package shapes, existing/missing month, name normalization, target race, file change, empty-directory add/remove/rename, package-root inode replacement, every filesystem/finalization fault boundary, continue and rollback pass; source body and attachment hashes remain unchanged, only same-batch empty directories are removed, and no UI/API success precedes verified index finalization plus core commit.

Commit:

```bash
git add src/server/intake/intake-planner.ts src/server/intake/intake-verifier.ts src/server/intake/intake-finalizer.ts src/server/intake/intake-service.ts src/server/db/repositories/intake-repository.ts src/server/start-server.ts tests/integration/intake-service.test.ts tests/integration/write-kernel.test.ts src/shared/domain/intake.ts src/shared/domain/write.ts src/server/workflow/write-intent-registry.ts src/server/workflow/write-coordinator.ts
git commit -m "feat: execute recoverable automatic intake"
```

### Task 6: Expose strict intake APIs

**Files:**

- Create: `src/server/api/routes/intake-jobs.ts`
- Modify: `src/shared/api/schemas.ts`
- Modify: `src/server/app.ts`
- Modify: `src/client/api/client.ts`
- Test: `tests/integration/intake-api.test.ts`
- Test: `tests/component/api-client.test.tsx`

- [ ] **Step 1: Write failing API tests**

Assert:

```text
GET  /api/v1/intake-jobs?state=needs_confirmation
GET  /api/v1/intake-jobs/:id
POST /api/v1/intake-jobs/:id/confirm
POST /api/v1/intake-jobs/:id/confirmed-plan/cancel
POST /api/v1/intake-jobs/:id/confirmed-plan/supersede
POST /api/v1/intake-jobs/:id/apply-confirmed
POST /api/v1/intake/reconcile
```

For a resolvable directory-main/metadata ambiguity, the confirm body is exactly:

```json
{
  "expectedVersion": 3,
  "packageKind": "directory",
  "mainMarkdownPath": "01图书馆/小兆clipper/article-1/source.md",
  "sourcePlatform": "公众号",
  "collectedAt": "2026-09-01",
  "shortTitle": "示例文章"
}
```

`POST .../confirm` performs no vault mutation and returns the authoritative `user_confirmed` job plus redacted immutable plan preview, plan hash, binding ID/version and the post-transition ready job version. An exact idempotent replay after native-dialog cancel or process restart returns that same persisted preview and never creates a replacement plan. `POST .../confirmed-plan/cancel` invalidates only the exact active, unprepared binding and returns a fresh `needs_confirmation` job; `POST .../confirmed-plan/supersede` atomically cancels that binding and returns the newly appended ready binding/preview. Both accept only exact binding/plan expectations plus, for supersede, a replacement confirmation input; a linked `planned` batch is terminalized atomically, while `prepared` or later or any manifest/journal/staged-inode/helper evidence returns 409. `POST .../apply-confirmed` is the only execution endpoint: it accepts exactly that job ID, binding ID/version, plan ID/hash, post-transition expected job version and the optional Phase 2 native-token seam; it accepts no resolution, classification, path, step, capsule, bytes or authorization mode. Assert unknown keys return 400, stale version/hash/binding returns 409, mutation routes require session/CSRF/idempotency, recovery lock returns 409 `RECOVERY_REQUIRED`, and responses never contain source body, attachment bytes, capsule JSON/hash, token or absolute paths. Confirmed plans remain byte-for-byte unmoved until apply-confirmed. Missing tokens remain usable only under the sentinel test policy in Phase 2; Phase 6 makes the token mandatory for `user_confirmed` production apply-confirmed. Cancel/supersede and apply race tests prove the shared mutex permits exactly one outcome. Deleting SQLite while only an active preview or non-durable planned row exists invalidates it and permits a fresh confirm; deleting it after manifest promotion reconstructs the exact consumed binding from the capsule before HTTP routes open. `POST .../confirm` on `ROOT_ATTACHMENT_UNASSIGNED` or root-level `PACKAGE_SHAPE_AMBIGUOUS` returns 409 `INTAKE_SHAPE_NOT_RESOLVABLE`; it cannot supply arbitrary package members, ignore a sibling or reach planning. A rolled-back job accepts a fresh confirm that appends the next binding version while the former row stays consumed. Change only `02_图书馆入馆规则.md` after the job is shown but before confirmation; confirm first returns 409 `RULE_BUNDLE_UNAPPROVED`, moves no bytes, and never self-approves. After explicit approval of that new bundle, stale active previews must be cancelled or superseded under the pre-prepare proof; replaying the old confirmation or apply-confirmed requires 409 `RULE_BUNDLE_STALE` and reclassification rather than accepting the old normalized destination. Restart with current/approved mismatch and assert reconcile returns diagnostic counts plus `RULE_BUNDLE_UNAPPROVED`, while confirm/apply-confirmed remain blocked and never update the approved record.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npm run test:integration -- intake-api
```

Expected: routes return 404 or schema validation failures.

- [ ] **Step 3: Add request and response schemas**

Add strict Zod schemas for `intakeState`, the shared Phase 1 `fileVersionSchema`/`directoryTreeVersionSchema` union, redacted `intakeJobSummary`, `intakeJobDetail`, `intakeConfirmationBody`, `confirmedIntakePreview`, `confirmedIntakePlanExpectation`, `cancelConfirmedIntakePlanBody`, `supersedeConfirmedIntakePlanBody`, `confirmedIntakeApplyBody`, `intakeReconcileResult` and their success envelopes. `intakeJobDetail` includes hashes, directory identities, authorization mode and relative paths but no raw bytes. `confirmedIntakePreview` exposes only job plus complete display preview, plan ID/hash, binding ID/version and the post-transition ready job version; it never exposes the capsule, capsule hash or private byte map.

```ts
export const intakePackageVersionSchema = z.union([
  fileVersionSchema.refine((value) => value.exists, 'package file must exist'),
  directoryTreeVersionSchema
]);

export const intakeConfirmationBodySchema = z.object({
  expectedVersion: z.number().int().positive(),
  packageKind: z.enum(['single_file', 'directory']),
  mainMarkdownPath: vaultRelativePathSchema,
  sourcePlatform: sourcePlatformSchema,
  collectedAt: isoDateSchema,
  shortTitle: safeShortTitleSchema
}).strict();

export const confirmedIntakePlanExpectationSchema = z.object({
  expectedJobVersion: z.number().int().positive(),
  bindingId: z.string().min(1),
  expectedBindingVersion: z.number().int().positive(),
  planId: z.string().min(1),
  expectedPlanSha256: sha256Schema
}).strict();

export const cancelConfirmedIntakePlanBodySchema =
  confirmedIntakePlanExpectationSchema;

export const supersedeConfirmedIntakePlanBodySchema = z.object({
  current: confirmedIntakePlanExpectationSchema,
  replacement: intakeConfirmationBodySchema.omit({ expectedVersion: true })
}).strict();

export const confirmedIntakeApplyBodySchema = confirmedIntakePlanExpectationSchema.extend({
  nativeGrantToken: z.string().regex(/^[a-f0-9]{64}$/u).optional()
}).strict();
```

- [ ] **Step 4: Implement service-only routes and client methods**

`registerIntakeRoutes(app, service)` validates through `parseApiOutput`, calls only `IntakeService`, and returns an operation ID for every mutation. `IntakeService.confirm` reloads the same five-file bundle, requires the injected compatibility gate approves it, rejects unapproved/stale fingerprints, builds a server-owned `user_confirmed` classification and atomically binds the immutable plan/capsule without executing. Cancel and supersede routes forward only exact expectations into the service; the service reloads the private capsule hash, proves the pre-prepare boundary beneath `WorkflowMutationMutex`, terminalizes an exact linked `planned` batch when present, and passes the full CAS tuple to the repository. `IntakeService.applyConfirmed` only parses the public expectation/token seam and delegates; the coordinator-owned verifier reloads the exact active binding under its mutex and never rebuilds a different plan from request data. The token field is forwarded once, then dropped in `finally`; it never enters generic logging/error/idempotency payloads. Extend `ReadConsoleApi` to `BrainConsoleApi` with:

```ts
listIntakeJobs(state?: IntakeState, signal?: AbortSignal): Promise<ApiClientResult<IntakeJobPage>>;
getIntakeJob(id: string, signal?: AbortSignal): Promise<ApiClientResult<IntakeJobDetail>>;
confirmIntake(id: string, body: IntakeConfirmationInput, idempotencyKey: string): Promise<ApiClientResult<ConfirmedIntakePreview>>;
cancelConfirmedIntakePlan(id: string, body: ConfirmedIntakePlanExpectation, idempotencyKey: string): Promise<ApiClientResult<IntakeJobDetail>>;
supersedeConfirmedIntakePlan(id: string, body: SupersedeConfirmedIntakePlanInput, idempotencyKey: string): Promise<ApiClientResult<ConfirmedIntakePreview>>;
applyConfirmedIntake(id: string, body: ConfirmedIntakeApplyInput, idempotencyKey: string): Promise<ApiClientResult<IntakeJobDetail>>;
reconcileIntake(idempotencyKey: string): Promise<ApiClientResult<IntakeReconcileResult>>;
```

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
npm run test:integration -- intake-api local-http-security
npm run test:component -- api-client
npm run typecheck
```

Expected: route, CSRF, version, idempotency, recovery and response-redaction tests pass.

Commit:

```bash
git add src/server/api/routes/intake-jobs.ts src/shared/api/schemas.ts src/server/app.ts src/client/api/client.ts tests/integration/intake-api.test.ts tests/component/api-client.test.tsx
git commit -m "feat: expose automatic intake APIs"
```

### Task 7: Add intake queue UI and prove the complete flow

**Files:**

- Create: `src/client/components/intake/IntakeJobList.tsx`
- Create: `src/client/components/intake/IntakeConfirmation.tsx`
- Modify: `src/client/pages/QueuePage.tsx`
- Modify: `src/client/pages/OperationsPage.tsx`
- Test: `tests/component/intake-queue.test.tsx`
- Test: `tests/e2e/automatic-intake-flow.spec.ts`

- [ ] **Step 1: Write failing component tests**

Assert the queue has four independently named regions: `未提炼`, `部分入库`, `待确认入馆`, `未完成任务`. A high-confidence completed intake only increments the nonblocking badge and appears as `未提炼`; resolvable metadata/directory-main ambiguity exposes server-listed fields, while unassigned root attachments/root shape show only the correction instruction and no confirm control. The first `确认入馆信息` action is disabled during submission, performs no vault mutation and renders the complete immutable move/YAML preview returned by the server. A distinct `确认并执行入馆` action remains disabled until that preview is current; under the Phase 2 sentinel fixture it calls only `applyConfirmedIntake` with the bound plan/hash/job/binding versions, while Phase 6 inserts the mandatory App-native grant before this same call. Conflict and recovery show operation ID and route to details.

Use accessible queries:

```ts
expect(screen.getByRole('heading', { name: '待确认入馆' })).toBeVisible();
await user.selectOptions(screen.getByLabelText('来源平台'), '公众号');
await user.click(screen.getByRole('button', { name: '确认入馆信息' }));
expect(api.confirmIntake).toHaveBeenCalledWith(
  'intake-1',
  expect.objectContaining({ expectedVersion: 3, sourcePlatform: '公众号' }),
  expect.stringMatching(/^intake-/u)
);
expect(screen.getByRole('button', { name: '确认并执行入馆' })).toBeEnabled();
await user.click(screen.getByRole('button', { name: '确认并执行入馆' }));
expect(api.applyConfirmedIntake).toHaveBeenCalledWith(
  'intake-1',
  expect.objectContaining({
    bindingId: confirmedPreview.bindingId,
    planId: confirmedPreview.planId,
    expectedPlanSha256: confirmedPreview.planSha256,
    expectedJobVersion: confirmedPreview.expectedJobVersion,
    expectedBindingVersion: confirmedPreview.bindingVersion
  }),
  expect.stringMatching(/^intake-apply-/u)
);
```

Add component assertions for the existing visual contract, not a new intake theme. Editing or backing out of an active preview calls only `cancelConfirmedIntakePlan` (or `supersedeConfirmedIntakePlan` when the replacement form is submitted), removes the old apply action, and proves the old binding can no longer execute. Native-dialog cancel does not call either lifecycle endpoint and leaves the exact preview reusable. A rolled-back job shows `重新确认后执行`; the returned preview must have a higher binding version while the old consumed binding never reappears. Queue/job/operation states must render Chinese text, a non-color icon and `data-tone`; use red only for failure/conflict, amber for pending confirmation/recovery decision, blue for auxiliary detection metadata, and fluorescent green for verified/completed. Panels consume the current `--surface-void`, `--surface-glass`, `--border-*`, `--accent-primary`, `--status-amber`, `--status-red` and `--status-blue` tokens. Stub `matchMedia('(prefers-reduced-motion: reduce)')` and assert nonessential badge/panel transitions are disabled while progress text remains visible.

- [ ] **Step 2: Run component tests and verify RED**

Run:

```bash
npm run test:component -- intake-queue
```

Expected: the intake regions and actions are absent.

- [ ] **Step 3: Implement the queue and operation presentation**

`IntakeJobList` renders state text, icon and permitted token color together through `data-tone`. Reuse the existing near-black/glass/silver-border/fluorescent-green tokens, add no alternate palette, and remove nonessential transition/transform animation under reduced motion. `IntakeConfirmation` shows the detected package shape and lets a resolvable ambiguous job choose only among server-listed package/main-document candidates; it requires source platform, date and the final readable short title, previews the exact normalized package and Markdown names, sends the current version, and replaces local state only with the server response. That response is `authorizationMode:'user_confirmed'` and includes the bound immutable plan preview, binding ID/version and post-transition ready job version; the component shows every ordered relative path/action plus before/after hashes before enabling the separate apply action. It never posts `authorizationMode`, classification, plan steps or capsule. Editing/back after preview calls the cancel endpoint before returning to fields; submitting a changed preview may call the atomic supersede endpoint. Both replace local state only with the authoritative response, and the old preview is immediately non-executable. Cancelling only the Phase 6 native dialog does not cancel the durable preview. In Phase 2 only the sentinel fixture can execute apply-confirmed; the production UI remains blocked until Phase 6 supplies the one-use native grant to that same unique execution endpoint. For `ROOT_ATTACHMENT_UNASSIGNED` or root-level `PACKAGE_SHAPE_AMBIGUOUS`, render no confirm/apply button and the exact instruction `请让插件把 Markdown 与附件放进同一个直属子目录，稳定后 App 会重新识别`; do not offer member checkboxes or an “ignore attachments” shortcut. `QueuePage` keeps material pagination independent from intake loading. `OperationsPage` renders intake detection, classification, directory creation, name normalization, write and recovery events without raw source content.

```tsx
{job.reason === 'ROOT_ATTACHMENT_UNASSIGNED' ||
job.reason === 'PACKAGE_SHAPE_AMBIGUOUS' ? (
  <p data-tone="warning">
    请让插件把 Markdown 与附件放进同一个直属子目录，稳定后 App 会重新识别
  </p>
) : (
  <IntakeConfirmation job={job} onConfirmed={replaceAuthoritativeJob} />
)}
```

- [ ] **Step 4: Write the guarded E2E journey**

The E2E fixture server must create a fresh sentinel-protected temporary vault with a pre-existing real `01图书馆/来自公众号` platform root but no `2026-09` month, copy `clipper-package`, and drive:

```text
fixture lands in 小兆clipper
→ first scan waits
→ stable scan classifies
→ automatic write plan commits
→ creates only the exact 2026-09 month
→ package and main Markdown are both named 20260901｜公众号｜示例文章
→ package exists only under 来自公众号/2026-09
→ source is 已归档 + 未提炼
→ body bytes and cover.png hash are unchanged
→ dashboard deck contains the material
```

Repeat with direct `clipper-single.md`: create the exact normalized target package directory and move the Markdown to its normalized filename; no attachment or body byte changes are allowed. Add root fixtures with two Markdown files and with a Markdown plus loose attachment; each remains byte-for-byte unmoved, has no confirm/apply action and cannot absorb/orphan a sibling. Add a separate directory-package fixture whose main Markdown tier is genuinely tied and prove only that resolvable candidate selection can proceed. For that fixture, confirm to immutable preview, cancel it before batch creation, confirm again and prove the old binding cannot apply; also exercise atomic supersede. Fault-inject after each mkdir/rename/move and verify restart offers deterministic continue/rollback, including conditional empty-directory cleanup; after rollback, retry must issue the next binding version and require a new native confirmation in Phase 6.

- [ ] **Step 5: Run all Phase 2 verification**

Run:

```bash
npm run test:unit -- source-frontmatter-patch intake-package-stability clipper-metadata-extractor intake-package-classifier
npm run test:integration -- intake-repository intake-reconciler intake-service intake-api
npm run test:component -- intake-queue api-client
npm run test:e2e -- automatic-intake-flow
npm run build
```

Expected: all commands exit 0; every write trace points to a unique temporary sentinel vault; formal vault path does not appear as a mutation target.

- [ ] **Step 6: Commit**

```bash
git add src/client/components/intake/IntakeJobList.tsx src/client/components/intake/IntakeConfirmation.tsx src/client/pages/QueuePage.tsx src/client/pages/OperationsPage.tsx tests/component/intake-queue.test.tsx tests/e2e/automatic-intake-flow.spec.ts
git commit -m "feat: complete the automatic intake workflow"
```

## Phase 2 Exit Criteria

- Direct single-Markdown deliveries and subdirectory packages created while the App is open or closed are found by reconciliation.
- Only stable, high-confidence packages are automatically planned and committed.
- Resolvable directory-main/metadata ambiguity remains byte-for-byte through field confirmation and immutable preview; it is marked `user_confirmed` and requires the separate App-native-confirmed apply in production, never the unattended automatic authority. Root-level loose attachments or ambiguous root grouping are non-resolvable in V1 and remain untouched until the plugin delivers one direct subdirectory package.
- User-confirmed plans use append-only versioned bindings with at most one active row per job. Cancel/supersede may terminalize a merely planned batch, but is forbidden after `prepared` or any manifest/journal/staging/helper evidence under the shared mutation mutex; the binding remains active only through the ordinary coordinator's post-manifest current checks, then verified finalization, live recovery entry or startup recovery makes it consumed before recovery actions appear, and rollback/retry appends a new version instead of reactivating authority.
- The strict plan intent and capsule both bind user confirmation identity/hash/timestamp, while only the capsule carries the canonical resolution; automatic intent omits confirmation evidence and its capsule contains `confirmationBinding:null`. All expected job versions are the post-confirmation ready version.
- Source body and attachment bytes are unchanged; only approved YAML value ranges and package paths change.
- The platform root must already exist; intake may create only its classified missing month and, for a direct single Markdown, its exact normalized package directory. Both package and main Markdown end as `YYYYMMDD｜来源平台｜短标题`, while attachment names and relative links remain unchanged.
- Every mutation is executed by the shared `WriteCoordinator`, has a recovery manifest and is tested only in a sentinel-protected temporary vault.
- Phase 2 完成时正式 root 自动执行仍关闭；Phase 6 只可为上述精确 intake from/to/intent scope 建立 Electron-owned production authority，并分别测试知识入库、编辑和反向恢复均被拒绝。
- A successful package is indexed as `处理状态: 已归档` and `知识入库状态: 未提炼` and appears in the unrefined deck.
