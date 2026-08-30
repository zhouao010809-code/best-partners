# Xiaozhao Brain Local Console MVP Implementation Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build a local, black-glass Web console that reads the existing Obsidian brain, creates reviewable AI extraction drafts, and only enables formal knowledge writes after the Local REST safety contract is proven.

**Architecture:** A single TypeScript package contains a React client, a Fastify local server, shared Zod contracts, SQLite workflow/index state, and a VaultGateway boundary. Obsidian Markdown/YAML remains the formal source of truth; SQLite stores only derived projections and unfinished local workflow state. Formal writes are fail-closed behind a real test-vault capability profile.

**Tech Stack:** Node 22, npm, React 19, Vite 8, TypeScript 6, Fastify 5, better-sqlite3, Zod, Vitest, Testing Library, Playwright

---

## Fixed locations

- Source repository: /Users/ao/Desktop/AO/04AI应用/xiaozhao-brain-console
- Approved design specification: /Users/ao/我的大脑/.superpowers/specs/2026-08-31-xiaozhao-brain-local-web-mvp-design.md
- Internal deck source kit: /Users/ao/Desktop/production-deck-source-kit-2026-08-31 2
- Formal vault: /Users/ao/我的大脑
- Runtime state: /Users/ao/Library/Application Support/xiaozhao-brain-console
- Local REST test-vault sentinel: __XIAOZHAO_TEST_VAULT__

Do not put node_modules, build output, SQLite, recovery manifests, API keys, contract sandboxes, or application source inside /Users/ao/我的大脑.

## Why the work is split

The approved specification contains four dependent products that can each be verified independently:

1. A safe local runtime and a factual Obsidian capability profile.
2. A useful read-only brain console.
3. An AI extraction and human-review workflow that still cannot write formal notes.
4. A crash-safe formal write path and final acceptance hardening.

The implementation plans are:

1. [Phase 0: Foundation and REST Contract](./2026-08-31-phase-0-foundation-rest-contract.md)
2. [Phase 1: Read-only Console](./2026-08-31-phase-1-read-only-console.md)
3. [Phase 2: Extraction Workflow](./2026-08-31-phase-2-extraction-workflow.md)
4. [Phase 3: Safe Write and Recovery](./2026-08-31-phase-3-safe-write-recovery.md)
5. [Phase 4: Hardening and Acceptance](./2026-08-31-phase-4-hardening-acceptance.md)

Execute them in that order. Phase 1 and Phase 2 may continue when the formal write gate is blocked. Phase 3 must not begin against a real vault unless Gate G2 passes or the user separately approves a replacement write gateway.

## Current verified REST evidence

On 2026-08-31, read-only inspection of the running plugin established:

- GET https://127.0.0.1:27124/ reports Local REST API with MCP 5.1.0 and Obsidian 1.13.7.
- Authenticated GET /openapi.yaml is available.
- PATCH /vault/{filename} documents If-Match and a 412 stale-version response.
- PUT /vault/{filename} does not document If-Match or If-None-Match.
- DELETE /vault/{filename} does not document If-Match.

This evidence is not permission to test writes in the formal vault. It predicts that conditional replacement may work while atomic conditional create/delete may fail. Phase 0 must prove the real behavior in an independent test vault and record a machine-readable profile.

## Gate order

| Gate | Required evidence | Failure behavior |
|---|---|---|
| G0 Isolation | Test-vault sentinel exists and every resolved root differs from /Users/ao/我的大脑 | Contract writes refuse to start |
| G1 REST read | Plugin/version/auth/list/raw bytes/Chinese path pass | Stop REST integration |
| G2 REST write CAS | Conditional create, stale replace, competing writer, conditional restore, conditional delete, and reread pass | Keep formal writes disabled |
| G3 Local security | Host, Origin, session, CSRF, CSP, path, symlink, body-size tests pass | Do not expose real-vault server |
| G4 State kernel | Migrations, WAL, constraints, integrity, backups, permissions pass | Do not start workflows |
| G5 Recovery kernel | Every crash point converges from a self-contained manifest without SQLite | Do not attach a real write gateway |
| G6 Read-only backend | Index and read APIs pass with fake and real read-only gateways | Keep console in fixture mode |
| G7 Read-only UI | Five navigation pages, MaterialDeck, search, and all states pass | Do not start AI workflow |
| G8 Draft workflow | Reading state, briefing, candidate persistence, and legacy partial recovery pass | Do not generate write plans |
| G9 Planner | Plan hash is deterministic and every version change invalidates it | Do not create write batches |
| G10 Fake coordinator | Idempotency, all crash windows, continue, rollback, and replay pass | Do not run real write tests |
| G11 Test-vault write | Full Local REST test-vault batch, conflict, restart, and recovery pass | Production write flag remains false |
| G12 Acceptance | Build, security, accessibility, visual, read-only real-vault smoke, and supervised batch pass | Do not enable routine writes |

The runtime predicate is:

~~~ts
export function mayWrite(input: {
  explicitWriteFlag: boolean;
  pluginFingerprintMatches: boolean;
  capabilityGatePassed: boolean;
  indexFresh: boolean;
  recoveryRequired: boolean;
  planVersionsCurrent: boolean;
}): boolean {
  return input.explicitWriteFlag
    && input.pluginFingerprintMatches
    && input.capabilityGatePassed
    && input.indexFresh
    && !input.recoveryRequired
    && input.planVersionsCurrent;
}
~~~

