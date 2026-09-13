import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueuePage } from '../../src/client/pages/QueuePage.js';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const path = '01图书馆/来自个人/2026-09/测试/测试.md';
const item = { materialPath: path, title: '一份足够完整的资料标题', view: 'pending', canExtract: true, sourceRawSha256: 'a'.repeat(64), sourcePlatform: '其他', collectedAt: '2026-09-06' };
const summary = { id: 'e52917bc-a9df-482f-aae8-8c4b6da4301d', status: 'ready', createdAt: '2026-09-06T00:00:00Z', sourceRawSha256: 'a'.repeat(64), candidateCount: 0 };
const run = { ...summary, materialPath: path, title: item.title, model: 'deepseek-v4-flash', readingState: '未看', ruleFingerprint: 'b'.repeat(64), result: { briefing: { sentences: ['已经保存的导读。', '第二句话。', '第三句话。'], keyPoints: ['知识点'], usefulness: '帮助理解' }, candidates: [] } };
const counts = { pending: 1, generating: 0, ready: 0, unfinished: 0 };
const extractionQueue = { list: vi.fn(), history: vi.fn(), get: vi.fn(), setVisibility: vi.fn() };
let dataRevision = 0;
let healthIndex = 'ready';
let ingestionEnabled = false;
const extraction = { list: vi.fn(), get: vi.fn(), preview: vi.fn(), start: vi.fn(), cancel: vi.fn() };
const getDocumentDetail = vi.fn();
const deepSeek = { get: vi.fn() };
vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => ({ api: { extractionQueue, extraction, getDocumentDetail, deepSeek, ...(ingestionEnabled ? { ingestion: {} } : {}) }, health: { status: 'ready', data: { index: { status: healthIndex } } }, dataRevision }) }));
vi.mock('../../src/client/pages/queue/CandidateReview.js', () => ({ CandidateReview: ({ onChanged, onReviewBusy }: { onChanged?: () => void; onReviewBusy?: (busy: boolean, durableDraft?: boolean) => void }) => <><button type="button" onClick={onChanged}>模拟审阅更新</button><button type="button" onClick={() => onReviewBusy?.(true, true)}>模拟未同步草稿</button></> }));
function Location() { const loc = useLocation(); return <output data-testid="location">{loc.pathname}{loc.search}</output>; }
function open(query = '') { return render(<MemoryRouter initialEntries={[`/queue${query}`]}><QueuePage /><Location /></MemoryRouter>); }
it('offers continued extraction from a completed partial result when the server returns it to pending', async () => {
  const partial = { ...item, pendingCandidateCount: 0, reviewComplete: false, latestRun: { ...summary, reviewComplete: true, pendingCandidateCount: 0 }, latestReadyRun: { ...summary, reviewComplete: true, pendingCandidateCount: 0 } };
  extractionQueue.get.mockResolvedValue(ok({ item: partial }));
  extractionQueue.list.mockImplementation(async query => ok({ items: query.view === 'pending' ? [partial] : [], counts }));
  extraction.get.mockResolvedValue(ok({ ...run, sourceRange: { offset: 10, length: 50, label: '原件第 1 页', coversWholeSource: false } }));
  const user = userEvent.setup(); open(`?view=pending&materialPath=${encodeURIComponent(path)}&run=${summary.id}&pane=result`);
  await user.click(await screen.findByRole('button', { name: '继续提炼' }));
  expect(await screen.findByRole('button', { name: '预览发送内容' })).toBeVisible(); expect(extraction.start).not.toHaveBeenCalled();
});
async function openDrawer(user: ReturnType<typeof userEvent.setup>, label: '待提炼' | '提炼中' | '待确认') {
  await user.click(await screen.findByRole('button', { name: `展开${label}抽屉` }));
}
it('opens saved candidates in wide reading and keeps the cabinet as collapsible navigation', async () => {
  const ready = { ...item, view: 'ready', latestRun: summary, latestReadyRun: summary };
  extractionQueue.list.mockImplementation(async (query) => ok({ items: query.view === 'ready' ? [ready] : [], counts: { pending: 0, generating: 0, ready: 1, unfinished: 0 } }));
  extractionQueue.get.mockResolvedValue(ok({ item: ready }));
  const user = userEvent.setup(); open(`?view=ready&materialPath=${encodeURIComponent(path)}&run=${summary.id}`);
  await screen.findByText('已经保存的导读。');
  expect(screen.getByRole('region', { name: '提炼工作台' })).toHaveClass('queue-workspace--reading');
  const navigation = screen.getByRole('button', { name: '资料导航' });
  expect(navigation).toHaveAttribute('aria-expanded', 'false');
  await user.click(navigation);
  expect(screen.getByRole('region', { name: '资料列表' })).toBeVisible();
  await user.click(navigation);
  expect(screen.queryByRole('region', { name: '资料列表' })).not.toBeInTheDocument();
  expect(extraction.start).not.toHaveBeenCalled();
});
it('opens source evidence without unmounting the current review', async () => {
  ingestionEnabled = true;
  const ready = { ...item, view: 'ready', latestRun: summary };
  extractionQueue.get.mockResolvedValue(ok({ item: ready }));
  extractionQueue.list.mockResolvedValue(ok({ items: [ready], counts: { ...counts, ready: 1 } }));
  const user = userEvent.setup(); open(`?view=ready&materialPath=${encodeURIComponent(path)}&run=${summary.id}`);
  const reviewControl = await screen.findByRole('button', { name: '模拟未同步草稿' });
  await user.click(reviewControl);
  await user.click(screen.getByRole('button', { name: '查看依据' }));
  expect(await screen.findByRole('region', { name: '原文依据' })).toBeVisible();
  expect(screen.getByRole('button', { name: '模拟未同步草稿' })).toBe(reviewControl);
  await user.click(screen.getByRole('button', { name: '收起依据' }));
  expect(screen.queryByRole('region', { name: '原文依据' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '模拟未同步草稿' })).toBe(reviewControl);
  expect(extraction.start).not.toHaveBeenCalled();
});
beforeEach(() => {
  dataRevision = 0;
  healthIndex = 'ready';
  ingestionEnabled = false;
  extractionQueue.get.mockResolvedValue(ok({ item }));
  extractionQueue.list.mockResolvedValue(ok({ items: [item], counts }));
  extractionQueue.history.mockResolvedValue(ok({ items: [] }));
  extraction.get.mockResolvedValue(ok(run)); extraction.list.mockResolvedValue(ok({ items: [] }));
  getDocumentDetail.mockResolvedValue(ok({ path, markdown: '# 原文\n\n可阅读的原文内容。', versionMarker: { rawSha256: item.sourceRawSha256 } }));
  deepSeek.get.mockResolvedValue(ok({ configured: true, available: true }));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('keeps all drawers closed on every workspace entry without reading an original', async () => {
  extractionQueue.list.mockImplementation(async (query) => ok({ items: query.view === 'pending' ? [item] : [], counts }));
  const user = userEvent.setup(); const view = open();
  await screen.findByRole('heading', { name: '待提炼 1' });
  for (const label of ['待提炼', '提炼中', '待确认'])
    expect(screen.getByRole('button', { name: `展开${label}抽屉` })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: /^打开 /u })).not.toBeInTheDocument();
  expect(getDocumentDetail).not.toHaveBeenCalled();
  await openDrawer(user, '待提炼');
  expect(screen.getByRole('button', { name: `打开 ${item.title}` })).toBeVisible();
  view.unmount(); open('?view=ready');
  await screen.findByRole('heading', { name: '待提炼 1' });
  for (const label of ['待提炼', '提炼中', '待确认'])
    expect(screen.getByRole('button', { name: `展开${label}抽屉` })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: /^打开 /u })).not.toBeInTheDocument();
  expect(getDocumentDetail).not.toHaveBeenCalled(); expect(extraction.start).not.toHaveBeenCalled();
});

