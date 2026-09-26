import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReadConsoleApi, ApiClientResult } from '../../src/client/api/client.js';
import type { ProjectFile, ProjectFileDetail, ProjectFilePage } from '../../src/shared/api/projects.js';
import { ProjectFilesPanel } from '../../src/client/components/projects/ProjectFilesPanel.js';

afterEach(cleanup);
const ok = <T,>(value: T) => ({ ok: true as const, value });
const file = (relativePath: string, extras: Partial<ProjectFile> = {}): ProjectFile => ({ relativePath, kind: 'file', parseStatus: 'readable', bytes: 1024, ...extras });
const folder = (relativePath: string): ProjectFile => ({ relativePath, kind: 'directory' });
function fixture(source: ProjectFile[] = [file('brief.md')], output: ProjectFile[] = []) {
  const files = vi.fn<NonNullable<ReadConsoleApi['projects']>['files']>(async (_id, query) => {
    const items = query.origin === 'output' ? output : source;
    return ok({ items, total: items.length, revision: 1 });
  });
  const read = vi.fn<NonNullable<ReadConsoleApi['projects']>['file']>(async (_id, path) => ok({ ...file(path), content: `正文：${path}` }));
  const api = { projects: { files, file: read } } as unknown as ReadConsoleApi;
  return { api, files, read };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it('uses collapsed nested folders and basenames while reading the original API path', async () => {
  const f = fixture([folder('资料'), folder('资料/策略'), file('资料/策略/方案.md'), file('封面.png', { parseStatus: 'unsupported', bytes: 1024 * 1024 })]);
  const user = userEvent.setup();
  render(<ProjectFilesPanel api={f.api} projectId="project-1" />);
  const root = await screen.findByRole('button', { name: '展开文件夹：资料' });
  expect(root).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText('方案.md')).not.toBeInTheDocument();
  await user.click(root);
  await user.click(screen.getByRole('button', { name: '展开文件夹：资料/策略' }));
  const row = screen.getByRole('button', { name: '打开文件：资料/策略/方案.md' });
  expect(within(row).getByText('方案.md')).toBeVisible();
  expect(row).not.toHaveTextContent('资料/策略/方案.md');
  await user.click(row);
  expect(await screen.findByText('正文：资料/策略/方案.md')).toBeVisible();
  expect(f.read).toHaveBeenCalledWith('project-1', '资料/策略/方案.md', expect.any(AbortSignal));
  expect(screen.getByRole('button', { name: '打开文件：封面.png' })).toHaveTextContent('暂不支持预览 · 1 MB');
  expect(screen.queryByRole('button', { name: '刷新文件' })).not.toBeInTheDocument();
});

it('hides every dot-path by default and offers a reversible visibility toggle', async () => {
  const f = fixture([file('.DS_Store'), folder('.config'), file('.config/private.md'), folder('资料'), file('资料/.secret.md'), file('brief.md')]);
  const user = userEvent.setup();
  render(<ProjectFilesPanel api={f.api} projectId="project-1" />);
  await screen.findByRole('button', { name: '打开文件：brief.md' });
  expect(screen.queryByText('.DS_Store')).not.toBeInTheDocument();
  expect(screen.queryByText('.config')).not.toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: '显示隐藏文件' }));
  expect(screen.getByText('.DS_Store')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '展开文件夹：.config' }));
  await user.click(screen.getByRole('button', { name: '打开文件：.config/private.md' }));
  await screen.findByText('正文：.config/private.md');
  await user.click(screen.getByRole('checkbox', { name: '显示隐藏文件' }));
  expect(screen.queryByText('正文：.config/private.md')).not.toBeInTheDocument();
  expect(screen.queryByText('.config')).not.toBeInTheDocument();
  expect(f.files).toHaveBeenCalledTimes(2);
});

it('shows search matches flat with their directories and discloses the 200-item limit without tab counts', async () => {
  const f = fixture();
  f.files.mockImplementation(async (_id, query) => ok({ items: query.origin === 'output' ? [] : [file('资料/策略/方案.md')], total: query.origin === 'output' ? 0 : 450, revision: 1 }));
  const user = userEvent.setup();
  render(<ProjectFilesPanel api={f.api} projectId="project-1" />);
  expect(await screen.findByText(/仅显示前 200 项/u)).toHaveTextContent('搜索');
  expect(screen.getByRole('tab', { name: '项目资料' })).toHaveTextContent(/^项目资料$/u);
  expect(screen.getByRole('tab', { name: '已保存产出' })).toHaveTextContent(/^已保存产出$/u);
  await user.type(screen.getByRole('textbox', { name: '搜索项目文件' }), '方案');
  const row = await screen.findByRole('button', { name: '打开文件：资料/策略/方案.md' });
  expect(within(row).getByText('资料/策略')).toBeVisible();
  expect(screen.queryByRole('button', { name: '展开文件夹：资料' })).not.toBeInTheDocument();
  expect(f.files).toHaveBeenCalledWith('project-1', { origin: 'source', search: '方案', limit: 200 }, expect.any(AbortSignal));
});

it('clears the old preview on tab changes and discards delayed reads after switching away', async () => {
  const f = fixture();
  const user = userEvent.setup();
  const late = deferred<ApiClientResult<ProjectFileDetail>>();
  render(<ProjectFilesPanel api={f.api} projectId="project-1" />);
  await user.click(await screen.findByRole('button', { name: '打开文件：brief.md' }));
  await screen.findByText('正文：brief.md');
  await user.click(screen.getByRole('tab', { name: '已保存产出' }));
  expect(screen.queryByText('正文：brief.md')).not.toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: '项目资料' }));
  f.read.mockReturnValueOnce(late.promise);
  await user.click(screen.getByRole('button', { name: '打开文件：brief.md' }));
  const signal = f.read.mock.calls.at(-1)![2]!;
  await user.click(screen.getByRole('tab', { name: '已保存产出' }));
  expect(signal.aborted).toBe(true);
  await act(async () => late.resolve(ok({ ...file('brief.md'), content: '不应出现的旧正文' })));
  expect(screen.queryByText('不应出现的旧正文')).not.toBeInTheDocument();
});

