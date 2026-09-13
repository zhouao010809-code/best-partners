import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LibraryPage } from '../../src/client/pages/LibraryPage.js';
import { MaterialTrashProvider, MaterialTrashView } from '../../src/client/components/MaterialTrash.js';
import { browserReadConsoleApi } from '../../src/client/api/client.js';
import type { ConsoleRuntime } from '../../src/client/app/ConsoleRuntime.js';
import type { TrashEntry } from '../../src/shared/api/trash.js';

const id = '62b6b258-8469-45ac-ae2e-a3c6a46af160'; const path = '01图书馆/来自个人/资料.md';
const deleteToken = '6e2553b8-5a80-41c6-858b-30f98e7a91c0';
const item = { path, title: '资料', rawSha256: 'a'.repeat(64), sourcePlatform: '个人', processingStatus: '已归档', knowledgeStatus: '已入库', generatedKnowledge: [] };
const entry: TrashEntry = { id, materialPath: path, title: '资料', status: 'trashed', indexed: true, createdAt: '2026-09-07T00:00:00Z' };
const preview = { id, materialPath: path, title: '资料', bytes: 512, expiresAt: '2099-01-01T00:00:00Z', referencedKnowledge: [{ path: '02知识库/已存知识.md', title: '已存知识' }] };
const ok = <T,>(value: T) => ({ ok: true as const, value });
const trash = { list: vi.fn(), get: vi.fn(), preview: vi.fn(), commit: vi.fn(), restore: vi.fn(), retry: vi.fn(), previewDelete: vi.fn(), delete: vi.fn() };
let runtime: ConsoleRuntime;
vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => runtime }));
async function open(route = '/library') {
  const view = render(<MemoryRouter initialEntries={[route]}>{route === '/trash' ? <MaterialTrashProvider onChanged={() => {}} allowPermanentDelete><MaterialTrashView /></MaterialTrashProvider> : <LibraryPage />}</MemoryRouter>);
  if (route !== '/trash') {
    const opener = screen.queryByRole('button', { name: '打开档案柜' });
    if (opener) await userEvent.click(opener);
    await waitFor(() => expect(screen.getByRole('button', { name: '封存并合柜' })).toBeEnabled(), { timeout: 2000 });
  }
  return view;
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  runtime = { dataRevision: 0, refreshHealth: vi.fn(async () => {}), health: { status: 'loading' }, api: { ...browserReadConsoleApi, trash,
    listMaterials: vi.fn().mockResolvedValue(ok({ items: [item] })),
    listLibrary: vi.fn().mockResolvedValue(ok({ mode: 'topic', path: '', breadcrumbs: [{ path: '', label: '全部资料' }], folders: [], items: [item], total: 1, directTotal: 1, unclassifiedCount: 0, indexVersion: 1 })),
    getDocumentDetail: vi.fn().mockResolvedValue(ok({ path, title: '资料', markdown: '# 原文', versionMarker: { rawSha256: item.rawSha256 } })),
  } };
  trash.list.mockResolvedValue(ok({ items: [] })); trash.preview.mockResolvedValue(ok(preview));
  trash.get.mockResolvedValue(ok(entry)); trash.commit.mockResolvedValue(ok(entry));
  trash.restore.mockResolvedValue(ok({ ...entry, status: 'restored', restoredAt: '2026-09-07T01:00:00Z' }));
  trash.retry.mockResolvedValue(ok(entry));
  trash.previewDelete.mockResolvedValue(ok({ ...preview, token: deleteToken }));
  trash.delete.mockResolvedValue(ok({ ...entry, status: 'deleted', deletedAt: '2026-09-07T02:00:00Z' }));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); localStorage.clear(); });

it('keeps a requested restore pending when a same-id query confirms the document is still trashed', async () => {
  localStorage.setItem('brain-trash-pending-operation', JSON.stringify({ id, materialPath: path, title: entry.title, action: 'restore' }));
  const user = userEvent.setup(); await open('/trash');
  await user.click(screen.getByRole('button', { name: '查询本次结果' }));
  expect(await screen.findByRole('heading', { name: '尚未恢复到原路径' })).toBeVisible();
  expect(JSON.parse(localStorage.getItem('brain-trash-pending-operation')!)).toMatchObject({ id, action: 'restore' });
  expect(screen.getByRole('button', { name: '使用同一编号重试恢复' })).toBeVisible();
  expect(trash.restore).not.toHaveBeenCalled();
});

