import { useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AssistantPanel } from '../../src/client/components/assistant/AssistantPanel.js';
import { AttachmentPicker } from '../../src/client/components/assistant/AttachmentPicker.js';
import { ContextUsage } from '../../src/client/components/assistant/ContextUsage.js';
import { AssistantContinuation } from '../../src/client/components/assistant/AssistantContinuation.js';
import { AssistantMessageView } from '../../src/client/components/assistant/AssistantMessageView.js';
import { useAssistantDrafts } from '../../src/client/components/assistant/useAssistantDrafts.js';
import { askAssistant } from '../../src/client/components/assistant/assistantIntent.js';
import type { ReadConsoleApi } from '../../src/client/api/client.js';
import type { AssistantDraft, AssistantDraftSave } from '../../src/shared/api/assistant-drafts.js';
import type { Attachment, AttachmentSelection } from '../../src/shared/api/attachments.js';
import type { AssistantConversation } from '../../src/shared/api/assistant.js';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const uuid = () => crypto.randomUUID();
const fileRecord = (id: string = uuid(), status: Attachment['status'] = 'ready'): Attachment => ({ id, name: '阅读资料.pdf', mediaType: 'application/pdf', size: 1234, sha256: 'a'.repeat(64), status, pageCount: 5, textBytes: 100, createdAt: '2026-09-10', updatedAt: '2026-09-10' });
function draftService(initial: AssistantDraft[] = []) {
  const records = new Map(initial.map(item => [item.id, item])); let activeId = initial[0]?.id;
  const service = {
    list: vi.fn(async () => ok({ drafts: [...records.values()], ...(activeId ? { activeId } : {}) })),
    save: vi.fn(async (id: string, input: AssistantDraftSave) => {
      const { expectedRevision, active: _active, ...fields } = input;
      const draft: AssistantDraft = { ...fields, id, revision: expectedRevision + 1, updatedAt: '2026-09-10', lastActive: '2026-09-10' }; records.set(id, draft); activeId = id; return ok({ draft });
    }), delete: vi.fn(async (id: string) => { records.delete(id); return ok({ deleted: true as const }); })
  };
  return { service, records };
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('waits for the current draft service before exposing restored state', async () => {
  const first = draftService();
  const next = draftService();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const nextList = next.service.list.getMockImplementation()!;
  next.service.list.mockImplementationOnce(async () => { await gate; return nextList(); });
  const view = renderHook(({ service }) => useAssistantDrafts(service), { initialProps: { service: first.service } });
  await waitFor(() => expect(view.result.current.ready).toBe(true));
  view.rerender({ service: next.service });
  expect(view.result.current.ready).toBe(false);
  await act(async () => { release(); });
  await waitFor(() => expect(view.result.current.ready).toBe(true));
});

it.each(['absent', 'restoring', 'restored'] as const)('restores the active conversation after bootstrap replaces a %s API client', async phase => {
  const conversationId = uuid();
  const saved: AssistantDraft = { id: uuid(), revision: 2, conversationId, text: '保留的追问', attachments: [], groupId: uuid(), scope: 'brain', updatedAt: '2026-09-10', lastActive: '2026-09-10' };
  const conversation: AssistantConversation = { id: conversationId, title: '已归档讨论', createdAt: '2026-09-10', updatedAt: '2026-09-10', status: 'idle', providerId: 'test', model: 'model', scope: 'brain', messages: [{ id: 'a', role: 'assistant', text: '归档后保留的回答', sources: [], actions: [] }] };
  let releaseFirst!: () => void;
  const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve; });
  const makeApi = () => ({
    assistantDrafts: draftService([saved]).service,
    assistant: {
      providers: vi.fn(async () => ok({ providers: [{ id: 'test', name: 'Test', status: 'ready', models: [{ id: 'model', name: 'Model', reasoningEfforts: [] }] }] })),
      history: vi.fn(async () => ok({ conversations: [conversation] })),
      get: vi.fn(async () => ok(conversation)), send: vi.fn()
    }
  });
  const first = makeApi(); const next = makeApi();
  if (phase === 'restoring') first.assistant.get.mockImplementationOnce(async () => { await firstResponse; return ok(conversation); });
  const panel = (api: ReadConsoleApi) => <MemoryRouter><AssistantPanel api={api} open onClose={() => {}} width={430} onWidthChange={() => {}} onRunningChange={() => {}} /></MemoryRouter>;
  const view = render(panel((phase === 'absent' ? {} : first) as unknown as ReadConsoleApi));
  if (phase === 'restoring') await waitFor(() => expect(first.assistant.get).toHaveBeenCalledTimes(1));
  if (phase === 'restored') await screen.findByText('归档后保留的回答');
  view.rerender(panel(next as unknown as ReadConsoleApi));
  await act(async () => { releaseFirst(); });
  expect(await screen.findByText('归档后保留的回答')).toBeVisible();
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue(saved.text);
  expect(next.assistant.get).toHaveBeenCalledWith(conversationId);
  expect(first.assistant.send).not.toHaveBeenCalled(); expect(next.assistant.send).not.toHaveBeenCalled();
  expect(next.assistantDrafts.save).not.toHaveBeenCalled();
});

