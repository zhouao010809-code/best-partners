import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserReadConsoleApi, type ApiClientResult, type LiveDocumentDetail, type MaterialPage } from '../../src/client/api/client.js';
import type { ConsoleRuntime } from '../../src/client/app/ConsoleRuntime.js';
import { AppRouter } from '../../src/client/app/router.js';
import { LibraryPage } from '../../src/client/pages/LibraryPage.js';
import type { LibraryPage as LibraryResponse } from '../../src/shared/api/library.js';

let runtime: ConsoleRuntime;
vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => runtime }));
const ok = <T,>(value: T): ApiClientResult<T> => ({ ok: true, value });
const failed = <T,>(): ApiClientResult<T> => ({ ok: false, state: { status: 'operation-error', message: 'SECRET' } });
const item = (title = '历史资料', overrides: Partial<MaterialPage['items'][number]> = {}): MaterialPage['items'][number] => ({
  path: `01图书馆/来自个人/${title}.md`, title, rawSha256: 'a'.repeat(64), sourcePlatform: '个人',
  processingStatus: '已归档', knowledgeStatus: '已入库', generatedKnowledge: [], ...overrides
});
const detail = (record = item(), markdown = '完整原文'): LiveDocumentDetail => ({
  path: record.path, title: record.title, markdown,
  versionMarker: { rawSha256: record.rawSha256, ...(record.upstreamVersion ? { upstreamVersion: record.upstreamVersion } : {}) }
});
const page = (items = [item()], overrides: Partial<LibraryResponse> = {}): LibraryResponse => ({
  mode: 'topic', path: '', breadcrumbs: [{ path: '', label: '全部资料' }], folders: [],
  items, total: items.length, directTotal: items.length, unclassifiedCount: 0, indexVersion: 1, ...overrides
});
async function openVault() {
  const opener = screen.queryByRole('button', { name: '打开档案柜' });
  if (opener) await userEvent.click(opener);
  await screen.findByLabelText('资料标题', {}, { timeout: 2000 });
  await waitFor(() => expect(screen.getByRole('button', { name: '封存并合柜' })).toBeEnabled());
}
function NavigationProbe() {
  const location = useLocation(); const navigate = useNavigate();
  return <><output aria-label="地址">{location.search}</output><button onClick={() => navigate(-1)}>浏览器返回</button><button onClick={() => navigate(1)}>浏览器前进</button></>;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((accept) => { resolve = accept; }), resolve: (value: T) => resolve(value) };
}
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  runtime = {
    dataRevision: 0, refreshHealth: vi.fn(async () => {}),
    health: { status: 'ready', data: {
      status: 'ready', vaultSource: { status: 'ready', adapter: 'filesystem', displayName: '我的大脑' },
      index: { status: 'ready', version: 1, refreshedAt: '2026-09-05T00:00:00.000Z' },
      model: { status: 'unavailable', reason: 'CONFIG_UNAVAILABLE' },
      writeGate: { status: 'blocked', missing: ['writeEnabled'], fingerprintMatches: false },
      schemaIssues: { status: 'available', count: 21 }
    } },
    api: {
      ...browserReadConsoleApi,
      listMaterials: vi.fn(async () => ok({ items: [item()] })),
      listLibrary: vi.fn(async () => ok(page())),
      getDocumentDetail: vi.fn(async () => ok(detail())),
      getHealth: vi.fn(async () => ok(runtime.health.status === 'ready' ? runtime.health.data : undefined!))
    }
  };
});
afterEach(() => { cleanup(); localStorage.clear(); });

