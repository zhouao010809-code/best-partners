# Phase 1 Atomic Filesystem and Recovery Kernel Implementation Plan

> **Accepted personal-path amendment, 2026-09-05:** The user explicitly accepted
> trusting the installed personal App/module at launch. For personal intake only,
> the historical standalone-executable/never-N-API requirements below are
> superseded by [the personal intake plan](2026-09-05-personal-intake-app.md).
> This does not authorize knowledge writes or weaken no-overwrite, source-body,
> attachment and interruption-recovery protections. The historical plan is not
> otherwise declared implemented.

> **Execution preflight, 2026-09-05:** The verified-descriptor execution contract
> in Task 3 is blocked on the current macOS host. See
> [read acceptance and preflight evidence](2026-09-05-real-vault-read-acceptance.md).
> Review the native execution boundary before implementing this plan; do not
> replace descriptor execution with an unapproved pathname fallback.
> A bundled Node-API replacement has since passed isolated feasibility probes;
> [replacement boundary and next work](2026-09-05-native-write-replacement-preflight.md)
> records the required trust-model amendment. It is not production enablement.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove and implement fail-closed formal-file primitives for the current macOS filesystem using a standalone C helper, then build immutable plans, a hash-chained intent/result journal, an ordered coordinator, and SQLite-independent crash recovery that can mutate only a sentinel-marked independent test vault.

**Architecture:** Raw before/after bytes live outside the vault in a private self-contained recovery directory. Extend Phase 0's read-only arm64 Mach-O helper—without weakening its descriptor-anchored read commands—with an internal hidden-inclusive tree-inspection surface, `RENAME_SWAP`, `RENAME_EXCL`, one-level `mkdirat`, identity-bound empty-directory retirement, bounded private-recovery file operations, `RENAME_NOFOLLOW_ANY`, and directory `fsync`. TypeScript owns canonical plans, hashes, schemas, capability profiles, and transaction ordering, but never opens a vault or recovery entry by reconstructed pathname. The write gate passes only when helper, macOS, architecture, target volume, primitive probes, conflict preservation, and crash evidence match one immutable profile.

**Tech Stack:** C11, macOS `renameatx_np`, TypeScript 6, Node.js 22, better-sqlite3, Zod 4, Vitest, SHA-256 canonical JSON, subprocess crash harnesses.

---

## Scope and fixed boundaries

- Start after Phase 0 direct-read Electron runtime is green.
- Use a standalone C executable, never N-API or another Node addon.
- Automated mutations require `.xiaozhao-atomic-test-vault.json` in an independent test vault.
- Reject `~/我的大脑`, the configured formal root, missing or symlinked sentinels, and nested app-data/vault paths before starting the helper.
- Never fall back to overwrite `rename`, `copyFile`, unlink-before-rename, or SQLite-only recovery.
- macOS does not provide an expected-inode compare-and-swap rename. The proven invariant is therefore precise: preflight binds the expected entries; the native rename is atomic and non-overwriting; postflight rechecks both names; any external race is never reported as success, and all observed versions are preserved or the batch stops for manual recovery. Do not claim that an uncooperative process can never cause a transient exchange between the last precheck and `renameatx_np`.
- A profile authorizes only the exact helper SHA, OS build, architecture, and target-volume identity it proves.
- The coordinator receives a server-internal authorization from `MutationTargetPolicy`; it never reads `NODE_ENV` or an environment write switch.
- The coordinator also receives Phase 0's `RuleCompatibilityGate` and a read-only current-bundle loader. It requires `plan.ruleBundleSha256` to equal the freshly loaded bundle and its explicit approved record before manifest preparation, before every helper call, and before final verification/finalization; no gate implementation defaults to allow.
- This phase implements only `SentinelTestMutationPolicy`. It does not implement production authority; the packaging phase later injects that from Electron main.
- This phase exposes no intake, AI, editor, extraction, or user-facing write endpoint.
- Migration `003_write_kernel.sql` belongs to this phase; every later migration starts at `004`.
- Final app packaging and helper placement in an `.app` are deferred to the packaging phase.

## File map

**Create:**

- `scripts/gate-filesystem-write-capability.ts`
- `src/shared/domain/write.ts`
- `src/server/vault/atomic-helper-protocol.ts`
- `src/server/vault/AtomicFileHelper.ts`
- `src/server/vault/PrivateRecoveryStore.ts`
- `src/server/vault/native-helper-path.ts`
- `src/server/vault/native-capability-profile.ts`
- `src/server/vault/native-capability-probe.ts`
- `src/server/vault/MutationTargetPolicy.ts`
- `src/server/vault/FileSystemVaultWriter.ts`
- `src/server/recovery/recovery-manifest.ts`
- `src/server/recovery/recovery-journal.ts`
- `src/server/recovery/recovery-scanner.ts`
- `src/server/workflow/write-planner.ts`
- `src/server/workflow/write-verifier.ts`
- `src/server/workflow/write-intent-registry.ts`
- `src/server/workflow/write-repository.ts`
- `src/server/workflow/write-coordinator.ts`
- `src/server/workflow/recovery-service.ts`
- `src/server/db/migrations/003_write_kernel.sql`
- `tests/helpers/atomic-test-vault.ts`
- `tests/helpers/native-helper-harness.ts`
- `tests/helpers/write-crash-worker.ts`
- `tests/native/atomic-file-helper.contract.test.ts`
- `tests/unit/atomic-helper-protocol.test.ts`
- `tests/unit/private-recovery-store.test.ts`
- `tests/unit/native-capability-profile.test.ts`
- `tests/unit/write-plan.test.ts`
- `tests/unit/recovery-journal.test.ts`
- `tests/integration/native-capability-gate.test.ts`
- `tests/integration/write-kernel.test.ts`
- `tests/integration/write-recovery-crash.test.ts`

**Modify:** `native/macos/atomic-file-helper.c`, `scripts/build-native-helper.ts`, `package.json`, `package-lock.json`, `src/server/db/migrate.ts`, `src/server/db/database.ts`, `src/server/vault/native-read-helper-protocol.ts`, `src/server/vault/NativeReadVaultPort.ts`, `src/server/vault/VaultGateway.ts`, `src/server/services/health-service.ts`, `src/shared/api/schemas.ts`, and their focused tests.

## Durable layout and helper protocol

```text
<userData>/recovery-preparing/<batchId>.<nonce>/
  manifest.json
  blobs/<sha256>.bin
  staging/                       # file and empty-directory sources
  retained/
  journal.ndjson

<userData>/recovery/<batchId>/
  manifest.json
  blobs/<sha256>.bin
  staging/<ordinal>-<file-hash-prefix-or-mkdir>
  retained/<step-ordinal>-<version-role>
  journal.ndjson
```

Directories are `0700`; files are `0600`. A batch is first built under the private `recovery-preparing` root. Manifest and blobs are exclusive-created, fsynced, reread, and followed by parent-directory fsync; only then may the helper move that complete directory exclusively to `recovery/<batchId>` and fsync both parents. Therefore every visible active batch already has a valid immutable manifest. A preparing directory is never an active batch and can be retired only after no active batch with that ID exists and the scanner proves no vault mutation/journal intent was possible; retirement is an exclusive identity-bound move to private `<userData>/abandoned-preparations`, never recursive deletion. The recovery root and vault must have the same `st_dev`; otherwise the write gate is blocked because old inodes cannot be retired with `RENAME_EXCL`. Each newline-terminated journal entry hashes its canonical body and previous entry hash. Persisted intent precedes mutation; result follows helper completion, retirement, directory fsync, reread, and verification.

```text
atomic-file-helper swap <bound-directory> <left-basename> <expected-left-dev> <expected-left-ino> <right-basename> <expected-right-dev> <expected-right-ino>
atomic-file-helper move-excl <bound-from-directory> <from-basename> <expected-source-dev> <expected-source-ino> <bound-to-directory> <to-basename>
atomic-file-helper mkdir-excl <bound-private-staging-directory> <staging-basename>
atomic-file-helper rmdir-created-empty <bound-vault-parent> <basename> <expected-dev> <expected-ino> <bound-private-retained-directory> <retained-basename>
atomic-file-helper fsync-dir <bound-directory>
atomic-file-helper list-dir-all <bound-directory>
atomic-file-helper scan-tree-private <bound-directory>
atomic-file-helper private-create-file <bound-private-directory> <basename> <expected-length> <expected-sha256>
atomic-file-helper private-read-file <bound-private-directory> <basename> <expected-dev> <expected-ino> <maximum-length>
atomic-file-helper private-append-file <bound-private-directory> <basename> <expected-dev> <expected-ino> <expected-size> <append-length> <append-sha256>
```

`<bound-directory>` is exactly `v1:<root-dev>:<root-ino>:<directory-dev>:<directory-ino>:<absolute-root-utf8-hex>:<relative-directory-utf8-hex>`, with lowercase hex, decimal unsigned identities, a 16 KiB total bound, and no empty/extra field. The TypeScript client creates it, and the helper strictly decodes it before filesystem access. `normalizedRelativeDirectory` is `.` for the bound root or an NFC relative component sequence with no empty/dot segment; the public read gateway still rejects hidden segments, while only the private inspection/recovery APIs may traverse a manifest-bound hidden segment. The helper opens the absolute root from `/`, matches root dev/ino, walks relative components with held `openat(...O_NOFOLLOW)` descriptors while requiring every component to stay on the bound root device, then matches the final parent dev/ino. No command accepts an unbound absolute child directory. `list-dir-all` returns every direct entry except `.`/`..`, including hidden entries, as a strict discriminated record. `scan-tree-private` performs the complete recursive walk in one native process: it holds each parent descriptor, snapshots and sorts its full direct-entry identity/type/name set before descending, re-enumerates it afterwards, and fails if the set or directory identity/times changed. It follows only real same-device directories, reads only real regular files with stat/read/stat, records symlink identity plus `readlinkat` target hash without following it, rejects special entries, and returns one bounded canonical full-tree frame. Package policy rejects hidden/symlink records; later read-only acceptance may include them as evidence. The public Phase 0 `list-dir` behavior remains unchanged.

`swap` binds both preflight entry identities; `move-excl` binds the source entry identity and reports the post-move identity. Because `renameatx_np` has no expected-inode CAS, a post-operation mismatch never triggers an automatic reverse inside the helper. The helper preserves both names as observed and returns `ESTALE`; the coordinator rescans and journals the two locations. Only a later, separately authorized recovery plan may reverse after rebinding both current locations to the exact expected post-rename identities and proving the destination absent or the exact exchange peer, again with non-overwriting semantics and postflight checks. The helper prints one bounded JSON line with operation, success, observed identity where required, and errno only; never paths or contents.

`private-create-file` and `private-append-file` consume exactly the declared byte count from stdin, compute SHA-256 in the helper, operate relative to the held private directory with `openat(...O_NOFOLLOW)`, fsync, reread through the same descriptor, and return identity/size/hash. `private-read-file` returns the existing framed payload only after stat/read/stat identity stability. `PrivateRecoveryStore` is the only TypeScript caller of these private commands; it binds the app-data root plus preparing/active batch directory identities and exposes exclusive create, verified append/read, complete list, bound mkdir/move, and directory fsync. It never accepts an arbitrary absolute child path.

### Task 1: Define write types and migration 003

**Files:**
- Create: `src/shared/domain/write.ts`
- Create: `src/server/db/migrations/003_write_kernel.sql`
- Create: `tests/unit/write-plan.test.ts`
- Modify: `src/server/db/migrate.ts`
- Modify: `tests/integration/database-kernel.test.ts`

- [ ] **Step 1: Write failing type and migration tests**

Use this fixture and assert non-contiguous ordinals, invalid hashes, duplicate targets, and a source-status step before knowledge fail validation. Add a directory-package fixture whose entries are sorted by NFC relative path; changing, adding, or deleting any package file or empty directory must change `treeSha256`. A hidden file, hidden directory, hidden symlink, visible symlink, socket, FIFO, device, cross-device descendant, or root-inode replacement must reject the package rather than disappear from its version:

```ts
const step: WriteStep = {
  ordinal: 0,
  kind: 'replace',
  role: 'knowledge',
  path: '02知识库/方法/测试.md',
  expectedBefore: {
    path: '02知识库/方法/测试.md', exists: true,
    rawSha256: 'a'.repeat(64), byteLength: 10
  },
  after: { rawSha256: 'b'.repeat(64), byteLength: 12, blobSha256: 'b'.repeat(64) }
};
```

Extend `database-kernel.test.ts` to require tables `write_plans`, `write_batches`, and `write_step_results`, with no BLOB column. Insert an audit row under migration 001 before applying 003, then prove its integer ID and `payload_json` remain unchanged and nullable `batch_id` is added.

- [ ] **Step 2: Run tests and verify RED**

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/write-plan.test.ts
npm exec -- vitest run --config vitest.integration.config.ts tests/integration/database-kernel.test.ts
```

Expected: FAIL because the shared domain and migration 003 do not exist.

- [ ] **Step 3: Implement the shared domain**

Create `src/shared/domain/write.ts` with runtime Zod schemas for these exact types:

```ts
export type FileVersion = {
  readonly path: string;
  readonly exists: boolean;
  readonly rawSha256?: string;
  readonly byteLength?: number;
  readonly modifiedAt?: string;
};

export type PlannedBytes = {
  readonly rawSha256: string;
  readonly byteLength: number;
  readonly blobSha256: string;
};

export type DirectoryTreeEntry =
  | {
      readonly type: 'file'; readonly relativePath: string;
      readonly rawSha256: string; readonly byteLength: number;
      readonly modifiedAt?: string;
    }
  | { readonly type: 'directory'; readonly relativePath: string };
export type DirectoryTreeVersion = {
  readonly path: string;
  readonly exists: true;
  readonly rootIdentity: DirectoryIdentity;
  readonly entries: readonly DirectoryTreeEntry[];
  readonly treeSha256: string;
};
export type FileIdentity = { readonly dev: string; readonly ino: string };
export type DirectoryIdentity = { readonly dev: string; readonly ino: string };

type Base = {
  readonly ordinal: number;
  readonly role: 'knowledge' | 'source-status' | 'intake' | 'recovery';
  readonly recoveryOfOrdinal?: number;
};
export type ReplaceStep = Base & {
  readonly kind: 'replace'; readonly path: string;
  readonly expectedBefore: FileVersion & { readonly exists: true; readonly rawSha256: string };
  readonly after: PlannedBytes;
};
export type CreateStep = Base & {
  readonly kind: 'create'; readonly path: string;
  readonly expectedBefore: FileVersion & { readonly exists: false };
  readonly after: PlannedBytes;
};
export type MoveExclusiveFileStep = Base & {
  readonly kind: 'move-exclusive'; readonly entryKind: 'file';
  readonly fromPath: string; readonly toPath: string;
  readonly expectedFrom: FileVersion & { readonly exists: true; readonly rawSha256: string };
  readonly expectedTo: FileVersion & { readonly exists: false };
};
export type MoveExclusiveDirectoryStep = Base & {
  readonly kind: 'move-exclusive'; readonly entryKind: 'directory';
  readonly fromPath: string; readonly toPath: string;
  readonly expectedFromTree: DirectoryTreeVersion;
  readonly expectedTo: FileVersion & { readonly exists: false };
};
export type MoveExclusiveStep = MoveExclusiveFileStep | MoveExclusiveDirectoryStep;
export type MkdirExclusiveStep = Base & {
  readonly kind: 'mkdir-exclusive';
  readonly path: string;
  readonly expectedBefore: FileVersion & { readonly exists: false };
};
export type RmdirCreatedEmptyStep = Base & {
  readonly kind: 'rmdir-created-empty';
  readonly path: string;
  readonly expectedIdentity: DirectoryIdentity;
  readonly createdByBatchId: string;
};
export type RetireCreatedFileStep = Base & {
  readonly kind: 'retire-created-file';
  readonly path: string;
  readonly expectedCurrent: FileVersion & {
    readonly exists: true; readonly rawSha256: string;
  };
  readonly expectedIdentity: FileIdentity;
  readonly createdByBatchId: string;
};
export type WriteStep =
  | ReplaceStep | CreateStep | MoveExclusiveStep
  | MkdirExclusiveStep | RmdirCreatedEmptyStep | RetireCreatedFileStep;