it('only presents the reader after selecting a file and removes it on close', async () => {
  const user = userEvent.setup(); open();
  await screen.findByRole('heading', { name: '待提炼 1' });
  expect(screen.queryByRole('region', { name: '资料工作区' })).not.toBeInTheDocument();
  expect(screen.queryByText('挑一份资料，开始整理')).not.toBeInTheDocument();
  await openDrawer(user, '待提炼');
  expect(screen.queryByRole('region', { name: '资料工作区' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: `打开 ${item.title}` }));
  expect(await screen.findByText('可阅读的原文内容。')).toBeVisible();
  expect(screen.getByRole('region', { name: '资料工作区' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '关闭资料详情' }));
  expect(screen.queryByRole('region', { name: '资料工作区' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: `打开 ${item.title}` })).toBeVisible();
  expect(screen.getByTestId('location')).not.toHaveTextContent('materialPath');
  expect(extraction.start).not.toHaveBeenCalled();
});

it('shows a bounded first row and expands the drawer without starting extraction', async () => {
  const materials = Array.from({ length: 8 }, (_, i) => ({ ...item, materialPath: `01图书馆/资料-${i}.md`, title: `资料 ${i}` }));
  extractionQueue.list.mockImplementation(async (query) => ok({ items: query.view === 'pending' ? materials : [], counts: { ...counts, pending: 8 } }));
  const user = userEvent.setup(); open();
  await openDrawer(user, '待提炼');
  await screen.findByRole('button', { name: '打开 资料 0' });
  expect(screen.queryByRole('button', { name: '打开 资料 3' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '查看全部待提炼' }));
  expect(await screen.findByRole('button', { name: '打开 资料 7' })).toBeVisible();
  expect(extraction.start).not.toHaveBeenCalled();
});