describe('original material library', () => {
  it('keeps archives sealed initially and opens exact linked files without another entry animation', async () => {
    const user = userEvent.setup();
    const view = render(<MemoryRouter><LibraryPage /></MemoryRouter>);
    expect(screen.getByRole('button', { name: '打开档案柜' })).toBeVisible();
    expect(runtime.api.listLibrary).not.toHaveBeenCalled();
    expect(runtime.api.getDocumentDetail).not.toHaveBeenCalled();
    expect(screen.getByLabelText('资料标题')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '打开档案柜' }));
    expect(await screen.findByRole('button', { name: '查看 历史资料 原文' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '封存并合柜' }));
    expect(screen.queryByRole('button', { name: '查看 历史资料 原文' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: '打开档案柜' })).toBeEnabled());
    expect(screen.getByRole('button', { name: '打开档案柜' })).toHaveFocus();
    view.unmount();
    render(<MemoryRouter initialEntries={[`/library?${new URLSearchParams({ path: item().path })}`]}><LibraryPage /></MemoryRouter>);
    expect(await screen.findByLabelText('原始文件内容')).toBeVisible();
    expect(screen.queryByRole('button', { name: '打开档案柜' })).toBeNull();
  });

  it('adds a navigation entry and defaults to all statuses in topic collections without reading bodies', async () => {
    render(<MemoryRouter initialEntries={['/library']}><AppRouter api={runtime.api} /></MemoryRouter>);
    await openVault();
    expect(screen.getByRole('link', { name: '档案库' })).toHaveAttribute('href', '/library');
    expect(screen.getByRole('heading', { level: 1, name: '档案库' })).toBeVisible();
    expect(await screen.findByRole('button', { name: '查看 历史资料 原文' })).toBeVisible();
    expect(runtime.api.listLibrary).toHaveBeenCalledWith({ mode: 'topic', path: '', limit: 200 }, expect.any(AbortSignal));
    expect(screen.getByLabelText('入库状态')).toHaveValue('');
    expect(screen.getByRole('button', { name: '主题馆藏' })).toHaveAttribute('aria-pressed', 'true');
    expect(runtime.api.listMaterials).not.toHaveBeenCalled();
    expect(runtime.api.getDocumentDetail).not.toHaveBeenCalled();
  });

  it.each(['未提炼', '部分入库'])('applies title and %s filters precisely', async (status) => {
    const user = userEvent.setup();
    runtime.api.listLibrary = vi.fn(async () => ok(page([])));
    render(<MemoryRouter><LibraryPage /><NavigationProbe /></MemoryRouter>);
    await openVault();
    await user.selectOptions(screen.getByLabelText('入库状态'), status);
    await user.type(screen.getByLabelText('资料标题'), '  一份资料  ');
    await waitFor(() => expect(runtime.api.listLibrary).toHaveBeenLastCalledWith({ mode: 'topic', path: '', status, title: '一份资料', limit: 200 }, expect.any(AbortSignal)));
    expect(new URLSearchParams(screen.getByLabelText('地址').textContent ?? '').get('title')).toBe('一份资料');
    expect(await screen.findByText('当前筛选范围内没有原始资料')).toBeVisible();
  });

  it('appends another page and disables repeated pagination requests while loading', async () => {
    const user = userEvent.setup();
    const pending = deferred<ApiClientResult<LibraryResponse>>();
    runtime.api.listLibrary = vi.fn().mockResolvedValueOnce(ok(page([item()], { total: 2, directTotal: 2, nextCursor: 'cursor-a' })))
      .mockImplementationOnce(() => pending.promise);
    render(<MemoryRouter><LibraryPage /></MemoryRouter>);
    await openVault();
    await user.click(await screen.findByRole('button', { name: '加载更多' }));
    expect(screen.getByRole('button', { name: '加载中' })).toBeDisabled();
    expect(screen.getByText('已加载 1 / 2 份资料')).toBeVisible();
    await act(async () => pending.resolve(ok(page([item('另一份资料')], { total: 2, directTotal: 2 }))));
    expect(screen.getByRole('button', { name: '查看 历史资料 原文' })).toBeVisible();
    expect(screen.getByRole('button', { name: '查看 另一份资料 原文' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull();
  });

  it.each(['duplicate path', 'repeated cursor', 'wrong status', 'index version', 'total', 'folder metadata', 'mode', 'path', 'breadcrumbs', 'empty next page'])('rejects invalid pagination: %s', async (kind) => {
    const user = userEvent.setup();
    const next = kind === 'duplicate path' ? { items: [item()] }
      : kind === 'repeated cursor' ? { items: [item('另一份')], nextCursor: 'cursor-a' }
      : kind === 'wrong status' ? { items: [item('错误状态', { knowledgeStatus: '未提炼' })] }
      : kind === 'index version' ? { indexVersion: 2 }
      : kind === 'total' ? { total: 99 }
      : kind === 'folder metadata' ? { folders: [{ path: '01AI', label: 'AI', count: 1, folderCount: 0 }] }
      : kind === 'mode' ? { mode: 'source' as const }
      : kind === 'path' ? { path: '01AI' }
      : kind === 'breadcrumbs' ? { breadcrumbs: [{ path: '', label: '不同目录' }] }
      : { items: [], nextCursor: 'cursor-b' };
    runtime.api.listLibrary = vi.fn().mockResolvedValueOnce(ok(page([item()], { total: 2, directTotal: 2, nextCursor: 'cursor-a' })))
      .mockResolvedValueOnce(ok(page([item('另一份')], { total: 2, directTotal: 2, ...next })));
    render(<MemoryRouter initialEntries={['/library?status=已入库']}><LibraryPage /></MemoryRouter>);
    await openVault();
    await user.click(await screen.findByRole('button', { name: '加载更多' }));
    expect(await screen.findByText('资料列表响应不符合当前筛选或分页规则')).toBeVisible();
    expect(screen.getByRole('button', { name: '加载更多' })).toBeDisabled();
  });

  it('aborts stale filter responses and never mixes results from different searches', async () => {
    const user = userEvent.setup();
    const pending = deferred<ApiClientResult<LibraryResponse>>();
    let oldSignal: AbortSignal | undefined;
    runtime.api.listLibrary = vi.fn().mockImplementationOnce((_query, signal) => { oldSignal = signal; return pending.promise; })
      .mockResolvedValueOnce(ok(page([item('新搜索结果')])));
    render(<MemoryRouter><LibraryPage /></MemoryRouter>);
    await openVault();
    expect(screen.getByText('正在读取原始资料')).toBeVisible();
    await user.type(screen.getByLabelText('资料标题'), '新搜索');
    expect(await screen.findByRole('button', { name: '查看 新搜索结果 原文' })).toBeVisible();
    await act(async () => pending.resolve(ok(page([item('过期结果')]))));
    expect(oldSignal?.aborted).toBe(true);
    expect(screen.queryByText('过期结果')).toBeNull();
  });

  it('renders literal original content safely and restores focus when closed', async () => {
    const user = userEvent.setup();
    const original = '---\n类型: 原始资料\n---\n<script>secret()</script>\n![图](https://example.com/image.png)';
    runtime.api.getDocumentDetail = vi.fn(async () => ok(detail(item(), original)));
    render(<MemoryRouter><LibraryPage /></MemoryRouter>);
    await openVault();
    const trigger = await screen.findByRole('button', { name: '查看 历史资料 原文' });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: '历史资料 原文' });
    expect(await within(dialog).findByLabelText('原始 Markdown 与 YAML')).toHaveTextContent('类型: 原始资料');
    expect(within(dialog).getByLabelText('原始文件内容').querySelector('script, img, iframe')).toBeNull();
    expect(dialog.querySelector('pre')?.textContent).toBe(original);
    expect(dialog.querySelector('pre')?.querySelector('script, img, iframe, a')).toBeNull();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('keeps a selected original in the URL across back, forward and reload without losing library filters', async () => {
    const user = userEvent.setup();
    runtime.api.listLibrary = vi.fn(async () => ok(page([item()], { mode: 'source', path: '来自个人', breadcrumbs: [{ path: '', label: '全部资料' }, { path: '来自个人', label: '个人' }] })));
    const route = '/library?mode=source&folder=来自个人&status=已入库&title=历史';
    const view = render(<MemoryRouter initialEntries={[route]}><LibraryPage /><NavigationProbe /></MemoryRouter>);
    await openVault();
    await user.click(await screen.findByRole('button', { name: '查看 历史资料 原文' }));
    await screen.findByLabelText('原始文件内容');
    const address = screen.getByLabelText('地址').textContent!;
    const params = new URLSearchParams(address);
    expect(params.get('path')).toBe(item().path);
    expect(params.get('folder')).toBe('来自个人'); expect(params.get('status')).toBe('已入库'); expect(params.get('title')).toBe('历史');
    await user.click(screen.getByRole('button', { name: '浏览器返回' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: '浏览器前进' }));
    expect(await screen.findByLabelText('原始文件内容')).toBeVisible();
    view.unmount();
    render(<MemoryRouter initialEntries={[`/library${address}`]}><LibraryPage /><NavigationProbe /></MemoryRouter>);
    await openVault();
    expect(await screen.findByLabelText('原始文件内容')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '关闭原文' }));
    const closed = new URLSearchParams(screen.getByLabelText('地址').textContent!);
    expect(closed.has('path')).toBe(false); expect(closed.get('folder')).toBe('来自个人');
  });

  it.each(['path', 'hash', 'upstreamVersion'])('does not display original content when %s differs from the selected record', async (field) => {
    const user = userEvent.setup();
    const record = item('有版本资料', { upstreamVersion: 'v1' });
    const response = detail(record, '不应展示的原文');
    if (field === 'path') response.path = '01图书馆/其他.md';
    else if (field === 'hash') response.versionMarker.rawSha256 = 'b'.repeat(64);
    else response.versionMarker.upstreamVersion = 'v2';
    runtime.api.listLibrary = vi.fn(async () => ok(page([record])));
    runtime.api.getDocumentDetail = vi.fn(async () => ok(response));
    render(<MemoryRouter><LibraryPage /></MemoryRouter>);
    await openVault();
    await user.click(await screen.findByRole('button', { name: '查看 有版本资料 原文' }));
    expect(await screen.findByText('资料版本与列表不一致，请刷新资料后重试')).toBeVisible();
    expect(screen.queryByText('不应展示的原文')).toBeNull();
  });

  it('cancels an old detail when another material is selected and when the index revision changes', async () => {
    const user = userEvent.setup();
    const pending = deferred<ApiClientResult<LiveDocumentDetail>>();
    let oldSignal: AbortSignal | undefined;
    runtime.api.listLibrary = vi.fn(async () => ok(page([item(), item('第二份')])));
    runtime.api.getDocumentDetail = vi.fn().mockImplementationOnce((_path, signal) => { oldSignal = signal; return pending.promise; })
      .mockResolvedValueOnce(ok(detail(item('第二份'), '第二份原文')))
      .mockResolvedValueOnce(ok(detail(item('第二份'), '刷新后的第二份原文')));
    const view = render(<MemoryRouter><LibraryPage /></MemoryRouter>);
    await openVault();
    await user.click(await screen.findByRole('button', { name: '查看 历史资料 原文' }));
    await user.click(screen.getByRole('button', { name: '查看 第二份 原文' }));
    expect(await screen.findByText('第二份原文', { selector: 'p' })).toBeVisible();
    await act(async () => pending.resolve(ok(detail(item(), '过期原文'))));
    expect(oldSignal?.aborted).toBe(true);
    expect(screen.queryByText('过期原文')).toBeNull();
    runtime = { ...runtime, dataRevision: 1 };
    view.rerender(<MemoryRouter><LibraryPage /></MemoryRouter>);
    expect(await screen.findByText('刷新后的第二份原文', { selector: 'p' })).toBeVisible();
    expect(screen.queryByText('第二份原文', { selector: 'p' })).toBeNull();
    await waitFor(() => expect(runtime.api.listLibrary).toHaveBeenCalledTimes(2));
  });

  it('offers retry after list and original-content failures without showing server details', async () => {
    const user = userEvent.setup();
    runtime.api.listLibrary = vi.fn().mockResolvedValueOnce(failed()).mockResolvedValueOnce(ok(page()));
    runtime.api.getDocumentDetail = vi.fn().mockResolvedValueOnce(failed()).mockResolvedValueOnce(ok(detail()));
    render(<MemoryRouter><LibraryPage /></MemoryRouter>);
    await openVault();
    await user.click(await screen.findByRole('button', { name: '重试读取资料' }));
    await user.click(await screen.findByRole('button', { name: '查看 历史资料 原文' }));
    await user.click(await screen.findByRole('button', { name: '重试读取原文' }));
    expect(await screen.findByText('完整原文', { selector: 'p' })).toBeVisible();
    expect(screen.queryByText('SECRET')).toBeNull();
  });
});

