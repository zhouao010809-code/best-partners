# Skill Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Skill library page that discovers local `.claude/skills` folders, safely exposes their metadata and Markdown instructions, and leaves a stable catalog contract for a later AI recommendation flow.

**Architecture:** The server owns a dedicated, read-only `SkillCatalogService` rooted at the selected vault's `.claude/skills`; it never reuses the normal knowledge-path allowlist and never accepts renderer-supplied filesystem paths. A small `/api/v1/skills` API returns summaries and a detail endpoint returns sanitized, bounded Markdown. The client adds a `/skills` route, sidebar entry, list/detail workspace, and uses the existing `SafeMarkdown` renderer.

**Tech Stack:** TypeScript, Fastify, Zod, React 19, React Router 7, Vitest, existing CSS tokens and `SafeMarkdown`.

---

### Task 1: Secure Skill catalog service and API contract

**Files:**
- Create: `src/shared/api/skills.ts`
- Create: `src/server/services/skill-catalog.ts`
- Create: `src/server/api/routes/skills.ts`
- Modify: `src/server/start-server.ts`
- Modify: `src/server/app.ts`
- Test: `tests/unit/skill-catalog.test.ts`
- Test: `tests/integration/skill-api.test.ts`

- [ ] **Step 1: Write failing service tests**

  In `tests/unit/skill-catalog.test.ts`, create a temporary vault with `.claude/skills/writer/SKILL.md`, a second valid skill, a `.hidden` directory, a symlink to an outside directory, a `.env` file, and a `scripts/run.sh`. Assert that `list()` returns only direct directories containing `SKILL.md`, returns a deterministic non-path `id`, parses `name`/`description` from frontmatter, and that `get(id)` returns bounded Markdown. Add cases asserting `../`, absolute IDs, unknown IDs, symlinks, `.env`, and script files are rejected or omitted. Use a service factory that accepts an explicit root so the test does not touch the real vault.

- [ ] **Step 2: Run the focused tests and observe the expected failure**

  Run `npm test -- tests/unit/skill-catalog.test.ts` and confirm the failure is caused by the missing catalog module/API, not by a fixture typo.

- [ ] **Step 3: Define the shared response schemas**

  In `src/shared/api/skills.ts`, define strict Zod schemas and inferred types for:

  ```ts
  skillSummarySchema = { id, name, description, revision }
  skillDetailSchema = skillSummarySchema.extend({ markdown, references })
  skillsPageSchema = { items: skillSummary[] }
  skillResponseSchema = successEnvelopeSchema(skillDetailSchema)
  skillsResponseSchema = successEnvelopeSchema(skillsPageSchema)
  ```

  Keep `id` opaque and bounded (not a path); keep Markdown and references bounded. Export the response schemas and types used by both server and client.

- [ ] **Step 4: Implement the dedicated catalog reader**

  In `src/server/services/skill-catalog.ts`, implement `createSkillCatalogService({ skillsRoot })` with these rules. This dedicated server service uses `node:fs/promises` only inside the fixed root; it does not loosen `validateFilesystemPath` or expose a generic file reader:

  - Resolve and verify the root is a real directory and not a symlink; if it is absent, return a typed unavailable error.
  - Enumerate only direct child directories with safe names; require a regular `SKILL.md` directly inside each child.
  - Re-check `realpath`/`lstat` before reading, reject symlinked skill directories and files, and never traverse `scripts`, `.env*`, binaries, or arbitrary references.
  - Read at most 256 KiB per `SKILL.md`; parse frontmatter with the existing `parseFrontmatter`, falling back to the directory name and a safe description when frontmatter is absent or invalid.
  - Compute `revision` as a SHA-256 of the exact bytes and compute the opaque stable `id` as a SHA-256 of the raw direct directory name (without Unicode normalization, so distinct filesystem names stay distinct).
  - Expose `list(): Promise<SkillSummary[]>` and `get(id): Promise<SkillDetail>`; `get` returns the parsed `name`, `description`, revision, Markdown body (frontmatter omitted from rendered body), and direct child `.md` reference names. It never returns reference contents.

- [ ] **Step 5: Wire the API and desktop root**

  Add `GET /api/v1/skills` and `GET /api/v1/skills/:id` in `src/server/api/routes/skills.ts`, using the existing route validation and `PublicApiError` conventions. Add `skillCatalog?: SkillCatalogService` to `BuildServerOptions`; register the routes from `buildServer`. In `start-server.ts`, when `config.adapter === 'filesystem'`, construct `createSkillCatalogService({ skillsRoot: join(config.vaultRealRoot, '.claude', 'skills') })` and pass it to `buildServer`; leave it undefined for local-REST so the same route returns 503 without reading the local filesystem. Unit/integration tests may inject a fixture service directly through `BuildServerOptions`.

- [ ] **Step 6: Add integration tests and verify green**

  In `tests/integration/skill-api.test.ts`, inject a fixture catalog into `buildServer`, authenticate the loopback session as existing API tests do, and assert valid list/detail envelopes, cache-control behavior, unknown ID rejection, and 503 when no catalog is configured. Run `npm test -- tests/unit/skill-catalog.test.ts tests/integration/skill-api.test.ts` and confirm all pass.

