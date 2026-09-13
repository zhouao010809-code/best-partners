import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueCabinet, type CabinetDrawerState } from '../../src/client/pages/queue/QueueCabinet.js';
import type { ExtractionQueueItem, ExtractionRunSummary } from '../../src/shared/api/extraction-queue.js';

const material = (index: number, overrides: Partial<ExtractionQueueItem> = {}): ExtractionQueueItem => ({
  materialPath: `01图书馆/来自个人/资料-${index}.md`, title: `完整的资料标题 ${index}`, view: 'pending',
  sourcePlatform: '个人', collectedAt: '2026-09-07', canExtract: true, ...overrides
});
const run: ExtractionRunSummary = { id: 'e52917bc-a9df-482f-aae8-8c4b6da4301d', status: 'ready',
  createdAt: '2026-09-07T00:00:00Z', sourceRawSha256: 'a'.repeat(64), candidateCount: 5 };
const drawer = (overrides: Partial<CabinetDrawerState> = {}): CabinetDrawerState => ({
  id: 'pending', label: '待提炼', count: 0, items: [], ...overrides
});
const callbacks = () => ({ onSelect: vi.fn(), onToggleAll: vi.fn(), onLoadMore: vi.fn(), onRetry: vi.fn() });

afterEach(cleanup);