it('serializes saving so a late response cannot overwrite newer typing, then restores the final text on remount', async () => {
  const f = draftService(); const realSave = f.service.save.getMockImplementation()!;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.service.save.mockImplementationOnce(async (id, input) => { await gate; return realSave(id, input); });
  const view = renderHook(() => useAssistantDrafts(f.service)); await waitFor(() => expect(view.result.current.ready).toBe(true));
  act(() => view.result.current.update({ text: '旧输入' }));
  let flush!: Promise<boolean>; act(() => { flush = view.result.current.flush(); });
  await waitFor(() => expect(f.service.save).toHaveBeenCalledTimes(1));
  act(() => view.result.current.update({ text: '输入过程中又补了结论' }));
  await act(async () => { release(); await flush; });
  expect(f.service.save).toHaveBeenCalledTimes(2); expect(f.service.save.mock.calls[1]![1]).toMatchObject({ text: '输入过程中又补了结论', expectedRevision: 1 });
  expect(view.result.current.current.text).toBe('输入过程中又补了结论'); view.unmount();
  const reopened = renderHook(() => useAssistantDrafts(f.service)); await waitFor(() => expect(reopened.result.current.ready).toBe(true));
  expect(reopened.result.current.current.text).toBe('输入过程中又补了结论');
});

it('retains unsaved text after a failed save and prevents switching until it can be preserved', async () => {
  const f = draftService(); const view = renderHook(() => useAssistantDrafts(f.service)); await waitFor(() => expect(view.result.current.ready).toBe(true));
  act(() => view.result.current.update({ text: '不能丢失的文字' })); const id = view.result.current.current.id;
  f.service.save.mockRejectedValueOnce(new Error('offline'));
  let changed = true; await act(async () => { changed = await view.result.current.newDraft(); });
  expect(changed).toBe(false); expect(view.result.current.current).toMatchObject({ id, text: '不能丢失的文字' });
  expect(view.result.current.error).toContain('文字仍在此处');
});

it('keeps edits made just before reopening the same draft instead of restoring its older saved snapshot', async () => {
  const saved: AssistantDraft = { id: uuid(), revision: 1, text: '旧快照', attachments: [], groupId: uuid(), scope: 'brain', updatedAt: '2026-09-10', lastActive: '2026-09-10' };
  const f = draftService([saved]); const view = renderHook(() => useAssistantDrafts(f.service)); await waitFor(() => expect(view.result.current.ready).toBe(true));
  act(() => view.result.current.update({ text: '刚刚补充的完整想法' }));
  await act(async () => { await view.result.current.select(saved); });
  expect(view.result.current.current.text).toBe('刚刚补充的完整想法'); expect(f.records.get(saved.id)?.text).toBe('刚刚补充的完整想法');
});

it('flushes unsaved project text before a workspace revision refresh', async () => {
  const projectId = uuid();
  const saved: AssistantDraft = { id: uuid(), revision: 1, text: '旧项目草稿', attachments: [], groupId: uuid(), scope: 'project', projectId, projectRevision: 1, updatedAt: '2026-09-10', lastActive: '2026-09-10' };
  const f = draftService([saved]);
  const view = renderHook(() => useAssistantDrafts(f.service, projectId));
  await waitFor(() => expect(view.result.current.ready).toBe(true));
  act(() => view.result.current.update({ text: '重连前刚补充的内容' }));
  await act(async () => { expect(await view.result.current.enterProject(projectId, 2)).toBe(true); });
  expect(f.records.get(saved.id)?.text).toBe('重连前刚补充的内容');
  expect(view.result.current.current.text).toBe('重连前刚补充的内容');
  expect(view.result.current.current.projectRevision).toBe(2);
});

