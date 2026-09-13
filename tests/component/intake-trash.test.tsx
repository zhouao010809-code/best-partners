import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useIntakeTrash } from '../../src/client/pages/intake/useIntakeTrash.js';
import { browserReadConsoleApi, type ApiClientResult } from '../../src/client/api/client.js';
import type { ConsoleRuntime } from '../../src/client/app/ConsoleRuntime.js';
import type { IntakeTrashEntry } from '../../src/shared/api/intake-trash.js';

const id = '62b6b258-8469-45ac-ae2e-a3c6a46af160';
const name = '未命名资料包';
const title = '未填写信息的资料';
const storageKey = 'brain-intake-trash-pending-operation';
const entry: IntakeTrashEntry = { id, name, title, kind: 'directory', fileCount: 3, bytes: 2048, createdAt: '2026-09-07T00:00:00Z', status: 'trashed' };
const preview = { id, name, title, kind: 'directory' as const, fileCount: 3, bytes: 2048, expiresAt: '2099-01-01T00:00:00Z' };
const ok = <T,>(value: T) => ({ ok: true as const, value });
const failure = (message: string, code?: string) => ({ ok: false as const, state: { status: 'operation-error' as const, message }, ...(code ? { code } : {}) });
const intakeTrash = { list: vi.fn(), preview: vi.fn(), commit: vi.fn(), get: vi.fn(), restore: vi.fn(), retry: vi.fn(), previewDelete: vi.fn(), delete: vi.fn() };
const changed = vi.fn();
let runtime: ConsoleRuntime;
vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => runtime }));

type HarnessProps = { showTrash?: boolean; showTrigger?: boolean; showDelete?: boolean };
function Harness(props: HarnessProps) {
  return <MemoryRouter initialEntries={[props.showDelete ? '/trash' : '/intake']}><HarnessContent {...props} /></MemoryRouter>;
}
function HarnessContent({ showTrash = false, showTrigger = true, showDelete = false }: HarnessProps) {
  const trash = useIntakeTrash(changed, { allowPermanentDelete: showDelete });
  return <main>
    {showTrigger && <button onClick={() => trash.open({ name, title })} disabled={!trash.available || trash.busy || trash.visible}>移入回收站：资料</button>}
    {showDelete && <button onClick={() => trash.openDelete(entry)} disabled={trash.busy || trash.visible}>彻底删除资料包</button>}
    <button aria-label="刷新收件箱" disabled={trash.busy || trash.visible}>刷新</button>
    <button disabled={trash.busy || trash.visible}>归档资料</button>
    <output aria-label="操作状态">{trash.busy ? '忙碌' : '空闲'}</output>
    {showTrash && trash.view}{trash.dialog}
  </main>;
}
beforeEach(() => {
  localStorage.clear();
  runtime = { dataRevision: 0, refreshHealth: vi.fn(async () => {}), health: { status: 'loading' }, api: { ...browserReadConsoleApi, intakeTrash } };
  intakeTrash.list.mockResolvedValue(ok({ items: [] }));
  intakeTrash.preview.mockResolvedValue(ok(preview));
  intakeTrash.commit.mockResolvedValue(ok(entry));
  intakeTrash.get.mockResolvedValue(ok(entry));
  intakeTrash.restore.mockResolvedValue(ok({ ...entry, status: 'restored' }));
  intakeTrash.retry.mockResolvedValue(ok(entry));
  intakeTrash.previewDelete.mockResolvedValue(ok({ ...preview, token: '6e2553b8-5a80-41c6-858b-30f98e7a91c0' }));
  intakeTrash.delete.mockResolvedValue(ok({ ...entry, status: 'deleted', deletedAt: entry.createdAt }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); localStorage.clear(); });

it('retains an uncertain packet deletion and requires a fresh explicit confirmation to continue a partial deletion', async () => {
  intakeTrash.delete.mockResolvedValueOnce(failure('删除响应丢失'));
  intakeTrash.get.mockResolvedValue(ok({ ...entry, status: 'deleting' }));
  intakeTrash.retry.mockResolvedValue(ok({ ...entry, status: 'deleting' }));
  const user = userEvent.setup(); const first = render(<Harness showDelete />);
  await user.click(screen.getByRole('button', { name: '彻底删除资料包' }));
  await user.click(await screen.findByRole('button', { name: '确认彻底删除' }));
  expect(await screen.findByText('删除响应丢失')).toBeVisible();
  const pending = JSON.parse(localStorage.getItem(storageKey)!);
  expect(pending).toMatchObject({ id, action: 'delete', token: '6e2553b8-5a80-41c6-858b-30f98e7a91c0' });
  first.unmount(); render(<Harness showDelete />);
  expect(intakeTrash.delete).toHaveBeenCalledTimes(1); expect(intakeTrash.get).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '查询本次结果' }));
  expect(await screen.findByRole('heading', { name: '正在彻底删除' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '继续核验' }));
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(pending);
  expect(intakeTrash.delete).toHaveBeenCalledTimes(1);
  const freshToken = '3a78e79c-217c-4bc1-ae0c-597a3b3e7663';
  intakeTrash.previewDelete.mockResolvedValue(ok({ ...preview, token: freshToken }));
  await user.click(screen.getByRole('button', { name: '重新确认彻底删除' }));
  await user.click(await screen.findByRole('button', { name: '取消' }));
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(pending);
  await user.click(screen.getByRole('button', { name: '彻底删除资料包' }));
  await user.click(await screen.findByRole('button', { name: '确认彻底删除' }));
  expect(await screen.findByRole('heading', { name: '已彻底删除' })).toBeVisible();
  expect(intakeTrash.delete).toHaveBeenLastCalledWith(id, freshToken);
  expect(localStorage.getItem(storageKey)).toBeNull();
});

