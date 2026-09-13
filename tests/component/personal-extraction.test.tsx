import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsPage } from '../../src/client/pages/SettingsPage.js';
import { AppRouter } from '../../src/client/app/router.js';
import { ExtractionWorkbench } from '../../src/client/pages/ExtractionPage.js';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const settings = { available: true, configured: true, providerHost: 'api.deepseek.com', model: 'deepseek-v4-flash' };
const source = '01图书馆/来自个人/2026-09/文章/文章.md';
const preview = { token: 'e52917bc-a9df-482f-aae8-8c4b6da4301d', materialPath: source, title: '一份测试资料', readingState: '未看',
  sourceRawSha256: 'a'.repeat(64), ruleFingerprint: 'b'.repeat(64), model: settings.model, providerHost: settings.providerHost,
  expiresAt: '2099-09-06T00:00:00.000Z', messages: [{ role: 'system', content: '只生成候选的规则' }, { role: 'user', content: '<script>不可信原文</script>' }] };
const run = { id: preview.token, materialPath: source, title: preview.title, readingState: '未看', sourceRawSha256: preview.sourceRawSha256,
  ruleFingerprint: preview.ruleFingerprint, model: settings.model, createdAt: '2026-09-06T00:00:00.000Z', status: 'ready',
  result: { briefing: { sentences: ['这是第一句话。', '这是第二句话。', '这是第三句话。'], keyPoints: ['原文的主要知识点'], usefulness: '帮助理解资料' },
    candidates: [{ title: '测试候选知识', knowledgeType: '方法', suggestedPath: '02知识库/09学习', topics: [], coreContent: '可复用的学习步骤', value: '降低重复阅读成本' }] } };
const deepSeek = { get: vi.fn(), setKey: vi.fn(), clearKey: vi.fn() };
const extraction = { list: vi.fn(), preview: vi.fn(), start: vi.fn(), get: vi.fn(), cancel: vi.fn() };
const refreshHealth = vi.fn();
const getDocumentDetail = vi.fn();
const extractionQueue = { get: vi.fn() };
let queueAvailable = false;
let dataRevision = 0;
vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => ({ api: { deepSeek, extraction, getDocumentDetail, ...(queueAvailable ? { extractionQueue } : {}) }, health: { status: 'loading' }, refreshHealth, dataRevision }) }));
vi.mock('../../src/client/app/AppShell.js', () => ({ AppShell: () => <Outlet /> }));
vi.mock('../../src/client/components/DocumentIssuesPanel.js', () => ({ DocumentIssuesPanel: () => null }));

beforeEach(() => {
  queueAvailable = false; dataRevision = 0;
  deepSeek.get.mockResolvedValue(ok(settings)); deepSeek.setKey.mockResolvedValue(ok(settings));
  deepSeek.clearKey.mockResolvedValue(ok({ ...settings, configured: false }));
  extraction.list.mockResolvedValue(ok({ items: [] })); extraction.preview.mockResolvedValue(ok(preview));
  extraction.start.mockResolvedValue(ok(run)); extraction.get.mockResolvedValue(ok(run));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });
function openWorkbench(path = `/extractions/new?materialPath=${encodeURIComponent(source)}`) {
  return render(<MemoryRouter initialEntries={[path]}><AppRouter /></MemoryRouter>);
}
function RouteProbe() { return <output aria-label="当前路由">{useLocation().pathname}</output>; }
it.each([undefined, false])('allows another extraction for a completed partial range with coversWholeSource=%s only after server permission', async coversWholeSource => {
  queueAvailable = true;
  extraction.get.mockResolvedValue(ok({ ...run, sourceRange: { offset: 20, length: 80, label: '原件第 1 页', ...(coversWholeSource === undefined ? {} : { coversWholeSource }) } }));
  extractionQueue.get.mockResolvedValue(ok({ item: { materialPath: source, view: 'pending', canExtract: true, reviewComplete: false, pendingCandidateCount: 0 } }));
  openWorkbench(`/extractions/${run.id}`);
  expect(await screen.findByText(/本次范围：原件第 1 页/u)).toBeVisible();
  expect(await screen.findByRole('link', { name: '继续提炼' })).toHaveAttribute('href', `/extractions/new?materialPath=${encodeURIComponent(source)}`);
  expect(extraction.preview).not.toHaveBeenCalled(); expect(extraction.start).not.toHaveBeenCalled();
});

