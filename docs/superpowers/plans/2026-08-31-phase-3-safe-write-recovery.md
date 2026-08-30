# Phase 3 Safe Formal Write and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Turn reviewed candidates into deterministic write plans and execute them with idempotency, real optimistic concurrency, byte verification, self-contained recovery manifests, and explicit continue/rollback controls.

**Architecture:** WritePlanner is pure and produces an immutable plan from current source/target bytes plus final decisions. WriteCoordinator persists a complete external manifest before the first mutation, executes ordered VaultGateway CAS operations, rereads every step, updates the source last, and records a committed batch only after graph verification. RecoveryService can continue or roll back from the manifest even when SQLite is unreadable.

**Tech Stack:** Existing stack, cryptographic canonical JSON, SQLite, filesystem fsync for recovery manifests, fake CAS gateway, and a proven real Local REST write adapter

---

Hard prerequisite: Gate G2 in docs/architecture/write-gate-decision.md is PASSED for the exact running plugin fingerprint, npm run gate:write-capability exits 0, or the user has approved a separate gateway plan that implements the same mutation interface. If the current Local REST profile is blocked, stop before Task 4. Tasks 1–3 may still produce and preview plans without enabling execution.

### Task 1: Persist immutable plans, batches, and steps

**Files:**
- Create: src/server/db/migrations/003_write_workflow.sql
- Create: src/server/db/repositories/write-repository.ts
- Create: src/shared/domain/write.ts
- Test: tests/integration/write-repository.test.ts

- [ ] **Step 1: Write failing persistence tests**

Assert:

- one run version has at most one current plan;
- plan_json and plan_hash never change after insert;
- idempotency key + identical request returns the same batch;
- idempotency key + different request hash is a 409;
- only one nonterminal batch may involve a material path;
- candidate changes invalidate an unprepared plan;
- candidates freeze after prepared;
- every state transition is checked and monotonic;
- step results are ordered and append-only.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:integration -- write-repository
~~~

Expected: the suite loads and fails at immutability, idempotency, uniqueness, freeze, or transition assertions. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Define write-domain types**

Create src/shared/domain/write.ts:

~~~ts
export type FileVersion = {
  exists: boolean;
  rawSha256?: string;
  upstreamVersion?: string;
};

export type FileOperation = {
  order: number;
  path: string;
  action: 'create' | 'replace';
  before: FileVersion;
  beforeBytes?: string;
  afterRawSha256: string;
  afterBytes: string;
  role: 'knowledge' | 'source';
};

export type WritePlan = {
  id: string;
  runId: string;
  runVersion: number;
  candidateSetHash: string;
  sourcePath: string;
  sourceRawSha256: string;
  operations: FileOperation[];
  planHash: string;
  createdAt: string;
};

export type WriteBatchState =
  | 'planned'
  | 'prepared'
  | 'applying'
  | 'verifying'
  | 'committed'
  | 'recovery_required'
  | 'recovery_applying'
  | 'rolled_back';
~~~

Store bytes as base64 in plan/manifest serialization and convert to Uint8Array only at boundaries. Never round-trip source body through JavaScript strings.

- [ ] **Step 4: Add migration 003**

Create tables write_plans, write_batches, write_step_results, and path_claims. Include plan_hash, request_hash, version, state, current_step, error_code, timestamps, and foreign keys to extraction_runs. Add partial unique indexes for a current plan per run and a nonterminal batch per source path.

- [ ] **Step 5: Implement repository transitions**

Expose explicit methods:

~~~ts
export interface WriteRepository {
  insertPlan(plan: WritePlan): void;
  invalidatePlans(runId: string, newerRunVersion: number): void;
  createOrGetBatch(input: CreateBatchInput): WriteBatch;
  markPrepared(batchId: string, expectedVersion: number): WriteBatch;
  startStep(batchId: string, step: number, expectedVersion: number): WriteBatch;
  finishStep(batchId: string, result: WriteStepResult): WriteBatch;
  requireRecovery(batchId: string, code: string): WriteBatch;
  markCommitted(batchId: string, expectedVersion: number): WriteBatch;
  markRolledBack(batchId: string, expectedVersion: number): WriteBatch;
}
~~~

Every method uses a transaction and expected version.

- [ ] **Step 6: Verify green and commit**

Run:

