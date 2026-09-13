# Clipper Date Compatibility Implementation Plan

> **For agentic workers:** Use test-driven development and independent review. Checkboxes track the current approved repair; keep unrelated dirty work untouched.

**Goal:** The user's plugin sample automatically displays its saved collection date and can preview/archive without losing its extra metadata or original body.

**Architecture:** Extend only the pure intake planner's known plugin mapping and deterministic body-preservation function. Reuse that exact function in journal validation so recovery accepts only the expected metadata prefix, never arbitrary inserted text. Existing API, UI, archive confirmation and knowledge-write boundaries remain unchanged.

**Tech Stack:** Existing TypeScript, YAML parser, Vitest and Electron Playwright tests. No dependency changes.

## Approved repair and decisions

The user approved the preceding diagnosis and proposal to fix App compatibility rather than edit the source. The real sample has `clipped: 2026-09-05`, `published`, `description`, and `学习状态`. `clipped` means collection date; `published` does not. Add `clipped` to the existing scalar date aliases, retaining strict conflict detection and calendar-date validation. Do not derive a date from the clock or file modification time.

The existing vault intake rule permits moving valuable noncanonical metadata to a separate information section before the untouched original body. Preserve the three known extra string fields in a literal YAML code block headed `原始资料信息`, without changing the canonical frontmatter schema. Escape multiline/Markdown-like values in quoted YAML strings. If the user corrects a different or invalid `clipped` value, preserve that original value in the same section. Unsupported nonempty keys, invalid Unicode and nonscalar values still fail closed. Already preserved matching information must not be duplicated; repeated planning of canonical output must leave body bytes identical.

Keeping these keys in canonical YAML would violate its strict schema; merely allowing and dropping them would lose information. The narrow metadata-prefix path follows the existing approved vault rule. It is not permission to alter original paragraphs, download attachments or write knowledge.

## Task 1: Failing planner regression tests

Files: `tests/unit/intake-plan.test.ts`, `tests/archive/intake-service.test.ts`.

- [x] Add a plugin fixture with the actual observed field names, synthetically shortened text and existing BOM/CRLF/body-link shapes.
- [x] Assert `inferIntakeFields('原文.md', note('clipped: 2026-09-05')).collectedAt === '2026-09-05'`; a `published`-only document has no inferred date. Conflicting date aliases refuse planning; invalid clipped values are not inferred.
- [x] Assert canonical output has `采集日期: 2026-09-05`, the information block round-trips all known extras, and its remaining byte suffix is exactly the original body. Unknown metadata is still refused. Check quotes, line breaks, existing duplicate information, date corrections and repeated planning.
- [x] Run `npx vitest run tests/unit/intake-plan.test.ts` and observe the expected missing-date/unsupported-metadata failures before production edits.
- [x] Add a native service case that previews and commits a synthetic plugin sample, preserves the entire original in recovery, and rejects a forged arbitrary body prefix. Observe failure before changing journal validation.

## Task 2: Minimal implementation

Files: `src/server/archive/intake-plan.ts`, `src/server/archive/intake-archive.ts`.

- [x] Include `clipped` in the known plugin date aliases. Preserve `published`, `description`, `学习状态` as original information, not canonical knowledge metadata.
- [x] Export a deterministic original-body preservation function taking original bytes and the confirmed collection date. Emit only validated original fields before untouched original bytes; return the body unchanged when no new information needs preserving.
- [x] Use this function for planner output and the coordinator's `validateStored` body equality check. Do not replace equality with a broad suffix acceptance check; previous no-extra journals continue to validate unchanged.
- [x] Run planner and native service/archive tests; address only failures directly related to this repair.

## Task 3: Actual desktop and handoff

Files: `tests/electron/intake-flow.test.ts`, `README.md`, this plan and the vault's `99_当前会话交接.md`.

- [x] An independent test worker adds plugin metadata to the temporary Electron fixture. Verify title/source/date autofill without manual date input, preview success, exact original-body suffix and attachment bytes after explicit test confirmation, unchanged knowledge gate and database recovery blocking in both development and packaged modes.
- [x] Independently review alias conflicts, metadata preservation and recovery validation; fix important findings.
- [x] Run typecheck, unit/integration/component suites, personal archive tests, build/package and the six Electron acceptance cases. Use the existing verified Electron cache if downloads remain unavailable.
- [x] Read-only evaluate the real sample before/after and compare its hash; never call real commit/resume. Replace and relaunch the user's packaged App after checking for unsaved work. Confirm date and preview in the current App; user retains the final archive action.
- [x] Update documentation with fresh verification and remaining limitations; preserve existing worktree changes and do not make a broad commit.

## Verification and handoff

- Planner regressions initially had six expected failures (missing date and unsupported metadata), then passed. The native service case initially failed confirmation until journal validation shared the exact body plan. Three interruption points plus an arbitrary-prefix/no-orphan-stage check were red before coordinator fixes. Desktop development initially reproduced the blank date on the old build.
- Independent review identified duplicate information when YAML quoting differed or an existing block was partial. Two reproductions failed first; both now pass. Matching is limited to explicitly labelled, safely parsed information blocks and strict per-key string equality. Ambiguous blocks and coincidental body substrings never authorize dropping original metadata. The reviewer rechecked the fix and found no blocking issue.
- Final checks: **587 unit**, **151 integration**, **201 component**, **12 personal native**, **46 archive/service/crash**, and **6 Electron desktop tests** passed. The focused planner suite contains 62 tests. Type checking, desktop runtime build, packaging and `git diff --check` passed. The existing 500 kB client bundle warning remains; no frontend redesign or bundle optimization was made.
- The actual macOS arm64 package was rebuilt from the existing verified Electron 44.1.0 cache and relaunched. Its native whitelist still contains only `atomic-file-helper` and `personal-archive.node`. No native authority or dependency changes were needed.
- After relaunch, the real selected vault was ready. The App's intake API returned `collectedAt: 2026-09-05` for the actual plugin sample; a read-only preview returned HTTP 200 and retained publication time, description and study state. One intake item remained, with **zero archive operations**. Automatic archive stayed false. No real commit/resume was called.
- The real sample's SHA-256 before and after was unchanged: `d7cf10ce53316a12f6d229cff725f1103a036e99870e580a87b07a3a3ba2fad6`. No original or attachment was edited/moved. Real UI confirmation remains the user's next action; successful temporary-fixture archiving is not presented as completed real archiving.
- Limitations remain: only these observed plugin fields were added, not arbitrary unknown metadata or timestamp-shaped collection dates. DeepSeek, knowledge writing and unattended automatic archiving remain outside this repair. Full browser visual E2E was not rerun; actual development/packaged Electron acceptance was.
