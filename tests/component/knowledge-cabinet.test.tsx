import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserReadConsoleApi, type ApiClientResult, type LiveKnowledgeDetail } from '../../src/client/api/client.js';
import type { ConsoleRuntime } from '../../src/client/app/ConsoleRuntime.js';
import type { KnowledgeRecord } from '../../src/shared/domain/records.js';
import type { KnowledgeCatalogQuery as Query } from '../../src/shared/api/knowledge-catalog.js';
import { KnowledgePage } from '../../src/client/pages/KnowledgePage.js';
import { ASSISTANT_INTENT_EVENT } from '../../src/client/components/assistant/assistantIntent.js';

let runtime: ConsoleRuntime;
vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => runtime }));
const ok = <T,>(value: T): ApiClientResult<T> => ({ ok: true, value });
const note: KnowledgeRecord = { path: '02知识库/01AI/AI基础/边界.md', title: 'Agent 与工作流的边界', rawSha256: 'a'.repeat(64),
  sourceType: 'AI提炼', usageStatus: '已优化', knowledgeType: '概念', sourceMaterials: ['01图书馆/来自个人/原文.md'],
  recallFields: { topics: ['系统'], keywords: ['Agent'], scenarios: ['判断任务'], conclusion: '固定流程与动态决策需要区分。', keyPoints: ['先判断任务是否稳定'], boundary: '明确任务边界' } };
type Catalog = { path: string; breadcrumbs: {path: string; label: string}[]; folders: {path: string; label: string; count: number}[];
  items: KnowledgeRecord[]; total: number; directTotal: number; indexVersion: number; nextCursor?: string };
function catalog(path = '', overrides: Partial<Catalog> = {}): Catalog {
  const labels = (name: string) => name.replace(/^\d+/u, '');
  return { path, breadcrumbs: [{path: '', label: '知识书柜'}, ...path.split('/').filter(Boolean).map((name, i, parts) => ({path: parts.slice(0, i + 1).join('/'), label: labels(name)}))],
    folders: path === '' ? [{path: '01AI', label: 'AI', count: 1}, {path: '07管理', label: '管理', count: 0}]
      : path === '01AI' ? [{path: '01AI/AI基础', label: 'AI基础', count: 1}] : [],
    items: path === '01AI/AI基础' ? [note] : [], total: path === '07管理' ? 0 : 1, directTotal: path === '01AI/AI基础' ? 1 : 0, indexVersion: 1, ...overrides };
}
function Probe() { const location = useLocation(); const navigate = useNavigate(); return <><output aria-label="地址">{location.search}</output><button onClick={() => navigate(-1)}>浏览器返回</button><button onClick={() => navigate(1)}>浏览器前进</button></>; }
function mount(url = '/knowledge') { return render(<MemoryRouter initialEntries={[url]}><KnowledgePage /><Probe /></MemoryRouter>); }
const address = () => new URLSearchParams(screen.getByLabelText('地址').textContent ?? '');
beforeEach(() => {
  sessionStorage.clear();
  runtime = { dataRevision: 0, refreshHealth: vi.fn(async () => {}), health: { status: 'ready', data: {
    status: 'ready', vaultSource: {status: 'ready', adapter: 'filesystem', displayName: '我的大脑'},
    index: {status: 'ready', version: 1, refreshedAt: '2026-09-07T00:00:00Z'}, model: {status: 'unavailable', reason: 'CONFIG_UNAVAILABLE'},
    writeGate: {status: 'blocked', missing: ['writeEnabled'], fingerprintMatches: false}, schemaIssues: {status: 'available', count: 0}
  } }, api: { ...browserReadConsoleApi,
    listKnowledge: vi.fn(async () => ok({items: []})),
    listKnowledgeCatalog: vi.fn(async (query: Query) => ok(catalog(query.path))),
    getKnowledgeDetail: vi.fn(async () => ok({path: note.path, title: note.title, record: note, markdown: '# 完整正文\n\n实际阅读内容。', internalKnowledgeLinks: [], versionMarker: {rawSha256: note.rawSha256}})),
    openKnowledge: vi.fn(async path => ok({opened: true as const, path}))
  } as ConsoleRuntime['api'] };
});
afterEach(cleanup);