export type ObservedStepResult =
  | { readonly kind: 'replace'; readonly target: FileVersion & { readonly exists: true } }
  | { readonly kind: 'create'; readonly target: FileVersion & { readonly exists: true };
      readonly identity: FileIdentity }
  | { readonly kind: 'move-exclusive-file';
      readonly source: FileVersion & { readonly exists: false };
      readonly target: FileVersion & { readonly exists: true } }
  | { readonly kind: 'move-exclusive-directory';
      readonly source: FileVersion & { readonly exists: false };
      readonly target: DirectoryTreeVersion }
  | { readonly kind: 'mkdir-exclusive'; readonly path: string;
      readonly identity: DirectoryIdentity }
  | { readonly kind: 'rmdir-created-empty'; readonly path: string;
      readonly exists: false; readonly removedIdentity: DirectoryIdentity }
  | { readonly kind: 'retire-created-file'; readonly path: string;
      readonly exists: false;
      readonly retained: FileVersion & { readonly exists: true; readonly rawSha256: string };
      readonly retainedIdentity: FileIdentity };
export type KernelTestWriteIntent = {
  readonly kind: 'kernel_test';
  readonly fixtureId: string;
  readonly purpose: 'replace' | 'create' | 'move-package' | 'mkdir';
};
export type KernelRecoveryWriteIntent = {
  readonly kind: 'kernel_recovery';
  readonly originalBatchId: string;
  readonly snapshotSha256: string;
  readonly direction: 'continue' | 'rollback' | 'resolve';
  readonly resolutionSha256?: string;
};
export type WriteIntent = KernelTestWriteIntent | KernelRecoveryWriteIntent;
export type WriteIntentKind = WriteIntent['kind'];
export type RecoverableOriginalIntentKind = Exclude<WriteIntentKind, 'kernel_recovery'>;
export type JsonValue =
  | null | boolean | number | string
  | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type DomainProjectionCapsule = {
  readonly schemaVersion: 1;
  readonly intentKind: RecoverableOriginalIntentKind;
  readonly payload: { readonly [key: string]: JsonValue };
  readonly payloadSha256: string;
};
export type WritePlan = {
  readonly schemaVersion: 1;
  readonly id: string; readonly createdAt: string; readonly ruleBundleSha256: string;
  readonly intent: WriteIntent;
  readonly steps: readonly WriteStep[]; readonly planSha256: string;
};
export type RecoveryObservedVersion =
  | { readonly kind: 'absent'; readonly versionId: string; readonly path: string }
  | { readonly kind: 'file'; readonly versionId: string; readonly path: string;
      readonly rawSha256: string; readonly byteLength: number;
      readonly identity: FileIdentity }
  | { readonly kind: 'directory'; readonly versionId: string; readonly path: string;
      readonly tree: DirectoryTreeVersion };
export type RecoveryResolutionSelection = {
  readonly choiceId: string;
  readonly path: string;
  readonly originalOrdinal: number;
  readonly current: RecoveryObservedVersion;
} & (
  | { readonly action: 'keep_current_file' | 'keep_current_topology' | 'keep_current_absent' }
  | { readonly action: 'select_version';
      readonly selectedSource: 'before' | 'after' | 'retained';
      readonly selected: Extract<RecoveryObservedVersion, { readonly kind: 'file' }> }
  | { readonly action: 'select_absent_before_create';
      readonly selected: Extract<RecoveryObservedVersion, { readonly kind: 'absent' }> }
);
export type WriteBatchState =
  | 'planned' | 'prepared' | 'executing' | 'recovery-required'
  | 'committed' | 'rolled-back' | 'manually-resolved';
type JournalBase = {
  readonly batchId: string; readonly seq: number;
  readonly previousEntrySha256: string | null;
  readonly recordedAt: string;
};
export type StepJournalEntryBody = JournalBase & (
  | {
      readonly kind: 'intent'; readonly stepOrdinal: number;
      readonly stepKind: WriteStep['kind']; readonly canonicalStepSha256: string;
      readonly stagingBasename?: string;
    }
  | {
      readonly kind: 'staging-source'; readonly stepOrdinal: number;
      readonly rawSha256: string; readonly byteLength: number;
      readonly observedFileIdentity: FileIdentity;
    }
  | {
      readonly kind: 'directory-staging-source'; readonly stepOrdinal: number;
      readonly observedDirectoryIdentity: DirectoryIdentity;
    }
  | {
      readonly kind: 'staged'; readonly stepOrdinal: number;
      readonly entryKind: 'file'; readonly observedFileIdentity: FileIdentity;
    }
  | {
      readonly kind: 'staged'; readonly stepOrdinal: number;
      readonly entryKind: 'directory'; readonly observedDirectoryIdentity: DirectoryIdentity;
    }
  | {
      readonly kind: 'observed-version-intent'; readonly stepOrdinal: number;
      readonly role: 'unexpected-exchanged-old'; readonly rawSha256: string;
      readonly byteLength: number; readonly evidenceBasename: string;
      readonly sourceIdentity: FileIdentity;
    }
  | {
      readonly kind: 'observed-version'; readonly stepOrdinal: number;
      readonly role: 'unexpected-exchanged-old'; readonly rawSha256: string;
      readonly byteLength: number; readonly blobSha256: string;
      readonly sourceIdentity: FileIdentity; readonly evidenceIdentity: FileIdentity;
    }
  | {
      readonly kind: 'result'; readonly stepOrdinal: number;
      readonly outcome: 'committed' | 'conflict' | 'failed';
      readonly observedResult: ObservedStepResult;
      readonly observedResultSha256: string;
    }
);
type AuthorizationJournalCommon = {
  readonly kind: 'authorization';
  readonly policyId: string;
  readonly operation: 'execute' | 'continue' | 'rollback' | 'resolve';
  readonly intentKind: WriteIntentKind;
  readonly planId: string; readonly planSha256: string;
  readonly canonicalScopeSha256: string;
  readonly targetRootIdentitySha256: string;
  readonly appDataRootIdentitySha256: string;
  readonly recoveryRootIdentitySha256: string;
  readonly profileKey: string; readonly ruleBundleSha256: string;
  readonly authorizationSha256: string;
  readonly manifestSha256: string; readonly projectionCapsuleSha256: string;
  readonly originalIntentKind: RecoverableOriginalIntentKind | null;
  readonly recoverySnapshotSha256: string | null;
  readonly resolutionSha256: string | null;
};
type AuthorizationJournalProvenance =
  | {
      readonly authorizationKind: 'sentinel-test';
      readonly productionEvidenceSha256: null;
      readonly nativeGrantScopeSha256: null;
      readonly confirmedAt: null;
    }
  | {
      readonly authorizationKind: 'automatic-intake';
      readonly productionEvidenceSha256: string;
      readonly nativeGrantScopeSha256: null;
      readonly confirmedAt: null;
    }
  | {
      readonly authorizationKind: 'native-grant';
      readonly productionEvidenceSha256: string;
      readonly nativeGrantScopeSha256: string;
      readonly confirmedAt: string;
    };
export type AuthorizationJournalEntryBody =
  JournalBase & AuthorizationJournalCommon & AuthorizationJournalProvenance;
type NonAuthorizationBatchJournalEntryBody = JournalBase & (
  | {
      readonly kind: 'resolution'; readonly direction: 'resolve';
      readonly originalBatchId: string; readonly snapshotSha256: string;
      readonly resolutionSha256: string;
      readonly selections: readonly RecoveryResolutionSelection[];
    }
  | {
      readonly kind: 'projection-pending';
      readonly originalBatchId: string; readonly recoveryBatchId: string;
      readonly originalIntentKind: RecoverableOriginalIntentKind;
      readonly direction: 'continue' | 'rollback' | 'resolve';
      readonly originalPlanSha256: string; readonly resolutionSha256?: string;
      readonly affectedPathsSha256: string; readonly observedOutcomeSha256: string;
    }
  | {
      readonly kind: 'terminal'; readonly completionKind: 'clean_commit';
      readonly planSha256: string; readonly diskSnapshotSha256: string;
      readonly finalizerProjectionSha256: string; readonly projectionCapsuleSha256: string;
      readonly coreOutcome: 'committed';
      readonly completedAt: string;
    }
  | {
      readonly kind: 'terminal'; readonly completionKind: 'recovery_continue';
      readonly planSha256: string; readonly diskSnapshotSha256: string;
      readonly finalizerProjectionSha256: string; readonly projectionCapsuleSha256: string;
      readonly recoveryBatchOutcome: 'committed';
      readonly originalBatchOutcome: 'committed';
      readonly completedAt: string; readonly originalBatchId: string;
      readonly originalIntentKind: RecoverableOriginalIntentKind;
    }
  | {
      readonly kind: 'terminal'; readonly completionKind: 'recovery_rollback';
      readonly planSha256: string; readonly diskSnapshotSha256: string;
      readonly finalizerProjectionSha256: string; readonly projectionCapsuleSha256: string;
      readonly recoveryBatchOutcome: 'committed';
      readonly originalBatchOutcome: 'rolled-back';
      readonly completedAt: string; readonly originalBatchId: string;
      readonly originalIntentKind: RecoverableOriginalIntentKind;
    }
  | {
      readonly kind: 'terminal'; readonly completionKind: 'manual_resolve';
      readonly planSha256: string; readonly diskSnapshotSha256: string;
      readonly finalizerProjectionSha256: string; readonly projectionCapsuleSha256: string;
      readonly recoveryBatchOutcome: 'committed';
      readonly originalBatchOutcome: 'manually-resolved';
      readonly completedAt: string; readonly originalBatchId: string;
      readonly originalIntentKind: RecoverableOriginalIntentKind;
    }
);
export type BatchJournalEntryBody =
  | AuthorizationJournalEntryBody
  | NonAuthorizationBatchJournalEntryBody;
export type JournalEntryBody = StepJournalEntryBody | BatchJournalEntryBody;
export type JournalEntry = JournalEntryBody & { readonly entrySha256: string };
```

`FileIdentity` and `DirectoryIdentity` are `{ readonly dev: string; readonly ino: string }`. `DirectoryTreeVersion.entries` includes every allowed regular file and every allowed nested directory, including empty directories, under the package; `rootIdentity` binds the package directory itself. The internal `list-dir-all` inspection sees hidden, symlink, and special entries before filtering: any hidden path segment, symlink, special file, cross-device child, unstable identity, or malformed name rejects the entire package, so it can never be moved as unversioned baggage. Normalize allowed relative paths to NFC, sort by UTF-8 byte order, then hash canonical discriminated records: files bind `{ type, relativePath, rawSha256, byteLength, modifiedAt? }`, directories bind `{ type, relativePath }`, and the enclosing version also binds `rootIdentity`. Adding, deleting, or renaming an empty directory changes `treeSha256`; directory mtime alone is never a package version.

`ObservedStepResult` is the exhaustive post-helper observation contract. `WriteVerifier` must switch on both step kind and this discriminant and reject mismatched pairs; no directory, absence, or retained-file result is squeezed into `VersionedBytes`.

The journal schema is a strict discriminated union. The implementation defines one recursively strict `authorizationJournalCommonSchema`, intersects it into three strict objects discriminated by `authorizationKind`, and exports `AuthorizationJournalEntryBody` from `z.infer<typeof authorizationJournalEntryBodySchema>`; the TypeScript shape above is the exact resulting contract, not a separately maintained permissive type. Thus sentinel can compile/parse only with all three provenance fields `null`, automatic only with production evidence plus null native scope/time, and native only with all three required strings. The operation-dependent fields are always present and canonicalized as explicit `null`: `execute` requires `originalIntentKind`, `recoverySnapshotSha256`, and `resolutionSha256` all null; `continue`/`rollback` require `intentKind:'kernel_recovery'`, non-null original intent/snapshot and null resolution; `resolve` additionally requires non-null resolution. Every step kind has its own required fields and rejects every field owned by another branch; step records require `stepOrdinal`, while batch records forbid it. Authorization records contain only redacted provenance—never a token, Electron session ID, absolute root, or file bytes—but bind the immutable manifest and projection capsule. Their required `intentKind` is copied from the branded authorization and must equal `manifest.plan.intent.kind`; omission or drift makes the graph corrupt before any hash is trusted. A resolve plan, including a zero-step keep-current plan, requires one durable `resolution` record before any helper call or finalization. That record contains the complete, UTF-8-path-sorted selection map, not merely a count: each server-issued opaque choice ID is bound to its relative path, original ordinal, exact current file/tree/absence version, action, and any selected before/after/retained known version. Recompute `resolutionSha256` from `{ schemaVersion: 1, originalBatchId, snapshotSha256, selections }`; missing paths, duplicate paths/choice IDs, changed ordering, unknown provenance, or a hash mismatch is invalid/manual-only. It carries no raw bytes or absolute paths.

The immutable manifest also contains one `DomainProjectionCapsule` created and strictly parsed by the original intent handler before authorization and before vault mutation. The core envelope is hash-bound; each registered handler owns an exact, versioned Zod payload schema and rejects unknown fields. Later phases must include only the durable IDs, reducer inputs, bindings, policy/rule references, and deterministic projection facts needed to rebuild that workflow after SQLite deletion—never model keys, auth tokens, absolute roots, or duplicate raw source bodies. For an ordinary plan the capsule kind equals `plan.intent.kind`; for `kernel_recovery` it equals the validated original manifest's non-recovery intent kind. Its digest is included in manifest, authorization, finalizer receipt, and terminal verification. A handler that cannot build or validate its capsule blocks preparation.

A matching `observed-version-intent` plus `observed-version` result is the only way an immutable manifest may acquire a post-manifest conflict blob: together they bind the stable descriptor-read source identity, content hash/length, deterministic exclusive evidence name/inode, and original step; any unreferenced extra blob is corrupt/manual-only. `projection-pending` is the SQLite-independent handoff used only after recovery disk convergence when the original intent projection cannot yet run; its stable digest makes replay idempotent. After final disk verification and the idempotent original-intent finalizer, append and fsync exactly one `terminal` record before transitioning SQLite. Its one timestamp and digests are the SQLite-independent authority for replaying the intended core outcome; the immutable manifest is never extended with results or terminal state.

`mkdir-exclusive` creates one missing directory level only; a plan contains one ordered step per missing `来源平台/YYYY-MM` component and never pre-creates unused months. `rmdir-created-empty` is legal only in a `kernel_recovery` plan, only for a directory created by the same original batch, and only with the exact recorded dev/ino identity. `retire-created-file` is likewise recovery-only: it may remove an original `create` result from the vault only by an identity/hash-bound exclusive move into that batch's private retained area, never by unlinking it. Every recovery step carries `recoveryOfOrdinal`, while ordinary plans forbid that field. Recovery-plan ordinals are their own contiguous `0..n-1`; `recoveryOfOrdinal` is the immutable link back to the original step. `resolutionSha256` is required only for `direction:'resolve'` and hashes the durable `RecoveryResolutionSelection[]`; it is forbidden for continue/rollback. A zero-step plan is legal only for `direction:'resolve'` when every path choice keeps the exact current version and the current snapshot still matches that map. Mixed file/directory/absence decisions are legal because the selection unit is one path, not one request-wide mode. For an unknown/drifted directory-package tree or a created directory that gained external content, V1 exposes only an exact snapshot-bound `keep_current_topology` choice: it emits no filesystem step, preserves all entries, marks the original workflow conflict/needs-review, and never claims that an unstored old tree can be selected.

`WriteIntent` in this file is the single extension point used by all later workflow phases. Phase 2 appends an `IntakeWriteIntent` member, Phase 4 appends `ExtractionBatchWriteIntent`, and Phase 5 appends one `KnowledgeEditWriteIntent` whose `mode: 'restore'` represents user-visible history restoration; it does not add a separate reverse kind. Later phases must not add a payload wrapper, another coordinator, or a parallel intent union. Incomplete-batch continue/rollback remains the internal `kernel_recovery` intent defined here.

- [ ] **Step 4: Add and register migration 003**

```sql
CREATE TABLE write_plans (
  id TEXT PRIMARY KEY,
  plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256) = 64),
  rule_bundle_sha256 TEXT NOT NULL CHECK(length(rule_bundle_sha256) = 64),
  plan_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE write_batches (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES write_plans(id),
  state TEXT NOT NULL CHECK(state IN ('planned','prepared','executing','recovery-required','committed','rolled-back','manually-resolved')),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE write_step_results (
  batch_id TEXT NOT NULL REFERENCES write_batches(id),
  step_ordinal INTEGER NOT NULL CHECK(step_ordinal >= 0),
  intent_entry_sha256 TEXT CHECK(length(intent_entry_sha256) = 64),
  result_entry_sha256 TEXT CHECK(length(result_entry_sha256) = 64),
  outcome TEXT CHECK(outcome IN ('committed','conflict','failed')),
  PRIMARY KEY(batch_id, step_ordinal)
);
ALTER TABLE audit_events
  ADD COLUMN batch_id TEXT REFERENCES write_batches(id);
CREATE INDEX write_batches_state_idx ON write_batches(state, updated_at);
CREATE INDEX write_plans_sha_idx ON write_plans(plan_sha256);
CREATE INDEX audit_events_batch_idx ON audit_events(batch_id, created_at);
```

Migration 001 already owns `audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id, event_type, payload_json, created_at)`. Migration 003 must reuse it exactly: add only nullable `batch_id`, keep `payload_json` and integer IDs, and never recreate or rename the table. Register version 3 after version 2. Add a source comment that subsequent migrations begin at 004.

- [ ] **Step 5: Run tests and commit**

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/write-plan.test.ts
npm exec -- vitest run --config vitest.integration.config.ts tests/integration/database-kernel.test.ts
git add src/shared/domain/write.ts src/server/db/migrations/003_write_kernel.sql src/server/db/migrate.ts tests/unit/write-plan.test.ts tests/integration/database-kernel.test.ts
git commit -m "feat: define write kernel domain"
```

