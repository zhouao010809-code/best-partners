# Company P0 Shared Workspace and Project Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add a separate company runtime on the office Mac mini so two LAN clients can submit a project folder, have an Agent create a reviewable project draft, and confirm it into a shared file-first project workspace.

**Architecture:** Keep the existing personal Electron runtime and personal tables unchanged. Add a company API namespace and company client shell that use the proven filesystem, indexing, operation-ledger, and assistant primitives. Markdown/YAML and attachments remain the source of truth; SQLite stores stable IDs, projections, jobs, and audit metadata. This plan is only the first vertical slice: shared workspace, two-user access, project ingestion, and a truthful empty dashboard. Platform connectors, metric APIs, and the complete Skill registry are separate follow-up plans.

**Tech Stack:** TypeScript 6, React 19, Fastify 5, better-sqlite3, Zod 4, YAML 2, ULID 3, Vite 8, Electron 44, Vitest 4, Playwright 1.62.

---

## Scope and guardrails

The current checkout contains pre-existing uncommitted changes in `src/server/assistant/action-plan-store.ts` (deleted), `src/shared/api/assistant.ts` (modified), and `package.json`/`package-lock.json` (the MCP SDK dependency addition). Do not overwrite, reformat, restore, or reset those changes. Before implementation, create a dedicated feature worktree from the current branch and carry these changes only if the owner explicitly requests it.

The company runtime must not:

- alter personal route semantics, personal vault rules, or personal migration data;
- use browser scripts to log into platform backends;
- move, delete, or rewrite a submitted source folder without an explicit confirmation transaction;
- store platform passwords, cookies, or tokens in project files;
- treat an Agent inference as a confirmed fact;
- render unavailable metrics as zero.

## File map

Create:

- src/shared/company/project.ts — project IDs, lifecycle states, evidence confidence, and project manifest types.
- src/shared/company/workspace.ts — company workspace manifest and relative-path helpers.
- src/shared/api/company-auth.ts — bootstrap, login, logout, and session response schemas.
- src/shared/api/company-projects.ts — scan, proposal, confirm, list, and detail contracts.
- src/server/company/company-paths.ts — canonical workspace paths and containment checks.
- src/server/company/company-auth-service.ts — two-user bootstrap, password hashing, session lookup, and role checks.
- src/server/company/project-ingestion.ts — read-only scan, deterministic proposal generation, source hashing, and staging.
- src/server/company/project-service.ts — draft persistence, confirmation transaction, listing, and dashboard projection.
- src/server/company/company-runtime.ts — company server composition root.
- src/server/api/routes/company-auth.ts — company auth routes.
- src/server/api/routes/company-projects.ts — company project routes.
- src/server/db/migrations/017_company_workspace.sql — company tables and indexes.
- src/client/company/CompanyAppShell.tsx — company navigation and persistent Agent entry.
- src/client/company/company-router.tsx — company route tree.
- src/client/pages/company/CompanyProjectDashboardPage.tsx — active-project dashboard.
- src/client/pages/company/CompanyProjectLibraryPage.tsx — project list and folder-drop entry.
- src/client/pages/company/CompanyProjectDetailPage.tsx — project detail and activity.
- src/client/components/company/ProjectImportProposal.tsx — proposal confirmation card.
- src/client/components/company/company-api.ts — typed browser client.

Modify only these integration points:

- src/server/db/migrate.ts — register migration 17.
- src/server/app.ts — register company routes only when mode is company.
- src/server/security/origin-host.ts and src/server/security/loopback-policy.ts — add a separately tested company LAN policy without changing loopback behavior.
- src/client/app/ConsoleRuntime.tsx — expose runtimeMode and company session state without changing personal consumers.
- src/client/app/router.tsx — select the company router only for a company bootstrap payload.
- src/client/app/AppShell.tsx — preserve the personal shell; do not add company navigation to the personal navigation constant.
- src/server/index.ts and package.json — add an explicit company-server start/build command.

Tests to create:

