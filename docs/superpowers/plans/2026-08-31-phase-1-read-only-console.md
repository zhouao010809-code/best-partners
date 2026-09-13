# Phase 1 Read-only Brain Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Deliver a useful local read-only console with real Obsidian projections, the approved black-glass UI, MaterialDeck, queue, knowledge search, operations, and connection diagnostics.

**Architecture:** SearchIndexer reads allowed Markdown through VaultGateway, validates current YAML contracts, and stores only titles, allowed recall fields, hashes, versions, and links in SQLite. Fastify exposes versioned read APIs. React renders five main pages; full Markdown is fetched only after the user opens a detail.

**Tech Stack:** Phase 0 stack plus YAML parsing, React Router, React Markdown without raw HTML, Testing Library, and Playwright

---

Prerequisites: Phase 0 local verification passes. G2 may be blocked; this entire phase must remain read-only.

### Task 1: Parse current vault contracts without changing bytes

**Files:**
- Create: src/shared/domain/records.ts
- Create: src/server/rules/frontmatter.ts
- Create: src/server/rules/library-schema.ts
- Create: src/server/rules/knowledge-schema.ts
- Create: src/server/rules/wikilinks.ts
- Create: src/server/rules/rule-bundle.ts
- Create: tests/fixtures/library-valid.md
- Create: tests/fixtures/library-schema-anomaly.md
- Create: tests/fixtures/knowledge-valid.md
- Test: tests/unit/frontmatter-rules.test.ts

- [ ] **Step 1: Write failing rule tests**

Cover:

~~~ts
expect(parseLibraryNote(validBytes).record.knowledgeStatus).toBe('未提炼');
expect(parseLibraryNote(anomalyBytes).issues[0]?.code).toBe('UNEXPECTED_TYPE');
expect(parseKnowledgeNote(validKnowledge).record.usageStatus).toBe('AI总结');
expect(parsed.bodyBytes).toEqual(originalBodyBytes);
expect(extractWikiLinks('[[A]] and [[B|label]]')).toEqual(['A', 'B']);
~~~

Also assert the exact current enums:

- source platforms: B站, YouTube, 抖音, 小红书, 公众号, 飞书, X推特, Reddit, 小宇宙, 独立站, 个人, 其他;
- knowledge status: 未提炼, 部分入库, 已入库;
- usage status: AI总结, 已优化, 定论, 过时;
- knowledge type: 概念, 原理, 模型, 方法, SOP, 标准, 案例, 数据, 观点, 素材.

Add rule-bundle tests that read the current required files through VaultGateway, compute a bundle SHA-256, expose the exact source paths, and mark compatibility stale when the bundle changes after startup. A stale rule bundle keeps read-only pages available but closes candidate generation and write planning until the implementation contract is reviewed.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:unit -- frontmatter-rules
~~~

Expected: the suite loads and fails at YAML, enum, wikilink, or byte-slice behavior assertions. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Define the shared projections**

Create src/shared/domain/records.ts:

~~~ts
export type KnowledgeStatus = '未提炼' | '部分入库' | '已入库';
export type UsageStatus = 'AI总结' | '已优化' | '定论' | '过时';

export type MaterialRecord = {
  path: string;
  rawSha256: string;
  upstreamVersion?: string;
  title: string;
  sourcePlatform: string;
  processingStatus: '未归档' | '已归档';
  knowledgeStatus: KnowledgeStatus;
  collectedAt?: string;
  generatedKnowledge: string[];
};

export type KnowledgeRecord = {
  path: string;
  rawSha256: string;
  upstreamVersion?: string;
  title: string;
  sourceType: 'AI提炼' | '人工输入';
  usageStatus: UsageStatus;
  knowledgeType: string;
  recallFields: {
    topics: string[];
    keywords: string[];
    scenarios: string[];
    conclusion: string;
    keyPoints: string[];
    boundary: string;
  };
  sourceMaterials: string[];
};
~~~

- [ ] **Step 4: Implement byte-aware frontmatter parsing**

frontmatter.ts locates the first opening and closing YAML delimiters in Uint8Array data, decodes only that slice, and keeps bodyBytes as an untouched subarray. It must reject a missing closing delimiter, duplicate YAML keys, aliases, and non-object YAML roots. The parser never serializes a source note in this phase.