it('offers separate accessible list and detail actions, previews the precise impact and cancels without writing', async () => {
  const user = userEvent.setup(); await open();
  const action = await screen.findByRole('button', { name: '移入回收站：资料' });
  expect(action.parentElement?.closest('button')).toBeNull();
  expect(screen.queryByRole('link', { name: '回收站' })).toBeNull();
  await user.click(action);
  const dialog = await screen.findByRole('dialog', { name: '移入回收站' });
  expect(within(dialog).getByText(path)).toBeVisible();
  expect(within(dialog).getByText(/只移动这份 Markdown/u)).toBeVisible();
  expect(within(dialog).getByText(/附件、目录、知识和提炼历史保持不变/u)).toBeVisible();
  expect(within(dialog).getByRole('link', { name: '已存知识' })).toHaveAttribute('href', `/knowledge?path=${encodeURIComponent('02知识库/已存知识.md')}`);
  expect(trash.commit).not.toHaveBeenCalled(); await user.click(within(dialog).getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('dialog', { name: '移入回收站' })).toBeNull(); expect(trash.commit).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '查看 资料 原文' }));
  expect(within(screen.getByRole('dialog', { name: '资料 原文' })).getByRole('button', { name: '移入回收站：资料' })).toBeVisible();
});

it('confirms once and shows a recoverable receipt instead of offering another move', async () => {
  const user = userEvent.setup(); await open(); await user.click(await screen.findByRole('button', { name: '移入回收站：资料' }));
  await user.dblClick(await screen.findByRole('button', { name: '确认移入回收站' }));
  expect(await screen.findByText('已移入回收站')).toBeVisible();
  expect(trash.commit).toHaveBeenCalledExactlyOnceWith(id);
  expect(screen.queryByRole('button', { name: '确认移入回收站' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '恢复原资料' }));
  expect(await screen.findByText('已恢复到原路径')).toBeVisible(); expect(trash.restore).toHaveBeenCalledExactlyOnceWith(id);
});

it('retains a response-lost operation across remount and only queries the same id until explicitly retried', async () => {
  trash.commit.mockResolvedValue({ ok: false, state: { status: 'disconnected', message: '响应丢失' } });
  const user = userEvent.setup(); const view = await open(); await user.click(await screen.findByRole('button', { name: '移入回收站：资料' }));
  await user.click(await screen.findByRole('button', { name: '确认移入回收站' }));
  expect(await screen.findByText(/响应丢失/u)).toBeVisible(); expect(screen.getByText(`操作编号：${id}`)).toBeVisible();
  view.unmount(); await open('/trash');
  await user.click(await screen.findByRole('button', { name: '查询本次结果' }));
  expect(await screen.findByText('已移入回收站')).toBeVisible(); expect(trash.get).toHaveBeenCalledWith(id, expect.any(AbortSignal));
  expect(trash.commit).toHaveBeenCalledTimes(1); expect(trash.preview).toHaveBeenCalledTimes(1);
});

it('separates restored receipts and preserves restore conflicts without overwriting', async () => {
  trash.list.mockResolvedValue(ok({ items: [entry, { ...entry, id: '48c07452-1845-44d6-80a6-87a9c3dc7524', title: '旧回执', status: 'restored' }] }));
  trash.restore.mockResolvedValue({ ok: false, code: 'RESTORE_CONFLICT', state: { status: 'conflict', message: '原路径已有文件，未覆盖' } });
  const user = userEvent.setup(); await open('/trash');
  expect(await screen.findByRole('heading', { name: '原始资料回收站' })).toBeVisible();
  expect(await screen.findByText('旧回执')).toBeVisible();
  expect(screen.getAllByRole('button', { name: /^恢复：/u })).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: '恢复：资料' }));
  expect(await screen.findByText(/原路径已有文件，未覆盖/u)).toBeVisible(); expect(trash.restore).toHaveBeenCalledExactlyOnceWith(id);
  expect(trash.retry).not.toHaveBeenCalled();
});