describe('knowledge cabinet', () => {
  it('opens real domain books, nested folders and knowledge papers then returns to the original paper', async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole('button', {name: '打开 AI 收藏册'}));
    await user.click(await screen.findByRole('button', {name: '打开 AI基础 文件夹'}));
    const paper = await screen.findByRole('button', {name: `展开 ${note.title} 知识纸页`});
    expect(within(paper).getByText(note.recallFields.conclusion)).toBeVisible();
    expect(runtime.api.getKnowledgeDetail).not.toHaveBeenCalled();
    await user.click(paper); expect(await screen.findByText('实际阅读内容。')).toBeVisible();
    expect(address().get('path')).toBe(note.path); expect(address().get('folder')).toBe('01AI/AI基础');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByRole('button', {name: `展开 ${note.title} 知识纸页`})).toHaveFocus();
    expect(address().get('path')).toBeNull();
    await user.click(screen.getByRole('button', {name: '返回上一级'}));
    expect(await screen.findByRole('button', {name: '打开 AI基础 文件夹'})).toHaveFocus();
    expect(runtime.api.listKnowledge).not.toHaveBeenCalled();
  });
  it('supports exact note links outside a list and restores the containing folder after refresh', async () => {
    const user = userEvent.setup(); mount(`/knowledge?${new URLSearchParams({path: note.path})}`);
    expect(await screen.findByText('实际阅读内容。')).toBeVisible();
    expect(screen.getByRole('navigation', {name: '知识目录路径'})).toHaveTextContent('AI基础');
    await user.click(screen.getByRole('button', {name: '收回纸页'}));
    expect(await screen.findByRole('button', {name: `展开 ${note.title} 知识纸页`})).toBeVisible();
    expect(address().get('folder')).toBe('01AI/AI基础');
  });
  it('keeps folder and filter URLs across browser back and forward with no duplicate folder navigation', async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole('button', {name: '打开 AI 收藏册'}));
    await user.click(await screen.findByRole('button', {name: '打开 AI基础 文件夹'}));
    await user.click(screen.getByRole('button', {name: '浏览器返回'}));
    expect(await screen.findByRole('button', {name: '打开 AI基础 文件夹'})).toBeVisible();
    expect(screen.getAllByRole('button', {name: '打开 AI基础 文件夹'})).toHaveLength(1);
    await user.click(screen.getByRole('button', {name: '浏览器前进'}));
    expect(await screen.findByRole('button', {name: `展开 ${note.title} 知识纸页`})).toBeVisible();
    expect(address().get('folder')).toBe('01AI/AI基础');
  });
  it('retains actual empty directories and provides an explicit way back', async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole('button', {name: '打开 管理 收藏册'}));
    expect(await screen.findByText('这个目录暂时没有知识')).toBeVisible();
    await user.click(screen.getByRole('button', {name: '归架'}));
    expect(await screen.findByRole('button', {name: '打开 管理 收藏册'})).toHaveFocus();
  });
  it('applies search and obsolete opt-in without confusing topics with directories', async () => {
    const user = userEvent.setup(); const list = vi.fn(async (query: Query) => ok(catalog(query.path, {folders: [], items: [], total: 0, directTotal: 0})));
    runtime.api.listKnowledgeCatalog = list; mount('/knowledge?folder=01AI');
    await user.type(screen.getByRole('searchbox', {name: '搜索知识'}), 'Agent');
    await user.click(screen.getByRole('button', {name: /筛选/u}));
    await user.selectOptions(screen.getByLabelText('使用状态'), '过时');
    await user.type(screen.getByLabelText('主题'), '系统');
    await user.click(screen.getByRole('button', {name: '应用筛选'}));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({path: '01AI', limit: 200, search: 'Agent', usageStatus: '过时', includeObsolete: true, topic: '系统'}, expect.any(AbortSignal)));
  });
  it('rejects a wrong-folder reply instead of showing stale knowledge', async () => {
    runtime.api.listKnowledgeCatalog = vi.fn(async () => ok(catalog('01AI/AI基础'))); mount('/knowledge?folder=07管理');
    expect(await screen.findByText('知识目录响应不符合当前路径或分页规则，请刷新重试。')).toBeVisible();
    expect(screen.queryByText(note.title)).toBeNull();
  });
  it('does not merge changed snapshots or repeated cursors into loaded pages', async () => {
    const user = userEvent.setup(); const second = {...note, path: '02知识库/01AI/AI基础/另一篇.md', title: '不应显示'};
    runtime.api.listKnowledgeCatalog = vi.fn().mockResolvedValueOnce(ok(catalog('01AI/AI基础', {total: 2, directTotal: 2, nextCursor: 'cursor-a'})))
      .mockResolvedValueOnce(ok(catalog('01AI/AI基础', {items: [second], total: 2, directTotal: 2, indexVersion: 2})));
    mount('/knowledge?folder=01AI/AI基础'); await user.click(await screen.findByRole('button', {name: '加载更多'}));
    expect(await screen.findByText('知识目录响应不符合当前路径或分页规则，请刷新重试。')).toBeVisible(); expect(screen.queryByText('不应显示')).toBeNull();
  });
  it('ignores a late response after moving to another directory', async () => {
    const user = userEvent.setup(); let resolve!: (value: ApiClientResult<Catalog>) => void;
    const late = new Promise<ApiClientResult<Catalog>>(accept => {resolve = accept;});
    runtime.api.listKnowledgeCatalog = vi.fn().mockResolvedValueOnce(ok(catalog())).mockImplementationOnce(() => late).mockResolvedValueOnce(ok(catalog()));
    mount(); await user.click(await screen.findByRole('button', {name: '打开 AI 收藏册'}));
    await user.click(screen.getByRole('button', {name: '归架'}));
    await screen.findByRole('button', {name: '打开 AI 收藏册'});
    await act(async () => resolve(ok(catalog('01AI'))));
    expect(screen.queryByRole('button', {name: '打开 AI基础 文件夹'})).toBeNull();
  });
  it('refreshes an exact linked note even when it is outside the current catalog filter', async () => {
    const user = userEvent.setup();
    runtime.api.listKnowledgeCatalog = vi.fn(async query => ok(catalog(query.path, {folders: [], items: [], total: 0, directTotal: 0})));
    mount(`/knowledge?${new URLSearchParams({path: note.path})}`);
    await screen.findByText('实际阅读内容。');
    expect(runtime.api.getKnowledgeDetail).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', {name: '刷新知识'}));
    await waitFor(() => expect(runtime.api.getKnowledgeDetail).toHaveBeenCalledTimes(2));
  });
  it('does not steal search focus when a slow directory finishes opening', async () => {
    const user = userEvent.setup(); let resolve!: (value: ApiClientResult<Catalog>) => void;
    const pending = new Promise<ApiClientResult<Catalog>>(accept => {resolve = accept;});
    runtime.api.listKnowledgeCatalog = vi.fn().mockResolvedValueOnce(ok(catalog())).mockImplementationOnce(() => pending);
    mount(); await user.click(await screen.findByRole('button', {name: '打开 AI 收藏册'}));
    const input = screen.getByRole('searchbox', {name: '搜索知识'}); await user.type(input, '正在输入');
    await act(async () => resolve(ok(catalog('01AI'))));
    expect(input).toHaveFocus();
  });
  it('rereads on background index updates without stealing focus from search', async () => {
    const user = userEvent.setup();
    runtime.api.listKnowledgeCatalog = vi.fn(async query => ok(catalog(query.path, {folders: [], items: [], total: 0, directTotal: 0})));
    const url = `/knowledge?${new URLSearchParams({path: note.path})}`;
    const view = mount(url);
    await screen.findByText('实际阅读内容。');
    const input = screen.getByRole('searchbox', {name: '搜索知识'}); await user.type(input, '正在输入');
    if (runtime.health.status !== 'ready' || runtime.health.data.index.status !== 'ready') throw new Error('Expected ready fixture');
    runtime = {...runtime, health: {...runtime.health, data: {...runtime.health.data, index: {...runtime.health.data.index, version: 2}}}};
    await act(async () => {view.rerender(<MemoryRouter initialEntries={[url]}><KnowledgePage /><Probe /></MemoryRouter>);});
    await waitFor(() => expect(runtime.api.getKnowledgeDetail).toHaveBeenCalledTimes(2));
    expect(input).toHaveFocus();
  });
  it('waits for the initial index identity before loading the return catalog', async () => {
    const user = userEvent.setup(); const readyHealth = runtime.health;
    runtime = {...runtime, health: {status: 'loading'}};
    const url = `/knowledge?${new URLSearchParams({path: note.path})}`;
    const view = mount(url); await screen.findByText('实际阅读内容。');
    expect(runtime.api.listKnowledgeCatalog).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    runtime = {...runtime, health: readyHealth};
    await act(async () => {view.rerender(<MemoryRouter initialEntries={[url]}><KnowledgePage /><Probe /></MemoryRouter>);});
    expect(await screen.findByRole('button', {name: `展开 ${note.title} 知识纸页`})).toHaveFocus();
  });
});