library-schema.ts and knowledge-schema.ts validate with Zod and return either a record or a structured SchemaIssue. Use the filename without .md only when 原始标题 is absent.

rule-bundle.ts reads only 00大脑规则/00_大脑规范.md, 00大脑规则/03_知识库提炼与入库规则.md, and the path/link rules needed by the operation. It does not parse free-form prose into new permissions. It exposes the trusted text excerpts for AI prompts plus a fingerprint compared by health and write gates.

- [ ] **Step 5: Verify green**

Run:

~~~bash
npm run test:unit -- frontmatter-rules
npm run typecheck
~~~

Expected: all parser, enum, anomaly, and byte-slice tests pass.

- [ ] **Step 6: Commit**

~~~bash
git add src/shared/domain src/server/rules tests/fixtures tests/unit/frontmatter-rules.test.ts
git commit -m "feat: parse current brain note contracts"
~~~

### Task 2: Build the derived index and freshness state

**Files:**
- Create: src/server/index/SearchIndexer.ts
- Create: src/server/index/index-state.ts
- Create: src/server/index/index-repository.ts
- Create: src/server/index/index-scheduler.ts
- Create: src/server/vault/FakeVaultGateway.ts
- Test: tests/integration/search-indexer.test.ts
- Test: tests/unit/index-state.test.ts

- [ ] **Step 1: Write failing index tests**

Use FakeVaultGateway fixtures to assert:

- only current 类型: 原始资料 enters the material projection;
- the three historical nonstandard types become schema issues, not queue rows;
- only 类型: 知识笔记 enters the knowledge projection;
- raw body text is absent from SQLite;
- default knowledge search excludes 过时;
- external create, modify, rename, and delete update the projection;
- two failed polls or 60 seconds without success marks the index stale;
- a source rename invalidates the old path instead of preserving a fake stable id.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:integration -- search-indexer
~~~

Expected: the suite loads and fails at projection exclusion, mutation, or stale-state assertions. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Implement the fake gateway and repository**

FakeVaultGateway implements the same read interface as LocalRest51Gateway and provides explicit mutateFixture methods only to tests. index-repository.ts writes canonical JSON for YAML recall fields and links, uses transactions per indexing batch, and never stores body Markdown.

Expose these repository methods:

~~~ts
export interface IndexRepository {
  replaceFile(entry: IndexedFile): void;
  removeFile(path: string): void;
  replaceIssue(issue: SchemaIssue): void;
  clearIssue(path: string): void;
  listMaterials(query: MaterialQuery): Page<MaterialRecord>;
  listKnowledge(query: KnowledgeQuery): Page<KnowledgeRecord>;
  getKnowledge(path: string): KnowledgeRecord | undefined;
}
~~~

- [ ] **Step 4: Implement deterministic indexing**

SearchIndexer recursively lists 01图书馆 and 02知识库, follows directory entries only, reads .md files, and rejects hidden path segments. It computes a manifest diff from path + contract-proven note metadata + upstreamVersion + rawSha256. Changed files are parsed; removed paths are deleted from the projection. If the Phase 0 profile cannot prove metadata change detection, every poll performs bounded raw rereads and the index remains refreshing until the complete allowed set is checked; it must not treat an unreliable mtime as authoritative.

index-state.ts exposes:

~~~ts
export type IndexState =
  | { status: 'building'; startedAt: string }
  | { status: 'ready'; version: number; refreshedAt: string }
  | { status: 'stale'; version: number; lastSuccessAt: string; reason: string }
  | { status: 'failed'; lastSuccessAt?: string; reason: string };
~~~

index-scheduler.ts runs every 15 seconds, accepts an immediate focus refresh command, and marks stale after exactly the approved thresholds. No timer is active in unit tests; inject a clock and scheduler.

- [ ] **Step 5: Verify green**

Run:

~~~bash
npm run test:unit -- index-state
npm run test:integration -- search-indexer
~~~

Expected: all index, exclusion, mutation, and stale tests pass.

- [ ] **Step 6: Commit**

~~~bash
git add src/server/index src/server/vault/FakeVaultGateway.ts tests
git commit -m "feat: build a reconstructable vault index"
~~~

### Task 3: Expose versioned read APIs and safe Markdown details

