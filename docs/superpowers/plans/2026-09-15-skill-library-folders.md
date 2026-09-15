# Skill 库自定义文件夹与访达定位 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox ( - [ ] ) syntax for tracking.

**Goal:** 在现有只读 Skill 库上增加一层真实本地文件夹、点击移动 Skill 和在访达定位 SKILL.md 的最小管理能力。

**Architecture:** 把现有 SkillCatalogService 扩展为固定 .claude/skills 根目录下的有界读写服务：根目录直接 Skill 属于“未分类”，根目录下一层目录是用户文件夹，文件夹下再一层是 Skill。列表和两个写操作通过受 CSRF 保护的 API 暴露；Electron 通过只接收 opaque skillId 的 bridge 解析并定位源文件。React 页面保留现有只读详情，增加新建文件夹、移动菜单和访达按钮。

**Tech Stack:** TypeScript, Fastify, Zod, React 19, React Router 7, Electron IPC, Node fs/promises, Vitest, Testing Library, Playwright Electron。

---

## 文件结构与职责

- Modify: src/shared/api/skills.ts — 文件夹、归属字段和创建/移动请求响应的严格 schema 与类型。
- Modify: src/server/services/skill-catalog.ts — 一层目录发现、文件夹创建、Skill 移动、源文件解析与路径安全检查。
- Modify: src/server/api/routes/skills.ts — POST /folders 与 POST /:id/move，保留现有 GET 路由。
- Modify: src/server/start-server.ts, src/server/app.ts — 注入可复用 catalog，并仅在 filesystem 适配器启用写接口。
- Modify: src/client/api/client.ts — 新增创建文件夹和移动 Skill 的客户端方法。
- Modify: src/client/pages/SkillsPage.tsx, src/client/styles/skills.css — 文件夹栏、新建表单、移动菜单、访达状态和错误反馈。
- Create: src/electron/skill-navigation.ts — 通过 opaque ID 安全解析并调用 Finder。
- Modify: src/electron/main.ts, src/electron/preload.ts, src/shared/desktop/bridge.ts, src/client/vite-env.d.ts — 注册受保护的 revealSkill bridge。
- Modify: tests/unit/skill-catalog.test.ts, tests/integration/skill-api.test.ts, tests/component/skills-page.test.tsx — 服务、API、页面行为回归。
- Create: tests/unit/desktop-skill-navigation.test.ts — Finder 解析边界。
- Modify: tests/electron/desktop-launch.test.ts — bridge 清单回归。
- Create: tests/electron/skill-library-folders.test.ts — 隔离 Electron 真实目录创建/移动/刷新/定位流程。
- Modify: README.md — 在能力表中补充 Skill 文件夹管理和源文件定位说明。

## Task 1: 扩展安全 Skill catalog 数据模型与文件操作

**Files:**
- Modify: src/shared/api/skills.ts
- Modify: src/server/services/skill-catalog.ts
- Test: tests/unit/skill-catalog.test.ts

- [ ] **Step 1: 先写一层目录和写操作的失败测试**

在现有临时 fixture 中加入根目录 Skill、空的 通用 文件夹、通用/写作 Skill、隐藏目录、符号链接和 scripts 目录。先加入下列行为测试：

~~~
it('lists uncategorized skills, one-level folders, and empty folders', async () => {
  const result = await catalog.list();
  expect(result.folders).toEqual([{ id: folderId('通用'), name: '通用', skillCount: 1 }]);
  expect(result.items.map(item => [item.name, item.folderName])).toEqual([
    ['root-skill', null],
    ['写作', '通用']
  ]);
});

it('creates a named folder without creating a Skill file', async () => {
  await expect(catalog.createFolder('发布')).resolves.toMatchObject({ name: '发布', skillCount: 0 });
  await expect(stat(join(skillsRoot, '发布'))).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  await expect(access(join(skillsRoot, '发布', 'SKILL.md'))).rejects.toThrow();
});

