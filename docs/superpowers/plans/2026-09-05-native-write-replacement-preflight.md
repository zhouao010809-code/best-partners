# Native write replacement: feasibility, not enablement

> **2026-09-05 accepted amendment:** The user explicitly accepted the personal
> App/module-at-launch execution trust boundary. This preflight is historical.
> The approved personal archive implementation and its limited authority are
> tracked in [personal intake App](2026-09-05-personal-intake-app.md). Sandbox
> open remains sentinel-only; the separately built personal addon is injected
> only by trusted Electron bootstrap. Knowledge writing remains blocked.

## Evidence

The old standalone-helper held-executable-FD execution contract failed on this
Mac (see real-vault-read-acceptance). A C Node-API v8 probe now works in Node
22.22.3, Electron 44.1.0 run-as-node, and the actual Electron main process.
Reproducible source and results: `/private/tmp/xiaozhao-napi-probe.bGtQhT/`.

The independent sentinel fixtures prove exclusive whole-directory rename with
`RENAME_EXCL | RENAME_NOFOLLOW_ANY`, inode and exact body/attachment/hidden-file
and empty-directory preservation, collision preservation, symlink and traversal
denial, formal-root denial, and successful parent `fsync`. They do not prove a
production writer, source compare-and-swap, crash recovery, or power-loss safety.
No formal-vault writes or production native-code changes were made.

## Proposed replacement boundary

Use a bundled in-process C Node-API module, loaded once during trusted App
bootstrap. Retain descriptor-relative no-follow data access and all original
data protections. This is NOT equivalent to per-operation same-executable-FD
verification: code trust moves to the installed App and module at launch. The
current personal package is unsigned and must not claim resistance to malicious
same-user replacement of App code. The execution-trust revision needs to be
accepted explicitly before production write authority is enabled; the old plan's
`never N-API` condition cannot be silently ignored.

## Next implementation, bounded

1. Capture and test the revised native interface only in sentinel roots; exact
   root/parent/member identity, private before-images, no overwrite or unlink.
2. Add a durable intent/result journal and restart reconstruction before any
   production intake. Test crashes and source/target replacement races.
3. Connect stable clipper packages to a metadata-and-move plan. Preserve original
   body and every attachment. Two stable scans are a quiescence heuristic, not a
   writer lock; before/after mismatch must pause visibly without silent success.
4. Integrate App preview/confirmation, outcome and recovery states. Only then
   consider formal-vault enablement. Historical schema issues do not globally
   prevent intake of an independently valid package.

At preflight time, the source had no intake service, write coordinator, or
recovery kernel. The subsequent bounded implementation is tracked in
[sandbox archive and recovery](2026-09-05-sandbox-archive-recovery.md): it adds a
sentinel-only whole-package move coordinator and immutable recovery records,
without enabling App or formal-vault writes. Production intake, metadata/name
planning, external recovery storage and write authorization remain unfinished.
This is progress past a platform blocker, not completed automatic archive.