it('opens an exact linked source outside the selected status and page without scanning for it', async () => {
  const source = item('链接指定资料', { knowledgeStatus: '部分入库' });
  runtime.api.listLibrary = vi.fn(async () => ok(page([])));
  runtime.api.getDocumentDetail = vi.fn(async () => ok(detail(source, '路径指定的完整原文')));
  render(<MemoryRouter initialEntries={[`/library?${new URLSearchParams({ path: source.path })}`]}><LibraryPage /></MemoryRouter>);
    await openVault();
  expect(await screen.findByText('路径指定的完整原文', { selector: 'p' })).toBeVisible();
  expect(runtime.api.getDocumentDetail).toHaveBeenCalledExactlyOnceWith(source.path, expect.any(AbortSignal));
  expect(runtime.api.listLibrary).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('link', { name: '返回这份资料的提炼工作台' })).toHaveAttribute('href', `/queue?${new URLSearchParams({ view: 'ready', materialPath: source.path })}`);
});

it('drills through real topic folders and returns without summing overlapping counts', async () => {
  const user = userEvent.setup();
  const records = [item('已入库资料'), item('未提炼资料', { knowledgeStatus: '未提炼' }), item('部分资料', { knowledgeStatus: '部分入库' })];
  runtime.api.listLibrary = vi.fn(async (query) => ok(query.path === '01AI/AI工具'
    ? page(records, { path: '01AI/AI工具', breadcrumbs: [{ path: '', label: '全部资料' }, { path: '01AI', label: 'AI' }, { path: '01AI/AI工具', label: 'AI工具' }] })
    : query.path === '01AI' ? page([], { path: '01AI', breadcrumbs: [{ path: '', label: '全部资料' }, { path: '01AI', label: 'AI' }], folders: [{ path: '01AI/AI工具', label: 'AI工具', count: 3, folderCount: 0 }], total: 3 })
      : page([], { folders: [{ path: '01AI', label: 'AI', count: 3, folderCount: 1 }, { path: '05设计', label: '设计', count: 1, folderCount: 0 }, { path: '@unclassified', label: '待分类', count: 1, folderCount: 0 }], total: 4, unclassifiedCount: 1 })));
  render(<MemoryRouter initialEntries={['/library']}><LibraryPage /><NavigationProbe /></MemoryRouter>);
    await openVault();
  expect(await screen.findByText('共 4 份资料')).toBeVisible();
  expect(screen.getByRole('button', { name: '打开 待分类' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '打开 AI' }));
  await user.click(await screen.findByRole('button', { name: '打开 AI工具' }));
  for (const record of records) expect(await screen.findByRole('button', { name: `查看 ${record.title} 原文` })).toBeVisible();
  expect(new URLSearchParams(screen.getByLabelText('地址').textContent ?? '').get('folder')).toBe('01AI/AI工具');
  expect(runtime.api.getDocumentDetail).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '返回上一级' }));
  expect(await screen.findByRole('button', { name: '打开 AI工具' })).toBeVisible();
  await user.click(within(screen.getByRole('navigation', { name: '当前位置' })).getByRole('button', { name: '全部资料' }));
  expect(await screen.findByRole('button', { name: '打开 AI' })).toBeVisible();
});

