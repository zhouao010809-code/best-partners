# Company Platform Export Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让公司版在不接平台 API 的前提下，通过 Mac mini 监听三平台官方导出文件，自动完成校验、去重、指标快照入库，并把可追溯数据投影到项目看板。

**Architecture:** 新增独立的 `CompanyMetricsService` 数据层，不把采集逻辑塞进项目页面。采集器只读取公司工作区 `platform-data/<platform>/<projectId>/` 下的官方导出文件，将原文件按 SHA-256 原样保存到 `platform-data/raw/`，解析成追加式指标快照；看板只读取快照投影。第一版支持 CSV 与 XLSX/XLS，平台字段通过显式别名映射，无法识别的列进入失败批次，不静默猜测。后台轮询器只在 Mac mini 上运行，浏览器端提供“立即扫描”与同步状态。平台导出目录与项目资料 `incoming/` 分离，避免项目扫描把表格误当项目资料。

**Tech Stack:** TypeScript/Node 22, Fastify 5, better-sqlite3 migrations, Zod 4, React 19, Vitest, SheetJS `xlsx`。

**Fixture boundary:** 在拿到用户三个平台各一份脱敏官方导出前，测试只锁定已知的最小字段别名与明确的失败/待处理状态；真实账号的额外表头、编码和多表结构必须先进入隔离区，不能宣称已经覆盖全部平台后台格式。

---

### Task 1: Define the metrics contract and database schema

**Files:**
- Create: `src/shared/company/metrics.ts`
- Create: `src/shared/api/company-metrics.ts`
- Create: `src/server/db/migrations/020_company_platform_metrics.sql`
- Modify: `src/server/db/migrate.ts`
- Modify: `src/shared/api/company-projects.ts`
- Test: `tests/unit/company-metrics-contract.test.ts`
- Test: `tests/integration/database-kernel.test.ts`

- [ ] **Step 1: Write the failing contract test**

Add tests that require:

```ts
it('accepts only the three company platforms and non-negative canonical metrics', () => {
  expect(companyPlatformSchema.parse('douyin')).toBe('douyin');
  expect(companyPlatformSchema.parse('xiaohongshu')).toBe('xiaohongshu');
  expect(companyPlatformSchema.parse('wechat-channels')).toBe('wechat-channels');
  expect(() => companyPlatformSchema.parse('bilibili')).toThrow();
  expect(companyMetricSnapshotSchema.parse({
    id: 'snapshot-1', workspaceId: 'company', projectId: 'project-1', platform: 'douyin',
    contentId: 'item-1', contentTitle: '试听课', metricDate: '2026-09-19', metricKind: 'cumulative',
    observedAt: '2026-09-19T12:00:00.000Z', metrics: { views: 120, likes: 8 },
    sourceType: 'official-export', sourceRelativePath: 'platform-data/douyin/project-1/a.csv',
    rawRelativePath: 'platform-data/raw/douyin/project-1/a.csv', sourceSha256: 'a'.repeat(64), sourceRow: 2,
    headerRow: 1, sheetName: 'CSV', rawRowSha256: 'b'.repeat(64),
    createdAt: '2026-09-19T12:00:01.000Z'
  })).toMatchObject({ platform: 'douyin' });
  expect(() => companyMetricSnapshotSchema.parse({
    id: 'snapshot-1', workspaceId: 'company', projectId: 'project-1', platform: 'douyin',
    metricDate: '2026-09-19', metricKind: 'cumulative', observedAt: '2026-09-19T12:00:00.000Z', metrics: { views: -1 },
    sourceType: 'official-export', sourceRelativePath: 'x', rawRelativePath: 'x', sourceSha256: 'a'.repeat(64), sourceRow: 2,
    headerRow: 1, sheetName: 'CSV', rawRowSha256: 'b'.repeat(64),
    createdAt: '2026-09-19T12:00:01.000Z'
  })).toThrow();
});

it('exposes truthful coverage states instead of forcing a number', () => {
  expect(companyDataCoverageSchema.parse('not_configured')).toBe('not_configured');
  expect(companyDataCoverageSchema.parse('connected')).toBe('connected');
  expect(companyDataCoverageSchema.parse('stale')).toBe('stale');
  expect(() => companyDataCoverageSchema.parse('0')).toThrow();
});
```

