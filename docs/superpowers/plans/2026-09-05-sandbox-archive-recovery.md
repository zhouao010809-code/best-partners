# Sandbox archive and restart recovery

Approved next step: safe archive and interruption recovery, with isolated test
materials first. This implements the bounded next slice in the native replacement
preflight, not the old Phase 1 execution contract or production enablement.

## Boundaries

- Only newly created private temporary roots with an exact archive-test sentinel.
- Move one unchanged directory package from clipper to an existing platform/month
  directory. No metadata rewrite, directory creation, deletion, rollback, AI,
  knowledge writes, watcher, App API or formal-vault capability change.
- Native module holds root and private recovery descriptors and an exclusive
  advisory lock. No-follow reads include hidden files and empty directories.
- The execution trust change remains unapproved for production. This module is
  not loaded by the App and cannot open a normal vault.

## Implementation and acceptance

- [x] Native sandbox port and contract tests: guarded open/close, bounded full
  reads/list/stat, exclusive move, parent synchronization, immutable private
  journal create/read/list. Reject wrong root, sentinel, permissions, links,
  traversal, collisions, identity drift, and concurrent handles.
- [x] Snapshot and intent: deterministic full-tree identity/content snapshot,
  16 MiB total before-images (10 MiB per file), strict paths and bounded entries/depth; intent binds
  root, both parents, exact source/destination and before-images; the sealed
  journal is capped at 32 MiB before any persistence. Persist and
  verify the immutable intent before any move.
- [x] Coordinator and recovery: verify original snapshot immediately before
  moving and destination immediately after. Synchronize parents before result.
  Recovery classifies without moving: source-only unchanged is not-moved;
  target-only identical is moved; both/neither/changed/corrupt is needs-review.
  Even a previous success is rechecked against current disk state. Reusing an ID
  with a changed request is rejected. Unresolved intents prevent new mutations.
- [x] Real process tests: kill after persisted intent, after native move, and
  before result persistence; restart with a fresh handle and reconstruct from
  journal, without SQLite. Verify complete before-images and preserved files.
- [x] Independent spec then quality review; unit/integration/native regression.

## Limits that must remain visible

macOS rename is not expected-inode CAS. A racing replacement may move; mismatched
post-state is retained for review, never automatically reversed. Stable snapshots
are observations, not a producer lock. Process-kill tests do not prove power-loss
durability. Private recovery in this sandbox lives beneath its temporary root;
production needs separately bound external App recovery storage. No result in
this slice means that metadata normalization, indexing or automatic archive UI
has completed.

## Verification, 2026-09-05

- `npm run verify`: 525 unit, 148 integration, 196 component tests; typecheck,
  read-helper, client/server and Electron builds pass. Existing 570.77 kB client
  chunk warning remains unchanged.
- `npm run test:sandbox-archive`: 24 native contracts and 14 recovery/runtime
  checks pass, including four process-kill boundaries and actual Electron main.
- `npm run test:native-read`: the existing 11 native read contracts still pass.
- Independent review: SPEC then CODE QUALITY passed after the boundary fixes;
  reviewer reran 31 TypeScript/packaging, 24 native and 13 process-recovery checks.
- This turn did not rebuild/replace the installed `.app` or run the separate four
  packaged/development UI tests; no UI behavior changed. A regression test verifies
  the packaging filter excludes both sandbox `.node` binaries.

Review-driven RED/GREEN corrections: missing final receipt, oversized sealed
intent with many long paths, noncanonical intent BOM/UUID, package root renaming,
post-fsync inode race, package-relative depth versus source/target prefix depth,
and target-relative path byte overflow. Native preflight now checks both source
and destination member paths before rename, including the platform path limit.

Remaining production work is explicit: trusted execution acceptance and external
App recovery binding, metadata and safe main-document naming, missing-month
creation with recovery, clipper package selection/stability and attachment
ownership, index finalization, App enable/preview/outcome/recovery controls. This
isolated kernel is not an automatic-archive delivery or a complete personal V1.
