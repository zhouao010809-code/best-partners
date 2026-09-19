import { useCallback, useState } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AssistantPanel, AssistantToggle } from '../../src/client/components/assistant/AssistantPanel.js';
import { ASSISTANT_REVIEW_EVENT, askAssistant } from '../../src/client/components/assistant/assistantIntent.js';
import type { ReadConsoleApi } from '../../src/client/api/client.js';
import type { AssistantConversation, AssistantProvider, AssistantSend } from '../../src/shared/api/assistant.js';

const ok = <T,>(value: T) => ({ ok: true as const, value });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const provider: AssistantProvider = { id: 'deepseek', name: 'DeepSeek', status: 'ready', defaultModel: 'deepseek-v4-pro', defaultEffort: 'high', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', reasoningEfforts: ['high', 'max'], recommended: true }, { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoningEfforts: [] }] };
const secondary: AssistantProvider = { id: 'secondary-provider', name: '备用服务', status: 'ready', defaultModel: 'secondary-model-v1', defaultEffort: 'ultra', models: [{ id: 'secondary-model-v1', name: '备用模型 V1', reasoningEfforts: ['high', 'ultra'], recommended: true }] };
const conversation: AssistantConversation = { id: '11c7a1d4-7cbf-4e92-9c64-ad175aa17d18', title: '学习方法', createdAt: '2026-09-09T06:00:00Z', updatedAt: '2026-09-09T06:00:01Z', status: 'idle', providerId: 'deepseek', model: 'deepseek-v4-pro', effort: 'high', scope: 'brain', messages: [{ id: 'm1', role: 'user', text: '帮我找到学习方法', sources: [], actions: [] }, { id: 'm2', role: 'assistant', text: '先提出一个**具体问题**。[S1]', model: 'deepseek-v4-pro', sources: [{ id: 'S1', path: '02知识库/09学习/学习方法.md', title: '学习方法' }], actions: [{ id: 'a1', type: 'review', label: '审阅知识候选', runId: 'run-123' }] }] };
const service = { providers: vi.fn(), history: vi.fn(), get: vi.fn(), send: vi.fn(), stop: vi.fn(), confirmAction: vi.fn(), cancelAction: vi.fn(), login: vi.fn() };
const skills = { match: vi.fn() };
const api = { assistant: service, skills } as unknown as ReadConsoleApi;
function Harness({ path = '/knowledge?path=02知识库%2F09学习%2F学习方法.md', dataRevision = 0 }: { path?: string; dataRevision?: number }) {
  const [open, setOpen] = useState(true); const [running, setRunning] = useState(false); const [width, setWidth] = useState(430);
  const close = useCallback(() => setOpen(false), []);
  return <MemoryRouter initialEntries={[path]}><AssistantToggle open={open} running={running} onClick={() => setOpen(value => !value)} /><AssistantPanel api={api} open={open} onClose={close} width={width} onWidthChange={setWidth} onRunningChange={setRunning} dataRevision={dataRevision} /></MemoryRouter>;
}
beforeEach(() => {
  service.providers.mockResolvedValue(ok({ providers: [provider, secondary] })); service.history.mockResolvedValue(ok({ conversations: [] })); service.send.mockResolvedValue(ok(conversation)); service.get.mockResolvedValue(ok(conversation)); service.stop.mockResolvedValue(ok({ ...conversation, status: 'stopped' }));
  skills.match.mockResolvedValue(ok({ candidates: [] }));
  service.login.mockResolvedValue(ok({ authUrl: 'https://auth.example.com/secondary', message: '请完成登录。' }));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); Reflect.deleteProperty(window, 'xiaozhaoDesktop'); });