it('restores URL filters including empty title through history and resets folder on view switch', async () => {
  const user = userEvent.setup();
  runtime.api.listLibrary = vi.fn(async (query) => ok(page([], { mode: query.mode ?? 'topic', path: query.path ?? '', breadcrumbs: query.path ? [{ path: '', label: '全部资料' }, { path: query.path, label: 'AI' }] : [{ path: '', label: '全部资料' }] })));
  render(<MemoryRouter initialEntries={['/library', '/library?mode=topic&folder=01AI&status=部分入库&title=资料']} initialIndex={1}><LibraryPage /><NavigationProbe /></MemoryRouter>);
    await openVault();
  expect(screen.getByLabelText('资料标题')).toHaveValue('资料');
  expect(screen.getByLabelText('入库状态')).toHaveValue('部分入库');
  await user.click(screen.getByRole('button', { name: '浏览器返回' }));
  await waitFor(() => expect(screen.getByLabelText('资料标题')).toHaveValue(''));
  expect(screen.getByLabelText('入库状态')).toHaveValue('');
  await user.click(screen.getByRole('button', { name: '浏览器前进' }));
  await waitFor(() => expect(screen.getByLabelText('资料标题')).toHaveValue('资料'));
  await user.click(screen.getByRole('button', { name: '来源目录' }));
  await waitFor(() => expect(runtime.api.listLibrary).toHaveBeenLastCalledWith({ mode: 'source', path: '', status: '部分入库', title: '资料', limit: 200 }, expect.any(AbortSignal)));
  const search = new URLSearchParams(screen.getByLabelText('地址').textContent ?? '');
  expect(search.has('folder')).toBe(false); expect(search.has('path')).toBe(false);
  await user.clear(screen.getByLabelText('资料标题'));
  await waitFor(() => expect(runtime.api.listLibrary).toHaveBeenLastCalledWith({ mode: 'source', path: '', status: '部分入库', limit: 200 }, expect.any(AbortSignal)));
});