it('keeps remaining-page extraction blocked while candidates are pending and refreshes permission after source changes', async () => {
  queueAvailable = true;
  extraction.get.mockResolvedValue(ok({ ...run, sourceRange: { offset: 20, length: 80, label: '原件第 1 页', coversWholeSource: false } }));
  extractionQueue.get.mockResolvedValue(ok({ item: { materialPath: source, view: 'ready', canExtract: false, reviewComplete: false, pendingCandidateCount: 1 } }));
  const view = render(<MemoryRouter><ExtractionWorkbench id={run.id} materialPath={source} /></MemoryRouter>);
  await waitFor(() => expect(extractionQueue.get).toHaveBeenCalled());
  expect(screen.queryByRole('link', { name: '继续提炼' })).not.toBeInTheDocument();
  extractionQueue.get.mockResolvedValue(ok({ item: { materialPath: source, view: 'pending', canExtract: true, reviewComplete: false, pendingCandidateCount: 0 } }));
  dataRevision += 1; view.rerender(<MemoryRouter><ExtractionWorkbench id={run.id} materialPath={source} /></MemoryRouter>);
  expect(await screen.findByRole('link', { name: '继续提炼' })).toBeVisible(); expect(extraction.start).not.toHaveBeenCalled();
});

it('does not treat an explicitly whole-source range as remaining pages', async () => {
  queueAvailable = true;
  extraction.get.mockResolvedValue(ok({ ...run, sourceRange: { offset: 20, length: 80, label: '全部可读原文', coversWholeSource: true } }));
  openWorkbench(`/extractions/${run.id}`); await screen.findByText('可复用的学习步骤');
  expect(screen.queryByRole('link', { name: '继续提炼' })).not.toBeInTheDocument(); expect(extractionQueue.get).not.toHaveBeenCalled();
});
it('keeps the standalone result mounted while looking at source evidence', async () => {
  getDocumentDetail.mockResolvedValue(ok({ path: source, markdown: '# 依据\n\n真实原文内容', versionMarker: { rawSha256: run.sourceRawSha256 } }));
  const user = userEvent.setup(); openWorkbench(`/extractions/${run.id}`);
  const candidateHeading = await screen.findByRole('heading', { name: '1. 测试候选知识' });
  await user.click(screen.getByRole('button', { name: '查看依据' }));
  expect(await screen.findByText('真实原文内容')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '收起依据' }));
  expect(screen.getByRole('heading', { name: '1. 测试候选知识' })).toBe(candidateHeading);
  expect(extraction.start).not.toHaveBeenCalled();
});

it('saves a password field only on explicit submit, clears it and never generates on configuration', async () => {
  const user = userEvent.setup(); render(<MemoryRouter><SettingsPage /></MemoryRouter>);
  const input = await screen.findByLabelText('DeepSeek API Key');
  expect(input).toHaveAttribute('type', 'password');
  await user.type(input, 'sk-test-user-key');
  expect(deepSeek.setKey).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '保存密钥' }));
  await waitFor(() => expect(deepSeek.setKey).toHaveBeenCalledWith('sk-test-user-key'));
  expect(input).toHaveValue('');
  expect(screen.getByText(/已保存在本机.*尚未验证/u)).toBeVisible();
  expect(extraction.start).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
});