it('uses provider recommendations, sends the selected context, and links real sources and review actions', async () => {
  const user = userEvent.setup(); render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  expect(screen.getByLabelText('思考强度')).toHaveValue('high');
  await user.selectOptions(screen.getByLabelText('资料范围'), 'current');
  await user.type(screen.getByLabelText('发送给问问的消息'), '帮我找到学习方法{Enter}');
  await waitFor(() => expect(service.send).toHaveBeenCalledTimes(1));
  expect(service.send.mock.calls[0]![0]).toMatchObject({ providerId: 'deepseek', model: 'deepseek-v4-pro', effort: 'high', scope: 'current', contextPath: '02知识库/09学习/学习方法.md' });
  expect(service.send.mock.calls[0]![0].clientRequestId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(await screen.findByText('具体问题')).toBeVisible();
  expect(screen.getByRole('link', { name: 'S1 学习方法' })).toHaveAttribute('href', '/knowledge?path=02%E7%9F%A5%E8%AF%86%E5%BA%93%2F09%E5%AD%A6%E4%B9%A0%2F%E5%AD%A6%E4%B9%A0%E6%96%B9%E6%B3%95.md');
  expect(screen.getByRole('link', { name: '审阅知识候选' })).toHaveAttribute('href', '/extractions/run-123');
});

it('confirms an archive plan through the panel and retains it when the API fails', async () => {
  const plan = {
    id: '6f9c3b4e-9c3f-4d7a-8c5f-1a8e0e5f2f66', type: 'plan' as const, kind: 'archive' as const, label: '准备归档', status: 'pending' as const,
    attachmentId: '7f9c3b4e-9c3f-4d7a-8c5f-1a8e0e5f2f66', sourceTitle: '资料.txt', sourceSha256: 'a'.repeat(64),
    targetPath: '01图书馆/来自个人/2026-09/资料', mainName: '原文.md', summary: '归档计划', createdAt: '2026-09-15T00:00:00.000Z', expiresAt: '2026-09-15T00:30:00.000Z'
  };
  const pending = { ...conversation, messages: [...conversation.messages, { id: 'm3', role: 'assistant' as const, text: '', sources: [], actions: [plan] }] };
  const completed = { ...pending, messages: pending.messages.map(message => message.id === 'm3' ? { ...message, actions: [{ id: 'archive:op:file', type: 'archive' as const, label: '打开归档资料', attachmentId: plan.attachmentId, materialPath: `${plan.targetPath}/${plan.mainName}`, materialTitle: plan.sourceTitle, operationId: 'op', status: 'archived' as const }] } : message) };
  service.send.mockResolvedValueOnce(ok(pending)); service.confirmAction.mockResolvedValueOnce({ ok: false, state: { status: 'operation-error', message: '确认服务暂不可用' } }).mockResolvedValueOnce(ok(completed));
  const user = userEvent.setup(); render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  await user.type(screen.getByLabelText('发送给问问的消息'), '请归档这个文件{Enter}');
  await user.click(await screen.findByRole('button', { name: '确认归档' }));
  await user.click(screen.getByRole('button', { name: '最终确认归档' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('确认服务暂不可用');
  expect(screen.getByRole('article', { name: '待确认的归档计划' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '确认归档' }));
  await user.click(screen.getByRole('button', { name: '最终确认归档' }));
  await waitFor(() => expect(service.confirmAction).toHaveBeenCalledTimes(2));
  expect(service.confirmAction.mock.calls[0]![0]).toBe(plan.id);
  expect(service.confirmAction.mock.calls[0]![1]).toMatch(/^[0-9a-f-]{36}$/u);
  expect(await screen.findByText('资料已保存到档案库。')).toBeVisible();
});

it('keeps the exact request id for an explicitly retried unknown send and never retries automatically', async () => {
  service.send.mockRejectedValueOnce(new TypeError('network'));
  const user = userEvent.setup(); render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  await user.type(screen.getByLabelText('发送给问问的消息'), '我的问题'); await user.click(screen.getByRole('button', { name: '发送消息' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('尚未确认发送结果'); expect(service.send).toHaveBeenCalledTimes(1);
  const original = service.send.mock.calls[0]![0] as AssistantSend;
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue('我的问题');
  await user.click(screen.getByRole('button', { name: '重试这条消息' }));
  await waitFor(() => expect(service.send).toHaveBeenCalledTimes(2)); expect(service.send.mock.calls[1]![0]).toEqual(original);
});

it('continues polling when closed, preserves messages on reopen, and Esc never stops a task', async () => {
  service.send.mockResolvedValue(ok({ ...conversation, status: 'running' }));
  const user = userEvent.setup(); render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  await user.type(screen.getByLabelText('发送给问问的消息'), '开始{Enter}');
  await screen.findByRole('button', { name: '停止回答' });
  await user.keyboard('{Escape}'); expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  await waitFor(() => expect(service.get).toHaveBeenCalled(), { timeout: 2000 });
  expect(service.stop).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '打开问问 AI' }));
  expect(await screen.findByText('具体问题')).toBeVisible(); expect(screen.queryByRole('button', { name: '停止回答' })).not.toBeInTheDocument();
});

it('stops a running conversation only after the user presses stop', async () => {
  service.send.mockResolvedValue(ok({ ...conversation, status: 'running' }));
  const user = userEvent.setup(); render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  await user.type(screen.getByLabelText('发送给问问的消息'), '开始{Enter}');
  await user.click(await screen.findByRole('button', { name: '停止回答' }));
  expect(service.stop).toHaveBeenCalledExactlyOnceWith(conversation.id); expect(await screen.findByText('已停止。你可以继续补充问题。')).toBeVisible();
});

it('shows provider failures and performs an explicit refresh without switching to an unrequested model', async () => {
  service.providers.mockRejectedValueOnce(new Error('offline'));
  const user = userEvent.setup(); render(<Harness />);
  expect(await screen.findByRole('alert')).toHaveTextContent('无法读取 AI 服务'); expect(service.providers).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: '重新读取 AI 服务' }));
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  await user.selectOptions(screen.getByLabelText('AI 服务'), 'secondary-provider');
  expect(screen.getByLabelText('模型')).toHaveValue('secondary-model-v1'); expect(screen.getByLabelText('思考强度')).toHaveValue('ultra');
  expect(service.send).not.toHaveBeenCalled();
});

it('opens history, restores its selected model and can start a fresh conversation', async () => {
  service.history.mockResolvedValue(ok({ conversations: [conversation] }));
  const user = userEvent.setup(); render(<Harness />);
  await user.click(screen.getByRole('button', { name: '历史对话' }));
  await user.click(await screen.findByRole('button', { name: /学习方法/u }));
  expect(await screen.findByText('具体问题')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '新对话' }));
  expect(screen.getByText('让收藏，变成你的答案。')).toBeVisible(); expect(screen.queryByText('具体问题')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: '带入这份资料' })).toBeVisible(); expect(screen.getByLabelText('资料范围')).toHaveValue('brain');
});