it('restores a persisted conversation draft with files, preserves it when creating a blank conversation, and finds it in draft history', async () => {
  const user = userEvent.setup(); const attachment = fileRecord(); const conversationId = uuid();
  const saved: AssistantDraft = { id: uuid(), revision: 2, conversationId, text: '尚未发出的追问', attachments: [{ id: attachment.id, startPage: 2, endPage: 3 }], groupId: uuid(), scope: 'current', contextPath: '01图书馆/旧资料.md', updatedAt: '2026-09-10', lastActive: '2026-09-10' };
  const f = draftService([saved]);
  const conversation: AssistantConversation = { id: conversationId, title: '旧讨论', createdAt: '2026-09-10', updatedAt: '2026-09-10', status: 'idle', providerId: 'test', model: 'model', scope: 'current', contextPath: saved.contextPath, messages: [{ id: 'a', role: 'assistant', text: '旧讨论的回答', sources: [], actions: [] }] };
  const api = { assistantDrafts: f.service, attachments: { get: vi.fn(async () => ok({ attachment })) }, assistant: { providers: vi.fn(async () => ok({ providers: [{ id: 'test', name: 'Test', status: 'ready', models: [{ id: 'model', name: 'Model', reasoningEfforts: [] }] }] })), history: vi.fn(async () => ok({ conversations: [conversation] })), get: vi.fn(async () => ok(conversation)), send: vi.fn() } } as unknown as ReadConsoleApi;
  render(<MemoryRouter><AssistantPanel api={api} open onClose={() => {}} width={430} onWidthChange={() => {}} onRunningChange={() => {}} /></MemoryRouter>);
  await screen.findByText('旧讨论的回答'); expect(screen.getByLabelText('发送给问问的消息')).toHaveValue(saved.text);
  await screen.findByText(attachment.name); expect(screen.getByLabelText(`${attachment.name} 起始页`)).toHaveValue(2);
  await user.click(screen.getByRole('button', { name: '新对话' }));
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue(''); expect(screen.getByLabelText('资料范围')).toHaveValue('brain'); expect(screen.queryByText(attachment.name)).not.toBeInTheDocument();
  expect(f.records.get(saved.id)?.text).toBe(saved.text); expect(api.assistant!.send).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '历史对话' })); await user.click(screen.getByRole('button', { name: /尚未发出的追问 · 1 份文件/u }));
  await waitFor(() => expect(screen.getByLabelText('发送给问问的消息')).toHaveValue(saved.text)); await screen.findByText(attachment.name);
});

it('preserves attachment-only scope on restore and sends it without silently widening to the whole brain', async () => {
  const user = userEvent.setup(); const attachment = fileRecord();
  const saved: AssistantDraft = { id: uuid(), revision: 1, text: '只解释已选文件', attachments: [{ id: attachment.id }], groupId: uuid(), scope: 'current', updatedAt: '2026-09-10', lastActive: '2026-09-10' };
  const f = draftService([saved]); const send = vi.fn(async (_input: unknown) => ({ ok: false, state: { status: 'operation-error', message: '测试未执行模型' } }));
  const api = { assistantDrafts: f.service, attachments: { get: vi.fn(async () => ok({ attachment })) }, skills: { match: vi.fn(async () => ok({ candidates: [] })) }, assistant: { providers: vi.fn(async () => ok({ providers: [{ id: 'test', name: 'Test', status: 'ready', models: [{ id: 'model', name: 'Model', reasoningEfforts: [] }] }] })), history: vi.fn(async () => ok({ conversations: [] })), send } } as unknown as ReadConsoleApi;
  render(<MemoryRouter><AssistantPanel api={api} open onClose={() => {}} width={430} onWidthChange={() => {}} onRunningChange={() => {}} /></MemoryRouter>);
  await screen.findByText(attachment.name); expect(screen.getByLabelText('资料范围')).toHaveValue('current'); expect(screen.getByRole('option', { name: '仅本轮附件' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: '发送消息' })); await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(send.mock.calls[0]![0]).toMatchObject({ scope: 'current', attachments: [{ id: attachment.id }] }); expect(send.mock.calls[0]![0]).not.toHaveProperty('contextPath');
});