it('clears and cancels a preview as soon as search changes and when the project revision refreshes', async () => {
  const f = fixture();
  const user = userEvent.setup();
  const rendered = render(<ProjectFilesPanel api={f.api} projectId="project-1" revision={1} />);
  await user.click(await screen.findByRole('button', { name: '打开文件：brief.md' }));
  await screen.findByText('正文：brief.md');
  await user.type(screen.getByRole('textbox', { name: '搜索项目文件' }), 'brief');
  expect(screen.queryByText('正文：brief.md')).not.toBeInTheDocument();
  const row = await screen.findByRole('button', { name: '打开文件：brief.md' });
  const late = deferred<ApiClientResult<ProjectFileDetail>>();
  f.read.mockReturnValueOnce(late.promise);
  await user.click(row);
  const signal = f.read.mock.calls.at(-1)![2]!;
  rendered.rerender(<ProjectFilesPanel api={f.api} projectId="project-1" revision={2} />);
  expect(signal.aborted).toBe(true);
  await act(async () => late.resolve(ok({ ...file('brief.md'), content: '已过期的正文' })));
  expect(screen.queryByText('已过期的正文')).not.toBeInTheDocument();
});

it.each(['source', 'output'] as const)('reports a %s failure independently and retries only that collection', async failedOrigin => {
  const f = fixture();
  f.files.mockImplementation(async (_id, query) => query.origin === failedOrigin
    ? { ok: false, state: { status: 'operation-error', message: '暂时断开' } }
    : ok({ items: [file(query.origin === 'source' ? 'brief.md' : 'AI工作区/草稿.md')], total: 1, revision: 1 }));
  const user = userEvent.setup();
  render(<ProjectFilesPanel api={f.api} projectId="project-1" />);
  const label = failedOrigin === 'source' ? '项目资料' : '已保存产出';
  if (failedOrigin === 'output') await user.click(screen.getByRole('tab', { name: label }));
  expect(await screen.findByRole('alert')).toHaveTextContent(`${label}读取失败`);
  expect(screen.getByRole('alert')).toHaveTextContent('暂时断开');
  expect(screen.queryByText(/还没有已保存的产出/u)).not.toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: failedOrigin === 'source' ? '已保存产出' : '项目资料' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: failedOrigin === 'source' ? '展开文件夹：AI工作区' : '打开文件：brief.md' })).toBeVisible();
  await user.click(screen.getByRole('tab', { name: label }));
  const before = f.files.mock.calls.length;
  f.files.mockResolvedValueOnce(ok({ items: [file('recovered.md')], total: 1, revision: 1 }));
  await user.click(screen.getByRole('button', { name: `重新读取${label}` }));
  expect(await screen.findByRole('button', { name: '打开文件：recovered.md' })).toBeVisible();
  expect(f.files.mock.calls).toHaveLength(before + 1);
  expect(f.files.mock.calls.at(-1)![1].origin).toBe(failedOrigin);
});

it('explains saved output location and opens the assistant without sending from the empty state', async () => {
  const f = fixture([], [folder('AI工作区')]);
  const onAsk = vi.fn();
  const user = userEvent.setup();
  render(<ProjectFilesPanel api={f.api} projectId="project-1" onAsk={onAsk} />);
  await user.click(screen.getByRole('tab', { name: '已保存产出' }));
  expect(await screen.findByText('还没有已保存的产出')).toBeVisible();
  expect(screen.getByText(/问问中确认保存/u)).toHaveTextContent('AI工作区');
  await user.click(screen.getByRole('button', { name: '打开项目问问' }));
  expect(onAsk).toHaveBeenCalledOnce();
  expect(f.read).not.toHaveBeenCalled();
});

it('ignores an old collection response after a new search finishes', async () => {
  const f = fixture();
  const late = deferred<ApiClientResult<ProjectFilePage>>();
  f.files.mockImplementation(async (_id, query) => query.origin === 'output' ? ok({ items: [], total: 0, revision: 1 })
    : query.search === '旧' ? late.promise : ok({ items: [file(query.search === '新' ? '新.md' : 'brief.md')], total: 1, revision: 1 }));
  const user = userEvent.setup();
  render(<ProjectFilesPanel api={f.api} projectId="project-1" />);
  await screen.findByRole('button', { name: '打开文件：brief.md' });
  const search = screen.getByRole('textbox', { name: '搜索项目文件' });
  await user.type(search, '旧');
  await waitFor(() => expect(f.files).toHaveBeenCalledWith('project-1', { origin: 'source', search: '旧', limit: 200 }, expect.any(AbortSignal)));
  const oldSignal = f.files.mock.calls.find(([, query]) => query.origin === 'source' && query.search === '旧')![2]!;
  await user.clear(search); await user.type(search, '新');
  await screen.findByRole('button', { name: '打开文件：新.md' });
  expect(oldSignal.aborted).toBe(true);
  await act(async () => late.resolve(ok({ items: [file('旧.md')], total: 1, revision: 1 })));
  expect(screen.queryByRole('button', { name: '打开文件：旧.md' })).not.toBeInTheDocument();
});
