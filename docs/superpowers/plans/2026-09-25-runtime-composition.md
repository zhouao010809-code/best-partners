# Runtime composition and lifecycle plan

## Goal

Make embedded-server startup and shutdown explicit and failure-safe without changing the HTTP/API contract.

## Scope

1. Add a generic reverse-order, idempotent runtime disposer with deterministic error aggregation.
2. Add unit coverage for order, idempotency, continued cleanup after errors, and registration after disposal.
3. Let `buildServer` preserve its standalone lifecycle behavior while allowing embedded startup to delegate service lifecycles to the composition boundary.
4. Replace `startServer`'s nested shutdown chain with the disposer and register resources as they are acquired.
5. Add a capability compatibility adapter so the composition root can pass explicit capabilities while legacy `buildServer` callers remain valid.
6. Extract personal resource construction into `runtime/personal-composition.ts`; keep `start-server.ts` focused on validation, HTTP assembly, assets, and listening.
7. Extract index repository/indexer/scheduler construction into `runtime/index-composition.ts` without changing refresh behavior.
8. Extract archive, ingestion, and trash service construction into `runtime/archive-composition.ts` while preserving degraded-mode fallbacks.
9. Run focused tests, full verification, and diff checks.

## Non-goals

- No route/API changes.
- No vault content migration.
- No company-runtime rewrite in this batch.

## Completion evidence

All implementation steps are complete. Failure-injection regressions cover late capability construction, recovery plus cleanup failures, original-error retention, and synchronous disposer reentry. Runtime resources are registered on acquisition and released in dependency phases. Final verification and external acceptance boundaries are recorded in [architecture acceptance](../../reviews/2026-09-25-architecture-foundation-acceptance.md).
