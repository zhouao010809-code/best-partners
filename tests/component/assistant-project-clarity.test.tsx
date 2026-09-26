import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AssistantPanel } from '../../src/client/components/assistant/AssistantPanel.js';
import { askAssistant, PROJECT_WORKSPACE_UPDATED_EVENT } from '../../src/client/components/assistant/assistantIntent.js';
import type { ReadConsoleApi } from '../../src/client/api/client.js';
import type { AssistantProvider } from '../../src/shared/api/assistant.js';
import type { AssistantDraft, AssistantDraftSave } from '../../src/shared/api/assistant-drafts.js';
import type { ProjectSummary } from '../../src/shared/api/projects.js';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const project: ProjectSummary = {
  id: '22c7a1d4-7cbf-4e92-9c64-ad175aa17d18', displayName: '黑骏画室知识库', sourceRevision: 7,
  availability: 'ready', outputRoot: 'AI工作区', fileCount: 112, readableFileCount: 105, issueCount: 0,
  createdAt: '2026-09-09T06:00:00Z', updatedAt: '2026-09-09T06:00:01Z'
};
const provider: AssistantProvider = { id: 'deepseek', name: 'DeepSeek', status: 'ready', defaultModel: 'deepseek-v4-pro', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', reasoningEfforts: [] }] };
const assistant = { providers: vi.fn(), history: vi.fn(), get: vi.fn(), send: vi.fn(), stop: vi.fn() };
const skills = { match: vi.fn() };
const projects = { get: vi.fn(), confirmWritePlan: vi.fn(), reconnect: vi.fn() };
const api = { assistant, skills, projects } as unknown as ReadConsoleApi;
const onRunningChange = vi.fn();
function open(path = `/projects/${project.id}`, client = api) {
  return render(<MemoryRouter initialEntries={[path]}><AssistantPanel api={client} open onClose={() => {}} width={430} onWidthChange={() => {}} onRunningChange={onRunningChange} /></MemoryRouter>);
}
function draftService() {
  const records = new Map<string, AssistantDraft>();
  let activeId: string | undefined;
  const assistantDrafts = {
    list: vi.fn(async () => ok({ drafts: [...records.values()], ...(activeId ? { activeId } : {}) })),
    save: vi.fn(async (id: string, input: AssistantDraftSave) => {
      const { expectedRevision, active: _active, ...fields } = input;
      const draft = { ...fields, id, revision: expectedRevision + 1, updatedAt: '2026-09-26', lastActive: '2026-09-26' };
      records.set(id, draft); activeId = id;
      return ok({ draft });
    }),
    delete: vi.fn()
  };
  return assistantDrafts;
}
beforeEach(() => {
  assistant.providers.mockResolvedValue(ok({ providers: [provider] }));
  assistant.history.mockResolvedValue(ok({ conversations: [] }));
  assistant.send.mockResolvedValue(ok({ id: '11c7a1d4-7cbf-4e92-9c64-ad175aa17d18', title: '项目重点', createdAt: '2026-09-09T06:00:00Z', updatedAt: '2026-09-09T06:00:01Z', status: 'idle', providerId: 'deepseek', model: 'deepseek-v4-pro', scope: 'project', projectId: project.id, projectRevision: 8, messages: [] }));
  skills.match.mockResolvedValue(ok({ candidates: [] }));
  projects.get.mockResolvedValue(ok(project));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('names the project once and explains reading and confirmed saving in ordinary language', async () => {
  open();
  expect(await screen.findByRole('heading', { name: '项目问问' })).toBeVisible();
  expect(await screen.findAllByText(project.displayName, { exact: true })).toHaveLength(1);
  const context = screen.getByRole('region', { name: '项目问问范围' });
  expect(within(context).getByText('围绕当前项目资料回答，可参考知识库；确认后保存到 AI工作区。')).toBeVisible();
  expect(within(context).getByText('项目资料已连接')).toBeVisible();
  expect(screen.queryByText(/项目语料：|全局知识库：|写入范围：/u)).not.toBeInTheDocument();
  expect(screen.getByText('当前项目资料', { exact: true })).toBeVisible();
  expect(screen.getByLabelText('发送给问问的消息')).toHaveAttribute('placeholder', '想了解这个项目的什么？');
});

it.each(['梳理项目重点', '找资料回答问题', '起草下一步计划'])('fills the %s task as an editable draft without sending or saving a project result', async (task) => {
  const user = userEvent.setup(); open();
  await screen.findByText(project.displayName, { exact: true });
  await user.click(screen.getByRole('button', { name: task }));
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue(task);
  expect(screen.getByLabelText('发送给问问的消息')).toHaveFocus();
  expect(assistant.send).not.toHaveBeenCalled();
  expect(skills.match).not.toHaveBeenCalled();
  expect(projects.confirmWritePlan).not.toHaveBeenCalled();
  expect(projects.reconnect).not.toHaveBeenCalled();
});

it.each([' ', ''])('reopens the current project using blank prompt %j without queueing a question or replacing its draft', async (prompt) => {
  const user = userEvent.setup(); open();
  await screen.findByText(project.displayName, { exact: true });
  await user.type(screen.getByLabelText('发送给问问的消息'), '尚未写完的项目问题');
  await user.click(screen.getByRole('button', { name: '历史对话' }));
  expect(screen.getByRole('button', { name: '返回对话' })).toBeVisible();
  await act(async () => { askAssistant({ prompt, scope: 'project', projectId: project.id, projectRevision: project.sourceRevision }); });
  expect(screen.queryByRole('button', { name: '返回对话' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '载入新提问' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue('尚未写完的项目问题');
  expect(assistant.send).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(assistant.send).toHaveBeenCalledTimes(1));
  expect(assistant.send.mock.calls[0]?.[0]).toMatchObject({ scope: 'project', projectId: project.id, projectRevision: project.sourceRevision, message: '尚未写完的项目问题' });
});

it.each([' ', ''])('rejects blank prompt %j addressed to another project without changing the current draft binding', async (prompt) => {
  const user = userEvent.setup(); open();
  await screen.findByText(project.displayName, { exact: true });
  await user.type(screen.getByLabelText('发送给问问的消息'), '只属于当前项目的草稿');
  await act(async () => { askAssistant({ prompt, scope: 'project', projectId: '33c7a1d4-7cbf-4e92-9c64-ad175aa17d18', projectRevision: 99 }); });
  expect(await screen.findByRole('alert')).toHaveTextContent('属于另一个项目');
  expect(screen.queryByRole('button', { name: '载入新提问' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue('只属于当前项目的草稿');
  expect(assistant.send).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(assistant.send).toHaveBeenCalledTimes(1));
  expect(assistant.send.mock.calls[0]?.[0]).toMatchObject({ scope: 'project', projectId: project.id, projectRevision: project.sourceRevision });
});

it('preserves a real queued question when the current project is opened again without a prompt', async () => {
  const user = userEvent.setup(); open();
  await screen.findByText(project.displayName, { exact: true });
  await user.type(screen.getByLabelText('发送给问问的消息'), '正在编辑的问题');
  await act(async () => { askAssistant({ prompt: '之后要写的项目复盘', scope: 'project', projectId: project.id }); });
  expect(screen.getByRole('button', { name: '载入新提问' })).toBeVisible();
  await act(async () => { askAssistant({ prompt: ' ', scope: 'project', projectId: project.id }); });
  await user.click(screen.getByRole('button', { name: '载入新提问' }));
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue('之后要写的项目复盘');
  expect(assistant.send).not.toHaveBeenCalled();
});

it('keeps the task draft when project data refreshes and sends the current project revision only after explicit send', async () => {
  const assistantDrafts = draftService();
  const user = userEvent.setup(); open(undefined, { ...api, assistantDrafts });
  await screen.findByText(project.displayName, { exact: true });
  await waitFor(() => expect(screen.getByLabelText('发送给问问的消息')).toBeEnabled());
  await user.click(screen.getByRole('button', { name: '梳理项目重点' }));
  projects.get.mockResolvedValue(ok({ ...project, sourceRevision: 8 }));
  await act(async () => { window.dispatchEvent(new CustomEvent(PROJECT_WORKSPACE_UPDATED_EVENT, { detail: { projectId: project.id } })); });
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue('梳理项目重点');
  expect(assistant.send).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(assistant.send).toHaveBeenCalledTimes(1));
  expect(assistant.send.mock.calls[0]?.[0]).toMatchObject({ message: '梳理项目重点', scope: 'project', projectId: project.id, projectRevision: 8 });
});

it.each([
  ['scanning', '正在扫描项目资料…'],
  ['reconnect-required', '项目资料需要重新连接'],
  ['unavailable', '项目资料暂不可用']
] as const)('keeps the %s project state visible instead of claiming readiness', async (availability, message) => {
  projects.get.mockResolvedValue(ok({ ...project, availability }));
  open();
  expect(await screen.findByText(message, { exact: true })).toBeVisible();
  expect(screen.queryByText('项目资料已连接')).not.toBeInTheDocument();
});

it('keeps a failed project read actionable without hiding the original error', async () => {
  projects.get.mockResolvedValueOnce({ ok: false, state: { status: 'operation-error', message: '项目文件夹当前无法读取。' } });
  const user = userEvent.setup(); open();
  expect(await screen.findByRole('alert')).toHaveTextContent('项目文件夹当前无法读取。');
  expect(screen.queryByText('正在读取项目', { exact: true })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '重新读取项目' }));
  await waitFor(() => expect(projects.get).toHaveBeenCalledTimes(2));
  expect(assistant.send).not.toHaveBeenCalled();
});

it('rebinds the project revision after retrying an initial read failure while preserving the unsent question', async () => {
  projects.get.mockResolvedValueOnce({ ok: false, state: { status: 'operation-error', message: '项目文件夹当前无法读取。' } });
  const assistantDrafts = draftService();
  const user = userEvent.setup(); open(undefined, { ...api, assistantDrafts });
  expect(await screen.findByRole('alert')).toHaveTextContent('项目文件夹当前无法读取。');
  const input = screen.getByLabelText('发送给问问的消息');
  await waitFor(() => expect(input).toBeEnabled());
  await user.type(input, '重试后继续这个问题');
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '重新读取项目' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled());
  expect(input).toHaveValue('重试后继续这个问题');
  expect(assistant.send).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(assistant.send).toHaveBeenCalledTimes(1));
  expect(assistant.send.mock.calls[0]?.[0]).toMatchObject({ message: '重试后继续这个问题', scope: 'project', projectId: project.id, projectRevision: project.sourceRevision });
});

it('unblocks a stale project after the workspace refresh succeeds without automatically resending', async () => {
  const assistantDrafts = draftService();
  const user = userEvent.setup(); open(undefined, { ...api, assistantDrafts });
  await screen.findByText(project.displayName, { exact: true });
  await waitFor(() => expect(screen.getByLabelText('发送给问问的消息')).toBeEnabled());
  await user.type(screen.getByLabelText('发送给问问的消息'), '资料更新后保留的问题');
  await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled());
  projects.get.mockResolvedValueOnce({ ok: false, state: { status: 'operation-error', message: '项目刷新失败，请重试。' } });
  assistant.send.mockResolvedValueOnce({ ok: false, code: 'PROJECT_REVISION_STALE', state: { status: 'operation-error', message: '项目资料已更新。' } });
  await user.click(screen.getByRole('button', { name: '发送消息' }));
  expect(await within(screen.getByRole('region', { name: '项目问问范围' })).findByRole('alert')).toHaveTextContent('项目刷新失败，请重试。');
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  projects.get.mockResolvedValue(ok({ ...project, sourceRevision: 9 }));
  await act(async () => { window.dispatchEvent(new CustomEvent(PROJECT_WORKSPACE_UPDATED_EVENT, { detail: { projectId: project.id } })); });
  await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled());
  expect(screen.getByLabelText('发送给问问的消息')).toHaveValue('资料更新后保留的问题');
  expect(assistant.send).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(assistant.send).toHaveBeenCalledTimes(2));
  expect(assistant.send.mock.calls[1]?.[0]).toMatchObject({ scope: 'project', projectId: project.id, projectRevision: 9 });
});

it('keeps the general brain welcome, suggestions and input wording unchanged', async () => {
  open('/');
  expect(await screen.findByRole('heading', { name: '问问' })).toBeVisible();
  expect(screen.getByText('让收藏，变成你的答案。')).toBeVisible();
  expect(screen.getByRole('button', { name: '找出大脑里关于创作的方法' })).toBeVisible();
  expect(screen.getByRole('button', { name: '搜索关于学习方法的知识' })).toBeVisible();
  expect(screen.getByRole('button', { name: '整理资料时，你能帮我做什么？' })).toBeVisible();
  await waitFor(() => expect(screen.getByLabelText('发送给问问的消息')).toHaveAttribute('placeholder', '问问你的大脑…'));
  expect(screen.queryByRole('region', { name: '项目问问范围' })).not.toBeInTheDocument();
});
