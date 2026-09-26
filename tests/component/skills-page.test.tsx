// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClientResult, ReadConsoleApi } from '../../src/client/api/client.js';
import type { SkillDetail, SkillsPage as SkillsPageData } from '../../src/shared/api/skills.js';
import { SkillsPage } from '../../src/client/pages/SkillsPage.js';

const skill = {
  id: 'a'.repeat(64),
  name: '公众号排版发布',
  description: '把文章排版成可发布的微信公众号 HTML。',
  revision: 'b'.repeat(64),
  folderId: null,
  folderName: null
} as const;

const detail: SkillDetail = {
  ...skill,
  markdown: '# 发布流程\n\n先检查素材，再生成排版。\n\n<script>alert(1)</script>',
  references: ['README.md', 'templates/style.md']
};

const ok = <T,>(value: T): ApiClientResult<T> => ({ ok: true, value });
const failed = <T,>(message = 'Skill 服务暂时不可用。'): ApiClientResult<T> => ({
  ok: false,
  state: { status: 'disconnected', message }
});

const list = vi.fn<(...args: [AbortSignal?]) => Promise<ApiClientResult<SkillsPageData>>>();
const get = vi.fn<(...args: [string, AbortSignal?]) => Promise<ApiClientResult<SkillDetail>>>();
const createFolder = vi.fn<(name: string) => Promise<ApiClientResult<{ id: string; name: string; skillCount: number }>>>();
const move = vi.fn<(id: string, folderId: string | null) => Promise<ApiClientResult<SkillsPageData['items'][number]>>>();

const runtime: {
  api: Pick<ReadConsoleApi, 'skills'>;
  health: { status: string; data: { index: { status: string } } };
  dataRevision: number;
  refreshHealth: () => Promise<void>;
} = {
  api: { skills: { list, get } },
  health: { status: 'ready', data: { index: { status: 'ready' } } },
  dataRevision: 0,
  refreshHealth: vi.fn(async () => undefined)
};

vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({
  useConsoleRuntime: () => runtime
}));

function renderPage() {
  return render(<SkillsPage />);
}

beforeEach(() => {
  runtime.api = { skills: { list, get, createFolder, move } };
  list.mockResolvedValue(ok({ folders: [], items: [skill] }));
  get.mockResolvedValue(ok(detail));
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'xiaozhaoDesktop');
  vi.clearAllMocks();
});