it('reads all three drawers independently and retains failed or completed result entry points', async () => {
  const ready = { ...item, materialPath: '01图书馆/候选.md', title: '需要审阅的资料', view: 'ready', reviewComplete: false, pendingCandidateCount: 2, latestRun: summary };
  const running = { ...item, materialPath: '01图书馆/运行.md', title: '正在提炼的资料', view: 'generating' };
  extractionQueue.list.mockImplementation(async (query) => ok({ items: query.view === 'pending' ? [item] : query.view === 'ready' ? [ready] : query.view === 'generating' ? [running] : [], counts: { pending: 1, generating: 1, ready: 2, unfinished: 1 } }));
  const user = userEvent.setup(); open();
  await openDrawer(user, '待确认'); await openDrawer(user, '提炼中');
  expect(await within(screen.getByRole('region', { name: '待确认' })).findByRole('button', { name: `打开 ${ready.title}` })).toBeVisible();
  expect(await within(screen.getByRole('region', { name: '提炼中' })).findByRole('button', { name: `打开 ${running.title}` })).toBeVisible();
  expect(screen.getByRole('button', { name: /未完成任务/u })).toBeVisible();
  expect(screen.getByRole('button', { name: '已处理结果' })).toBeVisible();
  expect(extraction.preview).not.toHaveBeenCalled(); expect(extraction.start).not.toHaveBeenCalled();
});

it('expands reading in place then opens the next available material', async () => {
  const second = { ...item, title: '下一份资料', materialPath: '01图书馆/下一份资料.md' };
  extractionQueue.list.mockImplementation(async (query) => ok({ items: query.view === 'pending' ? [item, second] : [], counts: { ...counts, pending: 2 } }));
  getDocumentDetail.mockImplementation(async (value) => ok({ path: value, markdown: value === path ? '当前原文' : '下一份原文', versionMarker: { rawSha256: item.sourceRawSha256 } }));
  const user = userEvent.setup(); open();
  await openDrawer(user, '待提炼');
  await user.click(await screen.findByRole('button', { name: `打开 ${item.title}` }));
  const heading = await screen.findByRole('heading', { name: item.title });
  await user.click(screen.getByRole('button', { name: '展开阅读' }));
  expect(screen.getByRole('heading', { name: item.title })).toBe(heading);
  await user.click(screen.getByRole('button', { name: '收起阅读' }));
  expect(screen.getByRole('heading', { name: item.title })).toBe(heading);
  await user.click(screen.getByRole('button', { name: '下一份' }));
  expect(await screen.findByText('下一份原文')).toBeVisible();
  expect(extraction.start).not.toHaveBeenCalled();
});

it('removes a source reversibly, preserves original reading and offers undo without a confirmation dialog', async () => {
  const removed = { ...item, canExtract: false, removedAt: '2026-09-07T00:00:00Z' };
  extractionQueue.setVisibility.mockImplementation(async (_path, isRemoved) => {
    extractionQueue.get.mockResolvedValue(ok({ item: isRemoved ? removed : item }));
    extractionQueue.list.mockResolvedValue(ok({ items: isRemoved ? [] : [item], counts: { ...counts, pending: isRemoved ? 0 : 1 } }));
    return ok({ item: isRemoved ? removed : item });
  });
  const user = userEvent.setup(); open(`?materialPath=${encodeURIComponent(path)}`);
  await user.click(await screen.findByRole('button', { name: '移出队列' }));
  expect(await screen.findByText('已移出队列，原文和全部提炼记录已保留。')).toBeVisible();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '开始提炼' })).not.toBeInTheDocument();
  expect(screen.getByText('可阅读的原文内容。')).toBeVisible();
  expect(screen.getByRole('button', { name: '重新加入' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '撤销移出' }));
  expect(await screen.findByRole('button', { name: '开始提炼' })).toBeVisible();
  expect(extractionQueue.setVisibility.mock.calls).toEqual([[path, true], [path, false]]);
  expect(extraction.start).not.toHaveBeenCalled();
});

