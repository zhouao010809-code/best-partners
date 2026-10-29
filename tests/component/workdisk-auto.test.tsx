// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkdiskAutoCollection } from '../../src/client/components/workdisk/WorkdiskAutoCollection.js';
import type { DesktopWorkdiskApi } from '../../src/shared/desktop/bridge.js';
import type { WorkdiskAutoState } from '../../src/shared/workdisk-auto.js';

const empty: WorkdiskAutoState = { source: null, enabled: false, nameFromContent: true, phase: 'off', pendingCount: 0, receipts: [] };
const running: WorkdiskAutoState = { ...empty, source: { rootPath: '/tmp/downloads', displayName: '下载' }, enabled: true, phase: 'watching' };
const autoStatus = vi.fn(), chooseAutoSource = vi.fn(), setAutoEnabled = vi.fn(), setAutoNaming = vi.fn(), openAutoSource = vi.fn(), renameAutoReceipt = vi.fn(), openFile = vi.fn(), onChanged = vi.fn();
const disk = { autoStatus, chooseAutoSource, setAutoEnabled, setAutoNaming, openAutoSource, renameAutoReceipt, openFile } as unknown as DesktopWorkdiskApi;
function mount() { render(<MemoryRouter><WorkdiskAutoCollection disk={disk} onChanged={onChanged} /></MemoryRouter>); }
beforeEach(() => { vi.resetAllMocks(); autoStatus.mockResolvedValue(empty); chooseAutoSource.mockResolvedValue(running); setAutoEnabled.mockResolvedValue(running); openAutoSource.mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('explains first-run scope and AI disclosure before choosing a source and enabling automatic collection', async () => {
  mount();
  expect(await screen.findByText(/仅接收启用后新增/u)).toBeVisible();
  expect(screen.getByText(/文字和图片识别结果会发送给已连接的 AI/u)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '开启自动收纳' }));
  expect(chooseAutoSource).toHaveBeenCalledWith({ nameFromContent: true });
  expect(await screen.findByText('/tmp/downloads')).toBeVisible();
  expect(screen.getByRole('button', { name: '暂停自动收纳' })).toBeVisible();
});
it('permits original-name collection and retains the selection when the directory picker is cancelled', async () => {
  chooseAutoSource.mockResolvedValue(null); mount();
  await userEvent.click(await screen.findByRole('checkbox', { name: '自动根据内容命名' }));
  await userEvent.click(screen.getByRole('button', { name: '开启自动收纳' }));
  expect(chooseAutoSource).toHaveBeenCalledWith({ nameFromContent: false });
  expect(screen.getByRole('checkbox', { name: '自动根据内容命名' })).not.toBeChecked();
  expect(screen.getByText(/不会为自动命名发送内容/u)).toBeVisible();
});
it('pauses and resumes the same source without opening a new picker', async () => {
  autoStatus.mockResolvedValue(running);
  setAutoEnabled.mockResolvedValueOnce({ ...running, enabled: false, phase: 'paused' }).mockResolvedValueOnce(running);
  mount(); await userEvent.click(await screen.findByRole('button', { name: '暂停自动收纳' }));
  await userEvent.click(await screen.findByRole('button', { name: '继续自动收纳' }));
  expect(setAutoEnabled.mock.calls.map(args => args[0])).toEqual([false, true]); expect(chooseAutoSource).not.toHaveBeenCalled();
});
it('changes the persisted automatic naming preference separately from manual imports', async () => {
  autoStatus.mockResolvedValue(running); setAutoNaming.mockResolvedValue({ ...running, nameFromContent: false }); mount();
  await userEvent.click(await screen.findByRole('checkbox', { name: '自动根据内容命名' }));
  expect(setAutoNaming).toHaveBeenCalledWith(false);
  expect(screen.getByRole('checkbox', { name: '自动根据内容命名' })).not.toBeChecked();
});
it('updates the naming checkbox immediately while saving and restores it when saving fails', async () => {
  let reject!: (error: Error) => void;
  autoStatus.mockResolvedValue(running);
  setAutoNaming.mockImplementation(() => new Promise<WorkdiskAutoState>((_resolve, fail) => { reject = fail; }));
  mount();
  const checkbox = await screen.findByRole('checkbox', { name: '自动根据内容命名' });
  await userEvent.click(checkbox);
  expect(setAutoNaming).toHaveBeenCalledWith(false);
  expect(checkbox).not.toBeChecked();
  expect(checkbox).toBeDisabled();
  expect(screen.getByText(/正在保存命名设置/u)).toBeVisible();
  expect(screen.queryByText(/不会为自动命名发送内容/u)).not.toBeInTheDocument();
  await act(async () => { reject(new Error('设置暂时无法保存')); });
  expect(await screen.findByRole('alert')).toHaveTextContent('设置暂时无法保存');
  expect(checkbox).toBeChecked();
  expect(checkbox).toBeEnabled();
  expect(screen.getByText(/文字和图片识别结果会发送给已连接的 AI/u)).toBeVisible();
});
it('shows saved names, real paths and uncertain recovery without claiming a failed file was saved', async () => {
  autoStatus.mockResolvedValue({ ...running, receipts: [
    { id: 'saved', sourceName: '001.txt', savedName: '访谈方法.txt', path: '2026-10-30/文档/访谈方法.txt', status: 'saved', reason: '根据正文命名', receivedAt: '2026-10-30T00:00:00Z' },
    { id: 'uncertain', sourceName: '002.pdf', status: 'uncertain', reason: '上次收纳结果未确认，请核对工作盘后手动收纳。', receivedAt: '2026-10-30T00:00:00Z' }
  ] }); mount();
  expect(await screen.findByText('访谈方法.txt')).toBeVisible(); expect(screen.getByText(/上次收纳结果未确认/u)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '打开 访谈方法.txt' }));
  expect(openFile).toHaveBeenCalledWith('2026-10-30/文档/访谈方法.txt'); expect(onChanged).toHaveBeenCalledOnce();
});
it('allows correcting a saved name without editing the original download and keeps a failed edit', async () => {
  const state: WorkdiskAutoState = { ...running, receipts: [{ id: 'saved', sourceName: '001.txt', savedName: '访谈方法.txt', path: '2026-10-30/文档/访谈方法.txt', status: 'saved', reason: '根据正文命名', receivedAt: '2026-10-30T00:00:00Z' }] };
  autoStatus.mockResolvedValue(state); renameAutoReceipt.mockRejectedValueOnce(new Error('同名文件已存在')); mount();
  await userEvent.click(await screen.findByRole('button', { name: '修改 访谈方法.txt 的名称' }));
  await userEvent.clear(screen.getByRole('textbox', { name: '新的文件名称' }));
  await userEvent.type(screen.getByRole('textbox', { name: '新的文件名称' }), '我的访谈提纲');
  await userEvent.click(screen.getByRole('button', { name: '保存名称' }));
  expect(renameAutoReceipt).toHaveBeenCalledWith('saved', '我的访谈提纲');
  expect(await screen.findByRole('alert')).toHaveTextContent('同名文件已存在');
  expect(screen.getByRole('textbox')).toHaveValue('我的访谈提纲');
});
it('polls for new receipts and refreshes files only when receipt identity or names change', async () => {
  vi.useFakeTimers(); mount(); await act(async () => {});
  autoStatus.mockResolvedValue({ ...running, receipts: [{ id: 'new', sourceName: '001.txt', savedName: '主题.txt', path: '2026-10-30/文档/主题.txt', status: 'saved', reason: '', receivedAt: '2026-10-30T00:00:00Z' }] });
  await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
  expect(onChanged).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
  expect(onChanged).toHaveBeenCalledOnce();
});
it('reports failed enablement and leaves a retry path', async () => {
  chooseAutoSource.mockRejectedValue(new Error('接收文件夹不能与工作盘重叠')); mount();
  await userEvent.click(await screen.findByRole('button', { name: '开启自动收纳' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('不能与工作盘重叠'));
  expect(screen.getByRole('button', { name: '开启自动收纳' })).toBeEnabled();
});
it('allows reviewing all returned receipts and keeps a name draft visible when new receipts arrive', async () => {
  const receipts = Array.from({ length: 6 }, (_, index) => ({ id: `receipt-${index}`, sourceName: `${index}.txt`, savedName: `主题${index}.txt`, path: `2026-10-30/文档/主题${index}.txt`, status: 'saved' as const, reason: '根据正文命名', receivedAt: '2026-10-30T00:00:00Z' }));
  autoStatus.mockResolvedValue({ ...running, receipts }); mount();
  await userEvent.click(await screen.findByRole('button', { name: '查看全部 6 条记录' }));
  expect(screen.getByRole('button', { name: '修改 主题5.txt 的名称' })).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '修改 主题5.txt 的名称' }));
  await userEvent.clear(screen.getByRole('textbox'));
  await userEvent.type(screen.getByRole('textbox'), '未提交的新名称');
  await userEvent.click(screen.getByRole('button', { name: '收起记录' }));
  autoStatus.mockResolvedValue({ ...running, receipts: [] });
  await waitFor(() => expect(autoStatus.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 4000 });
  expect(screen.getByRole('textbox')).toHaveValue('未提交的新名称');
});
