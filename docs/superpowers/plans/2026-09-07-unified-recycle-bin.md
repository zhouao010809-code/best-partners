# Unified Recycle Bin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 一个黑银垃圾桶页面统一四个来源的回收、恢复和逐项彻底删除。

**Architecture:** 汇总现有单 Markdown 与整包两种后端，不迁移旧文件。单 Markdown intent 新增可选 origin 并支持单篇知识；收件箱补永久删除状态机与受约束 Native purge。客户端统一显示与动作派发，保留同操作查询/确认机制。

**Tech Stack:** Existing React/TypeScript/CSS, Fastify/Zod/SQLite, macOS Native archive addon, Vitest/Playwright/Electron.

---

## Ownership and contracts

- Native/packet agent: `native/macos/sandbox-archive.c`, `src/server/trash/intake-trash-*`, `src/shared/api/intake-trash.ts`, `src/server/api/routes/intake-trash.ts` and packet native/service/API tests. Native owner also adds explicit single `02知识库/**/*.md` support to existing Markdown trash paths; no other agent edits C.
- Document agent: `src/server/trash/trash-service.ts`, `trash-native.ts`, `src/shared/api/trash.ts`, `src/server/api/routes/trash.ts` and Markdown service/API tests. No client/C edits.
- UI agent: `src/client/**` and focused component/browser tests. No shared/server/native edits.
- Main agent: coordination, ingestion/queue visibility guards and tests, runtime integration, docs, review and final build/deployment.

Shared interface additions (existing methods unchanged):

```ts
type TrashOrigin = 'library' | 'queue' | 'knowledge';
// trash preview request: { materialPath: string, origin?: TrashOrigin }
// TrashEntry/TrashPreview: origin?: TrashOrigin, old records default library.
// Service preview(path, origin?) validates path/origin consistency.
// Client trash.preview(materialPath, origin?) supplies new optional origin.
// IntakeTrashEntry adds 'deleting' | 'deleted' and optional deletedAt.
// IntakeTrashDeletePreview = IntakeTrashPreview & { token: string }.
// POST /api/v1/intake-trash/:id/delete-preview {} -> delete preview
// POST /api/v1/intake-trash/:id/delete { token } -> entry
// Client intakeTrash.previewDelete(id), intakeTrash.delete(id, token).
```

## Task 1 — Document service and knowledge support

- [x] Add failing service/API tests for origin surviving restart, legacy intent compatibility, knowledge-only Markdown delete/restore/purge, no linked source mutation and origin/path mismatch rejection.
- [x] Extend schemas and immutable intent with optional origin; infer knowledge origin only for knowledge paths and library otherwise. Keep one active recycle operation per path.
- [x] Parse knowledge note title from current bytes, permit recognized single knowledge notes, preserve file bytes and original path; show associated references without cascades. Check noncommitted ingestion target paths before mutation.
- [x] Run focused integration and native Markdown regression tests; report commands and evidence to main agent.

## Task 2 — Packet permanent deletion and Native capability

- [x] Add failing packet tests for delete token/expiry, directory and file purge, nested attachments, restart after explicit confirm, changed tree rejection and restore conflict with deletion.
- [x] Add Native purge bounded to confirmed UUID.packet tree. Validate fd ancestry/identity and manifest; do not traverse symlink/hardlink or remove outside packet. Add immutable delete intent/receipt suffixes and partial-deletion handling that never silently auto-continues on startup.
- [x] Add single knowledge Markdown path permission to existing trash branch and test it independently from core/archive paths.
- [x] Extend packet service/schema/routes with delete-preview/delete and deleting/deleted; preserve old restore receipts and archive mutual exclusion.
- [x] Run packet native/service/API tests. Native owner alone rebuilds addon and signals readiness for dependent tests.

## Task 3 — Unified UI

- [x] Add focused failing tests for sole `/trash` navigation, four source classes, correct action dispatch and confirmation state. Pure visual CSS needs no redundant unit tests.
- [x] Build `TrashPage` and focused styles/components: one bucket surface, four divider tabs and all view, search, readable paper tiles, details only on selection, real counts, loading/error/empty states, reduced motion and narrow layouts.
- [x] Aggregate `api.trash.list()` and `api.intakeTrash.list()`. Exclude terminal restored/deleted entries from active count. Do not display a failed source as zero.
- [x] Wire matching restore/delete-preview/delete handlers and persisted same-id operation recovery. Reuse existing dialogs where practical, preserve restart recovery receipts.
- [x] Add sole sidebar-bottom trash icon. Remove inbox/library embedded bin browsing; redirect old library query. Keep independent per-document deletion, add knowledge delete and queue “删除文档” with origin, keep queue “移出队列” separate.
- [x] Run relevant component tests; browser-check at desktop, intermediate and mobile widths.

