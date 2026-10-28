// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkdiskPage } from '../../src/client/pages/WorkdiskPage.js';

const binding = { id: 'disk-a', rootPath: '/tmp/工作盘', displayName: '工作盘', connectedAt: '2026-10-29T00:00:00Z' };
const file = { path: '2026-09-28/文档/招生.txt', name: '招生.txt', kind: 'document', size: 24, date: '2026-09-28', modifiedAt: '2026-09-28T00:00:00Z' };
const list = vi.fn(), connect = vi.fn(), importFiles = vi.fn(), createNote = vi.fn(), preview = vi.fn(), planner = vi.fn();
const runtime = { api: { workdiskSearchPlan: planner } };
vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => runtime }));
const snapshot = (files: unknown[] = [file]) => ({ binding, files, scannedAt: '2026-10-29T00:00:00Z', truncated: false, skippedCount: 0 });
function mount() { render(<MemoryRouter><WorkdiskPage /></MemoryRouter>); }

beforeEach(() => {
  sessionStorage.clear();
  list.mockResolvedValue(snapshot()); connect.mockResolvedValue(binding);
  importFiles.mockResolvedValue({ files: [file], failures: [] }); createNote.mockResolvedValue(file);
  preview.mockResolvedValue({ kind: 'text', text: '招生说明正文' });
  planner.mockResolvedValue({ ok: true, value: { mode: 'ai', plan: { terms: ['招生'], startDate: '2026-09-28', endDate: '2026-09-28' } } });
  Object.defineProperty(window, 'xiaozhaoDesktop', { configurable: true, value: { workdisk: { list, connect, importFiles, createNote, preview, openFile: vi.fn() } } });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'xiaozhaoDesktop'); vi.resetAllMocks(); });

describe('workdisk page', () => {
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
    expect(importFiles).toHaveBeenCalledWith('2026-10-28');
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
});