Any false value returns WRITE_GATE_CLOSED and a user-facing reason. There is no fallback to check-then-unconditional-write.

## Specification coverage audit

This mapping was checked against all sections of the approved design specification:

| Approved specification area | Implemented and verified in |
|---|---|
| Product definition, local-only scope, non-goals | Roadmap, Phase 0 Tasks 1–7 |
| Five main navigation pages and two flow routes | Phase 1 Tasks 4–6, Phase 2 Task 6, Phase 3 Task 9 |
| Dashboard counts, recent items, unique next action | Phase 1 Tasks 5–6 |
| Queue filters, schema fail-closed, resume/recover semantics | Phase 1 Task 6, Phase 2 Tasks 4 and 7 |
| Reading status 已看/未看 and required briefing | Phase 2 Tasks 3, 5, 6 |
| Candidate edit/accept/reject, reversibility, zero acceptance | Phase 2 Tasks 1, 4, 6, 7 |
| Historical 部分入库 without local draft | Phase 2 Tasks 4 and 7 |
| New versus merge, protected status, no default bypass | Phase 3 Tasks 2, 3, 9 |
| Knowledge search limited to title/YAML; live safe detail | Phase 1 Tasks 2, 3, 4, 6 |
| Operations, connection health, schema issues, SSE snapshots | Phase 1 Tasks 3 and 6, Phase 2 Task 5, Phase 3 Tasks 8–9 |
| Black glass visual language and complete page states | Phase 1 Tasks 4–6, Phase 4 Task 3 |
| Production Deck reuse boundaries and CSP-safe geometry | Phase 1 Task 5, Phase 4 Task 3 |
| Obsidian true source and SQLite workflow boundary | Phase 0 Tasks 3, 4, 6 |
| Local REST 5.1.0 real contract and fail-closed write gate | Phase 0 Tasks 3, 4, 7 |
| OpenAI-compatible minimal context, redaction, preview | Phase 2 Tasks 2, 3, 5, 6 |
| Index allowlist, polling, focus refresh, stale behavior | Phase 1 Tasks 2, 3, 6 |
| Deterministic YAML/body/source links and S1/S2 | Phase 3 Task 2 |
| Immutable plan, idempotent batch, source-last order | Phase 3 Tasks 1, 3, 6 |
| Crash-safe external manifest and SQLite-independent recovery | Phase 3 Tasks 5–7, Phase 4 Task 4 |
| Host/Origin/session/CSRF/CSP/path/size/secret safety | Phase 0 Tasks 2 and 5, Phase 4 Task 2 |
| Unit, component, integration, contract, E2E, visual tests | Every phase; consolidated in Phase 4 Tasks 1–4 |
| 1280/1440 desktop acceptance and reduced motion | Phase 1 Tasks 5–6, Phase 4 Task 3 |
| Independent source path, Git boundary, no formal-vault destructive tests | Roadmap, Phase 0 Tasks 1 and 4, Phase 4 Task 6 |

## Locked top-level file structure

All implementation plans use this single-package structure:

~~~text
xiaozhao-brain-console/
├── package.json
├── package-lock.json
├── .gitignore
├── .nvmrc
├── .env.example
├── index.html
├── tsconfig.json
├── tsconfig.client.json
├── tsconfig.server.json
├── vite.config.ts
├── vitest.config.ts
├── vitest.client.config.ts
├── vitest.integration.config.ts
├── vitest.contract.config.ts
├── playwright.config.ts
├── scripts/
├── src/
│   ├── shared/
│   │   ├── api/
│   │   └── domain/
│   ├── server/
│   │   ├── api/routes/
│   │   ├── ai/
│   │   ├── db/
│   │   ├── events/
│   │   ├── index/
│   │   ├── rules/
│   │   ├── security/
│   │   ├── vault/
│   │   └── workflow/
│   └── client/
│       ├── api/
│       ├── app/
│       ├── components/
│       ├── pages/
│       └── styles/
├── tests/
│   ├── component/
│   ├── contract/
│   ├── e2e/
│   ├── fixtures/
│   ├── integration/
│   │   └── security/
│   └── unit/
└── docs/
    ├── architecture/
    ├── contracts/
    └── superpowers/plans/
~~~

Do not convert this into a monorepo. Shared contracts are source files in src/shared, not a separately published package.

## Commit and verification policy

- Initialize Git only in /Users/ao/Desktop/AO/04AI应用/xiaozhao-brain-console.
- Never initialize Git in /Users/ao/我的大脑.
- Use one focused commit per task.
- Every behavior change follows red, green, refactor.
- Ordinary verification never targets the formal vault for writes.
- Real contract tests require ALLOW_OBSIDIAN_CONTRACT_WRITE=1 and the test-vault sentinel.
- Real-vault smoke tests are read-only until the final supervised acceptance task.

Run this baseline after every phase:

~~~bash
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:component
npm run build
~~~

Run the real plugin probe and hard gate separately:

~~~bash
npm run test:contract:obsidian:probe
npm run gate:write-capability
~~~

The probe must exit non-zero when isolation fails. It may exit zero with a blocked capability profile when the plugin accurately lacks a required operation. gate:write-capability must then exit non-zero, keep formal writes disabled, and create an architecture checkpoint.

For every RED step in every phase, the test suite must load and reach a behavioral assertion. Missing modules, syntax errors, and type errors are setup failures, not accepted RED evidence; add only the typed export shell required to reach the intended assertion before implementing behavior.