Run: `npx vitest run --config vitest.config.ts tests/unit/company-metrics-contract.test.ts`

Expected: FAIL because the shared metrics schemas do not exist.

- [ ] **Step 2: Run the test and verify the failure is about missing contracts**

Run the command above and confirm the failure is a module/export failure, not a malformed fixture.

- [ ] **Step 3: Implement the shared schemas and migration**

Define these exact canonical values:

```ts
type CompanyPlatform = 'douyin' | 'xiaohongshu' | 'wechat-channels';
type CompanyMetricName = 'views' | 'likes' | 'comments' | 'shares' | 'saves' | 'followers' | 'leads';
type CompanyMetricSourceType = 'official-export';
type CompanyMetricImportState = 'imported' | 'partial' | 'duplicate' | 'conflict' | 'failed';
```

Create migration `020` with:

```sql
CREATE TABLE company_platform_metric_imports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES company_workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES company_projects(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('douyin', 'xiaohongshu', 'wechat-channels')),
  source_path TEXT NOT NULL CHECK (length(source_path) > 0),
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  source_type TEXT NOT NULL CHECK (source_type = 'official-export'),
  state TEXT NOT NULL CHECK (state IN ('imported', 'partial', 'duplicate', 'conflict', 'failed')),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  imported_count INTEGER NOT NULL CHECK (imported_count >= 0),
  rejected_count INTEGER NOT NULL CHECK (rejected_count >= 0),
  error_json TEXT,
  source_relative_path TEXT NOT NULL CHECK (length(source_relative_path) > 0),
  raw_relative_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, source_sha256)
);

CREATE TABLE company_platform_metric_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES company_workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES company_projects(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('douyin', 'xiaohongshu', 'wechat-channels')),
  account_ref TEXT,
  content_id TEXT NOT NULL CHECK (length(content_id) > 0),
  content_title TEXT,
  metric_date TEXT NOT NULL,
  metric_kind TEXT NOT NULL CHECK (metric_kind = 'cumulative'),
  observed_at TEXT NOT NULL,
  metrics_json TEXT NOT NULL CHECK (length(metrics_json) > 0),
  source_type TEXT NOT NULL CHECK (source_type = 'official-export'),
  source_relative_path TEXT NOT NULL,
  raw_relative_path TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  source_row INTEGER NOT NULL CHECK (source_row >= 2),
  header_row INTEGER NOT NULL CHECK (header_row >= 1),
  sheet_name TEXT NOT NULL,
  raw_row_sha256 TEXT NOT NULL CHECK (length(raw_row_sha256) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, source_sha256, source_row),
  UNIQUE (workspace_id, project_id, platform, content_id, metric_date, metric_kind, raw_row_sha256)
);

CREATE INDEX company_platform_metric_snapshots_project_date_idx
  ON company_platform_metric_snapshots(project_id, metric_date, observed_at);
CREATE INDEX company_platform_metric_snapshots_platform_idx
  ON company_platform_metric_snapshots(platform, account_ref, metric_date);
CREATE INDEX company_platform_metric_imports_project_idx
  ON company_platform_metric_imports(project_id, created_at);
```

Register version `20` in `initialMigrations()`. Keep the existing `companyProjectSchema.dataCoverage = 'not_configured'` contract for backward compatibility; the new metrics namespace owns the richer coverage states so existing project and MCP fixtures do not silently change meaning.

- [ ] **Step 4: Run focused tests and migration checks**

Run:

```bash
npx vitest run --config vitest.config.ts tests/unit/company-metrics-contract.test.ts
npx vitest run --config vitest.integration.config.ts tests/integration/database-kernel.test.ts
```

Expected: PASS, including a fresh in-memory database containing migration 020 and an existing database upgrading without data loss.

- [ ] **Step 5: Commit the contract slice**

