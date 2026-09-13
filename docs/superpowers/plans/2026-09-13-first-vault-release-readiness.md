# 首次建库与最终安装包上线收口实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让没有现成大脑目录的新用户可以在不接触内部术语的情况下创建第一个大脑，并用与最新源码一致的最终 macOS App 完成首次使用回归。

**Architecture:** 在 Electron 首次启动发现默认目录无效时，提供一次“创建我的大脑”分支，由后端在用户选择的父目录下创建最小、可继续使用的规则目录与必要规则文件；保留选择已有大脑目录的分支。测试使用临时父目录和临时 userData，不触碰真实大脑。最后先构建桌面运行时，再打包并用打包 App 运行同一套首启/核心流程测试。

**Tech Stack:** Electron 44, React 19, Fastify, TypeScript, Playwright Electron, Vitest.

---

### Task 1: 锁定首次建库的行为契约

**Files:**
- Modify: `tests/unit/desktop-vault-selection.test.ts`
- Modify: `tests/electron/first-run-walkthrough.test.ts`

- [x] **Step 1: Write failing unit coverage** for creating a valid initial vault under a selected parent and for cancelling creation without saving settings.
- [x] **Step 2: Run the focused unit test** and confirm it fails because no creation operation exists.
- [x] **Step 3: Cover the first-launch choice contract** with the initial-selection unit test; native Electron system dialogs remain outside Playwright's reliable automation boundary.
- [x] **Step 4: Run the focused unit test** and confirm the create branch returns before opening the picker.

### Task 2: Implement the minimal initial-vault creation flow

**Files:**
- Modify: `src/electron/settings-store.ts`
- Modify: `src/electron/main.ts`
- Modify: `src/electron/vault-selection.ts`
- Modify: `src/shared/desktop/bridge.ts`
- Modify: `src/client/app/AppShell.tsx`
- Modify: `src/client/pages/DashboardPage.tsx`
- Modify: `src/client/styles/shell.css`

- [x] **Step 1: Add a bounded creation function** that accepts only a user-selected parent directory, creates `我的大脑/00大脑规则`, `01图书馆`, `02知识库`, and `03大讲堂`, writes the starter rule files, rejects an existing collision, and returns the validated vault settings.
- [x] **Step 2: Add the first-launch dialog action** “创建我的大脑” alongside “选择已有文件夹”; explain that only the initial folder structure is created.
- [x] **Step 3: Preserve cancellation and invalid-selection behavior** so no config is saved and the app exits with ordinary-language feedback when the user cancels or chooses an unsuitable location.
- [x] **Step 4: Keep the existing configured-user path unchanged** and reuse the same vault validation after creation.
- [x] **Step 5: Run the focused unit and Electron tests** and confirm the existing first-run paths pass; the native system dialog branch remains a manual verification item.

### Task 3: Update first-run documentation and release evidence

**Files:**
- Modify: `README.md`
- Modify: `docs/reviews/2026-09-11-first-run-walkthrough.md`
- Modify: `00大脑规则/99_当前会话交接.md`

- [x] **Step 1: Document the new first-launch choice** and classify parent-directory selection as user-authorized while keeping model key, send, archive, and ingestion confirmations explicit.
- [x] **Step 2: Mark the old “no first-vault creation” limitation as resolved** and retain the unverified human-comprehension boundary.
- [x] **Step 3: Record the exact verification scope**: fresh temporary parent for creation and fresh userData for development/packaged launch, with no real credentials or external sends.

### Task 4: Build and verify the final distributable

**Files:**
- No source changes expected unless verification exposes a regression.

- [x] **Step 1: Run `npm run typecheck` and focused regression suites** for vault selection, first-run, and extraction.
- [x] **Step 2: Run `npm run package:mac` with the cached Electron archive** to rebuild the App from the final source.
- [x] **Step 3: Confirm the packaged app contains current AI feedback markers and the new Electron creation handler; record the App signature/distribution boundary.**
- [x] **Step 4: Run the packaged first-run and configured-user extraction tests against the rebuilt App.**
- [x] **Step 5: Update the readiness docs with pass/fail evidence and remaining public-release limits; do not claim formal public release readiness unless all required gates pass.**