describe('QueueCabinet', () => {
  it('starts all three drawers closed with file controls inaccessible', () => {
    render(<QueueCabinet drawers={[
      drawer({ count: 1, items: [material(1)] }),
      drawer({ id: 'generating', label: '提炼中', count: 1, items: [material(2, { view: 'generating' })] }),
      drawer({ id: 'ready', label: '待确认', count: 1, items: [material(3, { view: 'ready' })] })
    ]} selectedPath="" {...callbacks()} />);
    for (const label of ['待提炼', '提炼中', '待确认']) {
      const region = screen.getByRole('region', { name: label });
      expect(within(region).getByRole('heading', { name: `${label} 1` })).toBeVisible();
      const handle = within(region).getByRole('button', { name: `展开${label}抽屉` });
      expect(handle).toHaveAttribute('aria-expanded', 'false');
      const cavity = document.getElementById(handle.getAttribute('aria-controls')!);
      expect(cavity).toHaveAttribute('aria-hidden', 'true');
      expect(cavity).toHaveAttribute('inert');
      expect(within(region).queryByRole('button', { name: /^打开 /u })).not.toBeInTheDocument();
    }
  });

  it('shows the first three materials in input order and delegates viewing all', async () => {
    const events = callbacks(); const items = [material(4), material(2), material(7), material(1)];
    render(<QueueCabinet drawers={[drawer({ count: '12', items })]} selectedPath="" {...events} />);
    await userEvent.setup().click(screen.getByRole('button', { name: '展开待提炼抽屉' }));
    const region = screen.getByRole('region', { name: '待提炼' });
    expect(within(region).getByRole('heading', { name: '待提炼 12' })).toBeVisible();
    expect(within(region).getAllByRole('button', { name: /^打开 /u }).map(button => button.getAttribute('aria-label')))
      .toEqual(items.slice(0, 3).map(item => `打开 ${item.title}`));
    expect(screen.queryByRole('button', { name: `打开 ${items[3]!.title}` })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: '查看全部待提炼' }));
    expect(events.onToggleAll).toHaveBeenCalledExactlyOnceWith('pending', true);
    expect(events.onSelect).not.toHaveBeenCalled();
  });

  it('uses expanded props for all loaded materials and delegates pagination and collapse', async () => {
    const events = callbacks(); const user = userEvent.setup(); const items = Array.from({ length: 5 }, (_, i) => material(i));
    const state = drawer({ count: 9, items, expanded: true, hasMore: true });
    const view = render(<QueueCabinet drawers={[state]} selectedPath="" {...events} />);
    await user.click(screen.getByRole('button', { name: '展开待提炼抽屉' }));
    expect(screen.getAllByRole('button', { name: /^打开 /u })).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: '加载更多资料' }));
    expect(events.onLoadMore).toHaveBeenCalledExactlyOnceWith('pending');
    await user.click(screen.getByRole('button', { name: '收起待提炼更多资料' }));
    expect(events.onToggleAll).toHaveBeenCalledExactlyOnceWith('pending', false);
    view.rerender(<QueueCabinet drawers={[{ ...state, moreBusy: true }]} selectedPath="" {...events} />);
    expect(screen.getByRole('button', { name: '正在加载更多资料…' })).toBeDisabled();
  });

  it('offers viewing all for a partial page while leaving small drawers uncluttered', async () => {
    render(<QueueCabinet drawers={[
      drawer({ count: '—', items: [material(1)], hasMore: true }),
      drawer({ id: 'ready', label: '待确认', count: 1, items: [material(2, { view: 'ready' })] })
    ]} selectedPath="" {...callbacks()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '展开待提炼抽屉' }));
    await user.click(screen.getByRole('button', { name: '展开待确认抽屉' }));
    expect(screen.getByRole('button', { name: '查看全部待提炼' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '查看全部待确认' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '加载更多资料' })).not.toBeInTheDocument();
  });

  it('opens and closes drawers independently while retaining counts and selection callbacks', async () => {
    const events = callbacks(); const user = userEvent.setup();
    render(<QueueCabinet drawers={[
      drawer({ count: 1, items: [material(1)] }),
      drawer({ id: 'generating', label: '提炼中', count: 1, items: [material(2, { view: 'generating' })] }),
      drawer({ id: 'ready', label: '待确认', count: 1, items: [material(3, { view: 'ready' })] })
    ]} selectedPath="" {...events} />);
    await user.click(screen.getByRole('button', { name: '展开待提炼抽屉' }));
    const handle = screen.getByRole('button', { name: '收起待提炼抽屉' });
    expect(handle.tagName).toBe('BUTTON'); expect(handle).toHaveAttribute('aria-expanded', 'true');
    const cavity = document.getElementById(handle.getAttribute('aria-controls')!);
    expect(cavity).not.toHaveAttribute('aria-hidden', 'true'); expect(cavity).not.toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: '展开提炼中抽屉' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: '展开待确认抽屉' })).toHaveAttribute('aria-expanded', 'false');
    await user.click(screen.getByRole('button', { name: `打开 ${material(1).title}` }));
    expect(events.onSelect).toHaveBeenCalledExactlyOnceWith(material(1));
    await user.click(screen.getByRole('button', { name: '展开提炼中抽屉' }));
    await user.click(handle);
    expect(screen.getByRole('button', { name: '展开待提炼抽屉' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('heading', { name: '待提炼 1' })).toBeVisible();
    expect(screen.queryByRole('button', { name: `打开 ${material(1).title}` })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: `打开 ${material(2).title}` })).toBeVisible();
    expect(screen.getByRole('button', { name: '展开待确认抽屉' })).toHaveAttribute('aria-expanded', 'false');
    await user.click(screen.getByRole('button', { name: '展开待提炼抽屉' }));
    expect(screen.getByRole('button', { name: `打开 ${material(1).title}` })).toBeVisible();
    expect(events.onToggleAll).not.toHaveBeenCalled();
    expect(events.onLoadMore).not.toHaveBeenCalled(); expect(events.onRetry).not.toHaveBeenCalled();
  });

  it('starts closed again after leaving and reentering the cabinet', async () => {
    const drawers = [drawer({ count: 1, items: [material(1)] }),
      drawer({ id: 'generating', label: '提炼中', count: 0 }), drawer({ id: 'ready', label: '待确认', count: 0 })];
    const events = callbacks(); const user = userEvent.setup();
    const view = render(<QueueCabinet drawers={drawers} selectedPath="" {...events} />);
    await user.click(screen.getByRole('button', { name: '展开待提炼抽屉' }));
    expect(screen.getByRole('button', { name: `打开 ${material(1).title}` })).toBeVisible();
    view.unmount();
    render(<QueueCabinet drawers={drawers} selectedPath={material(1).materialPath} {...events} />);
    for (const label of ['待提炼', '提炼中', '待确认'])
      expect(screen.getByRole('button', { name: `展开${label}抽屉` })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /^打开 /u })).not.toBeInTheDocument();
  });

  it('shows each loading, empty and recoverable error state independently', async () => {
    const events = callbacks();
    render(<QueueCabinet drawers={[
      drawer(), drawer({ id: 'generating', label: '提炼中', count: '—', loading: true }),
      drawer({ id: 'ready', label: '待确认', count: '—', error: '队列暂时无法读取，请重试。' })
    ]} selectedPath="" {...events} />);
    const user = userEvent.setup();
    for (const label of ['待提炼', '提炼中', '待确认'])
      await user.click(screen.getByRole('button', { name: `展开${label}抽屉` }));
    expect(within(screen.getByRole('region', { name: '待提炼' })).getByText('当前没有待提炼资料')).toBeVisible();
    expect(within(screen.getByRole('region', { name: '提炼中' })).getByRole('status')).toHaveTextContent('正在读取资料…');
    const ready = screen.getByRole('region', { name: '待确认' });
    expect(within(ready).getByRole('alert')).toHaveTextContent('队列暂时无法读取，请重试。');
    expect(within(ready).queryByText('还没有待确认的候选')).not.toBeInTheDocument();
    await userEvent.setup().click(within(ready).getByRole('button', { name: '重试待确认' }));
    expect(events.onRetry).toHaveBeenCalledExactlyOnceWith('ready');
  });

  it('keeps loaded items available during refresh errors and exposes a stale refresh action', async () => {
    const events = callbacks();
    render(<QueueCabinet drawers={[drawer({ count: 1, items: [material(1)], error: '状态更新失败', stale: true })]}
      selectedPath="" {...events} />);
    await userEvent.setup().click(screen.getByRole('button', { name: '展开待提炼抽屉' }));
    expect(screen.getByRole('button', { name: `打开 ${material(1).title}` })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('资料状态已更新');
    await userEvent.setup().click(screen.getByRole('button', { name: '刷新待提炼' }));
    expect(events.onRetry).toHaveBeenCalledExactlyOnceWith('pending');
  });

  it('selects the original item and shows real metadata or explicit missing values', async () => {
    const events = callbacks(); const first = material(1); const second = material(2, { sourcePlatform: undefined, collectedAt: undefined });
    const view = render(<QueueCabinet drawers={[drawer({ count: 2, items: [first, second] })]} selectedPath={first.materialPath} {...events} />);
    await userEvent.setup().click(screen.getByRole('button', { name: '展开待提炼抽屉' }));
    const selected = screen.getByRole('button', { name: `打开 ${first.title}` });
    expect(selected).toHaveAttribute('aria-pressed', 'true'); expect(selected).toHaveTextContent(first.title);
    expect(selected).toHaveTextContent('来源：个人'); expect(selected).toHaveTextContent('采集：2026-09-07');
    const next = screen.getByRole('button', { name: `打开 ${second.title}` });
    expect(next).toHaveAttribute('aria-pressed', 'false');
    expect(next).toHaveTextContent('来源：未记录'); expect(next).toHaveTextContent('采集：未记录');
    await userEvent.setup().click(next); expect(events.onSelect).toHaveBeenCalledExactlyOnceWith(second);
    view.rerender(<QueueCabinet drawers={[drawer({ count: 2, items: [first, second] })]} selectedPath={second.materialPath} {...events} />);
    expect(next).toHaveAttribute('aria-pressed', 'true'); expect(selected).toHaveAttribute('aria-pressed', 'false');
  });

  it('distinguishes active, pending review, complete, stopped and failed records without invented metadata', async () => {
    const error = '<script>opaque provider error</script>连接中断';
    const items = [
      material(1, { view: 'ready', pendingCandidateCount: 2, latestRun: run }),
      material(2, { view: 'ready', reviewComplete: true, latestRun: run }),
      material(3, { view: 'ready', latestReadyRun: run }),
      material(4, { view: 'unfinished', latestRun: { ...run, status: 'cancelled', candidateCount: undefined } }),
      material(5, { view: 'unfinished', latestRun: { ...run, status: 'failed', candidateCount: undefined, problem: error } }),
      material(6, { view: 'generating' }), material(7, { view: 'ready' })
    ];
    const { container } = render(<QueueCabinet drawers={[drawer({ count: items.length, items, expanded: true })]} selectedPath="" {...callbacks()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: '展开待提炼抽屉' }));
    const content = (index: number) => screen.getByRole('button', { name: `打开 ${material(index).title}` });
    expect(content(1)).toHaveTextContent('待处理 · 2 条候选'); expect(content(2)).toHaveTextContent('已处理');
    expect(content(3)).toHaveTextContent('待处理 · 5 条候选'); expect(content(4)).toHaveTextContent('已停止');
    expect(content(5)).toHaveTextContent(error); expect(container.querySelector('script')).toBeNull();
    expect(content(6)).toHaveTextContent('正在提炼'); expect(content(7)).toHaveTextContent('候选数量未记录');
  });
});