- [ ] **Step 7: Commit the backend slice**

  Run `git add src/shared/api/skills.ts src/server/services/skill-catalog.ts src/server/api/routes/skills.ts src/server/start-server.ts src/server/app.ts src/electron/main.ts tests/unit/skill-catalog.test.ts tests/integration/skill-api.test.ts` and commit with `feat: add local skill catalog api`.

### Task 2: Skill library page, route, and sidebar entry

**Files:**
- Modify: `src/client/api/client.ts`
- Create: `src/client/pages/SkillsPage.tsx`
- Create: `src/client/styles/skills.css`
- Modify: `src/client/app/router.tsx`
- Modify: `src/client/app/AppShell.tsx`
- Test: `tests/component/skills-page.test.tsx`
- Test: `tests/component/app-shell.test.tsx`

- [ ] **Step 1: Write failing component tests**

  Add tests that render `SkillsPage` with a fake `ReadConsoleApi`, verify loading, empty, error, summary-card, and detail states, and confirm the Markdown detail is rendered through `SafeMarkdown` (raw HTML is not inserted). Update the navigation expectation in `app-shell.test.tsx` to include `Skill 库` and add a route/title assertion for `/skills`.

- [ ] **Step 2: Run the focused component tests and observe failure**

  Run `npm run test:component -- tests/component/skills-page.test.tsx tests/component/app-shell.test.tsx`; confirm the new page and API method are absent.

- [ ] **Step 3: Add the browser API methods**

  In `src/client/api/client.ts`, import the Skill schemas/types, add an optional `skills?: { list(signal?): Promise<...>; get(id, signal?): Promise<...> }` group to `ReadConsoleApi`, and implement it in `createBrowserReadConsoleApi` with `requestData` against `/api/v1/skills` and `/api/v1/skills/:id`. Encode the opaque ID with `encodeURIComponent`; do not expose a path parameter. Keeping the group optional avoids breaking existing fixture APIs and lets local-REST show a clear unavailable state.

- [ ] **Step 4: Implement the page and detail view**

  In `src/client/pages/SkillsPage.tsx`, load the summary list on mount and on a visible “刷新” button, abort stale requests, and keep the standard `PageState` loading/error language. Render a compact grid of real Skill cards with name, description, revision prefix, and “查看方法” action. Selecting a card loads its detail, shows a back/close action, renders Markdown with `SafeMarkdown`, lists allowed Markdown references, and clearly labels the view as read-only. An empty root should say that Skills are added by placing folders under `.claude/skills`.

- [ ] **Step 5: Match the existing workbench visual language**

  In `src/client/styles/skills.css`, use existing tokens, dark graphite surfaces, thin green focus accents, responsive single-column behavior below 700px, keyboard-visible focus, and reduced-motion handling. Do not introduce a new UI framework or a generic bright card grid. Import the stylesheet from the page.

- [ ] **Step 6: Register the route and sidebar metadata**

  Add `SkillsPage` at `/skills` in `router.tsx`, add a `Sparkles`/`Workflow`-style lucide icon and `Skill 库` item to `NAVIGATION`, and add the `/skills` page identity/description in `AppShell.tsx`. Keep the existing sidebar order and trash/footer behavior unchanged.

- [ ] **Step 7: Run component tests and commit**

  Run the focused component tests again, then run `npm run typecheck`. Commit with `feat: add skill library workspace`.

### Task 3: Cross-layer verification and documentation handoff

**Files:**
- Modify: `docs/superpowers/specs/2026-09-14-skill-library-invocation-design.md` only if implementation constraints differ
- Modify: `README.md` only if the existing feature list documents sidebar routes
- Test: existing unit, integration, and component suites

- [ ] **Step 1: Review the implementation against the design**

  Check that the renderer never receives an absolute skills root, the API accepts only opaque IDs, no existing `validateFilesystemPath` rule was loosened, and no Skill script or secret file is read.

- [ ] **Step 2: Run proportional verification**

  Run `npm run test:unit -- tests/unit/skill-catalog.test.ts`, `npm run test:integration -- tests/integration/skill-api.test.ts`, `npm run test:component -- tests/component/skills-page.test.tsx tests/component/app-shell.test.tsx`, and `npm run typecheck`. If these pass, run `npm run build` to verify client/server bundles. Do not claim the full Electron package is verified unless `npm run build:electron` is also run.

- [ ] **Step 3: Perform a manual read-only smoke check**

  With a fixture `.claude/skills` root, open `/skills`, refresh after adding a new `SKILL.md`, open its detail, and confirm the body is visible while `<script>`/raw HTML is not executed. Do not write to the user's real vault during this check.

- [ ] **Step 4: Commit verification notes**

  If no docs changed, leave the design and plan as the record and report the exact focused test/build results. If README has a sidebar route table, update only that table and commit with `docs: mention skill library`.