it('does not replace a pending packet operation when another packet is selected', async () => {
  const otherId = 'b1f349e1-9303-4afc-a1a7-17d0e0efab8f';
  localStorage.setItem(storageKey, JSON.stringify({ id: otherId, name: '另一个资料包', title: '另一个资料包', action: 'restore' }));
  const user = userEvent.setup(); render(<Harness showDelete />);
  await user.click(screen.getByRole('button', { name: '关闭回收操作' }));
  await user.click(screen.getByRole('button', { name: '彻底删除资料包' }));
  expect(screen.getByText(`操作编号：${otherId}`)).toBeVisible();
  expect(intakeTrash.previewDelete).not.toHaveBeenCalled(); expect(intakeTrash.delete).not.toHaveBeenCalled();
});

it('previews the whole packet with its own attachments and cancels without a write', async () => {
  const user = userEvent.setup(); render(<Harness />);
  const trigger = screen.getByRole('button', { name: '移入回收站：资料' });
  await user.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: '移入回收站' });
  expect(await within(dialog).findByText(/整个资料包及其自带附件/u)).toBeVisible();
  expect(within(dialog).getByText(name)).toBeVisible();
  expect(within(dialog).getByText(/3 个文件/u)).toBeVisible();
  expect(within(dialog).getByText(/2,048 字节/u)).toBeVisible();
  expect(screen.getByRole('button', { name: '归档资料' })).toBeDisabled();
  expect(intakeTrash.preview).toHaveBeenCalledExactlyOnceWith(name, expect.any(AbortSignal));
  expect(intakeTrash.commit).not.toHaveBeenCalled();
  expect(localStorage.getItem(storageKey)).toBeNull();
  await user.click(within(dialog).getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(trigger).toHaveFocus();
  expect(intakeTrash.commit).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
});

