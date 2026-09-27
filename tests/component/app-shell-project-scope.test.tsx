import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AppShell } from '../../src/client/app/AppShell.js';
import { askAssistant } from '../../src/client/components/assistant/assistantIntent.js';
import type { ReadConsoleApi } from '../../src/client/api/client.js';
import type { AssistantConversation, AssistantSend } from '../../src/shared/api/assistant.js';
import type { AssistantDraft, AssistantDraftSave } from '../../src/shared/api/assistant-drafts.js';
import type { ProjectSummary } from '../../src/shared/api/projects.js';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const project: ProjectSummary = {
  id: '22c7a1d4-7cbf-4e92-9c64-ad175aa17d18', displayName: '测试画室', sourceRevision: 7,
  availability: 'ready', outputRoot: 'AI工作区', fileCount: 55, readableFileCount: 55, issueCount: 0,
  createdAt: '2026-09-28', updatedAt: '2026-09-28'
};

function mount() {
  const records = new Map<string, AssistantDraft>();
  const active = new Map<string, string>();
  const conversations = new Map<string, AssistantConversation>();
  const assistant = {
    providers: vi.fn(async () => ok({ providers: [{ id: 'deepseek', name: 'DeepSeek', status: 'ready', defaultModel: 'deepseek-v4-pro', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', reasoningEfforts: [] }] }] })),
    history: vi.fn(async () => ok({ conversations: [] })),
    get: vi.fn(async (id: string) => ok(conversations.get(id)!)),
    send: vi.fn(async (input: AssistantSend) => {
      const conversation: AssistantConversation = { ...input, id: crypto.randomUUID(), title: input.message, status: 'idle', messages: [], createdAt: '2026-09-28', updatedAt: '2026-09-28' };
      conversations.set(conversation.id, conversation);
      return ok(conversation);
    })
  };
  const assistantDrafts = {
    list: vi.fn(async (_signal?: AbortSignal, query?: { projectId?: string }) => ok({
      drafts: [...records.values()].filter(item => item.projectId === query?.projectId),
      ...(active.get(query?.projectId ?? 'brain') ? { activeId: active.get(query?.projectId ?? 'brain') } : {})
    })),
    save: vi.fn(async (id: string, input: AssistantDraftSave) => {
      const { expectedRevision, active: makeActive, ...fields } = input;
      const draft = { ...fields, id, revision: expectedRevision + 1, updatedAt: '2026-09-28', lastActive: '2026-09-28' };
      records.set(id, draft);
      if (makeActive) active.set(draft.projectId ?? 'brain', id);
      return ok({ draft });
    })
  };
  const api = { assistant, assistantDrafts, skills: { match: vi.fn(async () => ok({ candidates: [] })) }, projects: { get: vi.fn(async (id: string) => ok({ ...project, id, ...(id !== project.id ? { displayName: '另一个测试项目', sourceRevision: 9 } : {}) })) } } as unknown as ReadConsoleApi;
  render(<MemoryRouter initialEntries={[`/projects/${project.id}`]}><Routes><Route element={<AppShell api={api} suspendDataEffects />}><Route path="*" element={<>
    <button type="button" onClick={() => askAssistant({ prompt: '' })}>打开项目问问</button>
    <Link to={`/projects/${project.id}`}>返回测试项目</Link>
    <Link to="/projects/other-project">打开另一个测试项目</Link>
  </>} /></Route></Routes></MemoryRouter>);
  return { assistant, assistantDrafts };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('keeps the project draft and search scope while browsing Skills and returning to the project', async () => {
  const user = userEvent.setup(); const { assistant } = mount();
  await user.click(screen.getByRole('button', { name: '打开项目问问' }));
  await screen.findByText(project.displayName, { exact: true });
  await user.type(screen.getByLabelText('发送给问问的消息'), '帮我找中考美术资料');
  await user.click(screen.getByRole('link', { name: 'Skill 库' }));
  expect(screen.getByRole('region', { name: '项目问问范围' })).toBeVisible();
  expect(within(screen.getByRole('complementary', { name: '问问 AI' })).getByText(project.displayName)).toBeVisible();
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue('帮我找中考美术资料');
  await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(assistant.send).toHaveBeenCalledOnce());
  expect(assistant.send.mock.calls[0]?.[0]).toMatchObject({ scope: 'project', projectId: project.id, projectRevision: 7 });
  await user.click(screen.getByRole('link', { name: '返回测试项目' }));
  expect(screen.getByRole('region', { name: '项目问问范围' })).toBeVisible();
  expect(screen.getByText(project.displayName, { exact: true })).toBeVisible();
  await user.click(screen.getByRole('link', { name: '打开另一个测试项目' }));
  await user.click(screen.getByRole('button', { name: '打开项目问问' }));
  await screen.findByText('另一个测试项目', { exact: true });
  await user.type(screen.getByLabelText('发送给问问的消息'), '查这个项目');
  await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(assistant.send).toHaveBeenCalledTimes(2));
  expect(assistant.send.mock.calls[1]?.[0]).toMatchObject({ scope: 'project', projectId: 'other-project', projectRevision: 9 });
});

it.each(['大脑总览', '知识库', '我的项目'])('clears the retained project when explicitly entering %s, including a later visit to Skills', async (page) => {
  const user = userEvent.setup(); const { assistant } = mount();
  await user.click(screen.getByRole('button', { name: '打开项目问问' }));
  await screen.findByText(project.displayName, { exact: true });
  await user.click(screen.getByRole('link', { name: 'Skill 库' }));
  await user.click(screen.getByRole('link', { name: page }));
  await waitFor(() => expect(screen.getByLabelText('资料范围')).toHaveValue('brain'));
  expect(screen.queryByRole('region', { name: '项目问问范围' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('link', { name: 'Skill 库' }));
  expect(screen.getByLabelText('资料范围')).toHaveValue('brain');
  await user.type(screen.getByLabelText('发送给问问的消息'), '查大脑知识库');
  await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(assistant.send).toHaveBeenCalledOnce());
  expect(assistant.send.mock.calls[0]?.[0]).toMatchObject({ scope: 'brain' });
  expect(assistant.send.mock.calls[0]?.[0]).not.toHaveProperty('projectId');
});