it('defaults to unread and requires a separate consent click after literal outgoing preview', async () => {
  const user = userEvent.setup(); openWorkbench();
  await user.click(await screen.findByRole('button', { name: '预览发送内容' }));
  expect(extraction.preview).toHaveBeenCalledWith({ materialPath: source, readingState: '未看' });
  expect(await screen.findByText('<script>不可信原文</script>')).toBeVisible();
  expect(document.querySelector('script')).toBeNull();
  expect(extraction.start).not.toHaveBeenCalled();
  expect(screen.getByText(/本次发送内容约 .*上限 500 KB/u)).toBeVisible();
  await user.click(screen.getByRole('button', { name: '确认发送并提炼' }));
  expect(await screen.findByRole('heading', { name: /测试候选知识/u })).toBeVisible();
  expect(extraction.start).toHaveBeenCalledTimes(1);
  expect(extraction.start).toHaveBeenCalledWith(preview.token);
  expect(screen.getByText(/阅读状态判断：未看/u)).toBeVisible();
  expect(screen.getByText('这份资料讲了什么')).toBeVisible();
  expect(screen.getByText(/候选已保存在本机.*尚未入库/u)).toBeVisible();
  expect(screen.queryByRole('button', { name: /^确认入库$/u })).not.toBeInTheDocument();
});

it('invalidates consent preview when reading state changes', async () => {
  const user = userEvent.setup(); openWorkbench();
  await user.click(await screen.findByRole('button', { name: '预览发送内容' }));
  await screen.findByRole('button', { name: '确认发送并提炼' });
  await user.click(screen.getByRole('radio', { name: '已看过' }));
  expect(screen.queryByRole('button', { name: '确认发送并提炼' })).not.toBeInTheDocument();
  expect(extraction.start).not.toHaveBeenCalled();
});

it('reopens a durable result without automatically sending the source again', async () => {
  openWorkbench(`/extractions/${run.id}`);
  expect(await screen.findByRole('heading', { name: /测试候选知识/u })).toBeVisible();
  expect(extraction.get).toHaveBeenCalledWith(run.id, expect.any(AbortSignal));
  expect(extraction.preview).not.toHaveBeenCalled(); expect(extraction.start).not.toHaveBeenCalled();
});

it('does not display a result returned for a different run id', async () => {
  extraction.get.mockResolvedValue(ok({ ...run, id: '62b6b258-8469-45ac-ae2e-a3c6a46af160' }));
  openWorkbench(`/extractions/${run.id}`);
  expect(await screen.findByRole('alert')).toHaveTextContent('提炼记录与当前选择不匹配');
  expect(screen.queryByRole('heading', { name: /测试候选知识/u })).not.toBeInTheDocument();
  expect(extraction.start).not.toHaveBeenCalled();
});

it('offers saved results instead of silently regenerating the selected material', async () => {
  extraction.list.mockResolvedValue(ok({ items: [run] })); openWorkbench();
  expect(await screen.findByRole('link', { name: /查看已保存候选/u })).toHaveAttribute('href', `/extractions/${run.id}`);
  expect(extraction.start).not.toHaveBeenCalled();
});

it('directs an unconfigured user to settings without sending data', async () => {
  deepSeek.get.mockResolvedValue(ok({ ...settings, configured: false })); openWorkbench();
  expect(await screen.findByRole('link', { name: '配置 DeepSeek' })).toHaveAttribute('href', '/settings');
  expect(screen.queryByRole('button', { name: '预览发送内容' })).not.toBeInTheDocument();
  expect(extraction.start).not.toHaveBeenCalled();
});

