// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkdiskPage } from '../../src/client/pages/WorkdiskPage.js';

const binding = { id: 'disk-a', rootPath: '/tmp/工作盘', displayName: '工作盘', connectedAt: '2026-10-29T00:00:00Z' };
const file = { path: '2026-09-28/文档/招生.txt', name: '招生.txt', kind: 'document', size: 24, date: '2026-09-28', modifiedAt: '2026-09-28T00:00:00Z' };
const list = vi.fn(), status = vi.fn(), connect = vi.fn(), importFiles = vi.fn(), importDroppedFiles = vi.fn(), createNote = vi.fn(), preview = vi.fn(), planner = vi.fn();
const runtime = { api: { workdiskSearchPlan: planner } };
vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => runtime }));
const snapshot = (files: unknown[] = [file]) => ({ binding, files, scannedAt: '2026-10-29T00:00:00Z', truncated: false, skippedCount: 0 });
function mount() { render(<MemoryRouter><WorkdiskPage /></MemoryRouter>); }

beforeEach(() => {
  sessionStorage.clear();
  list.mockResolvedValue(snapshot()); status.mockResolvedValue(binding); connect.mockResolvedValue(binding);
  importFiles.mockResolvedValue({ files: [file], failures: [] }); createNote.mockResolvedValue(file);
  importDroppedFiles.mockResolvedValue({ files: [file], failures: [] });
  preview.mockResolvedValue({ kind: 'text', text: '招生说明正文' });
  planner.mockResolvedValue({ ok: true, value: { mode: 'ai', plan: { terms: ['招生'], startDate: '2026-09-28', endDate: '2026-09-28' } } });
  Object.defineProperty(window, 'xiaozhaoDesktop', { configurable: true, value: { workdisk: { status, list, connect, importFiles, importDroppedFiles, createNote, preview, openFile: vi.fn() } } });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'xiaozhaoDesktop'); vi.useRealTimers(); vi.resetAllMocks(); });

