# Director Workbench Implementation Plan

> **For agentic workers:** Use subagent-driven-development for independent server/assistant units, with controller integration and independent review. User approved the concrete creation-first prototype on 2026-09-26.

**Goal:** Deliver a personal-project workspace for short-video topics and scripts, including local drafts, AI suggestions, immutable versions, finalization and explicit export.

**Architecture:** SQLite owns creations independently of assistant input drafts and write-plan lifetimes. The existing DeepSeek assistant adapter and read-only project tools produce structured suggestions; a human adopts changes into the editable draft. A version snapshot is immutable and exported only by an explicit UI command to an exclusive AI工作区 file. Personal runtime only.

**Tech Stack:** Existing React, TypeScript, Fastify, SQLite, Zod, Vitest and Electron Playwright; no new dependencies.

## Contract and storage

- [x] Add `src/shared/api/project-creations.ts` schemas/types for `ProjectCreation`, `CreationVersion`, `CreationDetail`, `CreationExchange`, `CreationSuggestion`, requests and service.
- [x] Add migration and `src/server/projects/project-creations.ts`: project-owned draft with optimistic revision; immutable snapshots; stable finalVersionId; retained AI exchange history; explicit export with unique version path and no clobber.
- [x] First run integration tests that fail for missing implementation, then cover create/save/reopen, conflicts, cross-project rejection, final snapshot unchanged after editing, same-title export and source-file integrity.
- [x] Add `src/server/api/routes/project-creations.ts` with parsed input/output and ordinary errors; routes `/api/v1/projects/:projectId/creations`, `/:creationId`, `/:creationId/versions`, `/:creationId/versions/:versionId/export`, `/creation-suggestions`.

## Read-only AI generation

- [x] Add failing unit tests and `src/server/projects/creation-assistant.ts`, reusing AssistantAdapter and only read tools. Tasks `topics`, `script`, `revise`, `discuss` return validated suggestions, actual read sources and baseRevision.
- [x] Include current saved body and brief explicitly. Source text is evidence, never instructions. Restrict selection edits to the exact selected substring. Reject invalid/incomplete model structured output and fabricated source references. Never mutate body from model execution.
- [x] Preserve request/response per creation, with failure and late-result behavior; abort generation on server shutdown/client cancellation.

## Workbench UI and integration

- [x] Wire optional personal capability, route composition and typed client API in existing architecture.
- [x] Create `ProjectWorkbench.tsx`, `CreationEditor.tsx`, supporting state hook and scoped CSS; integrate `ProjectWorkspacePage.tsx` with tabs 创作台 / 选题库 / 项目资料 / 已定稿. Existing files panel and project question remain available.
- [x] Empty state has 策划选题 and 新建脚本. Optional natural-language brief. Generated topics are saved as topic items; selected topic becomes a script through an explicit generation and adoption flow.
- [x] Editor owns title, brief, body and save state. Debounced autosave uses serialized expectedRevision updates, stores a local recovery draft, and never overwrites newer edits from a late save/AI response. Switching entries flushes current edits.
- [x] Assistant sidebar displays scoped suggestions, source links and exchanges. Buttons support generate, opening rewrite via selected text, free request, adopt, keep original and retry. Provider missing is explained with a settings link; manual writing remains usable.
- [x] Snapshot/history UI supports restore into working draft, finalize exact snapshot, and export exact snapshot with visible preview/target. Working draft and finalized snapshot remain distinct.
- [x] Component tests for entry isolation, autosave errors, stale suggestions, local edit adoption, version restoration and final state.

## Review and release

- [x] Independent spec review then correctness review; fix findings.
- [x] Architecture, typecheck, focused unit/integration/component and required first-run Electron checks; isolated workbench Electron test includes restart and responsive screenshots. No real account AI requests or real-vault test writes.
- [x] Update README/reference/review docs and version. Build the complete staged tree, verify packaged DMG contents/version/hash, and check packaged workbench.
- [ ] Commit, push GitHub main, draft release with verified assets then publish preview release. User has no Apple Developer account, so retain the existing manual DMG update path.