it('moves a Skill to a folder and back without changing its bytes', async () => {
  const before = await readFile(join(skillsRoot, 'root-skill', 'SKILL.md'));
  const moved = await catalog.move(skillId('root-skill'), folderId('通用'));
  expect(moved.folderName).toBe('通用');
  await expect(readFile(join(skillsRoot, '通用', 'root-skill', 'SKILL.md'))).resolves.toEqual(before);
  await catalog.move(skillId('root-skill'), null);
  await expect(readFile(join(skillsRoot, 'root-skill', 'SKILL.md'))).resolves.toEqual(before);
});
~~~

同时断言空名称、路径分隔符、隐藏名、保留名、重复文件夹、未知 folder ID、同名目标、符号链接和越界 ID 都返回明确错误，且没有调用 rename 或覆盖已有目录。

- [ ] **Step 2: 运行测试并确认是功能缺失导致失败**

Run:

~~~bash
npx vitest run --config vitest.config.ts tests/unit/skill-catalog.test.ts
~~~

Expected: 新增用例因 folders、createFolder 或 move 未定义而失败；现有只读安全用例仍能运行。

- [ ] **Step 3: 扩展共享 schema 与类型**

在 src/shared/api/skills.ts 增加：

~~~ts
export const skillFolderIdSchema = sha256Schema;
export const skillFolderSchema = z.strictObject({
  id: skillFolderIdSchema,
  name: skillNameSchema,
  skillCount: z.number().int().nonnegative().max(1_000)
});
export const skillFolderCreateRequestSchema = z.strictObject({ name: skillNameSchema });
export const skillMoveRequestSchema = z.strictObject({ folderId: skillFolderIdSchema.nullable() });
export const skillFolderResponseSchema = successEnvelopeSchema(skillFolderSchema);
export const skillMoveResponseSchema = successEnvelopeSchema(skillSummarySchema);
~~~

把 folderId: string | null 与 folderName: string | null 加入 skillSummarySchema，并把 skillsPageSchema 改为 { folders, items }。保留现有 opaque Skill ID、revision、detail Markdown 和 references 的大小限制。

- [ ] **Step 4: 将 catalog 重构为一层目录发现器**

在 src/server/services/skill-catalog.ts 保留现有 canonical root 校验和 readBoundedRegularFile，把发现结果统一为：

~~~ts
type DiscoveredSkill = {
  directoryName: string;
  directoryPath: string;
  directoryRealPath: string;
  folderName: string | null;
  folderPath: string;
  bytes: Buffer;
};

type DiscoveredFolder = {
  id: string;
  name: string;
  path: string;
  skills: DiscoveredSkill[];
};
~~~

实现以下规则：根目录直接含 SKILL.md 的目录生成未分类 Skill；根目录不含 SKILL.md 的安全目录生成自定义文件夹，只检查其直接子目录；空文件夹进入 folders；隐藏目录、符号链接、scripts、env 和第三层嵌套不进入列表；folderId(name) 与 skillId(directoryName) 都使用 SHA-256；发现同名 Skill 目录两次时抛出 SKILL_LAYOUT_CONFLICT；list 稳定排序并把未分类排在前面。

新增接口：

~~~ts
export interface SkillCatalogService {
  list(): Promise<SkillsPage>;
  get(id: string): Promise<SkillDetail>;
  createFolder(name: string): Promise<SkillFolder>;
  move(id: string, folderId: string | null): Promise<SkillSummary>;
  resolveSource(id: string): Promise<string>;
}
~~~

createFolder 先校验当前大脑根目录，必要时建立 .claude/skills，拒绝父目录和目标目录符号链接，使用 mkdir 且不覆盖现有目录。move 重新解析两端，确认目标不存在或就是当前目录后使用同卷 rename；将 ENOENT、EEXIST 和权限错误转换为 PublicApiError。resolveSource 只供 Electron 主进程使用，不进入 API response。

- [ ] **Step 5: 运行 catalog 单元测试并提交后端服务切片**

Run:

~~~bash
npx vitest run --config vitest.config.ts tests/unit/skill-catalog.test.ts
~~~

Expected: catalog 单元测试全部通过，且没有真实 vault 写入。Commit:

~~~bash
git add src/shared/api/skills.ts src/server/services/skill-catalog.ts tests/unit/skill-catalog.test.ts
git commit -m "feat: manage skill folders safely"
~~~

## Task 2: 接通受保护的 Skill API

