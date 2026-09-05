# Desktop read milestone — execution adjustments

The user accepted the 2026-09-05 code review and its first delivery milestone.
The approved personal desktop V1 specification remains authoritative. This
increment implements independent read-only desktop use; it is not final V1.

## Work and verification

- [x] Descriptor-anchored native reader and narrow gateway; real temporary-vault
  tests prove byte fidelity, path safety, bounds and pathname-swap isolation.
- [x] Embedded same-origin server, dynamic loopback authority and truthful health;
  tests cover startup, static assets, security and idempotent shutdown.
- [x] Electron lifecycle, private settings and folder picker; test-only roots are
  validated before Electron creates any session/cache/database state.
- [x] Fixed left rail and passive index-version refresh; component tests and
  viewport geometry checks preserve the existing glass UI and pending-only deck.
- [x] Current-Mac `.app` smoke, build and independent code review; no DMG,
  notarization, publication, formal write or AI call in this increment.

## Corrections to the earlier phase plan

1. Keep filesystem path identity exactly as listed. Transport decoding happens
   once, outside the filesystem boundary. Literal percent signs and decomposed
   Unicode names must not be silently rewritten. Traversal, hidden segments,
   symbolic links and out-of-root accesses remain forbidden.
2. Use the actual `.app-frame`, `.main-navigation`, `.workspace` selectors.
   Measure the `aside.sidebar` shell, not its inset navigation, for full-height
   left-rail geometry. Do not treat `inset` versus separate edges as behavior.
3. Move the smallest installable current-Mac package smoke forward as accepted
   in the review. Rebuild native dependencies in the packaging staging tree,
   without replacing the development Node ABI modules. The full Phase 6
   distribution/security/real-vault acceptance remains outstanding.
4. Only current roadmap plans participate in migration-number validation.
   Superseded Local REST design files remain historical evidence, not active
   migration assignments.
5. Passive UI polling checks the published index version without requesting a
   rebuild on every tick. No source moves or frontmatter patches are introduced.
   Invalid plugin metadata is diagnosed rather than invented or rewritten.

## Safety and scope

All automated checks use self-created temporary fixtures and app-data roots.
The native helper exposes read commands only. No API or environment variable
can enable formal writes. Automatic intake/archiving, DeepSeek candidates,
editing, formal ingestion and recovery transactions are later increments.
Read-only file detection is not reported as successful automatic archiving.

## Baseline

The original full unit run had 355 passing tests and one failure because it
compared historical and current planned migrations together. Restricting that
test to the seven plans linked by the current roadmap produces 356/356 passing
tests before feature changes.

## Verification evidence — 2026-09-05

- `npm run verify`: 460 unit, 141 integration and 171 component tests pass;
  client/server/Electron type checks and all desktop build steps pass.
- `npm run test:native-read`: 11 native contracts pass. Real root/parent
  replacement races, byte fidelity, file types, directory and process bounds
  are exercised. A real cross-device mount test has not been run.
- The current arm64 `.app` is generated with only runtime assets/dependencies,
  native reader and SQLite migrations; no vault or environment file is bundled.
- `npm run test:electron`: 4 tests pass against the development entry and the
  actual packaged executable. Covers invalid test roots without app-data writes,
  independent indexing, automatic detection, renderer isolation, navigation
  restrictions, left-rail geometry at 720px, settings routing and clean exit.
  Packaged/home/compact/settings screenshots were captured for visual inspection.
- Full browser suite using installed Chrome: 21 pass, 1 inherited screenshot
  failure (four pixels on the selected deck button). Re-running that exact test
  on clean original `main` at `ad49f27d2714d1260fd8cca30334c6910bb4c347`
  produces the same failure and byte-identical actual PNG, SHA-256
  `6ce4a79914db8222f8af04b2f82749b1c215407e415ad22ea5085a31215b311d`.
  No snapshot, threshold or production deck code was changed to hide it.
  Default Playwright Chromium download was unavailable; Chrome was selected
  only in a temporary test configuration outside the repository.
- Vite still reports the pre-existing large client bundle warning (~558 KB
  minified). This increment does not claim bundle-size or large-vault performance
  optimization.
- Independent spec review passed after fixing synchronous pre-cache test-root
  validation and live bounded vault-readiness health. Independent code-quality
  review also passed after fixing per-vault cache isolation and cleaning up
  settings temp files on failed writes/syncs. A second reviewer independently
  ran both real-native cache-isolation tests: A to stalled/failed B never exposes
  A records, restarting A reuses its cache, and a new root inode at the same
  pathname receives a separate cache. Global settings and old caches remain.

Formal-vault acceptance, AI, automatic clipper intake, transactional writes and
distribution signing/notarization remain outside this completed read-only
implementation. The original main checkout is unchanged; changes are isolated
on `codex/desktop-read`.
