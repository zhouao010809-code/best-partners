import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LearningNotes, SaveLearningNote, type LearningNoteDraftCache } from '../../src/client/components/learning/LearningNotes.js';
import type { ReadConsoleApi } from '../../src/client/api/client.js';
import type { LearningNote, LearningNoteQuery } from '../../src/shared/api/learning-notes.js';

const selection = { path: '01图书馆/文章.md', title: '文章标题', revision: 'a'.repeat(64), text: '当时选择的原文' };
const conversationId = '11111111-1111-4111-8111-111111111111';
const messageId = '22222222-2222-4222-8222-222222222222';
const note: LearningNote = { id: '33333333-3333-4333-8333-333333333333', title: '理解标题', body: '自己的理解正文', selection, conversationId, messageId, revision: 1, createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z' };
afterEach(cleanup);
function fixture() {
  const save = vi.fn(async (id, input) => ({ ok: true as const, value: { note: { ...note, ...input, id, revision: input.expectedRevision + 1 } } }));
  const list = vi.fn(async (_query: LearningNoteQuery, _signal?: AbortSignal) => ({ ok: true as const, value: { notes: [note] } }));
  const getDocumentDetail = vi.fn(async (_path: string, _signal?: AbortSignal) => ({ ok: false as const, code: 'DOCUMENT_NOT_FOUND', state: { status: 'operation-error' as const } }));
  const getKnowledgeDetail = vi.fn(async (_path: string, _signal?: AbortSignal) => ({ ok: false as const, code: 'KNOWLEDGE_NOT_FOUND', state: { status: 'operation-error' as const } }));
  const api = { learningNotes: { save, list }, getDocumentDetail, getKnowledgeDetail } as unknown as ReadConsoleApi;
  return { api, save, list, getDocumentDetail, getKnowledgeDetail };
}
it('opens an editable confirmation and retains edits, id and revision on failed save/retry', async () => {
  const { api, save } = fixture(); save.mockResolvedValueOnce({ ok: false, state: { status: 'disconnected', message: '连接已断开' } } as never);
  render(<SaveLearningNote api={api} selection={selection} conversationId={conversationId} messageId={messageId} initialBody="AI 回答正文" />);
  expect(save).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: '保存理解' }));
  expect(screen.getByLabelText('笔记正文')).toHaveValue('AI 回答正文');
  fireEvent.change(screen.getByLabelText('笔记标题'), { target: { value: '我确认的标题' } });
  fireEvent.change(screen.getByLabelText('笔记正文'), { target: { value: '我重新整理的理解' } });
  fireEvent.click(screen.getByRole('button', { name: '确认保存笔记' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('连接已断开');
  expect(screen.getByLabelText('笔记正文')).toHaveValue('我重新整理的理解');
  fireEvent.click(screen.getByRole('button', { name: '确认保存笔记' }));
  expect(await screen.findByText('已保存为学习笔记')).toBeInTheDocument();
  expect(save).toHaveBeenCalledTimes(2); expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
  expect(save.mock.calls[0]?.[1]).toMatchObject({ title: '我确认的标题', body: '我重新整理的理解', expectedRevision: 0, selection, conversationId, messageId });
});
it('retains unfinished text and its original source when new props arrive', async () => {
  const { api, save } = fixture(); const props = { api, selection, conversationId, messageId, initialBody: '旧回答' };
  const view = render(<SaveLearningNote {...props} />); fireEvent.click(screen.getByRole('button', { name: '保存理解' }));
  fireEvent.change(screen.getByLabelText('笔记正文'), { target: { value: '正在编辑的想法' } });
  view.rerender(<SaveLearningNote {...props} selection={{ ...selection, path: '01图书馆/另一篇.md', text: '新选文' }} initialBody="新回答" />);
  expect(screen.getByLabelText('笔记正文')).toHaveValue('正在编辑的想法'); expect(screen.getByText(/保留原来的出处/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '确认保存笔记' })); await waitFor(() => expect(save).toHaveBeenCalled()); expect(save.mock.calls[0]?.[1].selection).toEqual(selection);
});
it('loads only the requested scope on expansion, preserves snapshots when source is missing, and edits without losing conflict input', async () => {
  const { api, save, list, getDocumentDetail } = fixture(); save.mockResolvedValueOnce({ ok: false, code: 'LEARNING_NOTE_CONFLICT', state: { status: 'conflict', message: '笔记已在其他窗口更新' } } as never);
  render(<LearningNotes api={api} conversationId={conversationId} />); expect(list).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '学习笔记' })); await screen.findByRole('button', { name: '理解标题' });
  expect(list.mock.calls[0]?.[0]).toEqual({ conversationId }); expect(getDocumentDetail).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '理解标题' }));
  expect(await screen.findByText(/来源暂不可读取/)).toBeInTheDocument(); expect(screen.getByText(selection.text)).toBeInTheDocument();
  expect(getDocumentDetail.mock.calls[0]?.[0]).toBe(selection.path);
  fireEvent.change(screen.getByLabelText('笔记正文'), { target: { value: '不能丢的编辑' } }); fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('其他窗口'); expect(screen.getByLabelText('笔记正文')).toHaveValue('不能丢的编辑');
});
it('checks the live knowledge version and keeps edited text through a list refresh', async () => {
  const { api, list, getKnowledgeDetail } = fixture(); list.mockResolvedValue({ ok: true, value: { notes: [{ ...note, selection: { ...selection, path: '02知识库/知识.md' } }] } });
  getKnowledgeDetail.mockResolvedValue({ ok: true, value: { versionMarker: { rawSha256: 'b'.repeat(64) } } } as never);
  const view = render(<LearningNotes api={api} path="02知识库/知识.md" refreshKey={0} />);
  fireEvent.click(screen.getByRole('button', { name: '学习笔记' })); fireEvent.click(await screen.findByRole('button', { name: '理解标题' }));
  expect(await screen.findByText(/原文已更新/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('笔记正文'), { target: { value: '还没有保存' } });
  view.rerender(<LearningNotes api={api} path="02知识库/知识.md" refreshKey={1} />);
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2)); expect(screen.getByLabelText('笔记正文')).toHaveValue('还没有保存');
});
it('refreshes matching open lists after a note is saved elsewhere without fetching unrelated scopes', async () => {
  const { api, list } = fixture();
  render(<><LearningNotes api={api} path={selection.path} /><SaveLearningNote api={api} selection={selection} conversationId={conversationId} messageId={messageId} initialBody="新回答" /></>);
  fireEvent.click(screen.getByRole('button', { name: '学习笔记' })); await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: '保存理解' })); fireEvent.click(screen.getByRole('button', { name: '确认保存笔记' }));
  await screen.findByText('已保存为学习笔记'); await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  window.dispatchEvent(new CustomEvent('learning-notes-updated', { detail: { path: '01图书馆/无关.md', conversationId: '44444444-4444-4444-8444-444444444444' } }));
  expect(list).toHaveBeenCalledTimes(2);
});
it.each([
  ['SOURCE_IN_TRASH', '来源已移入回收站；恢复后可以重新回看。'],
  ['KNOWLEDGE_DELETED', '来源已彻底删除；保存的选文快照仍可查看。']
])('shows the real source state for %s while retaining the note', async (code, message) => {
  const { api, getDocumentDetail } = fixture(); getDocumentDetail.mockResolvedValue({ ok: false, code, state: { status: 'operation-error' } });
  render(<LearningNotes api={api} conversationId={conversationId} />);
  fireEvent.click(screen.getByRole('button', { name: '学习笔记' })); fireEvent.click(await screen.findByRole('button', { name: '理解标题' }));
  expect(await screen.findByText(message)).toBeInTheDocument(); expect(screen.getByLabelText('笔记正文')).toHaveValue(note.body);
});
it('restores unsaved edits and the stable note id after unmounting and remounting', async () => {
  const { api, save } = fixture(); const draftCache: LearningNoteDraftCache = new Map();
  const props = { api, selection, conversationId, messageId, initialBody: '初始回答', draftCache };
  const view = render(<SaveLearningNote {...props} />); fireEvent.click(screen.getByRole('button', { name: '保存理解' }));
  fireEvent.change(screen.getByLabelText('笔记标题'), { target: { value: '关闭前的标题' } });
  fireEvent.change(screen.getByLabelText('笔记正文'), { target: { value: '关闭前还未保存的理解' } });
  view.unmount();
  render(<SaveLearningNote {...props} initialBody="重新载入的模型回答" />);
  expect(screen.getByLabelText('笔记标题')).toHaveValue('关闭前的标题'); expect(screen.getByLabelText('笔记正文')).toHaveValue('关闭前还未保存的理解');
  fireEvent.click(screen.getByRole('button', { name: '确认保存笔记' })); await screen.findByText('已保存为学习笔记');
  expect(save.mock.calls[0]?.[1].body).toBe('关闭前还未保存的理解'); expect(draftCache.size).toBe(1);
});
it('retries a lost acknowledgement after remount with the same uuid and then restores its acknowledged revision', async () => {
  const { api, save } = fixture(); const draftCache: LearningNoteDraftCache = new Map();
  save.mockResolvedValueOnce({ ok: false, state: { status: 'disconnected', message: '响应丢失' } } as never);
  const props = { api, selection, conversationId, messageId, initialBody: '我的理解', draftCache };
  const first = render(<SaveLearningNote {...props} />); fireEvent.click(screen.getByRole('button', { name: '保存理解' }));
  fireEvent.change(screen.getByLabelText('笔记正文'), { target: { value: '已经确认、不能重复创建的理解' } });
  fireEvent.click(screen.getByRole('button', { name: '确认保存笔记' })); await screen.findByRole('alert'); first.unmount();
  const second = render(<SaveLearningNote {...props} />);
  expect(screen.getByLabelText('笔记正文')).toHaveValue('已经确认、不能重复创建的理解');
  fireEvent.click(screen.getByRole('button', { name: '确认保存笔记' })); await screen.findByText('已保存为学习笔记');
  expect(save.mock.calls[1]).toEqual(save.mock.calls[0]); second.unmount();
  render(<SaveLearningNote {...props} />); fireEvent.change(screen.getByLabelText('笔记正文'), { target: { value: '保存后的补充' } });
  fireEvent.click(screen.getByRole('button', { name: '保存修改' })); await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
  expect(save.mock.calls[2]?.[0]).toBe(save.mock.calls[0]?.[0]); expect(save.mock.calls[2]?.[1].expectedRevision).toBe(1);
});
it.each([false, true])('handles an acknowledgement after unmount without recreating a cleared scope (clear=%s)', async clear => {
  const { api, save } = fixture(); const draftCache: LearningNoteDraftCache = new Map();
  let complete!: (value: Awaited<ReturnType<typeof save>>) => void;
  save.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const props = { api, selection, conversationId, messageId, initialBody: '在保存中的理解', draftCache };
  const first = render(<SaveLearningNote {...props} />); fireEvent.click(screen.getByRole('button', { name: '保存理解' }));
  fireEvent.click(screen.getByRole('button', { name: '确认保存笔记' }));
  const [id, input] = save.mock.calls[0]!; first.unmount(); if (clear) draftCache.clear();
  await act(async () => complete({ ok: true, value: { note: { ...note, ...input, id, revision: 1 } } }));
  if (clear) expect(draftCache.size).toBe(0);
  else {
    render(<SaveLearningNote {...props} />); expect(screen.getByRole('button', { name: '保存修改' })).toBeInTheDocument();
    expect(screen.getByLabelText('笔记正文')).toHaveValue('在保存中的理解');
  }
});