```bash
git add src/shared/company/metrics.ts src/shared/api/company-metrics.ts src/shared/api/company-projects.ts src/server/db/migrations/020_company_platform_metrics.sql src/server/db/migrate.ts tests/unit/company-metrics-contract.test.ts tests/integration/database-kernel.test.ts
git commit -m "feat: add company platform metrics contracts"
```

### Task 2: Build a safe CSV/XLSX export parser

**Files:**
- Create: `src/server/company/metrics-importer.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `tests/unit/company-metrics-importer.test.ts`

- [ ] **Step 1: Add parser tests before implementation**

Cover these behaviors with real temporary files/bytes:

```ts
it('parses quoted UTF-8 CSV with Chinese aliases and normalizes metrics', async () => {
  const result = await parsePlatformExport({
    platform: 'douyin', fileName: '作品数据.csv',
    bytes: Buffer.from('\ufeff作品ID,作品标题,数据日期,播放量,点赞,评论,分享\\nitem-1,"试听,公开课",2026-09-19,"1,200",8,3\\n')
  });
  expect(result.rows).toEqual([expect.objectContaining({
    contentId: 'item-1', contentTitle: '试听,公开课', metricDate: '2026-09-19',
    metricKind: 'cumulative', metrics: { views: 1200, likes: 8, comments: 3 }
  })]);
});

it('parses the first worksheet of an XLSX export using the same contract', async () => {
  const bytes = makeFixtureWorkbook([
    ['笔记ID', '笔记标题', '数据日期', '阅读量', '收藏'],
    ['note-1', '课程笔记', '2026/09/19', 321, 12]
  ]);
  const result = await parsePlatformExport({ platform: 'xiaohongshu', fileName: '笔记.xlsx', bytes });
  expect(result.rows[0]).toMatchObject({ contentId: 'note-1', metricDate: '2026-09-19', metrics: { views: 321, saves: 12 } });
});

it('rejects unknown metric columns and negative values instead of guessing', async () => {
  await expect(parsePlatformExport({ platform: 'wechat-channels', fileName: 'bad.csv', bytes: Buffer.from('日期,神秘指标\\n2026-09-19,3\\n') })).rejects.toMatchObject({ code: 'COMPANY_METRICS_COLUMNS_UNSUPPORTED' });
  await expect(parsePlatformExport({ platform: 'douyin', fileName: 'bad.csv', bytes: Buffer.from('数据日期,播放量\\n2026-09-19,-1\\n') })).rejects.toMatchObject({ code: 'COMPANY_METRICS_VALUE_INVALID' });
});

