# Phase 4 Security Hardening and MVP Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Prove the local console is secure, accessible, visually faithful, recoverable, production-buildable, and honest about whether the full formal-write MVP or only the read-only/draft product is complete.

**Architecture:** Verification is layered: deterministic unit and component tests, process-level integrations, artifact scans, Playwright browser journeys, real Local REST probes, guarded test-vault writes, and a final supervised production-vault batch only when every write gate passes. One acceptance script aggregates evidence but never hides a blocked gate.

**Tech Stack:** Existing stack, fast-check, Playwright, axe-core, production Fastify static serving, shell-free TypeScript verification scripts

---

Prerequisites: Phase 1 and Phase 2 pass. Phase 3 and real-write acceptance are conditional on G2 and G11.

### Task 1: Lock the final verification command graph

**Files:**
- Modify: package.json
- Modify: vitest.config.ts
- Modify: vitest.client.config.ts
- Modify: vitest.integration.config.ts
- Modify: vitest.contract.config.ts
- Create: scripts/verify-acceptance.ts
- Create: scripts/scan-artifacts.ts
- Test: tests/unit/verification-graph.test.ts

- [ ] **Step 1: Write a failing verification-graph test**

Parse package.json and assert the exact scripts exist:

~~~text
typecheck
test:unit
test:component
test:integration
test:security
test:deck
build
scan:artifacts
test:contract:obsidian:probe
test:contract:obsidian:restart:prepare
test:contract:obsidian:restart:verify
gate:write-capability
test:e2e
test:e2e:real-write
verify
verify:acceptance
~~~

Assert verify does not run the real write suite. Assert test:e2e:real-write runs gate:write-capability first. Assert verify:acceptance records a blocked result instead of skipping G2.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:unit -- verification-graph
~~~

Expected: the suite loads and fails because the final command graph is incomplete. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Add final scripts**

Set scripts to:

~~~json
{
  "test:deck": "npm run test:unit -- material-deck && npm run test:component -- material-deck && playwright test tests/e2e/production-deck.spec.ts",
  "scan:artifacts": "tsx scripts/scan-artifacts.ts",
  "test:e2e:real-write": "npm run gate:write-capability && playwright test tests/e2e/real-vault",
  "verify": "npm run typecheck && npm run test:unit && npm run test:component && npm run test:integration && npm run test:security && npm run test:deck && npm run build && npm run scan:artifacts",
  "verify:acceptance": "tsx scripts/verify-acceptance.ts"
}
~~~

Keep probe and gate separate. The probe may produce an accurate blocked profile with exit 0; the gate must exit 1 unless every write capability passed.

- [ ] **Step 4: Implement artifact scanning**

scan-artifacts.ts recursively scans dist, client source maps when present, generated HTML, SQLite test output, and non-secret docs. It exits non-zero if it finds:

- the actual Obsidian API key or model API key loaded from environment;
- Authorization: Bearer followed by a non-redacted value;
- ~/我的大脑 note body excerpts;
- query parameters named token, key, signature, or access_token with non-redacted values;
- runtime references to INTERNAL_SOURCE_KIT.

It must never print the secret value it is searching for; report only file and rule id.

- [ ] **Step 5: Implement acceptance aggregation**

verify-acceptance.ts executes local verify first, reads the capability profile, checks restartPersistence, then:

- if G2 is blocked, writes outcome READ_ONLY_AND_DRAFT_ACCEPTED and exits 2;
- if G2 passes but G11 evidence is absent, writes outcome TEST_VAULT_WRITE_PENDING and exits 2;
- if G2 and G11 pass, runs the guarded real-write E2E command and writes outcome FULL_MVP_TEST_VAULT_ACCEPTED;
- it never automatically writes the formal vault.

- [ ] **Step 6: Verify green and commit**

Run:

~~~bash
npm run test:unit -- verification-graph
npm run scan:artifacts
npm run typecheck
git add package.json vitest*.config.ts scripts tests/unit/verification-graph.test.ts
git commit -m "chore: lock the final verification graph"
~~~