**Files:**
- Create: src/shared/api/schemas.ts
- Create: src/shared/api/envelopes.ts
- Create: src/server/api/routes/materials.ts
- Create: src/server/api/routes/knowledge.ts
- Create: src/server/api/routes/operations.ts
- Create: src/server/api/routes/index-jobs.ts
- Create: src/server/api/routes/health.ts
- Create: src/server/services/read-service.ts
- Modify: src/server/app.ts
- Test: tests/integration/read-api.test.ts

- [ ] **Step 1: Write failing route tests**

Assert:

- GET /api/v1/materials returns only 未提炼 and 部分入库 by default.
- filters include status, source platform, date, and title.
- GET /api/v1/knowledge searches only title and YAML recall fields.
- 过时 is absent unless explicitly requested.
- GET /api/v1/knowledge/file rejects a disallowed path and returns live Markdown only for an indexed knowledge note.
- POST /api/v1/knowledge/open requires session and CSRF, validates the indexed path, and invokes only Local REST /open/{filename}; it never writes note bytes.
- GET /api/v1/operations returns an empty versioned page before workflows exist.
- POST /api/v1/index-jobs/rebuild requires session, CSRF, index version, and idempotency key.
- GET /api/v1/index-jobs/:id returns the authoritative rebuild snapshot used after stream reset.
- every error includes code, message, and operationId without secrets.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:integration -- read-api
~~~

Expected: the suite loads and fails at an HTTP status, envelope, filter, or safe-detail assertion. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Define API envelopes**

Create src/shared/api/envelopes.ts:

~~~ts
export type ApiSuccess<T> = {
  data: T;
  version: number;
  operationId?: string;
};

export type ApiFailure = {
  error: {
    code: string;
    message: string;
    operationId: string;
    fields?: Readonly<Record<string, string>>;
  };
};

export type Page<T> = {
  items: T[];
  nextCursor?: string;
};
~~~

schemas.ts defines Zod input and output schemas for health, materials, knowledge cards, live detail, operations, schema issues, and index jobs. Route handlers parse both input and service output.

- [ ] **Step 4: Implement read services and routes**

read-service.ts reads cards from IndexRepository. Knowledge detail rereads the real file through VaultGateway, verifies the hash against the projection, then returns Markdown plus a current version marker. Do not ask Local REST for rendered HTML. The explicit open command calls a dedicated openInObsidian gateway method after path validation and does not require the formal write capability gate.

POST index rebuild creates an idempotent local operation and calls SearchIndexer; it never writes the vault.
GET index job returns its persisted state, progress, index version, and operation id.

- [ ] **Step 5: Verify green**

Run:

~~~bash
npm run test:integration -- read-api
npm run typecheck
~~~

Expected: all route, filter, safe-detail, and error-envelope tests pass.

- [ ] **Step 6: Commit**

~~~bash
git add src/shared/api src/server/api src/server/services src/server/app.ts tests/integration/read-api.test.ts
git commit -m "feat: expose versioned read-only brain APIs"
~~~

### Task 4: Build the black-glass application shell and complete state system

**Files:**
- Create: src/client/app/router.tsx
- Create: src/client/app/AppShell.tsx
- Create: src/client/api/client.ts
- Create: src/client/components/PageState.tsx
- Create: src/client/components/SafeMarkdown.tsx
- Create: src/client/styles/tokens.css
- Create: src/client/styles/global.css
- Create: src/client/styles/shell.css
- Modify: src/client/App.tsx
- Modify: src/client/main.tsx
- Test: tests/component/app-shell.test.tsx
- Test: tests/component/safe-markdown.test.tsx

- [ ] **Step 1: Write failing shell and Markdown tests**

Assert five and only five main navigation items:

~~~ts
expect(screen.getAllByRole('link', { name: /大脑总览|提炼队列|知识库|操作记录|系统连接/ }))
  .toHaveLength(5);
~~~

Assert /extractions/:id and /write-plans/:id are routable but absent from the sidebar. Assert loading, empty, refreshing, disconnected, validation error, operation error, busy, success, conflict, and recovery required all have text plus an icon label.

SafeMarkdown tests must prove script, iframe, event attributes, javascript URLs, and raw HTML do not execute or render. External links get noopener noreferrer and no-referrer.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:component -- app-shell safe-markdown
~~~

Expected: the suite loads and fails at navigation, state, landmark, or malicious-Markdown behavior assertions. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Add tokens and shell**