it('offers explicit verification for incomplete operations and index refresh without a second move', async () => {
  trash.list.mockResolvedValue(ok({ items: [{ ...entry, status: 'needs-review', indexed: false, problem: '需要核对两端文件' }] }));
  const user = userEvent.setup(); await open('/trash');
  await user.click(await screen.findByRole('button', { name: '继续核验：资料' }));
  await screen.findByText('已移入回收站'); expect(trash.retry).toHaveBeenCalledExactlyOnceWith(id); expect(trash.commit).not.toHaveBeenCalled();
});

it('ignores a preview from a closed dialog and refuses a mismatched source', async () => {
  let resolve!: (value: unknown) => void;
  trash.preview.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const user = userEvent.setup(); await open(); await user.click(await screen.findByRole('button', { name: '移入回收站：资料' }));
  await user.click(screen.getByRole('button', { name: '取消' }));
  await act(async () => resolve(ok(preview))); expect(screen.queryByRole('button', { name: '确认移入回收站' })).toBeNull();
  trash.preview.mockResolvedValue(ok({ ...preview, materialPath: '01图书馆/别的.md' }));
  await user.click(screen.getByRole('button', { name: '移入回收站：资料' }));
  expect(await screen.findByText(/预览与所选资料不匹配/u)).toBeVisible(); expect(trash.commit).not.toHaveBeenCalled();
});

it('closes the deep-linked original after it has moved and preserves the receipt', async () => {
  const user = userEvent.setup(); await open(`/library?path=${encodeURIComponent(path)}`);
  const original = await screen.findByRole('dialog', { name: '资料 原文' });
  await user.click(within(original).getByRole('button', { name: '移入回收站：资料' }));
  await user.click(await screen.findByRole('button', { name: '确认移入回收站' }));
  expect(await screen.findByText('已移入回收站')).toBeVisible();
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '资料 原文' })).toBeNull());
});

it('keeps an unindexed receipt and explicitly retries verification without recommitting', async () => {
  trash.commit.mockResolvedValue(ok({ ...entry, indexed: false }));
  const user = userEvent.setup(); await open(); await user.click(await screen.findByRole('button', { name: '移入回收站：资料' }));
  await user.click(await screen.findByRole('button', { name: '确认移入回收站' }));
  expect(await screen.findByText(/检索尚未更新。请继续核验/u)).toBeVisible();
  await user.click(screen.getByRole('button', { name: '继续核验' }));
  expect(trash.retry).toHaveBeenCalledExactlyOnceWith(id); expect(trash.commit).toHaveBeenCalledTimes(1);
  expect(await screen.findByRole('button', { name: '恢复原资料' })).toBeVisible();
});

it('allows a new attempt only after a same-id query confirms that the rejected attempt was never registered', async () => {
  trash.commit.mockResolvedValue({ ok: false, code: 'TRASH_PREVIEW_STALE', state: { status: 'conflict', message: '回收预览已过期，请重新预览。' } });
  trash.get.mockResolvedValueOnce({ ok: false, code: 'TRASH_NOT_FOUND', state: { status: 'operation-error', message: '本次回收尚未提交' } });
  const user = userEvent.setup(); await open(); await user.click(await screen.findByRole('button', { name: '移入回收站：资料' }));
  await user.click(await screen.findByRole('button', { name: '确认移入回收站' }));
  expect(await screen.findByText(/回收预览已过期/u)).toBeVisible();
  expect(screen.queryByRole('button', { name: '取消本次尝试' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '查询本次结果' }));
  await user.click(await screen.findByRole('button', { name: '取消本次尝试' }));
  await user.click(screen.getByRole('button', { name: '移入回收站：资料' }));
  expect(await screen.findByRole('button', { name: '确认移入回收站' })).toBeVisible();
  expect(trash.preview).toHaveBeenCalledTimes(2); expect(trash.commit).toHaveBeenCalledTimes(1);
});