it('continues forward across drawers without looping back to the previous stage', async () => {
  const running = { ...item, materialPath: '01图书馆/正在处理.md', title: '正在处理', view: 'generating', canExtract: false };
  const ready = { ...item, materialPath: '01图书馆/待确认.md', title: '等待确认', view: 'ready', latestRun: summary };
  const materials = [item, running, ready];
  extractionQueue.list.mockImplementation(async (query) => ok({ items: materials.filter((value) => value.view === query.view), counts: { pending: 1, generating: 1, ready: 1, unfinished: 0 } }));
  const user = userEvent.setup(); open();
  await openDrawer(user, '待提炼'); await openDrawer(user, '待确认');
  await screen.findByRole('button', { name: '打开 等待确认' });
  await user.click(screen.getByRole('button', { name: `打开 ${item.title}` }));
  await user.click(screen.getByRole('button', { name: '下一份' }));
  await screen.findByRole('heading', { name: running.title });
  await waitFor(() => expect(screen.getByRole('button', { name: '下一份' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: '下一份' }));
  await screen.findByRole('heading', { name: ready.title });
  await waitFor(() => expect(screen.getByRole('button', { name: '下一份' })).toBeDisabled());
  expect(extraction.start).not.toHaveBeenCalled();
});

it('asks to retain a durable local draft before opening the next material', async () => {
  ingestionEnabled = true;
  const ready = { ...item, view: 'ready', latestRun: summary };
  const next = { ...ready, materialPath: '01图书馆/下一份.md', title: '另一份候选资料' };
  extractionQueue.list.mockImplementation(async (query) => ok({ items: query.view === 'ready' ? [ready, next] : [], counts: { pending: 0, generating: 0, ready: 2, unfinished: 0 } }));
  const user = userEvent.setup(); open('?view=ready');
  await openDrawer(user, '待确认');
  await user.click(await screen.findByRole('button', { name: `打开 ${item.title}` }));
  await user.click(await screen.findByRole('button', { name: '模拟未同步草稿' }));
  await user.click(screen.getByRole('button', { name: '下一份' }));
  expect(screen.getByRole('heading', { name: item.title })).toBeVisible();
  expect(screen.getByRole('group', { name: '保留草稿后切换' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '保留草稿并切换' }));
  expect(await screen.findByRole('heading', { name: next.title })).toBeVisible();
  expect(extraction.start).not.toHaveBeenCalled();
});

it('does not jump backwards while the selected drawer is still loading', async () => {
  const running = { ...item, materialPath: '01图书馆/运行.md', title: '正在处理', view: 'generating' };
  let resolve!: (value: unknown) => void;
  extractionQueue.list.mockImplementation((query) => query.view === 'generating' && query.limit === 40
    ? new Promise((accept) => { resolve = accept; })
    : Promise.resolve(ok({ items: query.view === 'pending' ? [item] : query.view === 'generating' ? [running] : [], counts: { ...counts, generating: 1 } })));
  const user = userEvent.setup(); open();
  await openDrawer(user, '提炼中');
  await user.click(await screen.findByRole('button', { name: '打开 正在处理' }));
  await screen.findByRole('heading', { name: running.title });
  expect(screen.getByRole('button', { name: '下一份' })).toBeDisabled();
  await act(async () => resolve(ok({ items: [running], counts: { ...counts, generating: 1 } })));
  expect(screen.getByRole('button', { name: '下一份' })).toBeDisabled();
});

it('opens removed sources through an independent visibility filter and selects their available stage', async () => {
  extractionQueue.get.mockResolvedValue(ok({ item: { ...item, view: 'ready', canExtract: false, removedAt: '2026-09-07T00:00:00Z', latestRun: summary } }));
  extractionQueue.list.mockImplementation(async (query) => ok(query.visibility === 'removed'
    ? { items: query.view === 'ready' ? [{ ...item, view: 'ready', canExtract: false, removedAt: '2026-09-07T00:00:00Z', latestRun: summary }] : [], counts: { pending: 0, ready: 1, generating: 0, unfinished: 0 } }
    : { items: [item], counts }));
  const user = userEvent.setup(); open();
  await user.click(await screen.findByRole('button', { name: '已移出' }));
  await openDrawer(user, '待确认');
  await waitFor(() => expect(within(screen.getByRole('region', { name: '待确认' })).getByRole('button', { name: `打开 ${item.title}` })).toBeVisible());
  await user.click(await screen.findByRole('button', { name: `打开 ${item.title}` }));
  expect(await screen.findByRole('button', { name: '重新加入' })).toBeVisible();
  expect(screen.getByTestId('location')).toHaveTextContent('visibility=removed');
});

it('keeps a pressed preview mounted while automatic stage selection loads its main list', async () => {
  const removed = { ...item, view: 'ready', canExtract: false, removedAt: '2026-09-07T00:00:00Z', latestRun: summary };
  const removedCounts = { pending: 0, ready: 1, generating: 0, unfinished: 0 };
  let resolveScope!: (value: unknown) => void;
  let resolveReady!: (value: unknown) => void;
  extractionQueue.get.mockResolvedValue(ok({ item: removed }));
  extractionQueue.list.mockImplementation((query) => {
    if (query.visibility !== 'removed') return Promise.resolve(ok({ items: query.view === 'pending' ? [item] : [], counts }));
    if (query.limit === 40) return new Promise(resolve => { if (query.view === 'pending') resolveScope = resolve; else if (query.view === 'ready') resolveReady = resolve; });
    return Promise.resolve(ok({ items: query.view === 'ready' ? [removed] : [], counts: removedCounts }));
  });
  const user = userEvent.setup(); open();
  await user.click(await screen.findByRole('button', { name: '已移出' }));
  await openDrawer(user, '待确认');
  const paper = await within(screen.getByRole('region', { name: '待确认' })).findByRole('button', { name: `打开 ${item.title}` });
  await user.pointer({ target: paper, keys: '[MouseLeft>]' });
  await act(async () => resolveScope(ok({ items: [], counts: removedCounts })));
  await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('view=ready'));
  expect(paper.isConnected).toBe(true);
  expect(within(screen.getByRole('region', { name: '待确认' })).getByRole('button', { name: `打开 ${item.title}` })).toBe(paper);
  expect(within(screen.getByRole('region', { name: '待确认' })).queryByText('正在读取资料…')).toBeNull();
  await user.pointer({ target: paper, keys: '[/MouseLeft]' });
  expect(await screen.findByRole('button', { name: '重新加入' })).toBeVisible();
  await act(async () => resolveReady(ok({ items: [removed], counts: removedCounts })));
  await user.click(screen.getByRole('button', { name: '资料导航' }));
  expect(within(screen.getByRole('region', { name: '待确认' })).getByRole('button', { name: `打开 ${item.title}` })).toBe(paper);
  expect(screen.getByTestId('location')).toHaveTextContent(`materialPath=${encodeURIComponent(path)}`);
  expect(extraction.start).not.toHaveBeenCalled();
});

