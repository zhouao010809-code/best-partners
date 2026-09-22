# Architecture Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize the current modular monolith by removing the first layering violation, restoring contract/test consistency, making verification reproducible, and adding a CI foundation without changing user data or API URLs.

**Architecture:** Keep the existing personal/company runtime and SQLite/file source-of-truth intact. Add small shared contract and verification seams first: shared desktop value types, one bootstrap state per browser client, explicit architecture checks, complete typecheck/test entrypoints, and fixture-aware Playwright commands. Runtime composition and domain repository extraction remain follow-up phases.

**Tech Stack:** TypeScript 6, React 19, Fastify 5, Vitest 4, Playwright 1.62, GitHub Actions, Node 22.

---

### Task 1: Restore the project write-plan contract test

**Files:**
- Modify: `tests/component/api-client.test.tsx:469-500`
- Read-only reference: `src/shared/api/projects.ts:201`, `src/server/api/routes/projects.ts:135-160`

- [ ] **Step 1: Replace the conversation fixture with a valid `ProjectWriteAction` response fixture while preserving CSRF/idempotency assertions.**
- [ ] **Step 2: Run `npx vitest run --config vitest.client.config.ts tests/component/api-client.test.tsx -t "uses CSRF and idempotency keys"`; expected: PASS.**
- [ ] **Step 3: Run the full component suite; record any remaining independent failure.**
- [ ] **Step 4: Commit with `test: align project write-plan response contract`.**

### Task 2: Remove shared/client to Electron type coupling and make browser bootstrap reusable

**Files:**
- Create: `src/shared/desktop/update.ts`
- Modify: `src/electron/update-check.ts`
- Modify: `src/shared/desktop/bridge.ts`
- Modify: `src/client/pages/SettingsPage.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/api/client.ts`
- Test: `tests/component/api-client.test.tsx`, `tests/component/app-smoke.test.tsx`

- [ ] **Step 1: Add a shared `UpdateCheckResult` type and re-export it from the Electron implementation without changing runtime behavior.**
- [ ] **Step 2: Add a bootstrap-state injection option to `createBrowserReadConsoleApi`; when supplied, reuse its CSRF token and runtime mode without a second bootstrap request.**
- [ ] **Step 3: Make `App` create one bootstrap promise/state and pass it into the router/API runtime; retain the personal fallback only while mode is pending.**
- [ ] **Step 4: Add `AbortSignal` to `writeWithCsrf` and thread it through write methods without replaying an aborted request.**
- [ ] **Step 5: Run focused component tests, then full component tests.**
- [ ] **Step 6: Commit with `refactor: centralize browser runtime bootstrap`.**

### Task 3: Add architecture and verification entrypoints

**Files:**
- Create: `scripts/check-architecture.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `tsconfig.mcp.json`
- Test: `tests/unit/scripts/check-architecture.test.ts`

- [ ] **Step 1: Write tests for allowed imports and for rejecting shared/client-to-Electron or client/server edges.**
- [ ] **Step 2: Run the new test and observe the intentional RED result before implementation.**
- [ ] **Step 3: Implement a deterministic source scan that resolves relative imports and exits nonzero on protected-layer violations.**
- [ ] **Step 4: Add personal MCP to the project typecheck path and add `check:architecture`, `test:all`, `verify:fast`, and `verify:release` scripts.**
- [ ] **Step 5: Run architecture check, typecheck, unit, integration, MCP, company-MCP and the focused component test.**
- [ ] **Step 6: Commit with `build: add architecture and verification gates`.**

### Task 4: Make E2E fixture orchestration explicit

**Files:**
- Modify: `package.json`
- Create: `scripts/run-playwright-suites.ts`
- Modify: `tests/e2e/overview-desk.spec.ts`
- Modify: `tests/e2e/intake-tray.spec.ts`
- Modify: `tests/e2e/company-project-onboarding.spec.ts`

- [ ] **Step 1: Keep the existing default web app E2E command separate from fixture-specific configs.**
- [ ] **Step 2: Add a runner that invokes each checked-in config serially and propagates the first nonzero exit code.**
- [ ] **Step 3: Narrow stale role selectors and metric/card assertions to the current fixture contract; do not weaken assertions.**
- [ ] **Step 4: Run each affected dedicated config and the aggregate fixture command.**
- [ ] **Step 5: Commit with `test: make browser fixture suites reproducible`.**

### Task 5: Add a minimal CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `README.md` verification section

- [ ] **Step 1: Add a Node 22.12+ Linux job for architecture, typecheck, unit, integration, MCP and company-MCP.**
- [ ] **Step 2: Add a macOS arm64 job for native and Electron checks behind the existing platform constraint.**
- [ ] **Step 3: Upload Playwright and build artifacts on failure; do not run real-vault, real-model or external-write commands.**
- [ ] **Step 4: Run YAML/script validation locally and review the workflow against package scripts.**
- [ ] **Step 5: Commit with `ci: add architecture and runtime verification workflow`.**

### Task 6: Final verification and integration review

**Files:**
- Read-only: all changed files and `git diff`

- [ ] **Step 1: Run `git diff --check`.**
- [ ] **Step 2: Run `npm run verify:fast`.**
- [ ] **Step 3: Run dedicated fixture suites and package/build checks available on the current host.**
- [ ] **Step 4: Confirm the pre-existing untracked user files remain untouched.**
- [ ] **Step 5: Report exact passing/failing counts and remaining follow-up work; do not claim release readiness without signing/notarization.**