it('previews permanent deletion with references and irreversible scope, then cancels without deletion or restore', async () => {
  trash.list.mockResolvedValue(ok({ items: [entry] })); const user = userEvent.setup(); await open('/trash');
  const action = await screen.findByRole('button', { name: '彻底删除：资料' });
  await user.click(action); const dialog = await screen.findByRole('dialog', { name: '彻底删除原始资料' });
  expect(await within(dialog).findByText(/无法从 App 恢复/u)).toBeVisible();
  expect(within(dialog).getByText(path)).toBeVisible();
  expect(within(dialog).getByText(/附件、目录、知识和提炼历史保持不变/u)).toBeVisible();
  expect(within(dialog).getByRole('link', { name: '已存知识' })).toBeVisible();
  expect(trash.previewDelete).toHaveBeenCalledWith(id, expect.any(AbortSignal));
  expect(trash.delete).not.toHaveBeenCalled(); await user.click(within(dialog).getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(action).toHaveFocus();
  expect(trash.delete).not.toHaveBeenCalled(); expect(trash.restore).not.toHaveBeenCalled(); expect(localStorage.length).toBe(0);
});

it('requires one explicit permanent-delete confirmation and separates nonrecoverable receipts', async () => {
  trash.list.mockResolvedValueOnce(ok({ items: [entry] })).mockResolvedValue(ok({ items: [{ ...entry, status: 'deleted', deletedAt: '2026-09-07T02:00:00Z' }] }));
  const user = userEvent.setup(); await open('/trash'); await user.click(await screen.findByRole('button', { name: '彻底删除：资料' }));
  await user.dblClick(await screen.findByRole('button', { name: '确认彻底删除' }));
  const dialog = screen.getByRole('dialog', { name: '回收操作结果' });
  expect(await within(dialog).findByRole('heading', { name: '已彻底删除' })).toBeVisible();
  expect(trash.delete).toHaveBeenCalledExactlyOnceWith(id, deleteToken);
  expect(within(dialog).queryByRole('button', { name: '恢复原资料' })).toBeNull();
  expect(within(dialog).queryByRole('button', { name: '确认彻底删除' })).toBeNull();
  await user.click(within(dialog).getByRole('button', { name: '关闭回收操作' }));
  expect(await screen.findByText('回收站为空')).toBeVisible();
  const summary = screen.getByText('已删除记录 · 1'); expect(summary.closest('details')).not.toHaveAttribute('open');
  await user.click(summary); expect(screen.getByText('资料')).toBeVisible();
  expect(screen.queryByRole('button', { name: /^恢复：/u })).toBeNull(); expect(screen.queryByRole('button', { name: /^彻底删除：/u })).toBeNull();
});

it('retains the deletion token across remount and retries only that explicit confirmation after a lost response', async () => {
  trash.list.mockResolvedValue(ok({ items: [entry] }));
  trash.delete.mockResolvedValueOnce({ ok: false, state: { status: 'disconnected', message: '删除响应丢失' } });
  trash.get.mockResolvedValue(ok({ ...entry, status: 'deleting', indexed: false }));
  const user = userEvent.setup(); const view = await open('/trash');
  await user.click(await screen.findByRole('button', { name: '彻底删除：资料' })); await user.click(await screen.findByRole('button', { name: '确认彻底删除' }));
  expect(await screen.findByText('删除响应丢失')).toBeVisible(); expect(localStorage.getItem('brain-trash-pending-operation')).toContain(deleteToken);
  view.unmount(); await open('/trash');
  await user.click(await screen.findByRole('button', { name: '查询本次结果' }));
  expect(await screen.findByRole('heading', { name: '正在彻底删除' })).toBeVisible(); expect(trash.delete).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: '使用同一确认重试删除' }));
  expect(await screen.findByRole('heading', { name: '已彻底删除' })).toBeVisible();
  expect(trash.delete.mock.calls).toEqual([[id, deleteToken], [id, deleteToken]]); expect(trash.previewDelete).toHaveBeenCalledTimes(1);
});

