# Extraction workspace implementation plan

> **For agentic workers:** Use subagent-driven-development for the independent read-model task and root-owned UI integration. Execute continuously; user has approved the design.

**Goal:** Replace the extraction queue with an actionable two-pane workspace while keeping source files, formal ingestion and provider consent unchanged.

**Architecture:** Read-only queue summaries use the full existing extraction table, not a 50-run history approximation. The client keeps view/search/selection in URL parameters, reads original content on selection, and embeds the existing extraction workflow with compact preparation/result rendering. No new dependencies or database migration.

**Tech Stack:** React, React Router, current CSS/lucide, Fastify, SQLite, Zod, Vitest and Playwright Electron.

## Ownership and sequence

- Backend agent: new `src/shared/api/extraction-queue.ts`, new `src/server/services/extraction-queue-service.ts`, existing extraction routes/service wiring and focused integration tests. No client files.
- Root: client API, `QueuePage`, extraction workspace/detail components, route labels, CSS, component and desktop flow checks, packaging and docs.
- Existing dirty linked worktree is retained. No merge, broad staging, source-vault edits or unrelated cleanup.

## Task 1 — Complete read-only queue state

- [x] Add regression fixtures with more than 50 runs, earlier success followed by failure, zero candidates and changed/missing source. First verify absent endpoint fails; then implement.
- [x] `GET /api/v1/extraction-queue`: query `view` (`pending|generating|ready|unfinished`, default pending), optional title/sourcePlatform/collectedFrom/collectedTo, cursor and limit. Return items, counts across matching filters and optional nextCursor. Stable newest-collection-first ordering, undated last, deterministic tie break; cursor must not silently mix changed snapshots.
- [x] Each `ExtractionQueueItem`: materialPath, title, view, optional sourcePlatform/collectedAt/sourceRawSha256, canExtract, optional latestRun/activeRun/latestReadyRun. `ExtractionRunSummary`: id, status, createdAt, sourceRawSha256, optional candidateCount and problem. No candidate text in list responses.
- [x] Pending requires an indexed archived/unrefined source without any history. Other views derive from active/latest run over the complete table, including historical sources no longer indexed. Preserve latest successful result independently of latest failure. Count ready-zero as success. Source unavailable does not mean deleted.
- [x] `GET /api/v1/extraction-history?materialPath=...&cursor=...&limit=...`: paginated summaries, selecting a run continues to use existing `/extractions/:id`. Existing endpoints remain compatible. No provider calls and no vault writes from these GETs.
- [x] Run focused integration/schema checks; inspect spec then independent quality review.

## Task 2 — Same-page selection, reading and extraction

- [x] Test selecting a pending source only reads it, selecting ready opens the existing result without preview/start, stale responses cannot replace a new selection, and query/selection survives return navigation. Do not add tests that merely restate font or spacing choices.
- [x] Add `api.extractionQueue.list(query,signal)` and `.history(query,signal)` with strict schemas, using existing GET helper. Keep optional capability for old-runtime fallback, without claiming unknown state is pending.
- [x] Queue URL stores `view`, `title`, `sourcePlatform`, dates, selected `materialPath` and optional `run`. Debounce search by 250ms; changing filters resets page cursor, not provider state. Status tabs show server counts. Poll read-only summaries when needed and on existing data revision; retain current pane during a status transition.
- [x] Replace the dense filter form with search, source select and expandable dates. Each list item is an accessible button with two-line title, source/date and next-action status. Default pending excludes partial-ingested and unarchived sources. Show a helpful empty state and route to original materials/inbox.
- [x] Right pane: original/result switch, local original rendered safely with metadata collapsed, source-version notices, compact reading-state choice, exact send preview available collapsed, explicit send action, generating/cancel, failed/retry, ready/zero and prior-results states. Main action sits adjacent to task state; no automatic retry or ingestion.
- [x] Refactor existing ExtractionPage only enough to embed its workflow through optional callbacks instead of forced navigation. Preserve standalone extraction URLs/homepage behavior. Clear per-source temporary preparation on selection change; retain selected original/record using URL.
- [x] CSS scopes the workbench, avoids nested framed cards, uses 14px list titles and readable detail text. Wide viewport shows two panes; narrow viewport switches list/detail with back control, left app navigation stays intact.

## Task 3 — Verify and hand off actual App

- [x] Run relevant component/integration suites and typecheck/build once changes are integrated; fix concrete failures without broad test churn.
- [x] Exercise existing real Electron provider-fixture flow plus workspace selection/results behavior. Inspect desktop and 720px screenshots. No actual DeepSeek call or live secret manipulation.
- [x] Package the App using existing verified Electron cache, close current App only after checking for unsaved actions, reopen and verify live queue read-only. Compare source/knowledge file aggregate hashes before/after.
- [x] Update README, implementation evidence and current vault handoff. Remove only this turn's unused temporary diagnostics. Deliver the changed workspace, not another design approval question.

## Delivery evidence — 2026-09-06

- Added exact selection recovery through `GET /api/v1/extraction-queue/source?materialPath=...`. It shares the complete summary and readiness checks with the queue, with no source-body/provider I/O.
- Spec and independent quality reviews closed stale selected actions, expanded pages disappearing on result reads, stale original content after hash changes, hidden old results interrupting retry preparation, and failure to recover automatically when the initial index becomes ready. Significant state failures were reproduced with focused regression cases.
- Final focused component run: 95 passed (`extraction-workspace`, `personal-extraction`, `extraction-api-client`, `app-shell`). The legacy read-page/API checks passed during integration. Queue/source/history plus existing extraction API/service integration: 36 passed.
- Typecheck, client/server build and Electron build passed. Vite retains a non-blocking single-chunk size warning. No new dependencies or database migration.
- Cached Electron packaging completed. Final development + packaged launch/extraction tests: 6 passed, including explicit one-time sending, persisted-result reopening, automatic indexing and 720px layout. All provider traffic was simulated in isolated temporary vaults.
- The actual App was gracefully closed after its read-only queue screen and zero active runs were verified, replaced and reopened. Live queue GET returned 4 pending, 0 generating, 0 ready, 0 unfinished; exact source lookup matched. The two partially ingested records remain outside pending.
- A read-only browser check against the actual packaged runtime at 1360x900 opened the real GPT-6 Astra source: 4 rows, visible original, no horizontal overflow. All POST/external requests were blocked in that check. Screenshot: `test-results/extraction-workspace-live.png`; packaged test screenshots cover wide and 720px views.
- Before/after hashes of all 463 regular files under `01图书馆` and `02知识库` matched: `baf93c07faea909e89c00d847a75f1f5e6bcd8f8943ae92863172cdf83686588`.
- App path is unchanged: `dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app`. Observed production port was 58733; resolve it again on future runs. Old ambient localhost:60439 is not the delivered runtime.
- README updated; temporary diagnostic screenshots removed, live screenshot retained. Existing dirty worktree changes were preserved, with no commit, staging or unrelated cleanup. Candidate editing and formal ingestion remain outside this delivery.