it('recovers a running conversation on first open and blocks a second concurrent submission', async () => {
  service.history.mockResolvedValue(ok({ conversations: [{ ...conversation, status: 'running' }] }));
  service.get.mockResolvedValue(ok({ ...conversation, status: 'running' }));
  render(<Harness />); expect(await screen.findByRole('button', { name: '停止回答' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '新对话' })).toBeDisabled(); expect(service.send).not.toHaveBeenCalled();
});

it('does not send Enter during IME composition and disables current scope without a document', async () => {
  const user = userEvent.setup(); render(<Harness path="/settings" />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  expect(screen.getByRole('option', { name: '当前资料 · 请先打开一篇' })).toBeDisabled();
  const input = screen.getByLabelText('发送给问问的消息'); await user.type(input, '正在输入');
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })); });
  expect(service.send).not.toHaveBeenCalled();
});

it('keeps an unavailable preferred model selected instead of falling back to Flash', async () => {
  service.providers.mockResolvedValue(ok({ providers: [{ ...provider, models: [provider.models[1]!] }] }));
  const user = userEvent.setup(); render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  await user.click(screen.getByRole('button', { name: '模型设置' }));
  expect(screen.getByRole('option', { name: 'deepseek-v4-pro · 当前不可用' })).toBeVisible();
  await user.type(screen.getByLabelText('发送给问问的消息'), '问题');
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled(); expect(service.send).not.toHaveBeenCalled();
  await user.selectOptions(screen.getByLabelText('模型'), 'deepseek-v4-flash');
  expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled();
});

