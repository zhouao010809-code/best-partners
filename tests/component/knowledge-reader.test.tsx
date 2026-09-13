import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { browserReadConsoleApi, type ApiClientResult, type LiveKnowledgeDetail, type ReadConsoleApi } from '../../src/client/api/client.js';
import type { ConsoleRuntime } from '../../src/client/app/ConsoleRuntime.js';
import { KnowledgeDetail } from '../../src/client/components/KnowledgeDetail.js';
import { KnowledgeReader, type KnowledgeReaderProps } from '../../src/client/components/knowledge/KnowledgeReader.js';
import type { KnowledgeRecord } from '../../src/shared/domain/records.js';

afterEach(cleanup);

it('offers the unified recycle workspace when a known knowledge note is in trash', async () => {
  const record = knowledge();
  renderReader({ path: record.path, onClose: () => {} }, readerApi({ getKnowledgeDetail: vi.fn(async () => ({ ok: false as const, code: 'KNOWLEDGE_IN_TRASH', state: { status: 'operation-error' as const, message: '这篇知识已移入回收站，可在回收站恢复。' } })) }));
  expect(await screen.findByText('这篇知识已移入回收站，可在回收站恢复。')).toBeVisible();
  expect(screen.getByRole('link', { name: '前往知识回收站' })).toHaveAttribute('href', '/trash?origin=knowledge');
});

function knowledge(overrides: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
  return {
    path: '02知识库/01AI/基础/工作流.md', rawSha256: 'a'.repeat(64), title: '工作流知识',
    sourceType: 'AI提炼', usageStatus: 'AI总结', knowledgeType: '方法',
    recallFields: { topics: ['AI'], keywords: ['工作流'], scenarios: ['规划任务'], conclusion: '核心结论', keyPoints: ['反馈'], boundary: '确定任务' },
    sourceMaterials: ['01图书馆/来自微信/来源材料.md'],
    ...overrides
  };
}

function detail(record = knowledge(), markdown = '完整知识正文'): LiveKnowledgeDetail {
  return {
    record, path: record.path, title: record.title, markdown,
    internalKnowledgeLinks: [{ path: '02知识库/关联.md', title: '关联知识' }],
    versionMarker: { rawSha256: record.rawSha256, ...(record.upstreamVersion === undefined ? {} : { upstreamVersion: record.upstreamVersion }) }
  };
}

function ok<T>(value: T): ApiClientResult<T> { return { ok: true, value }; }

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function readerApi(overrides: Partial<ReadConsoleApi> = {}): ReadConsoleApi {
  return {
    ...browserReadConsoleApi,
    getKnowledgeDetail: vi.fn(async () => ok(detail())),
    openKnowledge: vi.fn(async (path) => ok({ path, opened: true as const })),
    ...overrides
  };
}

function renderReader(props: KnowledgeReaderProps, api = readerApi()) {
  function tree(current: KnowledgeReaderProps, dataRevision: number) {
    const runtime: ConsoleRuntime = { api, health: { status: 'loading' }, dataRevision, refreshHealth: async () => undefined };
    return <MemoryRouter><Routes><Route element={<Outlet context={runtime} />}><Route path="*" element={<KnowledgeReader {...current} />} /></Route></Routes></MemoryRouter>;
  }
  const rendered = render(tree(props, 0));
  return { ...rendered, rerenderReader: (next: KnowledgeReaderProps, revision = 0) => rendered.rerender(tree(next, revision)) };
}

