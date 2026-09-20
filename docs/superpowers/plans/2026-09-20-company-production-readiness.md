# Company Production Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing company P0 slice into a safely deployable two-Mac pilot whose project, Skill, and Agent workflows are truthful, isolated, recoverable, and testable.

**Architecture:** Keep Markdown/YAML files as the company source of truth and SQLite as a projection/audit ledger. Tighten the runtime boundary so a company process cannot accidentally serve personal APIs, expose local absolute paths, or publish incomplete project metadata. Add a small HTTP-backed company MCP bridge for Codex/WorkBuddy and a reproducible Mac mini backup/launch path; platform scraping and private-message automation remain explicitly out of scope.

**Tech Stack:** TypeScript 6, Fastify 5, React 19, Zod 4, better-sqlite3, MCP SDK 1.30, Vitest 4, Vite 8, Node.js 22.

---

### Task 1: Close the company/personal API boundary

**Files:**
- Modify: `src/server/app.ts`
- Test: `tests/integration/company-workspace-api.test.ts`

- [x] **Step 1: Write the failing isolation assertion**

Add a company-mode request matrix asserting `/api/v1/health`, `/api/v1/library`, `/api/v1/skills`, and `/api/v1/assistant/providers` return `404` while `/api/v1/bootstrap` still returns `runtimeMode: company`.

- [x] **Step 2: Run the focused test and confirm the current leak**

Run: `npm run test:integration -- --no-file-parallelism tests/integration/company-workspace-api.test.ts`

Expected: the new assertions fail because personal routes are currently registered in company mode.

- [x] **Step 3: Add a fail-closed company namespace guard**

In the existing `onRequest` hook, before personal mutation/session handling, return the standard `NOT_FOUND` response for `/api/v1/*` when `runtimeMode === 'company'`, except the public `/api/v1/bootstrap` route. Do not alter personal mode or `/api/company/v1/*` behavior.

- [x] **Step 4: Run focused and security regressions**

Run: `npm run test:integration -- --no-file-parallelism tests/integration/company-workspace-api.test.ts tests/integration/security/company-lan-policy.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/server/app.ts tests/integration/company-workspace-api.test.ts
git commit -m "fix: isolate company runtime from personal api"
```

### Task 2: Make the project contract complete and path-safe

**Files:**
- Modify: `src/shared/api/company-projects.ts`
- Modify: `src/server/company/project-service.ts`
- Modify: `src/client/pages/company/CompanyProjectDetailPage.tsx`
- Modify: `src/client/pages/company/CompanyProjectDashboardPage.tsx`
- Modify: `src/client/components/company/ProjectImportProposal.tsx`
- Test: `tests/unit/company-project.test.ts`
- Test: `tests/integration/company-project-ingestion-api.test.ts`
- Test: `tests/component/company-dashboard.test.tsx`

- [x] **Step 1: Add contract tests for selected Skills and public relative paths**

Assert that project list/detail responses include `selectedSkillIds`, that `projectRoot`/`sourceRoot` are workspace-relative (`projects/<id>` and `incoming/<name>`), and that the API never returns the configured `/Users/...` or `/srv/...` prefix.

- [x] **Step 2: Run the focused tests to capture the current mismatch**

Run: `npm run test:unit -- --no-file-parallelism tests/unit/company-project.test.ts && npm run test:integration -- --no-file-parallelism tests/integration/company-project-ingestion-api.test.ts`

Expected: the new assertions fail because the projection omits `selectedSkillIds` and currently exposes absolute paths.

- [x] **Step 3: Extend the projection with selected Skill IDs and relative display paths**

Keep absolute paths internal for filesystem operations, but map API projections to stable workspace-relative paths. Include `selectedSkillIds` from `项目配置.yaml`/the persisted project projection and preserve the existing schema statuses and hashes.

- [x] **Step 4: Update the company UI to show actual Skill bindings and safe paths**

Render selected Skill IDs as a list in project detail, use relative source/project labels in the proposal, and derive the dashboard pending-proposal count from the returned project statuses instead of hardcoding “需核对”.

- [x] **Step 5: Run company component and integration tests**

Run: `npm run test:component -- --no-file-parallelism tests/component/company-dashboard.test.tsx tests/component/company-project-library.test.tsx tests/component/company-project-import-proposal.test.tsx && npm run test:integration -- --no-file-parallelism tests/integration/company-project-ingestion-api.test.ts`