it('never deletes through verification and reopens a deleting receipt for explicit confirmation', async () => {
  const deleting = { ...entry, status: 'deleting', indexed: false };
  trash.list.mockResolvedValue(ok({ items: [deleting] })); trash.retry.mockResolvedValue(ok(deleting));
  const user = userEvent.setup(); await open('/trash'); await user.click(await screen.findByRole('button', { name: '继续核验：资料' }));
  expect(await screen.findByRole('heading', { name: '正在彻底删除' })).toBeVisible(); expect(trash.retry).toHaveBeenCalledExactlyOnceWith(id); expect(trash.delete).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '重新确认彻底删除' }));
  expect(await screen.findByRole('button', { name: '确认彻底删除' })).toBeVisible(); expect(trash.delete).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '确认彻底删除' })); expect(trash.delete).toHaveBeenCalledExactlyOnceWith(id, deleteToken);
});

it('keeps an unindexed deleted receipt nonrecoverable and only verifies indexing', async () => {
  trash.list.mockResolvedValue(ok({ items: [{ ...entry, status: 'deleted', indexed: false }] }));
  trash.retry.mockResolvedValue(ok({ ...entry, status: 'deleted', indexed: true }));
  const user = userEvent.setup(); await open('/trash'); await user.click(await screen.findByText('已删除记录 · 1'));
  await user.click(screen.getByRole('button', { name: '继续核验：资料' }));
  expect(await screen.findByRole('heading', { name: '已彻底删除' })).toBeVisible();
  expect(screen.queryByRole('button', { name: /恢复原资料|^恢复：/u })).toBeNull();
  expect(trash.retry).toHaveBeenCalledExactlyOnceWith(id); expect(trash.delete).not.toHaveBeenCalled(); expect(trash.restore).not.toHaveBeenCalled();
});

it('does not mistake a still-trashed query for successful deletion and permits explicit cancellation only after the query', async () => {
  trash.list.mockResolvedValue(ok({ items: [entry] }));
  trash.delete.mockResolvedValue({ ok: false, code: 'TRASH_DELETE_PREVIEW_STALE', state: { status: 'conflict', message: '删除预览已过期' } });
  const user = userEvent.setup(); await open('/trash'); await user.click(await screen.findByRole('button', { name: '彻底删除：资料' }));
  await user.click(await screen.findByRole('button', { name: '确认彻底删除' }));
  expect(await screen.findByText('删除预览已过期')).toBeVisible(); expect(screen.queryByRole('button', { name: '取消本次删除尝试' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '查询本次结果' }));
  expect(await screen.findByText(/删除尚未登记，资料仍在回收站/u)).toBeVisible();
  expect(localStorage.getItem('brain-trash-pending-operation')).toContain(deleteToken);
  await user.click(screen.getByRole('button', { name: '取消本次删除尝试' }));
  expect(localStorage.getItem('brain-trash-pending-operation')).toBeNull();
  await user.click(screen.getByRole('button', { name: '彻底删除：资料' }));
  expect(await screen.findByRole('button', { name: '确认彻底删除' })).toBeVisible(); expect(trash.delete).toHaveBeenCalledTimes(1); expect(trash.previewDelete).toHaveBeenCalledTimes(2);
});

it('retains the deletion token through ordinary verification and does not offer cancellation while the server is busy', async () => {
  trash.list.mockResolvedValue(ok({ items: [entry] }));
  trash.delete.mockResolvedValue({ ok: false, state: { status: 'disconnected', message: '响应丢失' } });
  trash.get.mockResolvedValueOnce({ ok: false, code: 'TRASH_BUSY', state: { status: 'conflict', message: '正在核验删除' } })
    .mockResolvedValueOnce(ok({ ...entry, status: 'deleting', indexed: false }));
  trash.retry.mockResolvedValue(ok({ ...entry, status: 'deleting', indexed: false }));
  const user = userEvent.setup(); await open('/trash'); await user.click(await screen.findByRole('button', { name: '彻底删除：资料' }));
  await user.click(await screen.findByRole('button', { name: '确认彻底删除' })); await user.click(await screen.findByRole('button', { name: '查询本次结果' }));
  expect(await screen.findByText('正在核验删除')).toBeVisible(); expect(screen.queryByRole('button', { name: '取消本次删除尝试' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '查询本次结果' })); await user.click(await screen.findByRole('button', { name: '继续核验' }));
  expect(trash.retry).toHaveBeenCalledExactlyOnceWith(id); expect(trash.delete).toHaveBeenCalledTimes(1);
  expect(JSON.parse(localStorage.getItem('brain-trash-pending-operation')!)).toMatchObject({ id, action: 'delete', token: deleteToken });
  expect(screen.getByRole('button', { name: '使用同一确认重试删除' })).toBeVisible();
});