## Task 4 — Integration guards and delivery

- [x] Add failing regressions for deleted source queue-history reappearance, same-path new document visibility, and knowledge targets protected from conflicting ingestion/recovery.
- [x] Implement narrowly scoped guards, retaining all historical runs/links. Ensure restore enables actual source again; never use a permanent path blacklist.
- [x] Review each task against spec then code quality; resolve findings. Run focused cross-boundary regression and `npm run build:desktop-runtime` after agents finish.
- [x] Use isolated fixture for actual Electron four-source recycle/restore/delete lifecycle. No real-vault destructive test.
- [x] Confirm running App idle, back up exact packaged runtime, replace built runtime and reopen; verify new port and read-only live UI. Remove task temp files and update vault permission exception/handoff and README truthfully.

No commits of the dirty prior worktree; all pre-existing user changes stay in place. This task is authorized by the user's approval of the preceding design; execution proceeds without repetitive process-choice prompts.

## Delivery evidence — 2026-09-07

- Spec and independent quality review completed for document lifecycle, knowledge/queue/read guards and packet purge. Fixed stale projection reappearance, old queue visibility contaminating a new same-path source, generic knowledge detail guard bypass, and preview-versus-confirmation history cutoff. Old immutable intents remain byte-compatible.
- Integration: 9 files / 244 tests passed (`personal-trash-service`, `personal-trash-api`, `intake-trash-service`, `intake-trash-api`, `read-api`, `embedded-server`, `knowledge-catalog-api`, `extraction-queue-api`, `personal-ingestion-service`).
- Native: `intake-trash.contract` + `personal-trash.contract`, 72 passed. Real native + SQLite + HTTP archive flow: 5 passed. Includes interrupted packet deletion with explicit fresh confirmation for the remaining tree; no startup auto-purge.
- Component: full suite 407 passed. Final pointer stability refinement additionally verified with 34 focused tests. The previously intermittent removed-queue click failure was reproduced with controlled promises and pointerdown/up: the same-scope preview now stays mounted, and loading does not insert a placeholder above existing cards.
- Chrome fixture: 5 passed at 1440/1024/390 widths, including selection visibility, four origins, restore/delete dispatch, real counts, and source failure distinct from empty. Reusable command: `npm exec playwright test -- --config tests/e2e/unified-trash.config.ts`; it starts the isolated Vite fixture on 41795, with no live API writes.
- Electron lifecycle: development 1 passed; final packaged runtime 1 passed using `tests/electron/unified-trash-flow.test.ts` (`UNIFIED_TRASH_PACKAGED=1` for packaged). Recycled all four origins, restarted, restored exact BOM/CRLF/binary/empty-directory content, used knowledge UI deletion, permanently deleted each origin through UI, restarted again, and verified historical receipts plus untouched outside attachment. Temporary vaults/userData were removed by the test.
- `npm run build:desktop-runtime` passed. The last queue-only frontend refinement then passed `npm run build`; the final client was installed into the packaged App. Byte comparison verified packaged client/server/electron and both allowed native runtime binaries exactly match current builds. Existing large-client-bundle warning remains non-blocking.
- Confirmed live App idle before normal quit: no generating extraction, no pending archive/trash operation. Backed up the exact previous packaged runtime, installed current runtime, passed isolated packaged test, then reopened the real App. New origin at verification: `http://127.0.0.1:54996`, PID 51231.
- Real-vault read-only checks: health ready, one sidebar trash link, page and sidebar both show 2 existing intake packets, all four origin tabs present, both restore and permanent-delete buttons available after selection, knowledge empty filter and intake filter work. Previous 3 deleted document receipts remain historical records. No non-index POST, no browser error, no real-vault delete/restore or model request.
- Screenshots retained in `.local/unified-trash-evidence/` (development, packaged, and real live page). Temporary runtime backup and obsolete /tmp fixture screenshots cleaned only after verification. Existing dirty branch/worktree retained; no commit, merge, or migration of user data.