~~~bash
npm run test:integration -- write-repository
npm run typecheck
git add src/server/db src/shared/domain/write.ts tests/integration/write-repository.test.ts
git commit -m "feat: persist immutable write plans and batches"
~~~

### Task 2: Generate rule-compliant knowledge bytes and source patches

**Files:**
- Create: src/server/rules/knowledge-template.ts
- Create: src/server/rules/source-frontmatter-update.ts
- Create: src/server/rules/merge-ai-summary.ts
- Create: src/server/rules/wikilink-set.ts
- Test: tests/unit/knowledge-template.test.ts
- Test: tests/unit/source-frontmatter-update.test.ts
- Test: tests/unit/merge-ai-summary.test.ts

- [ ] **Step 1: Write failing deterministic rendering tests**

New-note tests assert exact YAML order:

~~~yaml
类型: 知识笔记
来源类型: AI提炼
使用状态: AI总结
知识类型:
所属主题: []
关键词: []
来源资料: []
适用场景: []
核心结论:
关键要点: []
使用边界:
创建日期:
更新日期:
备注:
~~~

Body tests assert exact headings:

~~~markdown
## 知识正文

## 可复用表达

### 原文引用

### 个人总结
~~~

Assert 3–6 keywords, one conclusion, 2–3 scenarios, 2–4 key points, one boundary, and a 150–320 character recall card in the normal case.

Source-update tests assert:

- only 生成知识, 知识入库状态, and task-required 备注 change;
- generated links are a stable old-first deduplicated union;
- bodyBytes after the closing delimiter are exactly equal;
- all rejected changes only status to 已入库;
- historical partial preserves every existing generated link.

Merge tests assert:

- only AI总结 produces an automatic merge proposal;
- 已优化, 定论, and 过时 return PROTECTED_KNOWLEDGE;
- no protected match silently becomes a new note;
- title collision is a conflict;
- creation date remains and update date changes;
- multi-source order and S1/S2 mapping are stable.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:unit -- knowledge-template source-frontmatter-update merge-ai-summary
~~~

Expected: all suites load and fail at deterministic YAML/body, byte preservation, protected state, collision, or S1/S2 assertions. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Implement new-note rendering**

knowledge-template.ts accepts only a validated candidate, current source path, final path, and current date. The service, never the model, sets 类型, 来源类型, 使用状态, 来源资料, dates, and fixed headings.

Reject frontmatter delimiters in candidate body, raw HTML, missing reusable-expression subsections, invalid filename characters, hidden path segments, and existing target paths.

- [ ] **Step 4: Implement byte-preserving source updates**

source-frontmatter-update.ts parses only the YAML byte slice, updates the three allowed fields, serializes that slice with LF, then concatenates the original closing delimiter and exact original bodyBytes. Test CRLF, BOM, no-final-newline, empty body, comments outside frontmatter, and Chinese links.

- [ ] **Step 5: Implement AI总结 merge proposals**

Preserve untouched YAML and body sections. Merge array fields with stable dedupe. For multiple sources, assign source numbers by existing 来源资料 order, append the new source, label changed sections, and generate 来源映射. If a section cannot be located or the old schema is invalid, return a blocking conflict instead of rewriting the file.

- [ ] **Step 6: Verify green and commit**

Run:

~~~bash
npm run test:unit -- knowledge-template source-frontmatter-update merge-ai-summary
npm run typecheck
git add src/server/rules tests/unit
git commit -m "feat: render deterministic knowledge and source bytes"
~~~

### Task 3: Build the pure WritePlanner and full diff preview

**Files:**
- Create: src/server/workflow/write-planner.ts
- Create: src/server/workflow/plan-hash.ts
- Create: src/server/workflow/file-diff.ts
- Test: tests/unit/write-planner.test.ts
- Test: tests/integration/write-plan-service.test.ts

- [ ] **Step 1: Write failing planner tests**

Assert:

1. Any pending candidate blocks a plan.
2. Accepted candidates require explicit create or merge disposition.
3. Rejected candidates create no knowledge operation.
4. Zero accepted produces one source replace operation.
5. Knowledge operations precede the one source operation.
6. Source operation is always last.
7. Same bytes, versions, decisions, and date produce the same planHash.
8. Any source/target hash, run version, candidate set, path, or disposition change changes or invalidates the plan.
9. Index stale, schema issue, protected target, collision, or disallowed path blocks the plan.
10. Diff includes every affected path and no unrelated file.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:unit -- write-planner
npm run test:integration -- write-plan-service
~~~

