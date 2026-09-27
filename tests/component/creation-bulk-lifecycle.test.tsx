import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReadConsoleApi } from '../../src/client/api/client.js';
import type { CreationDetail, ProjectCreation } from '../../src/shared/api/project-creations.js';
import { ProjectWorkbench } from '../../src/client/components/projects/ProjectWorkbench.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const now = '2026-09-27T12:00:00Z';
const ok = <T,>(value: T) => ({ ok: true as const, value });
const failed = (message = '此项正在导出，请稍后重试。') => ({ ok: false as const, code: 'CREATION_BUSY', state: { status: 'operation-error' as const, message } });
const item = (title: string, extra: Partial<ProjectCreation> = {}): ProjectCreation => ({ id: crypto.randomUUID(), projectId, kind: 'script', title, brief: '', body: `正文：${title}`, audience: '', angle: '', rationale: '', sources: [], revision: 1, createdAt: now, updatedAt: now, ...extra });
const detail = (value: ProjectCreation): CreationDetail => ({ item: structuredClone(value), versions: [], messages: [] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
function fixture(seed = [item('脚本甲'), item('脚本乙'), item('选题丙', { kind: 'topic' })]) {
  const stored = new Map(seed.map(value => [value.id, structuredClone(value)]));
  const change = (id: string, expectedRevision: number, discarded: boolean) => {
    const before = stored.get(id)!;
    if (before.revision !== expectedRevision) return failed('内容已变化，请重新读取。');
    const value = { ...before, revision: before.revision + 1 };
    if (discarded) value.discardedAt = now; else delete value.discardedAt;
    stored.set(id, value); return ok(detail(value));
  };
  const discard = vi.fn(async (_p: string, id: string, input: { expectedRevision: number }) => change(id, input.expectedRevision, true));
  const restore = vi.fn(async (_p: string, id: string, input: { expectedRevision: number }) => change(id, input.expectedRevision, false));
  const get = vi.fn(async (_p: string, id: string) => ok(detail(stored.get(id)!)));
  const api = { creations: {
    list: vi.fn(async () => ok({ items: [...stored.values()].filter(value => !value.discardedAt) })),
    listDiscarded: vi.fn(async () => ok({ items: [...stored.values()].filter(value => value.discardedAt) })),
    get, discard, restore,
  } } as unknown as ReadConsoleApi;
  const ui = (p = projectId) => <MemoryRouter><ProjectWorkbench api={api} projectId={p} files={<p>项目原始资料</p>} /></MemoryRouter>;
  return { api, ui, stored, discard, restore, get, change, seed };
}
afterEach(() => { cleanup(); localStorage.clear(); });
async function selectAll() { fireEvent.click(await screen.findByRole('button', { name: '全选当前列表' })); }
async function confirmBatch(n = 2) {
  fireEvent.click(screen.getByRole('button', { name: `批量移入回收站（${n}）` }));
  const dialog = await screen.findByRole('dialog', { name: '批量移入项目回收站' });
  fireEvent.click(within(dialog).getByRole('button', { name: `确认移入回收站（${n}）` }));
}

it('offers visible selection on every saved list and selects only the current list', async () => {
  const final = item('成稿丁', { finalVersionId: crypto.randomUUID() });
  const f = fixture([item('脚本甲'), item('选题乙', { kind: 'topic' }), final]); render(f.ui());
  expect(await screen.findByRole('checkbox', { name: '选择创作：脚本甲' })).toBeVisible();
  expect(screen.getByRole('button', { name: '批量移入回收站（0）' })).toBeDisabled();
  await selectAll(); expect(screen.getByText('已选 2 条')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '取消全选' }));
  expect(screen.getByText('已选 0 条')).toBeVisible();
  fireEvent.click(screen.getByRole('checkbox', { name: '选择创作：脚本甲' }));
  fireEvent.click(screen.getByRole('tab', { name: /选题库/ }));
  expect(await screen.findByRole('checkbox', { name: '选择创作：选题乙' })).not.toBeChecked();
  expect(screen.getByText('已选 0 条')).toBeVisible(); await selectAll();
  expect(screen.getByText('已选 1 条')).toBeVisible();
  fireEvent.click(screen.getByRole('tab', { name: '已定稿' }));
  expect(screen.getByRole('checkbox', { name: '选择创作：成稿丁' })).not.toBeChecked();
  expect(screen.queryByRole('checkbox', { name: '选择创作：脚本甲' })).not.toBeInTheDocument();
});