it('searches after a short pause and expands empty folder results to the whole knowledge library', async () => {
  const user = userEvent.setup();
  runtime.api.listKnowledgeCatalog = vi.fn(async query => ok(catalog(query.path, { folders: [], items: [], total: 0, directTotal: 0 })));
  mount('/knowledge?folder=01AI');
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索知识' }), { target: { value: 'Agent' } });
  await waitFor(() => expect(runtime.api.listKnowledgeCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ path: '01AI', search: 'Agent' }), expect.any(AbortSignal)));
  await user.click(await screen.findByRole('button', { name: '在全库查找' }));
  await waitFor(() => expect(runtime.api.listKnowledgeCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ path: '', search: 'Agent' }), expect.any(AbortSignal)));
  expect(screen.getByLabelText('知识搜索范围')).toHaveValue('all');
});
it('keeps compact contents and the previous reading available after remount', async () => {
  const user = userEvent.setup(); const view = mount('/knowledge?folder=01AI/AI基础');
  await user.click(await screen.findByRole('button', { name: '紧凑目录' }));
  await user.click(screen.getByRole('button', { name: `展开 ${note.title} 知识纸页` }));
  await screen.findByText('实际阅读内容。'); view.unmount(); mount();
  await user.click(await screen.findByRole('button', { name: `继续上次调阅：${note.title}` }));
  await screen.findByText('实际阅读内容。');
  await user.click(screen.getByRole('button', { name: '收回纸页' }));
  expect(await screen.findByRole('button', { name: '紧凑目录' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('list', { name: '知识纸页' })).toHaveClass('kb-papers--compact');
});

it('keeps catalog papers mounted while a local refresh is pending', async () => {
  const user = userEvent.setup(); let resolve!: (value: ApiClientResult<Catalog>) => void;
  runtime.api.listKnowledgeCatalog = vi.fn().mockResolvedValueOnce(ok(catalog('01AI/AI基础')))
    .mockImplementationOnce(() => new Promise<ApiClientResult<Catalog>>(accept => { resolve = accept; }));
  mount('/knowledge?folder=01AI/AI基础');
  const paper = await screen.findByRole('button', { name: `展开 ${note.title} 知识纸页` });
  await user.click(screen.getByRole('button', { name: '刷新知识' }));
  expect(screen.getByRole('button', { name: `展开 ${note.title} 知识纸页` })).toBe(paper);
  await act(async () => resolve(ok(catalog('01AI/AI基础'))));
});

it('restores the last catalog filters when returning through the knowledge navigation', async () => {
  runtime.api.listKnowledgeCatalog = vi.fn(async query => ok(catalog(query.path, { folders: [], items: [], total: 0, directTotal: 0 })));
  const view = mount('/knowledge?folder=01AI&search=Agent&layout=compact&scope=current');
  await screen.findByText('当前筛选没有匹配的知识'); view.unmount(); mount();
  await waitFor(() => expect(address().get('folder')).toBe('01AI'));
  expect(address().get('search')).toBe('Agent'); expect(screen.getByLabelText('搜索知识')).toHaveValue('Agent');
  expect(screen.getByRole('button', { name: '紧凑目录' })).toHaveAttribute('aria-pressed', 'true');
});

it('uses the verified knowledge path to prepare an editable assistant draft', async () => {
  const listener = vi.fn(); window.addEventListener(ASSISTANT_INTENT_EVENT, listener);
  try {
    mount(`/knowledge?${new URLSearchParams({path: note.path})}`);
    await screen.findByText('实际阅读内容。');
    await userEvent.click(await screen.findByRole('button', { name: '用这篇知识' }));
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      prompt: '请用这篇知识拟一个文章提纲，标出依据，先给我预览。', contextPath: note.path
    });
    expect(runtime.api.openKnowledge).not.toHaveBeenCalled();
  } finally { window.removeEventListener(ASSISTANT_INTENT_EVENT, listener); }
});