**Files:**
- Modify: src/server/api/routes/skills.ts
- Modify: src/server/app.ts
- Modify: src/server/start-server.ts
- Modify: tests/integration/skill-api.test.ts

- [ ] **Step 1: 写 API 失败测试**

在现有 fixture catalog 上加入列表、CSRF、创建和移动断言：

~~~ts
it('returns folders and folder ownership from GET /api/v1/skills', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/v1/skills' });
  expect(response.statusCode).toBe(200);
  expect(response.json().data).toMatchObject({ folders: [{ name: '通用' }], items: [{ folderName: '通用' }] });
});

it('requires CSRF and changes only the requested folder operation', async () => {
  const withoutCsrf = await app.inject({ method: 'POST', url: '/api/v1/skills/folders', payload: { name: '写作' } });
  expect(withoutCsrf.statusCode).toBe(401);
  const token = await bootstrapToken(app);
  const created = await app.inject({ method: 'POST', url: '/api/v1/skills/folders', headers: token.headers, payload: { name: '写作' } });
  expect(created.statusCode).toBe(200);
  const moveUrl = '/api/v1/skills/' + skillId('root-skill') + '/move';
  const moved = await app.inject({ method: 'POST', url: moveUrl, headers: token.headers, payload: { folderId: created.json().data.id } });
  expect(moved.statusCode).toBe(200);
  expect(moved.json().data.folderName).toBe('写作');
});
~~~

另外覆盖错误名称、重复创建、未知 ID、未知 folder ID、目标冲突和无 catalog 时的 503 SKILL_CATALOG_UNAVAILABLE。

- [ ] **Step 2: 运行集成测试确认红灯**

Run:

~~~bash
npx vitest run --config vitest.integration.config.ts tests/integration/skill-api.test.ts
~~~

Expected: 新增 POST 路由和新字段断言失败，失败原因是路由/schema 尚未接入。

- [ ] **Step 3: 注册严格的 Fastify 路由**

在 src/server/api/routes/skills.ts 保留现有 GET 路由，并增加：

~~~ts
app.post('/api/v1/skills/folders', async (request, reply) => {
  reply.header('cache-control', 'no-store');
  const body = parseApiInput(skillFolderCreateRequestSchema, request.body);
  return parseApiOutput(skillFolderResponseSchema, { data: await required().createFolder(body.name), version: API_VERSION });
});

app.post('/api/v1/skills/:id/move', async (request, reply) => {
  reply.header('cache-control', 'no-store');
  const { id } = parseApiInput(skillIdParamsSchema, request.params);
  const body = parseApiInput(skillMoveRequestSchema, request.body);
  return parseApiOutput(skillMoveResponseSchema, { data: await required().move(id, body.folderId), version: API_VERSION });
});
~~~

现有 onRequest hook 会为 POST 自动要求 session 与 CSRF；不要绕过该保护。

- [ ] **Step 4: 让 desktop filesystem 使用同一个 catalog 实例**

给 EmbeddedServerConfig 增加可选 skillCatalog?: SkillCatalogService。startServer 在 filesystem 模式使用传入实例，否则创建默认实例；local-rest 不创建实例。buildServer 继续把 skillCatalog 传给 registerSkillRoutes，使 Electron 主进程和 HTTP API 共享 ID/path 解析。

- [ ] **Step 5: 运行 API 测试并提交**

Run:

~~~bash
npx vitest run --config vitest.integration.config.ts tests/integration/skill-api.test.ts
npx vitest run --config vitest.config.ts tests/unit/skill-catalog.test.ts
~~~

Expected: 两组全部通过，未配置 catalog 的旧行为仍为 503。Commit:

~~~bash
git add src/server/api/routes/skills.ts src/server/app.ts src/server/start-server.ts tests/integration/skill-api.test.ts
git commit -m "feat: expose skill folder management api"
~~~

## Task 3: 增加 Electron 访达 bridge

**Files:**
- Create: src/electron/skill-navigation.ts
- Modify: src/electron/main.ts
- Modify: src/electron/preload.ts
- Modify: src/shared/desktop/bridge.ts
- Modify: src/client/vite-env.d.ts
- Create: tests/unit/desktop-skill-navigation.test.ts
- Modify: tests/electron/desktop-launch.test.ts