### Task 2: Complete security, property, and secret-leak testing

**Files:**
- Create: tests/unit/server/security/vault-path-property.test.ts
- Create: tests/unit/server/security/log-redaction.test.ts
- Create: tests/integration/security/local-http-security.integration.test.ts
- Create: tests/integration/security/sse-security.integration.test.ts
- Create: tests/integration/security/secret-artifacts.integration.test.ts
- Create: tests/e2e/security.spec.ts

- [ ] **Step 1: Write path property tests**

Use fast-check to generate Unicode, separators, percent encoding, dot segments, NULs, absolute prefixes, and mixed normalization. Assert:

- accepted values normalize to NFC relative POSIX paths under the exact allowlist;
- rejected values never reach VaultGateway;
- write mode cannot target 00大脑规则, .obsidian, hidden segments, or vault root;
- resolved realpath cannot escape through a symlink;
- decoding occurs once and leftover percent-encoded traversal is rejected.

- [ ] **Step 2: Write log and artifact tests**

Inject fake secrets, source bodies, cookies, CSRF tokens, and Authorization headers into every error path. Capture Fastify logs, API envelopes, SQLite rows, SSE events, HTML, and built client assets. Assert none contain the sensitive values.

- [ ] **Step 3: Write HTTP and SSE integration tests**

Cover:

1. binding only 127.0.0.1;
2. wrong Host 421;
3. wrong Origin 403;
4. mutation without cookie 401;
5. mutation without bound CSRF 403;
6. cookie flags;
7. JSON above 1 MiB 413;
8. Markdown above 10 MiB read-only and no model/write command;
9. SSE cookie auth and no URL token;
10. Last-Event-ID resume;
11. expired cursor stream_reset plus authoritative snapshot;
12. per-response CSP nonce differs.

- [ ] **Step 4: Write browser exploit tests**

Render fixture Markdown containing script, raw HTML, iframe, object, SVG event handlers, javascript/data/file URLs, CSS injection text, and external links. Assert no execution, embedding, or unsafe protocol. Assert external links use noopener, noreferrer, and no-referrer.

Try cross-origin form POST, fetch, image, iframe, and DNS-rebinding Host requests against the production server. All state-changing attempts must fail.

- [ ] **Step 5: Run and fix behavior until green**

Run:

~~~bash
npm run test:unit -- security
npm run test:security
npm run test:e2e -- security
~~~

Expected: all path, leakage, HTTP, SSE, CSP, and browser exploit assertions pass.

- [ ] **Step 6: Commit**

~~~bash
git add tests/unit/server/security tests/integration/security tests/e2e/security.spec.ts src
git commit -m "test: harden local security and secret boundaries"
~~~

### Task 3: Complete accessibility and visual regression

**Files:**
- Create: tests/e2e/accessibility.spec.ts
- Create: tests/e2e/visual-regression.spec.ts
- Create: tests/e2e/production-deck.spec.ts
- Create: tests/e2e/screenshots/.gitkeep
- Modify: playwright.config.ts
- Test: tests/component/page-state.test.tsx

- [ ] **Step 1: Write accessibility assertions**

At minimum:

- one h1 per route;
- skip link works;
- sidebar, navigation, main, search, form, and status landmarks are named;
- route change focuses the h1;
- MaterialDeck uses roving tabindex and restores focus;
- every icon-only control has an accessible name;
- busy state announces once;
- errors and recovery changes use aria-live without stealing focus;
- colors are not the only status signal;
- axe finds zero critical or serious violations.

- [ ] **Step 2: Write viewport and reduced-motion assertions**

Test 1440x900 and 1280x800 for every page. Test 390x844 only for MaterialDeck containment and safe degradation, not as a mobile-product acceptance claim.