it('restores the last user attachment snapshot only when history has no saved draft, respecting later explicit removal', async () => {
  const user = userEvent.setup(); const attachment = fileRecord(); const f = draftService();
  const conversation: AssistantConversation = { id: uuid(), title: '来自其他窗口的对话', createdAt: '2026-09-10', updatedAt: '2026-09-10', status: 'idle', providerId: 'test', model: 'model', scope: 'current', messages: [{ id: 'u', role: 'user', text: '请读这两页', sources: [], actions: [], scope: 'current', attachments: [{ ...attachment, startPage: 2, endPage: 3 }] }] };
  const api = { assistantDrafts: f.service, attachments: { get: vi.fn(async () => ok({ attachment })) }, assistant: { providers: vi.fn(async () => ok({ providers: [{ id: 'test', name: 'Test', status: 'ready', models: [{ id: 'model', name: 'Model', reasoningEfforts: [] }] }] })), history: vi.fn(async () => ok({ conversations: [conversation] })), get: vi.fn(async () => ok(conversation)) } } as unknown as ReadConsoleApi;
  render(<MemoryRouter><AssistantPanel api={api} open onClose={() => {}} width={430} onWidthChange={() => {}} onRunningChange={() => {}} /></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole('button', { name: '新对话' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: '历史对话' })); await user.click(await screen.findByRole('button', { name: /来自其他窗口的对话.*model/u }));
  await screen.findByRole('list', { name: '本对话附件' }); expect(screen.getByLabelText('阅读资料.pdf 起始页')).toHaveValue(2); expect(screen.getByLabelText('资料范围')).toHaveValue('current');
  await user.click(screen.getByRole('button', { name: '移除附件 阅读资料.pdf' })); await user.click(screen.getByRole('button', { name: '新对话' }));
  await user.click(screen.getByRole('button', { name: '历史对话' })); await user.click(await screen.findByRole('button', { name: /来自其他窗口的对话.*model/u }));
  await screen.findByText('请读这两页'); expect(screen.queryByRole('list', { name: '本对话附件' })).not.toBeInTheDocument();
});

it.each(['archive receipt', 'task completion'] as const)('refreshes selected file state after %s without fetching for streamed text updates', async trigger => {
  const user = userEvent.setup(); let attachment = fileRecord(); const operationId = uuid(); const conversationId = uuid();
  const saved: AssistantDraft = { id: uuid(), revision: 1, text: '请归档这份文件', attachments: [{ id: attachment.id }], groupId: uuid(), scope: 'current', updatedAt: '2026-09-10', lastActive: '2026-09-10' };
  const f = draftService([saved]);
  const running: AssistantConversation = { id: conversationId, title: '归档文件', createdAt: '2026-09-10', updatedAt: '2026-09-10', status: 'running', providerId: 'test', model: 'model', scope: 'current', messages: [{ id: 'a', role: 'assistant', text: '正在处理', sources: [], actions: [] }] };
  let polls = 0;
  const get = vi.fn(async () => {
    polls += 1;
    if (polls === 1) return ok({ ...running, updatedAt: '2026-09-10T01:00:00Z', messages: [{ ...running.messages[0]!, text: '正在处理文件的内容' }] });
    attachment = { ...attachment, archive: { state: 'archived', operationId, materialPath: '01图书馆/阅读资料.md', indexed: true } };
    return ok({ ...running, status: trigger === 'task completion' ? 'idle' as const : 'running' as const, messages: [{ ...running.messages[0]!, text: '文件归档已经完成', actions: trigger === 'archive receipt' ? [{ id: 'archive-action', type: 'archive' as const, attachmentId: attachment.id, operationId, materialPath: '01图书馆/阅读资料.md', materialTitle: '阅读资料', status: 'archived' as const, label: '查看归档资料' }] : [] }] });
  });
  const getAttachment = vi.fn(async () => ok({ attachment }));
  const send = vi.fn(async () => ok(running));
  const api = { assistantDrafts: f.service, attachments: { get: getAttachment }, skills: { match: vi.fn(async () => ok({ candidates: [] })) }, assistant: { providers: vi.fn(async () => ok({ providers: [{ id: 'test', name: 'Test', status: 'ready', models: [{ id: 'model', name: 'Model', reasoningEfforts: [] }] }] })), history: vi.fn(async () => ok({ conversations: [] })), get, send } } as unknown as ReadConsoleApi;
  render(<MemoryRouter><AssistantPanel api={api} open onClose={() => {}} width={430} onWidthChange={() => {}} onRunningChange={() => {}} /></MemoryRouter>);
  await screen.findByText('临时附件'); const sendButton = screen.getByRole('button', { name: '发送消息' }); await waitFor(() => expect(sendButton).toBeEnabled()); await user.click(sendButton); await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  const afterStarting = getAttachment.mock.calls.length;
  await screen.findByText('正在处理文件的内容', {}, { timeout: 2000 }); expect(getAttachment).toHaveBeenCalledTimes(afterStarting);
  await waitFor(() => expect(within(screen.getByRole('list', { name: '本对话附件' })).getByText('已归档')).toBeVisible(), { timeout: 2000 });
  expect(getAttachment).toHaveBeenCalledTimes(afterStarting + 1);
  expect(within(screen.getByRole('list', { name: '本对话附件' })).queryByText('临时附件')).not.toBeInTheDocument();
});