it('confirms exact titles once, cancellation retains selection, and undoes all successful removals', async () => {
  const f = fixture(); render(f.ui()); await selectAll();
  fireEvent.click(screen.getByRole('button', { name: '批量移入回收站（2）' }));
  let dialog = await screen.findByRole('dialog', { name: '批量移入项目回收站' });
  expect(dialog).toHaveTextContent('脚本甲'); expect(dialog).toHaveTextContent('脚本乙'); expect(dialog).not.toHaveTextContent('选题丙');
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
  expect(f.discard).not.toHaveBeenCalled(); expect(screen.getByText('已选 2 条')).toBeVisible();
  await confirmBatch();
  expect(await screen.findByText('已移入回收站 2 条，0 条未完成。')).toBeVisible();
  expect(f.discard).toHaveBeenCalledTimes(2);
  expect(f.stored.get(f.seed[2]!.id)?.discardedAt).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: '撤销本批回收' }));
  expect(await screen.findByText('已恢复 2 条，0 条未完成。')).toBeVisible();
  expect(f.restore).toHaveBeenCalledTimes(2);
  expect(await screen.findByRole('checkbox', { name: '选择创作：脚本甲' })).not.toBeChecked();
});

it('retains only failures for retry and reports each failed title and reason', async () => {
  const f = fixture(); f.discard.mockImplementationOnce(async () => failed()); render(f.ui()); await selectAll(); await confirmBatch();
  expect(await screen.findByText('已移入回收站 1 条，1 条未完成。')).toBeVisible();
  expect(screen.getByText(/脚本甲：此项正在导出/)).toBeVisible();
  expect(screen.getByRole('checkbox', { name: '选择创作：脚本甲' })).toBeChecked();
  expect(screen.getByText('已选 1 条')).toBeVisible();
  await confirmBatch(1);
  expect(await screen.findByText('已移入回收站 1 条，0 条未完成。')).toBeVisible();
  expect(f.discard).toHaveBeenCalledTimes(3);
  expect(f.discard.mock.calls[2]![1]).toBe(f.seed[0]!.id);
});

it('restores selected recycled items as a batch and retains failures for retry', async () => {
  const f = fixture([item('回收甲', { discardedAt: now }), item('回收乙', { discardedAt: now }), item('回收丙', { discardedAt: now })]);
  f.restore.mockImplementationOnce(async () => failed('创作台已满，请先整理后恢复。'));
  render(f.ui()); fireEvent.click(await screen.findByRole('tab', { name: '回收站' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: '选择回收创作：回收甲' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '选择回收创作：回收乙' }));
  fireEvent.click(screen.getByRole('button', { name: '批量恢复（2）' }));
  expect(await screen.findByText('已恢复 1 条，1 条未完成。')).toBeVisible();
  expect(screen.getByRole('checkbox', { name: '选择回收创作：回收甲' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: '选择回收创作：回收丙' })).not.toBeChecked();
  expect(screen.getByText(/回收甲：创作台已满/)).toBeVisible();
});

it('blocks double confirmation, tab changes, selections, and opening while work is pending', async () => {
  const f = fixture(); const pending = deferred<ReturnType<typeof ok<CreationDetail>>>();
  f.discard.mockImplementationOnce(async () => pending.promise); render(f.ui()); await selectAll();
  fireEvent.click(screen.getByRole('button', { name: '批量移入回收站（2）' }));
  const confirm = within(await screen.findByRole('dialog')).getByRole('button', { name: '确认移入回收站（2）' });
  fireEvent.click(confirm); fireEvent.click(confirm);
  expect(f.discard).toHaveBeenCalledTimes(1); expect(confirm).toBeDisabled();
  expect(screen.getByRole('tab', { name: /选题库/, hidden: true })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: '选择创作：脚本甲', hidden: true })).toBeDisabled();
  expect(screen.getByRole('button', { name: '打开创作：脚本甲', hidden: true })).toBeDisabled();
  await act(async () => { const result = f.change(f.seed[0]!.id, 1, true); if (result.ok) pending.resolve(result); });
  expect(await screen.findByText('已移入回收站 2 条，0 条未完成。')).toBeVisible();
  expect(f.discard).toHaveBeenCalledTimes(2);
});

it('reconciles a lost response without repeating a mutation or claiming an unconfirmed success', async () => {
  const f = fixture();
  f.discard.mockImplementationOnce(async (_p, id, input) => { f.change(id, input.expectedRevision, true); throw new Error('lost response'); });
  f.discard.mockImplementationOnce(async () => { throw new Error('connection failed'); });
  render(f.ui()); await selectAll(); await confirmBatch();
  expect(await screen.findByText('已移入回收站 1 条，1 条未完成。')).toBeVisible();
  expect(f.get).toHaveBeenCalledTimes(2); expect(f.discard).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('checkbox', { name: '选择创作：脚本乙' })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: '撤销本批回收' }));
  expect(await screen.findByText('已恢复 1 条，0 条未完成。')).toBeVisible();
  expect(f.restore).toHaveBeenCalledWith(projectId, f.seed[0]!.id, { expectedRevision: 2 });
  expect(screen.getByRole('checkbox', { name: '选择创作：脚本乙' })).toBeChecked();
  expect(screen.getByText('已选 1 条')).toBeVisible();
});