tokens.css defines near-black surfaces, silver borders, neon green primary, amber pending, red failure, blue information, type scale, spacing, and focus ring. Do not create multiple competing accent greens.

AppShell includes skip link, sidebar landmarks, active route state, connection badge, main heading focus on navigation, and a content area. Use lucide-react only.

PageState receives a discriminated state and always renders a visible label. It must not rely on color alone.

- [ ] **Step 4: Add safe Markdown**

Use react-markdown with remark-gfm and no rehypeRaw. Override links to reject protocols other than http and https; render rejected links as text. Obsidian file opening is a separate explicit application action, not a Markdown link protocol.

- [ ] **Step 5: Verify green**

Run:

~~~bash
npm run test:component -- app-shell safe-markdown
npm run typecheck
~~~

Expected: all navigation, state, landmark, and malicious Markdown tests pass.

- [ ] **Step 6: Commit**

~~~bash
git add src/client tests/component
git commit -m "feat: add the black-glass application shell"
~~~

### Task 5: Port Production Deck into MaterialDeck

**Files:**
- Create: src/client/components/material-deck/materialDeckLayout.ts
- Create: src/client/components/material-deck/MaterialDeck.tsx
- Create: src/client/components/material-deck/MaterialDeckDetail.tsx
- Create: src/client/components/material-deck/useDeckStyleSheet.ts
- Create: src/client/components/material-deck/material-deck.css
- Create: src/client/components/material-deck/SOURCE.md
- Test: tests/unit/client/material-deck/material-deck-layout.test.ts
- Test: tests/unit/client/material-deck/material-deck-source-boundary.test.ts
- Test: tests/component/material-deck/MaterialDeck.test.tsx
- Test: tests/component/material-deck/MaterialDeck.csp.test.tsx
- Test: tests/e2e/production-deck.spec.ts
- Source reference: INTERNAL_SOURCE_KIT/portable/src

- [ ] **Step 1: Write layout tests before copying code**

For counts 1, 7, 9, 25, and 100, assert finite geometry, stable order, selected card mode active, and rail count N - 1. Add hover non-action, ArrowLeft/ArrowRight, Enter/Space, Escape, focus restore, long-press preview without business state, reduced motion, and two-instance isolation tests.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:unit -- material-deck-layout
npm run test:component -- material-deck
~~~

Expected: all suites load and fail at layout, interaction, CSP, or source-boundary behavior assertions. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Port only the approved domain-free layout**

Copy the mathematical layout into materialDeckLayout.ts and rename all Production terms. Define:

~~~ts
export type MaterialDeckCard = {
  key: string;
  path: string;
  title: string;
  sourcePlatform: string;
  collectedAt?: string;
  knowledgeStatus: '未提炼' | '部分入库';
  nextAction: 'start' | 'resume' | 'recover';
};
~~~

Remove LarkRecord, publishing stages, schedule actions, DataRecoveryDeck, Ant Design icons, archive flight, onGoPlanning, and onGoContent.

SOURCE.md records the internal source-kit absolute origin, adaptation date, reused layout/interaction ideas, and that no public license claim is made. The application has no runtime dependency on that desktop folder.

- [ ] **Step 4: Replace inline style properties with nonce-scoped CSS**

useDeckStyleSheet reads the csp-nonce meta value. It generates a unique alphanumeric instance id and one nonce-bearing style element. The CSS text may interpolate only validated finite numbers and numeric card indexes:

~~~ts
export function numericCss(value: number): string {
  if (!Number.isFinite(value)) throw new Error('NON_FINITE_DECK_LAYOUT');
  return String(Math.round(value * 1000) / 1000);
}
~~~

MaterialDeck uses data-deck-instance and data-card-index attributes. It must contain no React style prop and no fixed DOM id.

MaterialDeck.csp.test.tsx must render two instances and assert distinct scoped selectors, distinct selection/focus state, a nonce-bearing dynamic style element, no style attribute, and no duplicate production-deck-title or production-card-detail id.

material-deck-source-boundary.test.ts scans imported target source and fails on @ant-design/icons, Lark, publish, schedule, archive, DataRecoveryDeck, runtime references to the desktop source-kit path, or React style properties.

- [ ] **Step 5: Apply the approved visual mapping**

Collapsed cards are white/silver glass with a persistent short status badge. Only the active detail uses neon green for the primary action. Labels are 开始提炼, 继续审阅, or 恢复提炼. Long press is an enhancement, never the only way to open or confirm.