it('persists the operation before one explicit commit and offers a recoverable receipt', async () => {
  intakeTrash.commit.mockImplementation(async (operationId: string) => {
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ id: operationId, name, title, action: 'commit' });
    return ok(entry);
  });
  const user = userEvent.setup(); render(<Harness />);
  await user.click(screen.getByRole('button', { name: '移入回收站：资料' }));
  await user.dblClick(await screen.findByRole('button', { name: '确认移入回收站' }));
  expect(await screen.findByRole('heading', { name: '已移入回收站' })).toBeVisible();
  expect(intakeTrash.commit).toHaveBeenCalledExactlyOnceWith(id); expect(changed).toHaveBeenCalledWith(entry);
  expect(screen.queryByRole('button', { name: '确认移入回收站' })).toBeNull();
  expect(screen.queryByRole('button', { name: /彻底删除/u })).toBeNull();
  expect(localStorage.getItem(storageKey)).toBeNull();
  await user.click(screen.getByRole('button', { name: '恢复到收件箱' }));
  expect(await screen.findByRole('heading', { name: '已恢复到收件箱' })).toBeVisible();
  expect(intakeTrash.restore).toHaveBeenCalledExactlyOnceWith(id);
  await user.click(screen.getByRole('button', { name: '关闭回收操作' }));
  expect(screen.getByRole('button', { name: '移入回收站：资料' })).toHaveFocus();
});

it('does not turn a still-trashed query into a successful restore receipt', async () => {
  localStorage.setItem(storageKey, JSON.stringify({ id, name, title, action: 'restore' }));
  const user = userEvent.setup(); render(<Harness />);
  await user.click(screen.getByRole('button', { name: '查询本次结果' }));
  expect(await screen.findByRole('heading', { name: '尚未恢复到收件箱' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: '已恢复到收件箱' })).toBeNull();
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ id, action: 'restore' });
  expect(screen.getByRole('button', { name: '使用同一编号重试恢复' })).toBeVisible();
  expect(intakeTrash.restore).not.toHaveBeenCalled();
});

it('keeps an uncertain operation across remount without submitting it automatically', async () => {
  intakeTrash.commit.mockResolvedValue(failure('提交响应丢失'));
  const user = userEvent.setup(); const view = render(<Harness />);
  await user.click(screen.getByRole('button', { name: '移入回收站：资料' }));
  await user.click(await screen.findByRole('button', { name: '确认移入回收站' }));
  expect(await screen.findByText('提交响应丢失')).toBeVisible();
  expect(screen.getByText(`操作编号：${id}`)).toBeVisible();
  view.unmount(); render(<Harness />);
  expect(await screen.findByRole('dialog', { name: '收件箱回收操作' })).toBeVisible();
  expect(intakeTrash.get).not.toHaveBeenCalled(); expect(intakeTrash.commit).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: '查询本次结果' }));
  expect(await screen.findByRole('heading', { name: '已移入回收站' })).toBeVisible();
  expect(intakeTrash.get).toHaveBeenCalledExactlyOnceWith(id, expect.any(AbortSignal));
  expect(intakeTrash.preview).toHaveBeenCalledTimes(1); expect(intakeTrash.commit).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(storageKey)).toBeNull();
});

it('retries the same operation only when asked, retaining durable restore failures', async () => {
  intakeTrash.list.mockResolvedValue(ok({ items: [entry] }));
  intakeTrash.restore.mockResolvedValueOnce(failure('原位置已有文件，未覆盖'));
  const user = userEvent.setup(); const view = render(<Harness showTrash />);
  await user.click(await screen.findByRole('button', { name: `恢复到收件箱：${title}` }));
  expect(await screen.findByText('原位置已有文件，未覆盖')).toBeVisible();
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ id, action: 'restore' });
  expect(screen.queryByRole('heading', { name: '已恢复到收件箱' })).toBeNull();
  view.unmount(); render(<Harness />);
  expect(intakeTrash.restore).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: '使用同一编号重试恢复' }));
  expect(await screen.findByRole('heading', { name: '已恢复到收件箱' })).toBeVisible();
  expect(intakeTrash.restore.mock.calls).toEqual([[id], [id]]);
});

