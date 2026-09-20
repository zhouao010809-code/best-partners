# Company Project Assistant Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在公司项目详情页增加一个可执行、可追溯的“项目助理”入口，同时保持 Codex 在网页外运行、公司 MCP 默认只读、个人“问问”完全不变。

**Architecture:** 新增一个纯前端 `CompanyProjectAssistant` 组件，使用当前已经读取到的项目和指标快照生成受控的只读任务提示词。用户选择任务后可查看完整上下文并复制给外部 Codex/WorkBuddy；页面不直接调用模型、不写项目文件。侧栏现有说明入口改名为“Agent 连接”，避免把静态说明伪装成聊天控制台。

**Tech Stack:** React 19、TypeScript、React Testing Library、Vitest、现有 company.css 与 lucide-react。

---

### Task 1: 定义项目助理提示词和状态契约

**Files:**
- Create: `src/client/components/company/CompanyProjectAssistant.tsx`
- Test: `tests/component/company-project-assistant.test.tsx`

- [ ] **Step 1: Write the failing tests**

覆盖以下真实行为：

```tsx
it('shows read-only project scope and three contextual tasks', () => {
  render(<CompanyProjectAssistant project={project} metrics={metrics} />);
  expect(screen.getByRole('heading', { name: '项目助理' })).toBeVisible();
  expect(screen.getByText('只读项目上下文')).toBeVisible();
  expect(screen.getByRole('button', { name: '分析项目现状' })).toBeVisible();
  expect(screen.getByRole('button', { name: '找平台异常' })).toBeVisible();
  expect(screen.getByRole('button', { name: '生成下周计划' })).toBeVisible();
  expect(screen.getByText('数据截至 2026-09-19')).toBeVisible();
});

it('reveals a bounded prompt with project identity and evidence scope', async () => {
  const user = userEvent.setup();
  render(<CompanyProjectAssistant project={project} metrics={metrics} />);
  await user.click(screen.getByRole('button', { name: '分析项目现状' }));
  expect(screen.getByRole('region', { name: '项目助理任务' })).toHaveTextContent('项目 ID：project-1');
  expect(screen.getByRole('region', { name: '项目助理任务' })).toHaveTextContent('先读取当前项目和官方导出指标');
  expect(screen.getByText('不会直接修改项目文件')).toBeVisible();
});

it('copies the selected prompt and exposes a truthful result state', async () => {
  const user = userEvent.setup();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  render(<CompanyProjectAssistant project={project} metrics={metrics} />);
  await user.click(screen.getByRole('button', { name: '找平台异常' }));
  await user.click(screen.getByRole('button', { name: '复制给 Codex' }));
  expect(writeText).toHaveBeenCalledOnce();
  expect(screen.getByRole('status')).toHaveTextContent('已复制任务提示，可粘贴到 Codex 或 WorkBuddy');
});

it('does not fabricate a metric date or zero values when the snapshot is unavailable', () => {
  render(<CompanyProjectAssistant project={project} metrics={undefined} />);
  expect(screen.getByText('平台数据尚未建立基线')).toBeVisible();
  expect(screen.queryByText(/播放 0/u)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx vitest run --config vitest.client.config.ts tests/component/company-project-assistant.test.tsx`

Expected: FAIL because the component and task actions do not exist.

- [ ] **Step 3: Implement the minimal component**

Define a typed `CompanyProjectAssistantProps` accepting `CompanyProject` and optional `CompanyProjectMetrics`. Keep task definitions in a local constant. Generate prompts containing only project-relative identity, lifecycle status, selected Skill IDs, metric coverage/date, and an explicit read-only instruction. Render the three task buttons, a selected-task region with a read-only `<pre>`, a “复制给 Codex” button, copy success/failure status, and a short statement that writes require the existing proposal/confirmation flow. If `navigator.clipboard.writeText` is unavailable or rejects, show a retryable error without claiming success.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npx vitest run --config vitest.client.config.ts tests/component/company-project-assistant.test.tsx`

Expected: all assistant component tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/client/components/company/CompanyProjectAssistant.tsx tests/component/company-project-assistant.test.tsx
git commit -m "feat: add company project assistant entry"
```

### Task 2: Put the assistant entry into the project detail workflow

**Files:**
- Modify: `src/client/pages/company/CompanyProjectDetailPage.tsx`
- Modify: `src/client/styles/company.css`
- Test: `tests/component/company-project-detail.test.tsx`

