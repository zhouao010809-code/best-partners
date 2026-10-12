import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AssistantPanel } from '../../src/client/components/assistant/AssistantPanel.js';
import { useAssistantDrafts } from '../../src/client/components/assistant/useAssistantDrafts.js';
import { ASSISTANT_INTENT_EVENT } from '../../src/client/components/assistant/assistantIntent.js';
import type { ReadConsoleApi } from '../../src/client/api/client.js';
import type { AssistantConversation, AssistantSend } from '../../src/shared/api/assistant.js';
import type { AssistantDraft, AssistantDraftSave } from '../../src/shared/api/assistant-drafts.js';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const source = { path: '01图书馆/来自个人/学习.md', title: '学习资料', revision: 'a'.repeat(64), text: '理解需要把新概念和已有经验联系起来。' };
const prompt = '请用容易理解的话解释这段内容';
function draftService(initial: AssistantDraft[] = []) {
  const records = new Map(initial.map(item => [item.id, item])); let activeId = initial[0]?.id;
  return {
    records,
    list: vi.fn(async () => ok({ drafts: [...records.values()], ...(activeId ? { activeId } : {}) })),
    save: vi.fn(async (id: string, input: AssistantDraftSave) => {
      const { expectedRevision, active: _active, ...fields } = input;
      const record = { ...fields, id, revision: expectedRevision + 1, updatedAt: '2026-10-12', lastActive: '2026-10-12' };
      records.set(id, record); activeId = id; return ok({ draft: record });
    }),
    delete: vi.fn(async () => ok({ deleted: true as const }))
  };
}
function fixture(initial: AssistantDraft[] = []) {
  const drafts = draftService(initial);
  const conversations = new Map<string, AssistantConversation>();
  const service = {
    providers: vi.fn(async () => ok({ providers: [{ id: 'test', name: 'Test', status: 'ready', models: [{ id: 'model', name: 'Model', reasoningEfforts: [] }] }] })),
    history: vi.fn(async () => ok({ conversations: [...conversations.values()] })),
    get: vi.fn(async (id: string) => ok(conversations.get(id)!)),
    send: vi.fn(async (input: AssistantSend) => {
      const id = input.conversationId ?? crypto.randomUUID();
      const context = { scope: input.scope, ...(input.contextPath ? { contextPath: input.contextPath } : {}), ...(input.purpose ? { purpose: input.purpose } : {}), ...(input.selection ? { selection: input.selection } : {}) };
      const next: AssistantConversation = {
        id, title: '阅读讨论', createdAt: '2026-10-12', updatedAt: '2026-10-12', status: 'idle', providerId: 'test', model: 'model', ...context,
        messages: [...(conversations.get(id)?.messages ?? []), { id: crypto.randomUUID(), role: 'user', text: input.message, sources: [], actions: [], ...context }, { id: crypto.randomUUID(), role: 'assistant', text: '可以把新概念和熟悉的例子联系起来。', sources: [], actions: [], ...context }]
      };
      conversations.set(id, next); return ok(next);
    }), stop: vi.fn(), confirmAction: vi.fn(), cancelAction: vi.fn(), login: vi.fn()
  };
  const skills = { match: vi.fn(async () => ok({ candidates: [] })) };
  const api = { assistant: service, assistantDrafts: drafts, skills } as unknown as ReadConsoleApi;
  const tree = (open = true) => <MemoryRouter><AssistantPanel api={api} open={open} onClose={() => {}} width={430} onWidthChange={() => {}} onRunningChange={() => {}} /></MemoryRouter>;
  return { api, drafts, service, skills, conversations, tree };
}
function ask(selection = source) {
  act(() => window.dispatchEvent(new CustomEvent(ASSISTANT_INTENT_EVENT, { detail: { prompt, contextPath: selection.path, scope: 'current', purpose: 'learning', selection } })));
}
async function ready() { await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('model')); }
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('shows a separate source card, sends a structured selection, and bypasses Skill matching', async () => {
  const f = fixture(); render(f.tree()); await ready(); ask();
  const card = await screen.findByRole('region', { name: '你选中的文字' });
  expect(within(card).getByText(source.text)).toBeVisible();
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue(prompt);
  expect(screen.queryByRole('combobox', { name: '资料范围' })).toBeNull();
  expect(f.service.send).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(f.service.send).toHaveBeenCalledOnce());
  expect(f.service.send.mock.calls[0]![0]).toMatchObject({ purpose: 'learning', selection: source, scope: 'current', contextPath: source.path, message: prompt });
  expect(f.skills.match).not.toHaveBeenCalled();
  expect(await screen.findByRole('button', { name: '说简单点' })).toBeVisible();
  expect(screen.getByRole('button', { name: '举个例子' })).toBeVisible();
});

