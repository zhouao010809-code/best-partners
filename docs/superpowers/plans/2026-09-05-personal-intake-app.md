# Personal Intake App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Allow the personal desktop App to discover clipper packages, preview canonical metadata and archive an explicitly confirmed package without losing source bytes.

**Architecture:** Trusted Electron bootstrap supplies a personal native port rooted in the selected vault and private external recovery directory. A synchronous, journaled coordinator handles normalization, exclusive moves and explicit restart recovery. The HTTP service owns expiring preview snapshots; renderer never supplies a filesystem root or raw replacement bytes.

**Tech Stack:** Existing React, Fastify, Zod, Node and macOS N-API runtime.

## Approved execution boundary (2026-09-05)

The user accepted trusting the installed personal App and its module at launch. The prior requirement to prove the executable identity through an inherited executable FD is superseded **only for this personal native archive path**. This does not authorize knowledge writes, remote AI calls, rewriting archived documents, deleting originals, or overriding filesystem conflicts. Same-user malicious App/module replacement is outside this accepted boundary. The sandbox-only adapter stays sandbox-only.

Completed-operation stage health is not a new-write global gate: full original bytes also remain inside the immutable verified intent. A later externally modified completed stage does not authorize any mutation and is not claimed healthy. In-progress phases always require the retained original inode and exact stage bytes. Missing intent/stage, malformed receipts, pending conflicts and corrupt intents fail closed. Historical lists read compact receipts; actual new mutations still validate prior intent/receipt bindings. Backup-health UI and historical storage compaction are not part of this release.

## Task 1: Native personal capability

Files: `native/macos/sandbox-archive.c`, `scripts/build-sandbox-archive.ts`, `src/server/archive/sandbox-native.ts`, `tests/native/personal-archive.contract.test.ts`.

- [x] Write failing contract tests for an owned vault root and external nonoverlapping private same-volume recovery root, retained directory identity, intake enumeration, month creation, Markdown exchange and exclusive rename.
- [x] Implement the approved API:

```ts
openPersonalArchive(root, recoveryRoot, addonPath);
port.listIntake();
port.ensureMonth(platform, month);
port.statRecovery(stageName);
port.swapMain(relativeMain, stageName, expectedMain, expectedStage);
port.renameMain(from, to, expected);
```

- [x] Verify new native tests plus the existing sandbox contracts. Test artifacts never enter packaged App.

## Task 2: Pure metadata plan

Files: `src/server/archive/intake-plan.ts`, `tests/unit/intake-plan.test.ts`.

- [x] Write failing tests for plain Markdown, existing metadata, BOM/CRLF preservation, invalid dates, unknown metadata and prior knowledge links/statuses.
- [x] Implement `inferIntakeFields(mainName, bytes)` and `planIntakeMain({packageName,mainName,bytes,fields})` without I/O. Preserve existing body bytes. Refuse ambiguous metadata rather than discard it.
- [x] Verify strict `parseLibraryNote` accepts every successful planned file and body remains byte-identical.

## Task 3: Durable normalization and move

Files: `src/server/archive/intake-archive.ts`, `tests/archive/intake-archive.test.ts`.

- [x] Write failing real-native tests for successful flow, stale preview, collision, interrupted exchange/rename/move and conflict after interruption.
- [x] Persist a staged new Markdown and an immutable intent containing the validated original snapshot and stage identity before modifying intake. Original Markdown is retained by exchange. Create only the selected month under an existing platform; retain an empty created month on failure.
- [x] Implement `prepareIntakeArchive(port,{source,tree,plan})` and `executeIntakeArchive(port,id)`; classify full live trees before each next step. No rollback/unlink. Completed receipts are historical and do not require archived notes to stay forever unchanged.
- [x] Verify original and final bytes, idempotency and unknown/corrupt recovery records failing closed.

## Task 4: App flow

Files: `src/shared/api/intake.ts`, `src/server/services/intake-service.ts`, `src/server/api/routes/intake.ts`, existing server bootstrap, Electron bootstrap and API client; `src/client/pages/IntakePage.tsx`, router and scoped CSS.

