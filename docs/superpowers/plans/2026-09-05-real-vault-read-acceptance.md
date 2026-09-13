# Real-vault read acceptance and write preflight — 2026-09-05

The user approved real-vault read acceptance, followed by safe write/recovery
work in an independent test vault and then clipper intake. This pass did not
authorize or execute formal-vault writes, document repairs, or DeepSeek calls.

## Real desktop read evidence

The packaged arm64 `小兆大脑.app` independently read `/Users/ao/我的大脑`
through `NativeReadVaultPort` / `FileSystemVaultGateway`. The embedded server
reported a ready filesystem source and index V1. No Obsidian API was used.

An independent read-only traversal found no access errors:

| Area | Markdown files | Valid records | Structure issues |
| --- | ---: | ---: | ---: |
| Library | 117 | 27 | 90 |
| Knowledge | 182 | 181 | 1 |
| Total | 299 | 208 | 91 |

The native App interface confirmed:

- Home: 3 unextracted materials, 2 partially ingested materials, 181 knowledge
  records. Only the 3 unextracted materials appear in the deck.
- Queue: 5 pending records; searching one existing title reduces the list to 1.
- Knowledge: 181 records; searching one existing title reduces the list to 1;
  opening it shows the live knowledge body and source-material reference in App.
- Settings: connected local folder, 91 structure issues, model unconfigured,
  write gate blocked. Left navigation remains visible beside the workspace.

The 91 issues are not missing files. Library issues comprise 17 files without
an opening YAML delimiter, 6 invalid YAML documents, 3 unexpected `类型` values,
and 64 `生成知识` fields parsed as nested arrays rather than string lists.
Knowledge has 1 invalid YAML document. The 3 type mismatches and all 64 link
field mismatches carry a readable `已入库` status, so they do not change the
current pending count. Those invalid records are excluded from normal results.
Neither the parser contract nor existing Markdown was changed to hide them.

This is a bounded read acceptance, not full Phase 6 acceptance. It does not
prove all historical documents are searchable or that attachment workflows,
archiving, recovery, AI, or formal ingestion are usable.

## Focus-refresh correction

Real UI navigation revealed a false unavailable state: opening home during a
focus refresh blocked its initial list fetch even while the authoritative index
was ready. The runtime resource was `refreshing`, but the dashboard accepted
only `ready`. Existing mounted pages retained their old results; this was not
the 15-second scan clearing the index.

The dashboard now also accepts a refreshing runtime with a readable ready/stale
index. It still checks the authoritative version before and after collecting
lists. Failed, building, unavailable and recovery states remain blocked. Two
regressions exercise settings-to-home navigation while refresh is held pending,
for ready and stale index states. Independent review identified a same-version
retry regression in the first change. A third test reproduced it before the
correction: the effect now explicitly observes refresh completion, while an
existing page waits during refresh. The final component suite passed 174 tests;
the reviewer independently passed all 13 dashboard-focused tests and found no
remaining actionable issue. Client/server/Electron type checks and the full
desktop runtime build also passed.

The updated `.app` was packaged and reopened against the same real vault. It
reused index V1, refreshed to V2, and retained the same 3/2/181 counts and 91
issues. After the review correction it was packaged and reopened again with the
same counts. Fresh checks this pass: 460 unit, 141 integration, 174 component,
and 4 development/packaged Electron tests passed (779 total). No browser
screenshot baseline was changed; the inherited browser pixel-difference issue
recorded in the earlier milestone was not reclassified as passing. The existing
large-bundle build warning remains.

## Phase 1 architecture blocker

The current write plan requires verifying an open helper descriptor and then
executing that exact descriptor without reopening an executable pathname. This
precondition failed on this host before any write implementation was added.

- Environment: macOS 15.5, build 24F74, arm64, Node 22.22.3.
- Read-only helper SHA-256:
  `5f91982fd366650edac97d57f508193a92677e48935314942a4bf8de74739648`.
- Direct-path `probe-root` in a self-created temporary root succeeds (diagnostic
  baseline only, not a permitted write fallback).
- Node `spawn('/dev/fd/3', ...)`, native `execve`, and native `posix_spawn` all
  fail with EACCES / errno 13. Descriptor inheritance and identity were checked.
- This SDK/runtime has no `fexecve` or `execveat` declarations, syscalls or
  dynamic symbols. Path replacement and unlink tests were confined to copies
  inside temporary fixtures.
- Direct Security.framework validation of `/dev/fd/3` succeeds before and after
  pathname replacement/unlink with the same helper identity and CDHash. Thus
  signature validation is possible, but it does not solve descriptor execution.

The independent probe sources, rerun instructions and JSONL results are retained
outside the repo at `/private/tmp/native-fd-preflight.m6F7FD/`. No production
helper command, dependency, write endpoint, capability profile or recovery
database was added. No pathname-based execution fallback was enabled.

Next decision: review a platform-supported native execution/trust boundary
before resuming Phase 1. An in-process native module or platform-managed signed
service would change the approved standalone-helper contract; neither is an
already-validated replacement. Automatic intake remains dependent on that
write/recovery foundation and is not enabled by this read acceptance.