it('isolates a new learning conversation from ordinary history and preserves the ordinary draft', async () => {
  const originalId = crypto.randomUUID();
  const original: AssistantDraft = { id: crypto.randomUUID(), revision: 1, conversationId: originalId, text: '尚未发送的项目想法', scope: 'brain', attachments: [], groupId: crypto.randomUUID(), updatedAt: '2026-10-12', lastActive: '2026-10-12' };
  const f = fixture([original]);
  f.conversations.set(originalId, { id: originalId, title: '旧话题', createdAt: '2026-10-12', updatedAt: '2026-10-12', status: 'idle', providerId: 'test', model: 'model', scope: 'brain', messages: [{ id: 'old', role: 'assistant', text: '旧项目讨论', sources: [], actions: [] }] });
  render(f.tree()); await ready(); await screen.findByText('旧项目讨论'); ask();
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue(original.text);
  await userEvent.click(await screen.findByRole('button', { name: '载入新提问' }));
  await screen.findByRole('region', { name: '你选中的文字' });
  expect(screen.queryByText('旧项目讨论')).toBeNull();
  expect(f.drafts.records.get(original.id)?.text).toBe(original.text);
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(f.service.send).toHaveBeenCalledOnce());
  expect(f.service.send.mock.calls[0]![0].conversationId).toBeUndefined();
});

it('continues the same source after a new selection but starts another conversation for a different source', async () => {
  const f = fixture(); render(f.tree()); await ready(); ask();
  await screen.findByRole('region', { name: '你选中的文字' });
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await screen.findByText('可以把新概念和熟悉的例子联系起来。');
  const firstId = [...f.conversations.keys()][0]!;
  const secondSelection = { ...source, text: '第二段讲述如何应用。' }; ask(secondSelection);
  await waitFor(() => expect(screen.getByLabelText('发送给问问的消息')).toHaveValue(prompt));
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(f.service.send).toHaveBeenCalledTimes(2));
  expect(f.service.send.mock.calls[1]![0]).toMatchObject({ conversationId: firstId, selection: secondSelection });
  await waitFor(() => expect(screen.getByLabelText('发送给问问的消息')).toHaveValue(''));
  ask({ ...source, path: '01图书馆/来自个人/另一篇.md', title: '另一篇' });
  await waitFor(() => expect(screen.getByLabelText('发送给问问的消息')).toHaveValue(prompt));
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(f.service.send).toHaveBeenCalledTimes(3));
  expect(f.service.send.mock.calls[2]![0].conversationId).toBeUndefined();
});

it('restores the pending learning selection and prompt after remounting', async () => {
  const f = fixture(); const view = render(f.tree()); await ready(); ask();
  await screen.findByRole('region', { name: '你选中的文字' });
  await waitFor(() => expect([...f.drafts.records.values()].some(item => item.purpose === 'learning' && item.selection?.text === source.text)).toBe(true));
  view.unmount(); render(f.tree()); await ready();
  expect(await screen.findByRole('region', { name: '你选中的文字' })).toHaveTextContent(source.text);
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue(prompt);
  expect(f.service.send).not.toHaveBeenCalled();
});

it('retains a failed selection and question without falling back to ordinary tools', async () => {
  const f = fixture(); f.service.send.mockResolvedValueOnce({ ok: false, code: 'LEARNING_SOURCE_CHANGED', state: { status: 'conflict', message: '原文已更新，请重新选择。' } } as never);
  render(f.tree()); await ready(); ask(); await screen.findByRole('region', { name: '你选中的文字' });
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('原文已更新');
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue(prompt);
  expect(screen.getByRole('region', { name: '你选中的文字' })).toHaveTextContent(source.text);
  expect(f.skills.match).not.toHaveBeenCalled();
});

