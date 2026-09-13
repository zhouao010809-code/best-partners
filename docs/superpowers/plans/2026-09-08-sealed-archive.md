# Sealed Archive Implementation Plan

**Goal:** 档案库默认关柜，银色仅作深色柜体光泽；点击锁扣开柜后调阅分类与原文。
**Architecture:** ArchiveVault owns closed/opening/open/closing visual state, mounts existing LibraryMaterials only when open. URL filters and selected file remain managed by existing page; sealing clears selected path; remount always closed. No backend or file changes.
**Tech Stack:** React, TypeScript, CSS 3D, Vitest, Playwright.

- [ ] Add failing LibraryPage test: closed page does not call listLibrary or getDocumentDetail; opening reveals content; seal hides content; remount is closed even with path query.
- [ ] Add `components/library/ArchiveVault.tsx`: finite state + cancellable transition timer, keyboard focus on open and seal, two hinged doors and lock button; preserve query navigation within session.
- [ ] Wrap existing library provider/content, clear path on seal; change navigation/title and recycle origin label to 档案库 without renaming /library, origin, APIs or source files.
- [ ] Replace scattered open folders with closed dossier boxes after cabinet opens. Categories use real folder labels/counts, not decorative numbered spines. Style in separate `archive-vault.css`, dark surfaces, edge highlights, lock rotation, reduced motion and mobile layout.
- [ ] Adapt existing library tests to explicitly open before exercising data flows; run relevant page/shell/trash tests, isolated browser checks and build.
- [ ] Client-only deployment after idle check and hash verification; read-only real UI inspection and screenshots, clear handoff and temporary backup.
