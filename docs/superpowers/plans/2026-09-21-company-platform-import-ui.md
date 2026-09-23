# Company Platform Import UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let an authenticated company operator select an official Douyin, WeChat Channels, or Xiaohongshu export in the project detail page and import it into the existing audited metrics pipeline without adding private platform access.

**Architecture:** Add a bounded binary upload endpoint under the existing company metrics namespace. The server writes the bytes into the same `platform-data/<platform>/<projectId>/` drop area with a content-hash-prefixed safe filename, then delegates to `CompanyMetricsService.importFile`; all parser, deduplication, conflict, and raw-evidence behavior remains centralized. The project detail page gains a compact operator-only import panel; reviewers keep a read-only view of import history.

**Tech Stack:** Fastify content-type parser, TypeScript, Zod contracts, React 19, existing company CSS, Vitest component/integration/unit tests.

---

### Task 1: Define the upload contract and service seam

**Files:**
- Modify: `src/shared/api/company-metrics.ts`
- Modify: `src/server/company/company-metrics-service.ts`
- Test: `tests/unit/company-metrics-contract.test.ts`
- Test: `tests/unit/company-metrics-service.test.ts`

- [ ] **Step 1: Write failing contract and service tests**

  Add assertions that an upload request accepts a supported platform and safe filename metadata, rejects traversal metadata, and that `uploadFile({ projectId, platform, fileName, bytes })` creates an auditable import through the existing parser.

- [ ] **Step 2: Run the focused tests and verify they fail for the missing upload method/schema**

  Run:

  ```sh
  npx vitest run --config vitest.config.ts tests/unit/company-metrics-contract.test.ts tests/unit/company-metrics-service.test.ts --no-file-parallelism
  ```

  Expected: FAIL because `uploadFile` and the upload contract do not exist yet.

- [ ] **Step 3: Implement the minimal contract and service method**

  Add `CompanyMetricUploadFile`/upload metadata types, `uploadFile` to `CompanyMetricsService`, and a method that validates project/platform/file size, writes a mode-0600 content-hash-prefixed file below `platform-data/<platform>/<projectId>/`, then calls `importFile`.

- [ ] **Step 4: Run focused tests and verify they pass**

  Run the same Vitest command; expected: PASS.

- [ ] **Step 5: Commit the service slice**

  ```sh
  git add src/shared/api/company-metrics.ts src/server/company/company-metrics-service.ts tests/unit/company-metrics-contract.test.ts tests/unit/company-metrics-service.test.ts
  git commit -m "feat: stage company metric uploads"
  ```

### Task 2: Expose a bounded authenticated binary route and client method

**Files:**
- Modify: `src/server/api/routes/company-metrics.ts`
- Modify: `src/client/components/company/company-api.ts`
- Modify: `tests/integration/company-metrics-api.test.ts`
- Modify: `tests/component/company-project-detail.test.tsx`

- [ ] **Step 1: Write failing API/client tests**

  Add an integration request with `application/octet-stream`, `platform=douyin`, and a filename query that expects a 200 import response, plus a reviewer request that expects 403. Add a client test that asserts the file bytes are sent to the upload endpoint with the CSRF token and platform metadata.

- [ ] **Step 2: Run tests and verify the route/client behavior fails**

  ```sh
  npx vitest run --config vitest.integration.config.ts tests/integration/company-metrics-api.test.ts --no-file-parallelism
  npx vitest run --config vitest.client.config.ts tests/component/company-project-detail.test.tsx --no-file-parallelism
  ```

  Expected: FAIL because no upload route/client method exists.

- [ ] **Step 3: Implement the route and browser client**

  Register scoped parsers for `application/octet-stream`, CSV, XLS, and XLSX MIME types with the existing 20 MiB importer limit. Validate `:id`, platform, and filename; require `metrics:import`; reject non-buffer bodies; call `metrics.uploadFile`. Add `metrics.upload(projectId, platform, file)` to the browser API and send the file bytes without JSON/base64 encoding.

- [ ] **Step 4: Run the focused tests and verify they pass**

  Run both commands from Step 2; expected: PASS.

- [ ] **Step 5: Commit the API slice**

  ```sh
  git add src/server/api/routes/company-metrics.ts src/client/components/company/company-api.ts tests/integration/company-metrics-api.test.ts tests/component/company-project-detail.test.tsx
  git commit -m "feat: expose company metric upload endpoint"
  ```

### Task 3: Add the project detail import workflow

**Files:**
- Modify: `src/client/pages/company/CompanyProjectDetailPage.tsx`
- Modify: `src/client/styles/company.css`
- Modify: `tests/component/company-project-detail.test.tsx`

- [ ] **Step 1: Write the failing UI test**

  Assert that an operator sees the platform select and official-export file picker, selecting a CSV and clicking “校验并导入” calls `metrics.upload`, and the returned imported/partial/conflict state is rendered. Assert that a reviewer sees the read-only note instead of the write control.

- [ ] **Step 2: Run the component test and verify it fails**

  ```sh
  npx vitest run --config vitest.client.config.ts tests/component/company-project-detail.test.tsx --no-file-parallelism
  ```

  Expected: FAIL because the import panel and upload call do not exist.

- [ ] **Step 3: Implement the compact operator-only panel**

  Add platform labels, a native file input restricted to `.csv,.xlsx,.xls`, upload/loading/error/success states, row counts and issue summary, then reload project metrics after a successful upload. Keep the existing drop-folder instructions as the fallback and explicitly state that the page never asks for platform credentials.

- [ ] **Step 4: Run the component test and verify it passes**

  Run the focused command; expected: PASS.

- [ ] **Step 5: Commit the UI slice**

  ```sh
  git add src/client/pages/company/CompanyProjectDetailPage.tsx src/client/styles/company.css tests/component/company-project-detail.test.tsx
  git commit -m "feat: add company platform import panel"
  ```

### Task 4: Documentation, full verification, and browser check

**Files:**
- Modify: `README.md`
- Modify: `docs/company/company-p0-operations.md`
- Modify: `docs/reviews/2026-09-20-company-production-readiness.md`

- [ ] **Step 1: Document the UI workflow and security boundary**

  Explain that the UI upload is only a convenience wrapper around the same official-export drop/import pipeline, has a 20 MiB limit, never accepts platform credentials, and remains subject to operator permission and the existing audit trail.

- [ ] **Step 2: Run complete verification**

  ```sh
  npm run typecheck
  npm run test:unit -- --no-file-parallelism
  npm run test:integration -- --no-file-parallelism
  npm run test:component -- --no-file-parallelism
  npm run test:company-mcp -- --no-file-parallelism
  npm run build:company-server
  git diff --check
  ```

- [ ] **Step 3: Verify the browser workflow**

  With the company preview server running, open a project detail page, choose a platform and a fixture export, submit it as the operator, and confirm the import history and dashboard status update. Confirm no platform login or private endpoint is requested.

- [ ] **Step 4: Commit documentation and final verification**

  ```sh
  git add README.md docs/company/company-p0-operations.md docs/reviews/2026-09-20-company-production-readiness.md
  git commit -m "docs: describe company metric import UI"
  ```