it('persists learning purpose and selection when saving a draft or restoring a conversation', async () => {
  const f = fixture(); const view = renderHook(() => useAssistantDrafts(f.api.assistantDrafts));
  await waitFor(() => expect(view.result.current.ready).toBe(true));
  act(() => view.result.current.update({ purpose: 'learning', selection: source, scope: 'current', contextPath: source.path, text: prompt }));
  await act(async () => { await view.result.current.flush(); });
  expect(f.drafts.save.mock.calls.at(-1)?.[1]).toMatchObject({ purpose: 'learning', selection: source });
  const conversation: AssistantConversation = { id: crypto.randomUUID(), title: '历史学习', createdAt: '2026-10-12', updatedAt: '2026-10-12', status: 'idle', providerId: 'test', model: 'model', scope: 'current', contextPath: source.path, purpose: 'learning', selection: source, messages: [] };
  await act(async () => { await view.result.current.forConversation(conversation); });
  expect(view.result.current.current).toMatchObject({ purpose: 'learning', selection: source, conversationId: conversation.id });
});

it('keeps a removed quote out of pending input while historical follow-up uses that answer original selection', async () => {
  const f = fixture(); render(f.tree()); await ready(); ask();
  await screen.findByRole('region', { name: '你选中的文字' });
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await screen.findByText('可以把新概念和熟悉的例子联系起来。');
  await waitFor(() => expect(screen.getByLabelText('发送给问问的消息')).toHaveValue(''));
  await userEvent.click(screen.getByRole('button', { name: '移除待发送选段' }));
  expect(screen.queryByRole('region', { name: '你选中的文字' })).toBeNull();
  expect(screen.getByRole('region', { name: '本条提问的选文' })).toHaveTextContent(source.text);
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: '说简单点' }));
  expect(await screen.findByRole('region', { name: '你选中的文字' })).toHaveTextContent(source.text);
  await waitFor(() => expect(screen.getByLabelText('发送给问问的消息')).toHaveValue('请把你刚才的解释说得更简单一些。'));
});

it('clears a failed-send retry when its pending quote is removed', async () => {
  const f = fixture(); f.service.send.mockRejectedValueOnce(new Error('connection lost'));
  render(f.tree()); await ready(); ask(); await screen.findByRole('region', { name: '你选中的文字' });
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await screen.findByRole('button', { name: '重试这条消息' });
  await userEvent.click(screen.getByRole('button', { name: '移除待发送选段' }));
  expect(screen.queryByRole('button', { name: '重试这条消息' })).toBeNull();
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue(prompt);
});

it('retains an edited understanding and its retry identity when the panel is closed and reopened', async () => {
  const f = fixture();
  const save = vi.fn(async () => ({ ok: false as const, code: 'CONNECTION_LOST', state: { status: 'offline' as const, message: '保存结果尚未确认' } }));
  f.api.learningNotes = { list: vi.fn(), save } as unknown as NonNullable<ReadConsoleApi['learningNotes']>;
  const view = render(f.tree()); await ready(); ask(); await screen.findByRole('region', { name: '你选中的文字' });
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await userEvent.click(await screen.findByRole('button', { name: '保存理解' }));
  await userEvent.clear(screen.getByLabelText('笔记正文'));
  await userEvent.type(screen.getByLabelText('笔记正文'), '这是我整理后的理解，不能丢失。');
  await userEvent.click(screen.getByRole('button', { name: '确认保存笔记' }));
  await screen.findByText('保存结果尚未确认');
  view.rerender(f.tree(false)); view.rerender(f.tree());
  await waitFor(() => expect(screen.getByLabelText('笔记正文')).toHaveValue('这是我整理后的理解，不能丢失。'));
  await userEvent.click(screen.getByRole('button', { name: '确认保存笔记' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[0]).toEqual(save.mock.calls[1]);
});
