# Personal Project Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a personal “我的项目” workspace that binds existing local folders, keeps each project isolated, lets the existing “问问” retrieve project files plus the global knowledge base, and saves confirmed content outputs into a versioned project-only work area.

**Architecture:** Add a personal project registry and cached file index to the personal SQLite kernel. A project stores only a canonical server-side root path and metadata; the original folder remains the source of truth and is never copied. The existing assistant service gains a project scope and a separate project-tool set, while global brain tools remain read-only and company routes/runtime stay isolated.

**Tech Stack:** TypeScript 6, React 19, Fastify 5, better-sqlite3, Zod 4, pdfjs-dist, Electron 44, Vitest 4, Playwright 1.62.

---

## Scope and guardrails

The design spec is committed at docs/superpowers/specs/2026-09-21-personal-project-workspace-design.md (1bf553f). The checkout also contains unrelated untracked files under .superpowers/ and existing plans; preserve them and do not add them to feature commits.

The implementation must preserve these boundaries:

- rootPath is accepted only for a local authenticated scan request, canonicalized on the server, stored only in the personal registry, and never returned in project API payloads, assistant messages, source citations, or model prompts.
- A project read can use only the project selected by the route/session. No tool accepts an arbitrary absolute path or another projectId.
- Bound project roots may not overlap one another (neither project may contain the other); this prevents a broad project scan from silently including another client's folder.
- 02知识库/ remains the global source of truth. Project tools can retrieve it through the existing read service, but project tools cannot write there.
- Project writes create new files below AI工作区/ after an explicit confirmation. Existing source files, other project roots, and the global vault are never silently overwritten.
- Personal project routes and tools are composed only in the personal runtime. /api/company/*, CompanyAppShell, company authentication, and company staging/copy flows remain unchanged.
- 项目模式 is a context scope of the existing assistant, not a second model service. The first version has no required stage, node, client-background, or status form fields.

## File map

### New files

- src/shared/api/projects.ts — Zod contracts and public types for project summaries, scans, files, write plans, and project operations.
- src/server/db/migrations/021_personal_projects.sql — personal project registry, scan snapshots, indexed files, write plans, and operation records.
- src/server/projects/project-paths.ts — canonical root checks, protected-root checks, relative-path validation, and output-path resolution.
- src/server/projects/project-scanner.ts — deterministic folder traversal, ignore rules, SHA-256 manifests, Markdown/TXT/PDF text extraction, and parse-status reporting.
- src/server/projects/project-service.ts — registry CRUD, scan preview/bind, refresh/revision handling, file search/read, availability state, and project summaries.
- src/server/projects/project-write-plans.ts — server-owned output plan creation, stale checks, atomic exclusive writes, confirmation/cancellation, and operation receipts.
- src/server/assistant/project-tools.ts — project-only assistant tools (search_project_files, read_project_file, save_project_draft, propose_project_edit, refresh_project_index).
- src/server/assistant/tool-factory.ts — compose global, attachment, and project tools from one captured scope.
- src/server/assistant/types.ts — share a per-turn source-ID allocator between global and project tool factories.
- src/server/api/routes/projects.ts — personal project and project-write-plan HTTP routes.
- src/electron/project-selection.ts — testable folder-picker result normalization and busy/cancelled behavior.
- src/client/pages/ProjectsPage.tsx — project list and native-folder binding entry.
- src/client/pages/ProjectWorkspacePage.tsx — one-project workspace with files, outputs, synchronization, and project assistant context.
- src/client/components/projects/ProjectBindPreview.tsx — scan preview and optional display-name confirmation; no client-side project questionnaire.
- src/client/components/projects/ProjectFilesPanel.tsx — relative file search, parse-status display, and supported-file reader.
- src/client/components/projects/ProjectStatusCard.tsx — connection/revision/output-scope status presentation.
- src/client/components/assistant/AssistantProjectWriteCard.tsx — confirmation card for a project output plan.
- src/client/styles/projects.css — project list/workspace/status styles.

### Existing files to modify

- src/server/db/migrate.ts — register migration 21.
- src/server/start-server.ts — create/close the personal project service and write-plan service.
- src/server/app.ts — register personal project routes, pass project services to assistant composition, and keep company mode fail-closed.
- src/shared/api/assistant.ts — add project scope, project identity, and project-write action schema.
- src/shared/api/assistant-drafts.ts — persist project identity in local assistant drafts.
- src/server/assistant/history.ts — filter history by projectId and sign the project filter into cursors.
- src/server/assistant/draft-service.ts and src/server/api/routes/assistant-drafts.ts — persist and query project-scoped drafts without leaking them into the global draft list.
- src/server/assistant/service.ts — validate project identity/revision, compose project context, and refresh project actions.
- src/server/assistant/attachment-tools.ts and src/server/assistant/brain-tools.ts — accept the expanded scope without granting project tools global write access.
- src/shared/desktop/bridge.ts, src/electron/preload.ts, src/electron/main.ts — expose a native project-folder picker without changing vault switching.
- src/client/api/client.ts — add typed project and project-write-plan methods.
- src/client/app/AppShell.tsx, src/client/app/router.tsx — add the sidebar entry, routes, page identity, and project context passed to the single assistant panel.
- src/client/components/assistant/useAssistantDrafts.ts, assistantIntent.ts, AssistantPanel.tsx, AssistantMessageView.tsx — isolate project drafts/history, build project sends, show project scope, and render project citations/actions.
- src/client/components/assistant/AssistantActionPlanCard.tsx — share confirmation interaction behavior with project-output cards only where labels differ.
- src/server/services/operation-ledger.ts, src/server/api/routes/operations.ts, and the operation-page contract — include project output receipts without changing existing archive/extraction semantics.

### Tests to create or extend

- tests/unit/project-paths.test.ts
- tests/unit/project-scanner.test.ts
- tests/unit/project-write-plans.test.ts
- tests/unit/assistant-project-tools.test.ts
- tests/unit/project-selection.test.ts
- tests/integration/database-kernel.test.ts
- tests/integration/personal-project-service.test.ts
- tests/integration/personal-project-api.test.ts
- tests/integration/assistant-project-mode.test.ts
- tests/integration/project-isolation.test.ts
- tests/component/projects-page.test.tsx
- tests/component/project-workspace.test.tsx
- tests/component/assistant-panel.test.tsx
- tests/component/assistant-message-view.test.tsx
- tests/component/api-client.test.tsx
- tests/electron/personal-project-workspace.test.ts
- tests/electron/desktop-launch.test.ts (bridge-key regression)

---

## Shared contracts and interfaces

The following contracts are introduced in Task 1 and are the source of truth for later tasks:

~~~ts
export const projectAvailabilitySchema = z.enum([
  'ready',
  'scanning',
  'unavailable',
  'reconnect-required'
]);

export const projectParseStatusSchema = z.enum([
  'readable',
  'unsupported',
  'too-large',
  'failed'
]);

export const projectCategorySchema = z.enum([
  '选题评估',
  '内容草稿',
  '周计划',
  '复盘草稿',
  '工作日志'
]);
export type ProjectCategory = z.infer<typeof projectCategorySchema>;

export const projectRelativePathSchema = z.string().min(1).max(4096).refine(value => {
  const normalized = value.replaceAll('\\', '/');
  return !value.startsWith('/') &&
    !/^[A-Za-z]:\//u.test(normalized) &&
    !value.includes('\\') &&
    !normalized.split('/').includes('..') &&
    !/[\u0000-\u001f]/u.test(value);
}, 'PROJECT_PATH_INVALID');

export const projectSummarySchema = z.strictObject({
  id: z.uuid(),
  displayName: z.string().min(1).max(255),
  sourceRevision: z.number().int().nonnegative(),
  availability: projectAvailabilitySchema,
  outputRoot: z.literal('AI工作区'),
  fileCount: z.number().int().nonnegative(),
  readableFileCount: z.number().int().nonnegative(),
  issueCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastScannedAt: z.string().optional()
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const projectScanRequestSchema = z.strictObject({
  rootPath: z.string().min(1).max(4096)
});
export const projectBindRequestSchema = z.strictObject({
  scanId: z.uuid(),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  displayName: z.string().trim().min(1).max(255).optional()
});
export const projectReconnectRequestSchema = projectBindRequestSchema;
export const projectFileQuerySchema = z.strictObject({
  search: z.string().trim().max(200).optional(),
  origin: z.enum(['source', 'output']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});
export const projectFileReadQuerySchema = z.strictObject({
  path: projectRelativePathSchema
});
export const projectIdParamSchema = z.strictObject({
  id: z.uuid()
});
export interface ProjectScanPreview {
  readonly scanId: string;
  readonly displayName: string;
  readonly sourceSha256: string;
  readonly fileCount: number;
  readonly readableFileCount: number;
  readonly unsupportedCount: number;
  readonly ignoredCount: number;
  readonly issueCount: number;
  readonly guidanceFiles: readonly string[];
  readonly entries: readonly ProjectFile[];
  readonly issues: readonly string[];
  readonly expiresAt: string;
}
export interface ProjectFilePage {
  readonly items: readonly ProjectFile[];
  readonly total: number;
  readonly revision: number;
}
export interface ProjectContext {
  readonly id: string;
  readonly displayName: string;
  readonly sourceRevision: number;
  readonly availability: z.infer<typeof projectAvailabilitySchema>;
}
export interface ProjectOperation {
  readonly id: string;
  readonly projectId: string;
  readonly eventType: string;
  readonly targetPath: string;
  readonly oldSha256?: string;
  readonly newSha256?: string;
  readonly createdAt: string;
  readonly status: 'completed' | 'failed' | 'stale';
}
export type ProjectFile = z.infer<typeof projectFileSchema>;
export type ProjectFileDetail = z.infer<typeof projectFileDetailSchema>;
export type AssistantProjectWriteAction = z.infer<typeof projectWriteActionSchema>;
export type ProjectWriteAction = AssistantProjectWriteAction;

export interface ProjectService {
  scan(rootPath: string, signal?: AbortSignal): Promise<ProjectScanPreview>;
  bind(scanId: string, input: { sourceSha256: string; displayName?: string }): Promise<ProjectSummary>;
  reconnect(id: string, scanId: string, input: { sourceSha256: string; displayName?: string }): Promise<ProjectSummary>;
  list(): Promise<readonly ProjectSummary[]>;
  get(id: string): Promise<ProjectSummary>;
  refresh(id: string, signal?: AbortSignal): Promise<ProjectSummary>;
  ensureFresh(id: string, signal?: AbortSignal): Promise<ProjectSummary>;
  listFiles(id: string, query: { search?: string; origin?: 'source' | 'output'; limit?: number }): Promise<ProjectFilePage>;
  readFile(id: string, relativePath: string): Promise<ProjectFileDetail>;
  context(id: string): Promise<ProjectContext>;
}

export interface ProjectWritePlanService {
  proposeDraft(input: {
    projectId: string;
    conversationId: string;
    messageId: string;
    category: ProjectCategory;
    title: string;
    summary: string;
    content: string;
    expectedRevision: number;
  }): Promise<AssistantProjectWriteAction>;
  confirm(planId: string, conversationId: string, clientRequestId: string): Promise<AssistantProjectWriteAction>;
  cancel(planId: string, conversationId: string, clientRequestId: string): AssistantProjectWriteAction;
  project(planId: string, conversationId?: string): AssistantProjectWriteAction | undefined;
  operations(projectId: string): Promise<readonly ProjectOperation[]>;
}
~~~

The implementation must keep these names and field meanings consistent across server, shared schemas, client API, and tests.

## Task 1: Establish personal project contracts and migration 21

**Files:**

- Create: src/shared/api/projects.ts
- Create: src/server/db/migrations/021_personal_projects.sql
- Modify: src/server/db/migrate.ts
- Modify: src/shared/api/assistant.ts
- Modify: src/shared/api/assistant-drafts.ts
- Modify: src/server/assistant/draft-service.ts
- Modify: src/server/api/routes/assistant-drafts.ts
- Test: tests/integration/database-kernel.test.ts
- Test: tests/integration/assistant-api.test.ts

- [ ] **Step 1: Write failing schema and migration assertions**

Add tests that parse a valid project summary/scan/file/write-action object, reject an absolute path in a public file payload, verify project-scoped draft/history fields, and assert that a fresh SQLite kernel contains these tables:

~~~text
personal_projects
personal_project_scan_runs
personal_project_files
personal_project_write_plans
personal_project_operations
~~~

Also assert that the existing migration list remains intact and gains version 21 exactly once.

Run:

~~~bash
npm run test:integration -- tests/integration/database-kernel.test.ts tests/integration/assistant-api.test.ts
~~~

Expected: FAIL because the shared project contracts and migration 21 are absent.

- [ ] **Step 2: Add public project schemas without absolute paths**

Create src/shared/api/projects.ts with the schemas from the shared-contract section plus:

~~~ts
export const projectFileSchema = z.strictObject({
  relativePath: projectRelativePathSchema,
  kind: z.enum(['file', 'directory']),
  bytes: z.number().int().nonnegative().optional(),
  modifiedAt: z.string().optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  parseStatus: projectParseStatusSchema.optional(),
  problem: z.string().max(1000).optional(),
  origin: z.enum(['source', 'output']).optional()
});

export const projectFileDetailSchema = projectFileSchema.extend({
  content: z.string().optional(),
  totalCharacters: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional()
});

export const projectScanPreviewSchema = z.strictObject({
  scanId: z.uuid(),
  displayName: z.string().min(1).max(255),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  fileCount: z.number().int().nonnegative(),
  readableFileCount: z.number().int().nonnegative(),
  unsupportedCount: z.number().int().nonnegative(),
  ignoredCount: z.number().int().nonnegative(),
  issueCount: z.number().int().nonnegative(),
  guidanceFiles: z.array(z.string().min(1).max(4096)).max(20),
  entries: z.array(projectFileSchema).max(20_000),
  issues: z.array(z.string().max(1000)).max(200),
  expiresAt: z.string()
});

export const projectWriteActionSchema = z.strictObject({
  id: z.uuid(),
  type: z.literal('project-write'),
  label: z.string().min(1).max(120),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'stale']),
  projectId: z.uuid(),
  projectName: z.string().min(1).max(255),
  category: projectCategorySchema,
  targetPath: projectRelativePathSchema,
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  sourceRevision: z.number().int().nonnegative(),
  summary: z.string().max(2000),
  createdAt: z.string(),
  expiresAt: z.string(),
  resultPath: projectRelativePathSchema.optional(),
  problem: z.string().max(2000).optional()
});

export const projectOperationSchema = z.strictObject({
  id: z.uuid(),
  projectId: z.uuid(),
  eventType: z.string().min(1).max(120),
  targetPath: projectRelativePathSchema,
  oldSha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  newSha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  createdAt: z.string(),
  status: z.enum(['completed', 'failed', 'stale'])
});

export const projectFileResponseSchema = successEnvelopeSchema(projectFileDetailSchema);
export const projectScanPreviewResponseSchema = successEnvelopeSchema(projectScanPreviewSchema);
export const projectSummaryResponseSchema = successEnvelopeSchema(projectSummarySchema);
export const projectListResponseSchema = successEnvelopeSchema(z.object({
  projects: z.array(projectSummarySchema)
}));
export const projectFilePageSchema = z.object({
  items: z.array(projectFileSchema),
  total: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative()
});
export const projectFilePageResponseSchema = successEnvelopeSchema(projectFilePageSchema);
export const projectOperationsResponseSchema = successEnvelopeSchema(z.object({
  operations: z.array(projectOperationSchema)
}));
~~~

Export the inferred ProjectSummary, ProjectScanPreview, ProjectFile, ProjectFileDetail, ProjectWriteAction, ProjectOperation, and ProjectCategory types; use the shared aliases in all route/client signatures rather than duplicating response shapes.

- [ ] **Step 3: Add migration 21**

Create src/server/db/migrations/021_personal_projects.sql with the following shape. Keep absolute paths in the private database only; content_text is a bounded cache and is never the source of truth.

~~~sql
CREATE TABLE personal_projects (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  source_revision INTEGER NOT NULL DEFAULT 0 CHECK (source_revision >= 0),
  source_sha256 TEXT NOT NULL CHECK (
    length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  availability TEXT NOT NULL CHECK (availability IN ('ready', 'scanning', 'unavailable', 'reconnect-required')),
  output_root TEXT NOT NULL DEFAULT 'AI工作区' CHECK (output_root = 'AI工作区'),
  write_policy TEXT NOT NULL DEFAULT 'new-output-confirmed' CHECK (write_policy = 'new-output-confirmed'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_scanned_at TEXT
);

CREATE TABLE personal_project_scan_runs (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (
    length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('scanning', 'proposed', 'confirmed', 'failed', 'superseded')),
  proposal_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE personal_project_files (
  project_id TEXT NOT NULL REFERENCES personal_projects(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'directory')),
  bytes INTEGER,
  modified_at TEXT,
  sha256 TEXT CHECK (
    sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  parse_status TEXT CHECK (parse_status IN ('readable', 'unsupported', 'too-large', 'failed')),
  parse_problem TEXT,
  content_text TEXT,
  origin TEXT NOT NULL DEFAULT 'source' CHECK (origin IN ('source', 'output')),
  indexed_revision INTEGER NOT NULL CHECK (indexed_revision >= 0),
  PRIMARY KEY (project_id, relative_path)
);
CREATE INDEX personal_project_files_search_idx ON personal_project_files(project_id, parse_status, origin);

CREATE TABLE personal_project_write_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES personal_projects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('选题评估', '内容草稿', '周计划', '复盘草稿', '工作日志')),
  title TEXT NOT NULL CHECK (length(title) > 0),
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
  target_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'stale')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirm_request_id TEXT UNIQUE,
  result_path TEXT,
  problem TEXT
);
CREATE INDEX personal_project_write_plans_project_idx ON personal_project_write_plans(project_id, created_at);

CREATE TABLE personal_project_operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES personal_projects(id) ON DELETE CASCADE,
  plan_id TEXT REFERENCES personal_project_write_plans(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  target_path TEXT NOT NULL,
  old_sha256 TEXT CHECK (
    old_sha256 IS NULL OR (length(old_sha256) = 64 AND old_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  new_sha256 TEXT CHECK (
    new_sha256 IS NULL OR (length(new_sha256) = 64 AND new_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX personal_project_operations_project_idx ON personal_project_operations(project_id, created_at);
~~~

- [ ] **Step 4: Register version 21 and extend assistant identity schemas**

Append the version 21 migration after version 20. Extend assistant scopes and drafts as follows:

~~~ts
const assistantScopeSchema = z.enum(['brain', 'current', 'project']);

// assistantMessageSchema and assistantConversationSchema
scope: assistantScopeSchema;
projectId: z.uuid().optional();
projectRevision: z.number().int().nonnegative().optional();

// assistantSendSchema
scope: assistantScopeSchema,
projectId: z.uuid().optional(),
projectRevision: z.number().int().nonnegative().optional(),
~~~

Add the same superRefine rule to assistantMessageSchema, assistantConversationSchema, assistantSendSchema, and assistantDraftFieldsSchema: project scope requires both project fields and forbids contextPath; non-project scopes forbid projectId and projectRevision. Add projectWriteActionSchema to assistantActionSchema. Extend assistantHistoryQuerySchema with optional projectId: z.uuid() so project history can be filtered without exposing a free-form path, and add:

~~~ts
export const assistantDraftQuerySchema = z.strictObject({
  projectId: z.uuid().optional()
});
~~~
Add assistantDraftQuerySchema with optional projectId. The draft persistence route must additionally verify a projectId against the personal project registry when scope=project, and draft listing must filter by the requested project identity; a list request without projectId returns only non-project drafts. It must never accept or persist a root path. Thread this query through draft-service, assistant-drafts routes, and the browser client.

- [ ] **Step 5: Run the contract tests and update migration expectations**

Run:

~~~bash
npm run test:integration -- tests/integration/database-kernel.test.ts tests/integration/assistant-api.test.ts
npm run typecheck
~~~

Expected: PASS, with existing brain/current payloads still accepted and project payloads requiring the new identity fields.

- [ ] **Step 6: Commit the contracts**

~~~bash
git add src/shared/api/projects.ts src/server/db/migrations/021_personal_projects.sql src/server/db/migrate.ts src/shared/api/assistant.ts src/shared/api/assistant-drafts.ts src/server/assistant/draft-service.ts src/server/api/routes/assistant-drafts.ts tests/integration/database-kernel.test.ts tests/integration/assistant-api.test.ts
git commit -m "feat: add personal project contracts and storage"
~~~

## Task 2: Add canonical project paths and deterministic scanning

**Files:**

- Create: src/server/projects/project-paths.ts
- Create: src/server/projects/project-scanner.ts
- Test: tests/unit/project-paths.test.ts
- Test: tests/unit/project-scanner.test.ts

- [ ] **Step 1: Write path-security tests**

Use temporary real directories and symlinks to assert:

~~~ts
await expect(canonicalProjectRoot(root, { protectedRoots: [vault] })).resolves.toBe(await realpath(root));
await expect(canonicalProjectRoot(vault, { protectedRoots: [vault] })).rejects.toThrow('PROJECT_ROOT_PROTECTED');
expect(() => assertProjectRelativePath('../outside.md')).toThrow('PROJECT_PATH_INVALID');
expect(() => assertProjectRelativePath('/absolute.md')).toThrow('PROJECT_PATH_INVALID');
expect(() => assertProjectRelativePath('a\\\\b.md')).toThrow('PROJECT_PATH_INVALID');
expect(() => assertProjectRelativePath('a\\0b.md')).toThrow('PROJECT_PATH_INVALID');
await expect(canonicalProjectRoot(symlink, { protectedRoots: [] })).rejects.toThrow('PROJECT_ROOT_SYMLINK');
~~~

Also assert that resolveProjectPath(realRoot, 'notes/a.md') stays contained, while resolveProjectPath(realRoot, '../../etc/passwd') throws before filesystem access.

- [ ] **Step 2: Run the path tests to verify failure**

Run:

~~~bash
npm run test:unit -- tests/unit/project-paths.test.ts
~~~

Expected: FAIL because the path module does not exist.

- [ ] **Step 3: Implement the path module**

Export these exact functions:

~~~ts
export async function canonicalProjectRoot(
  selectedPath: string,
  input: { protectedRoots: readonly string[] }
): Promise<string>;
export function assertProjectRelativePath(value: string): string;
export function resolveProjectPath(root: string, relativePath: string): string;
export function resolveProjectOutputPath(root: string, category: ProjectCategory, filename: string): string;
~~~

canonicalProjectRoot must use lstat before realpath, reject symlink roots and non-directories, resolve every protected root, reject equality or containment in either direction, and return only the canonical absolute root. resolveProjectPath must normalize separators to slash, reject parent traversal/NUL/control characters/absolute paths, join the root, and verify lexical containment. resolveProjectOutputPath must call the same validator and allow only AI工作区/category/filename.

- [ ] **Step 4: Write scanner tests for supported and unsupported files**

Create a temporary tree containing Markdown, UTF-8 TXT, a text-layer PDF from tests/helpers/pdf-fixture.ts, an image, .git, node_modules, a symlink, and a file larger than the configured text limit. Assert:

~~~ts
const result = await scanProjectFolder(root, { signal: new AbortController().signal });
expect(result.entries.map(item => item.relativePath)).not.toContain('.git/config');
expect(result.entries.map(item => item.relativePath)).not.toContain('node_modules/pkg.js');
expect(result.entries.find(item => item.relativePath === 'brief.md')?.parseStatus).toBe('readable');
expect(result.entries.find(item => item.relativePath === 'brief.md')?.content).toContain('获客');
expect(result.entries.find(item => item.relativePath === 'deck.pdf')?.content).toContain('PDF_EVIDENCE');
expect(result.entries.find(item => item.relativePath === 'logo.png')?.parseStatus).toBe('unsupported');
expect(result.issues.some(item => item.includes('symlink'))).toBe(true);
expect(result.ignoredCount).toBeGreaterThanOrEqual(2);
expect(result.sourceSha256).toMatch(/^[0-9a-f]{64}$/u);
~~~

The scanner must keep readable entries when another file fails. A changed file during the second pass must reject the scan with PROJECT_SOURCE_CHANGED.

- [ ] **Step 5: Run the scanner tests to verify failure**

Run:

~~~bash
npm run test:unit -- tests/unit/project-scanner.test.ts
~~~

Expected: FAIL because the scanner module does not exist.

- [ ] **Step 6: Implement the scanner**

Export:

~~~ts
export interface ProjectScanEntry {
  readonly relativePath: string;
  readonly kind: 'file' | 'directory';
  readonly bytes?: number;
  readonly modifiedAt?: string;
  readonly sha256?: string;
  readonly parseStatus?: 'readable' | 'unsupported' | 'too-large' | 'failed';
  readonly problem?: string;
  readonly content?: string;
  readonly origin: 'source' | 'output';
}

export interface ProjectScanResult {
  readonly sourceRoot: string;
  readonly sourceSha256: string;
  readonly suggestedName: string;
  readonly ignoredCount: number;
  readonly entries: readonly ProjectScanEntry[];
  readonly issues: readonly string[];
}

export function scanProjectFolder(
  selectedPath: string,
  input?: { signal?: AbortSignal; protectedRoots?: readonly string[]; maxIndexedBytes?: number }
): Promise<ProjectScanResult>;
~~~

Traverse in stable lexical order with lstat, skip .git, .hg, .svn, node_modules, and system, reject symlinks without aborting unrelated files, and hash every regular file. Use parseAttachment(bytes, mediaType, signal) for .md, .txt, and .pdf; retain only bounded text in content, and record parser problems for encrypted/scan-only/invalid PDFs. Hash the sorted manifest (path, kind, size, modified time, file hash, parse status) to produce sourceSha256. Do a second stat/hash check before returning so a concurrent source change is explicit.

- [ ] **Step 7: Run unit tests and commit the scanner**

Run:

~~~bash
npm run test:unit -- tests/unit/project-paths.test.ts tests/unit/project-scanner.test.ts
npm run typecheck
~~~

Expected: PASS.

~~~bash
git add src/server/projects/project-paths.ts src/server/projects/project-scanner.ts tests/unit/project-paths.test.ts tests/unit/project-scanner.test.ts
git commit -m "feat: add safe personal project scanning"
~~~

## Task 3: Build the personal project registry, index, and refresh service

**Files:**

- Create: src/server/projects/project-service.ts
- Test: tests/integration/personal-project-service.test.ts
- Modify: tests/integration/database-kernel.test.ts

- [ ] **Step 1: Write service lifecycle tests**

Use a temporary protected vault and project root plus an in-memory migrated database. Cover the complete registry lifecycle:

~~~ts
const preview = await service.scan(projectRoot);
const project = await service.bind(preview.scanId, { sourceSha256: preview.sourceSha256 });
expect(project.displayName).toBe('client-a');
expect(project.sourceRevision).toBe(1);
expect((await service.listFiles(project.id, { search: '获客' })).items[0]!.relativePath).toBe('brief.md');
await writeFile(join(projectRoot, 'brief.md'), '# 更新后的获客策略');
const refreshed = await service.refresh(project.id);
expect(refreshed.sourceRevision).toBe(2);
expect((await service.readFile(project.id, 'brief.md')).content).toContain('更新后的');
~~~

Add tests for duplicate or overlapping canonical roots, a moved/missing root becoming reconnect-required, reconnecting that project to a newly selected folder without changing its project ID or conversation history, a single unreadable file leaving other files searchable, stale scan confirmation, lazy freshness detection after an external edit, and a project-root path nested inside the global vault being rejected.

- [ ] **Step 2: Run the service tests to verify failure**

Run:

~~~bash
npm run test:integration -- tests/integration/personal-project-service.test.ts
~~~

Expected: FAIL because createProjectService is absent.

- [ ] **Step 3: Implement the registry and private projections**

Export:

~~~ts
export function createProjectService(input: {
  database: Database.Database;
  vaultRoot: string;
  stateRoot: string;
  now?: () => Date;
  scan?: typeof scanProjectFolder;
  idFactory?: () => string;
}): ProjectService & { close(): Promise<void> };
~~~

The service must:

1. canonicalize and protect the selected root before inserting a scan row;
2. store the complete scan proposal (including the private canonical root) only in personal_project_scan_runs;
3. return a projection stripped of root_path;
4. on bind, re-scan the canonical root and compare sourceSha256 before inserting personal_projects;
5. reject a bind when its canonical root equals, contains, or is contained by any existing project root; perform this overlap check together with scan-run confirmation in a serialized transaction so concurrent binds cannot create overlapping projects;
6. insert file entries in one immediate SQLite transaction and set source_revision = 1;
7. rank listFiles by query-token matches in path/title/content, then by relative path, while enforcing a bounded result count;
8. revalidate canonical containment and lstat on every readFile;
9. set availability = reconnect-required when the root is absent, replaced by a symlink, or no longer resolves to the stored canonical root;
10. set availability = ready only after a complete consistent refresh; failed refreshes preserve the prior file index and record the failure state, while deleted files are removed from the replacement index;
11. expose ensureFresh as a throttled, on-demand stat/manifest check used when entering a workspace or starting a project turn; it may trigger the same serialized refresh but never runs an unbounded watcher;
12. treat AI工作区/ entries as origin = output and all other entries as origin = source.

Normalize nullable SQLite timestamps to omitted optional fields in every public projection; never leak null/private column names through Zod parsing or error objects.

Add reconnect(id, scanId, input) to the same service. It must validate the scan proposal and selected canonical root, exclude the current project itself from the overlap check, replace the stored root/index in one transaction, increment sourceRevision, mark all pending write plans for that project stale, and preserve the project ID, display name (unless explicitly changed), operations, drafts, and conversation history.

readFile must return parsed content only for readable entries; unsupported/too-large/failed files return metadata plus a stable public problem. It must never return an absolute path.

- [ ] **Step 4: Add revision and availability assertions**

Extend the integration test to verify that a project response contains only:

~~~text
id, displayName, sourceRevision, availability, outputRoot, fileCount,
readableFileCount, issueCount, createdAt, updatedAt, lastScannedAt
~~~

Assert that root_path, scan proposal JSON, and private content cache are absent from serialized HTTP-facing projections. Assert that refreshes are serialized per project so two concurrent refresh calls cannot publish mixed revisions.

- [ ] **Step 5: Run service tests and commit**

Run:

~~~bash
npm run test:integration -- tests/integration/personal-project-service.test.ts tests/integration/database-kernel.test.ts
npm run typecheck
~~~

Expected: PASS.

~~~bash
git add src/server/projects/project-service.ts tests/integration/personal-project-service.test.ts tests/integration/database-kernel.test.ts
git commit -m "feat: add personal project registry and index"
~~~

## Task 4: Expose the personal project API and typed browser client

**Files:**

- Create: src/server/api/routes/projects.ts
- Modify: src/server/app.ts
- Modify: src/client/api/client.ts
- Test: tests/integration/personal-project-api.test.ts
- Test: tests/component/api-client.test.tsx

- [ ] **Step 1: Write route contract tests**

Build a personal Fastify fixture with a migrated in-memory database, a temporary vault root, and a real project fixture. Obtain the existing bootstrap cookie/CSRF headers, then assert the following route contract:

~~~ts
POST /api/v1/projects/scan
  body: { rootPath }
  response: { data: ProjectScanPreview }

POST /api/v1/projects
  body: { scanId, sourceSha256, displayName? }
  response: { data: ProjectSummary }
POST /api/v1/projects/:id/reconnect
  body: { scanId, sourceSha256, displayName? }
  response: { data: ProjectSummary }

GET /api/v1/projects
GET /api/v1/projects/:id
POST /api/v1/projects/:id/refresh
GET /api/v1/projects/:id/files?search=...
GET /api/v1/projects/:id/file?path=brief.md
~~~

Assert that the scan and bind responses never contain rootPath, proposal_json, or content_text. Assert that missing IDs return 404, invalid relative paths return 400, mutations without the CSRF header return 403, and a company-mode server returns 404 for every personal project route.

Run:

~~~bash
npm run test:integration -- tests/integration/personal-project-api.test.ts
~~~

Expected: FAIL because the project routes and client contracts are absent.

- [ ] **Step 2: Add route schemas and handlers**

In src/server/api/routes/projects.ts, parse every request with the shared schemas (including projectIdParamSchema for every :id route and projectReconnectRequestSchema for the reconnect body) and return the existing API envelope/version. Register these handlers:

~~~ts
app.post('/api/v1/projects/scan', async request =>
  service.scan(parseApiInput(projectScanRequestSchema, request.body).rootPath)
);
app.post('/api/v1/projects', async request =>
  service.bind(body.scanId, { sourceSha256: body.sourceSha256, ...(body.displayName ? { displayName: body.displayName } : {}) })
);
app.post('/api/v1/projects/:id/reconnect', async request =>
  service.reconnect(params.id, body.scanId, { sourceSha256: body.sourceSha256, ...(body.displayName ? { displayName: body.displayName } : {}) })
);
app.get('/api/v1/projects', async () => service.list());
app.get('/api/v1/projects/:id', async request => service.get(params.id));
app.post('/api/v1/projects/:id/refresh', async request => service.refresh(params.id));
app.get('/api/v1/projects/:id/files', async request => service.listFiles(params.id, query));
app.get('/api/v1/projects/:id/file', async request => service.readFile(params.id, projectFileReadQuerySchema.parse(query).path));
~~~

Parse the files query with projectFileQuerySchema (including the optional origin filter) and the single-file query with projectFileReadQuerySchema. Use a required-service helper that returns PROJECTS_UNAVAILABLE (503) when the personal service is not composed. Set cache-control no-store on every project response. The scan request may receive an absolute path from the trusted local renderer, but the response must use the public preview projection only.

- [ ] **Step 3: Register routes only in the personal composition**

Add a projectService optional dependency to BuildServerOptions. In personal runtime register registerProjectRoutes(app, projectService) beside the personal routes; its required-service helper returns 503 when the personal service is unavailable. Do not register or expose the routes through createCompanyRuntime at all. Keep the existing app onRequest/company namespace guard so a company process still returns 404 for /api/v1/projects.

- [ ] **Step 4: Add the browser API methods**

Import the project response schemas and add this property to ReadConsoleApi:

~~~ts
readonly projects?: {
  scan(rootPath: string): Promise<ApiClientResult<ProjectScanPreview>>;
  bind(input: { scanId: string; sourceSha256: string; displayName?: string }): Promise<ApiClientResult<ProjectSummary>>;
  reconnect(id: string, input: { scanId: string; sourceSha256: string; displayName?: string }): Promise<ApiClientResult<ProjectSummary>>;
  list(signal?: AbortSignal): Promise<ApiClientResult<{ projects: ProjectSummary[] }>>;
  get(id: string, signal?: AbortSignal): Promise<ApiClientResult<ProjectSummary>>;
  refresh(id: string): Promise<ApiClientResult<ProjectSummary>>;
  files(id: string, query: { search?: string; origin?: 'source' | 'output'; limit?: number }, signal?: AbortSignal): Promise<ApiClientResult<ProjectFilePage>>;
  file(id: string, relativePath: string, signal?: AbortSignal): Promise<ApiClientResult<ProjectFileDetail>>;
  operations(id: string, signal?: AbortSignal): Promise<ApiClientResult<{ operations: ProjectOperation[] }>>;
  confirmWritePlan(projectId: string, planId: string, clientRequestId: string): Promise<ApiClientResult<AssistantConversation>>;
  cancelWritePlan(projectId: string, planId: string, clientRequestId: string): Promise<ApiClientResult<AssistantConversation>>;
};
~~~

Use postWithCsrf for scan, bind, reconnect, refresh, and write-plan confirmation; use requestData for reads. Encode all project IDs and relative paths with encodeURIComponent, and pass the existing idempotency key for confirmation. Extend assistantDrafts.list to accept an optional projectId query and use the non-project default when omitted.

- [ ] **Step 5: Run API/client tests and commit**

Run:

~~~bash
npm run test:integration -- tests/integration/personal-project-api.test.ts
npm run test:component -- tests/component/api-client.test.tsx
npm run typecheck
~~~

Expected: PASS.

~~~bash
git add src/server/api/routes/projects.ts src/server/app.ts src/client/api/client.ts tests/integration/personal-project-api.test.ts tests/component/api-client.test.tsx
git commit -m "feat: expose personal project API"
~~~

## Task 5: Add the native folder picker and project list/workspace routes

**Files:**

- Create: src/electron/project-selection.ts
- Create: src/client/pages/ProjectsPage.tsx
- Create: src/client/pages/ProjectWorkspacePage.tsx
- Create: src/client/components/projects/ProjectBindPreview.tsx
- Create: src/client/components/projects/ProjectFilesPanel.tsx
- Create: src/client/components/projects/ProjectStatusCard.tsx
- Create: src/client/styles/projects.css
- Modify: src/shared/desktop/bridge.ts
- Modify: src/electron/preload.ts
- Modify: src/electron/main.ts
- Modify: src/client/app/AppShell.tsx
- Modify: src/client/app/router.tsx
- Test: tests/unit/project-selection.test.ts
- Test: tests/component/projects-page.test.tsx
- Test: tests/component/project-workspace.test.tsx
- Test: tests/electron/desktop-launch.test.ts

- [ ] **Step 1: Write picker and UI tests**

Add pure picker tests for cancel, busy, and selected results:

~~~ts
await expect(normalizeProjectSelection({ canceled: true, filePaths: [] })).resolves.toEqual({ selected: false, reason: 'cancelled' });
await expect(normalizeProjectSelection({ canceled: false, filePaths: [root] })).resolves.toMatchObject({ selected: true, path: root, displayName: basename(root) });
~~~

In the component tests, mock window.xiaozhaoDesktop.chooseProjectDirectory and the project API. Assert that clicking 添加项目 invokes the native picker, displays scan counts, allows only an optional display-name change, and binds without asking for client background/stage/goal fields. Assert that the workspace renders:

~~~text
项目语料：已连接
全局知识库：可检索
写入范围：A项目 / AI工作区
~~~

Extend desktop-launch bridge expectations with chooseProjectDirectory. Add a workspace test that a reconnect-required project opens the picker/scan preview, calls projects.reconnect, keeps the same project ID and visible conversation, and marks a pre-existing pending write plan stale.

- [ ] **Step 2: Implement the isolated picker helper and bridge type**

Define in src/shared/desktop/bridge.ts:

~~~ts
export interface DesktopProjectDirectorySelection {
  readonly selected: boolean;
  readonly path?: string;
  readonly displayName?: string;
  readonly reason?: 'cancelled' | 'busy' | 'unavailable';
}

export interface XiaozhaoDesktopApi {
  chooseProjectDirectory?(): Promise<DesktopProjectDirectorySelection>;
  // existing members remain unchanged
}
~~~

Create src/electron/project-selection.ts with:

~~~ts
export async function chooseProjectDirectory(input: {
  busy: boolean;
  chooseDirectory: () => Promise<string | undefined>;
  validateDirectory: (path: string) => Promise<string>;
}): Promise<DesktopProjectDirectorySelection>;
~~~

Return busy before invoking the dialog, return cancelled for no path, validate that the selected path is a real directory, and return the canonical path plus basename. Do not save settings, restart Electron, or copy files.

- [ ] **Step 3: Add the Electron IPC handler**

Expose chooseProjectDirectory in preload.ts. In main.ts, add a separate projectChoosing flag and handler:

~~~ts
ipcMain.handle('desktop:choose-project-directory', async event => {
  assertMainSender(event);
  if (projectChoosing) return { selected: false, reason: 'busy' };
  projectChoosing = true;
  try {
    const selected = await chooseProjectDirectory({
      busy: false,
      chooseDirectory: async () => {
        if (process.env.NODE_ENV === 'test' && process.env.XIAOZHAO_TEST_PROJECT_ROOT) {
          return process.env.XIAOZHAO_TEST_PROJECT_ROOT;
        }
        const result = await dialog.showOpenDialog({ title: '选择项目文件夹', properties: ['openDirectory'] });
        return result.canceled ? undefined : result.filePaths[0];
      },
      validateDirectory: value => validateProjectSelection(value, [settings.vaultRoot, userDataDir])
    });
    return selected;
  } finally {
    projectChoosing = false;
  }
});
~~~

Add this pure main-process helper in src/electron/project-selection.ts and call it from the handler:

~~~ts
import { canonicalProjectRoot } from '../server/projects/project-paths.js';

export async function validateProjectSelection(
  selectedPath: string,
  protectedRoots: readonly string[]
): Promise<string> {
  return canonicalProjectRoot(selectedPath, { protectedRoots });
}
~~~

Keep project-paths.ts dependency-free apart from Node path/fs primitives (and type-only shared imports) so this validation helper is safe to bundle into the Electron main process; it must not import server startup state or database modules.

validateProjectSelection must reject the personal vault itself, a path contained by the vault, a path containing the vault, the app-data directory, and symlink roots. The test-only environment variable is read only in NODE_ENV=test and never changes production picker behavior.

- [ ] **Step 4: Add project navigation and page components**

Add FolderKanban to the personal NAVIGATION list in AppShell.tsx:

~~~ts
{ to: '/projects', label: '我的项目', icon: FolderKanban, end: false }
~~~

Add routes in router.tsx:

~~~tsx
<Route path="projects" element={<ProjectsPage />} />
<Route path="projects/:id" element={<ProjectWorkspacePage />} />
~~~

ProjectsPage loads api.projects.list, calls the bridge picker, calls projects.scan, renders ProjectBindPreview, and calls projects.bind before navigating to /projects/:id. ProjectBindPreview must show file/readable/unsupported/ignored/issue counts and the optional display-name input whose default is the folder name. ProjectWorkspacePage loads one summary, ProjectFilesPanel, and project outputs from files with origin=output; its refresh button calls projects.refresh and reports reconnect-required without dropping the page or conversation history. When status is reconnect-required, ProjectStatusCard offers 重新连接: the same picker/scan preview flow calls projects.reconnect, preserving the project ID and existing conversation/drafts while invalidating stale write plans.

Import projects.css from the personal shell or the pages and use existing instrument-panel/page-state patterns. Keep the assistant mounted once in AppShell; do not instantiate a second model client in the page.

- [ ] **Step 5: Run UI and Electron picker tests**

Run:

~~~bash
npm run test:unit -- tests/unit/project-selection.test.ts
npm run test:component -- tests/component/projects-page.test.tsx tests/component/project-workspace.test.tsx
npm run test:electron -- tests/electron/desktop-launch.test.ts
~~~

Expected: PASS; the bridge list now includes chooseProjectDirectory and the existing vault picker behavior is unchanged.

- [ ] **Step 6: Commit the picker and navigation**

~~~bash
git add src/electron/project-selection.ts src/shared/desktop/bridge.ts src/electron/preload.ts src/electron/main.ts src/client/app/AppShell.tsx src/client/app/router.tsx src/client/pages/ProjectsPage.tsx src/client/pages/ProjectWorkspacePage.tsx src/client/components/projects src/client/styles/projects.css tests/unit/project-selection.test.ts tests/component/projects-page.test.tsx tests/component/project-workspace.test.tsx tests/electron/desktop-launch.test.ts
git commit -m "feat: add personal project binding and workspace pages"
~~~

## Task 6: Add confirmed project outputs and operation receipts

**Files:**

- Create: src/server/projects/project-write-plans.ts
- Create: src/client/components/assistant/AssistantProjectWriteCard.tsx
- Modify: src/server/api/routes/projects.ts
- Modify: src/client/api/client.ts
- Modify: src/server/services/operation-ledger.ts
- Modify: src/client/components/assistant/AssistantActionPlanCard.tsx
- Modify: src/client/components/assistant/AssistantMessageView.tsx
- Test: tests/unit/project-write-plans.test.ts
- Test: tests/integration/personal-project-api.test.ts
- Test: tests/component/assistant-message-view.test.tsx

- [ ] **Step 1: Write write-plan security tests**

Use a bound temporary project and assert:

~~~ts
const action = await plans.proposeDraft({
  projectId, conversationId, messageId, category: '周计划',
  title: '下周获客内容', summary: '保存周计划草稿',
  content: '# 下周获客内容', expectedRevision: 1
});
expect(action.status).toBe('pending');
expect(action.targetPath).toMatch(/^AI工作区\/周计划\//u);
await expect(readFile(join(projectRoot, action.targetPath))).rejects.toThrow();

const completed = await plans.confirm(action.id, conversationId, randomUUID());
expect(completed.status).toBe('completed');
expect(await readFile(join(projectRoot, completed.resultPath!),'utf8')).toContain('下周获客内容');
~~~

Add tests that source revision changes make confirmation stale, an existing target never gets overwritten, duplicate confirm requests return the same receipt, cancel creates no file, a category/path traversal input is rejected, and the operation row stores only relative paths and hashes.

- [ ] **Step 2: Run the write-plan tests to verify failure**

Run:

~~~bash
npm run test:unit -- tests/unit/project-write-plans.test.ts
~~~

Expected: FAIL because the write-plan service is absent.

- [ ] **Step 3: Implement proposal and atomic confirmation**

Export createProjectWritePlanService with the ProjectWritePlanService interface. Generate a server-owned target path:

~~~ts
const filename = dateStamp + '-' + safeSlug(input.title) + '.md';
const targetPath = 'AI工作区/' + input.category + '/' + filename;
~~~

safeSlug must retain only bounded Unicode letters/numbers, spaces, hyphens, and underscores; an empty result becomes 内容草稿. The service must:

1. verify the project is ready and expectedRevision equals sourceRevision;
2. cap content at 160,000 UTF-8 bytes;
3. persist the private content and expected revision in personal_project_write_plans;
4. return a public project-write action without content or absolute paths;
5. on confirmation, re-read project state and reject stale revisions;
6. create AI工作区/category with mode 0700, reject symlink parents, open the target with exclusive creation, write through a temporary file, fsync/rename, and hash the final bytes;
7. record a personal_project_operations row with operation ID, relative target, oldSha256 null, newSha256, and status payload;
8. update the plan status/result atomically and return the refreshed action;
9. mark unknown write failures as failed with a recoverable operation record rather than claiming success.

The service must not expose a delete/overwrite primitive to the assistant. Existing files cause PROJECT_OUTPUT_EXISTS and leave the plan stale.

- [ ] **Step 4: Add project write-plan routes and client methods**

Add:

~~~text
POST /api/v1/projects/:projectId/write-plans/:planId/confirm
POST /api/v1/projects/:projectId/write-plans/:planId/cancel
GET  /api/v1/projects/:projectId/operations
~~~

Each mutation requires the existing CSRF/session hook and a strict body containing only clientRequestId. The route loads the plan's private conversationId server-side, verifies the URL project ID matches the stored plan before delegating, and never accepts a conversationId or target path from the client. Add projects.confirmWritePlan, projects.cancelWritePlan, and projects.operations to ReadConsoleApi.

- [ ] **Step 5: Render and ledger project operations**

Render project-write actions in AssistantMessageView with AssistantProjectWriteCard. The card must say “尚未写入项目”, show project name/category/relative target/source revision, require a confirmation dialog, and call the dedicated project route. Do not reuse archive wording or show source absolute paths.

Extend the operation record schema and createOperationLedger input with an optional project operation reader. Project records use bucket history/attention, status labels 已保存/写入未完成/计划已失效, relative paths, and a link back to /projects/:id. Existing archive/extraction records and tests must remain byte-for-byte compatible.

- [ ] **Step 6: Run tests and commit**

Run:

~~~bash
npm run test:unit -- tests/unit/project-write-plans.test.ts
npm run test:integration -- tests/integration/personal-project-api.test.ts
npm run test:component -- tests/component/assistant-message-view.test.tsx
npm run typecheck
~~~

Expected: PASS.

~~~bash
git add src/server/projects/project-write-plans.ts src/server/api/routes/projects.ts src/client/api/client.ts src/server/services/operation-ledger.ts src/client/components/assistant/AssistantActionPlanCard.tsx src/client/components/assistant/AssistantProjectWriteCard.tsx src/client/components/assistant/AssistantMessageView.tsx tests/unit/project-write-plans.test.ts tests/integration/personal-project-api.test.ts tests/component/assistant-message-view.test.tsx
git commit -m "feat: add confirmed project output plans"
~~~

## Task 7: Add project assistant tools and server-side project context

**Files:**

- Create: src/server/assistant/project-tools.ts
- Create: src/server/assistant/tool-factory.ts
- Modify: src/server/assistant/brain-tools.ts
- Modify: src/server/assistant/attachment-tools.ts
- Modify: src/server/assistant/types.ts
- Modify: src/server/assistant/service.ts
- Modify: src/server/assistant/history.ts
- Modify: src/server/app.ts
- Modify: src/server/start-server.ts
- Test: tests/unit/assistant-project-tools.test.ts
- Test: tests/integration/assistant-project-mode.test.ts
- Test: tests/integration/project-isolation.test.ts

- [ ] **Step 1: Write project-tool boundary tests**

Construct two bound projects A and B plus a fake ReadService containing one global knowledge record. Create project tools with project A and assert:

~~~ts
const search = tools.find(tool => tool.name === 'search_project_files')!;
expect(await search.execute({ query: '获客', limit: 5 })).toMatchObject({ items: [{ path: 'brief.md' }] });
await expect(tools.find(tool => tool.name === 'read_project_file')!.execute({ path: '../B/brief.md' }))
  .rejects.toMatchObject({ code: 'PROJECT_SCOPE_LIMIT' });
expect(toolNames).toContain('search_knowledge');
expect(toolNames).toContain('save_project_draft');
expect(toolNames).not.toContain('write_file');
~~~

Assert that a project-tool source path is an opaque project reference, never an absolute path, and that save_project_draft refuses a request without explicit save intent. Assert that a project A turn cannot read B even when the model supplies B's UUID or an absolute path.
Assert that sources emitted by search_knowledge and search_project_files have unique S-numbers within the same turn.

- [ ] **Step 2: Run tool tests to verify failure**

Run:

~~~bash
npm run test:unit -- tests/unit/assistant-project-tools.test.ts
~~~

Expected: FAIL because project-tools.ts and the project scope are absent.

- [ ] **Step 3: Implement the project tool factory**

Create createProjectTools with this input:

~~~ts
export function createProjectTools(input: {
  projectService: ProjectService;
  writePlans: ProjectWritePlanService;
  projectId: string;
  projectRevision: number;
  conversationId: string;
  messageId: string;
  userMessage: string;
  model: string;
  signal: AbortSignal;
  emit: (event: AssistantEvent) => void;
  sourceAllocator?: { next(): string };
}): AssistantTool[];
~~~

Add createAssistantSourceAllocator to src/server/assistant/types.ts; it returns an object whose next() method yields S1, S2, and so on for one turn. Keep the existing local counter as a fallback only for direct brain-tool unit tests that do not provide an allocator.

Implement these exact tools:

~~~text
search_project_files({ query, limit })
read_project_file({ path, offset, length })
save_project_draft({ category, title, summary, content })
propose_project_edit({ path, replacement, rationale })
refresh_project_index({})
~~~

search_project_files and read_project_file call only the captured projectId. Create one source-ID allocator per assistant turn and pass it to both global and project factories so their S-numbers cannot collide; source.path is project:<projectId>/<relativePath>. The project ID is permitted as an opaque citation key but the root path is never included. read_project_file returns evidence fragments using the cached file SHA and UTF-16 offsets.

save_project_draft checks a small intent predicate before proposing a plan:

~~~ts
const explicitSaveIntent = /(保存|写入|落盘|存到项目|生成到项目|放进项目)/u;
const negatedSaveIntent = /(不要|无需|不用|不需要|别)(?:保存|写入|落盘|存到项目|生成到项目|放进项目)/u;
const hasExplicitSaveIntent = (message: string) =>
  explicitSaveIntent.test(message) && !negatedSaveIntent.test(message);
~~~

It calls writePlans.proposeDraft only when hasExplicitSaveIntent(userMessage) is true, with the captured revision, and emits the returned action; it never writes during the model turn. propose_project_edit validates the relative path and returns a bounded diff proposal only; it does not expose a write operation for original files. refresh_project_index calls service.refresh for the captured ID and reports the new revision.

- [ ] **Step 4: Compose global and project tools without widening scope**

Change ToolFactoryInput.scope to brain/current/project and add projectId/projectRevision. Make the expanded factory input explicit so project dependencies cannot be accidentally omitted:

~~~ts
export interface ToolFactoryInput {
  readService: ReadService;
  projectService?: ProjectService;
  projectWritePlans?: ProjectWritePlanService;
  scope: 'brain' | 'current' | 'project';
  contextPath?: string;
  projectId?: string;
  projectRevision?: number;
  allowCandidateWrites?: boolean;
  sourceAllocator: { next(): string };
  attachments: AttachmentSelection[];
  extractionService?: ExtractionService;
  attachmentService?: AttachmentPort;
  conversationId: string;
  messageId: string;
  userMessage: string;
  model: string;
  signal: AbortSignal;
  emit: (event: AssistantEvent) => void;
  proposeArchive?: (request: AttachmentArchiveProposalRequest, signal?: AbortSignal) => Promise<AssistantPlanAction>;
  markActionPending?: () => void;
}
~~~

Rename the current attachment-tools export to createAttachmentTools (keep a compatibility alias only if existing imports require it). Implement the outer createAssistantTools in the new tool-factory.ts:

~~~ts
const sourceAllocator = input.sourceAllocator ?? createAssistantSourceAllocator();
const brainTools = createBrainTools({
  ...input,
  scope: input.scope === 'current' ? 'current' : 'brain',
  contextPath: input.scope === 'current' ? input.contextPath : undefined,
  allowCandidateWrites: input.scope !== 'project',
  sourceAllocator
});
if (input.scope === 'project') {
  if (!input.projectService || !input.projectWritePlans ||
      !input.projectId || input.projectRevision === undefined) {
    throw new Error('PROJECT_DEPENDENCIES_REQUIRED');
  }
  const projectTools = createProjectTools({
    projectService: input.projectService,
    writePlans: input.projectWritePlans,
    projectId: input.projectId,
    projectRevision: input.projectRevision,
    conversationId: input.conversationId,
    messageId: input.messageId,
    userMessage: input.userMessage,
    model: input.model,
    signal: input.signal,
    emit: input.emit,
    sourceAllocator
  });
  return [...brainTools, ...projectTools];
}
const attachmentTools = createAttachmentTools({
  ...input,
  scope: input.scope === 'current' ? 'current' : 'brain',
  ...(input.scope === 'current' ? {} : { contextPath: undefined })
});
return [...brainTools, ...attachmentTools];
~~~

Add allowCandidateWrites?: boolean and sourceAllocator?: { next(): string } to createBrainTools, and thread sourceAllocator through attachment-tools; when allowCandidateWrites is false, omit prepare_extraction/submit_candidates and reject any global candidate-write callback. Keep current-scope behavior unchanged: current remains limited to the selected brain document and selected attachments. In project scope, expose global brain retrieval as read-only and do not include attachment archive/extraction or global candidate-write tools; project output proposals are the only write-capable actions, and they always wait for confirmation. Company tools continue to be supplied only by the explicit company composition path and are not passed to the personal project factory.

- [ ] **Step 5: Extend assistant service validation and history**

Add projectService and projectWritePlans optional dependencies to createAssistantService. Before creating a project turn, call projectService.ensureFresh for the captured project ID (with the configured low-frequency throttle), then load the project and require:

~~~ts
request.scope === 'project'
&& request.projectId !== undefined
&& request.projectRevision !== undefined
&& project.availability === 'ready'
&& project.sourceRevision === request.projectRevision
~~~

Return PROJECT_UNAVAILABLE or PROJECT_REVISION_STALE (including the latest public revision in structured error fields when available) before a provider call when these conditions fail. Store projectId/projectRevision on the conversation and user message, and clear them when a non-project turn is sent. A conversationId from another project must return ASSISTANT_PROJECT_CONFLICT rather than merging histories.

Create one source allocator per send/assistant turn in assistant service and pass it through createTools context; never reuse an allocator across conversations or requests.

Update SYSTEM construction for project turns with a bounded, non-path prompt:

~~~text
当前范围：项目模式。
项目名称：<displayName>
项目语料：只读检索当前项目。
全局知识库：可检索，只用于通用方法与经验。
写入范围：当前项目/AI工作区，任何写入都必须等待用户确认。
处理内容任务时先分别检索项目资料和全局知识，再说明事实、方法与推断的边界。
事实冲突时项目文件优先；不确定内容标为待核实。
~~~

Extend listAssistantHistory to accept projectId and include it in its cursor payload and SQL predicate. ProjectPanel history calls always pass the current project ID; a history request without projectId must filter to non-project conversations so a global sidebar cannot silently show a client's conversation. A project request with a different projectId is rejected before querying.

- [ ] **Step 6: Wire project services into the personal server**

In start-server.ts, after opening a normal filesystem personal kernel, create the project service with vaultRealRoot and appDataDir as protected roots, then create the write-plan service. Pass both to buildServer and close them before closing the kernel. In app.ts, pass the services into createAssistantService and createAssistantTools, pass a project-existence/identity callback to the draft service, and register project routes. Recovery-mode/local-rest startup and the separate company composition leave projectService undefined; they must not create or expose personal project services.

- [ ] **Step 7: Run assistant integration tests and commit**

Run:

~~~bash
npm run test:unit -- tests/unit/assistant-project-tools.test.ts
npm run test:integration -- tests/integration/assistant-project-mode.test.ts tests/integration/project-isolation.test.ts tests/integration/assistant-api.test.ts
npm run typecheck
~~~

Expected: PASS. The provider fixture should observe global search plus project search/read tools for scope project, only global tools for brain, and no project tools in company mode.

~~~bash
git add src/server/assistant/project-tools.ts src/server/assistant/tool-factory.ts src/server/assistant/brain-tools.ts src/server/assistant/attachment-tools.ts src/server/assistant/types.ts src/server/assistant/service.ts src/server/assistant/history.ts src/server/app.ts src/server/start-server.ts tests/unit/assistant-project-tools.test.ts tests/integration/assistant-project-mode.test.ts tests/integration/project-isolation.test.ts
git commit -m "feat: connect project context to the existing assistant"
~~~

## Task 8: Make the single assistant panel project-aware

**Files:**

- Modify: src/client/components/assistant/useAssistantDrafts.ts
- Modify: src/client/components/assistant/assistantIntent.ts
- Modify: src/client/components/assistant/AssistantPanel.tsx
- Modify: src/client/components/assistant/AssistantMessageView.tsx
- Modify: src/client/components/assistant/AssistantProjectWriteCard.tsx
- Modify: src/client/app/AppShell.tsx
- Modify: src/client/pages/ProjectWorkspacePage.tsx
- Modify: src/client/styles/projects.css
- Test: tests/component/assistant-panel.test.tsx
- Test: tests/component/assistant-message-view.test.tsx

- [ ] **Step 1: Write project-panel tests**

Render AssistantPanel under a project URL with a mocked project summary/API. Assert:

~~~ts
expect(screen.getByText('项目模式 · A项目')).toBeVisible();
expect(screen.getByText('项目语料：已连接')).toBeVisible();
expect(screen.getByText('全局知识库：可检索')).toBeVisible();
expect(screen.getByText('写入范围：A项目 / AI工作区')).toBeVisible();
expect(screen.getByText('项目模式 · A项目')).toBeVisible();
~~~

Fill “下周拍 6 条获客内容”, send, and assert the request body contains scope project, projectId, and the fetched sourceRevision. Navigate to B and assert a new/recovered B draft is selected, the history request includes B's projectId, and A's project conversation is not displayed.

- [ ] **Step 2: Extend draft persistence and assistant intent types**

Add projectId/projectRevision to LocalDraft and fields:

~~~ts
const fresh = (): LocalDraft => ({
  id: crypto.randomUUID(),
  revision: 0,
  text: '',
  attachments: [],
  groupId: crypto.randomUUID(),
  scope: 'brain'
});

async function enterProject(projectId: string, projectRevision: number): Promise<boolean> {
  const existing = draftsRef.current.find(item => item.projectId === projectId);
  return select(existing ? {
    ...existing,
    scope: 'project',
    projectId,
    projectRevision
  } : {
    ...fresh(),
    scope: 'project',
    projectId,
    projectRevision
  });
}
~~~

Export enterProject from useAssistantDrafts (including it in the hook return object). Extend assistantDrafts.list with a backward-compatible optional query (list(signal?, { projectId }?)); load project drafts with the projectId query and global drafts with the no-project query. Extend AssistantIntent.scope to include project and add projectId/projectRevision for programmatic intents; reject an intent whose projectId differs from the route in AssistantPanel.

- [ ] **Step 3: Add route-bound project state to AssistantPanel**

Add a projectId optional prop to AssistantPanel. When projectId changes, load api.projects.get, call draftStore.enterProject, set scope project, and clear any brain/current contextPath. On a project route, hide the brain/current selector options and render a non-editable project scope label; leaving the route restores the normal selector. Disable send when the project is scanning, unavailable, reconnect-required, or while the revision is stale. If the server reports PROJECT_REVISION_STALE, refresh the summary/draft revision and show “项目资料已更新，请确认后重试” rather than silently resending the user message. Include projectId/projectRevision in buildSendPayload and projectId in assistant.history queries.

The panel remains the one global AssistantPanel mounted by AppShell. Do not create a second assistant component or provider.

- [ ] **Step 4: Add project source links and write-card behavior**

Update AssistantMessageView with:

~~~ts
function projectSourceHref(path: string): string | undefined {
  if (!path.startsWith('project:')) return undefined;
  const separator = path.indexOf('/');
  if (separator < 0) return undefined;
  const projectId = path.slice('project:'.length, separator);
  const relativePath = path.slice(separator + 1);
  return '/projects/' + encodeURIComponent(projectId) + '?file=' + encodeURIComponent(relativePath);
}
~~~

Use this link for project citations, group citations into “项目资料” and “全局知识” labels, and display user-message context as “本轮检索：项目模式 · A项目；全局知识库可检索”. Render project-write actions with AssistantProjectWriteCard and wire its confirm/cancel callbacks to api.projects.confirmWritePlan/cancelWritePlan. On success, refresh the project files panel and the assistant conversation.

- [ ] **Step 5: Open and label the project assistant from AppShell**

Parse /projects/:id in AppShell, pass the ID to AssistantPanel, and include project-specific pageIdentity/workspace-bar text. Entering a project opens the existing assistant panel once and focuses its composer; closing it keeps the project page visible. ProjectWorkspacePage provides an explicit 打开项目问问 button that dispatches the existing ASSISTANT_INTENT_EVENT with no second service.

- [ ] **Step 6: Run component tests and commit**

Run:

~~~bash
npm run test:component -- tests/component/assistant-panel.test.tsx tests/component/assistant-message-view.test.tsx tests/component/projects-page.test.tsx tests/component/project-workspace.test.tsx
npm run typecheck
~~~

Expected: PASS, with existing brain/current assistant-panel tests unchanged except for the expanded scope union.

~~~bash
git add src/client/components/assistant/useAssistantDrafts.ts src/client/components/assistant/assistantIntent.ts src/client/components/assistant/AssistantPanel.tsx src/client/components/assistant/AssistantMessageView.tsx src/client/components/assistant/AssistantProjectWriteCard.tsx src/client/app/AppShell.tsx src/client/pages/ProjectWorkspacePage.tsx src/client/styles/projects.css tests/component/assistant-panel.test.tsx tests/component/assistant-message-view.test.tsx
git commit -m "feat: add project mode to the existing assistant panel"
~~~

## Task 9: Add refresh recovery, operation visibility, and runtime isolation

**Files:**

- Modify: src/server/services/operation-ledger.ts
- Modify: src/server/api/routes/operations.ts
- Modify: src/shared/api/schemas.ts
- Modify: src/client/pages/OperationsPage.tsx
- Modify: src/client/pages/ProjectWorkspacePage.tsx
- Modify: src/client/app/AppShell.tsx
- Test: tests/integration/project-isolation.test.ts
- Test: tests/integration/assistant-project-mode.test.ts
- Test: tests/component/project-workspace.test.tsx
- Test: tests/component/operations-page.test.tsx

- [ ] **Step 1: Write recovery and isolation tests**

Cover these state transitions with temporary folders:

~~~text
source folder moved or permission denied -> reconnect-required; project row and conversation remain readable; explicit reconnect preserves the project identity and invalidates stale plans
external source edit -> refresh increments sourceRevision; old write plan becomes stale
one parser failure -> file list remains visible; readable files remain searchable
global knowledge index revision changes -> next project turn sees the new global record; no project file hash changes
company runtime -> /api/v1/projects and project assistant tools are unavailable
~~~

Assert that a project A request containing project B's ID is rejected before the provider mock is called, and that a project output operation appears in /api/v1/operations with only relative paths.

- [ ] **Step 2: Expose project operations in the existing ledger**

Add an optional projects reader to createOperationLedger. Merge its records with existing records, sort by occurredAt/id, and preserve current counts/statuses. Project operation records must include:

~~~ts
{
  id: 'project:' + operationId,
  sourceId: operationId,
  title: projectName,
  kind: 'project-output',
  bucket: 'history' | 'attention',
  statusLabel: '已保存' | '写入未完成' | '计划已失效',
  paths: ['AI工作区/周计划/2026-09-22-下周获客内容.md'],
  action: { kind: 'navigate', label: '打开项目', href: '/projects/' + projectId }
}
~~~

Extend the shared operation kind schema with project-output and update OperationsPage labels only; do not add write controls to the ledger page.

- [ ] **Step 3: Make refresh/status truthful in the workspace**

ProjectWorkspacePage polls only while a refresh is running, displays the last confirmed revision, and keeps the prior file list on failure. A project entry or project turn may trigger the bounded ensureFresh check; a missing/changed root shows 需要重新连接 with a retry button and never silently substitutes another folder. AppShell health polling remains unchanged and project refresh is never folded into the global vault index job.

- [ ] **Step 4: Run recovery/isolation tests and commit**

Run:

~~~bash
npm run test:integration -- tests/integration/project-isolation.test.ts tests/integration/assistant-project-mode.test.ts
npm run test:component -- tests/component/project-workspace.test.tsx tests/component/operations-page.test.tsx
npm run typecheck
~~~

Expected: PASS; personal project state is visible only through personal routes and company mode remains isolated.

~~~bash
git add src/server/services/operation-ledger.ts src/server/api/routes/operations.ts src/shared/api/schemas.ts src/client/pages/OperationsPage.tsx src/client/pages/ProjectWorkspacePage.tsx src/client/app/AppShell.tsx tests/integration/project-isolation.test.ts tests/integration/assistant-project-mode.test.ts tests/component/project-workspace.test.tsx tests/component/operations-page.test.tsx
git commit -m "feat: add project recovery and operation visibility"
~~~

## Task 10: Verify the complete Electron acceptance flow and regressions

**Files:**

- Create: tests/electron/personal-project-workspace.test.ts
- Modify: tests/electron/desktop-launch.test.ts
- Modify: README.md
- Modify: docs/reviews/2026-09-11-first-run-walkthrough.md

- [ ] **Step 1: Add the end-to-end fixture and acceptance test**

Create a temporary personal vault, a temporary client project folder, and set XIAOZHAO_TEST_PROJECT_ROOT to the project path. Put in the project folder:

~~~text
brief.md          (customer facts and target audience)
content-history.md
unsupported.png
~~~

Launch both development and packaged Electron modes, click 我的项目, add the project, confirm the scan preview, and assert:

1. no client-background/stage form is shown;
2. the workspace shows the folder name, readable-file count, and AI工作区 write boundary;
3. the existing 问问 panel shows 项目模式;
4. sending 下周拍 6 条获客内容 causes the test adapter to return both a project source and a global-knowledge source;
5. explicitly asking to save a 周计划 produces a pending project-write card;
6. confirming the card creates exactly one new file below AI工作区 and leaves the global 02知识库 hash and another project's hash unchanged;
7. editing brief.md followed by 刷新索引 increments the revision and appears in the next read;
8. moving the project folder shows 需要重新连接 while the old conversation remains visible, and reconnecting to a newly selected folder keeps the same project ID while invalidating an old write plan.

The test adapter should inspect tool names and return deterministic text with source IDs; it must not use a real model or external network.

- [ ] **Step 2: Update desktop regression expectations and docs**

Add chooseProjectDirectory to the bridge-key expectation in desktop-launch.test.ts. Document in README.md that personal projects bind existing folders, never copy or overwrite source files, and use AI工作区 only after confirmation. Add the project route to the first-run walkthrough’s later-navigation note without changing observed first-run facts.

- [ ] **Step 3: Run the focused acceptance suites**

Run:

~~~bash
npm run test:electron -- tests/electron/personal-project-workspace.test.ts tests/electron/desktop-launch.test.ts
npm run test:integration -- tests/integration/personal-project-api.test.ts tests/integration/assistant-project-mode.test.ts tests/integration/project-isolation.test.ts
npm run test:component -- tests/component/projects-page.test.tsx tests/component/project-workspace.test.tsx tests/component/assistant-panel.test.tsx
~~~

Expected: PASS in development mode. Run packaged mode after the desktop runtime build has completed.

- [ ] **Step 4: Run the repository verification commands**

Run:

~~~bash
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:component
npm run build:desktop-runtime
~~~

Expected: all commands exit 0. If a pre-existing unrelated test fails, record its exact test name and output in the handoff; do not weaken the new project assertions.

- [ ] **Step 5: Review the final diff and commit**

Run:

~~~bash
git diff --check
git status --short
git diff --stat 67d1487..HEAD
~~~

Confirm that no absolute project root appears in shared API fixtures, assistant payload snapshots, rendered source links, or model prompt snapshots. Confirm that unrelated untracked files remain untracked. Commit only the project feature files and docs:

~~~bash
git add README.md docs/reviews/2026-09-11-first-run-walkthrough.md tests/electron/personal-project-workspace.test.ts tests/electron/desktop-launch.test.ts
git commit -m "test: verify personal project workspace end to end"
~~~

## Acceptance checklist

The implementation is ready for product review only when all statements below are true:

- A user can choose an existing local folder and bind it without completing a project questionnaire or copying the folder.
- /projects/:id shows files, outputs, revision/availability, and a single existing 问问 panel in project scope.
- A project turn retrieves current-project evidence and global-knowledge evidence separately, cites both, and labels inference.
- A project A turn cannot read project B, an absolute path, or a hidden project ID supplied by the model.
- A confirmed output creates a new versioned file only under A/AI工作区/; source files, 02知识库/, and B remain unchanged.
- A changed/moved folder produces a stale/reconnect state and never claims a successful write against old evidence.
- A bounded on-demand freshness check or manual refresh makes newly added/changed supported files available on the next project turn; unsupported files remain honest metadata.
- Project conversations and drafts are isolated by project ID, while brain/current behavior and existing company runtime tests remain green.
- All project operations have a relative-path receipt and an entry in the existing operations view.

No P1/P2 behavior is included in this plan: no background watcher, no automatic cross-project references, no silent global-knowledge write-back, no platform publishing, and no performance dashboard.