Expected: tests pass; SQLite contains projections but no unique recovery bytes.

### Task 2: Build and contract-test the standalone C helper

**Files:**
- Modify: `native/macos/atomic-file-helper.c`
- Modify: `scripts/build-native-helper.ts`
- Modify: `src/server/vault/native-read-helper-protocol.ts`
- Modify: `src/server/vault/NativeReadVaultPort.ts`
- Create: `tests/helpers/native-helper-harness.ts`
- Create: `tests/native/atomic-file-helper.contract.test.ts`
- Modify: `tests/unit/native-read-helper-protocol.test.ts`
- Modify: `tests/native/native-read-helper.contract.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing native contracts**

Test swap yields `BBB/AAA`; exclusive move onto an existing target returns errno 17 while source and target remain exact; absent-target move succeeds; private-staging mkdir returns created dev/ino, mode `0700`, and `EEXIST` on collision; the writer then lands only that exact empty inode into the vault through identity-bound `move-excl`. Strict recovery rmdir succeeds only for the recorded identity and an empty directory by moving it into the private retained directory; the helper never unlinks it. Rmdir must refuse wrong batch identity, non-empty directories, and directories replaced after creation while preserving them. Reject `.`, `..`, names containing `/`, absolute basenames, malformed bound-directory encodings, wrong root dev/ino, wrong final-parent dev/ino, a final or ancestor symlink, repeated/empty path segments, a same-device parent-path replacement, a descendant on another device, wrong source-entry identity, and cross-device move.

Add `list-dir-all` and `scan-tree-private` contracts that return hidden regular files/directories and symlink metadata without following them, reject special/cross-device entries, detect parent/member changes during recursion, and preserve Phase 0 public `list-dir` output byte-for-byte. Tree consumers must reject hidden file/dir/symlink/socket/FIFO fixtures before any package move. Add a race harness that replaces the authorized root or parent pathname after `MutationTargetPolicy.assertCurrent()` but before helper open, and another that replaces a pathname after helper descriptors are opened. Before `renameatx_np`, a mismatch must fail; in the unavoidable final-check-to-rename window, the result may be the exact expected atomic rename or a detected external-race incident, but never silent success. The original command never auto-reverses; a later recovery command is permitted only after its own durable intent and exact rebinding of both locations, and is itself exclusive. Otherwise every observed entry remains for manual recovery. Add a `mkdirat`→identity-observation race inside private staging; target landing accepts only the returned identity. Assert stdout contains neither fixture paths nor bytes.

Use the harness to express the observable contract without calling the helper through a shell:

```ts
const harness = await createNativeHelperHarness();

it('swaps exact inodes and never reports a raced replacement as success', async () => {
  const pair = await harness.createSwapPair({ left: 'AAA', right: 'BBB' });
  const result = await harness.swap(pair, {
    afterDescriptorsOpen: () => harness.replaceAuthorizedParentPath()
  });
  expect(result.ok === true || result.errno === ESTALE).toBe(true);
  expect(await harness.readAllObservedVersions()).toEqual(
    expect.arrayContaining([expect.objectContaining({ bytes: 'AAA' }), expect.objectContaining({ bytes: 'BBB' })])
  );
  if (result.ok) expect(await harness.readPair(pair)).toEqual({ left: 'BBB', right: 'AAA' });
});

it.each(['.', '..', '/absolute', 'child/name', ''])(
  'rejects invalid basename %j before mutation',
  async (name) => {
    const before = await harness.snapshot();
    await expect(harness.moveExclusive({ sourceName: 'source', targetName: name }))
      .resolves.toMatchObject({ ok: false, errno: EINVAL });
    expect(await harness.snapshot()).toEqual(before);
  }
);

it('keeps public listing stable while private inspection sees hidden entries', async () => {
  await harness.createTree(['visible.md', '.hidden.md', 'empty/', 'link@']);
  expect(await harness.listDirectoryPublic()).toEqual(['empty/', 'visible.md']);
  expect(await harness.scanTreePrivate()).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'file', relativePath: '.hidden.md' }),
    expect.objectContaining({ type: 'directory', relativePath: 'empty' }),
    expect.objectContaining({ type: 'symlink', relativePath: 'link' })
  ]));
  expect(harness.stdout()).not.toMatch(/AAA|BBB|\/Users\//u);
});
```

- [ ] **Step 2: Run and verify RED**

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/native-read-helper-protocol.test.ts
npm exec -- vitest run --config vitest.native.config.ts tests/native/atomic-file-helper.contract.test.ts --no-file-parallelism
```

Expected: FAIL because helper source/build do not exist.

- [ ] **Step 3: Extend the Phase 0 helper with the complete write command set**

Keep Phase 0's `probe-root`, public `list-dir`, `read-file`, and `stat-file` implementations and framed behavior byte-for-byte. Add private `list-dir-all` and the write/private-recovery functions below to the same component-walking, descriptor-held source; never replace the public read command table or add an absolute-entry `open` shortcut. `parse_bound_directory_v1`, `parse_identity`, `require_entry_identity`, `open_absolute_root_componentwise`, and `walk_relative_directory_nofollow` are mandatory in-file definitions, not pseudocode imports: strict decimal/hex parsers reject overflow/trailing bytes; the absolute walker begins at `/`; the relative walker accepts `.` or NFC component sequences; and every opened descriptor is same-device, no-follow, and closed on every branch. Compilation with `-Werror` plus the native contract is the completeness gate.

`NativeReadVaultPort` gains these server-internal methods without adding them to `ReadVaultGateway` or any renderer/API type:

```ts
type NativeTreeRecord =
  | { readonly type: 'file'; readonly relativePath: string; readonly identity: FileIdentity;
      readonly mode: number; readonly byteLength: number; readonly modifiedAtNs: string;
      readonly changedAtNs: string; readonly rawSha256: string }
  | { readonly type: 'directory'; readonly relativePath: string; readonly identity: DirectoryIdentity;
      readonly mode: number; readonly modifiedAtNs: string; readonly changedAtNs: string }
  | { readonly type: 'symlink'; readonly relativePath: string; readonly identity: FileIdentity;
      readonly mode: number; readonly byteLength: number; readonly modifiedAtNs: string;
      readonly changedAtNs: string; readonly targetSha256: string };

interface NativeVaultInspectionPort {
  listDirectoryAll(path: string): Promise<readonly NativeTreeRecord[]>;
  scanTreePrivate(path: string): Promise<readonly NativeTreeRecord[]>;
}
```

Both methods require a branded server-internal capability created only by composition roots; ordinary `FileSystemVaultGateway` receives no such capability. The strict protocol rejects duplicate paths, unsorted records, unknown fields, a child outside the requested prefix, or an aggregate above the documented entry/byte/depth bounds.

```c
#define _DARWIN_C_SOURCE 1
#include <sys/stdio.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>
#include <dirent.h>
#include <inttypes.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

static int valid_name(const char *v) {
  return v && v[0] && strcmp(v, ".") && strcmp(v, "..") && strchr(v, '/') == NULL;
}
typedef struct {
  char absolute_root[PATH_MAX];
  char relative_directory[PATH_MAX];
  uint64_t root_dev, root_ino, directory_dev, directory_ino;
} bound_directory;

static int open_bound_dir(const char *encoded) {
  bound_directory operand;
  if (parse_bound_directory_v1(encoded, &operand) != 0) {
    errno = EINVAL; return -1;
  }
  int root = open_absolute_root_componentwise(operand.absolute_root);
  if (root < 0) return -1;
  struct stat root_metadata;
  if (fstat(root, &root_metadata) != 0
      || (uint64_t)root_metadata.st_dev != operand.root_dev
      || (uint64_t)root_metadata.st_ino != operand.root_ino) {
    close(root); errno = ESTALE; return -1;
  }
  int directory = walk_relative_directory_nofollow(
    root, operand.relative_directory, operand.root_dev);
  close(root);
  if (directory < 0) return -1;
  struct stat directory_metadata;
  if (fstat(directory, &directory_metadata) != 0
      || !S_ISDIR(directory_metadata.st_mode)
      || (uint64_t)directory_metadata.st_dev != operand.root_dev
      || (uint64_t)directory_metadata.st_dev != operand.directory_dev
      || (uint64_t)directory_metadata.st_ino != operand.directory_ino) {
    close(directory); errno = ESTALE; return -1;
  }
  return directory;
}
static int finish(const char *op, int ok, int err) {
  if (ok) printf("{\"ok\":true,\"operation\":\"%s\"}\n", op);
  else printf("{\"ok\":false,\"operation\":\"%s\",\"errno\":%d}\n", op, err);
  return ok ? 0 : 1;
}
static int finish_identity(const char *op, const struct stat *metadata) {
  printf("{\"ok\":true,\"operation\":\"%s\",\"identity\":{\"dev\":\"%" PRIu64
    "\",\"ino\":\"%" PRIu64 "\"}}\n", op,
    (uint64_t)metadata->st_dev, (uint64_t)metadata->st_ino);
  return 0;
}
static int swap_files(int ac, char **av) {
  if (ac != 9 || !valid_name(av[3]) || !valid_name(av[6])) return finish("swap", 0, EINVAL);
  uint64_t left_dev, left_ino, right_dev, right_ino;
  if (parse_identity(av[4], av[5], &left_dev, &left_ino) != 0
      || parse_identity(av[7], av[8], &right_dev, &right_ino) != 0) {
    return finish("swap", 0, EINVAL);
  }
  int d = open_bound_dir(av[2]);
  if (d < 0) return finish("swap", 0, errno);
  if (require_entry_identity(d, av[3], left_dev, left_ino) != 0
      || require_entry_identity(d, av[6], right_dev, right_ino) != 0) {
    int saved = errno; close(d); return finish("swap", 0, saved);
  }
  int rc = renameatx_np(d, av[3], d, av[6], RENAME_SWAP | RENAME_NOFOLLOW_ANY);
  int saved = errno;
  if (rc == 0 && (require_entry_identity(d, av[3], right_dev, right_ino) != 0
      || require_entry_identity(d, av[6], left_dev, left_ino) != 0)) {
    saved = ESTALE;
    rc = -1;
  }
  close(d);
  return finish("swap", rc == 0, saved);
}
static int move_excl(int ac, char **av) {
  if (ac != 8 || !valid_name(av[3]) || !valid_name(av[7])) return finish("move-excl", 0, EINVAL);
  char *end_dev = NULL; char *end_ino = NULL;
  uint64_t expected_dev = strtoull(av[4], &end_dev, 10);
  uint64_t expected_ino = strtoull(av[5], &end_ino, 10);
  if (!end_dev || *end_dev || !end_ino || *end_ino) return finish("move-excl", 0, EINVAL);
  int from = open_bound_dir(av[2]);
  if (from < 0) return finish("move-excl", 0, errno);
  int to = open_bound_dir(av[6]);
  if (to < 0) { int saved = errno; close(from); return finish("move-excl", 0, saved); }
  struct stat before;
  if (fstatat(from, av[3], &before, AT_SYMLINK_NOFOLLOW) != 0
      || (uint64_t)before.st_dev != expected_dev
      || (uint64_t)before.st_ino != expected_ino) {
    int saved = errno ? errno : ESTALE; close(to); close(from);
    return finish("move-excl", 0, saved);
  }
  int rc = renameatx_np(from, av[3], to, av[7], RENAME_EXCL | RENAME_NOFOLLOW_ANY);
  int saved = errno;
  struct stat after;
  if (rc == 0 && (fstatat(to, av[7], &after, AT_SYMLINK_NOFOLLOW) != 0
      || (uint64_t)after.st_dev != expected_dev
      || (uint64_t)after.st_ino != expected_ino)) {
    saved = ESTALE;
    rc = -1;
  }
  close(to);
  close(from);
  return rc == 0 ? finish_identity("move-excl", &after)
                 : finish("move-excl", 0, saved);
}
static int mkdir_excl(int ac, char **av) {
  if (ac != 4 || !valid_name(av[3])) return finish("mkdir-excl", 0, EINVAL);
  int parent = open_bound_dir(av[2]);
  if (parent < 0) return finish("mkdir-excl", 0, errno);
  if (mkdirat(parent, av[3], 0700) != 0) {
    int saved = errno; close(parent); return finish("mkdir-excl", 0, saved);
  }
  int child = openat(parent, av[3], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat metadata;
  if (child < 0) { int saved = errno; close(parent); return finish("mkdir-excl", 0, saved); }
  if (fstat(child, &metadata) != 0) {
    int saved = errno; close(child); close(parent); return finish("mkdir-excl", 0, saved);
  }
  if (!S_ISDIR(metadata.st_mode)) {
    close(child); close(parent); return finish("mkdir-excl", 0, ENOTDIR);
  }
  if (fsync(parent) != 0) {
    int saved = errno; close(child); close(parent); return finish("mkdir-excl", 0, saved);
  }
  close(child); close(parent);
  return finish_identity("mkdir-excl", &metadata);
}
static int empty_directory(int descriptor) {
  int duplicate = dup(descriptor);
  if (duplicate < 0) return -1;
  DIR *stream = fdopendir(duplicate);
  if (!stream) { close(duplicate); return -1; }
  struct dirent *entry;
  int empty = 1;
  errno = 0;
  while ((entry = readdir(stream)) != NULL) {
    if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) { empty = 0; break; }
  }
  int read_error = errno;
  closedir(stream);
  if (read_error != 0) { errno = read_error; return -1; }
  return empty;
}
static int rmdir_created_empty(int ac, char **av) {
  if (ac != 8 || !valid_name(av[3]) || !valid_name(av[7])) return finish("rmdir-created-empty", 0, EINVAL);
  char *end_dev = NULL; char *end_ino = NULL;
  uint64_t expected_dev = strtoull(av[4], &end_dev, 10);
  uint64_t expected_ino = strtoull(av[5], &end_ino, 10);
  if (!end_dev || *end_dev || !end_ino || *end_ino) return finish("rmdir-created-empty", 0, EINVAL);
  int parent = open_bound_dir(av[2]); int quarantine = open_bound_dir(av[6]);
  if (parent < 0 || quarantine < 0) {
    int saved = errno; if (parent >= 0) close(parent); if (quarantine >= 0) close(quarantine);
    return finish("rmdir-created-empty", 0, saved);
  }
  int child = openat(parent, av[3], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat before;
  if (child < 0) {
    int saved = errno; close(quarantine); close(parent);
    return finish("rmdir-created-empty", 0, saved);
  }
  if (fstat(child, &before) != 0) {
    int saved = errno; close(child); close(quarantine); close(parent);
    return finish("rmdir-created-empty", 0, saved);
  }
  if (!S_ISDIR(before.st_mode)) {
    close(child); close(quarantine); close(parent);
    return finish("rmdir-created-empty", 0, ENOTDIR);
  }
  if ((uint64_t)before.st_dev != expected_dev || (uint64_t)before.st_ino != expected_ino
      || empty_directory(child) != 1) {
    close(child); close(quarantine); close(parent);
    return finish("rmdir-created-empty", 0, EBUSY);
  }
  close(child);
  if (renameatx_np(parent, av[3], quarantine, av[7], RENAME_EXCL | RENAME_NOFOLLOW_ANY) != 0) {
    int saved = errno; close(quarantine); close(parent); return finish("rmdir-created-empty", 0, saved);
  }
  int moved = openat(quarantine, av[7], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat after;
  int verified = moved >= 0 && fstat(moved, &after) == 0
    && (uint64_t)after.st_dev == expected_dev && (uint64_t)after.st_ino == expected_ino
    && empty_directory(moved) == 1;
  if (moved >= 0) close(moved);
  if (!verified) {
    close(quarantine); close(parent); return finish("rmdir-created-empty", 0, EBUSY);
  }
  int rc = fsync(quarantine) == 0 && fsync(parent) == 0 ? 0 : -1;
  int saved = errno;
  close(quarantine); close(parent);
  return finish("rmdir-created-empty", rc == 0, saved);
}
static int sync_dir(int ac, char **av) {
  if (ac != 3) return finish("fsync-dir", 0, EINVAL);
  int d = open_bound_dir(av[2]);
  if (d < 0) return finish("fsync-dir", 0, errno);
  int rc = fsync(d);
  int saved = errno;
  close(d);
  return finish("fsync-dir", rc == 0, saved);
}
int main(int ac, char **av) {
  if (ac < 2) return finish("invalid", 0, EINVAL);
  if (!strcmp(av[1], "probe-root")) return probe_root(ac, av);
  if (!strcmp(av[1], "list-dir")) return list_dir(ac, av);
  if (!strcmp(av[1], "list-dir-all")) return list_dir_all(ac, av);
  if (!strcmp(av[1], "scan-tree-private")) return scan_tree_private(ac, av);
  if (!strcmp(av[1], "read-file")) return read_file(ac, av);
  if (!strcmp(av[1], "stat-file")) return stat_file(ac, av);
  if (!strcmp(av[1], "swap")) return swap_files(ac, av);
  if (!strcmp(av[1], "move-excl")) return move_excl(ac, av);
  if (!strcmp(av[1], "mkdir-excl")) return mkdir_excl(ac, av);
  if (!strcmp(av[1], "rmdir-created-empty")) return rmdir_created_empty(ac, av);
  if (!strcmp(av[1], "fsync-dir")) return sync_dir(ac, av);
  if (!strcmp(av[1], "private-create-file")) return private_create_file(ac, av);
  if (!strcmp(av[1], "private-read-file")) return private_read_file(ac, av);
  if (!strcmp(av[1], "private-append-file")) return private_append_file(ac, av);
  return finish("invalid", 0, EINVAL);
}
```