it('is deterministic for repeated input and does not accept symlink/path data as file content', async () => {
  const input = { platform: 'douyin' as const, fileName: 'data.csv', bytes: Buffer.from('数据日期,播放量\\n2026-09-19,2\\n') };
  const first = await parsePlatformExport(input);
  const second = await parsePlatformExport(input);
  expect(second).toEqual(first);
});
```

Run: `npx vitest run --config vitest.config.ts tests/unit/company-metrics-importer.test.ts`

Expected: FAIL because the parser module and `xlsx` dependency are absent.

- [ ] **Step 2: Add the smallest supported dependency and implement the parser**

Install `xlsx@0.18.5` as a production dependency. Implement `parsePlatformExport({ platform, fileName, bytes })` with:

- extension allowlist `.csv`, `.xlsx`, `.xls`; reject all other extensions;
- UTF-8 BOM removal, RFC-style quoted CSV parsing, CRLF/LF support;
- first worksheet only for Excel, with a hard 20 MiB input limit, 20 worksheet limit, 100,000-row limit, and 1,000,000-cell limit;
- normalized header matching across platform aliases, using `Map<string, canonicalField>` and trimming punctuation/whitespace;
- detect the first non-empty row containing recognized identity/date/metric headers as `headerRow`; require `contentId`, `metricDate`, and at least one recognized metric per accepted row; rows without `contentId` become row-level quarantine issues and are never displayed as project metrics;
- integer-only non-negative metric values, comma separators accepted, blank cells omitted;
- ISO date normalization for `YYYY-MM-DD`, `YYYY/MM/DD`, and Excel date values; Excel date conversion must use an explicit Asia/Shanghai business date, not the host timezone;
- `contentTitle` and `accountRef` optional; no title-based project inference; every accepted row carries `metricKind: 'cumulative'`, `sheetName`, `headerRow`, and a raw-row hash;
- unknown extra columns are retained in row issues; a table with recognized identity/date/metric columns becomes `partial` rather than failing; a table with no recognized metric columns fails;
- typed `MetricsImportError` codes: `COMPANY_METRICS_FILE_UNSUPPORTED`, `COMPANY_METRICS_COLUMNS_UNSUPPORTED`, `COMPANY_METRICS_DATE_INVALID`, `COMPANY_METRICS_VALUE_INVALID`, `COMPANY_METRICS_ENCODING_UNSUPPORTED`, `COMPANY_METRICS_TOO_LARGE`, `COMPANY_METRICS_AMBIGUOUS_HEADER`.

The parser must return only normalized rows and the detected header mapping; it must not write files or databases.

- [ ] **Step 3: Run parser tests and refactor only after green**

Run the focused parser test until all cases pass. Then run `npm run typecheck` and keep the parser API independent of Fastify/SQLite.

- [ ] **Step 4: Commit the parser slice**

```bash
git add package.json package-lock.json src/server/company/metrics-importer.ts tests/unit/company-metrics-importer.test.ts
git commit -m "feat: parse company platform exports"
```

### Task 3: Implement import service, raw evidence storage, and polling scan

**Files:**
- Create: `src/server/company/company-metrics-service.ts`
- Create: `tests/unit/company-metrics-service.test.ts`
- Modify: `src/server/company/company-runtime.ts`
- Modify: `src/server/company/company-paths.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/company/graceful-shutdown.ts`

- [ ] **Step 1: Write service tests for the import lifecycle**

Cover:

```ts
it('imports a project-scoped official export, copies immutable raw evidence, and writes snapshots', async () => {
  // create workspace/platform-data/douyin/project-1/data.csv and a project row
  const result = await service.importFile({ relativePath: 'platform-data/douyin/project-1/data.csv' });
  expect(result.state).toBe('imported');
  expect(result.importedCount).toBe(1);
  expect(result.sourcePath).toMatch(/^platform-data\/raw\/douyin\/project-1\//u);
  expect(await readFile(join(workspaceRoot, result.sourcePath), 'utf8')).toContain('播放量');
});

it('is idempotent by source hash and never adds duplicate snapshots', async () => {
  const first = await service.importFile({ relativePath: 'platform-data/douyin/project-1/data.csv' });
  const second = await service.importFile({ relativePath: 'platform-data/douyin/project-1/data.csv' });
  expect(first.state).toBe('imported');
  expect(second.state).toBe('duplicate');
  expect(countSnapshots(database)).toBe(1);
});

it('rejects paths outside the platform drop root and records parse failures', async () => {
  await expect(service.importFile({ relativePath: '../../secret.csv' })).rejects.toMatchObject({ code: 'COMPANY_METRICS_PATH_INVALID' });
  const failure = await service.importFile({ relativePath: 'platform-data/douyin/project-1/bad.csv' });
  expect(failure.state).toBe('failed');
  expect(failure.errorCode).toBe('COMPANY_METRICS_COLUMNS_UNSUPPORTED');
});

it('scans only canonical platform/project folders and returns per-file outcomes', async () => {
  const result = await service.scanIncoming();
  expect(result.processed).toBe(1);
  expect(result.failed).toBe(0);
});
```

Run: `npx vitest run --config vitest.config.ts tests/unit/company-metrics-service.test.ts`

Expected: FAIL because the service and migration-backed tables are absent.

- [ ] **Step 2: Implement raw evidence and database writes**

`CompanyMetricsService` must expose:

```ts
interface CompanyMetricsService {
  importFile(input: { readonly relativePath: string }): Promise<CompanyMetricImportResult>;
  scanIncoming(): Promise<CompanyMetricScanResult>;
  listProjectMetrics(projectId: string, range?: { readonly from?: string; readonly to?: string }): Promise<CompanyProjectMetricsProjection>;
  getStatus(projectId?: string): Promise<CompanyMetricStatusProjection>;
  start(): { stop(): void };
}
```

Implementation rules:

- derive `platformDataRoot = join(workspace.rootPath, 'platform-data')` and create it with the same private-directory helper used by the company workspace; do not add it to the project `incoming/` tree or expose it as a project source;
- resolve only under `<workspace>/platform-data/<platform>/<projectId>/`; reject absolute paths, traversal, backslashes, symlinks, directories, and special files;
- derive platform and project ID only from the two path segments immediately below `platform-data`;
- verify project ID exists in `company_projects` and belongs to the company workspace;
- read the source, hash it, and re-stat it before parsing to detect concurrent writes; on change, record a failed import;
- copy bytes to `platform-data/raw/<platform>/<projectId>/<sha256>-<safe-basename>` with exclusive create and mode 0600; never overwrite or delete the incoming file;
- insert an import row before snapshot insertion and update it in one SQLite transaction;
- use `(workspace_id, source_sha256)` for duplicate detection; if the same file hash is encountered under another platform/project path, record `conflict` rather than silently attaching it to the new project;
- store `metrics_json` as canonical sorted JSON and use `(source_sha256, source_row)` to make snapshot insertion idempotent; before inserting, compare the logical key `(project, platform, accountRef, contentId, metricDate, metricKind)` against prior snapshots: equal values become row duplicates, different values become a conflict and do not overwrite history;
- record both `sourceRelativePath` (the drop file) and `rawRelativePath` (the immutable evidence copy), plus `sourceSha256`, `sourceRow`, `headerRow`, `sheetName`, `rawRowSha256`, `observedAt`, and `fetchedAt` in every projection;
- aggregate `cumulative` metrics by taking the latest snapshot for each content and metric before summing across contents; account-level `followers` is taken from the latest account row, never summed across content rows;
- derive coverage: no imports → `import_required`, latest import older than 48 hours → `stale`, latest successful import → `connected`, failed latest import with no successful import → `error`;
- never return zero for an absent metric; omit absent keys and expose `coverage`/`status` separately.

The polling `start()` method should scan immediately and then every 30 seconds by default, use a single in-flight promise, wait for a stable size/mtime across two checks before reading, and avoid creating a new failed run for an unchanged failed hash. Expose `stop()` for shutdown and allow an explicit retry after the file bytes change. Allow `COMPANY_METRICS_POLL_MS` to override the interval only when it is an integer between 5,000 and 86,400,000.

- [ ] **Step 3: Wire the service into the company runtime and production process**

Add `metrics` to `CompanyRuntime`, create it only when a database is present, and keep an unavailable no-op service for isolated route tests. In `src/server/index.ts`, call `companyRuntime.metrics.start()` after the server is created and stop it before closing SQLite. Extend the existing graceful shutdown callback rather than adding a second signal handler.

- [ ] **Step 4: Run service tests, then the existing company suites**

Run:

```bash
npx vitest run --config vitest.config.ts tests/unit/company-metrics-service.test.ts
npx vitest run --config vitest.integration.config.ts tests/integration/company-project-ingestion-api.test.ts tests/integration/company-workspace-api.test.ts
```

Expected: all focused tests pass and existing project ingestion behavior remains unchanged.

- [ ] **Step 5: Commit the service slice**

```bash
git add src/server/company/company-metrics-service.ts src/server/company/company-runtime.ts src/server/company/company-paths.ts src/server/index.ts src/server/company/graceful-shutdown.ts tests/unit/company-metrics-service.test.ts
git commit -m "feat: ingest company platform export snapshots"
```

### Task 4: Expose authenticated metrics APIs and Agent tools

**Files:**
- Create: `src/server/api/routes/company-metrics.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/company/company-auth-service.ts`
- Modify: `src/shared/api/company-metrics.ts`
- Modify: `src/client/components/company/company-api.ts`
- Modify: `company-mcp-server/tools.ts`
- Test: `tests/integration/company-metrics-api.test.ts`
- Test: `tests/unit/company-agent-tools.test.ts`
- Test: `tests/company-mcp/tools.test.ts`

- [ ] **Step 1: Write failing API and tool tests**

Require these endpoints:

```text
GET  /api/company/v1/projects/:id/metrics
GET  /api/company/v1/metrics/status
POST /api/company/v1/metrics/scan
POST /api/company/v1/metrics/import
```

The tests must verify:

- authenticated read returns typed project metrics with `coverage`, `lastImportedAt`, and source references;
- `POST /metrics/scan` requires `metrics:import` and CSRF, and returns per-file counts;
- `POST /metrics/import` accepts only `platform-data/...` relative paths and is idempotent;
- reviewer can read but cannot import; operator and owner can import;
- personal runtime has no company metrics route;
- MCP exposes only `company.list_data_sources`, `company.get_project_metrics`, `company.get_sync_status`, and `company.import_platform_export` when a company session is present;
- MCP import tool requires an explicit write flag and returns the same typed import result.

Run the focused integration/unit/MCP tests and confirm they fail because the routes/tools are not registered.

- [ ] **Step 2: Add permission and route contracts**

Add `metrics:import` to `CompanyPermission`; owner/operator may import, reviewer may read. Define strict Zod request/response schemas and use `parseApiInput`/`parseApiOutput` exactly like the existing project routes. `sourcePath` must be server-relative and must begin with `platform-data/`.

- [ ] **Step 3: Register routes and client methods**

Register `registerCompanyMetricsRoutes` only in company mode. Add typed browser methods:

```ts
metrics: {
  project(projectId: string, signal?: AbortSignal): Promise<CompanyApiResult<CompanyProjectMetrics>>;
  status(projectId?: string, signal?: AbortSignal): Promise<CompanyApiResult<CompanyMetricStatus>>;
  scan(): Promise<CompanyApiResult<CompanyMetricScanResult>>;
  importFile(sourcePath: string): Promise<CompanyApiResult<CompanyMetricImportResult>>;
}
```

Add the four MCP tools as read-only except `company.import_platform_export`, which must be gated by the existing explicit write/intent mechanism and must never receive credentials.

Every public metrics DTO must expose only workspace-relative `sourceRelativePath` and `rawRelativePath`; extend the MCP path-safety validator for both fields before returning any metrics to Codex/WorkBuddy.

- [ ] **Step 4: Run focused API/tool tests and commit**

```bash
npx vitest run --config vitest.integration.config.ts tests/integration/company-metrics-api.test.ts
npx vitest run --config vitest.config.ts tests/unit/company-agent-tools.test.ts
npm run test:company-mcp -- tests/company-mcp/tools.test.ts
git add src/server/api/routes/company-metrics.ts src/server/app.ts src/server/company/company-auth-service.ts src/shared/api/company-metrics.ts src/client/components/company/company-api.ts company-mcp-server/tools.ts tests/integration/company-metrics-api.test.ts tests/unit/company-agent-tools.test.ts tests/company-mcp/tools.test.ts
git commit -m "feat: expose company metrics sync contracts"
```

### Task 5: Replace the dashboard placeholder with truthful metrics UI

**Files:**
- Modify: `src/client/pages/company/CompanyProjectDashboardPage.tsx`
- Modify: `src/client/pages/company/CompanyProjectDetailPage.tsx`
- Modify: `src/client/styles/company.css`
- Test: `tests/component/company-dashboard.test.tsx`
- Test: `tests/component/company-project-detail.test.tsx`
- Modify: `docs/company/company-p0-operations.md`
- Modify: `README.md`

- [ ] **Step 1: Write failing component tests**

Cover:

```ts
it('shows imported metrics with freshness and source status', async () => {
  // fixture returns coverage=connected and views/likes snapshots
  expect(await screen.findByText('数据已同步')).toBeVisible();
  expect(screen.getByText('播放量')).toBeVisible();
  expect(screen.getByText('1,200')).toBeVisible();
  expect(screen.getByText(/来源：官方导出/u)).toBeVisible();
});

it('shows import required and never renders missing metrics as zero', async () => {
  expect(await screen.findByText('待导出')).toBeVisible();
  expect(screen.queryByText('播放量 0')).not.toBeInTheDocument();
});
```

Run: `npx vitest run --config vitest.client.config.ts tests/component/company-dashboard.test.tsx tests/component/company-project-detail.test.tsx`

Expected: FAIL while the dashboard still hardcodes `尚未接入`.

- [ ] **Step 2: Implement the smallest useful projection**

The dashboard should call the separate metrics overview API for each prioritized project (do not change the existing project list contract) and show:

- coverage status (`数据已同步`, `待导出`, `数据过期`, `同步失败`);
- latest snapshot time;
- aggregate cumulative metrics using the latest snapshot per content; account-level followers only from the latest account row; only show fields present in the imported snapshots;
- a link to the project detail for source path and import history;
- a `刷新数据` action that calls `metrics.scan()` and then reloads projects/metrics.

The project detail should show the drop-folder convention and the latest import source. Keep the existing truthful empty states when no export exists.

- [ ] **Step 3: Update operations documentation**

Document the exact folder convention:

```text
platform-data/douyin/<project-id>/export.csv
platform-data/xiaohongshu/<project-id>/export.xlsx
platform-data/wechat-channels/<project-id>/export.csv
```

Explain that platform dashboards must export the file; the watcher never stores passwords/Cookies, and failures are visible in the dashboard. Add backup coverage for `platform-data/raw` and `company_platform_metric_*` tables.

- [ ] **Step 4: Run component tests and commit**

```bash
npx vitest run --config vitest.client.config.ts tests/component/company-dashboard.test.tsx tests/component/company-project-detail.test.tsx
git add src/client/pages/company/CompanyProjectDashboardPage.tsx src/client/pages/company/CompanyProjectDetailPage.tsx src/client/styles/company.css tests/component/company-dashboard.test.tsx tests/component/company-project-detail.test.tsx docs/company/company-p0-operations.md README.md
git commit -m "feat: show imported platform metrics in company dashboard"
```

### Task 6: Add end-to-end watcher verification and release gate

**Files:**
- Create: `tests/integration/company-metrics-watcher.test.ts`
- Modify: `tests/e2e/company-project-onboarding.spec.ts`
- Modify: `docs/reviews/2026-09-20-company-production-readiness.md`

- [ ] **Step 1: Add a real filesystem integration test**

Create a temporary company workspace, project, three platform drop folders, and representative CSV/XLSX files. Start the service with a short test poll interval, wait for the scan promise/event, then assert:

- one import per source hash;
- duplicate file does not create another snapshot;
- the dashboard API reports `connected` and aggregate values;
- a malformed file reports `failed` without changing prior good data;
- raw evidence remains byte-identical;
- a symlink and a file outside the drop root are ignored/rejected.

- [ ] **Step 2: Run the full proportional verification**

Run:

```bash
npm run typecheck
npx vitest run --config vitest.config.ts tests/unit
npx vitest run --config vitest.integration.config.ts tests/integration
npx vitest run --config vitest.client.config.ts tests/component --no-file-parallelism
npm run build:company-server
git diff --check
```

Expected: all existing company/personal suites remain green; the only build output warning may be the existing Vite chunk-size warning.

- [ ] **Step 3: Update readiness boundaries**

Record separately:

- verified: local official-export ingestion in an isolated workspace;
- unverified: each platform's current export columns on the user's real accounts;
- not included: private API scraping, browser stealth automation, platform API authorization, and true real-time metrics.

- [ ] **Step 4: Commit the release gate**

```bash
git add tests/integration/company-metrics-watcher.test.ts tests/e2e/company-project-onboarding.spec.ts docs/reviews/2026-09-20-company-production-readiness.md
git commit -m "test: verify company platform export ingestion"
```

## Self-review

- The scope covers the user's first priority without introducing platform credentials or private API access.
- Every metric shown on the dashboard has an immutable source file, hash, row, and observed time.
- Missing or stale data remains an explicit state, never a fabricated zero.
- The watcher is isolated to the Mac mini/company runtime and has a deterministic shutdown path.
- The plan preserves the existing untracked user plan `docs/superpowers/plans/2026-09-14-company-p0-project-workspace.md` and does not touch concurrent personal Assistant files.
