# Legacy reading and intake repair

User approval: 2026-09-05, “可以，反正你要给我解决这个问题。”

## Approved outcome and boundaries

The App must read legacy documents instead of requiring manual repair of 91
files. Plugin intake is a separate workflow and must not be blocked merely by
unrelated historical schema issues. Original Markdown bodies and attachments
remain unchanged. No AI calls or knowledge ingestion are part of this repair.
All automatic write/crash experiments use independent temporary sentinel roots.

## Read design

1. Keep canonical parsers strict for future write validation. Add an explicitly
   read-only compatibility layer for syntactically unambiguous legacy forms.
   Preserve original hashes and body bytes; do not infer status or source.
2. Index compatible projections normally. Remaining schema issues stay outside
   knowledge/status counts, but are listed and readable in App settings.
3. Add paginated issue and live-document read endpoints. Allow only indexed
   Markdown under the library/knowledge roots. Preserve exact paths, validate
   live byte hashes and index consistency, and prohibit write/open side effects.
4. Use existing dark UI, left navigation and local API security. Show Chinese
   reasons, loading/empty/failure/retry states and safe plain-text originals.

## Tasks and verification

- [x] Compatibility: reproduce actual legacy shapes in synthetic unit fixtures;
      observe failure, implement minimum safe projection, retain strict failures.
- [x] Read endpoints: test pagination, denied paths, missing/stale records,
      invalid encoding and index changes, then implement.
- [x] Settings issue list/viewer: component tests for list/open/failure/retry;
      verify visually in the packaged App.
- [x] Integrate parsers into index; prove issue-to-record transitions and fresh
      persisted-cache scans. Recount real vault without modifying documents.
- [x] Rebuild and package; run regression suites and independent review.
- [ ] Resolve native execution architecture separately using platform-supported
      primitives. Do not enable formal-vault writes until recovery and conflict
      behavior have passed isolated tests. Record concrete remaining blockers.

The previous held-executable-FD startup design has failed on this Mac; it is not
an unfinished switch that can safely be toggled. Native replacement feasibility
is investigated in parallel, without weakening the existing write gate.

## Verified read delivery

Real read-only scan: 299 Markdown files, 278 canonical/compatible records,
21 unresolved metadata records. Library 27 -> 97, knowledge remains 181.
The recovered 70 retain their original 已入库 state: 64 unquoted wiki-link
lists, 3 @author scalars, 1 comma-separated wiki-link list, 2 colon-containing
remarks. All original hashes and bodies remain unchanged. The remaining 21
include 17 no-frontmatter companion files in the S1-S17 package, 3 old mixed
type/status/source schemas and 1 knowledge-note indentation problem. They must
not all be described as corrupted articles or guessed into the pending deck.

The added `/library` navigation gives archived originals an actual App entry;
default 已入库 shows 92 files, with other statuses selectable. Queue and deck
semantics are unchanged. Settings list and plain-text viewer expose unresolved
records without executing HTML or loading referenced images. This is viewing,
not a metadata editor; no original metadata repair was written to the vault.

Independent review found and fixed two P2s through RED/GREEN regressions:
SQLite-vs-JS Unicode pagination ordering, and field-looking text in a root flow
mapping's multiline scalar. Visual inspection found a narrow-window refresh
button overflow; a real Electron geometry assertion reproduced it (770px right
edge vs 686px container) and passed after the local CSS correction.

Fresh verification: 494 unit, 148 integration, 196 component, 11 native-read,
4 development/packaged Electron tests (853 total); desktop types/build and
packaging pass. No browser screenshot baselines changed. Existing large client
bundle warning remains; the older browser pixel-difference issue is not claimed
fixed by these checks.

The rebuilt `.app` was opened with the real vault: index V4 refreshed its old
cache to 21 issues and 92 archived originals; home remains 3 pending / 2 partial /
181 knowledge. The @author legacy original and a no-frontmatter S1 companion
were opened successfully in the native App. Sidebar remains left. UI at normal
window width and 720px Electron width was inspected.

Automatic archiving is **not complete**. The platform replacement feasibility
and unimplemented safety/workflow work are recorded in
[native replacement preflight](2026-09-05-native-write-replacement-preflight.md).