Assert no clipped control, root horizontal scroll, hidden focus ring, overlapping confirmation button, or unreadable source panel. With reduced motion, final bounding boxes and semantics match normal mode after animations settle.

- [ ] **Step 3: Establish project-owned screenshots**

Generate baselines only after the first target implementation is manually reviewed:

- dashboard 1440 ready;
- dashboard 1440 deck detail;
- dashboard error;
- extraction 未看 briefing;
- extraction candidate editing;
- write confirmation full diff;
- recovery required;
- knowledge detail.

The user reference image and source-kit previews are design references, not pixel baselines.

- [ ] **Step 4: Run visual and accessibility suites**

Run:

~~~bash
npm run test:e2e -- accessibility visual-regression production-deck
~~~

Expected: accessibility assertions pass and screenshots match the project-owned baselines within the configured threshold.

- [ ] **Step 5: Commit**

~~~bash
git add tests/e2e playwright.config.ts
git commit -m "test: lock accessibility and visual behavior"
~~~

### Task 4: Prove database, backup, manifest, and crash recovery lifecycle

**Files:**
- Create: tests/fixtures/crash/write-worker.ts
- Create: tests/helpers/crash-harness.ts
- Create: tests/integration/workflow/crash-boundaries.integration.test.ts
- Create: tests/integration/workflow/manifest-only-recovery.integration.test.ts
- Create: tests/integration/db/database-lifecycle.integration.test.ts

- [ ] **Step 1: Build a process-level crash harness**

Run the application worker and fake REST server in separate child processes. The parent controls request barriers and sends SIGKILL to the application worker; production classes receive no test-only crash method.

Cover:

- before manifest durable;
- after manifest durable;
- request arrived before remote apply;
- remote applied before response;
- after reread;
- after step persisted;
- before source;
- after source;
- before full verify;
- after committed before manifest cleanup.

- [ ] **Step 2: Assert restart convergence**

For every crash point:

- no success before committed;
- current before permits safe retry;
- current after marks the step complete without duplicate write;
- a third hash requires recovery;
- source is last;
- committed plus leftover manifest rereads then cleans up;
- all involved paths remain locked during recovery.

- [ ] **Step 3: Destroy a copied workflow database**

Corrupt a temporary state.sqlite3 while preserving the manifest. Assert startup preserves the damaged file, enters recovery-only mode, and can continue or roll back from manifest alone. Verify backup integrity before restoration and rotate exactly three backups.

- [ ] **Step 4: Run lifecycle tests**

Run:

~~~bash
npm run test:integration -- crash-boundaries manifest-only-recovery database-lifecycle
~~~

Expected: all process, manifest-only, database, permission, backup, and recovery assertions pass.

- [ ] **Step 5: Commit**

~~~bash
git add tests/fixtures/crash tests/helpers/crash-harness.ts tests/integration
git commit -m "test: prove crash and database recovery lifecycle"
~~~

### Task 5: Add production serving and the local operations runbook

**Files:**
- Create: src/server/web/render-index.ts
- Create: src/server/web/static-server.ts
- Modify: src/server/app.ts
- Create: docs/runbook/local-operation.md
- Create: docs/runbook/recovery.md
- Test: tests/integration/production-server.test.ts

- [ ] **Step 1: Write failing production-server tests**

Assert:

- one Fastify origin serves built HTML/assets and /api/v1;
- HTML receives a fresh nonce and no inline script/style;
- unknown client routes serve index.html;
- /api unknown routes remain JSON 404, not HTML;
- cache headers are immutable for hashed assets and no-store for HTML/API;
- server refuses host 0.0.0.0 and non-loopback values;
- missing secrets keep corresponding integration disabled;
- WRITE_ENABLED defaults false.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:integration -- production-server
~~~

Expected: the suite loads and fails at serving, nonce, routing, cache, bind, or default-gate assertions. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Implement production serving**

render-index.ts loads dist/client/index.html, injects the nonce meta value, and returns the CSP header. static-server.ts registers hashed assets and the SPA fallback without intercepting /api/v1.