Expected: both suites load and fail at plan preflight, operation order, hash stability, invalidation, or diff assertions. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Implement canonical plan hashing**

Sort object keys recursively, preserve operation array order, encode UTF-8, and hash SHA-256. Exclude generated plan id and createdAt from the hash. Include runVersion, candidateSetHash, all before versions, all after hashes, dispositions, and final date.

- [ ] **Step 4: Implement planner preflight**

The planner:

1. loads run and all candidate decisions;
2. asserts ready_to_plan and expectedRunVersion;
3. asserts index ready;
4. rereads source and every target through VaultGateway;
5. verifies schemas and protected states;
6. renders after bytes;
7. creates line diffs with the diff package;
8. validates all after bytes by reparsing;
9. persists one immutable plan.

It never calls a mutation method.

- [ ] **Step 5: Verify green and commit**

Run:

~~~bash
npm run test:unit -- write-planner
npm run test:integration -- write-plan-service
npm run typecheck
git add src/server/workflow tests
git commit -m "feat: generate immutable full-file write plans"
~~~

### Task 4: Define real and fake CAS mutation gateways

**Files:**
- Modify: src/server/vault/VaultGateway.ts
- Create: src/server/vault/FakeCasVaultGateway.ts
- Create or modify: src/server/vault/LocalRest51WriteGateway.ts
- Test: tests/unit/fake-cas-gateway.test.ts
- Test: tests/contract/obsidian-local-rest-5.1.0/write-adapter.contract.test.ts

- [ ] **Step 1: Stop if G2 is blocked**

Read the exact capability profile. If formalWriteGate is blocked, record the missing operations and stop Phase 3 execution here. Ask the user to approve a separate companion-plugin gateway plan or keep the product draft-only. Do not implement LocalRest51WriteGateway with check-then-PUT or check-then-DELETE.

- [ ] **Step 2: Write the gateway conformance suite**

Extend VaultGateway:

~~~ts
export interface MutableVaultGateway extends VaultGateway {
  conditionalCreate(path: string, after: Uint8Array): Promise<VersionedBytes>;
  conditionalReplace(path: string, before: FileVersion, after: Uint8Array): Promise<VersionedBytes>;
  conditionalDelete(path: string, expected: FileVersion): Promise<void>;
}
~~~

Run one conformance suite against FakeCasVaultGateway and the guarded real test-vault adapter. Required behavior:

- create fails if the path exists;
- replace fails when upstream version or current bytes differ;
- delete fails when current version or bytes differ;
- every success returns or permits immediate raw reread;
- 412 maps to VERSION_CONFLICT;
- an unknown fingerprint maps to WRITE_GATE_CLOSED.

- [ ] **Step 3: Run and verify red**

Run:

~~~bash
npm run test:unit -- fake-cas-gateway
~~~

Expected: the suite loads and fails at atomic create, replace, delete, or conflict assertions. Module resolution and type errors do not count as RED.

- [ ] **Step 4: Implement the fake gateway**

FakeCasVaultGateway stores bytes and versions in memory, increments versions atomically, supports a beforeMutation hook for race injection, and implements all three operations as single critical sections.

- [ ] **Step 5: Implement the real adapter only from passed primitives**

Map the exact passed Phase 0 primitives to conditionalCreate, conditionalReplace, and conditionalDelete. Send If-Match only where the plugin contract proved it works. Check response status, then reread raw bytes. Do not infer support from OpenAPI text alone.

- [ ] **Step 6: Verify both adapters**

Run:

~~~bash
npm run test:unit -- fake-cas-gateway
ALLOW_OBSIDIAN_CONTRACT_WRITE=1 npm run test:contract:obsidian:probe -- write-adapter
npm run gate:write-capability
~~~

Expected: the fake adapter passes. The real adapter must pass every conformance assertion or Phase 3 stops with formal writes disabled.

- [ ] **Step 7: Commit**

~~~bash
git add src/server/vault tests
git commit -m "feat: add capability-proven CAS gateways"
~~~

### Task 5: Persist a self-contained crash-safe recovery manifest