it('disables queue removal during generation and points to the existing stop control', async () => {
  const generating = { ...run, status: 'generating', result: undefined };
  const active = { ...item, view: 'generating', canExtract: false, activeRun: generating, latestRun: generating };
  extractionQueue.list.mockResolvedValue(ok({ items: [active], counts: { ...counts, generating: 1 } }));
  extraction.get.mockResolvedValue(ok(generating));
  const user = userEvent.setup(); open('?view=generating');
  await openDrawer(user, '提炼中');
  await user.click(await screen.findByRole('button', { name: `打开 ${item.title}` }));
  expect(await screen.findByRole('button', { name: '移出队列' })).toBeDisabled();
  expect(screen.getByText(/先停止本次提炼/u)).toBeVisible();
  expect(screen.getByRole('button', { name: '停止本次提炼' })).toBeVisible();
  expect(extractionQueue.setVisibility).not.toHaveBeenCalled();
});

it('keeps source actions intact when a queue visibility change fails', async () => {
  extractionQueue.setVisibility.mockResolvedValue({ ok: false, state: { status: 'conflict', message: '请先完成入库恢复。' } });
  const user = userEvent.setup(); open(`?materialPath=${encodeURIComponent(path)}`);
  await user.click(await screen.findByRole('button', { name: '移出队列' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('请先完成入库恢复。');
  expect(screen.getByRole('button', { name: '移出队列' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '开始提炼' })).toBeVisible();
});

it('selects a material for inline reading without previewing or sending it', async () => {
  const user = userEvent.setup(); open();
  await openDrawer(user, '待提炼');
  await user.click(await screen.findByRole('button', { name: `打开 ${item.title}` }));
  expect(await screen.findByText('可阅读的原文内容。')).toBeVisible();
  expect(screen.getByRole('button', { name: '开始提炼' })).toBeVisible();
  expect(extraction.preview).not.toHaveBeenCalled(); expect(extraction.start).not.toHaveBeenCalled();
  expect(screen.getByTestId('location').textContent).toContain('materialPath=');
});

it('opens a saved zero-candidate result directly and keeps it out of pending', async () => {
  extractionQueue.list.mockResolvedValue(ok({ items: [{ ...item, view: 'ready', latestRun: summary, latestReadyRun: summary }], counts: { ...counts, pending: 0, ready: 1 } }));
  const user = userEvent.setup(); open('?view=ready');
  await openDrawer(user, '待确认');
  await user.click(await screen.findByRole('button', { name: `打开 ${item.title}` }));
  expect(await screen.findByText('已经保存的导读。')).toBeVisible();
  expect(screen.getByText(/暂未识别出适合长期复用的知识/u)).toBeVisible();
  expect(extraction.preview).not.toHaveBeenCalled(); expect(extraction.start).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '开始提炼' })).not.toBeInTheDocument();
});