- tests/unit/company-project.test.ts
- tests/unit/company-paths.test.ts
- tests/unit/company-auth-service.test.ts
- tests/unit/company-project-ingestion.test.ts
- tests/unit/company-agent-tools.test.ts
- tests/integration/company-workspace-api.test.ts
- tests/integration/company-project-ingestion-api.test.ts
- tests/integration/company-restart-recovery.test.ts
- tests/integration/security/company-lan-policy.test.ts
- tests/component/company-project-library.test.tsx
- tests/component/company-project-import-proposal.test.tsx
- tests/component/company-dashboard.test.tsx
- tests/e2e/company-project-onboarding.spec.ts

## Task 1: Establish the company runtime boundary

**Files:**

- Create: src/shared/company/workspace.ts
- Create: src/server/company/company-runtime.ts
- Modify: src/server/app.ts
- Modify: src/server/index.ts
- Modify: package.json
- Test: tests/integration/company-workspace-api.test.ts

- [ ] Step 1: Write the runtime-mode contract test.

Build the personal server with no mode and the company server with mode company. Assert that the bootstrap payload contains runtimeMode personal or company respectively, and that the personal server returns 404 for /api/company/v1/projects.

Run:

~~~bash
npm run test:integration -- tests/integration/company-workspace-api.test.ts
~~~

Expected: FAIL because runtimeMode and company composition do not exist.

- [ ] Step 2: Add the shared workspace contract.

Define:

~~~ts
export const companyRuntimeModes = ['personal', 'company'] as const;
export type CompanyRuntimeMode = typeof companyRuntimeModes[number];

export interface CompanyWorkspaceManifest {
  readonly id: string;
  readonly displayName: string;
  readonly rootPath: string;
  readonly incomingPath: string;
  readonly projectsPath: string;
  readonly skillsPath: string;
  readonly systemPath: string;
}
~~~

Add runtimeMode to the bootstrap schema. Keep the personal default unchanged.

- [ ] Step 3: Add a company composition root.

Create company-runtime.ts that composes the company path resolver, company database projection, company auth service, and project service. It must not pass a personal vault root or LocalRest51Gateway into company services.

Add scripts named company-server and build:company-server. Leave start and electron unchanged.

- [ ] Step 4: Run the test and regressions.

~~~bash
npm run test:integration -- tests/integration/company-workspace-api.test.ts
npm run test:integration -- tests/integration/embedded-server.test.ts
~~~

Expected: PASS.

- [ ] Step 5: Commit.

~~~bash
git add src/shared/company/workspace.ts src/server/company/company-runtime.ts src/server/app.ts src/server/index.ts package.json tests/integration/company-workspace-api.test.ts
git commit -m "feat: add isolated company runtime boundary"
~~~

## Task 2: Add safe paths and file-first project contracts

**Files:**

- Create: src/server/company/company-paths.ts
- Create: src/shared/company/project.ts
- Test: tests/unit/company-paths.test.ts
- Test: tests/unit/company-project.test.ts

- [ ] Step 1: Write path and manifest tests.

Assert that resolving /srv/company-workspace returns incoming, projects, skills, and system children. Reject parent traversal, absolute replacement paths, NUL bytes, backslashes, symlink escapes, and a workspace root contained by the SQLite state directory.

Assert that project status is exactly:

~~~ts
['draft', 'active', 'acceptance', 'completed', 'paused', 'archived']
~~~

- [ ] Step 2: Run the tests and verify failure.

~~~bash
npm run test:unit -- tests/unit/company-paths.test.ts tests/unit/company-project.test.ts
~~~

Expected: FAIL because the modules do not exist.

- [ ] Step 3: Implement canonical path resolution.

company-paths.ts must:

1. resolve the configured workspace root and real ancestors;
2. create children only through an explicit ensureCompanyWorkspace call;
3. reject roots equal to or contained by the state directory;
4. return absolute paths;
5. expose assertCompanyRelativePath for every company file operation.

- [ ] Step 4: Implement the project manifest types.

Define:

~~~ts
export type CompanyProjectId = string;