- [ ] **Step 6: Verify green**

Run:

~~~bash
npm run test:unit -- material-deck-layout
npm run test:component -- material-deck
npm run test:e2e -- production-deck
~~~

Expected: all geometry, keyboard, pointer, CSP, multi-instance, and browser screenshot tests pass. The Playwright suite covers 1440x820, 1280x800, and 390x844, confirms root has no horizontal overflow, and verifies reduced-motion final geometry. Search the source and confirm no antd, Lark, ProductionCard, DataRecoveryDeck, onGoPlanning, or style property remains.

Only the reusable layout and interaction tests are adapted. Do not migrate the source kit's 13 Cockpit/Feishu tests or 11 DataRecoveryDeck tests, and do not preserve publishing or archive state-machine assertions.

- [ ] **Step 7: Commit**

~~~bash
git add src/client/components/material-deck tests
git commit -m "feat: adapt the source deck into MaterialDeck"
~~~

### Task 6: Complete the five read-only pages and real-vault read smoke

**Files:**
- Create: src/client/pages/DashboardPage.tsx
- Create: src/client/pages/MaterialQueuePage.tsx
- Create: src/client/pages/KnowledgeLibraryPage.tsx
- Create: src/client/pages/OperationsPage.tsx
- Create: src/client/pages/ConnectionsPage.tsx
- Create: src/client/components/KnowledgeDetail.tsx
- Create: src/client/components/MaterialFilters.tsx
- Test: tests/component/read-pages.test.tsx
- Test: tests/e2e/read-only-console.spec.ts
- Create: playwright.config.ts

- [ ] **Step 1: Write component tests for each page**

Dashboard asserts connection/index status, 未提炼, 部分入库, formal knowledge, upgradeable corpus counts, MaterialDeck, recent knowledge, and recent operations.

Queue asserts only valid pending materials, status/source/date/title filters, live path, and no edit/delete control.

Knowledge asserts title/YAML search, usage/type/domain filters, 过时 excluded by default, and no body fetch until detail opens.
Knowledge detail displays 来源资料, 02知识库 internal links, and an explicit Open in Obsidian action; it does not read 03大讲堂 or expose an edit control.

Operations asserts an honest empty state before workflows exist.

Connections asserts plugin, index, model, write gate, schema issue count, and no secret text.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:component -- read-pages
~~~

Expected: the suite loads and fails at the first page-specific content or interaction assertion. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Implement pages using the shared API client**

api/client.ts validates every response with shared Zod schemas, sends credentials same-origin, includes CSRF and idempotency headers only on commands, and maps stable errors to PageState. Do not add a global state library.

Implement each page exactly to its component assertions. The primary dashboard CTA navigates to an extraction route but remains disabled with a clear message until Phase 2 is installed.
Register a window-focus listener that requests an immediate index refresh; the server remains authoritative for the 15-second schedule and stale threshold.

- [ ] **Step 4: Add Playwright read-only journey**

Use a fake gateway server fixture for deterministic E2E:

1. Open dashboard at 1280x900 and 1440x1000.
2. Open a MaterialDeck card by keyboard and close with Escape.
3. Filter queue to 部分入库.
4. Search knowledge by 核心结论 text.
5. Open detail and confirm the body request occurs once.
6. Verify malicious Markdown does not create script, iframe, or javascript link.
7. Verify reduced-motion and focus restore.

Install the pinned browser once before the first Playwright run:

~~~bash
npx playwright install chromium
~~~

- [ ] **Step 5: Verify the independent app**

Run:

~~~bash
npm run test:component
npm run build
npm run test:e2e -- read-only-console
~~~

Expected: all read-only page, viewport, keyboard, and safe-render tests pass.

- [ ] **Step 6: Run a real-vault read-only smoke**

Start with WRITE_ENABLED=false and the formal Local REST credentials. Verify:

- runtime counts are not hard-coded;
- the three known schema anomalies are excluded and reported;
- no request method other than GET reaches /vault during the smoke;
- opening a knowledge detail rereads the real path;
- no file mtime or hash changes in 00大脑规则, 01图书馆, or 02知识库.

- [ ] **Step 7: Commit**

~~~bash
git add src/client/pages src/client/components src/client/api playwright.config.ts tests
git commit -m "feat: deliver the read-only brain console"
~~~