it('keeps an older successful result accessible after the latest attempt fails', async () => {
  const failed = { ...summary, id: 'failure', status: 'failed', problem: '网络中断' };
  extractionQueue.list.mockResolvedValue(ok({ items: [{ ...item, view: 'unfinished', latestRun: failed, latestReadyRun: summary }], counts: { ...counts, unfinished: 1 } }));
  extraction.get.mockImplementation(async (id) => ok(id === 'failure' ? { ...run, ...failed, result: undefined } : run));
  const user = userEvent.setup(); open('?view=unfinished');
  await user.click(await screen.findByRole('button', { name: `打开 ${item.title}` }));
  await user.click(await screen.findByRole('button', { name: /查看上次成功结果/u }));
  expect(await screen.findByText('已经保存的导读。')).toBeVisible();
  expect(extraction.start).not.toHaveBeenCalled();
});

it('restores selection and filters from the URL and searches without an apply button', async () => {
  const user = userEvent.setup(); open(`?view=pending&title=资料&materialPath=${encodeURIComponent(path)}`);
  expect(await screen.findByText('可阅读的原文内容。')).toBeVisible();
  const input = screen.getByRole('searchbox', { name: '搜索资料标题' });
  expect(input).toHaveValue('资料'); await user.clear(input); await user.type(input, '新的标题');
  await waitFor(() => expect(extractionQueue.list).toHaveBeenLastCalledWith(expect.objectContaining({ title: '新的标题' }), expect.any(AbortSignal)));
  expect(screen.queryByRole('button', { name: '应用筛选' })).not.toBeInTheDocument();
});

it('ignores a late original response after switching materials', async () => {
  let resolve!: (value: unknown) => void;
  const other = { ...item, materialPath: '01图书馆/另一个.md', title: '另一份资料' };
  extractionQueue.list.mockResolvedValue(ok({ items: [item, other], counts: { ...counts, pending: 2 } }));
  getDocumentDetail.mockImplementation((selected) => selected === path ? new Promise((accept) => { resolve = accept; }) : Promise.resolve(ok({ path: other.materialPath, markdown: '第二份原文', versionMarker: { rawSha256: item.sourceRawSha256 } })));
  const user = userEvent.setup(); open();
  await openDrawer(user, '待提炼');
  await user.click(await screen.findByRole('button', { name: `打开 ${item.title}` }));
  await user.click(screen.getByRole('button', { name: `打开 ${other.title}` }));
  expect(await screen.findByText('第二份原文')).toBeVisible();
  await act(async () => resolve(ok({ path, markdown: '过时的响应', versionMarker: { rawSha256: item.sourceRawSha256 } })));
  expect(screen.queryByText('过时的响应')).not.toBeInTheDocument();
});

it('reports a failed summary read instead of presenting an empty pending queue', async () => {
  extractionQueue.list.mockResolvedValue({ ok: false, state: { status: 'disconnected', message: '提炼状态暂不可用' } });
  const user = userEvent.setup(); open(); await openDrawer(user, '待提炼');
  expect(await within(screen.getByRole('region', { name: '待提炼' })).findByRole('alert')).toHaveTextContent('提炼状态暂不可用');
  expect(screen.queryByText('当前没有待提炼资料')).not.toBeInTheDocument();
});