Expected: PASS.

### Task 3: Provide a real, safe Codex/WorkBuddy company bridge

**Files:**
- Create: `company-mcp-server/client.ts`
- Create: `company-mcp-server/tools.ts`
- Create: `company-mcp-server/index.ts`
- Modify: `package.json`
- Create: `tests/company-mcp/client.test.ts`
- Create: `tests/company-mcp/protocol.test.ts`
- Modify: `README.md`
- Modify: `docs/company/company-p0-operations.md`

- [x] **Step 1: Define the HTTP client contract and write failing tests**

The client must require an explicit non-wildcard `COMPANY_API_ORIGIN`, send `Origin` on mutations, retain only an opaque session cookie and CSRF token, parse every response with existing Zod schemas, retry once after a session refresh, and never log credentials or absolute paths.

- [x] **Step 2: Implement the bounded client**

Implement login/session refresh and the seven read/confirm operations by calling the existing `/api/company/v1` routes. Reject arbitrary URLs, absolute project paths, unknown response fields, and write calls unless `COMPANY_MCP_WRITE_ENABLED=true`.

- [x] **Step 3: Register MCP tools**

Expose `company.list_projects`, `company.get_project`, `company.scan_project_folder`, `company.get_project_proposal`, `company.confirm_project`, `company.list_skills`, and `company.get_skill`. Tool descriptions must state that scan is a proposal and confirm is the only write, requiring explicit user intent.

- [x] **Step 4: Verify the stdio protocol and no-write default**

Run: `npm run test:company-mcp`

Expected: protocol lists exactly the seven tools; read tools work with a fixture server; confirm fails closed when write enablement is absent; returned JSON contains no password or machine-root path.

- [x] **Step 5: Add the operational registration command**

Add `company:mcp` and document a Codex/WorkBuddy registration using `COMPANY_API_ORIGIN`, `COMPANY_DISPLAY_NAME`, `COMPANY_PASSWORD`, and optional `COMPANY_MCP_WRITE_ENABLED=true`. Keep the existing personal read-only MCP unchanged.

### Task 4: Make Mac mini operation recoverable

**Files:**
- Create: `scripts/company-backup.ts`
- Create: `scripts/company-restore-check.ts`
- Create: `scripts/company-launchd.plist.template`
- Modify: `package.json`
- Modify: `src/server/index.ts`
- Test: `tests/unit/company-operations.test.ts`
- Modify: `docs/company/company-p0-operations.md`

- [x] **Step 1: Write backup/restore and graceful-shutdown tests**

Cover exact workspace/state source validation, symlink rejection, manifest creation with file counts and hashes, restore verification, and idempotent SIGTERM/SIGINT shutdown.

- [x] **Step 2: Implement safe backup tooling**

Require explicit absolute source and destination paths, refuse a destination inside either source, copy the complete workspace and SQLite state (including WAL/SHM, backups, and recovery) into a timestamped snapshot, and write a manifest. Never delete or overwrite an existing snapshot.

- [x] **Step 3: Add restore verification**

Verify manifest hashes and required company directories without starting the server or modifying the source. Return non-zero on missing, changed, symlinked, or extra unsafe entries.

- [x] **Step 4: Add graceful company-server signal handling and a launchd template**

Close Fastify and SQLite exactly once on SIGINT/SIGTERM, keep personal startup unchanged, and provide a user-level launchd template with explicit paths, `KeepAlive`, stdout/stderr logs, and environment variables.

- [x] **Step 5: Run operation tests and document the two-Mac runbook**

Include first boot, backup before upgrades, restore rehearsal, health check, and the manual platform-data boundary. Do not claim automatic platform metrics or private-message access.

### Task 5: Full verification and handoff

**Files:**
- Modify: `README.md`
- Modify: `docs/reviews/2026-09-20-company-production-readiness.md`

- [x] **Step 1: Run fresh verification**

Run typecheck, unit, integration, security, component, build, company MCP tests, and a real built company-server smoke with temporary workspace/state.

- [x] **Step 2: Record blocked checks honestly**

If Playwright Chromium or a physical second Mac is unavailable, record it as manual follow-up rather than claiming it passed.

- [x] **Step 3: Commit the audited system and hand off exact launch commands**

Report changed files, test output, the two-Mac acceptance steps, and remaining out-of-scope platform connector work.
