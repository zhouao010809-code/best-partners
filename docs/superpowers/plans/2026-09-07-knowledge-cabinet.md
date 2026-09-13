# Knowledge cabinet implementation plan

> **For agentic workers:** Use subagent-driven-development for the independent read API and reader units; the main agent integrates and verifies the cabinet.

**Goal:** Implement the approved physical bookshelf, nested folders and knowledge paper reader against real local knowledge without changing Markdown.

**Architecture:** Keep the old indexed search API for compatibility. Add an optional `listKnowledgeCatalog` capability, served by the browser client, combining a live directory listing with the complete filtered index projection. Use URL state for directories, filters and exact note links; render native folder and paper buttons, and retain version-checked live reading.

**Tech Stack:** Existing React, React Router, scoped CSS, Lucide, Fastify, Zod, SQLite and native read gateway. No new dependencies.

## Approved design and scope

- User approved `knowledge-folder-interior.html` on 2026-09-07. Keep smoke-black/silver cabinet, uniform 56×168 book spines, no numeric prefixes or stamps in display labels. Actual paths and ordering remain unchanged.
- Use the latest draft's double open shelf layout; responsive rows accommodate fixed-size books. No new settings for design alternatives.
- Books represent first-level knowledge domains; folders represent real child directories at arbitrary depth; knowledge records are paper cards with title, type, state and conclusion.
- A folder stays visible around its contents and reader. Only breadcrumb, parent and shelf return, no duplicate sibling navigation. Papers expand into readable Markdown and return to their originating card.
- Retain search of YAML recall fields, state/type/topic filters (topic is not a directory), obsolete opt-in, pagination, retry, original sources, internal note deep links and Obsidian opening.
- No original content edits, folder moves, model requests or state changes. Existing unrelated dirty files remain untouched except additive scoped integration.

## Task 1: Read-only catalog API

Files: `src/shared/api/knowledge-catalog.ts`, `src/server/services/knowledge-catalog.ts`, `src/server/services/read-service.ts`, `src/server/api/routes/knowledge.ts`, `src/client/api/client.ts`, focused integration and client tests.

- [x] First test `/api/v1/knowledge/catalog?path=01AI`: real child directories (including empty), only directly contained notes, descendant count independent of pagination; search returns matching descendants.
- [x] Introduce query `{ path?: string, search?, usageStatus?, includeObsolete?, knowledgeType?, topic?, cursor?, limit? }` using existing filter schema constraints. Response `{ path, breadcrumbs, folders: [{path,label,count}], items, total, directTotal, indexVersion, nextCursor? }`; root path is `''` and root label `知识书柜`.
- [x] Use `gateway.listDirectory` for requested directory only, collect all indexed filtered notes, validate boundary-safe paths, strip ordering prefixes from labels only. Count selected descendant records, preserve real empty folders when not searching. Sign cursors with catalog kind, filters, index version and live folder snapshot; reject stale or cross-filter reuse.
- [x] Client exposes `listKnowledgeCatalog?` and browser implementation validates envelopes. Preserve old methods.
- [x] Run focused integration/client tests including unsafe paths, literal percent names, missing folder, obsolete opt-in, pagination and changed snapshots.

## Task 2: Inline reader

Files: `src/client/components/knowledge/KnowledgeReader.tsx`, `src/client/components/KnowledgeDetail.tsx`, `tests/component/knowledge-reader.test.tsx`.

- [x] Test exact path/version validation, failed read retry, stale response cancellation, Escape and source/internal links.
- [x] Add an inline presentation to the existing reader with body-first layout, visible `收回纸页`, expandable traceability, and existing Obsidian action. Existing panel presentation stays compatible.
- [x] A small reader controller fetches only the selected note, accepts optional indexed record for version comparison, cancels late replies, resets on revision, reports real loaded record to the parent.
- [x] Run reader tests and existing read page regressions.

## Task 3: Cabinet and directory navigation