**Files:**
- Create: src/server/workflow/recovery-manifest.ts
- Create: src/server/workflow/recovery-scan.ts
- Create: src/server/workflow/path-locks.ts
- Test: tests/unit/recovery-manifest.test.ts
- Test: tests/integration/recovery-scan.test.ts

- [ ] **Step 1: Write failing manifest tests**

Assert:

- manifest contains schemaVersion, batchId, planId, planHash, idempotency identity, candidateSetHash, complete ordered operations, before/after bytes, hashes, versions, current step, state, and checksum;
- write order is temp file, file fsync, atomic rename, parent-directory fsync;
- modes are directory 0700 and files 0600;
- truncated or checksum-invalid manifest blocks all involved paths;
- startup scans manifests before opening normal writes;
- two batches claiming the same path cannot both prepare;
- complete verified batches remove their manifest;
- failed batches retain it.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:unit -- recovery-manifest
npm run test:integration -- recovery-scan
~~~

Expected: both suites load and fail at manifest completeness, durability, checksum, scan, or path-claim assertions. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Implement atomic manifest serialization**

Use canonical JSON and base64 bytes. Never reference SQLite row ids without also embedding their immutable data. Validate a parsed manifest with Zod before acquiring path locks.

Write to:

~~~text
/Users/ao/Library/Application Support/xiaozhao-brain-console/recovery/{batchId}/manifest.json
~~~

Keep a second manifest.previous only while replacing current progress, and delete it after the new checksum verifies.

- [ ] **Step 4: Implement startup scan and path locks**

Sort normalized paths to prevent deadlock. recovery-scan returns clean, recovery_required, or corrupt_manifest. In the latter two cases, normal writes remain closed and the UI gets an actionable operation id.

- [ ] **Step 5: Verify green and commit**

Run:

~~~bash
npm run test:unit -- recovery-manifest
npm run test:integration -- recovery-scan
npm run typecheck
git add src/server/workflow/recovery-manifest.ts src/server/workflow/recovery-scan.ts src/server/workflow/path-locks.ts tests
git commit -m "feat: add self-contained write recovery manifests"
~~~

### Task 6: Implement WriteCoordinator with exhaustive crash injection

**Files:**
- Create: src/server/workflow/write-coordinator.ts
- Create: src/server/workflow/write-verifier.ts
- Create: src/server/workflow/fault-injector.ts
- Test: tests/integration/write-coordinator.test.ts
- Test: tests/integration/write-coordinator-crash.test.ts
- Test: tests/integration/write-coordinator-replay.test.ts

- [ ] **Step 1: Define explicit fault points**

fault-injector.ts exposes only test hooks:

~~~ts
export const FaultPoint = {
  AfterBatchInsert: 'after_batch_insert',
  AfterLocks: 'after_locks',
  AfterManifest: 'after_manifest',
  BeforeStep: 'before_step',
  AfterMutation: 'after_mutation',
  AfterStepReread: 'after_step_reread',
  BeforeSource: 'before_source',
  AfterSource: 'after_source',
  BeforeFinalVerify: 'before_final_verify',
  AfterCommitRecord: 'after_commit_record'
} as const;
~~~

Production construction uses a no-op injector.

- [ ] **Step 2: Write failing normal and replay tests**

Assert exact order:

~~~text
claim sorted paths
revalidate all before versions
persist full manifest
conditional knowledge operations with reread
conditional source operation last with reread
verify every knowledge source link
verify source generated links and status
record committed
refresh affected index rows
delete manifest
release paths
~~~

Double submit and two tabs return one batch. Replaying after a lost HTTP response returns the same committed batch.

- [ ] **Step 3: Write failing crash-window tests**

For every FaultPoint and every operation index:

- terminate the coordinator;
- restart from external manifest;
- compare current bytes to before and after;
- require a deterministic recoverable state;
- assert the UI never receives success before committed.

If source update fails after knowledge files exist, source remains at its before version and the batch is recovery_required.

- [ ] **Step 4: Run and verify red**

Run:

~~~bash
npm run test:integration -- write-coordinator
~~~

Expected: all suites load and fail at operation order, idempotency, crash-window, replay, or verification assertions. Module resolution and type errors do not count as RED.

- [ ] **Step 5: Implement the coordinator**