it('refreshes on health index changes and offers a way out of disappeared folders', async () => {
  const user = userEvent.setup();
  runtime.api.listLibrary = vi.fn().mockResolvedValueOnce(failed()).mockResolvedValue(ok(page([])));
  const view = render(<MemoryRouter initialEntries={['/library?folder=01AI']}><LibraryPage /></MemoryRouter>);
    await openVault();
  await user.click(await screen.findByRole('button', { name: '返回全部资料' }));
  expect(await screen.findByText('当前筛选范围内没有原始资料')).toBeVisible();
  if (runtime.health.status === 'ready') runtime = { ...runtime, health: { status: 'ready', data: { ...runtime.health.data, index: { status: 'ready', version: 2, refreshedAt: '2026-09-07T00:00:00.000Z' } } } };
  view.rerender(<MemoryRouter initialEntries={['/library?folder=01AI']}><LibraryPage /></MemoryRouter>);
  await waitFor(() => expect(runtime.api.listLibrary).toHaveBeenCalledTimes(3));
});

it('cancels a pending next page when the status changes and resets pagination', async () => {
  const user = userEvent.setup();
  const pending = deferred<ApiClientResult<LibraryResponse>>(); let oldSignal: AbortSignal | undefined;
  runtime.api.listLibrary = vi.fn().mockResolvedValueOnce(ok(page([item()], { total: 2, directTotal: 2, nextCursor: 'cursor-a' })))
    .mockImplementationOnce((_query, signal) => { oldSignal = signal; return pending.promise; })
    .mockResolvedValueOnce(ok(page([item('新范围', { knowledgeStatus: '未提炼' })])));
  render(<MemoryRouter><LibraryPage /></MemoryRouter>);
    await openVault();
  await user.click(await screen.findByRole('button', { name: '加载更多' }));
  await user.selectOptions(screen.getByLabelText('入库状态'), '未提炼');
  expect(await screen.findByRole('button', { name: '查看 新范围 原文' })).toBeVisible();
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => pending.resolve(ok(page([item('过期第二页')], { total: 2, directTotal: 2 }))));
  expect(screen.queryByRole('button', { name: '查看 历史资料 原文' })).toBeNull();
  expect(screen.queryByRole('button', { name: '查看 过期第二页 原文' })).toBeNull();
  expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull();
});

