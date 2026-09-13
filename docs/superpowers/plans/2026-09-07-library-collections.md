# Library Collections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development for bounded independent work. Do not commit or reset the pre-existing dirty worktree.

**Goal:** 把已确认的第二版玻璃文件夹视觉接入真实原始资料库，并保持已有操作闭环。

**Architecture:** 独立只读馆藏 API 在一致索引快照中构建分类与完整计数，客户端仅管理目录浏览、筛选、分页和原文选择。旧资料 API、写入路径和真实文件结构不变。

**Tech Stack:** React, TypeScript, Fastify, SQLite index, Lucide, scoped CSS, Vitest, Playwright Electron.

## 1. Read contract and classification

Files: `src/shared/api/library.ts`, `src/shared/domain/records.ts`, `src/shared/api/schemas.ts`, `src/server/rules/library-schema.ts`, `src/server/index/index-repository.ts`, `src/server/services/library-catalog.ts`, `src/server/services/read-service.ts`, `src/server/api/routes/materials.ts`, `src/client/api/client.ts`.

- [x] Add failing classification/API tests: no status means all states in the new API; old materials default unchanged; unique references and existing topic paths classify without title guessing; ambiguous/missing links remain unclassified; duplicate membership counts once; source path preserves package; trash excluded; cursor tied to filters/version/visibility.
- [x] Implement `listLibrary(query)` and the shared contract:

```ts
type LibraryQuery = { mode?: 'topic' | 'source'; path?: string; status?: KnowledgeStatus; title?: string; cursor?: string; limit?: number };
type LibraryFolder = { path: string; label: string; count: number; folderCount: number };
type LibraryPage = { mode: 'topic' | 'source'; path: string; breadcrumbs: { path: string; label: string }[]; folders: LibraryFolder[]; items: MaterialRecord[]; total: number; directTotal: number; unclassifiedCount: number; indexVersion: number; nextCursor?: string };
```

- [x] Run related unit/integration/API-client tests and typecheck. Preserve source bytes and old index compatibility; no DB migration needed for JSON projection additions.

## 2. Production folder browser

Files: `src/client/pages/LibraryPage.tsx`, `src/client/components/library/*`, `src/client/styles/library.css`, `tests/component/library-page.test.tsx`.

- [x] Write failing behavior tests for root folders, descendant navigation/back, search/status changes, paging/error handling, stale-response cancellation, linked original, and recycled-item removal.
- [x] Replace the flat default view with the approved folder objects. Keep the existing original detail and MaterialTrashProvider flows, separate selectable row from destructive button, use real server counts and categories only.
- [x] Persist mode/path/status/title in URL; changing directory resets cursor but closing original does not lose directory. Add clear unknown/empty directories and refresh controls. Never label a partial page as the total.
- [x] Title search covers current directory and all descendants, returning matching files directly with no folder tiles; clearing search restores folder browsing.
- [x] Inspect 1440px, 1024px, 720px and 390px. Keep App sidebar at left. No new dependencies, no miniature app shell inside the real shell.
- [x] Run relevant component tests and client typecheck.

## 3. Integration, review, and desktop delivery

Files: `tests/electron/library-collections.test.ts`, existing material Electron tests only where navigating the new directory UI requires it, `README.md`, this plan.

- [x] Exercise an isolated real indexed vault: topic/source folders, month/package path, status/search, exact original deep link, reload; verify original/attachment bytes unchanged and no model call.
- [x] Independently review spec coverage, then code quality and concrete regressions. Fix identified issues and rerun affected checks only.
- [x] Run `npm run typecheck`, focused unit/integration/components; build client/server/electron, package using verified local Electron ZIP. Do not rebuild unrelated native code.
- [x] Run new isolated Electron coverage and recycle/permanent-delete regression against final artifacts. Read screenshots.
- [x] Open updated actual App, read-only check current catalog and existing history; do not perform real deletion or model calls.
- [x] Update README and vault handoff; remove task-owned temporary fixtures and finish with concise usage guidance.

## Baseline

Existing linked worktree `desktop-read` reused; old library component tests passed 15/15 before edits. Read-only index inspection found 97 material records and 181 knowledge records before visibility filtering. This is not a permanent production count.

## Delivery verification — 2026-09-07

- `npm run typecheck` passed. Full component run passed 318 tests; after the final original-URL refinement, the affected library/trash suite passed 47 tests, including hash/version mismatch, stale response cancellation, focus restoration, URL back/forward/reload, and recycle refresh.
- Related unit/API/projection checks passed. Final review fixes passed 11 catalog unit tests and 33 read-api integration tests; earlier related read/indexer suite passed 53 tests and API-client suite passed 34.
- Development and packaged Electron collection/recycle/permanent-delete flows passed 6/6 against final artifacts. Desktop launch, isolated roots, automatic refresh and plugin archive regressions passed another 6/6 during integration.
- Inspected 1440/1024/720/390 layouts and 1024px original-detail ordering. Final live-catalog browser screenshot showed the genuine eight topic collections, not mock categories. No horizontal overflow or page errors.
- Independent spec/code review found three concrete P2 issues: literal percent-containing folders, explicit reference paths borrowing title aliases, and original selection missing from URL. All were reproduced, fixed and independently rechecked.
- Client, server and Electron compiled; arm64 App packaged using the cached Electron ZIP, without rebuilding unrelated native code. Real App reopened normally (no debug port). The live `/library` page was verified in a temporary browser, and a browser opening was requested (UI returned queued).
- Read-only live verification at delivery: 97 materials, eight classified root collections plus 10 unclassified materials, and six source directories. Topic/source totals match; multi-membership does not inflate the root total. These counts are a delivery snapshot, not constants.
- Index record paths/content hashes plus extraction, candidate-review, ingestion and trash rows matched the pre-update read-only snapshot byte-for-byte. The existing deleted trash receipt was preserved; no real model invocation, material move, deletion or ingestion was performed for verification.