Use WriteRepository for state, RecoveryManifest for durable intent, MutableVaultGateway for CAS, and WriteVerifier for parsed/hash/link verification. On any exception after manifest preparation, stop immediately, persist recovery_required, and leave the manifest.

The coordinator never automatically rolls back.

- [ ] **Step 6: Verify green and commit**

Run:

~~~bash
npm run test:integration -- write-coordinator write-coordinator-crash write-coordinator-replay
npm run typecheck
git add src/server/workflow tests/integration
git commit -m "feat: execute crash-safe formal write batches"
~~~

### Task 7: Implement explicit continue and conditional rollback

**Files:**
- Create: src/server/workflow/recovery-service.ts
- Create: src/server/workflow/recovery-only-server.ts
- Test: tests/integration/recovery-service.test.ts
- Test: tests/integration/sqlite-unreadable-recovery.test.ts

- [ ] **Step 1: Write failing recovery tests**

For each step:

- current equals after means mark complete and advance;
- current equals before means retry with CAS;
- current equals neither means remain recovery_required;
- rollback replacement performs after to before CAS;
- rollback creation performs conditional delete only when current equals after;
- rollback order is reverse operation order;
- a second failure remains recovery_required;
- unrelated external changes are never overwritten;
- when SQLite is corrupt, manifest-only mode can show, continue, or roll back the batch;
- the damaged database is preserved.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:integration -- recovery-service sqlite-unreadable-recovery
~~~

Expected: both suites load and fail at continue, rollback, conflict, or manifest-only recovery assertions. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Implement recovery classification**

RecoveryService rereads every involved path before offering actions. It returns:

~~~ts
type RecoveryChoice = {
  canContinue: boolean;
  canRollback: boolean;
  conflicts: Array<{ path: string; expectedBefore?: string; expectedAfter: string; actual?: string }>;
};
~~~

Continue and rollback require expected batch version and a new idempotency key. Human-handled completion still performs full graph verification before closing.

- [ ] **Step 4: Implement recovery-only startup**

If SQLite integrity fails, serve only health, recovery list/detail, continue, rollback, and static recovery UI. Rebuild a new database only after a verified backup restore or explicit user confirmation to abandon non-write drafts. Reconcile the manifest result into the restored database.

- [ ] **Step 5: Verify green and commit**

Run:

~~~bash
npm run test:integration -- recovery-service sqlite-unreadable-recovery
npm run typecheck
git add src/server/workflow/recovery-service.ts src/server/workflow/recovery-only-server.ts tests
git commit -m "feat: recover write batches without trusting SQLite"
~~~

### Task 8: Expose plan, batch, operation, and recovery APIs

**Files:**
- Create: src/server/api/routes/write-plans.ts
- Create: src/server/api/routes/write-batches.ts
- Modify: src/server/api/routes/operations.ts
- Modify: src/server/api/routes/events.ts
- Modify: src/shared/api/schemas.ts
- Modify: src/server/app.ts
- Test: tests/integration/write-api.test.ts

- [ ] **Step 1: Write failing API tests**

Cover:

- POST /write-plans with expectedRunVersion and dispositions;
- GET plan includes complete diffs and protected-state blockers;
- POST /write-batches requires expectedPlanVersion and idempotency key;
- GET /write-batches/:id returns authoritative state and ordered steps;
- continue/rollback require expected batch version and CSRF;
- write gate closed returns 409 WRITE_GATE_CLOSED before any mutation;
- SSE resumes persisted write events or returns stream_reset;
- operation detail reveals hashes and paths but no bytes, source body, or keys.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:integration -- write-api
~~~

Expected: the suite loads and fails at route, gate, version, idempotency, snapshot, or SSE assertions. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Implement routes as service adapters**

Routes validate shared schemas, call planner/coordinator/recovery services, and return operationId plus resource versions. They never access the database or gateway directly. POST /write-batches checks the runtime mayWrite predicate again after service preflight.

- [ ] **Step 4: Verify green and commit**

Run:

~~~bash
npm run test:integration -- write-api
npm run typecheck
git add src/server/api src/shared/api src/server/app.ts tests/integration/write-api.test.ts
git commit -m "feat: expose versioned write and recovery APIs"
~~~

### Task 9: Build confirmation, diff, and recovery UI

