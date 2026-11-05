// Guards against duplicate dispatch, lost drafts, stale task responses, and unsafe result rendering.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AutoloopPage } from '../../src/client/pages/AutoloopPage.js';

const { autoloop } = vi.hoisted(() => ({ autoloop: { list: vi.fn(), get: vi.fn(), create: vi.fn(), answer: vi.fn(), cancel: vi.fn() } }));
vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => ({ api: { autoloop }, runtimeMode: 'personal' }) }));
const task = (id = 'first', status = 'running') => ({ id, title: id === 'first' ? '演示任务' : '第二个任务', instructions: '先问一个问题，再给出结果。', createdAt: '2026-11-05T10:00:00.000Z', status, summary: '正在处理', runId: 1, cards: [] });
const success = <T,>(value: T) => ({ ok: true as const, value });
const connection = { connected: true };
const detail = (id = 'first', status = 'running') => ({ connection, task: task(id, status), result: '', timeline: [] });
const failure = { ok: false, state: { status: 'disconnected', message: '无法连接本地服务。' } };
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(r => { resolve = r; }), resolve }; }
function fillTask() {
  fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '演示任务' } });
  fireEvent.change(screen.getByLabelText('任务要求'), { target: { value: '先问一个问题。\n回答后再继续。' } });
}
beforeEach(() => {
  vi.resetAllMocks();
  autoloop.list.mockResolvedValue(success({ connection, tasks: [] }));
  autoloop.get.mockResolvedValue(success(detail()));
  autoloop.answer.mockResolvedValue(success({ ok: true }));
  autoloop.cancel.mockResolvedValue(success({ ok: true }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('explains local execution, shows offline separately, and never submits from rendering', async () => {
  autoloop.list.mockResolvedValue(success({ connection: { connected: false, message: '自动任务服务尚未连接。' }, tasks: [] }));
  render(<AutoloopPage />);
  expect(await screen.findByText('自动任务服务尚未连接。')).toBeInTheDocument();
  expect(screen.getByText(/交给本机 Codex/)).toBeInTheDocument();
  expect(screen.getByText('还没有自动任务')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '提交任务' })).toBeDisabled();
  fillTask();
  expect(autoloop.create).not.toHaveBeenCalled();
  expect(screen.getByLabelText('任务要求').tagName).toBe('TEXTAREA');
});

it('locks duplicate submits and retries a failed request with the same UUID and draft', async () => {
  const first = deferred<unknown>();
  autoloop.create.mockReturnValueOnce(first.promise).mockResolvedValueOnce(success({ task: task() }));
  render(<AutoloopPage />);
  await screen.findByText('还没有自动任务');
  fillTask();
  fireEvent.click(screen.getByRole('button', { name: '提交任务' }));
  expect(screen.getByRole('button', { name: '提交中…' })).toBeDisabled();
  expect(autoloop.create).toHaveBeenCalledTimes(1);
  await act(async () => first.resolve(failure));
  expect(screen.getByLabelText('任务要求')).toHaveValue('先问一个问题。\n回答后再继续。');
  expect(await screen.findByRole('alert')).toHaveTextContent('无法连接本地服务');
  fireEvent.click(screen.getByRole('button', { name: '提交任务' }));
  await waitFor(() => expect(autoloop.create).toHaveBeenCalledTimes(2));
  expect(autoloop.create.mock.calls[0]?.[0]).toEqual(autoloop.create.mock.calls[1]?.[0]);
  expect(autoloop.create.mock.calls[0]?.[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
  await screen.findByRole('heading', { name: '任务结果' });
  expect(screen.getByLabelText('任务要求')).toHaveValue('');
});

it('answers options once using zero-based choice and renders results as inert text', async () => {
  const waiting = { ...detail('first', 'waiting'), task: { ...task('first', 'waiting'), cards: [{ id: 7, kind: 'ask', title: '请选择颜色', text: '选一种颜色继续。', options: ['红色', '蓝色'], state: 'open' }] } };
  autoloop.list.mockResolvedValue(success({ connection, tasks: [waiting.task] }));
  autoloop.get.mockResolvedValue(success(waiting));
  const answer = deferred<unknown>(); autoloop.answer.mockReturnValue(answer.promise);
  render(<AutoloopPage />);
  expect(await screen.findByRole('heading', { name: '请选择颜色' })).toBeInTheDocument();
  expect(autoloop.answer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '蓝色' }));
  expect(screen.getByRole('button', { name: '蓝色' })).toBeDisabled();
  expect(autoloop.answer).toHaveBeenCalledExactlyOnceWith('first', { cardId: 7, choice: 1 });
  const done = { ...detail('first', 'done'), result: '<img src=x onerror=alert(1)>\n选择了蓝色。' };
  autoloop.get.mockResolvedValue(success(done)); autoloop.list.mockResolvedValue(success({ connection, tasks: [done.task] }));
  await act(async () => answer.resolve(success({ ok: true })));
  expect(await screen.findByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
  expect(document.querySelector('.autoloop-page img')).toBeNull();
});

it('keeps typed answers through refresh and failed answer submission', async () => {
  const waiting = { ...detail('first', 'waiting'), task: { ...task('first', 'waiting'), cards: [{ id: 8, kind: 'ask', title: '需要补充什么？', text: '', options: [], state: 'open' }] } };
  autoloop.list.mockResolvedValue(success({ connection, tasks: [waiting.task] }));
  autoloop.get.mockResolvedValue(success(waiting));
  autoloop.answer.mockResolvedValue(failure);
  render(<AutoloopPage />);
  fireEvent.change(await screen.findByLabelText('补充回答'), { target: { value: '保留第一行。\n也保留第二行。' } });
  fireEvent.click(screen.getByRole('button', { name: '刷新任务' }));
  await waitFor(() => expect(autoloop.get.mock.calls.length).toBeGreaterThan(1));
  expect(screen.getByLabelText('补充回答')).toHaveValue('保留第一行。\n也保留第二行。');
  fireEvent.click(screen.getByRole('button', { name: '发送回答' }));
  await screen.findByRole('alert');
  expect(autoloop.answer).toHaveBeenCalledWith('first', { cardId: 8, text: '保留第一行。\n也保留第二行。' });
  expect(screen.getByLabelText('补充回答')).toHaveValue('保留第一行。\n也保留第二行。');
});

it('focuses task details only after the user opens a task, including the currently selected task', async () => {
  autoloop.list.mockResolvedValue(success({ connection, tasks: [task(), task('second')] }));
  autoloop.get.mockImplementation((id: string) => Promise.resolve(success(detail(id))));
  render(<AutoloopPage />);
  const first = await screen.findByRole('heading', { name: '演示任务' });
  expect(first).not.toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: /第二个任务/ }));
  const selected = screen.getByRole('heading', { name: '第二个任务' });
  expect(selected).toHaveFocus();
  const draft = screen.getByLabelText('任务名称');
  draft.focus();
  const previousReads = autoloop.get.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: '刷新任务' }));
  await waitFor(() => expect(autoloop.get.mock.calls.length).toBeGreaterThan(previousReads));
  expect(draft).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: /第二个任务/ }));
  expect(selected).toHaveFocus();
});