it('refreshes collection counts after a manual trash operation and links its receipt to the unified recycle workspace', async () => {
  const user = userEvent.setup(); const record = item(); const id = '62b6b258-8469-45ac-ae2e-a3c6a46af160';
  runtime.api.listLibrary = vi.fn().mockResolvedValueOnce(ok(page())).mockResolvedValue(ok(page([])));
  runtime = { ...runtime, api: { ...runtime.api, trash: {
    ...browserReadConsoleApi.trash!,
    preview: vi.fn(async () => ok({ id, materialPath: record.path, title: record.title, bytes: 123, expiresAt: '2099-01-01T00:00:00Z', referencedKnowledge: [] })),
    commit: vi.fn(async () => ok({ id, materialPath: record.path, title: record.title, status: 'trashed' as const, indexed: true, createdAt: '2026-09-07T00:00:00Z' })),
    list: vi.fn(async () => ok({ items: [] }))
  } } };
  render(<MemoryRouter initialEntries={['/library']}><LibraryPage /></MemoryRouter>);
    await openVault();
  const action = await screen.findByRole('button', { name: '移入回收站：历史资料' });
  expect(action.parentElement?.closest('button')).toBeNull();
  await user.click(action); await user.click(await screen.findByRole('button', { name: '确认移入回收站' }));
  await waitFor(() => expect(runtime.api.listLibrary).toHaveBeenCalledTimes(2));
  expect(screen.getByText('共 0 份资料')).toBeVisible();
  expect(screen.queryByRole('button', { name: '查看 历史资料 原文' })).toBeNull();
  expect(screen.getByRole('link', { name: '查看回收站' })).toHaveAttribute('href', '/trash');
  await user.click(screen.getByRole('button', { name: '关闭回收操作' }));
  expect(screen.queryByRole('link', { name: '回收站' })).toBeNull();
});