it('queues an external intent until restoring the original conversation finishes, keeping send reachable', async () => {
  const user = userEvent.setup(); const conversationId = uuid(); let resolve!: (value: unknown) => void;
  const gate = new Promise(done => { resolve = done; });
  const saved: AssistantDraft = { id: uuid(), revision: 1, conversationId, text: '', attachments: [], groupId: uuid(), scope: 'brain', updatedAt: '2026-09-10', lastActive: '2026-09-10' };
  const f = draftService([saved]); const get = vi.fn(() => gate);
  const api = { assistantDrafts: f.service, assistant: { providers: vi.fn(async () => ok({ providers: [{ id: 'test', name: 'Test', status: 'ready', models: [{ id: 'model', name: 'Model', reasoningEfforts: [] }] }] })), history: vi.fn(async () => ok({ conversations: [] })), get } } as unknown as ReadConsoleApi;
  render(<MemoryRouter><AssistantPanel api={api} open onClose={() => {}} width={430} onWidthChange={() => {}} onRunningChange={() => {}} /></MemoryRouter>);
  await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
  act(() => askAssistant({ prompt: '后来到达的新提问', scope: 'brain' })); expect(screen.getByRole('button', { name: '载入新提问' })).toBeDisabled();
  await act(async () => { resolve(ok({ id: conversationId, title: '原对话', createdAt: '2026-09-10', updatedAt: '2026-09-10', status: 'idle', scope: 'brain', providerId: 'test', model: 'model', messages: [] })); });
  await user.click(screen.getByRole('button', { name: '载入新提问' })); expect(screen.getByLabelText('发送给问问的消息')).toHaveValue('后来到达的新提问'); expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled();
});

it('uploads one stable id, polls real processing state, keeps page selections and only unselects on removal', async () => {
  const user = userEvent.setup(); let record = fileRecord(); const change = vi.fn();
  const upload = vi.fn(async (_file: File, id: string) => { record = { ...record, id }; return ok({ attachment: { ...record, status: 'processing' as const } }); });
  const get = vi.fn(async () => ok({ attachment: record })); const cancel = vi.fn();
  const api = { attachments: { upload, get, cancel } } as unknown as ReadConsoleApi;
  function Harness() { const [value, setValue] = useState<AttachmentSelection[]>([]); return <AttachmentPicker api={api} value={value} groupId="c288ad54-4272-4ac0-9bfe-d8c1521e5b87" onChange={next => { change(next); setValue(next); }} />; }
  render(<Harness />); await user.upload(screen.getByLabelText('添加 PDF、MD 或 TXT 文件'), new File(['pdf'], '阅读资料.pdf', { type: 'application/pdf' }));
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(1)); await screen.findByText('可阅读 · 2 KB · 5 页');
  expect(upload.mock.calls[0]![1]).toBe(change.mock.calls[0]![0][0].id);
  fireEvent.change(screen.getByLabelText('阅读资料.pdf 起始页'), { target: { value: '3' } });
  expect(change.mock.calls.at(-1)![0]).toEqual([{ id: record.id, startPage: 3, endPage: 5 }]);
  expect(screen.getByRole('link', { name: '下载原件' })).toHaveAttribute('download', '阅读资料.pdf');
  await user.click(screen.getByRole('button', { name: '移除附件 阅读资料.pdf' })); expect(change.mock.calls.at(-1)![0]).toEqual([]); expect(cancel).not.toHaveBeenCalled();
});