describe('SkillsPage', () => {
  it('loads the local catalog and presents read-only skill summaries with organization controls', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: '公众号排版发布' })).toBeVisible();
    expect(screen.getByText(skill.description)).toBeVisible();
    expect(screen.getByText(`版本 ${skill.revision.slice(0, 8)}`)).toBeVisible();
    expect(screen.getByRole('button', { name: '查看方法：公众号排版发布' })).toBeEnabled();
    expect(screen.getByText('内容只读 · 可整理')).toBeVisible();
    expect(screen.queryByRole('button', { name: /执行|编辑|保存/u })).not.toBeInTheDocument();
    expect(list).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it('opens a selected skill detail and renders its markdown and references', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '查看方法：公众号排版发布' }));

    expect(await screen.findByRole('heading', { name: '公众号排版发布' })).toBeVisible();
    expect(screen.getByText('先检查素材，再生成排版。')).toBeVisible();
    expect(screen.queryByText('<script>alert(1)</script>')).not.toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeVisible();
    expect(screen.getByText('templates/style.md')).toBeVisible();
    expect(screen.getByRole('button', { name: '返回 Skill 库' })).toBeVisible();
    expect(get).toHaveBeenCalledWith(skill.id, expect.any(AbortSignal));
  });

  it('offers an explicit retry when the catalog cannot be read', async () => {
    const user = userEvent.setup();
    list.mockResolvedValueOnce(failed('本地 Skill 目录暂时无法读取。'));
    list.mockResolvedValueOnce(ok({ folders: [], items: [skill] }));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('本地 Skill 目录暂时无法读取。');
    const retry = screen.getByRole('button', { name: '重新读取 Skill 库' });
    await user.click(retry);
    expect(await screen.findByRole('heading', { name: '公众号排版发布' })).toBeVisible();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('turns the catalog unavailable response into a clear local-connection message', async () => {
    list.mockResolvedValueOnce({
      ok: false,
      code: 'SKILL_CATALOG_UNAVAILABLE',
      state: { status: 'operation-error', message: 'Skill catalog is unavailable.' }
    });
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('当前连接不提供 Skill 库。');
    expect(screen.getByText('请使用支持本地文件 Skill 的桌面连接。')).toBeVisible();
  });

  it('retries a detail read without changing the selected skill', async () => {
    const user = userEvent.setup();
    get.mockResolvedValueOnce(failed('本地 Skill 方法暂时无法读取。'));
    get.mockResolvedValueOnce(ok(detail));
    renderPage();

    await user.click(await screen.findByRole('button', { name: '查看方法：公众号排版发布' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('本地 Skill 方法暂时无法读取。');
    await user.click(screen.getByRole('button', { name: '重新读取 Skill 方法' }));
    expect(await screen.findByText('先检查素材，再生成排版。')).toBeVisible();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('explains where to add a skill when the catalog is empty', async () => {
    list.mockResolvedValue(ok({ folders: [], items: [] }));
    renderPage();

    expect(await screen.findByText('在 .claude/skills 下添加 Skill 文件夹')).toBeVisible();
    expect(screen.getByText('当前还没有可浏览的 Skill。')).toBeVisible();
  });

  it('does not show an empty success state when a refresh fails after an empty read', async () => {
    const user = userEvent.setup();
    list.mockResolvedValueOnce(ok({ folders: [], items: [] }));
    list.mockResolvedValueOnce(failed('刷新 Skill 目录失败。'));
    renderPage();

    expect(await screen.findByText('当前还没有可浏览的 Skill。')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '刷新 Skill 库' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('刷新 Skill 目录失败。');
    expect(screen.queryByText('当前还没有可浏览的 Skill。')).not.toBeInTheDocument();
  });

  it('reports a clear unavailable state when this connection has no skill API', async () => {
    runtime.api = {};
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('当前连接不提供 Skill 库。');
    expect(screen.getByText('请使用支持本地文件 Skill 的桌面连接。')).toBeVisible();
  });

  it('creates a folder, refreshes the catalog, and selects it', async () => {
    const user = userEvent.setup();
    const folder = { id: 'c'.repeat(64), name: '发布流程', skillCount: 0 };
    createFolder.mockResolvedValue(ok(folder));
    list.mockResolvedValueOnce(ok({ folders: [], items: [skill] })).mockResolvedValueOnce(ok({ folders: [folder], items: [] }));
    renderPage();
    await user.click(await screen.findByRole('button', { name: '新建文件夹' }));
    await user.type(screen.getByRole('textbox', { name: '文件夹名称' }), ' 发布流程 ');
    await user.click(screen.getByRole('button', { name: '保存文件夹' }));
    expect(createFolder).toHaveBeenCalledWith('发布流程', expect.any(AbortSignal));
    expect(await screen.findByRole('button', { name: /发布流程/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('这里还没有 Skill')).toBeVisible();
  });

  it('moves a skill from the card menu and refreshes', async () => {
    const user = userEvent.setup();
    const folder = { id: 'c'.repeat(64), name: '发布流程', skillCount: 0 };
    move.mockResolvedValue(ok({ ...skill, folderId: folder.id, folderName: folder.name }));
    list.mockResolvedValueOnce(ok({ folders: [folder], items: [skill] })).mockResolvedValueOnce(ok({ folders: [folder], items: [] }));
    renderPage();
    const select = await screen.findByRole('combobox', { name: `移动到：${skill.name}` });
    await user.selectOptions(select, folder.id);
    expect(move).toHaveBeenCalledWith(skill.id, folder.id, expect.any(AbortSignal));
    expect(await screen.findByText('当前还没有可浏览的 Skill。')).toBeVisible();
  });

  it('reveals a skill in Finder through the desktop bridge', async () => {
    const user = userEvent.setup();
    const revealSkill = vi.fn(async () => undefined);
    vi.stubGlobal('xiaozhaoDesktop', { revealSkill });
    renderPage();
    await user.click(await screen.findByRole('button', { name: `在 Finder 中打开：${skill.name}` }));
    expect(revealSkill).toHaveBeenCalledWith(skill.id);
  });

  it('reports Finder bridge failures and restores the retry button', async () => {
    const user = userEvent.setup();
    const revealSkill = vi.fn(async () => { throw new Error('bridge failed'); });
    vi.stubGlobal('xiaozhaoDesktop', { revealSkill });
    renderPage();
    const button = await screen.findByRole('button', { name: `在 Finder 中打开：${skill.name}` });
    await user.click(button);
    expect(await screen.findByRole('status')).toHaveTextContent('无法在 Finder 中打开，请重试。');
    expect(button).toBeEnabled();
  });

  it('keeps the original list and reports a move failure', async () => {
    const user = userEvent.setup();
    const folder = { id: 'c'.repeat(64), name: '发布流程', skillCount: 0 };
    move.mockResolvedValue(failed('移动失败。'));
    list.mockResolvedValue(ok({ folders: [folder], items: [skill] }));
    renderPage();
    await user.selectOptions(await screen.findByRole('combobox', { name: `移动到：${skill.name}` }), folder.id);
    expect(await screen.findByRole('alert')).toHaveTextContent('移动失败，请刷新后重试。');
    expect(screen.getByRole('heading', { name: skill.name })).toBeVisible();
  });

  it('cancels folder creation and reports mutation failures', async () => {
    const user = userEvent.setup();
    createFolder.mockResolvedValue(failed('文件夹创建失败。'));
    renderPage();
    await user.click(await screen.findByRole('button', { name: '新建文件夹' }));
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('textbox', { name: '文件夹名称' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '新建文件夹' }));
    await user.type(screen.getByRole('textbox', { name: '文件夹名称' }), '失败');
    await user.click(screen.getByRole('button', { name: '保存文件夹' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('文件夹创建失败。');
  });

  it('keeps read-only mode when mutation API or bridge is unavailable', async () => {
    runtime.api = { skills: { list, get } };
    renderPage();
    expect(await screen.findByRole('heading', { name: skill.name })).toBeVisible();
    expect(screen.queryByRole('button', { name: '新建文件夹' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: `移动到：${skill.name}` })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /在 Finder 中打开/ })).not.toBeInTheDocument();
  });
});

it('previews entire folder recycling, cancels without mutation, and supports confirmed recycle and undo', async () => {
  const user = userEvent.setup();
  const folder = { id: 'f'.repeat(64), name: '发布流程', skillCount: 1 };
  const id = '11111111-1111-4111-8111-111111111111';
  const entry = { id, folderId: folder.id, name: folder.name, skillCount: 1, createdAt: '2026-09-26T12:00:00Z', status: 'trashed' as const };
  const previewFolderTrash = vi.fn(async () => ok({ ...entry, entryCount: 3, expiresAt: '2026-09-26T12:05:00Z' }));
  const trashFolder = vi.fn(async () => { list.mockResolvedValue(ok({ folders: [], items: [] })); return ok(entry); });
  const listFolderTrash = vi.fn(async () => ok({ items: [entry] }));
  const restoreFolder = vi.fn(async () => { list.mockResolvedValue(ok({ folders: [folder], items: [{ ...skill, folderId: folder.id, folderName: folder.name }] })); return ok({ ...entry, status: 'restored' as const }); });
  runtime.api = { skills: { list, get, createFolder, move, previewFolderTrash, trashFolder, listFolderTrash, restoreFolder } };
  list.mockResolvedValue(ok({ folders: [folder], items: [{ ...skill, folderId: folder.id, folderName: folder.name }] }));
  renderPage();
  expect(screen.queryByRole('button', { name: '移到回收站' })).not.toBeInTheDocument();
  await user.click(await screen.findByRole('button', { name: '发布流程 1' }));
  await user.click(screen.getByRole('button', { name: '移到回收站' }));
  expect(await screen.findByRole('dialog', { name: '回收“发布流程”？' })).toHaveTextContent('隐藏文件');
  expect(trashFolder).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '取消回收' }));
  expect(trashFolder).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '移到回收站' }));
  await user.click(await screen.findByRole('button', { name: '确认回收整个文件夹' }));
  expect(trashFolder).toHaveBeenCalledExactlyOnceWith(id, expect.any(AbortSignal));
  await user.click(await screen.findByRole('button', { name: '撤销回收' }));
  expect(restoreFolder).toHaveBeenCalledExactlyOnceWith(id, expect.any(AbortSignal));
  expect(await screen.findByRole('button', { name: '发布流程 1' })).toHaveAttribute('aria-pressed', 'true');
});

it('loads persisted recycled folders and retains conflict errors for an explicit restore retry', async () => {
  const user = userEvent.setup();
  const entry = { id: '11111111-1111-4111-8111-111111111111', folderId: 'f'.repeat(64), name: '写作', skillCount: 2, createdAt: '2026-09-26T12:00:00Z', status: 'trashed' as const };
  const restoreFolder = vi.fn(async () => failed<typeof entry>('原位置已有“写作”。请先重命名同名文件夹，再恢复；回收内容仍保留。'));
  runtime.api = { skills: { list, get, previewFolderTrash: vi.fn(), trashFolder: vi.fn(), listFolderTrash: vi.fn(async () => ok({ items: [entry] })), restoreFolder } };
  renderPage();
  await user.click(await screen.findByRole('button', { name: '文件夹回收站' }));
  await user.click(await screen.findByRole('button', { name: '恢复：写作' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('回收内容仍保留');
  expect(screen.getByRole('button', { name: '恢复：写作' })).toBeEnabled();
});

it('discards a late folder preview after the user changes the selected category', async () => {
  const user = userEvent.setup();
  const folder = { id: 'f'.repeat(64), name: '旧分类', skillCount: 0 };
  let finish!: (value: ApiClientResult<any>) => void;
  const previewFolderTrash = vi.fn(() => new Promise<ApiClientResult<any>>(resolve => { finish = resolve; }));
  runtime.api = { skills: { list, get, previewFolderTrash, trashFolder: vi.fn(), listFolderTrash: vi.fn(async () => ok({ items: [] })), restoreFolder: vi.fn() } };
  list.mockResolvedValue(ok({ folders: [folder], items: [] }));
  renderPage();
  await user.click(await screen.findByRole('button', { name: '旧分类 0' }));
  await user.click(screen.getByRole('button', { name: '移到回收站' }));
  await user.click(screen.getByRole('button', { name: '未分类 0' }));
  finish(ok({ id: '11111111-1111-4111-8111-111111111111', folderId: folder.id, name: folder.name, skillCount: 0, entryCount: 0, expiresAt: '2026-09-26T12:05:00Z' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('keeps a failed confirmation visible and clears old undo state when the API scope changes', async () => {
  const user = userEvent.setup();
  const folder = { id: 'f'.repeat(64), name: '旧分类', skillCount: 0 };
  const id = '11111111-1111-4111-8111-111111111111';
  const entry = { id, folderId: folder.id, name: folder.name, skillCount: 0, createdAt: '2026-09-26T12:00:00Z', status: 'trashed' as const };
  const trashFolder = vi.fn().mockResolvedValueOnce(failed('目录变化，请重新预览。')).mockResolvedValueOnce(ok(entry));
  runtime.api = { skills: { list, get, previewFolderTrash: vi.fn(async () => ok({ id, folderId: folder.id, name: folder.name, skillCount: 0, entryCount: 0, expiresAt: '2026-09-26T12:05:00Z' })), trashFolder, listFolderTrash: vi.fn(async () => ok({ items: [] })), restoreFolder: vi.fn() } };
  list.mockResolvedValue(ok({ folders: [folder], items: [] }));
  const rendered = renderPage();
  await user.click(await screen.findByRole('button', { name: '旧分类 0' }));
  await user.click(screen.getByRole('button', { name: '移到回收站' }));
  await user.click(await screen.findByRole('button', { name: '确认回收整个文件夹' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('目录变化');
  expect(screen.getByRole('dialog')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '取消回收' }));
  await user.click(screen.getByRole('button', { name: '移到回收站' }));
  await user.click(await screen.findByRole('button', { name: '确认回收整个文件夹' }));
  expect(await screen.findByRole('button', { name: '撤销回收' })).toBeVisible();
  runtime.api = { skills: { ...runtime.api.skills!, list: vi.fn(async () => ok({ folders: [], items: [] })) } };
  rendered.rerender(<SkillsPage />);
  await waitFor(() => expect(screen.queryByRole('button', { name: '撤销回收' })).not.toBeInTheDocument());
});

it('keeps the folder mutation mounted by disabling catalog navigation and writes until confirmation completes', async () => {
  const user = userEvent.setup();
  const folder = { id: 'f'.repeat(64), name: '处理中分类', skillCount: 1 };
  const id = '11111111-1111-4111-8111-111111111111';
  const entry = { id, folderId: folder.id, name: folder.name, skillCount: 1, createdAt: '2026-09-26T12:00:00Z', status: 'trashed' as const };
  let finish!: (value: ApiClientResult<typeof entry>) => void;
  const trashFolder = vi.fn(() => new Promise<ApiClientResult<typeof entry>>(resolve => { finish = resolve; }));
  runtime.api = { skills: { list, get, createFolder, move, previewFolderTrash: vi.fn(async () => ok({ id, folderId: folder.id, name: folder.name, skillCount: 1, entryCount: 1, expiresAt: '2026-09-26T12:05:00Z' })), trashFolder, listFolderTrash: vi.fn(async () => ok({ items: [] })), restoreFolder: vi.fn() } };
  list.mockResolvedValue(ok({ folders: [folder], items: [{ ...skill, folderId: folder.id, folderName: folder.name }] }));
  renderPage();
  await user.click(await screen.findByRole('button', { name: '处理中分类 1' }));
  await user.click(screen.getByRole('button', { name: '移到回收站' }));
  await user.click(await screen.findByRole('button', { name: '确认回收整个文件夹' }));
  expect(screen.getByRole('button', { name: '查看方法：公众号排版发布' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '新建文件夹' })).toBeDisabled();
  expect(screen.getByRole('combobox', { name: '移动到：公众号排版发布' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '未分类 0' })).toBeDisabled();
  list.mockResolvedValue(ok({ folders: [], items: [] })); finish(ok(entry));
  expect(await screen.findByRole('button', { name: '撤销回收' })).toBeVisible();
  await waitFor(() => expect(screen.queryByRole('button', { name: '处理中分类 1' })).not.toBeInTheDocument());
});