it('searches before opening the cabinet and Enter applies the title immediately', async () => {
  runtime.api.listLibrary = vi.fn(async query => ok(page([item('已知标题')])));
  render(<MemoryRouter><LibraryPage /><NavigationProbe /></MemoryRouter>);
  const input = screen.getByRole('searchbox', { name: '资料标题' });
  expect(runtime.api.listLibrary).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '已知标题' } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => expect(runtime.api.listLibrary).toHaveBeenCalledWith(expect.objectContaining({ title: '已知标题', path: '' }), expect.any(AbortSignal)));
  expect(input).toHaveValue('已知标题');
});
it('renders formatted original prose while keeping exact Markdown and YAML collapsed', async () => {
  const original = '---\n标题: 保留属性\n---\n# 可读标题\n\n**重点**与普通正文。';
  runtime.api.getDocumentDetail = vi.fn(async () => ok(detail(item(), original)));
  render(<MemoryRouter initialEntries={[`/library?${new URLSearchParams({ path: item().path })}`]}><LibraryPage /></MemoryRouter>);
  expect(await screen.findByRole('heading', { name: '可读标题' })).toBeVisible();
  expect(screen.getByText('重点').tagName).toBe('STRONG');
  const raw = screen.getByLabelText('原始 Markdown 与 YAML');
  expect(raw.textContent).toBe(original); expect(raw.closest('details')).not.toHaveAttribute('open');
});
it('offers the previous original on reentry and retains its filters', async () => {
  const user = userEvent.setup(); const route = `/library?${new URLSearchParams({ path: item().path, title: '历史', status: '已入库' })}`;
  const view = render(<MemoryRouter initialEntries={[route]}><LibraryPage /></MemoryRouter>);
  await screen.findByLabelText('原始文件内容'); view.unmount();
  render(<MemoryRouter><LibraryPage /><NavigationProbe /></MemoryRouter>);
  await user.click(await screen.findByRole('button', { name: '继续上次调阅：历史资料' }));
  expect(await screen.findByLabelText('原始文件内容')).toBeVisible();
  const params = new URLSearchParams(screen.getByLabelText('地址').textContent!);
  expect(params.get('title')).toBe('历史'); expect(params.get('status')).toBe('已入库');
});

it('keeps the list mounted during a local refresh and preserves its reading position', async () => {
  const user = userEvent.setup(); const pending = deferred<ApiClientResult<LibraryResponse>>();
  runtime.api.listLibrary = vi.fn().mockResolvedValueOnce(ok(page())).mockImplementationOnce(() => pending.promise);
  render(<MemoryRouter><LibraryPage /></MemoryRouter>); await openVault();
  const row = await screen.findByRole('button', { name: '查看 历史资料 原文' });
  const scroller = row.closest('.archive-vault__contents')!;
  scroller.scrollTop = 240; fireEvent.scroll(scroller);
  await user.click(screen.getByRole('button', { name: '刷新资料' }));
  expect(screen.getByRole('button', { name: '查看 历史资料 原文' })).toBe(row);
  await act(async () => pending.resolve(ok(page())));
  expect(scroller.scrollTop).toBe(240);
});