**Files:**
- Create: src/client/pages/WriteConfirmationPage.tsx
- Create: src/client/components/write/DispositionControl.tsx
- Create: src/client/components/write/FileDiffViewer.tsx
- Create: src/client/components/write/WriteGate.tsx
- Create: src/client/components/write/BatchTimeline.tsx
- Create: src/client/components/write/RecoveryActions.tsx
- Modify: src/client/pages/OperationsPage.tsx
- Modify: src/client/pages/ConnectionsPage.tsx
- Test: tests/component/write-confirmation.test.tsx
- Test: tests/component/recovery-ui.test.tsx

- [ ] **Step 1: Write failing confirmation tests**

Assert:

- every accepted candidate chooses create, merge, or return/reject;
- protected matches disable merge and do not default to create;
- choosing a truly independent create requires explicit acknowledgement;
- target path, full YAML/body preview, line diff, source update, and all affected files display;
- candidate changes invalidate the plan and return to review;
- G2 blocked disables final confirmation with exact missing capabilities;
- busy prevents double submit while the server idempotency key remains the real guard;
- zero accepted shows one source-only diff;
- success appears only for committed;
- recovery_required navigates to a timeline with explicit continue and rollback.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:component -- write-confirmation recovery-ui
~~~

Expected: both suites load and fail at disposition, protected-state, gate, diff, submit, timeline, or recovery-action assertions. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Implement the confirmation flow**

DispositionControl renders match status and reasons. FileDiffViewer uses line diff output from the server; it does not recompute authoritative bytes in the browser. WriteGate lists plugin fingerprint, index freshness, recovery lock, plan versions, and explicit flag.

Final confirmation requires a visible summary and a deliberate button; long press, Enter on a card, or route navigation cannot execute a batch.

- [ ] **Step 4: Implement recovery UI**

BatchTimeline shows each persisted step, before/after hash prefixes, status, and operation id. RecoveryActions requires a second confirmation and fresh batch version. On stream_reset, refetch GET /write-batches/:id.

- [ ] **Step 5: Verify green and commit**

Run:

~~~bash
npm run test:component -- write-confirmation recovery-ui
npm run typecheck
git add src/client/pages src/client/components/write tests/component
git commit -m "feat: add formal write confirmation and recovery UI"
~~~

### Task 10: Prove the complete batch in the independent test vault

**Files:**
- Create: tests/e2e/test-vault-write-flow.spec.ts
- Create: tests/e2e/test-vault-conflict.spec.ts
- Create: tests/e2e/test-vault-crash-recovery.spec.ts
- Create: docs/contracts/test-vault-write-acceptance.md

- [ ] **Step 1: Guard the E2E suite**

Reuse assertContractTestVault. Require WRITE_ENABLED=true, G2 passed for the exact fingerprint, ALLOW_OBSIDIAN_CONTRACT_WRITE=1, and a random sandbox prefix. Refuse /Users/ao/我的大脑 by realpath and sentinel.

- [ ] **Step 2: Test new, merge, and zero-accept batches**

Run three independent sandbox sources:

1. new knowledge with bidirectional links;
2. AI总结 merge with S1/S2 mapping;
3. all candidates rejected with source-only 已入库.

After each, reread raw bytes and parse both sides. Verify source body bytes are identical.

- [ ] **Step 3: Test conflict and crash recovery**

Use a second REST client to change a target after plan creation. The batch must stop before overwrite. Repeat with process termination at each real integration fault point, restart the service, and explicitly continue or roll back.

Perform the documented human Obsidian restart between prepare and verify. No passing report exists until the post-restart verification command succeeds.

- [ ] **Step 4: Run guarded E2E**

Run:

~~~bash
ALLOW_OBSIDIAN_CONTRACT_WRITE=1 WRITE_ENABLED=true npm run test:e2e -- test-vault
~~~

Expected: every batch, conflict, crash, restart, continue, and rollback test passes; all sandbox notes are moved to trash; no formal-vault path appears in the trace.

- [ ] **Step 5: Record evidence and commit**

Write docs/contracts/test-vault-write-acceptance.md with plugin fingerprint, test names, timestamps, and pass/fail summary. Exclude keys and note bodies.

~~~bash
git add tests/e2e docs/contracts
git commit -m "test: prove crash-safe writes in the test vault"
~~~