export interface CompanyProjectConfig {
  readonly id: CompanyProjectId;
  readonly clientName?: string;
  readonly name: string;
  readonly status: 'draft' | 'active' | 'acceptance' | 'completed' | 'paused' | 'archived';
  readonly serviceStart?: string;
  readonly serviceEnd?: string;
  readonly sourceRoot: string;
  readonly projectRoot: string;
  readonly selectedSkillIds: readonly string[];
  readonly platformAccountRefs: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectFieldEvidence {
  readonly value?: string;
  readonly confidence: 'confirmed' | 'inferred' | 'unknown';
  readonly evidencePaths: readonly string[];
}
~~~

Unknown values must remain unknown. The generated 项目配置.yaml is a file representation, not a database-only record.

- [ ] Step 5: Run tests and commit.

~~~bash
npm run test:unit -- tests/unit/company-paths.test.ts tests/unit/company-project.test.ts
git add src/server/company/company-paths.ts src/shared/company/project.ts tests/unit/company-paths.test.ts tests/unit/company-project.test.ts
git commit -m "feat: add safe company workspace and project contracts"
~~~

## Task 3: Add company projection tables

**Files:**

- Create: src/server/db/migrations/017_company_workspace.sql
- Modify: src/server/db/migrate.ts
- Test: tests/integration/database-kernel.test.ts
- Test: tests/integration/company-workspace-api.test.ts

- [ ] Step 1: Write migration assertions.

Assert the presence of:

~~~text
company_workspaces(id, display_name, root_path, created_at, updated_at)
company_users(id, workspace_id, display_name, role, password_salt, password_hash, disabled, created_at, updated_at)
company_sessions(id_hash, user_id, expires_at, created_at, last_seen_at)
company_projects(id, workspace_id, name, client_name, status, project_root, source_root, config_sha256, confidence_json, created_at, updated_at)
company_project_ingestion_runs(id, project_id, source_sha256, state, proposal_json, operation_id, created_at, updated_at)
company_project_events(id, project_id, actor_id, event_type, payload_json, created_at)
~~~

Assert that an open ingestion run cannot reuse the same source hash and that a workspace cannot have two rows claiming the same project root.

- [ ] Step 2: Run migration tests and verify failure.

~~~bash
npm run test:integration -- tests/integration/database-kernel.test.ts
~~~

Expected: FAIL because migration 17 is not registered.

- [ ] Step 3: Add the migration.

Migration 017 must define the company workspace, user, and session boundary before the project tables are created:

~~~sql
CREATE TABLE company_workspaces (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE company_users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES company_workspaces(id),
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'operator')),
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE company_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES company_users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
~~~

The project tables must reference `company_workspaces`; ingestion runs and events must retain actor/operation provenance. Add indexes/unique constraints for the source hash and project root rules asserted above.

Use these states:

~~~text
company_project_ingestion_runs.state:
scanning, proposed, confirmed, failed, superseded
~~~

Store JSON only after validating it with the shared Zod schema. Do not rename or alter personal tables.

- [ ] Step 4: Register version 17 and run regressions.

~~~bash
npm run test:integration -- tests/integration/database-kernel.test.ts tests/integration/operation-ledger.test.ts
~~~

Expected: PASS.

- [ ] Step 5: Commit.

~~~bash
git add src/server/db/migrations/017_company_workspace.sql src/server/db/migrate.ts tests/integration/database-kernel.test.ts tests/integration/company-workspace-api.test.ts
git commit -m "feat: add company workspace projection tables"
~~~

## Task 4: Add minimal two-user sessions and LAN policy

**Files:**

- Create: src/shared/api/company-auth.ts
- Create: src/server/company/company-auth-service.ts
- Create: src/server/api/routes/company-auth.ts
- Modify: src/server/app.ts
- Modify: src/server/security/origin-host.ts
- Modify: src/server/security/loopback-policy.ts
- Test: tests/unit/company-auth-service.test.ts
- Test: tests/integration/security/company-lan-policy.test.ts