it('opens a linked archive directory, expands empty title searches and can seal the selected original', async () => {
  const user = userEvent.setup();
  runtime.api.listLibrary = vi.fn(async query => ok(page(query.path ? [] : [item()], {
    mode: query.mode ?? 'topic', path: query.path ?? '', breadcrumbs: [{ path: '', label: '全部资料' }, ...(query.path ? [{ path: query.path, label: '个人' }] : [])]
  })));
  render(<MemoryRouter initialEntries={['/library?mode=source&folder=来自个人&title=历史']}><LibraryPage /><NavigationProbe /></MemoryRouter>);
  expect(screen.queryByRole('button', { name: '打开档案柜' })).toBeNull();
  await user.click(await screen.findByRole('button', { name: '在全部档案查找' }));
  await user.click(await screen.findByRole('button', { name: '查看 历史资料 原文' }));
  await screen.findByLabelText('原始文件内容');
  await user.click(screen.getByRole('button', { name: '封存并合柜' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '打开档案柜' })).toBeEnabled());
  expect(new URLSearchParams(screen.getByLabelText('地址').textContent!).get('title')).toBe('历史');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('honors an immediate search while the cabinet is closing', async () => {
  render(<MemoryRouter initialEntries={['/library?title=历史']}><LibraryPage /></MemoryRouter>);
  await screen.findByRole('button', { name: '查看 历史资料 原文' });
  fireEvent.click(screen.getByRole('button', { name: '封存并合柜' }));
  fireEvent.submit(screen.getByRole('searchbox', { name: '资料标题' }).closest('form')!);
  await waitFor(() => expect(screen.getByRole('button', { name: '封存并合柜' })).toBeEnabled());
  expect(screen.getByRole('button', { name: '查看 历史资料 原文' })).toBeVisible();
});

it('keeps the same original mounted while checking its fresh version and removes it on a read failure', async () => {
  const refreshed = deferred<ApiClientResult<LiveDocumentDetail>>();
  const unavailable = deferred<ApiClientResult<LiveDocumentDetail>>();
  runtime.api.getDocumentDetail = vi.fn().mockResolvedValueOnce(ok(detail(item(), '正在阅读的原文')))
    .mockImplementationOnce(() => refreshed.promise).mockImplementationOnce(() => unavailable.promise);
  render(<MemoryRouter initialEntries={[`/library?${new URLSearchParams({ path: item().path })}`]}><LibraryPage /></MemoryRouter>);
  const body = await screen.findByLabelText('原始文件内容'); const scroller = body.closest('.archive-vault__contents')!;
  const raw = screen.getByLabelText('原始 Markdown 与 YAML').closest('details')!; raw.open = true;
  scroller.scrollTop = 420;
  await userEvent.click(screen.getByRole('button', { name: '刷新资料' }));
  expect(screen.getByLabelText('原始文件内容')).toBe(body); expect(body).toHaveTextContent('正在阅读的原文');
  expect(raw.open).toBe(true); expect(scroller.scrollTop).toBe(420);
  await act(async () => refreshed.resolve(ok(detail(item('历史资料', { rawSha256: 'b'.repeat(64) }), '已核对的新原文'))));
  expect(body).toHaveTextContent('已核对的新原文'); expect(scroller.scrollTop).toBe(420);
  await userEvent.click(screen.getByRole('button', { name: '刷新资料' }));
  expect(screen.getByLabelText('原始文件内容')).toBe(body);
  await act(async () => unavailable.resolve(failed()));
  expect(screen.queryByLabelText('原始文件内容')).toBeNull(); expect(await screen.findByRole('button', { name: '重试读取原文' })).toBeVisible();
});

it('reloads the previously loaded archive pages before restoring a deep catalog position', async () => {
  const second = item('第二页旧资料'); const freshSecond = item('第二页新资料');
  const pending = deferred<ApiClientResult<LibraryResponse>>(); let returning = false;
  runtime.api.listLibrary = vi.fn(async query => {
    if (returning && query.cursor) return pending.promise;
    return ok(query.cursor ? page([second], {total: 2, directTotal: 2}) : page([item()], {total: 2, directTotal: 2, nextCursor: returning ? 'fresh-page-2' : 'old-page-2'}));
  });
  const view = render(<MemoryRouter><LibraryPage /></MemoryRouter>); await openVault();
  await userEvent.click(await screen.findByRole('button', { name: '加载更多' }));
  const row = await screen.findByRole('button', { name: '查看 第二页旧资料 原文' });
  const oldScroller = row.closest('.archive-vault__contents')!; oldScroller.scrollTop = 620; fireEvent.scroll(oldScroller); view.unmount();
  returning = true; render(<MemoryRouter><LibraryPage /></MemoryRouter>);
  await waitFor(() => expect(runtime.api.listLibrary).toHaveBeenLastCalledWith(expect.objectContaining({cursor: 'fresh-page-2'}), expect.any(AbortSignal)));
  const scroller = screen.getByRole('region', { name: '档案柜' }).querySelector('.archive-vault__contents')!;
  expect(scroller.scrollTop).toBe(0); expect(screen.queryByRole('button', { name: '查看 第二页旧资料 原文' })).toBeNull();
  await act(async () => pending.resolve(ok(page([freshSecond], {total: 2, directTotal: 2}))));
  expect(await screen.findByRole('button', { name: '查看 第二页新资料 原文' })).toBeVisible();
  expect(scroller.scrollTop).toBe(620);
});