it('discards the old detail response after switching tasks', async () => {
  const old = deferred<unknown>();
  autoloop.list.mockResolvedValue(success({ connection, tasks: [task(), task('second')] }));
  autoloop.get.mockImplementation((id: string) => id === 'first' ? old.promise : Promise.resolve(success({ ...detail('second', 'done'), result: '第二个任务的结果' })));
  render(<AutoloopPage />);
  fireEvent.click(await screen.findByRole('button', { name: /第二个任务/ }));
  await screen.findByText('第二个任务的结果');
  await act(async () => old.resolve(success({ ...detail('first', 'done'), result: '不应显示的旧结果' })));
  expect(screen.queryByText('不应显示的旧结果')).not.toBeInTheDocument();
  expect(screen.getByText('第二个任务的结果')).toBeInTheDocument();
});

it('refreshes automatically without replacing drafts or marking an offline task as failed', async () => {
  vi.useFakeTimers();
  autoloop.list.mockResolvedValue(success({ connection, tasks: [task()] }));
  render(<AutoloopPage />);
  await act(async () => {});
  fillTask();
  autoloop.list.mockResolvedValue(success({ connection: { connected: false, message: '进度暂不可读。' }, tasks: [task('first', 'unknown')] }));
  autoloop.get.mockResolvedValue(success({ ...detail('first', 'unknown'), connection: { connected: false, message: '进度暂不可读。' } }));
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(autoloop.list.mock.calls.length).toBeGreaterThan(1);
  expect(screen.getByLabelText('任务要求')).toHaveValue('先问一个问题。\n回答后再继续。');
  expect(screen.getAllByText('状态待更新').length).toBeGreaterThan(0);
  expect(screen.queryByText('执行失败')).not.toBeInTheDocument();
});