it('includes the visible document as context when searching the whole brain', async () => {
  const user = userEvent.setup(); render(<Harness path="/queue?materialPath=01图书馆%2F文章.md" />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  expect(screen.getByTitle('01图书馆/文章.md')).toBeVisible();
  await user.type(screen.getByLabelText('发送给问问的消息'), '这篇和已有知识有什么联系？{Enter}');
  await waitFor(() => expect(service.send).toHaveBeenCalledTimes(1));
  expect(service.send.mock.calls[0]![0]).toMatchObject({ scope: 'brain', contextPath: '01图书馆/文章.md' });
});

it('keeps a running task during a polling failure and reconnects only on request', async () => {
  service.send.mockResolvedValue(ok({ ...conversation, status: 'running' })); service.get.mockRejectedValueOnce(new Error('offline'));
  const user = userEvent.setup(); render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  await user.type(screen.getByLabelText('发送给问问的消息'), '开始{Enter}');
  expect(await screen.findByRole('alert')).toHaveTextContent('进度连接中断');
  expect(screen.getByRole('button', { name: '停止回答' })).toBeEnabled(); expect(service.get).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: '重新读取进度' }));
  await waitFor(() => expect(service.get).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('button', { name: '停止回答' })).not.toBeInTheDocument(); expect(service.send).toHaveBeenCalledTimes(1);
});

it('restores the historical document instead of silently taking the document currently open', async () => {
  const prior = { ...conversation, scope: 'current' as const, contextPath: '01图书馆/原资料.md' };
  service.history.mockResolvedValue(ok({ conversations: [prior] })); service.get.mockResolvedValue(ok(prior));
  const user = userEvent.setup(); render(<Harness path="/library?path=01图书馆%2F另一篇.md" />);
  await user.click(screen.getByRole('button', { name: '历史对话' }));
  await user.click(await screen.findByRole('button', { name: /学习方法/u }));
  expect(await screen.findByText(/本轮仍使用《原资料》/u)).toBeVisible();
  await user.type(screen.getByLabelText('发送给问问的消息'), '继续解释{Enter}');
  await waitFor(() => expect(service.send).toHaveBeenCalledTimes(1));
  expect(service.send.mock.calls[0]![0]).toMatchObject({ scope: 'current', contextPath: '01图书馆/原资料.md' });
});

it('keeps a draft when expanding and closing the focus view, without sending it', async () => {
  const user = userEvent.setup(); render(<Harness />);
  await user.type(screen.getByLabelText('发送给问问的消息'), '留着这段问题');
  await user.click(screen.getByRole('button', { name: '展开阅读' }));
  expect(screen.getByRole('complementary')).toHaveClass('assistant-panel--expanded');
  await user.keyboard('{Escape}');
  expect(screen.getByRole('complementary')).not.toHaveClass('assistant-panel--expanded');
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue('留着这段问题');
  expect(service.send).not.toHaveBeenCalled();
});

it('shows an evidence excerpt in place and preserves it when the parent rerenders', async () => {
  const evidenceConversation = { ...conversation, messages: conversation.messages.map(item => item.role === 'assistant' ? { ...item, sources: [{ ...item.sources[0]!, kind: 'read' as const, evidence: [{ excerpt: '真实的原文片段。', revision: 'a'.repeat(64), offset: 0, length: 8, startLine: 2, endLine: 2 }] }] } : { ...item, scope: 'current' as const, contextPath: '02知识库/09学习/学习方法.md', contextTitle: '学习方法' }) };
  service.send.mockResolvedValue(ok(evidenceConversation));
  const user = userEvent.setup(); render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  await user.type(screen.getByLabelText('发送给问问的消息'), '解释{Enter}');
  await user.click(await screen.findByRole('button', { name: '查看引用 S1' }));
  expect(screen.getByText('真实的原文片段。')).toBeVisible();
  expect(screen.getByText('本轮检索：仅《学习方法》')).toBeVisible();
  await user.type(screen.getByLabelText('发送给问问的消息'), '继续');
  expect(screen.getByText('真实的原文片段。')).toBeVisible();
  expect(service.send).toHaveBeenCalledTimes(1);
});