it('keeps verified knowledge prose mounted during a refresh and removes it after a failed read', async () => {
  let resolveRefresh!: (value: ApiClientResult<LiveKnowledgeDetail>) => void;
  runtime.api.listKnowledgeCatalog = vi.fn(async query => ok(catalog(query.path, {folders: [], items: [], total: 0, directTotal: 0})));
  const first = await runtime.api.getKnowledgeDetail(note.path);
  runtime.api.getKnowledgeDetail = vi.fn().mockResolvedValueOnce(first)
    .mockImplementationOnce(() => new Promise(accept => { resolveRefresh = accept; }))
    .mockResolvedValueOnce({ok: false, state: {status: 'operation-error', message: 'Unavailable'}});
  mount(`/knowledge?${new URLSearchParams({ path: note.path })}`);
  const prose = await screen.findByText('实际阅读内容。'); const body = screen.getByRole('region', { name: '知识正文' });
  await userEvent.click(screen.getByRole('button', { name: '刷新知识' }));
  expect(screen.getByText('实际阅读内容。')).toBe(prose); expect(screen.getByRole('region', { name: '知识正文' })).toBe(body);
  expect(screen.queryByRole('button', { name: '用这篇知识' })).toBeNull();
  await act(async () => resolveRefresh(ok({path: note.path, title: note.title, record: {...note, rawSha256: 'b'.repeat(64)}, markdown: '核对后的新知识正文。', internalKnowledgeLinks: [], versionMarker: {rawSha256: 'b'.repeat(64)}})));
  expect(body).toHaveTextContent('核对后的新知识正文。');
  await userEvent.click(screen.getByRole('button', { name: '刷新知识' }));
  expect(await screen.findByRole('button', { name: '重新读取这篇知识' })).toBeVisible();
  expect(screen.queryByRole('region', { name: '知识正文' })).toBeNull();
});

