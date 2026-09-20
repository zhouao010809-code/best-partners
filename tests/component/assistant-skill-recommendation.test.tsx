import { useCallback, useState } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AssistantPanel } from '../../src/client/components/assistant/AssistantPanel.js';
import { askAssistant } from '../../src/client/components/assistant/assistantIntent.js';
import type { ReadConsoleApi } from '../../src/client/api/client.js';
import type { AssistantConversation, AssistantProvider } from '../../src/shared/api/assistant.js';
import type { SkillMatchCandidate } from '../../src/shared/api/skills.js';

const ok = <T,>(value: T) => ({ ok: true as const, value });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const provider: AssistantProvider = {
  id: 'deepseek',
  name: 'DeepSeek',
  status: 'ready',
  defaultModel: 'deepseek-v4-pro',
  defaultEffort: 'high',
  models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', reasoningEfforts: ['high'], recommended: true }]
};
const conversation: AssistantConversation = {
  id: '11c7a1d4-7cbf-4e92-9c64-ad175aa17d18',
  title: '问题',
  createdAt: '2026-09-09T06:00:00Z',
  updatedAt: '2026-09-09T06:00:01Z',
  status: 'idle',
  providerId: 'deepseek',
  model: 'deepseek-v4-pro',
  scope: 'brain',
  messages: [
    { id: 'user', role: 'user', text: '写一篇公众号文章', sources: [], actions: [] },
    { id: 'assistant', role: 'assistant', text: '回答', model: 'deepseek-v4-pro', sources: [], actions: [] }
  ]
};
const candidate = (name: string, id: string): SkillMatchCandidate => ({
  id,
  name,
  description: `${name} 的用途`,
  folderName: '写作',
  revision: `${id.slice(0, 63)}${id.slice(-1)}`,
  reason: 'Skill 名称与当前任务匹配'
});

const service = {
  providers: vi.fn(),
  history: vi.fn(),
  get: vi.fn(),
  send: vi.fn(),
  stop: vi.fn(),
  confirmAction: vi.fn(),
  cancelAction: vi.fn(),
  login: vi.fn()
};
const skills = { list: vi.fn(), get: vi.fn(), match: vi.fn() };

function Harness({ onClose = () => undefined }: { onClose?: () => void }) {
  const [width, setWidth] = useState(430);
  return <MemoryRouter><AssistantPanel api={{ assistant: service, skills } as unknown as ReadConsoleApi} open onClose={onClose} width={width} onWidthChange={setWidth} onRunningChange={() => undefined} /></MemoryRouter>;
}

beforeEach(() => {
  service.providers.mockResolvedValue(ok({ providers: [provider] }));
  service.history.mockResolvedValue(ok({ conversations: [] }));
  service.get.mockResolvedValue(ok(conversation));
  service.send.mockResolvedValue(ok(conversation));
  skills.match.mockResolvedValue(ok({ candidates: [candidate('公众号写作', 'a'.repeat(64)), candidate('内容润色', 'b'.repeat(64))] }));
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it('shows matching and candidates without sending before the user confirms', async () => {
  const user = userEvent.setup();
  const matching = deferred<ReturnType<typeof ok<{ candidates: SkillMatchCandidate[] }>>>();
  skills.match.mockImplementationOnce(() => matching.promise);
  render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));

  await user.type(screen.getByLabelText('发送给问问的消息'), '写一篇公众号文章{Enter}');

  expect(await screen.findByText('正在匹配适合的 Skill…')).toBeVisible();
  expect(skills.match).toHaveBeenCalledWith('写一篇公众号文章', expect.any(AbortSignal));
  expect(service.send).not.toHaveBeenCalled();
  matching.resolve(ok({ candidates: [candidate('公众号写作', 'a'.repeat(64)), candidate('内容润色', 'b'.repeat(64))] }));
  expect(await screen.findByText('公众号写作')).toBeVisible();
  expect(screen.getByRole('button', { name: '使用此 Skill' })).toBeVisible();
  expect(screen.getByRole('button', { name: '不用' })).toBeVisible();
  expect(screen.getByRole('button', { name: '换一个' })).toBeVisible();
});

it('switches candidates locally and only sends the selected revision after confirmation', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  await user.type(screen.getByLabelText('发送给问问的消息'), '写一篇公众号文章{Enter}');
  await screen.findByText('公众号写作');

  await user.click(screen.getByRole('button', { name: '换一个' }));
  expect(screen.getByText('内容润色')).toBeVisible();
  expect(skills.match).toHaveBeenCalledTimes(1);
  expect(service.send).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: '使用此 Skill' }));
  await waitFor(() => expect(service.send).toHaveBeenCalledTimes(1));
  expect(service.send.mock.calls[0]![0]).toMatchObject({
    message: '写一篇公众号文章',
    skillId: 'b'.repeat(64),
    skillRevision: `${'b'.repeat(63)}b`
  });
});