it('ignores an idle focus refresh that returns after a new turn is already running', async () => {
  const staleRefresh = deferred<ReturnType<typeof ok<AssistantConversation>>>();
  const running: AssistantConversation = { ...conversation, status: 'running', messages: [...conversation.messages, { id: 'm3', role: 'user', text: '新一轮问题', sources: [], actions: [] }] };
  const user = userEvent.setup(); render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  await user.type(screen.getByLabelText('发送给问问的消息'), '第一轮{Enter}');
  await screen.findByText('具体问题');
  service.get.mockResolvedValue(ok(running)).mockImplementationOnce(() => staleRefresh.promise);
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(service.get).toHaveBeenCalledTimes(1);
  service.send.mockResolvedValueOnce(ok(running));
  await user.type(screen.getByLabelText('发送给问问的消息'), '新一轮问题{Enter}');
  expect(await screen.findByRole('button', { name: '停止回答' })).toBeEnabled();
  await act(async () => { staleRefresh.resolve(ok(conversation)); });
  expect(screen.getByRole('button', { name: '停止回答' })).toBeEnabled();
  expect(screen.getByText('新一轮问题')).toBeVisible();
  expect(service.send).toHaveBeenCalledTimes(2);
});

it('queues an external intent during a running turn and applies its context only after explicit loading', async () => {
  const progress = deferred<ReturnType<typeof ok<AssistantConversation>>>();
  const currentPath = '02知识库/09学习/学习方法.md';
  const nextPath = '02知识库/写作/新知识.md';
  const prior: AssistantConversation = { ...conversation, scope: 'current', contextPath: currentPath };
  service.send.mockResolvedValueOnce(ok({ ...prior, status: 'running' }));
  service.get.mockImplementationOnce(() => progress.promise);
  const user = userEvent.setup(); render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  await user.selectOptions(screen.getByLabelText('资料范围'), 'current');
  await user.type(screen.getByLabelText('发送给问问的消息'), '开始{Enter}');
  await screen.findByRole('button', { name: '停止回答' });
  await user.type(screen.getByLabelText('发送给问问的消息'), '还在编辑的问题');
  await act(async () => { askAssistant({ prompt: '用新知识拟提纲', contextPath: nextPath }); });
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue('还在编辑的问题');
  expect(screen.getByText('当前：学习方法')).toHaveAttribute('title', currentPath);
  expect(screen.queryByTitle(nextPath)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '载入新提问' })).toBeDisabled();
  await waitFor(() => expect(service.get).toHaveBeenCalledTimes(1), { timeout: 2000 });
  await act(async () => { progress.resolve(ok(prior)); });
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue('还在编辑的问题');
  expect(screen.getByRole('button', { name: '载入新提问' })).toBeEnabled();
  expect(service.send).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: '载入新提问' }));
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue('用新知识拟提纲');
  expect(screen.getByLabelText('资料范围')).toHaveValue('current');
  expect(screen.getByTitle(nextPath)).toBeVisible();
  await user.click(screen.getByRole('button', { name: '发送消息' }));
  expect(service.send.mock.calls[1]![0]).toMatchObject({ message: '用新知识拟提纲', scope: 'current', contextPath: nextPath });
});

it('keeps an external intent queued while a send is pending instead of erasing it with the send response', async () => {
  const sent = deferred<ReturnType<typeof ok<AssistantConversation>>>();
  service.send.mockImplementationOnce(() => sent.promise);
  const user = userEvent.setup(); render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  await user.selectOptions(screen.getByLabelText('资料范围'), 'current');
  await user.type(screen.getByLabelText('发送给问问的消息'), '正在发送的问题{Enter}');
  await waitFor(() => expect(service.send).toHaveBeenCalledTimes(1));
  await act(async () => { askAssistant({ prompt: '搜索整个大脑的新问题', scope: 'brain' }); });
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue('正在发送的问题');
  expect(screen.getByLabelText('资料范围')).toHaveValue('current');
  expect(screen.getByRole('button', { name: '载入新提问' })).toBeDisabled();
  await act(async () => { sent.resolve(ok(conversation)); });
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue('');
  expect(screen.getByLabelText('资料范围')).toHaveValue('current');
  expect(screen.getByRole('button', { name: '载入新提问' })).toBeEnabled();
  expect(service.send).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: '载入新提问' }));
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue('搜索整个大脑的新问题');
  expect(screen.getByLabelText('资料范围')).toHaveValue('brain');
  expect(service.send).toHaveBeenCalledTimes(1);
});

