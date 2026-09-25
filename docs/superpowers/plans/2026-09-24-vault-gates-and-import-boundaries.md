# Vault Gates and Import Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the real-vault metadata health, verification gates, and spreadsheet-risk boundary explicit without changing user notes or business data.

**Architecture:** Reuse the existing strict/read-compatible note parsers for a read-only vault lint command. Upgrade SheetJS from its official CDN, keep the import contract and limits, and move synchronous parsing to a timed Worker. Document the remaining real-sample compatibility boundary. Separate fast, full, and release verification so a green command names exactly what it covers.

**Tech Stack:** Node 22, TypeScript, `tsx`, Vitest, existing Zod/YAML note parsers, npm scripts, GitHub Actions.

---

### Task 1: Add a read-only vault lint report

**Files:**
- Create: `scripts/vault-lint.ts`
- Create: `tests/unit/vault-lint.test.ts`
- Modify: `package.json`

- [x] **Step 1: Write failing tests for strict notes, legacy read-compatible notes, and untyped Markdown.**
- [x] **Step 2: Run `npm run test:unit -- tests/unit/vault-lint.test.ts` and confirm the new module is missing.**
- [x] **Step 3: Implement recursive, symlink-skipping Markdown discovery under `01图书馆` and `02知识库`; classify strict records as valid, read-compatible records as warnings, malformed frontmatter as errors, and files without frontmatter as warnings unless strict mode is requested.**
- [x] **Step 4: Add `VAULT_ROOT`-driven CLI output with stable counts and exit codes; never write or rewrite vault files.**
- [x] **Step 5: Run the focused test and `VAULT_ROOT=/Users/ao/我的大脑 npm run vault:lint`; preserve the report as terminal evidence only.**

### Task 2: Align verification scripts and CI

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Test: existing unit and integration suites

- [x] **Step 1: Add explicit `test:all`, `verify:full`, and `verify:release` command composition covering security, archive, native, E2E fixture, Electron, and company build checks where the environment supports them.**
- [x] **Step 2: Keep external Obsidian contracts as an explicit separate command so missing real credentials cannot become a misleading green result.**
- [x] **Step 3: Make CI call the named fast gate and add the full fixture gate on the supported runner.**
- [x] **Step 4: Run the changed command graph locally and record any platform-only checks separately.**

### Task 3: Document the spreadsheet risk boundary

**Files:**
- Modify: `docs/superpowers/specs/2026-09-22-architecture-foundation-design.md`
- Modify: `docs/reviews/2026-09-20-company-production-readiness.md`

- [x] **Step 1: Document the existing 20 MiB, sheet, row, cell, and parse-failure limits as the current control boundary.**
- [x] **Step 2: Upgrade to official SheetJS 0.20.3 and document the verified parser boundary.**
  - The parser runs in a Worker with a 15-second timeout and V8 heap limits. The lockfile pins the official CDN tarball and integrity; production audit is clean. Worker heap limits are not process memory isolation.
- [x] **Step 3: Run typecheck and the company importer tests after the parser change, including legacy XLS and Excel calendar regressions.**

### Task 4: Verify without mutating the vault

**Files:**
- The lint command never writes notes. Separately authorized metadata repairs fixed five malformed records without changing source bodies.

- [x] **Step 1: Run the focused lint tests and all current fast tests.**
- [x] **Step 2: Run the real-vault lint in report mode and capture error/warning counts.**
- [x] **Step 3: Run `npm audit --omit=dev --audit-level=high` and confirm zero production findings after the official upgrade.**

Final local verification and external acceptance boundaries: [2026-09-25 architecture acceptance](../../reviews/2026-09-25-architecture-foundation-acceptance.md).
