# Inbox envelope opening and packet trash implementation plan

**Goal:** Keep the inbox tray alone until an envelope opens; make unwanted incoming packets recoverably deletable, without requiring archive metadata first.

**Architecture:** Preserve the existing archive flow and archived Markdown trash. A separate native packet port, immutable recovery journals, typed service/API, and confirmation UI handle incoming whole packets. No real user materials are used in destructive verification.

**Tech Stack:** React, TypeScript, Fastify, Zod, macOS N-API, Vitest, Playwright.

## Authorized scope

- User confirmed whole selected incoming packet plus its own attachments, recoverable move/restore only.
- Default: closed envelopes; selecting flips the lid and then reveals the archive sheet. Closing removes the sheet.
- Delete is an independent envelope icon; missing metadata does not prevent deletion.
- “待补信息” becomes “信息不完整”, with actual missing fields displayed.

## Independent implementation tasks

- [x] Native: extend `native/macos/sandbox-archive.c`, `src/server/archive/sandbox-native.ts`; create `src/server/trash/intake-trash-native.ts` and `tests/native/intake-trash.contract.test.ts`. Confine top-level source, retain descriptors, reject unsafe trees, use no-overwrite atomic rename and fsync. Keep existing Markdown port unchanged.
- [x] Service: create `src/shared/api/intake-trash.ts`, `src/server/trash/intake-trash-service.ts`, `tests/integration/intake-trash-service.test.ts`. Preview reads only; immutable intent precedes move; restore intent precedes restore, completed receipt follows full verification; compare complete manifests. Restart reconciles evidence without starting pending moves. Same-name conflicts preserve both copies.
- [x] Trash UI: create `src/client/pages/intake/useIntakeTrash.tsx`, `src/client/styles/intake-trash.css`, `tests/component/intake-trash.test.tsx`. Preview exact scope before confirmation, persist operation ID before submission, recover ambiguous requests using the same ID, restore from a user-opened inbox trash view.
- [x] Integration: add `src/server/api/routes/intake-trash.ts`, register in `src/server/app.ts`, bootstrap and close in `src/server/start-server.ts`, add typed `api.intakeTrash` methods in `src/client/api/client.ts`. All mutation routes retain existing CSRF/session/host checks.
- [x] Envelope UI: modify `IntakePage.tsx`, `intake/IntakeTray.tsx`, `intake.css`, `intake-tray.css`. Hide the editor unless selected, sequence lid and sheet motion, add independent accessible delete icon, gate archive and trash interactions while a confirmation is active.

## Verification and delivery

- [x] Red/green component tests for closed initial state, opening/closing, deletion without selecting, cancellation and refresh/restoration.
- [x] Native and service tests use temporary fixture directories only: files/attachments byte-identical after restore, no-overwrite, journal durability, unsafe paths, stale preview, cancellation, and repeated operations.
- [x] Route/API tests cover payload validation, CSRF and error-code preservation.
- [x] Run targeted tests, typecheck, client/server/Electron builds. Inspect real browser at desktop and narrow widths with fixture materials; no real-vault writes.
- [x] Update packaged app after read-only idle check, restart normally, inspect live GET endpoints and fresh assets. Remove only this turn's disposable test/deployment artifacts.
- [x] Update project evidence and clear vault handoff once delivered. Preserve all unrelated worktree edits; do not commit automatically.

## Completed delivery — 2026-09-07

All tasks above are complete. The restore **intent** precedes restoration; the separate immutable `.restored.json` **receipt** follows full verification. That terminal receipt permits subsequent edits, archival and another recycle cycle without reviving old operations. New same-name packets use separate UUIDs; restoring never overwrites a new arrival.

- Native: 126 regression tests passed; after adding the terminal receipt suffix, packet + original Markdown trash focused regression passed 56 tests.
- Service: 42 isolated integration tests; API 6 tests; embedded server lifecycle 13 tests; shared archive/recycle mutation gate 2 tests.
- Client: 32 focused component/API tests passed. First red tests demonstrated persistent editor, absent delete control and lost cancellation focus; each fixed and verified.
- Browser: 17 checks passed at 1440 / 1024 / 390 pixels, including open/close, metadata filtering, explicit archive, deletion cancellation, complete recycle/restore, keyboard focus and responsive bounds. Narrow screens lift the sheet vertically to keep the animation inside the viewport.
- Desktop: development and packaged Electron each passed the real filesystem roundtrip, two recycle/restore cycles and three starts, with BOM/CRLF, nested binary and empty attachments preserved byte-for-byte. Restored records remain terminal after later archival and restart. Temporary vaults/userData were cleaned by fixture teardown.
- Builds: full desktop runtime, then final client/server build and typecheck passed. Existing Vite large-chunk advisory remains non-blocking.
- Packaged runtime updated and normally restarted. Live GET-only checks at `http://127.0.0.1:60069/intake` confirmed two incoming packets, zero pending archives, two deletion controls, editor absent initially/after close, available empty packet trash, and no browser errors. No live material was deleted, restored or archived for testing.
- Client delivery: `index-DqmP195X.js`, `index-CUBOGzUb.css`; installed client index and approved native addon hashes match the build. No sandbox test writer is packaged.
- Evidence: `.local/intake-packet-results/` (browser and live screenshots), `test-results/intake-trash-flow-packaged-0d0dc-hivable-after-another-cycle/` (packaged end-to-end screenshots).

No permanent whole-packet deletion, data migration, real model request, or unrelated UI redesign was added. Existing archived-Markdown trash rules remain unchanged. Deployment backup and temporary browser config/server were removed after successful verification; unrelated worktree edits are preserved, with no commit.