it.each(['new conversation', 'external intent'] as const)('does not restore a stale running history response after a %s interaction', async action => {
  const restore = deferred<ReturnType<typeof ok<AssistantConversation>>>();
  const active: AssistantConversation = { ...conversation, status: 'running', scope: 'current', contextPath: '01图书馆/旧资料.md' };
  service.history.mockResolvedValue(ok({ conversations: [active] }));
  service.get.mockImplementationOnce(() => restore.promise);
  const user = userEvent.setup(); render(<Harness />);
  await waitFor(() => expect(service.get).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  if (action === 'new conversation') {
    await user.click(screen.getByRole('button', { name: '新对话' }));
    await user.type(screen.getByLabelText('发送给问问的消息'), '新对话草稿');
  } else {
    await act(async () => { askAssistant({ prompt: '新资料草稿', contextPath: '02知识库/新资料.md' }); });
  }
  await act(async () => { restore.resolve(ok(active)); });
  expect(screen.queryByRole('button', { name: '停止回答' })).not.toBeInTheDocument();
  expect(screen.queryByText('具体问题')).not.toBeInTheDocument();
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue(action === 'new conversation' ? '新对话草稿' : '新资料草稿');
  expect(screen.getByLabelText('资料范围')).toHaveValue(action === 'new conversation' ? 'brain' : 'current');
  if (action === 'external intent') expect(screen.getByTitle('02知识库/新资料.md')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '发送消息' }));
  expect(service.send).toHaveBeenCalledTimes(1);
  expect(service.send.mock.calls[0]![0]).not.toHaveProperty('conversationId');
  if (action === 'external intent') expect(service.send.mock.calls[0]![0]).toMatchObject({ scope: 'current', contextPath: '02知识库/新资料.md' });
});

