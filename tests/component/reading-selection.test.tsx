import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserReadConsoleApi, type LiveKnowledgeDetail } from '../../src/client/api/client.js';
import type { ConsoleRuntime } from '../../src/client/app/ConsoleRuntime.js';
import type { PageResource } from '../../src/client/pages/pageSupport.js';
import { KnowledgeDetail } from '../../src/client/components/KnowledgeDetail.js';
import { LibraryPage } from '../../src/client/pages/LibraryPage.js';
import { QueueDetail } from '../../src/client/pages/queue/QueueDetail.js';
import { ASSISTANT_INTENT_EVENT } from '../../src/client/components/assistant/assistantIntent.js';

let runtime: ConsoleRuntime;
vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => runtime }));
const sourcePath = '01图书馆/来自个人/实际来源.md';
const knowledgePath = '02知识库/实际知识.md';
const revision = 'a'.repeat(64);
const passage = '解释这段正文，保留原文身份。';
const detail = (path = knowledgePath, markdown = passage): LiveKnowledgeDetail => ({
  path, title: '实际加载的标题', markdown, versionMarker: { rawSha256: revision }, internalKnowledgeLinks: []
});
const record = { path: knowledgePath, title: '列表中的旧标题', sourceMaterials: ['来源元信息'] };
const callbacks = { onClose: vi.fn(), onOpen: vi.fn() };
const queueProps = { materialPath: sourcePath, item: undefined, runId: '', pane: 'original', onPane: vi.fn(), onSelectRun: vi.fn(), onRun: vi.fn(), onChanged: vi.fn() };
function knowledgeView(resource: PageResource<LiveKnowledgeDetail>, current = record) {
  return <MemoryRouter initialEntries={['/knowledge?path=错误的URL.md']}><KnowledgeDetail api={runtime.api} record={current} resource={resource} openState="idle" {...callbacks} /></MemoryRouter>;
}
function select(first: Node, last = first) {
  act(() => {
    const range = document.createRange(); range.setStart(first, 0); range.setEnd(last, last.textContent!.length);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
}
function selectProse() { select(screen.getByText(passage, { selector: 'p' }).firstChild!); }
function intentListener() {
  const listener = vi.fn(); window.addEventListener(ASSISTANT_INTENT_EVENT, listener);
  return { listener, dispose: () => window.removeEventListener(ASSISTANT_INTENT_EVENT, listener) };
}
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  runtime = { dataRevision: 0, refreshHealth: vi.fn(async () => {}), health: { status: 'loading' }, api: {
    ...browserReadConsoleApi,
    learningNotes: { ...browserReadConsoleApi.learningNotes!, list: vi.fn(async () => ({ ok: true as const, value: { notes: [] } })) },
    getDocumentDetail: vi.fn(async (path) => ({ ok: true as const, value: detail(path) })),
    listLibrary: vi.fn(async () => ({ ok: true as const, value: { mode: 'topic' as const, path: '', breadcrumbs: [{ path: '', label: '全部资料' }], folders: [], items: [], total: 0, directTotal: 0, unclassifiedCount: 0, indexVersion: 1 } }))
  } };
});
afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); });