- [ ] Step 1: Write auth tests.

Cover:

- bootstrap can run only when no company users exist;
- it creates one operator and one reviewer;
- password material never appears in a response or log;
- passwords use a per-user salt and constant-time comparison;
- login creates an opaque HttpOnly company_session cookie;
- expired, disabled, or malformed sessions return 401;
- operator can create and confirm a project;
- reviewer can read and approve a proposal but cannot change workspace paths;
- mutations require a valid CSRF token;
- personal loopback behavior remains unchanged.

- [ ] Step 2: Run tests and verify failure.

~~~bash
npm run test:unit -- tests/unit/company-auth-service.test.ts
npm run test:security -- tests/integration/security/company-lan-policy.test.ts
~~~

Expected: FAIL because company auth and LAN policy do not exist.

- [ ] Step 3: Implement password and session storage.

Use Node crypto.scrypt with a random 16-byte salt and a 32-byte derived key. Store only salt and derived key. Store only a SHA-256 hash of the opaque session ID. The login response contains only user identity, role, and CSRF token.

- [ ] Step 4: Implement the company LAN policy.

The company server must accept only its configured host and port, reject unknown Host headers with 421, reject mutation requests with unknown Origin, and never default to a public all-interface bind. The personal loopback policy must remain unchanged.

- [ ] Step 5: Run security and integration tests.

~~~bash
npm run test:security -- tests/integration/security/company-lan-policy.test.ts
npm run test:integration -- tests/integration/company-workspace-api.test.ts
~~~

- [ ] Step 6: Commit.

~~~bash
git add src/shared/api/company-auth.ts src/server/company/company-auth-service.ts src/server/api/routes/company-auth.ts src/server/app.ts src/server/security/origin-host.ts src/server/security/loopback-policy.ts tests/unit/company-auth-service.test.ts tests/integration/security/company-lan-policy.test.ts
git commit -m "feat: add protected company sessions"
~~~

## Task 5: Implement deterministic project-folder scanning

**Files:**

- Create: src/server/company/project-ingestion.ts
- Test: tests/unit/company-project-ingestion.test.ts

- [ ] Step 1: Write scanner tests with a fixture tree.

Use:

~~~text
客户A教育项目/
├─ 机构介绍.md
├─ 课程资料/
│  ├─ 课程表.pdf
│  └─ 试听课说明.md
└─ 品牌素材/
   └─ logo.png
~~~

Assert that the scanner returns a deterministic sorted manifest with relative path, kind, size, modification time, and SHA-256. Ignore .DS_Store and generated system directories. Reject symlink escapes and configured oversized files. Repeated scans of unchanged bytes must produce the same sourceSha256.

- [ ] Step 2: Run the test and verify failure.

~~~bash
npm run test:unit -- tests/unit/company-project-ingestion.test.ts
~~~

Expected: FAIL because the scanner does not exist.

- [ ] Step 3: Implement the scanner contract.

Expose:

~~~ts
export interface ProjectSourceEntry {
  readonly relativePath: string;
  readonly kind: 'file' | 'directory';
  readonly bytes?: number;
  readonly modifiedAt?: string;
  readonly sha256?: string;
}

export interface ProjectScanProposal {
  readonly sourceRoot: string;
  readonly sourceSha256: string;
  readonly suggestedName: string;
  readonly suggestedClientName?: string;
  readonly suggestedStatus: 'draft' | 'active';
  readonly fields: Readonly<Record<string, {
    value?: string;
    confidence: 'inferred' | 'unknown';
    evidencePaths: readonly string[];
  }>>;
  readonly selectedSkillIds: readonly string[];
  readonly entries: readonly ProjectSourceEntry[];
  readonly issues: readonly string[];
}
~~~

The P0 proposal generator is deterministic. Derive the initial name from the top-level folder, extract client and service dates only from clearly named small Markdown/YAML files, and leave selectedSkillIds empty until the Skill registry plan. Do not call a model in this task.

- [ ] Step 4: Implement safe staging.