it('lists only actual unrecovered entries and supports explicit verification', async () => {
  intakeTrash.list.mockResolvedValueOnce(ok({ items: [
    { ...entry, status: 'needs-review', problem: '需要核对资料包' },
    { ...entry, id: 'b1f349e1-9303-4afc-a1a7-17d0e0efab8f', title: '已恢复的旧资料', status: 'restored' }
  ] })).mockResolvedValue(ok({ items: [entry] }));
  const user = userEvent.setup(); render(<Harness showTrash />);
  expect(await screen.findByRole('heading', { name: '收件箱回收站' })).toBeVisible();
  expect(await screen.findByText('需要核对资料包')).toBeVisible();
  expect(screen.queryByText('已恢复的旧资料')).toBeNull();
  expect(screen.getByLabelText('回收站资料数量')).toHaveTextContent('1');
  await user.click(screen.getByRole('button', { name: `继续核验：${title}` }));
  expect(await screen.findByRole('heading', { name: '已移入回收站' })).toBeVisible();
  expect(intakeTrash.retry).toHaveBeenCalledExactlyOnceWith(id); expect(intakeTrash.commit).not.toHaveBeenCalled();
});

it('shows list errors without an empty-success state and permits refresh', async () => {
  intakeTrash.list.mockResolvedValueOnce(failure('暂时无法读取回收站'));
  const user = userEvent.setup(); render(<Harness showTrash />);
  expect(await screen.findByText('暂时无法读取回收站')).toBeVisible();
  expect(screen.queryByText('回收站为空')).toBeNull();
  expect(screen.queryByLabelText('回收站资料数量')).toBeNull();
  await user.click(screen.getByRole('button', { name: '刷新收件箱回收站' }));
  expect(await screen.findByText('回收站为空')).toBeVisible();
});

it('abandons a stale attempt only after a same-id not-found query', async () => {
  intakeTrash.commit.mockResolvedValue(failure('预览已过期', 'INTAKE_TRASH_PREVIEW_STALE'));
  intakeTrash.get.mockResolvedValue(failure('本次操作尚未登记', 'INTAKE_TRASH_NOT_FOUND'));
  const user = userEvent.setup(); render(<Harness />);
  await user.click(screen.getByRole('button', { name: '移入回收站：资料' }));
  await user.click(await screen.findByRole('button', { name: '确认移入回收站' }));
  expect(await screen.findByText('预览已过期')).toBeVisible();
  expect(screen.queryByRole('button', { name: '取消本次尝试' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '查询本次结果' }));
  await user.click(await screen.findByRole('button', { name: '取消本次尝试' }));
  expect(localStorage.getItem(storageKey)).toBeNull();
  await user.click(screen.getByRole('button', { name: '移入回收站：资料' }));
  expect(await screen.findByRole('button', { name: '确认移入回收站' })).toBeVisible();
  expect(intakeTrash.preview).toHaveBeenCalledTimes(2); expect(intakeTrash.commit).toHaveBeenCalledTimes(1);
});

it('cancels a slow preview, ignores its late response, and rejects a different packet', async () => {
  let resolve!: (result: unknown) => void;
  intakeTrash.preview.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const user = userEvent.setup(); render(<Harness />);
  await user.click(screen.getByRole('button', { name: '移入回收站：资料' }));
  expect(screen.getByLabelText('操作状态')).toHaveTextContent('忙碌');
  await user.click(screen.getByRole('button', { name: '取消' }));
  expect(intakeTrash.preview.mock.calls[0]![1].aborted).toBe(true);
  await act(async () => resolve(ok(preview)));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.getByLabelText('操作状态')).toHaveTextContent('空闲');
  intakeTrash.preview.mockResolvedValue(ok({ ...preview, name: '另一个资料包' }));
  await user.click(screen.getByRole('button', { name: '移入回收站：资料' }));
  expect(await screen.findByText(/预览与所选资料包不匹配/u)).toBeVisible();
  expect(screen.queryByRole('button', { name: '确认移入回收站' })).toBeNull();
});

it('traps keyboard focus and consumes Escape before the enclosing editor', async () => {
  const user = userEvent.setup(); render(<Harness />);
  const parentEscape = vi.fn(); document.addEventListener('keydown', parentEscape);
  try {
    const trigger = screen.getByRole('button', { name: '移入回收站：资料' });
    await user.click(trigger); const dialog = await screen.findByRole('dialog', { name: '移入回收站' });
    const cancel = await within(dialog).findByRole('button', { name: '取消' });
    cancel.focus(); await user.tab(); expect(within(dialog).getByRole('button', { name: '关闭回收操作' })).toHaveFocus();
    await user.tab({ shift: true }); expect(cancel).toHaveFocus();
    parentEscape.mockClear(); await user.keyboard('{Escape}');
    expect(parentEscape).not.toHaveBeenCalled(); expect(screen.queryByRole('dialog')).toBeNull(); expect(trigger).toHaveFocus();
  } finally { document.removeEventListener('keydown', parentEscape); }
});