The same source defines the five newly dispatched functions before `main`; they are not optional stubs. `list_dir_all` and `scan_tree_private` use `fdopendir(dup(fd))`, `fstatat(...AT_SYMLINK_NOFOLLOW)`, and `readlinkat` and emit the strict framed records described above; the recursive command additionally enforces entry/depth/byte caps and before/after directory snapshots. The three private-file functions use only the already defined `open_bound_dir`, validate exact argument counts and decimal/hash syntax before reading stdin, reject symlink/non-regular entries, cap bytes before allocation, and implement the stat/write-or-read/fsync/stat/hash contracts from the protocol section. The RED contract must also compile and invoke every command, so a missing function or dispatch cannot pass Step 5.

- [ ] **Step 4: Implement deterministic arm64 compilation**

Retain Phase 0's `scripts/build-native-helper.ts`; it invokes `xcrun` via `execFile`, never a shell:

```ts
await execFileAsync('xcrun', [
  'clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
  '-arch', 'arm64', '-mmacosx-version-min=13.0', source, '-o', output
], { maxBuffer: 1024 * 1024 });
await chmod(output, 0o755);
process.stdout.write(`${sha256Bytes(await readFile(output))}  ${output}\n`);
```

Fail unless platform is Darwin arm64. Default output is `dist/native/atomic-file-helper`; tests inject a temporary path.

- [ ] **Step 5: Add scripts, run, and commit**

```json
{
  "scripts": {
    "test:native-contract": "npm run build:native && vitest run --config vitest.native.config.ts tests/native --no-file-parallelism"
  }
}
```

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/native-read-helper-protocol.test.ts
npm run test:native-contract
file dist/native/atomic-file-helper
otool -L dist/native/atomic-file-helper
git add native/macos/atomic-file-helper.c scripts/build-native-helper.ts src/server/vault/native-read-helper-protocol.ts src/server/vault/NativeReadVaultPort.ts tests/helpers/native-helper-harness.ts tests/native/atomic-file-helper.contract.test.ts tests/unit/native-read-helper-protocol.test.ts tests/native/native-read-helper.contract.test.ts package.json package-lock.json
git commit -m "feat: add macos atomic file helper"
```

Expected: helper is arm64 Mach-O, links only libSystem, and passes both Phase 0 descriptor-read race contracts and all new write contracts.

The TypeScript path checks remain defense in depth. They are not the nofollow authority: every helper operation obtains directory descriptors by starting at `open("/")` and walking each absolute-path component through `openat(..., O_DIRECTORY | O_NOFOLLOW)`, checks every descriptor with `fstat`, then calls `renameatx_np`/`fsync` only with those held descriptors.

### Task 3: Add the bounded TypeScript helper client

**Files:**
- Create: `src/server/vault/atomic-helper-protocol.ts`
- Create: `src/server/vault/AtomicFileHelper.ts`
- Create: `src/server/vault/native-helper-path.ts`
- Create: `tests/unit/atomic-helper-protocol.test.ts`

- [ ] **Step 1: Write failing protocol/client tests**

Cover valid success/failure, extra keys, multiple lines, output above 8 KiB, malformed JSON, timeout, abort, nonzero exit without valid output, invalid absolute directory, and invalid basename rejected before process launch. Cover exact stdin length/EOF/hash, early close, oversized private file, append wrong identity/size, and framed `list-dir-all`/`private-read-file` payload truncation or extra bytes.

Encode the parser and process-boundary matrix directly:

```ts
it.each([
  ['', 'ATOMIC_HELPER_FAILED'],
  ['{}\n', 'ATOMIC_HELPER_FAILED'],
  ['{"ok":true,"operation":"swap","extra":1}\n', 'ATOMIC_HELPER_FAILED'],
  ['{"ok":true,"operation":"swap"}\n{"ok":true,"operation":"swap"}\n', 'ATOMIC_HELPER_FAILED'],
  [`${'x'.repeat(8193)}\n`, 'ATOMIC_HELPER_FAILED']
] as const)('rejects malformed or unbounded output', (stdout, code) => {
  expect(() => parseAtomicHelperOutput(stdout)).toThrowError(expect.objectContaining({ code }));
});

it.each([
  { name: '/absolute', code: 'ATOMIC_HELPER_FAILED' },
  { name: '..', code: 'ATOMIC_HELPER_FAILED' },
  { name: 'child/name', code: 'ATOMIC_HELPER_FAILED' }
] as const)('rejects $name before spawn', async ({ name, code }) => {
  const spawn = vi.fn();
  const helper = createAtomicFileHelper({ executable: verifiedExecutable, spawn });
  await expect(helper.mkdirExclusive(boundDirectory, name)).rejects.toMatchObject({ code });
  expect(spawn).not.toHaveBeenCalled();
});

it('requires exact private input length, hash, EOF, and append identity', async () => {
  const helper = createAtomicFileHelper({ executable: verifiedExecutable, spawn: fakeSpawn });
  await expect(helper.privateCreateFile(boundDirectory, 'blob', bytes, wrongSha256))
    .rejects.toMatchObject({ code: 'ATOMIC_HELPER_FAILED' });
  await expect(helper.privateAppendFile(boundDirectory, 'journal', wrongIdentity, 4, bytes))
    .rejects.toMatchObject({ code: 'ATOMIC_HELPER_FAILED' });
});
```

- [ ] **Step 2: Run and verify RED**

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/atomic-helper-protocol.test.ts
```

Expected: FAIL because client modules do not exist.

- [ ] **Step 3: Implement schemas and stable errno mapping**

```ts
export const helperResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    operation: z.enum(['swap','rmdir-created-empty','fsync-dir'])
  }).strict(),
  z.object({
    ok: z.literal(true), operation: z.enum(['mkdir-excl','move-excl']),
    identity: z.object({ dev: z.string().regex(/^\d+$/u), ino: z.string().regex(/^\d+$/u) }).strict()
  }).strict(),
  z.object({
    ok: z.literal(true), operation: z.enum(['private-create-file','private-append-file']),
    identity: z.object({ dev: z.string().regex(/^\d+$/u), ino: z.string().regex(/^\d+$/u) }).strict(),
    byteLength: z.number().int().nonnegative(),
    rawSha256: z.string().regex(/^[a-f0-9]{64}$/u)
  }).strict(),
  z.object({
    ok: z.literal(false),
    operation: z.enum([
      'swap','move-excl','mkdir-excl','rmdir-created-empty','fsync-dir',
      'private-create-file','private-append-file','invalid'
    ]),
    errno: z.number().int().min(1).max(4096)
  }).strict()
]);
export type AtomicHelperErrorCode =
  | 'ATOMIC_TARGET_EXISTS' | 'ATOMIC_PATH_MISSING' | 'ATOMIC_CROSS_DEVICE'
  | 'ATOMIC_SYMLINK_REJECTED' | 'ATOMIC_NOT_SUPPORTED' | 'ATOMIC_HELPER_FAILED';
```

Map Darwin errno 17, 2, 18, 40, and 45/102 to the stable codes; keep paths out of public errors.

- [ ] **Step 4: Implement the no-shell client**

Create a `NativeHelperExecutable` once from the helper path: open it `O_RDONLY|O_NOFOLLOW`, require a regular executable, capture dev/ino/mode, hash bytes through the held descriptor, verify the same vnode's code signature, and keep the descriptor open for the runtime. Every invocation executes the inherited descriptor through the target-verified `/dev/fd/3` path with `shell:false`; if that capability is unavailable, the native write gate is blocked. Never close and reopen the helper by pathname between verification and execution. The target-mac native contract replaces the on-disk path immediately before spawn and proves the child either runs the already verified inode or fails, never the replacement.

Use `spawn('/dev/fd/3', args, { shell:false, stdio:['ignore','pipe','pipe', executableFd] })` for metadata operations and the same call with stdin `pipe` only for the two private byte-write commands. Enforce timeout 5000, an 8192-byte JSON output cap, framed read bounds, exact declared stdin bytes, and these argument arrays. `encodeBoundDirectory()` takes already observed root and final-parent identities; no caller supplies a bare absolute child directory:

```ts
['swap', encodeBoundDirectory(parent), left.name, left.dev, left.ino,
  right.name, right.dev, right.ino]
['move-excl', encodeBoundDirectory(from.parent), from.name, from.dev, from.ino,
  encodeBoundDirectory(to.parent), to.name]
['mkdir-excl', encodeBoundDirectory(privateDirectoryStage), stagingBasename]
['rmdir-created-empty', encodeBoundDirectory(vaultParent), name,
  expected.dev, expected.ino, encodeBoundDirectory(privateRetained), retainedBasename]
['fsync-dir', encodeBoundDirectory(directory)]
['list-dir-all', encodeBoundDirectory(directory)]
['scan-tree-private', encodeBoundDirectory(directory)]
['private-create-file', encodeBoundDirectory(directory), name,
  String(bytes.byteLength), sha256Bytes(bytes)]
['private-read-file', encodeBoundDirectory(directory), name,
  expected.dev, expected.ino, String(maximumLength)]
['private-append-file', encodeBoundDirectory(directory), name,
  expected.dev, expected.ino, String(expectedSize),
  String(bytes.byteLength), sha256Bytes(bytes)]
```

Require exactly one newline-terminated JSON object for mutation metadata; `list-dir-all` and `private-read-file` use the existing bounded framed read protocol with new strict discriminants. `encodeBoundDirectory()` emits the strict versioned operand and rejects root/parent identity drift before launch; the helper independently rechecks it. `native-helper-path.ts` resolves `dist/native/atomic-file-helper` for development, while the client owns the still-open verified executable capability and contains no packaged-resource logic.

- [ ] **Step 5: Run and commit**

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/atomic-helper-protocol.test.ts
npm run test:native-contract
git add src/server/vault/atomic-helper-protocol.ts src/server/vault/AtomicFileHelper.ts src/server/vault/native-helper-path.ts tests/unit/atomic-helper-protocol.test.ts
git commit -m "feat: wrap atomic helper safely"
```

Expected: mocked and real helper cases pass without shell invocation or path leakage.

### Task 4: Build the sentinel capability profile and fail-closed gate

**Files:**
- Create: `tests/helpers/atomic-test-vault.ts`
- Create: `src/server/vault/native-capability-profile.ts`
- Create: `src/server/vault/native-capability-probe.ts`
- Create: `src/server/vault/MutationTargetPolicy.ts`
- Create: `scripts/gate-filesystem-write-capability.ts`
- Create: `tests/unit/native-capability-profile.test.ts`
- Create: `tests/integration/native-capability-gate.test.ts`
- Modify: `tests/unit/test-vault-guard.test.ts`
- Modify: `src/server/services/health-service.ts`
- Modify: `src/shared/api/schemas.ts`
- Modify: `tests/integration/health-write-gate.test.ts`

- [ ] **Step 1: Write guard and profile tests**

Require a regular `0600` sentinel containing exactly:

```json
{"purpose":"xiaozhao-atomic-write-contract","schemaVersion":1}
```

Assert formal root, configured formal root, missing/symlink sentinel, nested app-data, helper mismatch, OS mismatch, architecture mismatch, profile target `st_dev` mismatch, recovery-root/vault `st_dev` mismatch, same-path/same-device app-data or recovery-root inode replacement, pending recovery, and each unverified capability all block before helper mutation. Assert a caller cannot construct or replay a mutation authorization for another root/plan/profile, and that every bound-directory operand is built only from the identities captured by the same successful `assertCurrent()` pass.

- [ ] **Step 2: Run and verify RED**

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/native-capability-profile.test.ts tests/unit/test-vault-guard.test.ts
```

Expected: FAIL because sentinel/profile modules do not exist.

- [ ] **Step 3: Implement an immutable volume-bound profile**

```ts
export type NativeCapabilityProfile = {
  readonly schemaVersion: 1;
  readonly helperSha256: string;
  readonly helperProtocolVersion: 1;
  readonly macosBuild: string;
  readonly arch: 'arm64';
  readonly volume: { readonly device: string; readonly filesystemType: string };
  readonly checkedAt: string;
  readonly capabilities: Readonly<Record<
    'renameSwap' | 'renameExclusive' | 'mkdirExclusive' | 'rmdirCreatedEmpty'
      | 'hiddenInspection' | 'privateRecoveryIO'
      | 'noFollow' | 'fileFsync' | 'directoryFsync'
      | 'conflictPreservation' | 'crashRecovery',
    'passed' | 'failed' | 'unverified'>>;
  readonly evidence: readonly {
    readonly capability: string; readonly status: 'passed' | 'failed';
    readonly reasonCode: string; readonly observedAt: string;
  }[];
  readonly profileKey: string;
};
```

Hash canonical content excluding timestamps and `profileKey`. Persist immutable revisions and an fsynced atomic pointer under `<appData>/capability-profiles`; malformed/stale pointers block.

- [ ] **Step 4: Implement executable primitive probes**

After sentinel validation, create a private probe directory inside the test vault and a bound probe directory under app-data. Prove exact swap bytes, exclusive collision with unchanged files, exclusive absent-target move, one-level exclusive mkdir with recorded dev/ino/mode, collision-safe mkdir, identity-bound empty-directory recovery removal through private quarantine, refusal to remove a non-empty/replaced directory, hidden-inclusive no-follow inspection, exact-length private create/read/append plus root-swap rejection, nofollow ancestor/final symlink rejection, file fsync, directory fsync, and conflict preservation. Hash helper; capture `sw_vers -buildVersion`, arm64, filesystem type, and `stat.dev`. Persist evidence outside the vault, retire only the exact generated probe identities by exclusive move, and leave `crashRecovery: 'unverified'` until Task 10.

```ts
const requiredPrimitiveCapabilities = [
  'renameSwap', 'renameExclusive', 'mkdirExclusive', 'rmdirCreatedEmpty',
  'hiddenInspection', 'privateRecoveryIO', 'noFollow',
  'fileFsync', 'directoryFsync', 'conflictPreservation',
] as const;
const evidence = await runNativeCapabilityProbes({
  helper, sentinelVault, appDataRoot, required: requiredPrimitiveCapabilities,
});
for (const capability of requiredPrimitiveCapabilities) {
  if (evidence.capabilities[capability] !== 'passed') {
    throw new AppError('NATIVE_WRITE_CAPABILITY_BLOCKED');
  }
}
```

- [ ] **Step 5: Implement gate CLI and health source**

Read `APP_DATA_DIR`, `VAULT_REAL_ROOT`, and `NATIVE_CAPABILITY_PROFILE_KEY`; rehash helper and reobserve OS/arch/target volume/recovery. Require `<APP_DATA_DIR>/recovery` and the vault to share `st_dev`. Print exactly `PASSED` with exit 0 or `BLOCKED <capabilities>` with exit 1. Catch all errors as `BLOCKED profile`. Health may say enabled only when this evaluator passes and recovery scan is empty.

Create the server-internal policy boundary:

```ts
declare const mutationAuthorizationBrand: unique symbol;
type MutationTargetAuthorizationCommon = {
  readonly policyId: string;
  readonly targetRootRealPath: string;
  readonly targetDevice: string;
  readonly targetInode: string;
  readonly appDataRootRealPath: string;
  readonly appDataDevice: string;
  readonly appDataInode: string;
  readonly recoveryRootRealPath: string;
  readonly recoveryDevice: string;
  readonly recoveryInode: string;
  readonly intentKind: WriteIntentKind;
  readonly originalIntentKind: null;
  readonly operation: 'execute';
  readonly recoverySnapshotSha256: null;
  readonly resolutionSha256: null;
  readonly targetRootIdentitySha256: string;
  readonly appDataRootIdentitySha256: string;
  readonly recoveryRootIdentitySha256: string;
  readonly canonicalScopeSha256: string;
  readonly planId: string;
  readonly planSha256: string;
  readonly projectionCapsuleSha256: string;
  readonly profileKey: string;
  readonly ruleBundleSha256: string;
  readonly authorizationSha256: string;
  readonly [mutationAuthorizationBrand]: true;
};
type MutationAuthorizationProvenance =
  | {
      readonly authorizationKind: 'sentinel-test';
      readonly productionEvidenceSha256: null;
      readonly nativeGrantScopeSha256: null;
      readonly confirmedAt: null;
    }
  | {
      readonly authorizationKind: 'automatic-intake';
      readonly productionEvidenceSha256: string;
      readonly nativeGrantScopeSha256: null;
      readonly confirmedAt: null;
    }
  | {
      readonly authorizationKind: 'native-grant';
      readonly productionEvidenceSha256: string;
      readonly nativeGrantScopeSha256: string;
      readonly confirmedAt: string;
    };
export type MutationTargetAuthorization =
  MutationTargetAuthorizationCommon & MutationAuthorizationProvenance;
export type MutationPolicyInput = {
  readonly targetRoot: string;
  readonly appDataRoot: string;
  readonly plan: WritePlan;
  readonly projectionCapsule: DomainProjectionCapsule;
  readonly profile: NativeCapabilityProfile;
};
export interface MutationTargetPolicy {
  authorize(input: MutationPolicyInput): Promise<MutationTargetAuthorization>;
  assertCurrent(
    authorization: MutationTargetAuthorization,
    input: MutationPolicyInput,
  ): Promise<void>;
}

export function canonicalMutationScopeSha256(
  plan: WritePlan,
  projectionCapsule: DomainProjectionCapsule,
): string {
  return sha256Text(canonicalJson({
    intent: plan.intent,
    steps: plan.steps,
    projectionCapsuleSha256: projectionCapsule.payloadSha256,
  }));
}
```

Implement only `SentinelTestMutationPolicy`. `MutationTargetAuthorization` is produced through the same three-branch strict provenance schema as the journal authorization and exported from that schema; no constructor can compile or parse a mixed nullability combination. Phase 1 always emits `operation:'execute'` with `originalIntentKind`, `recoverySnapshotSha256`, and `resolutionSha256` explicitly null; Phase 6 widens those exact required fields for recovery operations rather than introducing optional/absent representations. `authorize()` and `assertCurrent()` both parse the complete plan and intent-owned projection capsule with strict shared/registry schemas, recompute both digests, and derive `canonicalScopeSha256` from the full intent, complete ordered steps, and capsule digest—including every role, source/destination/path, expected file/tree/absence version, directory identity, and planned-byte hash. They re-resolve and re-stat target root, app-data root, and the exact private recovery root, then bind every realpath/dev/ino plus the three canonical root-identity hashes, intent kind, canonical scope hash, plan ID/hash, capsule hash, rule hash, and complete profile key into the branded authorization. Phase 1's sentinel authorization sets `authorizationKind:'sentinel-test'`, `nativeGrantScopeSha256:null`, `confirmedAt:null`, and `productionEvidenceSha256:null`. Its `authorizationSha256` is the SHA-256 of the canonical pre-manifest authorization projection: it excludes `authorizationSha256`, the TypeScript brand, the later-added `manifestSha256`, and all `JournalBase` chain metadata, but covers every other persistent authorization field including all explicit nulls. The journal validator separately requires its added `manifestSha256` to equal the immutable manifest bytes. They also revalidate the sentinel, formal-root exclusion, all pairwise non-overlap constraints, recovery-root ownership/mode, same-device recovery root, and profile evidence. `assertCurrent()` rejects any root/recovery inode drift—even at the same path and device—or any bound plan/capsule change, so a caller cannot replay authorization after replacing a directory or changing a step while retaining an old hash. Every helper bound-directory operand is derived from these current identities plus a freshly observed final-parent identity. No production policy, environment boolean, or default allow policy exists in this phase. Phase 6 supplies a separate Electron-owned production implementation that performs its allowlist decision from this same complete `MutationPolicyInput` and the reconstructible production evidence hash.

- [ ] **Step 6: Run and commit**

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/native-capability-profile.test.ts tests/unit/test-vault-guard.test.ts
npm exec -- vitest run --config vitest.integration.config.ts tests/integration/native-capability-gate.test.ts tests/integration/health-write-gate.test.ts --no-file-parallelism
git add tests/helpers/atomic-test-vault.ts src/server/vault/native-capability-profile.ts src/server/vault/native-capability-probe.ts src/server/vault/MutationTargetPolicy.ts scripts/gate-filesystem-write-capability.ts tests/unit/native-capability-profile.test.ts tests/integration/native-capability-gate.test.ts tests/unit/test-vault-guard.test.ts src/server/services/health-service.ts src/shared/api/schemas.ts tests/integration/health-write-gate.test.ts
git commit -m "feat: gate filesystem write capabilities"
```

Expected: primitive probe passes only in the sentinel vault; gate stays blocked on crash recovery.

### Task 5: Create deterministic plans with source-status last

**Files:**
- Create: `src/server/workflow/write-planner.ts`
- Modify: `tests/unit/write-plan.test.ts`

- [ ] **Step 1: Add failing determinism and invalidation tests**

Assert reordered object keys produce the same plan hash; changing only `id` or `createdAt` does not change it; any byte, path, expected version, rule bundle, intent field, schema version, or step order does. Assert ordinary roles order as knowledge, intake, recovery, source-status; duplicate targets fail. For intake directories, require each missing parent `mkdir-exclusive` before its child/month and before the package move; do not synthesize unrelated or future month directories. For recovery, require fresh contiguous plan ordinals plus a unique in-range `recoveryOfOrdinal` on every step. Continue bindings must form the original unchanged suffix in ascending original order; rollback bindings must be landed original steps in strict descending order; resolve bindings and `resolutionSha256` must match the selected version map. Require `rmdir-created-empty` and `retire-created-file` to use a kernel-recovery intent and reject either kind in an ordinary plan.

```ts
const first = createWritePlan({ ...fixture, id: 'plan-a', createdAt: '2026-09-01T00:00:00.000Z' });
const replay = createWritePlan({ ...fixture, id: 'plan-b', createdAt: '2026-09-02T00:00:00.000Z' });
expect(replay.planSha256).toBe(first.planSha256);
expect(createWritePlan({ ...fixture, steps: [...fixture.steps].reverse() }).planSha256)
  .not.toBe(first.planSha256);
```

- [ ] **Step 2: Run and verify RED**

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/write-plan.test.ts
```

Expected: FAIL because `createWritePlan()` is absent.

- [ ] **Step 3: Implement canonical planning**

Recursively sort object keys, preserve array order, reject undefined/non-finite values, duplicate targets, and non-contiguous plan ordinals. Ordinary plans stable-sort by role and forbid `recoveryOfOrdinal`; recovery plans preserve the recovery planner's explicitly validated order, assign a new contiguous ordinal sequence, and require the original-step binding on every step.

```ts
export function createWritePlan(input: {
  readonly id: string;
  readonly createdAt: string;
  readonly ruleBundleSha256: string;
  readonly intent: WriteIntent;
  readonly steps: readonly Omit<WriteStep, 'ordinal'>[];
}): WritePlan {
  const source = input.intent.kind === 'kernel_recovery'
    ? [...input.steps]
    : [...input.steps].sort((left, right) => roleRank(left.role) - roleRank(right.role));
  const ordered = source
    .map((step, ordinal) => ({ ...step, ordinal } as WriteStep));
  assertOrdinaryOrRecoveryOrdering(input.intent, ordered);
  assertUniqueTargets(ordered);
  const semantic = {
    schemaVersion: 1 as const,
    ruleBundleSha256: input.ruleBundleSha256,
    intent: input.intent,
    steps: ordered,
  };
  const planSha256 = sha256Text(canonicalJson(semantic));
  return writePlanSchema.parse({
    ...semantic,
    id: input.id,
    createdAt: input.createdAt,
    planSha256,
  });
}
```

Callers inject identifiers and timestamps; planner generates neither. They are instance/audit metadata and are intentionally excluded from the semantic hash. `write_plans.plan_sha256` is indexed but not unique; the idempotency owner reuses its stored plan instance, while optimistic execution compares the exact `expectedPlanSha256`.

- [ ] **Step 4: Run and commit**

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/write-plan.test.ts
git add src/server/workflow/write-planner.ts tests/unit/write-plan.test.ts
git commit -m "feat: build immutable write plans"
```

Expected: deterministic hashes, order, duplicate, and invalidation cases pass.

### Task 6: Persist self-contained manifests, blobs, and hash-chain journal

**Files:**
- Create: `src/server/vault/PrivateRecoveryStore.ts`
- Create: `src/server/recovery/recovery-manifest.ts`
- Create: `src/server/recovery/recovery-journal.ts`
- Create: `tests/unit/private-recovery-store.test.ts`
- Create: `tests/unit/recovery-journal.test.ts`
- Modify: `src/server/db/database.ts`
- Modify: `tests/integration/database-kernel.test.ts`

- [ ] **Step 1: Write failing durability/corruption tests**

Test BOM, CRLF, no-final-newline bytes; content-address collision; modes `0600/0700`; duplicate manifest; seq gap; wrong previous/entry hash; altered manifest; missing/unreferenced-extra blob; missing/extra/mismatched staging reservation, `staging-source`, or `directory-staging-source` record; retained-inode metadata/hash mismatch; a create result missing its file dev/ino; partial final line; and successful scan after SQLite deletion/corruption. Replace the app-data root, preparing root, active recovery root, or batch pathname before a private operation and during its native test synchronization hook; every operation must either use the held expected inode or fail, never read/write an alias. Crash before preparing-directory promotion and prove no active recovery batch or vault mutation exists; crash after exclusive promotion and prove the active batch already has a complete valid manifest. A stale preparing directory may be retired only when its captured dev/ino, strict name, absent active batch, and zero-intent condition all match; symlinks, foreign entries, collisions, or ambiguous identity fail closed without recursive deletion.

Strict journal tests require `stepOrdinal` on every step record and reject it on `authorization`, `resolution`, `projection-pending`, and `terminal`; reject a token/session/absolute root/raw bytes, a missing or manifest-divergent authorization `intentKind`, wrong plan/manifest/capsule/snapshot/resolution/projection/terminal digest, duplicate divergent batch record, projection-before-disk-convergence, and zero-step resolve finalization without its durable full selection record. Delete SQLite and prove each registered intent can reconstruct its strict projection capsule; reject missing, wrong-kind, extra-field, secret-bearing, or tampered capsules before any finalizer. For resolve, reject a selection hash without payload, payload/hash mismatch, missing or duplicate path/choice ID, forged current/selected version, and a zero-step selection after SQLite deletion; replay identical projection-pending and terminal records idempotently after reconstruction. For move steps, require manifest entry metadata for the complete `DirectoryTreeVersion`; raw blobs are not duplicated because move does not change file bytes. Every create/replace reservation binds one deterministic private file source and vault staging basename to raw hash, byte length, plan ordinal, and batch. Every `mkdir-exclusive` reservation binds one deterministic empty-directory source under private staging plus its final vault basename. Durable `staging-source` and `directory-staging-source` records add the observed source identities before any vault mutation. A recovery retirement record binds the created result identity/hash and the deterministic retained identity/hash.

Make corruption cases data-driven and assert SQLite-independent replay explicitly:

```ts
it.each([
  ['sequence gap', (fixture: RecoveryFixture) => fixture.journal[1].seq += 1, 'RECOVERY_JOURNAL_SEQUENCE'],
  ['wrong previous hash', (fixture: RecoveryFixture) => fixture.journal[1].previousEntrySha256 = 'f'.repeat(64), 'RECOVERY_JOURNAL_HASH'],
  ['extra blob', (fixture: RecoveryFixture) => fixture.blobs.push(unreferencedBlob()), 'RECOVERY_BLOB_UNREFERENCED'],
  ['capsule tamper', (fixture: RecoveryFixture) => fixture.manifest.domainProjectionCapsule.payloadSha256 = '0'.repeat(64), 'RECOVERY_CAPSULE_INVALID'],
  ['partial tail', (fixture: RecoveryFixture) => fixture.journalBytes = fixture.journalBytes.slice(0, -1), 'RECOVERY_JOURNAL_PARTIAL']
] as const)('rejects %s', async (_name, mutate, code) => {
  const fixture = makeValidRecoveryFixture();
  mutate(fixture);
  await expect(validateRecoveryFixture(fixture)).rejects.toMatchObject({ code });
});

it('reconstructs the original projection after SQLite deletion', async () => {
  const fixture = makeValidRecoveryFixture({ intentKind: 'kernel_test' });
  await fixture.privateStore.persist(fixture);
  await rm(fixture.databasePath, { force: true });
  const [batch] = await scanRecoveryOnly({
    recoveryStore: fixture.privateStore,
    vaultReadPort: fixture.vaultReadPort,
    intentRegistry: fixture.intentRegistry
  });
  expect(batch.domainProjectionCapsule).toEqual(fixture.manifest.domainProjectionCapsule);
});
```

- [ ] **Step 2: Run and verify RED**

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/private-recovery-store.test.ts tests/unit/recovery-journal.test.ts
```

Expected: FAIL because recovery store modules do not exist.

- [ ] **Step 3: Implement immutable manifest and blobs**

Create an unpredictable, ownership-recorded batch directory under private `<userData>/recovery-preparing`, then create `blobs`, `staging`, and `retained` beneath it with `recursive: false`, mode `0700`. Do not expose `recovery/<batchId>` yet. `PrivateRecoveryStore` is initialized from the already validated app-data realpath/dev/ino and returns only opaque bound-directory handles:

```ts
declare const boundPrivateDirectoryBrand: unique symbol;
export type BoundPrivateDirectory = {
  readonly root: DirectoryIdentity;
  readonly directory: DirectoryIdentity;
  readonly relativeDirectory: string;
  readonly [boundPrivateDirectoryBrand]: true;
};
export interface PrivateRecoveryStore {
  createDirectoryExclusive(parent: BoundPrivateDirectory, name: string): Promise<BoundPrivateDirectory>;
  createFileExclusive(input: {
    readonly parent: BoundPrivateDirectory; readonly name: string;
    readonly bytes: Uint8Array; readonly rawSha256: string;
  }): Promise<{ readonly identity: FileIdentity; readonly byteLength: number }>;
  readFile(input: {
    readonly parent: BoundPrivateDirectory; readonly name: string;
    readonly expectedIdentity: FileIdentity; readonly maximumLength: number;
  }): Promise<Uint8Array>;
  appendFile(input: {
    readonly parent: BoundPrivateDirectory; readonly name: string;
    readonly expectedIdentity: FileIdentity; readonly expectedSize: number;
    readonly bytes: Uint8Array; readonly appendSha256: string;
  }): Promise<{ readonly identity: FileIdentity; readonly byteLength: number }>;
  listAll(parent: BoundPrivateDirectory): Promise<readonly PrivateEntry[]>;
  moveExclusive(input: {
    readonly from: BoundPrivateDirectory; readonly name: string;
    readonly expectedIdentity: FileIdentity | DirectoryIdentity;
    readonly to: BoundPrivateDirectory; readonly toName: string;
  }): Promise<void>;
  fsyncDirectory(directory: BoundPrivateDirectory): Promise<void>;
}
```

The native client streams bytes over stdin only to `private-create-file`/`private-append-file`; it declares length and SHA-256 in argv, caps manifest/journal frames at 16 MiB and blobs at the plan-declared length, and requires exact EOF. The helper performs `openat`/write/fsync/stat/reread/hash/stat under the held bound directory and returns only the verified identity, length, and hash. Reads use the framed stdout protocol. TypeScript never passes `blobPath`, never calls Node `open`/`readFile`/`appendFile` on recovery content, and never reconstructs a child absolute path.