Copy bytes into the company incoming staging area using temporary files and atomic rename. Write source-manifest.json. If a copy fails, clean only the run's staging directory and leave the original source untouched.

- [ ] Step 5: Run tests and commit.

~~~bash
npm run test:unit -- tests/unit/company-project-ingestion.test.ts
git add src/server/company/project-ingestion.ts tests/unit/company-project-ingestion.test.ts
git commit -m "feat: scan and stage company project folders safely"
~~~

## Task 6: Implement idempotent project drafts and confirmation

**Files:**

- Create: src/server/company/project-service.ts
- Test: tests/integration/company-project-ingestion-api.test.ts
- Test: tests/integration/company-restart-recovery.test.ts

- [ ] Step 1: Write integration tests.

Cover this exact sequence:

1. scan a source folder;
2. receive a draft run ID and proposal;
3. confirm with a project name and status;
4. assert 项目配置.yaml, 项目说明.md, source-manifest.json, and raw files exist;
5. assert original source bytes are unchanged;
6. assert the project appears once;
7. submit the same source again and receive the existing open run;
8. change one source file and receive a new proposal without replacing the old project;
9. interrupt confirmation, restart, and resume without creating a second project.

- [ ] Step 2: Run tests and verify failure.

~~~bash
npm run test:integration -- tests/integration/company-project-ingestion-api.test.ts tests/integration/company-restart-recovery.test.ts
~~~

Expected: FAIL because project service and routes do not exist.

- [ ] Step 3: Implement draft persistence.

Use ULIDs for projectId and runId. Persist proposals in company_project_ingestion_runs. A repeated request with the same source hash returns the open run and does not rescan.

- [ ] Step 4: Implement confirmation as a transaction.

Confirmation must:

1. rescan and compare sourceSha256;
2. reject stale proposals with COMPANY_SOURCE_CHANGED;
3. resolve a safe project-relative directory;
4. stage raw files;
5. atomically write 项目配置.yaml and 项目说明.md;
6. insert company_projects;
7. insert a project_confirmed event;
8. mark the run confirmed;
9. refresh the company index;
10. return the project projection and operation ID.

Never delete an existing target directory to make confirmation succeed. If a later step fails, leave a resumable run and do not mark the project active.

- [ ] Step 5: Implement project listing.

Sort statuses as active, acceptance, draft, paused, completed, archived. Within a status sort by updated time descending, then stable project ID. Include dataCoverage not_configured in P0.

- [ ] Step 6: Run tests and commit.

~~~bash
npm run test:integration -- tests/integration/company-project-ingestion-api.test.ts tests/integration/company-restart-recovery.test.ts
git add src/server/company/project-service.ts tests/integration/company-project-ingestion-api.test.ts tests/integration/company-restart-recovery.test.ts
git commit -m "feat: add idempotent company project confirmation"
~~~

## Task 7: Expose typed company project routes

**Files:**

- Create: src/shared/api/company-projects.ts
- Create: src/server/api/routes/company-projects.ts
- Modify: src/server/app.ts
- Test: tests/integration/company-workspace-api.test.ts
- Test: tests/integration/company-project-ingestion-api.test.ts

- [ ] Step 1: Write route contract tests.

Test:

~~~text
GET  /api/company/v1/projects
POST /api/company/v1/projects/scan
GET  /api/company/v1/projects/drafts/:runId
POST /api/company/v1/projects/drafts/:runId/confirm
GET  /api/company/v1/projects/:projectId
~~~

Every response includes version and passes a strict Zod schema. Invalid paths, stale hashes, duplicate confirmations, and invalid statuses return a documented error code and operation ID.

- [ ] Step 2: Run the tests and verify failure.

~~~bash
npm run test:integration -- tests/integration/company-workspace-api.test.ts tests/integration/company-project-ingestion-api.test.ts
~~~

- [ ] Step 3: Define strict request schemas.

The scan request accepts only a server-relative incoming path or a registered upload ID. It must never accept an arbitrary absolute path from a browser. The confirm request contains name, optional clientName, status draft or active, sourceSha256, and selectedSkillIds.