it('restores a selected source outside the first filtered page with its real action state', async () => {
  extractionQueue.list.mockResolvedValue(ok({ items: [], counts }));
  open(`?materialPath=${encodeURIComponent(path)}`);
  expect(await screen.findByRole('button', { name: '开始提炼' })).toBeVisible();
  expect(extractionQueue.get).toHaveBeenCalledWith(path, expect.any(AbortSignal));
});

it('refreshes original content after its indexed version changes', async () => {
  const user = userEvent.setup(); const view = open();
  await openDrawer(user, '待提炼');
  await user.click(await screen.findByRole('button', { name: `打开 ${item.title}` }));
  await screen.findByText('可阅读的原文内容。');
  const updated = { ...item, sourceRawSha256: 'c'.repeat(64) };
  extractionQueue.list.mockResolvedValue(ok({ items: [updated], counts }));
  extractionQueue.get.mockResolvedValue(ok({ item: updated }));
  getDocumentDetail.mockResolvedValue(ok({ path, markdown: '更新后的当前原文', versionMarker: { rawSha256: updated.sourceRawSha256 } }));
  dataRevision++;
  view.rerender(<MemoryRouter><QueuePage /><Location /></MemoryRouter>);
  expect(await screen.findByText('更新后的当前原文')).toBeVisible();
  expect(screen.queryByText('可阅读的原文内容。')).not.toBeInTheDocument();
});

it('does not keep the pending start action after the selected source starts generating', async () => {
  const generating = { ...run, status: 'generating', result: undefined };
  extraction.preview.mockResolvedValue(ok({ token: summary.id, title: item.title, messages: [], providerHost: 'api.deepseek.com', model: run.model }));
  extraction.start.mockImplementation(async () => {
    extractionQueue.list.mockResolvedValue(ok({ items: [], counts: { ...counts, pending: 0, generating: 1 } }));
    extractionQueue.get.mockResolvedValue(ok({ item: { ...item, canExtract: false, view: 'generating', activeRun: generating, latestRun: generating } }));
    extraction.get.mockResolvedValue(ok(generating)); return ok(generating);
  });
  const user = userEvent.setup(); open();
  await openDrawer(user, '待提炼');
  await user.click(await screen.findByRole('button', { name: `打开 ${item.title}` }));
  await user.click(await screen.findByRole('button', { name: '开始提炼' }));
  await user.click(await screen.findByRole('button', { name: '预览发送内容' }));
  await user.click(await screen.findByRole('button', { name: '确认发送并提炼' }));
  await screen.findByRole('button', { name: '停止本次提炼' });
  await user.click(screen.getByRole('button', { name: '原文' }));
  expect(screen.queryByRole('button', { name: '开始提炼' })).not.toBeInTheDocument();
  expect(extraction.start).toHaveBeenCalledTimes(1);
});

it('keeps expanded pages in place when background summaries refresh', async () => {
  const older = { ...item, materialPath: '01图书馆/更早资料.md', title: '已展开的更早资料' };
  const activeCounts = { ...counts, pending: 2, generating: 1 };
  extractionQueue.list.mockImplementation(async (query) => ok(query.cursor ? { items: [older], counts: activeCounts } : { items: [item], counts: activeCounts, nextCursor: 'page-2' }));
  const user = userEvent.setup(); open();
  await openDrawer(user, '待提炼');
  await user.click(await screen.findByRole('button', { name: '查看全部待提炼' }));
  await user.click(await screen.findByRole('button', { name: '加载更多资料' }));
  expect(await screen.findByRole('button', { name: `打开 ${older.title}` })).toBeVisible();
  await waitFor(() => expect(extractionQueue.list.mock.calls.filter(([query]) => query.limit === 40)).toHaveLength(3), { timeout: 3000 });
  expect(screen.getByRole('button', { name: `打开 ${older.title}` })).toBeVisible();
});

