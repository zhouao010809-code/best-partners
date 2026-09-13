# Xiaozhao Brain Personal Desktop V1 Implementation Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing read-only local Web console into a personal macOS desktop application that automatically ingests plugin-captured Markdown, supports DeepSeek-assisted extraction and direct knowledge editing, and performs recoverable formal vault writes without requiring Obsidian or a terminal.

**Architecture:** Preserve the current React, Fastify, SQLite, Zod, and indexing code, then wrap it in an Electron main process that owns configuration, secrets, the embedded loopback server, and lifecycle. Replace the required Local REST runtime with a direct filesystem reader and a separately gated macOS atomic-file helper; keep Markdown/YAML as the formal source of truth and keep workflow state, journals, backups, and secrets outside the vault.

**Tech Stack:** Node.js 22, TypeScript 6, React 19, Vite 8, Fastify 5, SQLite/better-sqlite3, Electron, C/clang macOS helper, DeepSeek through an OpenAI-compatible client, Zod, Vitest, Testing Library, Playwright

---

## Fixed locations and authority

- Source repository: `PROJECT_ROOT`
- Approved specification: `docs/superpowers/specs/2026-09-01-xiaozhao-brain-personal-desktop-v1-design.md`
- Formal vault: `~/我的大脑`
- Runtime state: Electron `app.getPath('userData')`, never inside the formal vault
- Intake source: `01图书馆/小兆clipper`
- Native target: current `arm64` Mac running macOS 15.5

The approved specification is authoritative. The earlier Local REST Web MVP Phase 2/3 plans are historical references only; do not execute them unchanged where they conflict with direct filesystem operation, automatic intake, direct editing, partial commits, or Electron packaging.

Locked UX invariants: the App always uses a full-height fixed left sidebar; narrow windows collapse it to an icon rail and never move navigation to the bottom. The Dashboard card deck contains only `未提炼`, while `部分入库` appears only in Queue. Every product setup, capability, confirmation and recovery action is available inside the App without requiring Terminal; command-line scripts in later phases are developer verification tooling, not the user's operating path. User-confirmed intake bindings are append-only, immutable and versioned, with exactly one current active binding before forward execution.

## Required execution order

Execute these plans in order:

1. [Phase 0: Desktop Runtime and Direct Read](./2026-09-01-phase-0-desktop-runtime-direct-read.md)
2. [Phase 1: Atomic Filesystem and Recovery Kernel](./2026-09-01-phase-1-atomic-filesystem-recovery.md)
3. [Phase 2: Automatic Library Intake](./2026-09-01-phase-2-automatic-library-intake.md)
4. [Phase 3: DeepSeek Extraction and Review](./2026-09-01-phase-3-deepseek-extraction-review.md)
5. [Phase 4: Formal Knowledge Ingestion](./2026-09-01-phase-4-formal-knowledge-ingestion.md)
6. [Phase 5: Direct Knowledge Editor](./2026-09-01-phase-5-direct-knowledge-editor.md)
7. [Phase 6: Packaging, Hardening, and Acceptance](./2026-09-01-phase-6-packaging-hardening-acceptance.md)

Each phase must leave the repository buildable and independently testable. A later phase may not weaken a prior safety gate to make progress.

## Gate order