- [x] Write failing route/client/component tests for unavailable mode, empty state, preview, expired/stale preview, explicit confirmation and recovery.
- [x] Add `GET /api/v1/intake`, `POST /api/v1/intake/preview`, `/commit` and `/resume`. Keep existing Host/Origin/session/CSRF protections. Preview is read-only; commit receives only server-issued operation token.
- [x] Add left-nav 收件箱 with automatic polling while open, source/date/title correction, literal preview, clear pending/success/errors and explicit resume. No automatic knowledge writes or AI calls. Unattended automatic archive is not enabled by this release.
- [x] Refresh the index after a verified archive and distinguish “files archived, index refresh pending” from success.

## Task 5: Verification and handoff

- [x] Permit only approved `personal-archive.node` plus read helper in package whitelist; test exclusions.
- [x] Run `npm run verify`, `npm run test:sandbox-archive`, personal native and archive tests, existing native-read contracts and packaged Electron acceptance.
- [x] Review implementation independently; fix important findings before handoff.
- [x] Update README, prior trust preflight and vault `99_当前会话交接.md` with verified outcomes and limitations. Do not commit unrelated dirty work.

Real intake was empty during initial read-only inspection. Fixture verification is not evidence of a real plugin-generated archive. Loose files, no-main packages and ambiguous legacy metadata must remain visible with a clear pending reason; no data is silently ignored or modified.

## Verified handoff (2026-09-05)

- `npm run verify` passed during implementation. After the final runtime recovery gate change, unit (570), integration (151), component (201), type checking and desktop runtime build were rerun successfully.
- Personal native contracts: 12 passed. Personal archive/service/process-crash tests: 41 passed. Existing sandbox native contracts: 24 passed; existing archive tests: 14 passed; native-read contracts: 11 passed.
- Electron desktop acceptance: **6 passed**, covering development and packaged invalid-root handling, independent local reading/refresh, and intake discovery → literal preview → explicit confirmation → indexed original reading. The intake cases additionally create a real database recovery blocker in a temporary fixture and verify that new archive previews are refused.
- Important independent-review findings were fixed: snapshot equality, orphan-stage refusal, bounded intent encoding before stage creation, compact historical receipt reads, isolated malformed inferred fields, and separate personal recovery storage. Personal archive journals live under `vaults/<hash>/personal-intake-v1`, not the database `recovery` folder.
- Rebuilt the macOS arm64 App using the locally cached Electron 44.1.0 archive after the network download timed out. Archive integrity was checked and the executable hash matched the installed Electron runtime. Packaged native files contain only `atomic-file-helper` and `personal-archive.node`; no sandbox/test add-ons. The App remains unsigned and unnotarized.
- Launched the newly packaged App against the user's selected `我的大脑` vault. Read-only checks confirmed `health.status=ready`, index V5 ready, personal intake available, automatic archive false, and empty intake/history. The native window shows seven left navigation entries including 收件箱. No real source package, attachment or knowledge document was written by these checks.
- `git diff --check` passed. The full browser E2E/visual baseline suite was not rerun; the six actual Electron acceptance cases above were.

## Remaining product scope

Follow-up: the real plugin sample's `clipped` collection date and `published`/`description`/`学习状态` preservation were implemented and verified in [clipper compatibility](2026-09-05-clipper-date-compatibility.md). The earlier empty-intake observation below is historical; one real sample now has a successful read-only App preview, awaiting the user's archive confirmation.

This is confirmed intake archiving, not unattended automatic archiving or completed AI knowledge ingestion. While its page is visible, the inbox scans every five seconds. A supported package needs a root Markdown main file and an existing source-platform directory; missing basic metadata can be filled in the App. Loose files, missing-main packages, conflicting/unknown nonempty metadata and multi-Markdown packages requiring a main-file rename remain pending with explanations. No repair editor or automatic wrapping is included.

The real plugin intake is currently empty, so an actual plugin-generated sample still needs acceptance. Existing 21 legacy schema findings were not rewritten; companion Markdown files are not automatically classified as broken originals. DeepSeek remains unconfigured and the separate knowledge write gate remains blocked.

Recovery verification covers process interruption, not a power-loss guarantee or atomic expected-inode comparison. Native limits remain 10 MiB per file, 16 MiB per full snapshot, 10,000 entries, depth 64 and a 32 MiB intent. Recovery storage must be private, external and on the same volume. Corrupt/conflicting records pause operations rather than overwrite or delete data.