- [ ] **Step 1: 写 Finder 导航失败测试**

使用临时 .claude/skills/通用/写作/SKILL.md 和可注入的 catalog.resolveSource/shell.showItemInFolder，先加入：

~~~ts
it('reveals the resolved SKILL.md and never accepts a renderer path', async () => {
  const navigation = createDesktopSkillNavigation({ catalog, shell });
  await navigation.revealSkill(skillId('写作'));
  expect(catalog.resolveSource).toHaveBeenCalledExactlyOnceWith(skillId('写作'));
  expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith('/vault/.claude/skills/通用/写作/SKILL.md');
});

it.each(['../secret', '/tmp/secret', 'not-a-sha'])('rejects invalid IDs before Finder', async (id) => {
  await expect(navigation.revealSkill(id)).rejects.toThrow('无法定位这个 Skill');
  expect(shell.showItemInFolder).not.toHaveBeenCalled();
});
~~~

覆盖 resolver 失败、根目录替换和 Finder 抛错，断言只暴露普通语言错误。

- [ ] **Step 2: 运行原生测试确认红灯**

Run:

~~~bash
npx vitest run --config vitest.config.ts tests/unit/desktop-skill-navigation.test.ts
~~~

Expected: 因新模块或 revealSkill 不存在而失败。

- [ ] **Step 3: 实现受限导航与 bridge**

src/electron/skill-navigation.ts 的公开边界为：

~~~ts
export function createDesktopSkillNavigation(input: {
  readonly catalog: Pick<SkillCatalogService, 'resolveSource'>;
  readonly shell: Pick<Electron.Shell, 'showItemInFolder'>;
}) {
  return {
    async revealSkill(id: unknown): Promise<void> {
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) throw new Error('无法定位这个 Skill，请刷新后重试。');
      try {
        const source = await input.catalog.resolveSource(id);
        input.shell.showItemInFolder(source);
      } catch {
        throw new Error('无法在 Finder 中定位这个 Skill，请刷新后重试。');
      }
    }
  };
}
~~~

main.ts 先创建 createSkillCatalogService({ skillsRoot: join(settings.vaultRoot, '.claude', 'skills') })，将实例传给 startServer({ skillCatalog }) 和 createDesktopSkillNavigation，再注册 ipcMain.handle('desktop:reveal-skill', ...) 并调用现有 assertMainSender。preload 只暴露 revealSkill；共享 bridge 类型把它标为可选。

- [ ] **Step 4: 更新桌面启动契约并验证**

把 tests/electron/desktop-launch.test.ts 的 bridge 白名单加入 revealSkill，运行：

~~~bash
npx vitest run --config vitest.config.ts tests/unit/desktop-skill-navigation.test.ts
npx playwright test --config playwright.electron.config.ts tests/electron/desktop-launch.test.ts
~~~

Expected: 原生单测和开发/打包 bridge 启动契约全部通过。Commit:

~~~bash
git add src/electron/skill-navigation.ts src/electron/main.ts src/electron/preload.ts src/shared/desktop/bridge.ts src/client/vite-env.d.ts tests/unit/desktop-skill-navigation.test.ts tests/electron/desktop-launch.test.ts
git commit -m "feat: reveal skills in Finder"
~~~

## Task 4: 客户端 API 与 Skill 库界面

**Files:**
- Modify: src/client/api/client.ts
- Modify: src/client/pages/SkillsPage.tsx
- Modify: src/client/styles/skills.css
- Modify: tests/component/skills-page.test.tsx

- [ ] **Step 1: 扩展组件测试 fixture 并写红灯交互用例**

给现有 skill 增加 folderId/folderName，把 list fixture 改为 { folders: [], items: [skill] }，然后先加入：