Do not add Electron, DMG packaging, background daemons, cloud hosting, or remote access in MVP.

- [ ] **Step 4: Write the operations runbook**

local-operation.md includes:

1. Node 22 requirement and npm ci;
2. environment variable setup without copying secrets into files;
3. Obsidian and plugin startup;
4. npm run build and npm start;
5. expected local URL;
6. read-only default;
7. capability fingerprint status;
8. index rebuild;
9. log and data locations;
10. safe shutdown.

recovery.md includes manifest states, path locks, continue, rollback, manual conflict, SQLite recovery-only mode, and what never to delete by hand.

- [ ] **Step 5: Verify green and commit**

Run:

~~~bash
npm run build
npm run test:integration -- production-server
git add src/server/web src/server/app.ts docs/runbook tests/integration/production-server.test.ts
git commit -m "feat: serve the console as one secure local origin"
~~~

### Task 6: Run final acceptance without overstating the result

**Files:**
- Create: tests/e2e/real-vault/read-only-smoke.real.spec.ts
- Create: tests/e2e/real-vault/full-ingestion.real.spec.ts
- Create: docs/acceptance/mvp-evidence.md
- Modify: 00 handoff only through the brain repository rules after evidence exists

- [ ] **Step 1: Run the complete local verification**

Run:

~~~bash
npm ci
npm run verify
~~~

Expected: typecheck, unit, component, integration, security, deck, build, and artifact scan all exit 0.

- [ ] **Step 2: Run real plugin probe and hard gate**

Run against the independent sentinel test vault:

~~~bash
ALLOW_OBSIDIAN_CONTRACT_WRITE=1 npm run test:contract:obsidian:probe
npm run test:contract:obsidian:restart:prepare
~~~

Restart Obsidian and the plugin manually, then run:

~~~bash
npm run test:contract:obsidian:restart:verify
npm run gate:write-capability
~~~

Expected: the probe records evidence. The hard gate either exits 0 with every required capability or exits 1 and names the missing capabilities.

- [ ] **Step 3: Branch honestly on the gate**

If gate exits 1:

- do not run any real-write E2E;
- run the formal vault read-only smoke;
- record READ_ONLY_AND_DRAFT_ACCEPTED;
- state that the formal-write MVP remains blocked by Local REST capability;
- ask the user whether to plan a companion Obsidian plugin or keep draft-only.

If gate exits 0:

- run npm run test:e2e:real-write against the independent test vault;
- require G11 evidence before the supervised production batch.

- [ ] **Step 4: Run formal-vault read-only smoke**

Snapshot paths, mtimes, and raw SHA-256 for allowed Markdown files. Start the production server with WRITE_ENABLED=false. Verify counts, schema issues, search, detail opening, and extraction draft generation. Recompute the snapshot and assert no formal file changed.

- [ ] **Step 5: Run one supervised formal batch only when all gates pass**

The user explicitly selects one existing 未提炼 material and confirms the final diff. Execute one batch with WRITE_ENABLED=true. Verify:

- new or merged knowledge bytes;
- knowledge 来源资料;
- source 生成知识;
- source 知识入库状态;
- source body bytes unchanged;
- index search hit;
- committed batch and removed manifest.

Return WRITE_ENABLED=false after the supervised acceptance. No bulk write is part of this task.

- [ ] **Step 6: Record evidence**

mvp-evidence.md lists every gate, exact command, date, exit code, test count, plugin fingerprint, and outcome. It contains no keys or note bodies.

Only use the phrase FULL_MVP_ACCEPTED when G0–G12 passed. Otherwise use the exact highest achieved outcome, such as READ_ONLY_AND_DRAFT_ACCEPTED.

- [ ] **Step 7: Commit**

~~~bash
git add tests/e2e/real-vault docs/acceptance
git commit -m "docs: record evidence-backed MVP acceptance"
~~~