it('shows a failed run with a deliberate retry path rather than automatically retrying', async () => {
  extraction.get.mockResolvedValue(ok({ ...run, status: 'failed', result: undefined, problem: 'DeepSeek 暂时无法连接，请稍后重试。' }));
  openWorkbench(`/extractions/${run.id}`);
  expect(await screen.findByText('DeepSeek 暂时无法连接，请稍后重试。')).toBeVisible();
  expect(screen.getByRole('link', { name: '重新预览后再试' })).toHaveAttribute('href', `/extractions/new?materialPath=${encodeURIComponent(source)}&readingState=%E6%9C%AA%E7%9C%8B`);
  expect(extraction.start).not.toHaveBeenCalled();
});
it('routes credential failures to settings and preserves the reading decision when retrying', async () => {
  const failed = { ...run, readingState: '已看' as const, status: 'failed' as const, result: undefined, problem: 'DeepSeek 密钥未通过验证，请在设置中更新密钥。' };
  extraction.get.mockResolvedValue(ok(failed));
  const user = userEvent.setup(); openWorkbench(`/extractions/${failed.id}`);
  expect(await screen.findByRole('link', { name: '去设置更新密钥' })).toHaveAttribute('href', '/settings');
  const retry = screen.getByRole('link', { name: '重新预览后再试' });
  expect(retry).toHaveAttribute('href', `/extractions/new?materialPath=${encodeURIComponent(source)}&readingState=%E5%B7%B2%E7%9C%8B`);
  await user.click(retry);
  expect(await screen.findByRole('radio', { name: '已看过' })).toBeChecked();
  expect(extraction.preview).not.toHaveBeenCalled();
});

it('keeps the briefing reachable for an empty result even when the material was already read', async () => {
  extraction.get.mockResolvedValue(ok({ ...run, readingState: '已看', result: { ...run.result, candidates: [] } }));
  openWorkbench(`/extractions/${run.id}`);
  expect(await screen.findByText(/暂未识别出适合长期复用的知识/u)).toBeVisible();
  expect(screen.getByText('这份资料讲了什么')).toBeVisible();
  expect(screen.getByText('帮助理解资料')).toBeVisible();
  expect(screen.getByText('阅读状态判断：已看')).toBeVisible();
});

it('stops an active run only after an explicit click', async () => {
  const generating = { ...run, status: 'generating', result: undefined };
  const cancelled = { ...run, status: 'cancelled', result: undefined, problem: '已取消本次提炼。' };
  extraction.get.mockResolvedValue(ok(generating));
  extraction.cancel.mockImplementation(async () => { extraction.get.mockResolvedValue(ok(cancelled)); return ok(cancelled); });
  const user = userEvent.setup(); openWorkbench(`/extractions/${run.id}`);
  const stop = await screen.findByRole('button', { name: '停止本次提炼' });
  expect(extraction.cancel).not.toHaveBeenCalled();
  await user.click(stop);
  expect(await screen.findByText('已取消本次提炼。')).toBeVisible();
  expect(extraction.cancel).toHaveBeenCalledWith(run.id);
});

it('does not double-submit while awaiting confirmation response', async () => {
  let resolve!: (value: ReturnType<typeof ok>) => void;
  extraction.start.mockImplementation(() => new Promise((accept) => { resolve = accept; }));
  const user = userEvent.setup(); const view = openWorkbench();
  await user.click(await screen.findByRole('button', { name: '预览发送内容' }));
  await user.dblClick(await screen.findByRole('button', { name: '确认发送并提炼' }));
  expect(extraction.start).toHaveBeenCalledTimes(1);
  view.unmount(); resolve(ok(run));
});

it('requires explicit confirmation before clearing an existing key', async () => {
  const user = userEvent.setup(); render(<MemoryRouter><SettingsPage /></MemoryRouter>);
  await user.click(await screen.findByRole('button', { name: '移除密钥' }));
  expect(deepSeek.clearKey).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '确认移除密钥' }));
  expect(await screen.findByText('密钥已从本机移除。已保存的候选不会删除。')).toBeVisible();
  expect(deepSeek.clearKey).toHaveBeenCalledTimes(1);
});