it('shows OCR and encrypted failures honestly while keeping original download available', async () => {
  const attachment = fileRecord(undefined, 'needs-ocr'); const api = { attachments: { get: vi.fn(async () => ok({ attachment })) } } as unknown as ReadConsoleApi;
  render(<AttachmentPicker api={api} value={[{ id: attachment.id }]} groupId={uuid()} onChange={() => {}} />);
  expect(await screen.findByText('需要文字识别 · 2 KB · 5 页')).toBeVisible(); expect(screen.getByText(/请先进行文字识别/u)).toBeVisible();
  expect(screen.getByRole('link', { name: '下载原件' })).toHaveAttribute('href', `/api/v1/assistant/attachments/${attachment.id}/content`);
});

it('starts a fresh upload batch after removal, and preserves its batch id for a retry', async () => {
  const user = userEvent.setup(); const records = new Map<string, Attachment>(); let failedId = '';
  const upload = vi.fn(async (file: File, id: string, _group: string) => {
    if (file.name === '第二份.pdf' && !failedId) { failedId = id; throw new Error('response lost'); }
    const attachment = { ...fileRecord(id), name: file.name, size: 10 * 1024 * 1024 }; records.set(id, attachment); return ok({ attachment });
  });
  const api = { attachments: { upload, get: vi.fn(async (id: string) => records.has(id) ? ok({ attachment: records.get(id)! }) : { ok: false, state: { status: 'operation-error', message: '尚未收到' } }) } } as unknown as ReadConsoleApi;
  function Harness() { const [value, setValue] = useState<AttachmentSelection[]>([]); return <AttachmentPicker api={api} value={value} groupId="575fe286-102d-443d-a805-665c81e46a9b" onChange={setValue} />; }
  render(<Harness />); const first = new File(['a'], '第一份.pdf', { type: 'application/pdf' }); Object.defineProperty(first, 'size', { value: 10 * 1024 * 1024 });
  const second = new File(['b'], '第二份.pdf', { type: 'application/pdf' }); Object.defineProperty(second, 'size', { value: 10 * 1024 * 1024 });
  await user.upload(screen.getByLabelText('添加 PDF、MD 或 TXT 文件'), first); await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  await user.click(screen.getByRole('button', { name: '移除附件 第一份.pdf' })); await user.upload(screen.getByLabelText('添加 PDF、MD 或 TXT 文件'), second);
  await user.click(await screen.findByRole('button', { name: '重试上传' })); await waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
  expect(upload.mock.calls[0]![2]).not.toBe(upload.mock.calls[1]![2]); expect(upload.mock.calls[1]!.slice(1)).toEqual(upload.mock.calls[2]!.slice(1));
});

it('does not upload bytes when durable selection fails and allows a stable-id retry after saving recovers', async () => {
  const user = userEvent.setup(); const upload = vi.fn(async (_file: File, id: string) => ok({ attachment: fileRecord(id) }));
  const save = vi.fn().mockRejectedValueOnce(new Error('draft offline')).mockResolvedValue(undefined);
  const api = { attachments: { upload, get: vi.fn(async () => ({ ok: false, state: { status: 'operation-error', message: '尚未收到' } })) } } as unknown as ReadConsoleApi;
  function Harness() { const [value, setValue] = useState<AttachmentSelection[]>([]); return <AttachmentPicker api={api} value={value} groupId="575fe286-102d-443d-a805-665c81e46a9b" onChange={async next => { setValue(next); await save(next); }} />; }
  render(<Harness />); await user.upload(screen.getByLabelText('添加 PDF、MD 或 TXT 文件'), new File(['a'], '阅读资料.pdf', { type: 'application/pdf' }));
  expect(await screen.findByText(/附件编号尚未保存/u)).toBeVisible(); expect(upload).not.toHaveBeenCalled();
  await user.click(await screen.findByRole('button', { name: '重试上传' })); await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  expect(upload.mock.calls[0]![1]).toBe(save.mock.calls[0]![0][0].id); expect(save).toHaveBeenCalledTimes(2);
});