it('ignores a closed deletion preview and refuses an identity mismatch or expired confirmation', async () => {
  trash.list.mockResolvedValue(ok({ items: [entry] })); let resolve!: (value: unknown) => void;
  trash.previewDelete.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const user = userEvent.setup(); await open('/trash'); const action = await screen.findByRole('button', { name: '彻底删除：资料' });
  await user.click(action); await user.click(screen.getByRole('button', { name: '取消' }));
  expect(trash.previewDelete.mock.calls[0]![1].aborted).toBe(true);
  await act(async () => resolve(ok({ ...preview, token: deleteToken }))); expect(screen.queryByRole('button', { name: '确认彻底删除' })).toBeNull();
  trash.previewDelete.mockResolvedValueOnce(ok({ ...preview, id: deleteToken, token: deleteToken }));
  await user.click(action); expect(await screen.findByText(/删除预览与所选资料不匹配/u)).toBeVisible(); expect(screen.queryByRole('button', { name: '确认彻底删除' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '取消' }));
  trash.previewDelete.mockResolvedValueOnce(ok({ ...preview, token: deleteToken, expiresAt: '2000-01-01T00:00:00Z' }));
  await user.click(action); expect(await screen.findByRole('button', { name: '确认彻底删除' })).toBeDisabled(); expect(trash.delete).not.toHaveBeenCalled();
});

it('permits abandoning an unregistered deletion after another window restored the material without calling it deleted', async () => {
  trash.list.mockResolvedValue(ok({ items: [entry] }));
  trash.delete.mockResolvedValue({ ok: false, state: { status: 'disconnected', message: '响应丢失' } });
  trash.get.mockResolvedValue(ok({ ...entry, status: 'restored', restoredAt: '2026-09-07T02:00:00Z' }));
  const user = userEvent.setup(); await open('/trash'); await user.click(await screen.findByRole('button', { name: '彻底删除：资料' }));
  await user.click(await screen.findByRole('button', { name: '确认彻底删除' })); await user.click(await screen.findByRole('button', { name: '查询本次结果' }));
  expect(await screen.findByText(/资料已恢复，本次未删除/u)).toBeVisible(); expect(screen.queryByText(/删除尚未登记，资料仍在回收站/u)).toBeNull();
  await user.click(screen.getByRole('button', { name: '取消本次删除尝试' })); expect(localStorage.getItem('brain-trash-pending-operation')).toBeNull();
  expect(trash.delete).toHaveBeenCalledTimes(1); expect(trash.restore).not.toHaveBeenCalled();
});

it('adopts a fresh deletion-preview token only after explicit confirmation and preserves the old token on cancel', async () => {
  const freshToken = '3a78e79c-217c-4bc1-ae0c-597a3b3e7663'; const deleting = { ...entry, status: 'deleting', indexed: false };
  localStorage.setItem('brain-trash-pending-operation', JSON.stringify({ id, materialPath: path, title: entry.title, action: 'delete', token: deleteToken }));
  trash.list.mockResolvedValue(ok({ items: [deleting] })); trash.get.mockResolvedValue(ok(deleting));
  trash.previewDelete.mockResolvedValue(ok({ ...preview, token: freshToken }));
  const user = userEvent.setup(); await open('/trash'); await user.click(screen.getByRole('button', { name: '查询本次结果' }));
  await user.click(await screen.findByRole('button', { name: '重新确认彻底删除' }));
  await user.click(await screen.findByRole('button', { name: '取消' }));
  expect(JSON.parse(localStorage.getItem('brain-trash-pending-operation')!)).toMatchObject({ action: 'delete', token: deleteToken });
  expect(trash.delete).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '重新确认彻底删除：资料' })); await user.click(await screen.findByRole('button', { name: '确认彻底删除' }));
  expect(await screen.findByRole('heading', { name: '已彻底删除' })).toBeVisible(); expect(trash.delete).toHaveBeenCalledExactlyOnceWith(id, freshToken);
});