- [ ] Step 4: Register only in company mode.

Personal mode must not register company routes. Company mode registers auth and project routes under /api/company/v1. Existing /api/v1 routes remain unchanged.

- [ ] Step 5: Run regression tests and commit.

~~~bash
npm run test:integration -- tests/integration/company-workspace-api.test.ts tests/integration/company-project-ingestion-api.test.ts
npm run test:integration -- tests/integration/read-api.test.ts tests/integration/intake-api.test.ts
git add src/shared/api/company-projects.ts src/server/api/routes/company-projects.ts src/server/app.ts tests/integration/company-workspace-api.test.ts tests/integration/company-project-ingestion-api.test.ts
git commit -m "feat: expose company project ingestion API"
~~~

## Task 8: Add the company client shell and onboarding flow

**Files:**

- Create: src/client/company/CompanyAppShell.tsx
- Create: src/client/company/company-router.tsx
- Create: src/client/pages/company/CompanyProjectLibraryPage.tsx
- Create: src/client/pages/company/CompanyProjectDashboardPage.tsx
- Create: src/client/pages/company/CompanyProjectDetailPage.tsx
- Create: src/client/components/company/ProjectImportProposal.tsx
- Create: src/client/components/company/company-api.ts
- Modify: src/client/app/ConsoleRuntime.tsx
- Modify: src/client/app/router.tsx
- Modify: src/client/app/AppShell.tsx
- Test: tests/component/company-project-library.test.tsx
- Test: tests/component/company-project-import-proposal.test.tsx
- Test: tests/component/company-dashboard.test.tsx
- Test: tests/e2e/company-project-onboarding.spec.ts

- [ ] Step 1: Write component tests.

Using a fake company API:

1. render the project library;
2. choose a staged folder;
3. show analyzing state;
4. show inferred fields with an inference label and unknown fields with a confirmation label;
5. confirm;
6. show the active project card;
7. sort it before a completed project;
8. show retry without losing the source reference after a failed scan.

- [ ] Step 2: Run component tests and verify failure.

~~~bash
npm run test:component -- tests/component/company-project-library.test.tsx tests/component/company-project-import-proposal.test.tsx tests/component/company-dashboard.test.tsx
~~~

- [ ] Step 3: Implement company navigation.

The primary navigation contains only:

~~~text
项目数据看板
项目档案库
Skill 库
~~~

Skill 库 may show a not-yet-connected state in P0. Keep a persistent Agent button. Do not expose personal labels such as 收件箱 or 知识库 in the company primary navigation.

- [ ] Step 4: Implement the project library.

The library lists projects by status and provides a folder-drop entry into the Mac mini incoming area. It must not upload arbitrary client filesystem paths directly. The proposal card shows source name, file count, suggested project name, client, status, selected Skills, issues, source hash, and scan time.

- [ ] Step 5: Implement the dashboard projection.

Render active and acceptance projects first. Each card shows project name, client, status, last activity, data coverage 尚未接入, project health, and pending proposal count. Do not render fake platform metrics or zero values.

- [ ] Step 6: Run component and E2E tests.

~~~bash
npm run test:component -- tests/component/company-project-library.test.tsx tests/component/company-project-import-proposal.test.tsx tests/component/company-dashboard.test.tsx
npm run test:e2e -- tests/e2e/company-project-onboarding.spec.ts
~~~

- [ ] Step 7: Commit.

~~~bash
git add src/client/company src/client/pages/company src/client/components/company src/client/app/ConsoleRuntime.tsx src/client/app/router.tsx src/client/app/AppShell.tsx tests/component/company-project-library.test.tsx tests/component/company-project-import-proposal.test.tsx tests/component/company-dashboard.test.tsx tests/e2e/company-project-onboarding.spec.ts
git commit -m "feat: add company project onboarding shell"
~~~

## Task 9: Add safe Agent project tools

**Files:**