For each create/replace step, put a reservation in the manifest before materializing a staging inode. Its private source path is `staging/<ordinal>-<after-sha-prefix>` and its future vault basename is exactly `.xiaozhao-stage-<batchId>-<ordinal>-<after-sha-prefix>`; bind both names to batch, ordinal, raw hash and byte length, and reject IDs or lengths that do not fit `NAME_MAX`. For every `mkdir-exclusive` step, reserve `staging/<ordinal>-mkdir` plus the final basename, with no content blob. The manifest binds that source as an empty directory owned by this batch; it is created only after active-batch promotion by helper `mkdir-excl` under the bound private staging directory, fsynced, and recorded through `directory-staging-source` before its step intent.

Write canonical `manifest.json` through `PrivateRecoveryStore.createFileExclusive()`, then fsync blobs, staging, retained, the preparing batch, and its parent through the same bound port. Manifest contains the full plan, strict intent-owned `DomainProjectionCapsule`, blob metadata, every deterministic file/directory staging reservation, deterministic retained basenames, and expected identities/hashes but no absolute vault path. A move step stores every sorted discriminated package entry—including empty directories—plus the root identity and tree hash; it does not copy unchanged package bytes into blobs. Once the preparing tree is complete, use `moveExclusive()` to move that captured directory to `recovery/<batchId>`, fsync both parent directories, rebind and validate its dev/ino plus manifest hash, and only then expose the `manifest-persisted` checkpoint. Node never creates or renames an active-batch pathname. After promotion, materialize each reserved private file source from the verified blob through the same native create/read contract, then append/fsync/reread a `staging-source` journal record with its exact dev/ino/hash/length. Materialize each reserved empty-directory source through bound private `mkdir-excl`, fsync and record `directory-staging-source`. Never create a directory directly at a vault target and never write planned bytes directly to a vault pathname from Node. A crash during source materialization therefore still has an immutable manifest; an absent/partial/mismatched source without its valid typed record is manual-only and cannot be adopted automatically.

After a valid `staging-source` record, a reservation is valid only when exactly one of its private source path or exact vault basename has that journal-bound dev/ino/hash/length. Both, neither, a different inode/hash, an unexpected same-prefix name, or a `staged` journal record whose identity disagrees is conflict/manual-only. Unrelated hidden names are never adopted or deleted.

- [ ] **Step 4: Implement newline-terminated hash-chain records**

```ts
const body: JournalEntryBody = { batchId, seq, previousEntrySha256, ...payload };
const entrySha256 = sha256Text(canonicalJson(body));
const line = `${canonicalJson({ ...body, entrySha256 })}\n`;
```

Use `PrivateRecoveryStore.createFileExclusive()` for the first journal line and `appendFile()` thereafter. Under one process mutex, append exactly one full line, fsync, read the complete file back through the same operation's held descriptor contract, and validate the entire chain through `journalEntryBodySchema`, the strict union from Task 1. Never close and reopen an app-data recovery pathname through Node. `staging-source` binds a fully fsynced private file inode; `directory-staging-source` binds a fully fsynced empty-directory inode. `intent` binds the manifest's exact vault staging/final basename before any vault move; after descriptor-anchored landing and both directory fsyncs, the typed `staged` entry proves that same file/directory inode now occupies the planned basename before commit can proceed. Append one redacted `authorization`—including exact manifest and capsule digests plus `intentKind` copied from the branded authorization and checked against `manifest.plan.intent.kind`—before the first step intent. Append `observed-version-intent` before creating a post-manifest conflict evidence blob and `observed-version` only after the exclusive evidence inode is fsynced/reread. Append the full strict `resolution` payload before any resolve helper or zero-step finalization. `projection-pending` is legal only after the scanner and verifier prove recovery disk convergence and only while the state kernel is recovery-only; ordinary coordinator code may never use it as a substitute for the original intent finalizer. `terminal` is legal only after final-state verification plus a stable finalizer receipt, must be the last distinct record, and is fsynced/reread before SQLite transition. A partial tail yields `RECOVERY_JOURNAL_PARTIAL`, never an ignored record.

- [ ] **Step 5: Make discovery independent of SQLite**

Create/private the recovery root before SQLite open and expose it in normal and recovery-only state kernels. Journal parsing remains in recovery modules. SQLite corruption must not prevent manifest/blob/journal validation.

```ts
const recoveryStore = await PrivateRecoveryStore.open({
  appDataRoot: validatedAppDataRoot,
  nativePort
});
const recoveryKernel = await createRecoveryKernel({ recoveryStore, vaultReadPort });

try {
  const database = openDatabase(databasePath);
  return createNormalStateKernel({ database, recoveryKernel });
} catch (error) {
  return createRecoveryOnlyStateKernel({ recoveryKernel, databaseError: safeDatabaseError(error) });
}
```

The recovery-only branch must not instantiate an ordinary repository, watcher, indexer, model client, or workflow service. Its tests delete and corrupt SQLite before process start, then prove that `PrivateRecoveryStore.listAll()` and strict manifest/journal validation still enumerate the same batches.

- [ ] **Step 6: Run and commit**

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/private-recovery-store.test.ts tests/unit/recovery-journal.test.ts
npm exec -- vitest run --config vitest.integration.config.ts tests/integration/database-kernel.test.ts
git add src/server/vault/PrivateRecoveryStore.ts src/server/recovery/recovery-manifest.ts src/server/recovery/recovery-journal.ts tests/unit/private-recovery-store.test.ts tests/unit/recovery-journal.test.ts src/server/db/database.ts tests/integration/database-kernel.test.ts
git commit -m "feat: persist self contained recovery journal"
```

Expected: recovery validation still works with SQLite unavailable.

### Task 7: Implement exclusive staging, helper commits, and verification

**Files:**
- Create: `src/server/vault/FileSystemVaultWriter.ts`
- Create: `src/server/workflow/write-verifier.ts`
- Create: `src/server/workflow/write-intent-registry.ts`
- Modify: `src/server/vault/VaultGateway.ts`
- Create: `tests/integration/write-kernel.test.ts`

- [ ] **Step 1: Write failing writer tests in a sentinel vault**

Cover create, replace, `entryKind:'file'` exclusive move, `entryKind:'directory'` whole-package move, staged empty-directory landing, recovery-only identity-bound retirement of a landed create/directory, external mutation immediately before swap/move, target or staged entry replacement between observation and helper rename, helper success whose exchanged old bytes do not match expected, target collision, symlink insertion, unsupported primitive, and post-commit reread mismatch. Prove planned bytes and empty directory inodes are first materialized only under private app-data, then landed under a manifest reservation solely by descriptor-anchored, root/parent/entry-identity-bound helper operations; Node never opens a vault staging pathname for writing or calls `mkdir` on a vault path. Race an authorized root/parent replacement before helper open and after descriptor acquisition; collide with a foreign exact basename, create same-prefix foreign names, and interleave two batch IDs. Only the exact manifest-bound dev/ino/hash may be reported committed. A detected post-rename mismatch is a recovery incident; preserve every observed location and attempt a reverse only through a separately journaled, freshly identity-bound, non-overwriting recovery operation. For file moves, modify bytes after planning and after moving. For package moves, mutate/add/delete a nested file, add/delete/rename an empty directory, and insert hidden file/dir/symlink/socket entries at both points; every allowed-tree change changes the version, while every forbidden entry rejects the move. A created-file/directory retirement must use the recorded dev/ino (and file hash), move it exclusively into the original batch's private retained area, fsync both parents, and leave the vault path absent; changed identity/hash or occupied retained name is manual-only. Reject symlinks, sockets, devices, FIFOs, and special tree entries. Each conflict preserves every observed byte version. Registry tests reject missing, duplicate, wrong-kind, and invalid projection-capsule handlers before manifest preparation.

The core failure assertion must preserve all observed versions and refuse unregistered intent handlers:

```ts
it.each(['create', 'replace', 'move-file', 'move-directory', 'mkdir'] as const)(
  'preserves evidence when %s changes after planning',
  async (kind) => {
    const fixture = await createWriterFixture(kind);
    await fixture.mutateAfterObservation();
    await expect(fixture.execute()).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(await fixture.observedVersions()).toEqual(fixture.expectedPreservedVersions);
    expect(await fixture.vaultWritesOutsideNativeHelper()).toEqual([]);
  }
);

it('rejects an unregistered or wrong-kind projection capsule before preparation', async () => {
  const fixture = await createWriterFixture('replace');
  fixture.registry.remove('kernel_test');
  await expect(fixture.execute()).rejects.toMatchObject({ code: 'WRITE_INTENT_HANDLER_MISSING' });
  expect(await fixture.privateStore.listAll(fixture.recoveryRoot)).toEqual([]);
  expect(fixture.helperCalls()).toEqual([]);
});
```

- [ ] **Step 2: Run and verify RED**

```bash
npm exec -- vitest run --config vitest.integration.config.ts tests/integration/write-kernel.test.ts --no-file-parallelism
```

Expected: FAIL because writer and verifier do not exist.

- [ ] **Step 3: Add a mutation port separate from reads**

```ts
export interface AtomicVaultMutationPort {
  observeFile(path: string): Promise<FileVersion>;
  observeTree(path: string): Promise<DirectoryTreeVersion>;
  landManifestStaging(input: {
    readonly batchId: string; readonly stepOrdinal: number;
    readonly targetPath: string;
    readonly reservation: ManifestStagingReservation;
  }): Promise<{ readonly basename: string; readonly identity: FileIdentity }>;
  commitReplace(input: {
    readonly path: string; readonly stagedBasename: string;
    readonly expectedBeforeSha256: string; readonly expectedAfterSha256: string;
  }): Promise<Extract<ObservedStepResult, { readonly kind: 'replace' }>>;
  commitCreate(input: {
    readonly path: string; readonly stagedBasename: string;
  }): Promise<Extract<ObservedStepResult, { readonly kind: 'create' }>>;
  commitMoveExclusive(input:
    | { readonly entryKind: 'file'; readonly fromPath: string; readonly toPath: string;
        readonly expectedFromSha256: string }
    | { readonly entryKind: 'directory'; readonly fromPath: string; readonly toPath: string;
        readonly expectedFromTreeSha256: string }
  ): Promise<
    | Extract<ObservedStepResult, { readonly kind: 'move-exclusive-file' }>
    | Extract<ObservedStepResult, { readonly kind: 'move-exclusive-directory' }>
  >;
  commitMkdirExclusive(input: {
    readonly path: string; readonly batchId: string; readonly stepOrdinal: number;
    readonly stagedIdentity: DirectoryIdentity;
  }): Promise<
    Extract<ObservedStepResult, { readonly kind: 'mkdir-exclusive' }>
  >;
  commitRmdirCreatedEmpty(input: {
    readonly path: string; readonly expectedIdentity: DirectoryIdentity;
    readonly createdByBatchId: string; readonly recoveryBatchId: string;
  }): Promise<Extract<ObservedStepResult, { readonly kind: 'rmdir-created-empty' }>>;
  commitRetireCreatedFile(input: {
    readonly path: string; readonly expectedCurrentSha256: string;
    readonly expectedIdentity: FileIdentity;
    readonly createdByBatchId: string; readonly recoveryBatchId: string;
  }): Promise<Extract<ObservedStepResult, { readonly kind: 'retire-created-file' }>>;
}
```

Keep this server-internal; do not widen `ReadVaultGateway` or expose it to renderer code.

- [ ] **Step 4: Implement same-directory staging and atomic commits**

`landManifestStaging()` does not accept caller bytes or invent a basename. It loads the immutable manifest reservation, verifies the private app-data source's exact dev/ino/hash/length and the target parent/root identities, then calls native helper `move-excl` from that private source into the exact deterministic hidden vault basename. The helper's component-by-component no-follow directory walk holds both descriptors across the rename. After helper success, fsync both parents, reread the landed inode through the safe gateway, require the same identity/hash/length, and append/reread the `staged` journal entry. Node performs no write-open against a vault staging path. An occupied destination, source/target race, both/neither location, or identity/hash drift preserves every entry and becomes recovery-required/manual-only.

```ts
const landed = await helper.moveExclusive({
  from: reservation.privateSource,
  expectedSourceIdentity: sourceRecord.observedFileIdentity,
  to: reservation.boundVaultParent,
  toName: reservation.vaultStagingBasename,
});
await helper.fsyncDirectory(reservation.boundPrivateParent);
await helper.fsyncDirectory(reservation.boundVaultParent);
await assertLandedReservation({ reservation, sourceRecord, landed });
await journal.append(stagedEntryFor(reservation, landed.identity));
```

`commitReplace()` receives only a successfully landed, manifest-bound staged basename and observes expected target hash immediately before helper swap. After swap, staged basename contains commit-instant old target; verify its hash and inode identity. On a match, use helper `move-excl` to retire that inode to the batch's private `retained/<ordinal>-before`, fsync both target and retained directories, and record retained hash/identity before declaring the step verified. Never leave the hidden staging basename in the vault after a normal commit.

If the exchanged old hash differs, read the still-hidden exchanged-old inode through the manifest-bound descriptor reader, require stable dev/ino/size/mtime before and after, and compute its bytes hash in memory. Append/fsync an `observed-version-intent` reservation containing only step ordinal, source identity, hash, length, and deterministic private evidence basename; exclusive-create/fsync/reread that appData evidence file; then append/fsync the typed `observed-version` result with the evidence dev/ino and blob hash. The strict journal union includes both branches, and no observed blob is valid without the matching intent+result pair. A crash after intent but before evidence completion is resumable only while the exact hidden source inode remains; a crash after evidence creation but before result leaves an unreferenced extra blob and therefore becomes manual-only with every name preserved, never auto-adopted. The original execution stops here: it does not swap back, retire either exchanged inode, or report success. It journals the observed target/staged identities and hashes, preserves the target, hidden staged name, and private evidence blob, and classifies the batch manual-only. Any later exchange is a new, separately authorized `kernel_recovery` plan that first binds this exact fresh snapshot, appends its own durable intent, and rechecks both current identities immediately before the non-overwriting helper call; if those conditions fail, it preserves every name/blob for manual resolution.

`observeTree()` uses the internal descriptor-anchored `scan-tree-private` command, so one native process sees and stability-checks the entire namespace before returning it. It sees every name before applying policy, follows no links, accepts only non-hidden same-device regular files/directories, records the package root identity plus sorted discriminated file and directory entries (including empty directories), and returns canonical `treeSha256`; hidden, symlink, special, cross-device, or unstable entries reject the entire tree. `commitCreate()` uses helper exclusive move from the already landed manifest basename to the absent target, rereads the created file, and returns the discriminated create result with its dev/ino for the durable result entry. File moves reobserve `expectedFromSha256`; directory-package moves reobserve the complete source tree and require exact `rootIdentity + treeSha256`. Both use the same bound helper exclusive rename and fsync parents; afterwards file moves return source-absence plus destination bytes, while package moves return source-absence plus the recomputed destination tree. `commitMkdirExclusive()` accepts only the already journaled private empty-directory inode, lands it by identity-bound `move-excl`, fsyncs both parents, and returns the exact directory identity; it never calls `mkdirat` in the vault. `commitRmdirCreatedEmpty()` is recovery-only and returns a directory-removed result only after same-batch identity, emptiness, exclusive retained move and vault absence verification; the helper does not unlink the retained directory. `commitRetireCreatedFile()` is recovery-only, revalidates the landed create's recorded dev/ino and after hash, derives a deterministic private retained basename from the original/recovery batch IDs, invokes the existing helper `move-excl`, fsyncs both parents, and returns vault absence plus retained identity/hash. It never unlinks a vault file. No method uses recursive mkdir or ordinary unjournaled directory creation in the vault.

- [ ] **Step 5: Verify bytes, schema, and links after every step**

```ts
export interface WriteVerifier {
  verify(step: WriteStep, actual: ObservedStepResult): Promise<void>;
}
```

Implement an exhaustive switch over `step.kind` and, for `move-exclusive`, `entryKind`; each branch requires the matching `ObservedStepResult.kind` and a `never` assertion makes a newly added step fail TypeScript until handled. Verify raw SHA-256 and length for file states, complete tree hashes for directory moves, exact source/target absence, created/removed identity, and retained identity/hash as applicable. For Markdown, use current frontmatter parsers and wikilink extraction. Source YAML patches also require a byte-preservation proof that every unapproved range is identical.

Create `write-intent-registry.ts` as the only dispatch surface:

```ts
export interface WriteIntentVerifierHandler<Kind extends WriteIntentKind> {
  readonly kind: Kind;
  buildProjectionCapsule(input: {
    readonly intent: Extract<WriteIntent, { readonly kind: Kind }>;
    readonly plan: WritePlan;
  }): Promise<DomainProjectionCapsule>;
  validateProjectionCapsule(capsule: DomainProjectionCapsule): Promise<void>;
  verifyPlan(intent: Extract<WriteIntent, { readonly kind: Kind }>, plan: WritePlan): Promise<void>;
  verifyStep(intent: Extract<WriteIntent, { readonly kind: Kind }>, step: WriteStep): Promise<void>;
  verifyFinalState(
    intent: Extract<WriteIntent, { readonly kind: Kind }>,
    plan: WritePlan,
  ): Promise<void>;
}
export type FinalizerReceipt = {
  readonly projectionSha256: string;
  readonly projectionCapsuleSha256: string;
  readonly finalizedAt: string;
};
export interface WriteIntentFinalizerHandler<Kind extends WriteIntentKind> {
  readonly kind: Kind;
  finalizeVerified(input: {
    readonly intent: Extract<WriteIntent, { readonly kind: Kind }>;
    readonly plan: WritePlan;
    readonly batchId: string;
    readonly projectionCapsule: DomainProjectionCapsule;
  }): Promise<FinalizerReceipt>;
  finalizeRecoveryVerified(input: {
    readonly originalIntent: Extract<WriteIntent, { readonly kind: Kind }>;
    readonly originalPlan: WritePlan;
    readonly originalBatchId: string;
    readonly recoveryIntent: KernelRecoveryWriteIntent;
    readonly recoveryPlan: WritePlan;
    readonly recoveryBatchId: string;
    readonly direction: 'continue' | 'rollback' | 'resolve';
    readonly projectionCapsule: DomainProjectionCapsule;
  }): Promise<FinalizerReceipt>;
}
export interface WriteIntentHandlerRegistry {
  requireVerifier(intent: WriteIntent): WriteIntentVerifierHandler<WriteIntentKind>;
  requireFinalizer(intent: WriteIntent): WriteIntentFinalizerHandler<WriteIntentKind>;
}
```

Register only `kernel_test` and `kernel_recovery` handlers here. Before policy authorization, the original handler builds and strictly revalidates its immutable projection capsule; the recovery handler never substitutes a new capsule for the original one. Each `finalizeVerified()` implementation is idempotent under the stable `(batchId, plan.planSha256, projectionCapsule.payloadSha256)` key and owns the intent-specific completed projection plus any affected-index refresh. It persists and returns the same `FinalizerReceipt` on every replay; `projectionSha256` hashes the exact durable domain/index projection, `projectionCapsuleSha256` echoes the validated capsule, and `finalizedAt` is created once, never regenerated. Each `finalizeRecoveryVerified()` implementation is independently idempotent under `(originalBatchId, recoveryBatchId, recoveryPlan.planSha256, direction, projectionCapsule.payloadSha256)` and returns the same kind of receipt: `continue` produces the same domain/index state as a fully verified original plan; `rollback` restores the verified before-state projection; `resolve` reindexes the explicitly selected stable disk versions and invokes the original handler's documented conflict projection without projecting ordinary success. Later phases append direct union members to `WriteIntent`, exact capsule schemas, and both finalization paths to this registry; they do not add coordinator branches. A recovery process that crashes resumes the same recovery plan and batch; it does not wrap that failure in another nested `kernel_recovery` plan.

- [ ] **Step 6: Run and commit**

```bash
npm run test:native-contract
npm exec -- vitest run --config vitest.integration.config.ts tests/integration/write-kernel.test.ts --no-file-parallelism
git add src/server/vault/FileSystemVaultWriter.ts src/server/workflow/write-verifier.ts src/server/workflow/write-intent-registry.ts src/server/vault/VaultGateway.ts tests/integration/write-kernel.test.ts
git commit -m "feat: commit atomic vault mutations"
```

Expected: injected mutation becomes conflict; expected, external, and proposed bytes remain recoverable.

### Task 8: Execute plans through one serialized coordinator

**Files:**
- Create: `src/server/workflow/write-repository.ts`
- Create: `src/server/workflow/write-coordinator.ts`
- Modify: `tests/integration/write-kernel.test.ts`

- [ ] **Step 1: Write failing ordering and optimistic-state tests**

Test idempotent batch creation, one active coordinator, stale batch version, native gate, Phase 0 `RuleCompatibilityGate`, and `MutationTargetPolicy.assertCurrent()` re-evaluation under lock, manifest before first mutation, intent before each mutation, result after verification, source status last, registry dispatch by `plan.intent.kind`, and immediate stop after ambiguous helper results. Reject missing, forged, replayed-to-another-plan, and stale authorizations before manifest preparation. With the default deny gate, assert `RULE_BUNDLE_UNAPPROVED` before repository/manifest/helper effects. With the explicit sentinel-fixture gate, change any one of the five rules before manifest, between steps, and after the last step but before finalization; require `RULE_BUNDLE_UNAPPROVED` when approval is missing/stale and `RULE_BUNDLE_STALE` when the immutable plan hash differs from the freshly loaded current bundle. Prove each step writes only its core result; the finalizer runs exactly once per execution only after every disk step, journal result, and final-state verification succeeds. Inject a crash after finalization but before the core committed transition, rerun recovery, and prove idempotent finalization creates no duplicate projection or index side effect. API/UI success reads must remain unavailable until finalization finishes.

Assert the durable order as an exact sequence and verify the deny gate has zero side effects:

```ts
it('persists every authority and disk checkpoint in order', async () => {
  const fixture = await createCoordinatorFixture();
  await fixture.coordinator.execute(fixture.input);
  expect(fixture.checkpoints).toEqual([
    'manifest-persisted', 'staging-source-fsynced', 'intent-persisted',
    'staging-landed', 'before-helper', 'after-helper', 'old-version-retired',
    'directory-fsynced', 'result-persisted', 'step-verified',
    'final-state-verified', 'finalize-started', 'finalize-completed',
    'terminal-persisted', 'core-transitioned', 'batch-committed'
  ]);
  expect(fixture.plan.steps.at(-1)?.role).toBe('source-status');
});