- [ ] **Step 1: Add failing integration assertions**

Extend the existing project detail test to assert that the project page renders “项目助理”, the current project name, the read-only badge, and the three contextual actions. Add a second assertion that selecting “生成下周计划” reveals the project-specific task region.

- [ ] **Step 2: Run the project detail test to verify it fails**

Run: `npx vitest run --config vitest.client.config.ts tests/component/company-project-detail.test.tsx`

Expected: FAIL because the page does not render the assistant component.

- [ ] **Step 3: Add the assistant section near the project heading**

Import and render `CompanyProjectAssistant` immediately after the project basic-information grid and before the metrics/upload panels, passing `project` and `metrics`. Keep it available for both operator and reviewer; it is read-only and does not depend on the metrics upload permission.

- [ ] **Step 4: Add restrained company styles**

Add styles for the assistant panel, scope badges, task button row, selected task details, prompt block, and status messages. Reuse existing company tokens, keep the layout dense, make buttons wrap on narrow screens, and add a visible focus state. Do not introduce a new dependency or a nested card hierarchy.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run --config vitest.client.config.ts tests/component/company-project-assistant.test.tsx tests/component/company-project-detail.test.tsx`

Expected: all focused tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/client/pages/company/CompanyProjectDetailPage.tsx src/client/styles/company.css tests/component/company-project-detail.test.tsx
git commit -m "feat: surface project assistant in detail page"
```

### Task 3: Correct the connection affordance and documentation

**Files:**
- Modify: `src/client/company/CompanyAppShell.tsx`
- Modify: `src/client/styles/company.css`
- Modify: `tests/e2e/company-project-onboarding.spec.ts`
- Modify: `docs/company/company-p0-operations.md`
- Modify: `README.md`

- [ ] **Step 1: Add the failing label/semantics assertion**

Update the onboarding E2E assertion to expect `打开 Agent 连接说明`, and add a check that opening it shows `默认只读` and `网页不内置聊天`. Run the targeted E2E or component equivalent to observe the expected failure before implementation.

- [ ] **Step 2: Rename the static entry and make its state explicit**

Change the sidebar button text and accessible label from “Agent 控制台” to “Agent 连接”. Keep the popover as a connection guide, add explicit badges/text for “外部 Codex / WorkBuddy” and “默认只读”, and do not add a chat input. Preserve the existing MCP boundary and session behavior.

- [ ] **Step 3: Update product documentation**

Explain that “项目助理” prepares a read-only context prompt for an external Agent, while “Agent 连接” only explains the MCP connection. State that copying a prompt is not an execution receipt and that any project write continues through the existing proposal → human confirmation flow.

- [ ] **Step 4: Run targeted verification**

Run: `npx vitest run --config vitest.client.config.ts tests/component/company-project-detail.test.tsx tests/component/company-dashboard.test.tsx` and, if the local Playwright runtime is available, `npx playwright test tests/e2e/company-project-onboarding.spec.ts`.

Expected: targeted component tests pass; report any Playwright environment blocker separately rather than weakening the assertions.

- [ ] **Step 5: Commit**

```bash
git add src/client/company/CompanyAppShell.tsx src/client/styles/company.css tests/e2e/company-project-onboarding.spec.ts docs/company/company-p0-operations.md README.md
git commit -m "docs: clarify company agent connection surface"
```

### Task 4: Final verification and review

**Files:**
- Review all files changed in Tasks 1–3.

- [ ] **Step 1: Run focused type checking and tests**

Run:

```bash
npx tsc -p tsconfig.client.json
npx vitest run --config vitest.client.config.ts tests/component/company-project-assistant.test.tsx tests/component/company-project-detail.test.tsx tests/component/company-dashboard.test.tsx
git diff --check
```

Expected: TypeScript, focused tests, and whitespace checks pass.

- [ ] **Step 2: Review the diff against the product boundary**

Confirm that no personal `AssistantPanel`, DeepSeek adapter, company MCP tool, project file, or database write path changed. Confirm prompts contain no machine absolute paths, credentials, or claims that a copied prompt was executed.

- [ ] **Step 3: Run the existing company test subset**

Run: `npm run test:component -- --runInBand` only if the repository runner supports the flag; otherwise run `npm run test:component` and record unrelated pre-existing failures without modifying them.

- [ ] **Step 4: Commit any final documentation/test-only adjustment**

Use a focused commit only if verification found a necessary correction; preserve all unrelated working-tree files and concurrent changes.