it('keeps embedded consent local until confirmation and reports the started run without navigating', async () => {
  const onRun = vi.fn(); const user = userEvent.setup();
  extraction.list.mockResolvedValue(ok({ items: [run] }));
  render(<MemoryRouter initialEntries={['/queue']}><RouteProbe /><ExtractionWorkbench id="new" materialPath={source} embedded onRun={onRun} /></MemoryRouter>);
  await user.click(await screen.findByRole('button', { name: '预览发送内容' }));
  expect(screen.queryByRole('link', { name: '返回提炼队列' })).not.toBeInTheDocument();
  expect(screen.queryByText('这份资料已有提炼记录')).not.toBeInTheDocument();
  expect(screen.queryByText(source)).not.toBeInTheDocument();
  expect(extraction.preview).toHaveBeenCalledWith({ materialPath: source, readingState: '未看' });
  expect(screen.getByText('资料与目录上下文').closest('details')).not.toHaveAttribute('open');
  expect(extraction.start).not.toHaveBeenCalled(); expect(onRun).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '确认发送并提炼' }));
  await waitFor(() => expect(onRun).toHaveBeenCalledExactlyOnceWith(run));
  expect(screen.getByLabelText('当前路由')).toHaveTextContent('/queue');
});

it('notifies embedded progress once per status and uses the current callback without restarting polling', async () => {
  vi.useFakeTimers();
  const generating = { ...run, status: 'generating', result: undefined };
  extraction.get.mockResolvedValueOnce(ok(generating)).mockResolvedValueOnce(ok(generating)).mockResolvedValue(ok(run));
  const first = vi.fn(); const second = vi.fn();
  const view = render(<MemoryRouter><ExtractionWorkbench id={run.id} materialPath={source} embedded onRun={first} /></MemoryRouter>);
  await act(async () => {});
  expect(first).toHaveBeenCalledExactlyOnceWith(generating);
  view.rerender(<MemoryRouter><ExtractionWorkbench id={run.id} materialPath={source} embedded onRun={second} /></MemoryRouter>);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(extraction.get).toHaveBeenCalledTimes(2); expect(second).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(second).toHaveBeenCalledExactlyOnceWith(run);
  expect(screen.getByRole('heading', { name: /测试候选知识/u })).toBeVisible();
});

it('does not let a delayed poll replace an explicitly cancelled embedded run', async () => {
  vi.useFakeTimers();
  const generating = { ...run, status: 'generating', result: undefined };
  const cancelled = { ...generating, status: 'cancelled', problem: '已取消本次提炼。' };
  let resolvePoll!: (value: ReturnType<typeof ok>) => void;
  let resolveCancel!: (value: ReturnType<typeof ok>) => void;
  extraction.get.mockResolvedValueOnce(ok(generating)).mockImplementationOnce(() => new Promise((resolve) => { resolvePoll = resolve; })).mockResolvedValue(ok(cancelled));
  extraction.cancel.mockImplementation(() => new Promise((resolve) => { resolveCancel = resolve; })); const onRun = vi.fn();
  render(<MemoryRouter><ExtractionWorkbench id={run.id} materialPath={source} embedded onRun={onRun} onRetry={vi.fn()} /></MemoryRouter>);
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '停止本次提炼' })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  await act(async () => { resolveCancel(ok(cancelled)); await Promise.resolve(); resolvePoll(ok(generating)); });
  expect(screen.getByText('已取消本次提炼。')).toBeVisible();
  expect(screen.queryByRole('button', { name: '停止本次提炼' })).not.toBeInTheDocument();
  expect(onRun.mock.calls.map(([value]) => value.status)).toEqual(['generating', 'cancelled']);
});