| Gate | Evidence | Failure behavior |
|---|---|---|
| G0 Approved scope | This specification and roadmap are committed | Do not change product scope in implementation |
| G1 Desktop read runtime | Electron launches embedded Fastify on an ephemeral loopback port and reads a fixture vault with Obsidian closed | Keep browser-only read console; do not attach mutation services |
| G2 Filesystem identity | Direct gateway rejects path escape, hidden segments, symlinks, unexpected inode/device changes, and oversized files | Keep direct filesystem gateway read-only |
| G3 macOS atomic contract | Bundled helper proves `RENAME_EXCL`, `RENAME_SWAP`, `RENAME_NOFOLLOW_ANY`, hidden-inclusive inspection, descriptor-bound private recovery I/O, parent fsync, detected-race preservation, and unsupported-volume refusal in a sentinel test vault | Formal create, replace, move, restore, and intake remain closed |
| G4 Recovery kernel | Every intent/result crash window converges from immutable manifest, strict domain projection capsule, hash-chain journal, retained bytes, and disk hashes without SQLite | Mutation routes remain unregistered |
| G5 Intake | Stable classifier-high plugin fixture auto-archives byte-preservingly under the current `00/01/02/03/05` rule fingerprint; a resolvable ambiguity stays untouched until its current versioned immutable preview and App-native confirmation, while stale previews are superseded without rewriting their audit rows and conflicting, unsafe, or stale-rule fixtures remain untouched | Disable automatic intake and show pending diagnosis |
| G6 Extraction | DeepSeek fixture, redaction, preview, persisted decisions, partial-ready state, and refresh recovery pass without vault mutations | Do not generate formal write plans |
| G7 Formal ingestion | Deterministic plans, partial/full status rules, atomic batches, link verification, and recovery pass in a sentinel test vault | Formal knowledge writes remain closed |
| G8 Direct editor | Controlled YAML/Markdown editor, protected-state rules, stale draft handling, reverse plan, and recovery pass in a sentinel test vault | Keep knowledge details read-only |
| G9 Packaged security | Packaged app passes session/CSRF/CSP/navigation/preload/loopback/native-module tests, and Electron main is the sole source of production mutation authority | Do not call the package installable |
| G10 Formal-vault acceptance | Read-only snapshot, user-selected diff, interactive confirmation, one supervised batch, and post-write byte/link verification pass | Do not call the product finally usable |

## Permanent safety invariants

1. Automated write tests reject `~/我的大脑`, the configured formal vault, and any vault without the exact test sentinel.
2. No test, CI command, fixture server, or model response can trigger the supervised formal-vault confirmation endpoint.
3. The renderer never receives vault filesystem powers or a stored plaintext API key.
4. Formal file changes require an immutable `WritePlan`, an fsynced journal intent, a currently valid rule bundle, and the exact expected file hashes.
5. The atomic helper is fail-closed. Do not fall back from atomic exchange or exclusive rename to ordinary overwrite rename.
6. Source-body and attachment bytes are immutable. Intake and source backlink/status updates use targeted frontmatter byte patches only.
7. Knowledge files are never permanently deleted through the product. Rolling back an uncommitted file created by the same batch is allowed only when path, after-hash, dev and ino still match; `retire-created-file` must move it exclusively into that batch's private app-data retained area and fsync both parents, never unlink or delete it.
8. Any unknown current disk hash stops automatic continue/rollback and preserves all known versions for manual resolution.
9. SQLite is never the only copy of formal Markdown or recovery bytes.
10. No claim of success is valid until a fresh command or disk reread proves it.
11. Production mutation authority is constructed only by Electron main. Unattended authority is limited to exact classifier-high `intake` plans carrying server-owned `authorizationMode:'automatic'`; user-confirmed intake, an `extraction_batch` formal commit, editing, restore, continue, rollback, and manual resolve require a one-use, expiring native-dialog grant bound to the complete plan and current disk snapshot. A user-confirmed intake grant must also bind the unique current active immutable binding; stale, cancelled, consumed, superseded, or rolled-back bindings cannot be reused. Renderer input can never relabel an intake plan as automatic. AI extraction without a formal commit remains read-only.
12. New vault directories use journaled exclusive creation, and retained old versions, backups, journals, secrets, databases, logs, and all other runtime artifacts stay outside the formal vault.

## Locked responsibility map

New code follows these responsibility boundaries. Each phase plan's file map is authoritative for exact filenames; this map prevents competing runtimes or duplicate write kernels:

```text
native/
  macos/
    atomic-file-helper.c
src/
  electron/
    main.ts
    preload.ts
    runtime.ts
    settings-store.ts
    window-policy.ts
    production-mutation-target-policy.ts
  shared/
    desktop/
      bridge.ts
  server/
    start-server.ts
    vault/
      FileSystemVaultGateway.ts
      MutationTargetPolicy.ts
      AtomicFileHelper.ts
      PrivateRecoveryStore.ts
      FileSystemVaultWriter.ts
    intake/
      package-classifier.ts
      intake-reconciler.ts
      intake-planner.ts
      intake-service.ts
    ai/
      model-config.ts
      redaction.ts
      compatible-client.ts
      orchestrator.ts
    rules/
      source-frontmatter-patch.ts
      knowledge-template.ts
      knowledge-edit-policy.ts
    workflow/
      write-planner.ts
      write-coordinator.ts
      write-intent-registry.ts
      write-repository.ts
      recovery-service.ts
      formal-ingestion-planner.ts
      knowledge-editor-service.ts
    recovery/
      recovery-journal.ts
      recovery-manifest.ts
    db/repositories/
      intake-repository.ts
      extraction-repository.ts
      ingestion-repository.ts
      editor-draft-repository.ts
  client/
    components/intake/
    components/extraction/
    components/write/
    components/editor/
    pages/
      SettingsPage.tsx
      ExtractionWorkbenchPage.tsx
      WriteConfirmationPage.tsx
      KnowledgeEditorPage.tsx
      RecoveryDetailPage.tsx
tests/
  native/
  electron/
  fixtures/deepseek/
  fixtures/intake/
  integration/
  component/
  e2e/
```

Do not create broad utility modules. A file belongs in this structure only when a phase plan gives it one concrete responsibility and tests it directly.

## Shared verification commands

Run narrow tests during RED/GREEN loops, then use these gates at phase boundaries:

```bash
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:component
npm run test:security
npm run test:e2e
npm run build
```

Native and packaged phases add:

```bash
npm run build:native
npm run test:native
npm run build:electron
npm run test:electron
npm run dist:mac
```

Expected phase-boundary result: every invoked command exits `0`. During intermediate development only, an optional real-service smoke may report an explicit `SKIP` with a documented missing prerequisite rather than silently substituting a fixture. Final Phase 6 acceptance treats a skipped DeepSeek smoke, packaged gate, or supervised formal-vault verification as blocking, never as a pass.

## Specification coverage map

| Approved specification area | Owning plan |
|---|---|
| Personal, non-SaaS, double-click Electron shape | Phase 0, Phase 6 |
| Obsidian-closed direct read/search/open | Phase 0 |
| First-run folder picker, fixed left sidebar, confirmed glass visual system, and Settings navigation | Phase 0 |
| Atomic exchange, exclusive create/move, fail-closed capability gate | Phase 1 |
| Intent/result journal, crash recovery, conditional reverse plans | Phase 1 |
| Plugin folder watcher, startup/focus reconciliation, stable-file detection, and rule 02 staleness | Phase 2 |
| Byte-preserving auto-archive and pending intake | Phase 2 |
| DeepSeek safe storage, configurable compatible endpoint/model, bounded preview, redaction, and fixture client | Phase 3 |
| Reading-state briefing, candidate edit/accept/reject, partial-ready state | Phase 3 |
| New/merge decisions, partial/full status, backlinks, source-last batches | Phase 4 |
| Write confirmation, full diff, operation ledger, continue/rollback UI | Phase 4 |
| Direct YAML/Markdown editing and protected knowledge statuses | Phase 5 |
| No permanent delete and conditional historical restore | Phase 5 |
| App/DMG build, packaged security, production mutation authority, and formal-vault supervised acceptance | Phase 6 |
| Dashboard deck shows only `未提炼` | Already implemented; regression in Phase 2 and Phase 6 |

## Completion rule

Finishing Phase 6 does not by itself authorize calling the product complete. The final statement must name the exact packaged artifact, show the latest automated gate results, identify whether the supervised formal-vault batch ran, and distinguish any skipped Developer ID notarization from local current-Mac installation success.