Files: `src/client/pages/KnowledgeCabinetPage.tsx`, `src/client/pages/KnowledgePage.tsx`, `src/client/components/knowledge/knowledgeCatalogResponse.ts`, `src/client/styles/knowledge-cabinet.css`, `tests/component/knowledge-cabinet.test.tsx`.

- [x] Test root books → real nested folders → paper → reader → return, encoded URL and browser back/forward, counts, filtered search, empty/error, and stale paginated replies.
- [x] Keep the current page as a compatibility fallback for adapters without catalog capability; actual browser uses new page. URL `folder` is relative directory and `path` remains full note path. Retain search/filter state on back.
- [x] Validate response scope, breadcrumbs, immediate folders, item paths, counts, unique records, cursor advancement and snapshot consistency before displaying/merging pages.
- [x] Render approved physical forms in a scoped stylesheet without modifying global shell layout. Restore focus/scroll on return; reduced-motion support and left App navigation remain.
- [x] Run component tests and typecheck/build.

## Task 4: Verification and handoff

Files: `tests/electron/knowledge-cabinet.test.ts`, `README.md`, this plan and vault current handoff.

- [x] In a temporary vault verify real catalog, reading/source link, deep link refresh, nested/empty folders, filters and unchanged Markdown in Electron. Inspect desktop 1440/1024 and narrow 390/320 browser layouts for clipping.
- [x] Build/package with existing scripts; verify packaged app as well as development runtime. Review only task-related changes; do not commit the user's unrelated work.
- [x] Restart the user's local app, verify its real knowledge page and provide its current URL, with no model call or knowledge file mutation. Record verification; retain only useful final screenshots.

## Verification record — 2026-09-07

- Read-only API regressions: catalog unit 5 and integration 8 passed on the final tree. Related backend/client regressions during implementation also passed (20 unit, 41 integration and 36 client).
- Final cabinet/reader/catalog client component suites passed: 12 cabinet, 24 reader and 2 catalog client. The existing read-pages suite passed 57/57 when run separately. One concurrent run intermittently failed an unchanged queue pagination focus assertion; no queue code was changed for this task.
- `npm run build:desktop-runtime`, final `npm run typecheck` and Vite build passed. Existing bundle-size warning remains (~712 KB minified JS); no new dependency. Packaging succeeded with the verified local Electron 44.1.0 arm64 ZIP cache.
- Final development Electron run passed twice consecutively; final packaged Electron run passed once. Both exercise real local APIs with isolated test vaults, source-link reading, deep-link reload, Escape return, arbitrary-depth directories, obsolete opt-in and original-byte comparison. External model transport is blocked in these tests. Viewports 1440, 1024, 390 and 320 have no horizontal clipping.
- Review fixes verified with failing-then-passing regressions: explicit refresh rereads linked notes outside the catalog filter; slow directory completion does not steal search focus; background index updates reread without remounting the reader. An Electron startup race was reproduced: first health identity invalidated already-rendered paper DOM after Escape. Catalog now waits for the initial index identity; the race no longer reproduced in the two final development runs or packaged verification.
- Kept final visual evidence in `.local/knowledge-cabinet-evidence/packaged-final/` and `real-vault-shelf.png`; intermediate diagnostic screenshots/traces removed. Fixture vaults and user-data directories are removed by the tests.
- Real App was gracefully quit only after read-only queue inspection showed zero generating tasks. The rebuilt App restarted from `dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app`. Its current session URL is `http://127.0.0.1:50787/knowledge` (port changes on future restarts). Real read-only smoke verified 11 books, 181 non-obsolete indexed notes, and 7 papers in AI/AI基础, with no browser errors or horizontal overflow. No real note body was read for this smoke, no content was moved/written, and no model call was made. Requested a browser opening; UI tool returned queued.
- Existing dirty worktree and branch `desktop-read` are preserved; no commit, merge or push performed. Vault current handoff cleared after completion.