describe('KnowledgeDetail presentation', () => {
  it('puts inline body before collapsed provenance and provides a visible paper close action', async () => {
    const user = userEvent.setup();
    const record = knowledge();
    const onClose = vi.fn();
    render(<MemoryRouter><KnowledgeDetail record={record} resource={{ status: 'ready', data: detail(record) }} openState="idle" onClose={onClose} onOpen={vi.fn()} presentation="inline" /></MemoryRouter>);

    expect(screen.getByText('完整知识正文')).toBeVisible();
    expect(screen.getByText('方法 · AI总结')).toBeVisible();
    expect(screen.getByText('方法 · AI总结')).toHaveClass('knowledge-detail__inline-meta');
    const close = screen.getByRole('button', { name: '收回纸页' });
    expect(within(close).getByText('收回纸页')).toBeVisible();
    const disclosure = screen.getByText('来源与关联知识').closest('details');
    expect(disclosure).not.toHaveAttribute('open');
    expect(screen.getByText('完整知识正文').compareDocumentPosition(disclosure!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await user.click(screen.getByText('来源与关联知识'));
    expect(screen.getByRole('link', { name: '查看原文 · 来源材料' })).toHaveAttribute('href', `/library?${new URLSearchParams({ path: record.sourceMaterials[0]! })}`);
    expect(screen.getByRole('link', { name: '关联知识' })).toHaveAttribute('href', `/knowledge?${new URLSearchParams({ path: '02知识库/关联.md' })}`);
    await user.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the default panel presentation and its existing close label', () => {
    const record = knowledge();
    render(<MemoryRouter><KnowledgeDetail record={record} resource={{ status: 'ready', data: detail(record) }} openState="idle" onClose={vi.fn()} onOpen={vi.fn()} /></MemoryRouter>);
    const panel = screen.getByRole('dialog', { name: '工作流知识 详情' });
    expect(within(panel).getByRole('button', { name: '关闭知识详情' })).toBeVisible();
    expect(within(panel).getByRole('link', { name: '查看原文 · 来源材料' })).toBeVisible();
    expect(within(panel).getByRole('link', { name: '关联知识' })).toBeVisible();
  });
});

describe('KnowledgeReader', () => {
  it('reads the exact deep-link path and reports the validated response record', async () => {
    const record = knowledge({ path: '02知识库/01AI/基础/50% #方法.md' });
    const onLoaded = vi.fn();
    const api = readerApi({ getKnowledgeDetail: vi.fn(async () => ok(detail(record, '深链正文'))) });
    renderReader({ path: record.path, onClose: vi.fn(), onLoaded }, api);
    expect(await screen.findByText('深链正文')).toBeVisible();
    expect(screen.getByRole('region', { name: `${record.title} 阅读` })).toHaveClass('knowledge-detail--inline');
    expect(api.getKnowledgeDetail).toHaveBeenCalledExactlyOnceWith(record.path, expect.any(AbortSignal));
    expect(onLoaded).toHaveBeenCalledExactlyOnceWith(record);
    expect(api.openKnowledge).not.toHaveBeenCalled();
  });

  it('supports a validated indexed record when an older detail response omits record', async () => {
    const record = knowledge({ upstreamVersion: 'v1' });
    const { record: _record, ...response } = detail(record);
    const onLoaded = vi.fn();
    renderReader({ path: record.path, record, onClose: vi.fn(), onLoaded }, readerApi({ getKnowledgeDetail: vi.fn(async () => ok(response)) }));
    expect(await screen.findByText('完整知识正文')).toBeVisible();
    expect(onLoaded).toHaveBeenCalledExactlyOnceWith(record);
  });

  it('omits undefined transport fields from the loaded domain record', async () => {
    const record = knowledge();
    const response = detail(record);
    response.record = { ...record, upstreamVersion: undefined, createdAt: undefined, updatedAt: undefined };
    const onLoaded = vi.fn();
    renderReader({ path: record.path, onClose: vi.fn(), onLoaded }, readerApi({ getKnowledgeDetail: vi.fn(async () => ok(response)) }));
    expect(await screen.findByText('完整知识正文')).toBeVisible();
    const loaded = onLoaded.mock.calls[0]![0];
    expect(loaded).not.toHaveProperty('upstreamVersion');
    expect(loaded).not.toHaveProperty('createdAt');
    expect(loaded).not.toHaveProperty('updatedAt');
  });

  it.each(['path', 'title', 'rawSha256', 'upstreamVersion'] as const)('rejects indexed detail with a mismatched %s', async (field) => {
    const record = knowledge({ upstreamVersion: 'v1' });
    const response = detail(record, '不可信正文');
    if (field === 'path') response.path = '02知识库/别篇.md';
    if (field === 'title') response.title = '别篇标题';
    if (field === 'rawSha256') response.versionMarker.rawSha256 = 'b'.repeat(64);
    if (field === 'upstreamVersion') response.versionMarker.upstreamVersion = 'v2';
    const onLoaded = vi.fn();
    renderReader({ path: record.path, record, onClose: vi.fn(), onLoaded }, readerApi({ getKnowledgeDetail: vi.fn(async () => ok(response)) }));
    expect(await screen.findByRole('alert')).toHaveTextContent('知识版本与列表不一致');
    expect(screen.queryByText('不可信正文')).not.toBeInTheDocument();
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it.each(['missing', 'path', 'title', 'rawSha256', 'upstreamVersion', 'malformed'] as const)('rejects a %s response record without an indexed record', async (field) => {
    const record = knowledge({ upstreamVersion: 'v1' });
    const response = detail(record, '不可信正文');
    if (field === 'missing') delete response.record;
    else if (field === 'path') response.record!.path = '02知识库/别篇.md';
    else if (field === 'title') response.record!.title = '别篇标题';
    else if (field === 'rawSha256') response.record!.rawSha256 = 'b'.repeat(64);
    else if (field === 'upstreamVersion') response.record!.upstreamVersion = 'v2';
    else response.record!.rawSha256 = '';
    const onLoaded = vi.fn();
    renderReader({ path: '02知识库/01AI/基础/工作流.md', onClose: vi.fn(), onLoaded }, readerApi({ getKnowledgeDetail: vi.fn(async () => ok(response)) }));
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.queryByText('不可信正文')).not.toBeInTheDocument();
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it.each(['response', 'rejection'] as const)('offers a safe retry after an API %s failure', async (kind) => {
    const user = userEvent.setup();
    const getKnowledgeDetail = vi.fn<ReadConsoleApi['getKnowledgeDetail']>();
    if (kind === 'response') getKnowledgeDetail.mockResolvedValueOnce({ ok: false, state: { status: 'operation-error', message: 'SECRET_SERVER_MESSAGE' } });
    else getKnowledgeDetail.mockRejectedValueOnce(new Error('SECRET_SERVER_MESSAGE'));
    getKnowledgeDetail.mockResolvedValueOnce(ok(detail()));
    renderReader({ path: knowledge().path, onClose: vi.fn() }, readerApi({ getKnowledgeDetail }));
    expect(await screen.findByRole('alert')).toHaveTextContent('读取知识未完成，请稍后重试');
    expect(document.body).not.toHaveTextContent('SECRET_SERVER_MESSAGE');
    await user.click(screen.getByRole('button', { name: '重新读取这篇知识' }));
    expect(await screen.findByText('完整知识正文')).toBeVisible();
  });

  it('aborts a previous path and ignores its late reply and callback', async () => {
    const oldRecord = knowledge();
    const nextRecord = knowledge({ path: '02知识库/下一篇.md', title: '下一篇知识' });
    const oldReply = deferred<ApiClientResult<LiveKnowledgeDetail>>();
    const onLoaded = vi.fn();
    const getKnowledgeDetail = vi.fn<ReadConsoleApi['getKnowledgeDetail']>().mockReturnValueOnce(oldReply.promise).mockResolvedValueOnce(ok(detail(nextRecord, '下一篇正文')));
    const props = { path: oldRecord.path, onClose: vi.fn(), onLoaded };
    const view = renderReader(props, readerApi({ getKnowledgeDetail }));
    const oldSignal = getKnowledgeDetail.mock.calls[0]![1]!;
    view.rerenderReader({ ...props, path: nextRecord.path });
    expect(oldSignal.aborted).toBe(true);
    expect(await screen.findByText('下一篇正文')).toBeVisible();
    await act(async () => oldReply.resolve(ok(detail(oldRecord, '过期正文'))));
    expect(screen.queryByText('过期正文')).not.toBeInTheDocument();
    expect(onLoaded).toHaveBeenCalledExactlyOnceWith(nextRecord);
  });

  it('removes the previous body while another path is still loading', async () => {
    const nextReply = deferred<ApiClientResult<LiveKnowledgeDetail>>();
    const getKnowledgeDetail = vi.fn<ReadConsoleApi['getKnowledgeDetail']>().mockResolvedValueOnce(ok(detail())).mockReturnValueOnce(nextReply.promise);
    const props = { path: knowledge().path, onClose: vi.fn() };
    const view = renderReader(props, readerApi({ getKnowledgeDetail }));
    expect(await screen.findByText('完整知识正文')).toBeVisible();
    view.rerenderReader({ ...props, path: '02知识库/下一篇.md' });
    expect(screen.queryByText('完整知识正文')).not.toBeInTheDocument();
    expect(screen.getByText('正在读取当前版本正文')).toBeVisible();
  });

  it('rereads when dataRevision changes and ignores an earlier reply for the same path', async () => {
    const oldReply = deferred<ApiClientResult<LiveKnowledgeDetail>>();
    const fresh = knowledge({ rawSha256: 'b'.repeat(64) });
    const onLoaded = vi.fn();
    const getKnowledgeDetail = vi.fn<ReadConsoleApi['getKnowledgeDetail']>().mockReturnValueOnce(oldReply.promise).mockResolvedValueOnce(ok(detail(fresh, '更新正文')));
    const props = { path: knowledge().path, onClose: vi.fn(), onLoaded };
    const view = renderReader(props, readerApi({ getKnowledgeDetail }));
    const oldSignal = getKnowledgeDetail.mock.calls[0]![1]!;
    view.rerenderReader(props, 1);
    expect(oldSignal.aborted).toBe(true);
    expect(await screen.findByText('更新正文')).toBeVisible();
    await act(async () => oldReply.resolve(ok(detail(knowledge(), '过期正文'))));
    expect(screen.queryByText('过期正文')).not.toBeInTheDocument();
    expect(onLoaded).toHaveBeenCalledExactlyOnceWith(fresh);
  });

  it('uses the latest callback without rereading identical record values', async () => {
    const pending = deferred<ApiClientResult<LiveKnowledgeDetail>>();
    const getKnowledgeDetail = vi.fn(() => pending.promise);
    const oldCallback = vi.fn();
    const nextCallback = vi.fn();
    const record = knowledge();
    const props = { path: record.path, record, onClose: vi.fn(), onLoaded: oldCallback };
    const view = renderReader(props, readerApi({ getKnowledgeDetail }));
    view.rerenderReader({ ...props, record: { ...record }, onLoaded: nextCallback });
    await act(async () => pending.resolve(ok(detail(record))));
    expect(getKnowledgeDetail).toHaveBeenCalledTimes(1);
    expect(oldCallback).not.toHaveBeenCalled();
    expect(nextCallback).toHaveBeenCalledExactlyOnceWith(record);
  });

  it('aborts on unmount and never reports a late loaded record', async () => {
    const pending = deferred<ApiClientResult<LiveKnowledgeDetail>>();
    const getKnowledgeDetail = vi.fn<ReadConsoleApi['getKnowledgeDetail']>(() => pending.promise);
    const onLoaded = vi.fn();
    const view = renderReader({ path: knowledge().path, onClose: vi.fn(), onLoaded }, readerApi({ getKnowledgeDetail }));
    const signal = getKnowledgeDetail.mock.calls[0]![1]!;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(ok(detail())));
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it('calls close once for Escape and invalidates a pending read immediately', async () => {
    const pending = deferred<ApiClientResult<LiveKnowledgeDetail>>();
    const getKnowledgeDetail = vi.fn<ReadConsoleApi['getKnowledgeDetail']>(() => pending.promise);
    const onClose = vi.fn();
    const onLoaded = vi.fn();
    renderReader({ path: knowledge().path, onClose, onLoaded }, readerApi({ getKnowledgeDetail }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(getKnowledgeDetail.mock.calls[0]![1]!.aborted).toBe(true);
    await act(async () => pending.resolve(ok(detail())));
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it('opens Obsidian only after an explicit click and suppresses late open status after navigation', async () => {
    const user = userEvent.setup();
    const pending = deferred<Awaited<ReturnType<ReadConsoleApi['openKnowledge']>>>();
    const next = knowledge({ path: '02知识库/下一篇.md', title: '下一篇知识' });
    const openKnowledge = vi.fn(() => pending.promise);
    const getKnowledgeDetail = vi.fn<ReadConsoleApi['getKnowledgeDetail']>().mockResolvedValueOnce(ok(detail())).mockResolvedValueOnce(ok(detail(next, '下一篇正文')));
    const props = { path: knowledge().path, onClose: vi.fn() };
    const view = renderReader(props, readerApi({ getKnowledgeDetail, openKnowledge }));
    expect(await screen.findByText('完整知识正文')).toBeVisible();
    expect(openKnowledge).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '在 Obsidian 中打开' }));
    expect(openKnowledge).toHaveBeenCalledExactlyOnceWith(props.path);
    expect(screen.getByRole('button', { name: '正在打开' })).toBeDisabled();
    view.rerenderReader({ ...props, path: next.path });
    expect(await screen.findByText('下一篇正文')).toBeVisible();
    await act(async () => pending.resolve(ok({ path: props.path, opened: true })));
    expect(screen.queryByText('已在 Obsidian 中打开')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: '在 Obsidian 中打开' })).toBeEnabled());
  });
});