~~~tsx
it('creates a folder and refreshes the list', async () => {
  const user = userEvent.setup();
  createFolder.mockResolvedValue(ok({ id: 'c'.repeat(64), name: '写作', skillCount: 0 }));
  list.mockResolvedValueOnce(ok({ folders: [], items: [skill] }))
    .mockResolvedValueOnce(ok({ folders: [{ id: 'c'.repeat(64), name: '写作', skillCount: 0 }], items: [skill] }));
  renderPage();
  await user.click(await screen.findByRole('button', { name: '新建文件夹' }));
  await user.type(screen.getByRole('textbox', { name: '文件夹名称' }), '写作');
  await user.click(screen.getByRole('button', { name: '保存文件夹' }));
  expect(createFolder).toHaveBeenCalledExactlyOnceWith('写作');
  expect(await screen.findByText('写作')).toBeVisible();
});

it('moves a Skill through the click menu and can request Finder reveal', async () => {
  const user = userEvent.setup();
  move.mockResolvedValue(ok({ ...skill, folderId: 'c'.repeat(64), folderName: '写作' }));
  vi.stubGlobal('xiaozhaoDesktop', { revealSkill: vi.fn(async () => undefined) });
  renderPageWith({ folders: [{ id: 'c'.repeat(64), name: '写作', skillCount: 0 }], items: [skill] });
  await user.selectOptions(await screen.findByRole('combobox', { name: '移动到：公众号排版发布' }), 'c'.repeat(64));
  expect(move).toHaveBeenCalledExactlyOnceWith(skill.id, 'c'.repeat(64));
  await user.click(screen.getByRole('button', { name: '在访达中打开：公众号排版发布' }));
  expect(window.xiaozhaoDesktop?.revealSkill).toHaveBeenCalledExactlyOnceWith(skill.id);
});
~~~

再加入取消、重复文件夹错误、移动失败、Finder 不可用时隐藏按钮和无写 API 时的降级断言。

- [ ] **Step 2: 运行组件测试确认红灯**

Run:

~~~bash
npx vitest run --config vitest.client.config.ts tests/component/skills-page.test.tsx
~~~

Expected: 因新 API 方法、按钮和表单不存在而失败；原有详情/安全渲染断言仍可定位。

- [ ] **Step 3: 添加客户端 API 方法**

在 ReadConsoleApi.skills 增加：

~~~ts
createFolder(name: string): Promise<ApiClientResult<SkillFolder>>;
move(id: string, folderId: string | null): Promise<ApiClientResult<SkillSummary>>;
~~~

在 createBrowserReadConsoleApi 中使用现有 postWithCsrf：

~~~ts
createFolder: name => postWithCsrf('/api/v1/skills/folders', skillFolderResponseSchema, { name }),
move: (id, folderId) => postWithCsrf('/api/v1/skills/' + encodeURIComponent(id) + '/move', skillMoveResponseSchema, { folderId })
~~~

错误 code 继续通过 requestApi 传回页面；不要把绝对路径加进任何客户端类型。

- [ ] **Step 4: 实现最简文件夹栏和操作状态**

在 SkillsPage.tsx 保留现有 list/detail 请求与 SafeMarkdown，新增状态：

~~~ts
const [creatingFolder, setCreatingFolder] = useState(false);
const [folderName, setFolderName] = useState('');
const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
const [mutation, setMutation] = useState<{ id: string; kind: 'move' | 'reveal' } | undefined>();
~~~

顶部渲染“未分类”和 folders；点击后只显示对应 items，空文件夹显示“这里还没有 Skill”。新建表单前端先 trim/检查 1–256 字节、禁止路径分隔符、控制字符、隐藏名和 scripts/env；成功后刷新并选中新文件夹，失败保留输入并显示 role=alert。

每张卡片增加 select（aria-label 为“移动到：<Skill 名称>”），选项为“未分类”和 folders；选择后调用 skillsApi.move，期间禁用控件，成功刷新，失败显示“移动失败，请刷新后重试”。不做拖放、删除或编辑。

卡片和详情页在 window.xiaozhaoDesktop?.revealSkill 存在时显示按钮，调用期间显示“正在打开…”，成功显示 role=status，失败可再次点击。没有 desktop bridge 时隐藏按钮。

- [ ] **Step 5: 补齐样式与可访问性**

在 skills.css 添加文件夹栏、inline form、select、mutation feedback 样式，沿用现有深色 token；按钮和选择控件保留 :focus-visible，窄屏改为横向可滚动文件夹栏，prefers-reduced-motion 不依赖动画表达状态。不要引入新 UI 库或拖拽依赖。