describe('workdisk page', () => {
  it('updates the default date at midnight without a focus event', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(2026, 9, 31, 23, 59, 59));
    await act(async () => mount());
    expect(screen.getByLabelText('收纳日期')).toHaveValue('2026-10-31');
    await act(async () => vi.advanceTimersByTime(1500));
    expect(screen.getByLabelText('收纳日期')).toHaveValue('2026-11-01');
  });
  it('follows today after waking on a later day and submits the current date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 31, 23, 59));
    mount(); await screen.findByRole('button', { name: /预览 招生.txt/u });
    expect(screen.getByLabelText('收纳日期')).toHaveValue('2026-10-31');
    vi.setSystemTime(new Date(2026, 10, 3, 9));
    fireEvent.focus(window);
    expect(screen.getByLabelText('收纳日期')).toHaveValue('2026-11-03');
    await userEvent.click(screen.getByRole('button', { name: '收文件' }));
    expect(importFiles).toHaveBeenCalledWith('2026-11-03', { nameFromContent: true });
  });
  it('preserves a deliberately selected date across days until switched back to today', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 31, 23, 59));
    mount(); await screen.findByRole('button', { name: /预览 招生.txt/u });
    fireEvent.change(screen.getByLabelText('收纳日期'), { target: { value: '2026-10-28' } });
    vi.setSystemTime(new Date(2026, 10, 3, 9)); fireEvent.focus(window);
    expect(screen.getByLabelText('收纳日期')).toHaveValue('2026-10-28');
    await userEvent.click(screen.getByRole('button', { name: '改回今天' }));
    expect(screen.getByLabelText('收纳日期')).toHaveValue('2026-11-03');
  });
  it('uses the submission date when a default-date import crosses midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 31, 23, 59));
    let finish!: (value: unknown) => void;
    importFiles.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    mount(); await screen.findByRole('button', { name: /预览 招生.txt/u });
    await userEvent.click(screen.getByRole('button', { name: '收文件' }));
    vi.setSystemTime(new Date(2026, 10, 1, 0, 1)); fireEvent.focus(window);
    await act(async () => finish({ files: [file], failures: [] }));
    expect(importFiles).toHaveBeenCalledWith('2026-10-31', { nameFromContent: true });
    expect(screen.getByText('已收好 1 个文件 · 2026-10-31')).toBeVisible();
    expect(screen.getByLabelText('收纳日期')).toHaveValue('2026-11-01');
  });
  it('keeps the remembered folder and recovery controls visible when the initial scan is unavailable', async () => {
    list.mockRejectedValue(new Error('工作盘暂时未连接'));
    Object.assign(window.xiaozhaoDesktop!.workdisk!, {
      autoStatus: vi.fn().mockResolvedValue({ source: { rootPath: '/tmp/downloads', displayName: '下载' }, enabled: true, nameFromContent: true, phase: 'waiting', pendingCount: 0, receipts: [] }),
      chooseAutoSource: vi.fn(), setAutoEnabled: vi.fn(), setAutoNaming: vi.fn()
    });
    mount();
    expect(await screen.findByText(binding.rootPath)).toBeVisible();
    expect(screen.getByRole('button', { name: '重新连接' })).toBeVisible();
    expect(screen.getByText('暂时未连接')).toBeVisible();
    expect(screen.getByRole('region', { name: '自动收纳' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '连接本地文件夹' })).not.toBeInTheDocument();
    expect(document.querySelector('.workdisk-online')).toBeNull();
    list.mockResolvedValue(snapshot());
    await userEvent.click(screen.getByRole('button', { name: '重试读取' }));
    expect(await screen.findByRole('button', { name: /预览 招生.txt/u })).toBeVisible();
    expect(screen.queryByText('暂时未连接')).not.toBeInTheDocument();
  });
  it('removes an old import success notice and naming result when the disk becomes unavailable', async () => {
    importFiles.mockResolvedValue({ files: [file], failures: [], naming: [{ originalName: '001.txt', savedName: file.name, status: 'renamed', reason: '根据正文命名' }] });
    mount(); await userEvent.click(await screen.findByRole('button', { name: '收文件' }));
    expect(await screen.findByText(/已收好 1 个文件/u)).toBeVisible();
    expect(screen.getByRole('region', { name: '本次收纳命名结果' })).toBeVisible();
    list.mockRejectedValue(new Error('工作盘暂时未连接')); fireEvent.focus(window);
    await screen.findByText('工作盘暂时未连接');
    expect(screen.queryByText(/已收好 1 个文件/u)).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '本次收纳命名结果' })).not.toBeInTheDocument();
  });
  it('connects an ordinary folder and shows existing local files with separate knowledge entry', async () => {
    list.mockResolvedValueOnce({ ...snapshot([]), binding: null }); mount();
    await userEvent.click(await screen.findByRole('button', { name: '连接本地文件夹' }));
    expect(connect).toHaveBeenCalledOnce();
    expect(await screen.findByRole('button', { name: /预览 招生.txt/u })).toBeVisible();
    expect(screen.getByRole('link', { name: /知识库/u })).toHaveAttribute('href', '/knowledge');
  });
  it('imports into the chosen date and reports partial failures', async () => {
    importFiles.mockResolvedValue({ files: [file], failures: [{ name: '打不开.mp4', message: '文件不可读' }] }); mount();
    await screen.findByRole('button', { name: /预览 招生.txt/u });
    fireEvent.change(screen.getByLabelText('收纳日期'), { target: { value: '2026-10-28' } });
    await userEvent.click(screen.getByRole('button', { name: '收文件' }));
    expect(importFiles).toHaveBeenCalledWith('2026-10-28', { nameFromContent: true });
    expect(await screen.findByText(/打不开.mp4/u)).toBeVisible();
  });
  it('searches across dates with a query plan and opens actual content', async () => {
    mount(); await screen.findByRole('button', { name: /预览 招生.txt/u });
    await userEvent.type(screen.getByRole('searchbox', { name: '描述要找的文件' }), '上个月28号的招生文案');
    await userEvent.click(screen.getByRole('button', { name: '找文件' }));
    await waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({ query: '上个月28号的招生文案', plan: expect.objectContaining({ terms: ['招生'] }) })));
    await userEvent.click(await screen.findByRole('button', { name: /预览 招生.txt/u }));
    expect(await screen.findByText('招生说明正文')).toBeVisible();
    expect(preview).toHaveBeenCalledWith(file.path);
  });
  it('keeps the note draft on failed save and clears it only after success', async () => {
    createNote.mockRejectedValueOnce(new Error('保存位置不可用')); mount();
    await userEvent.click(await screen.findByRole('button', { name: '写文案' }));
    await userEvent.type(screen.getByLabelText('文案标题'), '今日招生');
    await userEvent.type(screen.getByLabelText('文案正文'), '这是需要保存的内容');
    await userEvent.click(screen.getByRole('button', { name: '保存到工作盘' }));
    expect(await screen.findByText('保存位置不可用')).toBeVisible();
    expect(screen.getByLabelText('文案正文')).toHaveValue('这是需要保存的内容');
    await userEvent.click(screen.getByRole('button', { name: '保存到工作盘' }));
    await waitFor(() => expect(screen.queryByLabelText('文案正文')).not.toBeInTheDocument());
    expect(createNote).toHaveBeenLastCalledWith(expect.objectContaining({ title: '今日招生', body: '这是需要保存的内容' }));
  });
  it('does not pretend files are available without the desktop bridge', async () => {
    Reflect.deleteProperty(window, 'xiaozhaoDesktop'); mount();
    expect(await screen.findByText(/请在桌面应用中打开工作盘/u)).toBeVisible();
    expect(list).not.toHaveBeenCalled();
  });
  it('removes old folder files immediately when a newly connected folder cannot be scanned', async () => {
    mount(); await screen.findByRole('button', { name: /预览 招生.txt/u });
    connect.mockResolvedValue({ ...binding, id: 'disk-b', displayName: '新工作盘', rootPath: '/tmp/新工作盘' });
    list.mockRejectedValue(new Error('文件夹暂时不可读'));
    await userEvent.click(screen.getByRole('button', { name: '更换' }));
    expect(await screen.findByText('文件夹暂时不可读')).toBeVisible();
    expect(screen.queryByRole('button', { name: /预览 招生.txt/u })).not.toBeInTheDocument();
    expect(screen.getByText('新工作盘')).toBeVisible();
  });
  it('shows incomplete content search warnings even when the initial inventory was complete', async () => {
    mount(); await screen.findByRole('button', { name: /预览 招生.txt/u });
    list.mockResolvedValue({ ...snapshot([]), skippedCount: 3 });
    await userEvent.type(screen.getByRole('searchbox'), '招生');
    await userEvent.click(screen.getByRole('button', { name: '找文件' }));
    expect(await screen.findByText(/有 3 项未完整读取/u)).toBeVisible();
  });
  it('does not strand an in-flight search when the window regains focus', async () => {
    let finish!: (value: unknown) => void;
    planner.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    mount(); await screen.findByRole('button', { name: /预览 招生.txt/u });
    await userEvent.type(screen.getByRole('searchbox'), '招生');
    await userEvent.click(screen.getByRole('button', { name: '找文件' }));
    fireEvent.focus(window);
    await act(async () => finish({ ok: true, value: { mode: 'local', plan: { terms: ['招生'] } } }));
    expect(await screen.findByRole('button', { name: '退出搜索' })).toBeVisible();
    expect(screen.getByRole('button', { name: '找文件' })).toBeEnabled();
  });
  it('explains content naming before import and permits keeping the original name', async () => {
    mount(); await screen.findByRole('button', { name: /预览 招生.txt/u });
    expect(screen.getByRole('checkbox', { name: '根据内容命名' })).toBeChecked();
    expect(screen.getByText('文字与图片识别结果交给已连接的 AI 起名，原件保留。')).toBeVisible();
    await userEvent.click(screen.getByText('命名说明', { exact: true }));
    expect(screen.getByText(/可读正文会发送给已连接的 AI/u)).toBeVisible();
    await userEvent.click(screen.getByRole('checkbox', { name: '根据内容命名' }));
    await userEvent.click(screen.getByRole('button', { name: '收文件' }));
    expect(importFiles).toHaveBeenCalledWith(expect.any(String), { nameFromContent: false });
  });
  it('shows original and actual saved names, including reasons for retaining an unsupported file', async () => {
    importFiles.mockResolvedValue({ files: [file], failures: [], naming: [
      { originalName: '83927.pdf', savedName: '短视频获客的选题方法.pdf', status: 'renamed', reason: '根据可读正文概括命名。' },
      { originalName: '777.png', savedName: '777.png', status: 'kept', reason: '图片暂不支持读取正文命名。' }
    ] });
    mount(); await userEvent.click(await screen.findByRole('button', { name: '收文件' }));
    expect(await screen.findByRole('region', { name: '本次收纳命名结果' })).toHaveTextContent('83927.pdf');
    expect(screen.getByRole('region', { name: '本次收纳命名结果' })).toHaveTextContent('短视频获客的选题方法.pdf');
    expect(screen.getByRole('region', { name: '本次收纳命名结果' })).toHaveTextContent('图片暂不支持读取正文命名。');
  });
  it('passes the content naming option on drop and explains the pending work', async () => {
    let finish!: (value: unknown) => void;
    importDroppedFiles.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    mount(); await screen.findByRole('button', { name: /预览 招生.txt/u });
    const article = new File(['短视频需要有具体主题和可验证的内容。'], '83927.txt', { type: 'text/plain' });
    fireEvent.drop(screen.getByRole('navigation', { name: '资料空间' }).parentElement!, { dataTransfer: { files: [article], types: ['Files'] } });
    expect(importDroppedFiles).toHaveBeenCalledWith([article], expect.any(String), { nameFromContent: true });
    expect(screen.getByRole('checkbox', { name: '根据内容命名' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('正在读取正文、生成名称并保存');
    await act(async () => finish({ files: [file], failures: [] }));
    expect(screen.getByRole('checkbox', { name: '根据内容命名' })).toBeEnabled();
  });
  it('defers background collection refresh until an active search finishes', async () => {
    let finish!: (value: unknown) => void;
    planner.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const receipts = [{ id: 'receipt', sourceName: '001.txt', savedName: file.name, path: file.path, status: 'saved', reason: '', receivedAt: file.modifiedAt }];
    Object.assign(window.xiaozhaoDesktop!.workdisk!, {
      autoStatus: vi.fn().mockResolvedValue({ source: null, enabled: false, nameFromContent: true, phase: 'off', pendingCount: 0, receipts: [] }),
      chooseAutoSource: vi.fn().mockResolvedValue({ source: { rootPath: '/tmp/downloads', displayName: '下载' }, enabled: true, nameFromContent: true, phase: 'watching', pendingCount: 0, receipts }),
      setAutoEnabled: vi.fn(), setAutoNaming: vi.fn()
    });
    mount(); await screen.findByRole('button', { name: /预览 招生.txt/u });
    await userEvent.type(screen.getByRole('searchbox'), '招生');
    await userEvent.click(screen.getByRole('button', { name: '找文件' }));
    await userEvent.click(screen.getByRole('button', { name: '开启自动收纳' }));
    await act(async () => finish({ ok: true, value: { mode: 'local', plan: { terms: ['招生'] } } }));
    expect(await screen.findByRole('button', { name: '退出搜索' })).toBeVisible();
    expect(screen.getByRole('button', { name: '找文件' })).toBeEnabled();
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ query: '招生' }));
  });
});