describe('ready reading selections', () => {
  it.each(['library', 'knowledge', 'queue'])('uses the actual loaded %s source and opens only an intent', async (reader) => {
    const capture = intentListener();
    try {
      if (reader === 'library') render(<MemoryRouter initialEntries={[`/library?${new URLSearchParams({ path: sourcePath })}`]}><LibraryPage /></MemoryRouter>);
      if (reader === 'knowledge') render(knowledgeView({ status: 'ready', data: detail() }));
      if (reader === 'queue') render(<MemoryRouter><QueueDetail {...queueProps} /></MemoryRouter>);
      await screen.findByText(passage, { selector: 'p' });
      const before = vi.mocked(runtime.api.getDocumentDetail).mock.calls.length;
      selectProse();
      expect(capture.listener).not.toHaveBeenCalled();
      const action = screen.getByRole('button', { name: '问问这段内容' });
      expect(fireEvent.mouseDown(action)).toBe(false);
      expect(window.getSelection()?.toString()).toBe(passage);
      await userEvent.click(action);
      const path = reader === 'knowledge' ? knowledgePath : sourcePath;
      expect(capture.listener).toHaveBeenCalledOnce();
      expect((capture.listener.mock.calls[0]![0] as CustomEvent).detail).toEqual({
        purpose: 'learning', scope: 'current', contextPath: path,
        prompt: '请用容易理解的话解释这段内容',
        selection: { path, title: '实际加载的标题', revision, text: passage }
      });
      expect(vi.mocked(runtime.api.getDocumentDetail).mock.calls).toHaveLength(before);
      expect(screen.queryByRole('button', { name: '问问这段内容' })).not.toBeInTheDocument();
    } finally { capture.dispose(); }
  });


  it.each(['library', 'knowledge', 'queue'])('opens source-linked notes directly below the %s reader', async (reader) => {
    if (reader === 'library') render(<MemoryRouter initialEntries={[`/library?${new URLSearchParams({ path: sourcePath })}`]}><LibraryPage /></MemoryRouter>);
    if (reader === 'knowledge') render(knowledgeView({ status: 'ready', data: detail() }));
    if (reader === 'queue') render(<MemoryRouter><QueueDetail {...queueProps} /></MemoryRouter>);
    await screen.findByText(passage, { selector: 'p' });
    expect(runtime.api.learningNotes!.list).not.toHaveBeenCalled();
    const trigger = screen.getByRole('button', { name: '学习笔记' });
    expect(screen.getByText(passage, { selector: 'p' }).compareDocumentPosition(trigger)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    select(trigger.lastChild!);
    expect(screen.queryByRole('button', { name: '问问这段内容' })).not.toBeInTheDocument();
    await userEvent.click(trigger);
    expect(runtime.api.learningNotes!.list).toHaveBeenCalledWith({ path: reader === 'knowledge' ? knowledgePath : sourcePath }, expect.any(AbortSignal));
    expect(await screen.findByText('还没有学习笔记。可在回答下选择“保存理解”。')).toBeVisible();
  });

  it('rejects metadata and cross-boundary selection after an accepted prose selection', () => {
    render(knowledgeView({ status: 'ready', data: detail() }));
    selectProse(); expect(screen.getByRole('button', { name: '问问这段内容' })).toBeVisible();
    select(screen.getByText('来源元信息').firstChild!);
    expect(screen.queryByRole('button', { name: '问问这段内容' })).not.toBeInTheDocument();
    select(screen.getByText('来源元信息').firstChild!, screen.getByText(passage, { selector: 'p' }).firstChild!);
    expect(screen.queryByRole('button', { name: '问问这段内容' })).not.toBeInTheDocument();
  });

  it.each(['refreshing', 'failed'] as const)('clears the snapshot and blocks capture from retained %s prose', (status) => {
    const data = detail();
    const view = render(knowledgeView({ status: 'ready', data }));
    selectProse(); expect(screen.getByRole('button', { name: '问问这段内容' })).toBeVisible();
    view.rerender(knowledgeView(status === 'refreshing' ? { status, data } : { status, data, state: { status: 'operation-error', message: '读取失败' } }));
    expect(screen.queryByRole('button', { name: '问问这段内容' })).not.toBeInTheDocument();
    selectProse();
    expect(screen.queryByRole('button', { name: '问问这段内容' })).not.toBeInTheDocument();
    view.rerender(knowledgeView({ status: 'ready', data }));
    expect(screen.queryByRole('button', { name: '问问这段内容' })).not.toBeInTheDocument();
  });

  it.each(['path', 'revision'])('clears an existing selection when the loaded %s changes', (change) => {
    const data = detail();
    const view = render(knowledgeView({ status: 'ready', data }));
    selectProse(); expect(screen.getByRole('button', { name: '问问这段内容' })).toBeVisible();
    const next = change === 'path' ? { ...data, path: '02知识库/其他.md' } : { ...data, versionMarker: { rawSha256: 'b'.repeat(64) } };
    view.rerender(knowledgeView({ status: 'ready', data: next }, { ...record, path: next.path }));
    expect(screen.queryByRole('button', { name: '问问这段内容' })).not.toBeInTheDocument();
    expect(window.getSelection()?.toString()).toBe('');
  });

  it('accepts exactly 6000 Unicode code points without truncating surrogate pairs', async () => {
    const text = '😀'.repeat(6000);
    const capture = intentListener();
    try {
      render(knowledgeView({ status: 'ready', data: detail(knowledgePath, `  ${text}  `) }));
      select(screen.getByText(text, { selector: 'p' }).firstChild!);
      await userEvent.click(screen.getByRole('button', { name: '问问这段内容' }));
      expect((capture.listener.mock.calls[0]![0] as CustomEvent).detail.selection.text).toBe(text);
    } finally { capture.dispose(); }
  });

  it('shows an explicit limit message and never silently truncates an oversized selection', () => {
    const text = '😀'.repeat(6001);
    const capture = intentListener();
    try {
      render(knowledgeView({ status: 'ready', data: detail(knowledgePath, text) }));
      select(screen.getByText(text, { selector: 'p' }).firstChild!);
      expect(screen.getByRole('status')).toHaveTextContent('选中文字超过 6000 字，请缩小选择范围。');
      expect(screen.queryByRole('button', { name: '问问这段内容' })).not.toBeInTheDocument();
      expect(capture.listener).not.toHaveBeenCalled();
    } finally { capture.dispose(); }
  });


  it('blocks a library selection while the displayed source is being reloaded', async () => {
    let finish!: (value: Awaited<ReturnType<typeof runtime.api.getDocumentDetail>>) => void;
    runtime.api.getDocumentDetail = vi.fn().mockResolvedValueOnce({ ok: true, value: detail(sourcePath) })
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<MemoryRouter initialEntries={[`/library?${new URLSearchParams({ path: sourcePath })}`]}><LibraryPage /></MemoryRouter>);
    await screen.findByText(passage, { selector: 'p' }); selectProse();
    expect(screen.getByRole('button', { name: '问问这段内容' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '刷新资料' }));
    expect(screen.queryByRole('button', { name: '问问这段内容' })).not.toBeInTheDocument();
    selectProse(); expect(screen.queryByRole('button', { name: '问问这段内容' })).not.toBeInTheDocument();
    await act(async () => finish({ ok: false, state: { status: 'operation-error', message: '读取失败' } }));
    expect(screen.queryByText(passage, { selector: 'p' })).not.toBeInTheDocument();
  });

  it('clears a queue selection while changing sources and ignores a late response', async () => {
    let finish!: (value: Awaited<ReturnType<typeof runtime.api.getDocumentDetail>>) => void;
    runtime.api.getDocumentDetail = vi.fn().mockResolvedValueOnce({ ok: true, value: detail(sourcePath) })
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<MemoryRouter><QueueDetail {...queueProps} /></MemoryRouter>);
    await screen.findByText(passage, { selector: 'p' }); selectProse();
    expect(screen.getByRole('button', { name: '问问这段内容' })).toBeVisible();
    view.rerender(<MemoryRouter><QueueDetail {...queueProps} materialPath="01图书馆/来自个人/下一份.md" /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: '问问这段内容' })).not.toBeInTheDocument();
    expect(screen.queryByText(passage, { selector: 'p' })).not.toBeInTheDocument();
    await act(async () => finish({ ok: true, value: detail(sourcePath) }));
    expect(await screen.findByText('原文路径不匹配，请重新读取。')).toBeVisible();
    expect(screen.queryByRole('button', { name: '问问这段内容' })).not.toBeInTheDocument();
  });

  it('clears a queue selection when its source pane is hidden', async () => {
    const view = render(<MemoryRouter><QueueDetail {...queueProps} /></MemoryRouter>);
    await screen.findByText(passage, { selector: 'p' }); selectProse();
    expect(screen.getByRole('button', { name: '问问这段内容' })).toBeVisible();
    view.rerender(<MemoryRouter><QueueDetail {...queueProps} pane="result" /></MemoryRouter>);
    selectProse();
    expect(screen.queryByRole('button', { name: '问问这段内容' })).not.toBeInTheDocument();
  });

  it('offers retry and prevents selection after a rejected queue read', async () => {
    runtime.api.getDocumentDetail = vi.fn(async () => { throw new Error('private failure'); });
    render(<MemoryRouter><QueueDetail {...queueProps} /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: '重新读取原文' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('原资料暂时无法读取，已保存结果仍可查看。');
    expect(screen.queryByRole('button', { name: '问问这段内容' })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('private failure');
  });

  it('clears an action after collapsing the selection', () => {
    render(knowledgeView({ status: 'ready', data: detail() }));
    selectProse(); expect(screen.getByRole('button', { name: '问问这段内容' })).toBeVisible();
    act(() => { window.getSelection()?.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
    expect(screen.queryByRole('button', { name: '问问这段内容' })).not.toBeInTheDocument();
  });
});