- Create: src/server/company/agent-tools.ts
- Modify: src/server/assistant/brain-tools.ts through a company-specific registration hook
- Test: tests/unit/company-agent-tools.test.ts
- Test: tests/integration/company-agent-project-flow.test.ts

- [ ] Step 1: Write tool contract tests.

Expose exactly:

~~~text
company.scan_project_folder
company.get_project_proposal
company.confirm_project
company.list_projects
company.get_project
~~~

Assert that every tool returns structured JSON, accepts a runId or projectId, and rejects paths outside the company workspace. Model output must never become a direct filesystem write instruction.

- [ ] Step 2: Run tests and verify failure.

~~~bash
npm run test:unit -- tests/unit/company-agent-tools.test.ts
npm run test:integration -- tests/integration/company-agent-project-flow.test.ts
~~~

- [ ] Step 3: Implement typed adapters.

Each tool calls ProjectService and validates its result. The Agent may propose name, clientName, status, and Skill IDs; only the explicit confirmation tool can commit them. Include operation ID and source hash in every mutation response.

- [ ] Step 4: Test the natural-language path.

With a fake assistant adapter, send a request equivalent to “把这个项目文件夹建立成一个新项目，先分析，不要直接确认。” Assert that a proposal is returned and no active project exists. Send explicit confirmation and assert exactly one project and one project-confirmed event.

- [ ] Step 5: Run tests and commit.

~~~bash
npm run test:unit -- tests/unit/company-agent-tools.test.ts
npm run test:integration -- tests/integration/company-agent-project-flow.test.ts
git add src/server/company/agent-tools.ts src/server/assistant/brain-tools.ts tests/unit/company-agent-tools.test.ts tests/integration/company-agent-project-flow.test.ts
git commit -m "feat: expose safe company project Agent tools"
~~~

## Task 10: Mac mini pilot and final P0 verification

**Files:**

- Create: docs/company/company-p0-operations.md
- Modify: README.md with a short company-runtime section
- Create: tests/electron/company-client-launch.test.ts if a packaged company client is included

- [ ] Step 1: Document the pilot runbook.

Document the Mac mini workspace root, incoming folder, start and stop commands, LAN URL, bootstrap of the two users, backup location, recovery of a pending ingestion run, and separation from the personal vault. State explicitly that platform backend scraping is unsupported.

- [ ] Step 2: Run the full P0 verification set.

~~~bash
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:component
npm run test:e2e -- tests/e2e/company-project-onboarding.spec.ts
npm run build
npm run build:company-server
~~~

Expected: all existing personal tests remain green, company onboarding passes, and company startup contains no personal-vault or personal-credential defaults.

- [ ] Step 3: Perform the two-computer acceptance run.

On computer A, log in as operator, submit the education project folder, review, and confirm. On computer B, log in as reviewer, open the dashboard, and verify the same project ID, source hash, status, timestamps, and activity record. Verify that no raw platform credentials or personal-vault paths are visible.

- [ ] Step 4: Commit the runbook.

~~~bash
git add docs/company/company-p0-operations.md README.md tests/electron/company-client-launch.test.ts
git commit -m "docs: document company p0 pilot operations"
~~~

## Self-review checklist

Before execution:

- personal runtime remains loopback-only;
- company routes are absent in personal mode;
- raw files remain unchanged;
- duplicate submission is idempotent;
- stale confirmation is rejected;
- interrupted runs are resumable;
- mutation responses contain operation IDs;
- inferred fields remain visibly unconfirmed;
- P0 does not claim platform metrics or private-message access;
- company primary navigation has exactly the three agreed areas;
- Skill registry and platform metrics remain separate follow-up plans.

## Follow-up plans after P0

1. company-skill-registry-and-binding — versioned Skill packages, project manifests, testing, and promotion from project retro.
2. company-platform-data-connectors — official authorization, export, and file-parser adapters for 视频号、抖音、小红书, with freshness and coverage states.
3. company-project-dashboard-and-reporting — normalized metric snapshots, consultation records, anomaly analysis, and report generation.
4. company-archive-and-offboarding — immutable project snapshots, account revocation, and reusable project templates.