it('requires explicit stop confirmation and never cancels on unmount', async () => {
  autoloop.list.mockResolvedValue(success({ connection, tasks: [task()] }));
  const view = render(<AutoloopPage />);
  fireEvent.click(await screen.findByRole('button', { name: '停止任务' }));
  expect(autoloop.cancel).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认停止' }));
  await waitFor(() => expect(autoloop.cancel).toHaveBeenCalledExactlyOnceWith('first'));
  view.unmount();
  expect(autoloop.cancel).toHaveBeenCalledTimes(1);
});

it('resumes a saved dispatch after remount with its original identity, without losing a new draft', async () => {
  const pending = task('first', 'dispatching');
  autoloop.list.mockResolvedValue(success({ connection, tasks: [pending] }));
  autoloop.get.mockResolvedValue(success(detail('first', 'dispatching')));
  autoloop.create.mockResolvedValue(success({ task: task() }));
  const first = render(<AutoloopPage />);
  await screen.findByRole('button', { name: '重试提交' });
  first.unmount();
  render(<AutoloopPage />);
  fillTask();
  fireEvent.click(await screen.findByRole('button', { name: '重试提交' }));
  await waitFor(() => expect(autoloop.create).toHaveBeenCalledExactlyOnceWith({ requestId: pending.id, title: pending.title, instructions: pending.instructions }));
  expect(screen.getByLabelText('任务要求')).toHaveValue('先问一个问题。\n回答后再继续。');
});

it('does not turn open notifications into answer forms', async () => {
  const notice = { ...detail(), task: { ...task(), cards: [{ id: 9, kind: 'notice', title: '正在整理', text: '稍后可以查看结果。', options: [], state: 'open' }] } };
  autoloop.list.mockResolvedValue(success({ connection, tasks: [notice.task] }));
  autoloop.get.mockResolvedValue(success(notice));
  render(<AutoloopPage />);
  await screen.findByRole('heading', { name: '任务结果' });
  expect(screen.queryByLabelText('补充回答')).not.toBeInTheDocument();
  expect(autoloop.answer).not.toHaveBeenCalled();
});

it('submits the chosen workspace, agent, model and skill and retains choices on retry', async () => {
  const choices = vi.fn().mockResolvedValue(success({ workspaces: [{ id: 'vault', name: '我的大脑', kind: 'vault', available: true }], agents: [{ id: 'claude', name: 'Claude', use: 'claude', available: true }], skills: [{ id: 'summary', name: '资料整理', description: '' }], notificationsAvailable: true }));
  Object.assign(autoloop, { choices });
  autoloop.create.mockResolvedValue(failure);
  render(<AutoloopPage />);
  fireEvent.change(await screen.findByLabelText('资料范围'), { target: { value: 'vault' } });
  fireEvent.change(screen.getByLabelText('执行 Agent'), { target: { value: 'claude' } });
  fireEvent.change(screen.getByLabelText('模型（可选）'), { target: { value: 'custom-model' } });
  fireEvent.change(screen.getByLabelText('使用 Skill'), { target: { value: 'summary' } });
  fillTask();
  fireEvent.click(screen.getByRole('button', { name: '提交任务' }));
  await screen.findByRole('alert');
  expect(autoloop.create.mock.calls[0]?.[0]).toMatchObject({ workspaceId: 'vault', agentId: 'claude', model: 'custom-model', skillId: 'summary', notify: true });
  fireEvent.click(screen.getByRole('button', { name: '提交任务' }));
  await waitFor(() => expect(autoloop.create).toHaveBeenCalledTimes(2));
  expect(autoloop.create.mock.calls[1]?.[0]).toEqual(autoloop.create.mock.calls[0]?.[0]);
  delete (autoloop as Record<string, unknown>).choices;
});