it('places the modal above container-contained intake and editor surfaces', async () => {
  const user = userEvent.setup(); const view = render(<div className="intake-page"><Harness /></div>);
  await user.click(screen.getByRole('button', { name: '移入回收站：资料' }));
  const dialog = await screen.findByRole('dialog', { name: '移入回收站' });
  expect(view.container.contains(dialog)).toBe(false);
  expect(dialog.parentElement?.parentElement).toBe(document.body);
});

it('returns focus to the inbox refresh when the original envelope has been removed', async () => {
  const user = userEvent.setup(); const view = render(<Harness />);
  await user.click(screen.getByRole('button', { name: '移入回收站：资料' }));
  await user.click(await screen.findByRole('button', { name: '确认移入回收站' }));
  await screen.findByRole('heading', { name: '已移入回收站' });
  view.rerender(<Harness showTrigger={false} />);
  await user.click(screen.getByRole('button', { name: '关闭回收操作' }));
  expect(screen.getByRole('button', { name: '刷新收件箱' })).toHaveFocus();
});

it('locks all actions during submission and preserves the id if unmounted before the response', async () => {
  let resolve!: (result: ApiClientResult<IntakeTrashEntry>) => void;
  intakeTrash.commit.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const user = userEvent.setup(); const view = render(<Harness />);
  await user.click(screen.getByRole('button', { name: '移入回收站：资料' }));
  await user.click(await screen.findByRole('button', { name: '确认移入回收站' }));
  expect(screen.getByRole('button', { name: '归档资料' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '关闭回收操作' })).toBeDisabled();
  await user.keyboard('{Escape}'); expect(screen.getByRole('dialog')).toBeVisible();
  view.unmount(); await act(async () => resolve(ok(entry)));
  expect(changed).not.toHaveBeenCalled(); expect(localStorage.getItem(storageKey)).toContain(id);
  render(<Harness />); expect(screen.getByLabelText('操作状态')).toHaveTextContent('空闲');
  expect(intakeTrash.commit).toHaveBeenCalledTimes(1);
});

it('refuses submission when the pending id cannot be stored', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  const user = userEvent.setup(); render(<Harness />);
  await user.click(screen.getByRole('button', { name: '移入回收站：资料' }));
  await user.click(await screen.findByRole('button', { name: '确认移入回收站' }));
  expect(await screen.findByText(/无法在本机保留操作编号/u)).toBeVisible();
  expect(intakeTrash.commit).not.toHaveBeenCalled();
});

it('refuses an expired preview and a mismatched receipt', async () => {
  const user = userEvent.setup(); const view = render(<Harness />);
  intakeTrash.preview.mockResolvedValueOnce(ok({ ...preview, expiresAt: '2000-01-01T00:00:00Z' }));
  await user.click(screen.getByRole('button', { name: '移入回收站：资料' }));
  expect(await screen.findByRole('button', { name: '确认移入回收站' })).toBeDisabled();
  expect(intakeTrash.commit).not.toHaveBeenCalled(); view.unmount();
  intakeTrash.commit.mockResolvedValue(ok({ ...entry, name: '另一份资料' })); render(<Harness />);
  await user.click(screen.getByRole('button', { name: '移入回收站：资料' }));
  await user.click(await screen.findByRole('button', { name: '确认移入回收站' }));
  expect(await screen.findByText(/返回记录与本次操作不匹配/u)).toBeVisible();
  expect(changed).not.toHaveBeenCalled(); expect(localStorage.getItem(storageKey)).toContain(id);
  await waitFor(() => expect(screen.getByRole('button', { name: '查询本次结果' })).toBeEnabled());
});
