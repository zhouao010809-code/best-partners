# Creative Context Implementation Plan

> **For agentic workers:** Use subagent-driven-development for bounded independent work, then spec and correctness review. User has approved implementation; continue without another approval gate.

**Goal:** Reuse confirmed project creative background, constrain each script to its selected sources, and make the editor easier to understand.

**Architecture:** A project-owned SQLite profile uses optimistic revisions and immutable sample references. Drafts and versions retain optional source scope. The existing read-only AI generator applies the saved scope as a tool boundary. UI keeps profile editing explicit and reuses serialized draft autosave.

**Tech Stack:** React, TypeScript, Zod, Fastify, SQLite, Vitest, Electron Playwright; no additional dependencies.

## Storage and API

- [x] Add `src/shared/api/creative-profile.ts` and extend `src/shared/api/project-creations.ts` with the exact contracts in the approved design.
- [x] First add integration cases to `tests/integration/project-creations.test.ts / project-creative-migration.test.ts`: blank profile revision 0, save/reopen, stale expectedRevision rejected, sample cross-project rejected, frozen sample preserved, per-draft source selections survive save/snapshot/reopen.
- [x] Run `npx vitest run --config vitest.integration.config.ts tests/integration/project-creations.test.ts tests/integration/project-creative-migration.test.ts`; capture expected initial failure, then implement `023_project_creative_context.sql`, migration registration, profile persistence and route parsing. Keep existing export bytes immutable.
- [x] Register GET/PUT creative-profile beside creation routes. Add optional typed client methods in `src/client/api/client.ts`.
- [x] Rerun focused storage/runtime and migration tests, check server types.

## AI scope and background

- [x] Extend `tests/unit/creation-assistant.test.ts` with selected-file read/search restrictions, zero global tools in selected mode, missing file fails before adapter.run, project profile defaults and immutable style samples enter context, profile candidate remains unsaved.
- [x] Add generation scope helper under `src/server/projects/`, use it from `creation-assistant.ts`; enforce scope before delegated project reads, redact out-of-scope source/history context, retain only valid citation IDs. Do not rely on prompt text for access restrictions.
- [x] Wire `getProfileContext` from the persisted service in `src/server/api/register-routes.ts`. Profile candidate task returns structured fields only, no writes. Use model context budget and cancellation already present.
- [x] Run unit generator and real runtime integration tests using fake adapters; inspect received context and tool results, never real paid requests.

## UI and persistence

- [x] Create `ProjectCreativeProfile.tsx` and `CreationReferencePicker.tsx` plus scoped styles. Profile form supports explicit save, conflict recovery without discarding local fields, candidate preview, confirmed version samples. File picker supports search, readable originals, visible persisted selection, auto mode, max 20 and disabled empty selected mode.
- [x] Integrate profile at project workbench and in editor as a compact expandable panel; integrate per-item selection with `useCreationDraft.editable` so fingerprint/autosave/recovery/copy include scope. Topics inherit the submitted scope.
- [x] Compact `ProjectWorkspacePage` only while editing via explicit callback; label project discussion and manuscript assistant separately. Keep original model settings recovery, save/final/export controls. Avoid history auto-expansion after snapshots, keep final export discoverable.
- [x] Component tests prove unsaved profile input survives errors, stale candidates cannot overwrite newer fields, draft scope invalidates pending suggestion, planning input/scope captured together, and old API without profile methods still works.

## Verification and release

- [x] Independent spec and code review; fix material findings and add regression checks.
- [x] Run architecture checks, all typechecks, affected unit/integration/component suites, then broaden required suites if unresolved concerns remain.
- [x] Extend isolated `tests/electron/director-workbench.test.ts` or new adjacent test for profile/source persistence/restart and 1360/720 layouts; run it with first-run and existing project flows.
- [x] Bump 0.1.5, update reference and acceptance evidence. Build complete staged tree, package DMG, verify mount contents/version/SHA and development + packaged Electron checks.
- [ ] Push tested implementation to GitHub main; create draft release, verify hashes/target, publish; run production update checker from 0.1.4. Retain local installer and evidence, remove temporary build files. Do not replace a running app with unsaved work.