it('refreshes a completed task card on dataRevision without navigation or a focus event', async () => {
  const withAction = (status: 'ready' | 'committed'): AssistantConversation => ({ ...conversation, messages: conversation.messages.map(message => ({ ...message, actions: message.actions.map(action => action.type === 'review' ? ({ ...action, status, materialTitle: '学习原文', candidateCount: 2, committedCount: status === 'committed' ? 2 : 0 }) : action) })) });
  service.send.mockResolvedValue(ok(withAction('ready')));
  service.get.mockResolvedValue(ok(withAction('committed')));
  const user = userEvent.setup(); const view = render(<Harness path="/extractions/run-123" />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  await user.type(screen.getByLabelText('发送给问问的消息'), '提炼资料{Enter}');
  expect(await screen.findByText('待审阅')).toBeVisible();
  expect(service.get).not.toHaveBeenCalled();
  view.rerender(<Harness path="/extractions/run-123" dataRevision={1} />);
  expect(await screen.findByText('已入库 2 条')).toBeVisible();
  expect(screen.queryByText('待审阅')).not.toBeInTheDocument();
  expect(service.get).toHaveBeenCalledWith(conversation.id, expect.any(AbortSignal));
  expect(service.send).toHaveBeenCalledTimes(1);
});

it('refreshes a discarded task on a review event without a dataRevision change and ignores an older focus response', async () => {
  const withAction = (status: 'ready' | 'discarded'): AssistantConversation => ({ ...conversation, messages: conversation.messages.map(message => ({ ...message, actions: message.actions.map(action => action.type === 'review' ? ({ ...action, status, materialTitle: '学习原文', candidateCount: 2, committedCount: 0, discardedCount: status === 'discarded' ? 2 : 0 }) : action) })) });
  const oldFocus = deferred<ReturnType<typeof ok<AssistantConversation>>>();
  service.send.mockResolvedValue(ok(withAction('ready')));
  service.get.mockImplementationOnce(() => oldFocus.promise).mockResolvedValue(ok(withAction('discarded')));
  const user = userEvent.setup(); render(<Harness path="/extractions/run-123" dataRevision={0} />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  await user.type(screen.getByLabelText('发送给问问的消息'), '提炼资料{Enter}');
  expect(await screen.findByText('待审阅')).toBeVisible();
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(service.get).toHaveBeenCalledTimes(1);
  await act(async () => { window.dispatchEvent(new Event(ASSISTANT_REVIEW_EVENT)); });
  expect(await screen.findByText('已放弃 2 条')).toBeVisible();
  expect(service.get).toHaveBeenCalledTimes(2);
  await act(async () => { oldFocus.resolve(ok(withAction('ready'))); });
  expect(screen.getByText('已放弃 2 条')).toBeVisible();
  expect(screen.queryByText('待审阅')).not.toBeInTheDocument();
  expect(service.send).toHaveBeenCalledTimes(1);
});


it('searches older history on the server and retries loading a later page without losing the first page', async () => {
  const older = { ...conversation, id: '7ec74d24-1c69-4595-b1cc-3c66d67c3483', title: '较早的归档讨论' };
  service.history.mockImplementation(async (_signal, query) => query?.search === '归档' ? ok({ conversations: [older], hasMore: false }) : ok({ conversations: [conversation], hasMore: true, nextCursor: 'older-page' }));
  const user = userEvent.setup(); render(<Harness />);
  await user.click(screen.getByRole('button', { name: '历史对话' }));
  await screen.findByRole('button', { name: /学习方法/u });
  service.history.mockResolvedValueOnce({ ok: false, state: { status: 'disconnected', message: '分页暂不可用' } });
  await user.click(await screen.findByRole('button', { name: '加载更多对话' }));
  expect(await screen.findByText('分页暂不可用')).toBeVisible();
  expect(screen.getByRole('button', { name: /学习方法/u })).toBeVisible();
  service.history.mockResolvedValueOnce(ok({ conversations: [older], hasMore: false }));
  await user.click(screen.getByRole('button', { name: '重试加载更多' }));
  expect(await screen.findByRole('button', { name: /较早的归档讨论/u })).toBeVisible();
  expect(service.history).toHaveBeenLastCalledWith(expect.any(AbortSignal), expect.objectContaining({ cursor: 'older-page' }));
  await user.type(screen.getByRole('textbox', { name: '搜索历史对话' }), '归档');
  await waitFor(() => expect(service.history).toHaveBeenLastCalledWith(expect.any(AbortSignal), expect.objectContaining({ search: '归档' })));
  expect(await screen.findByRole('button', { name: /较早的归档讨论/u })).toBeVisible();
  expect(screen.queryByRole('button', { name: /学习方法/u })).not.toBeInTheDocument();
  expect(service.send).not.toHaveBeenCalled();
});

it('does not let an old history search replace the latest search result', async () => {
  const stale = deferred<ReturnType<typeof ok<{ conversations: typeof conversation[] }>>>();
  service.history.mockImplementation(async (_signal, query) => query?.search === '旧' ? stale.promise : query?.search === '新' ? ok({ conversations: [{ ...conversation, title: '新问题结果' }] }) : ok({ conversations: [] }));
  const user = userEvent.setup(); render(<Harness />);
  await user.click(screen.getByRole('button', { name: '历史对话' }));
  const input = screen.getByRole('textbox', { name: '搜索历史对话' });
  await user.type(input, '旧');
  await waitFor(() => expect(service.history).toHaveBeenLastCalledWith(expect.any(AbortSignal), expect.objectContaining({ search: '旧' })));
  await user.clear(input); await user.type(input, '新');
  expect(await screen.findByRole('button', { name: /新问题结果/u })).toBeVisible();
  await act(async () => stale.resolve(ok({ conversations: [{ ...conversation, title: '旧问题结果' }] })));
  expect(screen.getByRole('button', { name: /新问题结果/u })).toBeVisible();
  expect(screen.queryByRole('button', { name: /旧问题结果/u })).not.toBeInTheDocument();
});

it('clears a polling error when stop is confirmed and visibly offers a fresh conversation', async () => {
  service.send.mockResolvedValue(ok({ ...conversation, status: 'running' }));
  service.get.mockRejectedValue(new Error('offline'));
  const user = userEvent.setup(); render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  await user.type(screen.getByLabelText('发送给问问的消息'), '开始{Enter}');
  await screen.findByText('进度连接中断，任务可能仍在运行。');
  await user.click(screen.getByRole('button', { name: '停止回答' }));
  await screen.findByText('已停止。你可以继续补充问题。');
  expect(screen.queryByText('进度连接中断，任务可能仍在运行。')).not.toBeInTheDocument();
  const start = screen.getByRole('button', { name: '新对话' });
  expect(start).toHaveTextContent('新对话'); await user.click(start);
  expect(screen.queryByRole('button', { name: '重新读取进度' })).not.toBeInTheDocument();
});