it('uses the latest real input receipt for the ring, never cumulative totals or a made-up unknown capacity', () => {
  const conversation = { messages: [{ role: 'assistant', usage: { latest: { inputTokens: 100000, outputTokens: 2000 }, total: { inputTokens: 800000 }, status: 'complete' }, context: { capacity: { contextWindowTokens: 1000000, sourceUrl: 'https://example.com/capacity', verifiedAt: '2026-09-10' }, outputReserveTokens: 32768, estimate: { inputTokens: 120000 }, history: { availableMessages: 40, selectedMessages: 24, omittedMessages: 16, messageLimit: 24, conversationMessageLimit: 100, conversationMessages: 42, remainingMessages: 58 } } }] } as AssistantConversation;
  const view = render(<ContextUsage conversation={conversation} draftChanged onContinue={() => {}} />);
  expect(screen.getByLabelText('上下文用量：10.2%')).toBeVisible(); fireEvent.click(screen.getByLabelText('上下文用量：10.2%'));
  expect(screen.getByText(/圆环保留上一请求回执/u)).toBeVisible(); expect(screen.getByText('24 / 40 条')).toBeVisible();
  view.rerender(<ContextUsage conversation={{ ...conversation, messages: [{ ...conversation.messages[0]!, context: undefined }] }} onContinue={() => {}} />);
  expect(screen.getByLabelText('上下文用量：102,000 tokens · 容量未知')).toBeVisible();
  view.rerender(<ContextUsage conversation={{ ...conversation, messages: [{ ...conversation.messages[0]!, usage: { ...conversation.messages[0]!.usage!, status: 'partial', latest: { step: 1, measuredAt: '2026-09-10', status: 'partial', inputTokens: 100000 } } }] }} onContinue={() => {}} />);
  expect(screen.getByLabelText('上下文用量：≥10%')).toBeVisible(); expect(screen.getByText(/比例是已知下界/u)).toBeVisible();
});

it('creates an editable continuation excerpt and transfers only explicitly selected files without sending', async () => {
  const user = userEvent.setup(); const file = fileRecord(); const onContinue = vi.fn(async () => {});
  const conversation = { title: '学习讨论', messages: [{ role: 'user', text: '旧问题', sources: [] }, { role: 'assistant', text: '旧回答', sources: [] }] } as unknown as AssistantConversation;
  render(<AssistantContinuation conversation={conversation} attachments={[{ id: file.id }]} records={[file]} onCancel={() => {}} onContinue={onContinue} />);
  expect((screen.getByLabelText('新对话摘要草稿') as HTMLTextAreaElement).value).toContain('旧回答');
  await user.clear(screen.getByLabelText('新对话摘要草稿')); await user.type(screen.getByLabelText('新对话摘要草稿'), '我核对后的摘要');
  await user.click(screen.getByRole('button', { name: '放入新对话草稿' })); expect(onContinue).toHaveBeenCalledExactlyOnceWith('我核对后的摘要', []);
});

it('renders archive receipts and attachment citations as original downloads, never library paths containing attachment ids', async () => {
  const user = userEvent.setup(); const id = uuid();
  render(<MemoryRouter><AssistantMessageView onFollowUp={() => {}} message={{ id: 'm', role: 'assistant', text: '根据原件 [S1001]', sources: [{ id: 'S1001', path: `attachment:${id}`, attachmentId: id, title: '阅读资料.pdf', evidence: [{ excerpt: '第3页内容', page: 3, revision: 'abc', offset: 0, length: 5, startLine: 1, endLine: 1 }] }], actions: [{ id: 'a', type: 'archive', attachmentId: id, materialPath: '01图书馆/阅读资料/阅读资料.md', materialTitle: '阅读资料', operationId: uuid(), status: 'archived', label: '查看资料' }] }} /></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: '查看引用 S1001' })); expect(screen.getByText(/原件第 3 页/u)).toBeVisible();
  expect(screen.getByRole('region', { name: '文件归档结果' })).toBeVisible();
  const links = screen.getAllByRole('link'); expect(links.some(link => link.getAttribute('href')?.includes('attachment%3A'))).toBe(false);
});