it('does not compare a fresh detail against the old catalog snapshot while the catalog refresh is pending', async () => {
  let releaseCatalog!: (value: ApiClientResult<Catalog>) => void;
  const fresh = {...note, rawSha256: 'b'.repeat(64)};
  mount(`/knowledge?${new URLSearchParams({ path: note.path })}`);
  await screen.findByText('实际阅读内容。');
  runtime.api.listKnowledgeCatalog = vi.fn(() => new Promise<ApiClientResult<Catalog>>(accept => { releaseCatalog = accept; }));
  runtime.api.getKnowledgeDetail = vi.fn(async () => ok({path: fresh.path, title: fresh.title, record: fresh, markdown: '确认为新的同路径正文。', internalKnowledgeLinks: [], versionMarker: {rawSha256: fresh.rawSha256}}));
  await userEvent.click(screen.getByRole('button', { name: '刷新知识' }));
  expect(await screen.findByText('确认为新的同路径正文。')).toBeVisible();
  expect(screen.queryByText('知识版本与列表不一致，请刷新后重试')).toBeNull();
  await act(async () => releaseCatalog(ok(catalog('01AI/AI基础', {items: [fresh]}))));
  expect(screen.getByText('确认为新的同路径正文。')).toBeVisible();
});

it('rereads all previously loaded knowledge pages before restoring a deep directory position', async () => {
  const second = {...note, path: '02知识库/01AI/AI基础/旧第二页.md', title: '旧第二页知识'};
  const freshSecond = {...note, path: '02知识库/01AI/AI基础/新第二页.md', title: '新第二页知识'};
  let returning = false; let resolve!: (value: ApiClientResult<Catalog>) => void;
  const pending = new Promise<ApiClientResult<Catalog>>(accept => { resolve = accept; });
  let scroll = 0; const position = vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scroll);
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  try {
    runtime.api.listKnowledgeCatalog = vi.fn(async query => {
      if (returning && query.cursor) return pending;
      return ok(query.cursor ? catalog(query.path, {items: [second], total: 2, directTotal: 2}) : catalog(query.path, {total: 2, directTotal: 2, nextCursor: returning ? 'fresh-page-2' : 'old-page-2'}));
    });
    const view = mount('/knowledge?folder=01AI/AI基础');
    await userEvent.click(await screen.findByRole('button', { name: '加载更多' }));
    await screen.findByRole('button', { name: '展开 旧第二页知识 知识纸页' });
    scroll = 620; fireEvent.scroll(window); view.unmount(); returning = true; scroll = 0; scrollTo.mockClear(); mount();
    await waitFor(() => expect(runtime.api.listKnowledgeCatalog).toHaveBeenLastCalledWith(expect.objectContaining({cursor: 'fresh-page-2'}), expect.any(AbortSignal)));
    expect(scrollTo).not.toHaveBeenCalledWith({top: 620, behavior: 'instant'});
    await act(async () => resolve(ok(catalog('01AI/AI基础', {items: [freshSecond], total: 2, directTotal: 2}))));
    expect(await screen.findByRole('button', { name: '展开 新第二页知识 知识纸页' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '展开 旧第二页知识 知识纸页' })).toBeNull();
    expect(scrollTo).toHaveBeenCalledWith({top: 620, behavior: 'instant'});
  } finally { position.mockRestore(); scrollTo.mockRestore(); }
});