it('keeps undo for other batch members after restoring one item individually', async () => {
  const f = fixture(); render(f.ui()); await selectAll(); await confirmBatch();
  await screen.findByText('已移入回收站 2 条，0 条未完成。');
  fireEvent.click(screen.getByRole('tab', { name: '回收站' }));
  fireEvent.click(await screen.findByRole('button', { name: '恢复创作：脚本甲' }));
  await waitFor(() => expect(screen.queryByRole('checkbox', { name: '选择回收创作：脚本甲' })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: '撤销本批回收' }));
  await screen.findByText('已恢复 1 条，0 条未完成。');
  expect(f.restore).toHaveBeenCalledTimes(2);
});

it('does not undo a member changed after recycling and preserves its recoverable receipt', async () => {
  const f = fixture(); render(f.ui()); await selectAll(); await confirmBatch();
  await screen.findByText('已移入回收站 2 条，0 条未完成。');
  const first = f.stored.get(f.seed[0]!.id)!;
  f.stored.set(first.id, { ...first, revision: first.revision + 2 });
  fireEvent.click(screen.getByRole('button', { name: '撤销本批回收' }));
  expect(await screen.findByText('已恢复 1 条，1 条未完成。')).toBeVisible();
  expect(f.stored.get(first.id)?.discardedAt).toBe(now);
  expect(screen.getByText(/脚本甲：内容已变化/)).toBeVisible();
});

it('stops a pending batch after unmount without sending remaining mutations', async () => {
  const f = fixture(); const pending = deferred<ReturnType<typeof ok<CreationDetail>>>();
  f.discard.mockImplementationOnce(async () => pending.promise); const view = render(f.ui()); await selectAll(); await confirmBatch(); view.unmount();
  await act(async () => { const result = f.change(f.seed[0]!.id, 1, true); if (result.ok) pending.resolve(result); });
  expect(f.discard).toHaveBeenCalledTimes(1);
  expect(f.stored.get(f.seed[1]!.id)?.discardedAt).toBeUndefined();
});

it('clears selection when project changes even when the same view remains', async () => {
  const f = fixture(); const view = render(f.ui()); await selectAll();
  view.rerender(f.ui('22222222-2222-4222-8222-222222222222'));
  await waitFor(() => expect(screen.getByText('已选 0 条')).toBeVisible());
});


it('reconciles transport error result envelopes as well as thrown connection errors', async () => {
  const f = fixture();
  f.discard.mockImplementationOnce(async (_p, id, input) => {
    f.change(id, input.expectedRevision, true);
    return { ok: false, state: { status: 'disconnected', message: '无法连接本地服务。' } } as never;
  });
  render(f.ui()); await selectAll(); await confirmBatch();
  expect(await screen.findByText('已移入回收站 2 条，0 条未完成。')).toBeVisible();
  expect(f.get).toHaveBeenCalledWith(projectId, f.seed[0]!.id);
  fireEvent.click(screen.getByRole('button', { name: '撤销本批回收' }));
  await screen.findByText('已恢复 2 条，0 条未完成。');
});

it('refresh removes selected rows that are no longer in the visible list', async () => {
  const f = fixture(); f.discard.mockImplementationOnce(async () => failed());
  render(f.ui()); await selectAll(); await confirmBatch();
  await screen.findByText('已移入回收站 1 条，1 条未完成。');
  f.change(f.seed[0]!.id, 1, true);
  fireEvent.click(screen.getByRole('button', { name: '重新读取列表' }));
  await waitFor(() => expect(screen.queryByRole('checkbox', { name: '选择创作：脚本甲' })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('tab', { name: '回收站' }));
  expect(await screen.findByRole('checkbox', { name: '选择回收创作：脚本甲' })).not.toBeChecked();
});

it('does not count an unrelated later recycle as a recovered success', async () => {
  const f = fixture();
  f.discard.mockImplementationOnce(async (_p, id) => {
    const current = f.stored.get(id)!;
    f.stored.set(id, { ...current, revision: current.revision + 3, discardedAt: now });
    throw new Error('result lost');
  });
  render(f.ui()); await selectAll(); await confirmBatch();
  await screen.findByText('已移入回收站 1 条，1 条未完成。');
  expect(screen.getByText(/脚本甲：内容已变化，无法确认本次结果/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '撤销本批回收' }));
  await screen.findByText('已恢复 1 条，0 条未完成。');
  expect(f.restore).toHaveBeenCalledTimes(1);
  expect(f.restore.mock.calls[0]![1]).toBe(f.seed[1]!.id);
  expect(f.stored.get(f.seed[0]!.id)?.discardedAt).toBe(now);
});