it('blocks an unapproved rule bundle before repository, manifest, or helper effects', async () => {
  const fixture = await createCoordinatorFixture({ ruleGate: 'deny' });
  await expect(fixture.coordinator.execute(fixture.input))
    .rejects.toMatchObject({ code: 'RULE_BUNDLE_UNAPPROVED' });
  expect(fixture.repositoryWrites).toEqual([]);
  expect(fixture.manifestWrites).toEqual([]);
  expect(fixture.helperCalls).toEqual([]);
});
```

- [ ] **Step 2: Run and verify RED**

```bash
npm exec -- vitest run --config vitest.integration.config.ts tests/integration/write-kernel.test.ts --no-file-parallelism
```

Expected: coordinator cases fail because repository/coordinator do not exist.

- [ ] **Step 3: Implement optimistic SQLite projection transitions**

Use this exact transition and require `changes === 1`:

```sql
UPDATE write_batches
SET state = ?, version = version + 1, error_code = ?, updated_at = ?
WHERE id = ? AND version = ? AND state = ?
```

Throw `WRITE_BATCH_VERSION_CONFLICT` otherwise. Journal remains authoritative for recovery.

- [ ] **Step 4: Implement checkpoints and execution order**

```ts
export interface WorkflowMutationMutex {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

export type WriteCheckpoint =
  | 'manifest-persisted' | 'staging-source-fsynced' | 'intent-persisted'
  | 'staging-landed' | 'before-helper' | 'after-helper'
  | 'old-version-retired' | 'directory-fsynced'
  | 'result-persisted' | 'step-verified' | 'final-state-verified'
  | 'finalize-started' | 'finalize-completed' | 'terminal-persisted'
  | 'core-transitioned' | 'batch-committed';
```

Expose the ordinary entry as:

```ts
execute(input: {
  readonly authorization: MutationTargetAuthorization;
  readonly plan: WritePlan;
  readonly projectionCapsule: DomainProjectionCapsule;
  readonly bytesBySha256: ReadonlyMap<string, Uint8Array>;
}): Promise<void>;
```

Under one async mutex, use one private `assertRuleCompatibility(plan)` routine. It reloads the authoritative five-file bundle, first calls `ruleCompatibilityGate.assertApproved(current.fingerprint)` and maps every missing/stale/invalid approval to `RULE_BUNDLE_UNAPPROVED`; only after the current bundle is approved does it compare `plan.ruleBundleSha256`, returning `RULE_BUNDLE_STALE` for an older immutable plan. Require the strict record's `bundleSha256` to equal current and plan. Call it before `policy.assertCurrent()` and before any repository or manifest side effect. Dispatch the handler for `plan.intent`, strictly revalidate the supplied capsule and its digest, require it matches the authorization, then re-evaluate the native gate and require no pending recovery. Persist verified private app-data blobs plus the immutable manifest containing the capsule and deterministic staging reservations, mark prepared, and append/reread the redacted batch-level `authorization` record binding policy, plan, manifest, capsule, scope, operation, and confirmation provenance. For each create/replace step, materialize its private source and durably append/reread `staging-source`; for `mkdir-exclusive`, materialize and record `directory-staging-source`; then persist/reread intent. Run `assertRuleCompatibility(plan)`, `policy.assertCurrent(...)`, capsule validation, and the native gate, land the journal-bound inode through helper `move-excl`, fsync/reread it, and persist/reread the typed `staged` entry. Immediately before the commit helper for every step, run all four checks again; only then invoke it, fsync parents, obtain the discriminated observation, verify it, and persist/reread the core step result. After every result is durable, validate the full journal, run all four checks once more, call `verifyFinalState()` once, then call the idempotent `finalizeVerified()` with the capsule and receive its stable `FinalizerReceipt`. Derive one canonical final disk snapshot, require the receipt echoes the capsule digest, append/fsync/reread the strict `terminal` record using that receipt's digest/timestamp, and only then transition SQLite to the record's declared core outcome. API/UI success requires both the durable terminal and matching SQLite transition. On ambiguity after manifest preparation, leave durable intent and every manifest-known inode, best-effort mark recovery-required, and stop. On restart after a crash after finalization, recovery revalidates disk/journal/capsule, retrieves the same idempotent receipt, appends an absent terminal or replays the terminal-declared SQLite transition; it never invents a new timestamp/digest. Neither coordinator nor writer reads `NODE_ENV`, `WRITE_ENABLED`, rule-approval environment values, or authorization env vars.

- [ ] **Step 5: Run and commit**

```bash
npm exec -- vitest run --config vitest.integration.config.ts tests/integration/write-kernel.test.ts tests/integration/database-kernel.test.ts --no-file-parallelism
git add src/server/workflow/write-repository.ts src/server/workflow/write-coordinator.ts tests/integration/write-kernel.test.ts
git commit -m "feat: coordinate journaled write plans"
```

Expected: execution is serial and every source-status step is last.

### Task 9: Classify recovery from journal plus actual disk hashes

**Files:**
- Create: `src/server/recovery/recovery-scanner.ts`
- Create: `src/server/workflow/recovery-service.ts`
- Modify: `src/server/workflow/write-coordinator.ts`
- Modify: `src/server/start-server.ts`
- Modify: `tests/unit/recovery-journal.test.ts`
- Modify: `tests/integration/write-kernel.test.ts`

- [ ] **Step 1: Write the failing recovery matrix**

For each step kind, cover disk equal to before, after, both swap names present, neither expected hash, missing blob, partial journal, broken hash chain, later external mutation, and fully committed journal. File-move recovery compares exact SHA/length; directory-move recovery compares complete source/destination `DirectoryTreeVersion`, including nested modify/add/delete after planning and after moving. A landed create with its exact result hash/dev/ino must generate `retire-created-file`; a changed or replaced create target is manual-only and is never deleted. Only exact file/tree before/after matches expose automatic `continue` or `rollback`; an unknown file version or special-file tree exposes `manual-only` and never calls the writer without a later explicit resolution plan. For a regular but drifted directory topology, test the only V1 resolution: a fresh full-tree snapshot plus explicit `keep_current_topology`, zero helper calls, `manually-resolved`, and original workflow conflict/needs-review. Reject any directory before/after/retained selection, uploaded archive, member deletion/move, or topology hash race because move bytes were never duplicated into recovery blobs. Add authorization tests proving arbitrary callers cannot request recovery mode, bind a snapshot from one batch to another, or use recovery while no matching pending manifest exists. Register a fake original-intent finalizer and prove continue calls its `finalizeRecoveryVerified(...direction:'continue')`, rollback calls the rollback branch, and a verified manual choice calls `direction:'resolve'`; none dispatch domain projection from `recoveryPlan.intent.kind`, and a crash after any finalization but before batch-state transitions replays without duplicate projection or index effects.

Represent every disk state in one explicit table; only exact known states may expose automatic actions:

```ts
it.each([
  ['before', ['continue', 'rollback']],
  ['after', ['continue', 'rollback']],
  ['both-swap-names', ['resolve', 'export']],
  ['neither-known-hash', ['resolve', 'export']],
  ['missing-blob', []],
  ['partial-journal', []],
  ['complete-terminal', ['export']]
] as const)('classifies %s from disk plus journal', async (diskState, allowedActions) => {
  const fixture = await createRecoveryFixture({ diskState });
  const snapshot = await fixture.scanner.scan(fixture.batchId);
  expect(snapshot.allowedActions).toEqual(allowedActions);
  if (!allowedActions.includes('continue') && !allowedActions.includes('rollback')) {
    expect(fixture.writerCalls()).toEqual([]);
  }
});

it.each(['continue', 'rollback', 'resolve'] as const)(
  'dispatches %s finalization through the original intent',
  async (direction) => {
    const fixture = await createRecoveryFixture({ direction, originalIntentKind: 'kernel_test' });
    await fixture.service.executeRecovery(fixture.request);
    expect(fixture.originalFinalizer).toHaveBeenCalledWith(
      expect.objectContaining({ direction, projectionCapsule: fixture.originalCapsule })
    );
    expect(fixture.recoveryIntentFinalizer).not.toHaveBeenCalled();
  }
);
```

- [ ] **Step 2: Run and verify RED**

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/recovery-journal.test.ts
npm exec -- vitest run --config vitest.integration.config.ts tests/integration/write-kernel.test.ts --no-file-parallelism
```

Expected: FAIL because scanner/service do not exist.

- [ ] **Step 3: Implement SQLite-independent scanning**

Enumerate only direct non-symlink batch directories through `PrivateRecoveryStore.listAll()` from the bound app-data root; validate modes, captured root/batch identity, immutable manifest hash, strict projection capsule, each blob/staging/retained inode hash and identity, and the full journal chain before rereading vault paths through descriptor authority. For each file or directory staging reservation, inspect only its exact private source and exact deterministic vault/final basename and require the manifest/journal-bound identity (plus hash/length for files) at exactly one location; never glob/adopt a prefix match. Both/neither, a foreign collision, or a typed `staged` record mismatch is manual-only with all names preserved. For replace, classify target, that exact in-vault staging basename, retained-before, retained-proposed, and any unknown-old blob; such a blob is trusted only when exactly one valid `observed-version` record binds its original step, source identity, evidence identity, hash and length. An unreferenced extra blob or a record with an absent/mismatched blob is manual-only, never silently adopted. For `move-exclusive`, recompute both trees through hidden-inclusive native inspection from root identity plus sorted discriminated file/directory records, including empty directories, and compare `treeSha256`; any hidden/symlink/special/cross-device member is manual-only, never silently omitted.

```ts
export type RecoveryBatchSnapshot = {
  readonly batchId: string;
  readonly integrity: 'valid' | 'partial-journal' | 'invalid';
  readonly completedOrdinals: readonly number[];
  readonly pendingOrdinal?: number;
  readonly classification: 'recoverable' | 'manual-only' | 'complete' | 'invalid';
  readonly allowedActions: readonly (
    'continue' | 'rollback' | 'resolve' | 'export'
  )[];
  readonly reasonCode: string;
  readonly snapshotSha256: string;
};
```

`write-coordinator.ts` exports this one server-internal mutex contract and its FIFO implementation. `startServer()` constructs exactly one instance for the process and injects it into `WriteCoordinator` and `RecoveryService`; later phases must inject that same instance into plan bind/cancel/supersede paths and retention cleanup instead of constructing feature-local locks. The mutex is process-wide because V1 is a single-user desktop App. Lock ownership is non-reentrant and explicit: `RecoveryService` may use one bounded lock segment to replay a recovery-entry hook and derive a snapshot/action/plan, but it must release that segment before calling `WriteCoordinator.executeRecovery()`; the coordinator is the sole lock owner for execution and, after acquiring it itself, repeats the idempotent recovery-entry hook, authoritative scan, snapshot/action/plan validation, and every current check before effects. No service calls a coordinator while already inside `runExclusive()`. Tests hold each boundary and prove a second planner, recovery or coordinator operation cannot persist state, that a change between the service segment and coordinator acquisition fails the repeated check, and that no nested acquisition deadlocks.

`allowedActions` uses the fixed order `continue, rollback, resolve, export`, contains no duplicate, and is derived only from the current validated disk/journal snapshot. One recoverable snapshot may safely expose both continue and rollback. A `manual-only` snapshot exposes `resolve` and `export` only when the complete manifest/journal chain, every declared blob and retained identity are valid; a `complete` snapshot exposes only `export` while that same complete evidence remains retained. `partial-journal`, `missing-blob`, broken-chain, and every other evidence-integrity `invalid` snapshot expose no export action because Phase 4's verified exporter cannot acquire a lease for them. Routes and UI never infer an action from `classification` or SQLite. Do not infer success from SQLite: a committed row without a valid matching terminal journal remains recovery-required.

- [ ] **Step 4: Implement conditional continue, rollback, and manual resolution**

Accept a fresh `snapshotSha256`. Continue resumes at the first durable intent only if disk versions still match the classified set. Every recovery plan has fresh contiguous ordinals and binds each step back through `recoveryOfOrdinal`. Rollback constructs a `kernel_recovery` intent whose reverse bindings include only durably landed steps in strict descending original ordinal; it never reuses original ordinals or overwrites directly.

Avoid the ordinary-entry recovery deadlock by adding this separate coordinator entry:

```ts
executeRecovery(input: {
  readonly authorization: MutationTargetAuthorization;
  readonly batchId: string;
  readonly snapshotSha256: string;
  readonly intent: Extract<WriteIntent, { readonly kind: 'kernel_recovery' }>;
  readonly recoveryPlan: WritePlan;
  readonly projectionCapsule: DomainProjectionCapsule;
}): Promise<void>;
```

Inside its own acquisition of the same global mutex, `executeRecovery()` first replays the original-intent `enterRecoveryRequired` hook when present, requires its exact idempotent result, rescans the authoritative disk/journal state, and requires the supplied snapshot/action/recovery plan to still match. It then calls the same `assertRuleCompatibility(recoveryPlan)` before any recovery-plan repository/manifest effect, immediately before every recovery helper call, and again before final verification/finalization. The current approved hash must equal `recoveryPlan.ruleBundleSha256`; the immutable original plan is validated as historical manifest evidence and need not be rewritten to the current hash. It reloads the immutable original plan and capsule from the validated original manifest, requires the supplied capsule and authorization digest to match them exactly, strictly validates that capsule through the original-intent handler, and then revalidates `MutationTargetPolicy` with the complete `{ targetRoot, appDataRoot, plan: recoveryPlan, projectionCapsule, profile }` input. It requires `intent.originalBatchId === batchId` and `intent.snapshotSha256 === snapshotSha256`, requires the scanner to reproduce that exact snapshot hash, and permits only that batch's pending recovery record. For `direction: 'continue'`, the recovery steps' `recoveryOfOrdinal` values must identify the unchanged not-yet-landed suffix of the original plan in ascending original order while the recovery ordinals remain `0..n-1`. After the suffix is durable, it verifies the original plan's complete after-state, dispatches by `originalPlan.intent.kind`, and obtains the stable receipt from `finalizeRecoveryVerified(...direction:'continue', projectionCapsule)`. It then appends/fsyncs a `recovery_continue` terminal record declaring recovery-batch `committed` plus original-batch `committed`; only that record authorizes both SQLite transitions. For `direction: 'rollback'`, recovery ordinals again remain contiguous while `recoveryOfOrdinal` traverses durably landed original steps in strict descending order. Reverse mapping is exact by original kind: replace restores the validated retained before bytes, move-exclusive uses an identity/version-bound inverse exclusive move, create becomes `retire-created-file`, and mkdir-exclusive becomes `rmdir-created-empty`. After complete before-state verification, the same original-intent finalizer returns its stable rollback receipt; append/fsync `recovery_rollback` declaring recovery-batch `committed` and original-batch `rolled-back` before either SQLite transition.

For `direction:'resolve'`, require a current manual-only snapshot whose `allowedActions` contains `resolve`. The API submits only the fresh `snapshotSha256` plus one opaque `affectedEntryId` and discriminated action per affected path; `choiceId` is required only for `select_version` and `select_absent_before_create`, while `keep_current` and `keep_current_topology` omit it. The service resolves those IDs against its exact fresh current/known-version catalogue, derives the current-choice ID for keep actions, and constructs the complete internal `RecoveryResolutionSelection[]` whose `choiceId` remains required. Every file selection must resolve to the exact current bytes or an already validated before/after/retained blob from that manifest; every directory selection must be `keep_current_topology` bound to the freshly observed complete tree/hash and may not select an unstored historical tree; absence may be selected only for an original create whose before state was absent. Require complete path coverage, canonical order, unique affected-entry and selected-choice IDs, and exact server-derived original ordinals. Recompute `resolutionSha256`, forbid caller-supplied bytes, paths, hashes, directories, member lists, ordinals, or archives, give each emitted file step a new contiguous ordinal plus the selected path's server-derived `recoveryOfOrdinal`, and bind every non-current file step's expected-before hash to the observed current hash. Keep-current file/topology/absence selections emit no filesystem step.

Persist and reread the complete strict resolution journal payload before the first helper call or zero-step finalization. Then re-scan and require both current snapshot and each choice catalogue entry unchanged. After the selected disk state is durable, obtain the stable receipt from the original-intent `finalizeRecoveryVerified(...direction:'resolve', projectionCapsule)`, append/fsync a `manual_resolve` terminal record declaring recovery-batch `committed` and original-batch `manually-resolved`, then replay those exact SQLite transitions. Preserve the complete incident evidence; never label the original batch committed or rolled-back. The finalizer dispatches an intent-specific review/conflict projection rather than a nonexistent universal state: intake → `needs_confirmation` with `MANUAL_RECOVERY_CONFLICT`; extraction → existing `reviewing` with the same issue code; knowledge edit → draft `conflict`. It refreshes only parseable current index rows/trees and records schema issues for unparseable selected files. SQLite-independent replay loads the original capsule from the original manifest and rejects a recovery manifest that substitutes another capsule.

The `kernel_recovery` verifier owns recovery-plan mechanics, but its kind never substitutes for the original domain finalizer. A crash after recovery finalization but before any core transition revalidates disk/journal and reruns the idempotent original-intent finalizer. `executeRecovery()` bypasses only the broad `requireNoPendingRecovery()` check; it never bypasses target policy, native capability gate, manifest integrity, file/tree hash conditions, final-state verification, idempotent finalization, or handler registry. Ordinary `execute()` remains blocked while any recovery exists. A changed target returns `VERSION_CONFLICT`; manual-only permits only read-only inspection/export until a separately authorized resolve plan is supplied.

- [ ] **Step 5: Run and commit**

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/recovery-journal.test.ts
npm exec -- vitest run --config vitest.integration.config.ts tests/integration/write-kernel.test.ts --no-file-parallelism
git add src/server/recovery/recovery-scanner.ts src/server/workflow/recovery-service.ts src/server/workflow/write-coordinator.ts src/server/start-server.ts tests/unit/recovery-journal.test.ts tests/integration/write-kernel.test.ts
git commit -m "feat: recover from durable disk evidence"
```

Expected: unknown disk hashes never invoke helper methods.

### Task 10: Prove every crash window and promote exact evidence

**Files:**
- Create: `tests/helpers/write-crash-worker.ts`
- Create: `tests/integration/write-recovery-crash.test.ts`
- Modify: `src/server/vault/native-capability-profile.ts`
- Modify: `src/server/vault/native-capability-probe.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Implement the subprocess crash worker**

Accept sentinel vault, app-data, plan fixture, and one checkpoint. At that checkpoint print `READY_TO_KILL` and wait. Parent sends `SIGKILL`, then starts a fresh scanner process that cannot use killed in-memory state.

```ts
const input = crashWorkerInputSchema.parse(JSON.parse(process.argv[2] ?? ''));
await runWriteFixture({
  ...input,
  onCheckpoint: async (checkpoint) => {
    if (checkpoint !== input.checkpoint) return;
    process.stdout.write('READY_TO_KILL\n');
    await new Promise<never>(() => undefined);
  },
});
```

- [ ] **Step 2: Add all named failure windows**

```ts
const checkpoints: readonly WriteCheckpoint[] = [
  'manifest-persisted', 'staging-source-fsynced', 'intent-persisted',
  'staging-landed', 'before-helper', 'after-helper',
  'old-version-retired', 'directory-fsynced',
  'result-persisted', 'step-verified', 'final-state-verified',
  'finalize-started', 'finalize-completed', 'terminal-persisted',
  'core-transitioned', 'batch-committed'
];
```

Run each for replace, exclusive create plus `retire-created-file` rollback, file move, directory-package move, mkdir-exclusive, recovery rmdir, and a multi-step mkdir/package/source plan where applicable. Replace cases explicitly kill after swap/before retirement, during unexpected-old preservation, and after retirement/before result. Create rollback cases kill before and after the exclusive retirement and prove the created inode is either still at its exact vault path or preserved under the batch retained area, never lost. A fresh process must classify safe continue, safe rollback/continue, verified committed, manually resolved, or manual-only with every version and created-entry identity preserved. After convergence, assert the only allowed vault-root `.xiaozhao-*` entry is the exact `.xiaozhao-atomic-test-vault.json` sentinel with its original bytes/mode; no staging prefix or other runtime artifact remains, and retired versions exist only in batch `retained/`. It must never see an absent required target, silent overwrite, invalid-journal success, recursive directory creation, or SQLite dependency.

- [ ] **Step 3: Run crash tests before promotion**

```bash
npm exec -- vitest run --config vitest.integration.config.ts tests/integration/write-recovery-crash.test.ts --no-file-parallelism
```

Expected: crash cases pass, but the primitive profile remains `crashRecovery: unverified` and gate stays blocked.

- [ ] **Step 4: Promote only the exercised profile**

`promoteCrashRecoveryEvidence()` requires exact profile key, helper SHA, volume identity, and deterministic crash-matrix hash. It creates an immutable revision with:

```ts
{
  capability: 'crashRecovery',
  status: 'passed',
  reasonCode: 'ALL_NAMED_CRASH_WINDOWS_CONVERGED',
  observedAt
}
```

Any helper, OS, architecture, volume, primitive evidence, or matrix mismatch fails closed. Mocked/unit tests cannot call production promotion.

- [ ] **Step 5: Add scripts and run the exact gate**

```json
{
  "scripts": {
    "test:write-crash": "vitest run --config vitest.integration.config.ts tests/integration/write-recovery-crash.test.ts --no-file-parallelism",
    "test:native": "npm run test:native-contract && npm run test:write-crash",
    "gate:filesystem-write": "tsx scripts/gate-filesystem-write-capability.ts"
  }
}
```

```bash
npm run test:write-crash
APP_DATA_DIR="$XIAOZHAO_TEST_APP_DATA" VAULT_REAL_ROOT="$XIAOZHAO_TEST_VAULT_ROOT" NATIVE_CAPABILITY_PROFILE_KEY="$NATIVE_CAPABILITY_PROFILE_KEY" npm run gate:filesystem-write
```

Expected: exact evidence prints `PASSED`; changing one helper byte or target device prints `BLOCKED` and exits 1.

- [ ] **Step 6: Commit crash evidence**

```bash
git add tests/helpers/write-crash-worker.ts tests/integration/write-recovery-crash.test.ts src/server/vault/native-capability-profile.ts src/server/vault/native-capability-probe.ts package.json package-lock.json
git commit -m "test: prove atomic crash recovery windows"
```

### Task 11: Run the Phase 1 completion gate

**Files:**
- Modify only when a failure is caused by a Phase 1 file.

- [ ] **Step 1: Run all native and recovery suites serially**

```bash
npm run build:native
npm run test:native
npm exec -- vitest run --config vitest.config.ts tests/unit/atomic-helper-protocol.test.ts tests/unit/native-capability-profile.test.ts tests/unit/write-plan.test.ts tests/unit/recovery-journal.test.ts
npm exec -- vitest run --config vitest.integration.config.ts tests/integration/native-capability-gate.test.ts tests/integration/write-kernel.test.ts --no-file-parallelism
```

Expected: the aggregate runs the exact native contract and crash suites once; all pass with mutations confined to sentinel vault and private test app-data.

- [ ] **Step 2: Run repository regression**

```bash
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:security
npm run test:component
npm run test:e2e
npm run test:electron
npm run build:desktop-runtime
```

Expected: every command exits 0; direct reading and Electron launch remain green.

- [ ] **Step 3: Inspect native provenance and forbid fallbacks**

```bash
file dist/native/atomic-file-helper
otool -L dist/native/atomic-file-helper
rg -n "RENAME_SWAP|RENAME_EXCL|RENAME_NOFOLLOW_ANY" native/macos/atomic-file-helper.c
rg -n "rename\(|copyFile|unlink" src/server/vault/FileSystemVaultWriter.ts src/server/workflow src/server/recovery
```

Expected: arm64 Mach-O links only libSystem; all required flags exist; no ordinary rename/copy/unlink commit fallback exists. Cleanup-only unlink, if any, occurs only after retention completion.

- [ ] **Step 4: Prove the formal vault was untouched**

Compare before/after path, mtime, size, and SHA-256 inventories. Never launch an integration write harness with the formal path as its target. The exact formal-root rejection is exercised only through the pure/injected guard test, whose fake stat/realpath adapters return the captured formal-root identity and whose helper/repository spies must remain untouched.

Run a hidden-inclusive, read-only filesystem inventory twice around the complete write suite; keep both outputs outside the vault and compare them byte-for-byte. This check observes every entry but does not grant write authority; Phase 6 later replaces acceptance capture with the descriptor-anchored scanner:

```bash
set -o pipefail
XIAOZHAO_PHASE1_AUDIT_DIR="$(mktemp -d "${TMPDIR%/}/xiaozhao-phase1-audit.XXXXXX")"
snapshot_formal_vault() {
  /usr/bin/find ~/我的大脑 -xdev -print0 |
    while IFS= read -r -d '' entry; do
      /usr/bin/stat -f 'entry|%HT|%Lp|%d|%i|%z|%m|%N' "$entry"
      if [[ -f "$entry" && ! -L "$entry" ]]; then
        /usr/bin/shasum -a 256 "$entry"
      elif [[ -L "$entry" ]]; then
        /usr/bin/readlink "$entry" | /usr/bin/shasum -a 256
      fi
    done | LC_ALL=C /usr/bin/sort
}
snapshot_formal_vault > "$XIAOZHAO_PHASE1_AUDIT_DIR/before.txt"
npm exec -- vitest run --config vitest.config.ts tests/unit/test-vault-guard.test.ts 2>&1 | tee "$XIAOZHAO_PHASE1_AUDIT_DIR/formal-guard.log"
npm exec -- vitest run --config vitest.integration.config.ts tests/integration/native-capability-gate.test.ts tests/integration/write-kernel.test.ts --no-file-parallelism 2>&1 | tee "$XIAOZHAO_PHASE1_AUDIT_DIR/sentinel-write.log"
npm run test:write-crash 2>&1 | tee "$XIAOZHAO_PHASE1_AUDIT_DIR/sentinel-crash.log"
snapshot_formal_vault > "$XIAOZHAO_PHASE1_AUDIT_DIR/after.txt"
cmp "$XIAOZHAO_PHASE1_AUDIT_DIR/before.txt" "$XIAOZHAO_PHASE1_AUDIT_DIR/after.txt"
rg -q 'FORMAL_VAULT_FORBIDDEN' tests/unit/test-vault-guard.test.ts
```

Expected: the pure guard test proves the exact formal root, its aliases, ancestors and descendants return `FORMAL_VAULT_FORBIDDEN` before any repository/helper construction; all integration mutations remain confined to sentinel temporary roots; `cmp` prints nothing. The temporary audit directory may be removed after the handoff evidence is recorded.

- [ ] **Step 5: Verify migration continuity and plan hygiene**

```bash
rg -n "003_write_kernel" src docs/superpowers/plans
rg -n "004_" docs/superpowers/plans
git diff --check
```

Expected: 003 appears only in this phase and registration; later migrations start at 004; diff check is empty.

- [ ] **Step 6: Record a truthful handoff**

Include helper SHA-256, OS build, architecture, filesystem type, `st_dev`, profile key, crash-matrix hash, test counts, and independent test-vault gate result. State exactly:

```text
Phase 1 proves the atomic filesystem and recovery kernel only for the exact helper/profile/volume evidence shown above. It does not authorize automated tests to write the formal vault and does not yet expose a user-facing write workflow.
```