it('rejects an embedded result for a different material even when the run id matches', async () => {
  extraction.get.mockResolvedValue(ok({ ...run, materialPath: '01图书馆/来自个人/另一份.md' }));
  const onRun = vi.fn();
  render(<MemoryRouter><ExtractionWorkbench id={run.id} materialPath={source} embedded onRun={onRun} /></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent('提炼记录与当前选择不匹配');
  expect(screen.queryByRole('heading', { name: /测试候选知识/u })).not.toBeInTheDocument();
  expect(onRun).not.toHaveBeenCalled();
});

it('keeps a mismatched run error visible after starting inside the embedded workbench', async () => {
  const generating = { ...run, status: 'generating', result: undefined };
  extraction.start.mockResolvedValue(ok(generating));
  extraction.get.mockResolvedValue(ok({ ...run, id: '62b6b258-8469-45ac-ae2e-a3c6a46af160' }));
  const user = userEvent.setup(); const onRun = vi.fn();
  render(<MemoryRouter><ExtractionWorkbench id="new" materialPath={source} embedded onRun={onRun} /></MemoryRouter>);
  await user.click(await screen.findByRole('button', { name: '预览发送内容' }));
  await user.click(screen.getByRole('button', { name: '确认发送并提炼' }));
  await act(async () => {});
  expect(await screen.findByRole('alert')).toHaveTextContent('提炼记录与当前选择不匹配');
  expect(screen.queryByRole('heading', { name: /测试候选知识/u })).not.toBeInTheDocument();
  expect(onRun).toHaveBeenCalledExactlyOnceWith(generating);
});

it('clears a saved embedded result when selection changes and ignores the previous request', async () => {
  const otherSource = '01图书馆/来自个人/另一份.md'; const otherId = '62b6b258-8469-45ac-ae2e-a3c6a46af160';
  let resolveNext!: (value: ReturnType<typeof ok>) => void;
  extraction.get.mockResolvedValueOnce(ok(run)).mockImplementationOnce(() => new Promise((resolve) => { resolveNext = resolve; }));
  const onRun = vi.fn();
  const view = render(<MemoryRouter><ExtractionWorkbench id={run.id} materialPath={source} embedded onRun={onRun} /></MemoryRouter>);
  await screen.findByRole('heading', { name: /测试候选知识/u });
  view.rerender(<MemoryRouter><ExtractionWorkbench id={otherId} materialPath={otherSource} embedded onRun={onRun} /></MemoryRouter>);
  expect(screen.queryByRole('heading', { name: /测试候选知识/u })).not.toBeInTheDocument();
  view.rerender(<MemoryRouter><ExtractionWorkbench id="new" materialPath={source} embedded onRun={onRun} /></MemoryRouter>);
  await act(async () => { resolveNext(ok({ ...run, id: otherId, materialPath: otherSource })); });
  expect(screen.queryByRole('heading', { name: /测试候选知识/u })).not.toBeInTheDocument();
  expect(onRun).toHaveBeenCalledExactlyOnceWith(run);
  expect(extraction.start).not.toHaveBeenCalled();
});

it('marks old-version embedded results only when the current source hash is known and different', async () => {
  const view = render(<MemoryRouter><ExtractionWorkbench id={run.id} materialPath={source} embedded /></MemoryRouter>);
  await screen.findByRole('heading', { name: /测试候选知识/u });
  expect(screen.queryByText(/旧版资料/u)).not.toBeInTheDocument();
  expect(screen.queryByText(/已删除/u)).not.toBeInTheDocument();
  view.rerender(<MemoryRouter><ExtractionWorkbench id={run.id} materialPath={source} embedded currentSourceSha={'c'.repeat(64)} /></MemoryRouter>);
  expect(screen.getByText(/资料已变化.*旧版资料/u)).toBeVisible();
  expect(screen.queryByRole('heading', { name: run.title })).not.toBeInTheDocument();
});

it('retries an embedded failure through its parent callback without navigating or sending', async () => {
  extraction.get.mockResolvedValue(ok({ ...run, status: 'failed', result: undefined, problem: '请求超时。' }));
  const onRetry = vi.fn(); const user = userEvent.setup();
  render(<MemoryRouter initialEntries={['/queue']}><RouteProbe /><ExtractionWorkbench id={run.id} materialPath={source} embedded onRetry={onRetry} /></MemoryRouter>);
  await user.click(await screen.findByRole('button', { name: '重新预览后再试' }));
  expect(onRetry).toHaveBeenCalledTimes(1); expect(extraction.preview).not.toHaveBeenCalled(); expect(extraction.start).not.toHaveBeenCalled();
  expect(screen.getByLabelText('当前路由')).toHaveTextContent('/queue');
});