- [ ] **Step 6: 运行组件回归并提交客户端切片**

Run:

~~~bash
npx vitest run --config vitest.client.config.ts tests/component/skills-page.test.tsx tests/component/app-shell.test.tsx
~~~

Expected: Skill 页面新旧用例和侧栏路由全部通过。Commit:

~~~bash
git add src/client/api/client.ts src/client/pages/SkillsPage.tsx src/client/styles/skills.css tests/component/skills-page.test.tsx
git commit -m "feat: organize skills with local folders"
~~~

## Task 5: Electron 隔离流程、文档与整体验证

**Files:**
- Create: tests/electron/skill-library-folders.test.ts
- Modify: README.md
- Modify: docs/superpowers/specs/2026-09-14-skill-library-folders-design.md only if observed behavior differs

- [ ] **Step 1: 写隔离 Electron 流程测试**

建立临时完整 vault、.claude/skills/root-a、root-b、root-c、root-d 和 fixture userData，使用 XIAOZHAO_TEST_VAULT_ROOT 启动 development 与 packaged 两种模式。测试流程：进入 /skills 看到四个未分类 Skill；创建“通用”；把四个 Skill 分别移动进去；刷新后四个归属保持；点击一个“在访达中打开”；关闭实例并检查四个 SKILL.md 字节与移动前一致。finally 只删除临时 vault/userData，绝不使用真实 /Users/ao/我的大脑。

- [ ] **Step 2: 运行隔离 Electron 流程**

Run:

~~~bash
npx playwright test --config playwright.electron.config.ts tests/electron/skill-library-folders.test.ts
~~~

Expected: development/packaged 两种模式都通过；失败时只修复本功能的路由、IPC、fixture 或等待时序。

- [ ] **Step 3: 更新公开能力说明**

在 README 的“现在能做什么”表中增加：

~~~markdown
| 管理本地 Skill | 在 Skill 库创建一层自定义文件夹、手动移动 Skill，并在访达定位源文件；Skill 内容仍由本地文件维护 |
~~~

不要把 AI 自动分类、删除或执行写成当前能力。

- [ ] **Step 4: 运行比例相称的验证**

按顺序运行：

~~~bash
npx vitest run --config vitest.config.ts tests/unit/skill-catalog.test.ts tests/unit/desktop-skill-navigation.test.ts
npx vitest run --config vitest.integration.config.ts tests/integration/skill-api.test.ts
npx vitest run --config vitest.client.config.ts tests/component/skills-page.test.tsx tests/component/app-shell.test.tsx
npx playwright test --config playwright.electron.config.ts tests/electron/desktop-launch.test.ts tests/electron/first-run-walkthrough.test.ts tests/electron/skill-library-folders.test.ts
npm run typecheck
npx vite build
npm run build:server
npm run build:electron
~~~

Expected: 本功能相关测试和构建通过；若全量 typecheck 仍被其他并发工作阻断，记录具体文件与错误，不回滚无关改动。

- [ ] **Step 5: 做手动隔离 smoke 并提交收口**

在隔离 vault 中确认创建文件夹真实存在、移动后目录结构正确、Skill 内容未变、刷新能复现归属、访达按钮选中 SKILL.md。运行 git diff --check，确认没有把真实 vault 或临时文件加入版本库，然后提交：

~~~bash
git add README.md tests/electron/skill-library-folders.test.ts docs/superpowers/specs/2026-09-14-skill-library-folders-design.md
git commit -m "docs: document skill folder management"
~~~

## 计划自检

- 设计中的每项能力均有对应任务：创建文件夹（Task 1/2/4/5）、点击移动（Task 1/2/4/5）、空文件夹（Task 1/4）、访达定位（Task 3/4/5）、一层目录和安全边界（Task 1/3）、明确不做删除/AI（Task 4/5）。
- 没有删除、回收站、AI 分类、拖拽依赖或 Skill 编辑任务，符合已确认的最简范围。
- SkillCatalogService.list、createFolder、move、resolveSource 与 API schema、Electron bridge 的名称保持一致。
- 所有写操作都经过现有 CSRF hook；所有 Electron 调用都经过 assertMainSender；测试只使用临时 vault。