it('sends an ordinary payload when the user declines a recommendation', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  await user.type(screen.getByLabelText('发送给问问的消息'), '写一篇公众号文章{Enter}');
  await screen.findByText('公众号写作');

  await user.click(screen.getByRole('button', { name: '不用' }));
  await waitFor(() => expect(service.send).toHaveBeenCalledTimes(1));
  expect(service.send.mock.calls[0]![0]).not.toHaveProperty('skillId');
  expect(service.send.mock.calls[0]![0]).not.toHaveProperty('skillRevision');
});

it('invalidates a pending recommendation when the user edits the question', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  const input = screen.getByLabelText('发送给问问的消息');
  await user.type(input, '写一篇公众号文章{Enter}');
  await screen.findByText('公众号写作');

  await user.type(input, ' 改成短视频脚本');
  expect(screen.queryByText('公众号写作')).not.toBeInTheDocument();
  expect(screen.getByText('推荐已失效，请重新发送问题。')).toBeVisible();
  expect(service.send).not.toHaveBeenCalled();
});

it('offers ordinary continuation when matching is unavailable and does not retry matching after a failed send', async () => {
  skills.match.mockRejectedValueOnce(new Error('offline'));
  service.send.mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(ok(conversation));
  const user = userEvent.setup();
  render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  const input = screen.getByLabelText('发送给问问的消息');
  await user.type(input, '继续整理这份资料{Enter}');

  expect(skills.match).toHaveBeenCalledTimes(1);
  expect(await screen.findByText(/匹配服务暂不可用/u)).toBeVisible();
  await user.click(screen.getByRole('button', { name: '继续普通问问' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('尚未确认发送结果');
  expect(skills.match).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: '重试这条消息' }));
  await waitFor(() => expect(service.send).toHaveBeenCalledTimes(2));
  expect(skills.match).toHaveBeenCalledTimes(1);
});

it('sends normally when there are no candidates', async () => {
  skills.match.mockResolvedValue(ok({ candidates: [] }));
  const user = userEvent.setup();
  render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  await user.type(screen.getByLabelText('发送给问问的消息'), '没有匹配项的问题{Enter}');
  await waitFor(() => expect(service.send).toHaveBeenCalledTimes(1));
  expect(screen.queryByText('使用此 Skill')).not.toBeInTheDocument();
});

it('rematches instead of retrying an expired Skill as the same assistant request', async () => {
  const refreshed = candidate('公众号写作（新版）', 'c'.repeat(64));
  service.send
    .mockResolvedValueOnce({ ok: false, code: 'ASSISTANT_SKILL_STALE', state: { status: 'operation-error', message: '所选 Skill 已更新，请重新匹配后再试。' } })
    .mockResolvedValueOnce(ok(conversation));
  const user = userEvent.setup();
  render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  await user.type(screen.getByLabelText('发送给问问的消息'), '写一篇公众号文章{Enter}');
  await user.click(await screen.findByRole('button', { name: '使用此 Skill' }));

  expect(await screen.findByText('所选 Skill 已更新，请重新匹配后再试。')).toBeVisible();
  expect(screen.queryByRole('button', { name: '重试这条消息' })).not.toBeInTheDocument();
  skills.match.mockResolvedValueOnce(ok({ candidates: [refreshed] }));
  await user.click(screen.getByRole('button', { name: '重试匹配' }));
  expect(await screen.findByText('公众号写作（新版）')).toBeVisible();
  expect(skills.match).toHaveBeenCalledTimes(2);

  await user.click(screen.getByRole('button', { name: '使用此 Skill' }));
  await waitFor(() => expect(service.send).toHaveBeenCalledTimes(2));
  expect(service.send.mock.calls[1]![0]).toMatchObject({ skillId: refreshed.id, skillRevision: refreshed.revision });
});

it('clears a recommendation when an explicitly queued assistant intent is loaded', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('deepseek-v4-pro'));
  await user.type(screen.getByLabelText('发送给问问的消息'), '写一篇公众号文章{Enter}');
  await screen.findByText('公众号写作');

  await act(async () => { askAssistant({ prompt: '改成短视频脚本' }); });
  await user.click(screen.getByRole('button', { name: '载入新提问' }));

  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue('改成短视频脚本');
  expect(screen.queryByLabelText('Skill 推荐')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Skill 推荐已失效')).not.toBeInTheDocument();
  expect(service.send).not.toHaveBeenCalled();
});