it('keeps the second page when opening an already saved result', async () => {
  const first = { ...item, materialPath: '01图书馆/第一份.md', title: '第一份资料', view: 'ready', latestRun: summary };
  const second = { ...item, view: 'ready', latestRun: summary, latestReadyRun: summary };
  const readyCounts = { ...counts, pending: 0, ready: 2 };
  extractionQueue.list.mockImplementation(async (query) => ok(query.cursor ? { items: [second], counts: readyCounts } : { items: [first], counts: readyCounts, nextCursor: 'page-2' }));
  extractionQueue.get.mockResolvedValue(ok({ item: second }));
  const user = userEvent.setup(); open('?view=ready');
  await openDrawer(user, '待确认');
  await user.click(await screen.findByRole('button', { name: '加载更多资料' }));
  await user.click(await screen.findByRole('button', { name: `打开 ${item.title}` }));
  await screen.findByText('已经保存的导读。');
  await user.click(screen.getByRole('button', { name: '资料导航' }));
  expect(screen.getByRole('button', { name: `打开 ${item.title}` })).toHaveAttribute('aria-pressed', 'true');
  expect(extractionQueue.list.mock.calls.filter(([query]) => query.limit === 40)).toHaveLength(2);
});

it('restores retry preparation without treating a hidden old result read as a new start', async () => {
  extractionQueue.list.mockResolvedValue(ok({ items: [{ ...item, view: 'ready', latestRun: summary, latestReadyRun: summary }], counts: { ...counts, pending: 0, ready: 1 } }));
  open(`?view=ready&materialPath=${encodeURIComponent(path)}&run=${summary.id}&pane=prepare`);
  await screen.findByText('已经保存的导读。');
  expect(await screen.findByRole('button', { name: '预览发送内容' })).toBeVisible();
  expect(screen.getByTestId('location')).toHaveTextContent('pane=prepare');
  expect(extraction.preview).not.toHaveBeenCalled(); expect(extraction.start).not.toHaveBeenCalled();
});

it('automatically reads the queue when the initial index becomes ready', async () => {
  healthIndex = 'building';
  extractionQueue.list.mockImplementation(async (query) => healthIndex === 'building'
    ? { ok: false, state: { status: 'busy', message: '索引准备中' } }
    : ok({ items: query.view === 'pending' ? [item] : [], counts }));
  const user = userEvent.setup(); const view = open(); await openDrawer(user, '待提炼'); await screen.findByRole('alert');
  healthIndex = 'ready';
  view.rerender(<MemoryRouter><QueuePage /><Location /></MemoryRouter>);
  expect(await screen.findByRole('button', { name: `打开 ${item.title}` })).toBeVisible();
});

it('filters ready sources by unresolved versus completed review state', async () => {
  extractionQueue.list.mockResolvedValue(ok({ items: [{ ...item, view: 'ready', reviewComplete: false, pendingCandidateCount: 2, latestRun: summary }], counts: { ...counts, pending: 0, ready: 1 } }));
  const user = userEvent.setup(); open('?view=ready');
  await openDrawer(user, '待确认');
  expect(await screen.findByText('待处理 · 2 条候选')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '已处理结果' }));
  await waitFor(() => expect(extractionQueue.list).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'ready', reviewState: 'complete' }), expect.any(AbortSignal)));
});

it('refreshes the selected source after review changes without losing the selected run', async () => {
  ingestionEnabled = true;
  const ready = { ...item, view: 'ready', latestRun: summary, latestReadyRun: summary, pendingCandidateCount: 2, reviewComplete: false };
  extractionQueue.list.mockResolvedValue(ok({ items: [ready], counts: { ...counts, pending: 0, ready: 1 } }));
  const user = userEvent.setup(); open(`?view=ready&materialPath=${encodeURIComponent(path)}&run=${summary.id}&pane=result`);
  await openDrawer(user, '待确认');
  await screen.findByRole('button', { name: '模拟审阅更新' });
  const updated = { ...ready, sourceRawSha256: 'c'.repeat(64), pendingCandidateCount: 1, canExtract: false,
    latestRun: { ...summary, currentSourceSha256: 'c'.repeat(64) }, latestReadyRun: { ...summary, currentSourceSha256: 'c'.repeat(64) } };
  extractionQueue.list.mockResolvedValue(ok({ items: [updated], counts: { ...counts, pending: 0, ready: 1 } }));
  getDocumentDetail.mockResolvedValue(ok({ path, markdown: '入库回写后的原文', versionMarker: { rawSha256: updated.sourceRawSha256 } }));
  await user.click(screen.getByRole('button', { name: '模拟审阅更新' }));
  await user.click(screen.getByRole('button', { name: '资料导航' }));
  expect(await screen.findByText('待处理 · 1 条候选')).toBeVisible();
  expect(screen.getByTestId('location')).toHaveTextContent(`run=${summary.id}`);
  await user.click(screen.getByRole('button', { name: '原文' }));
  expect(await screen.findByText('入库回写后的原文')).toBeVisible();
  expect(extraction.start).not.toHaveBeenCalled();
});
