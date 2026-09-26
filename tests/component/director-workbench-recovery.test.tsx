import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AssistantProvider } from '../../src/shared/api/assistant.js';
import { creationCreateSchema, creationSaveSchema, type CreationDetail, type CreationSuggestion, type ProjectCreation } from '../../src/shared/api/project-creations.js';
import type { ApiClientResult, ReadConsoleApi } from '../../src/client/api/client.js';
import { CreationAssistant } from '../../src/client/components/projects/CreationAssistant.js';
import { CreationEditor } from '../../src/client/components/projects/CreationEditor.js';
import { ProjectWorkbench } from '../../src/client/components/projects/ProjectWorkbench.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const randomUUID = () => crypto.randomUUID();
const itemId = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-09-26T00:00:00Z';
const ok = <T,>(value: T) => ({ ok: true as const, value });
const provider: AssistantProvider = { id: 'deepseek', name: 'DeepSeek', status: 'ready', defaultModel: 'deepseek-v4-pro', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', reasoningEfforts: [] }] };
const original: ProjectCreation = { id: itemId, projectId, kind: 'script', title: '隔离测试稿件', brief: '保留真实限制', body: '原来的开头。\n保持正文。', audience: '', angle: '', rationale: '', sources: [], revision: 1, createdAt: timestamp, updatedAt: timestamp };
const detail = (item: ProjectCreation): CreationDetail => ({ item, versions: [], messages: [] });
const suggestion = (patch: Partial<CreationSuggestion> = {}): CreationSuggestion => ({ id: randomUUID(), task: 'discuss', reply: '独立讨论回复', topics: [], sources: [], baseRevision: 1, createdAt: timestamp, ...patch });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(item: ProjectCreation = structuredClone(original)) {
  let stored = detail(item);
  const get = vi.fn<NonNullable<ReadConsoleApi['creations']>['get']>(async () => ok(structuredClone(stored)));
  const list = vi.fn<NonNullable<ReadConsoleApi['creations']>['list']>(async () => ok({ items: [structuredClone(stored.item)] }));
  const save = vi.fn<NonNullable<ReadConsoleApi['creations']>['save']>(async (_projectId, _id, input) => {
    const parsed = creationSaveSchema.safeParse(input);
    if (!parsed.success) return { ok: false, code: 'CREATION_INVALID', state: { status: 'operation-error', message: '创作格式不完整。' } };
    const { expectedRevision, ...fields } = parsed.data;
    stored = { ...stored, item: { ...stored.item, ...fields, revision: expectedRevision + 1 } };
    return ok(structuredClone(stored));
  });
  const create = vi.fn<NonNullable<ReadConsoleApi['creations']>['create']>(async (_projectId, input) => ok(detail({ ...original, ...creationCreateSchema.parse(input), id: randomUUID() })));
  const suggest = vi.fn<NonNullable<ReadConsoleApi['creations']>['suggest']>().mockResolvedValue(ok(suggestion()));
  const providers = vi.fn<NonNullable<ReadConsoleApi['assistant']>['providers']>(async () => ok({ providers: [provider] }));
  const api = { creations: { get, list, save, create, suggest, snapshot: vi.fn(), exportVersion: vi.fn() }, assistant: { providers } } as unknown as ReadConsoleApi;
  return { api, get, list, save, create, suggest, providers, get stored() { return stored; } };
}
function editor(f: ReturnType<typeof fixture>) {
  return <CreationEditor api={f.api} projectId={projectId} id={itemId} onBack={vi.fn()} onSaved={vi.fn()} onOpen={vi.fn()} />;
}
async function ready() {
  await screen.findByRole('textbox', { name: '脚本正文' });
  await waitFor(() => expect(screen.getByRole('button', { name: '根据资料起草' })).toBeEnabled());
}
beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

it('deduplicates the optimistic discussion when its persisted exchange has a different outer id', async () => {
  const f = fixture(); const answer = suggestion(); f.suggest.mockResolvedValue(ok(answer));
  const props = { api: f.api, projectId, draft: original, persistedDraft: original, flush: async () => original, onAdopt: vi.fn(async () => true) };
  const view = render(<MemoryRouter><CreationAssistant {...props} messages={[]} /></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole('button', { name: '根据资料起草' })).toBeEnabled());
  fireEvent.change(screen.getByRole('textbox', { name: '给问问的要求' }), { target: { value: '讨论这条内容' } });
  fireEvent.change(screen.getByRole('combobox', { name: '处理方式' }), { target: { value: 'discuss' } });
  fireEvent.click(screen.getByRole('button', { name: '发送给问问' }));
  expect(await screen.findByText('本条讨论 · 1')).toBeInTheDocument();
  view.rerender(<MemoryRouter><CreationAssistant {...props} messages={[{ id: randomUUID(), instruction: '讨论这条内容', suggestion: answer, createdAt: timestamp }]} /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText('本条讨论 · 1')).toBeInTheDocument());
  expect(screen.queryByText('本条讨论 · 2')).not.toBeInTheDocument();
  expect(screen.getAllByText('讨论这条内容')).toHaveLength(1);
});

it('restores an unsent assistant request after visiting model settings and reopening the same item', async () => {
  const f = fixture(); f.providers.mockResolvedValue(ok({ providers: [{ ...provider, status: 'unconfigured' }] }));
  render(<MemoryRouter initialEntries={['/edit']}><Routes><Route path="/edit" element={editor(f)} /><Route path="/settings" element={<Link to="/edit">返回原稿件</Link>} /></Routes></MemoryRouter>);
  const input = await screen.findByRole('textbox', { name: '给问问的要求' });
  fireEvent.change(input, { target: { value: '尚未发送：保留最后的真实课堂案例。' } });
  fireEvent.click(await screen.findByRole('link', { name: '前往模型设置' }));
  expect(screen.queryByRole('textbox', { name: '给问问的要求' })).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole('link', { name: '返回原稿件' }));
  expect(await screen.findByRole('textbox', { name: '给问问的要求' })).toHaveValue('尚未发送：保留最后的真实课堂案例。');
  expect(f.suggest).not.toHaveBeenCalled();
  expect(f.save).not.toHaveBeenCalled();
});

it('restores a planner request after an unconfigured-model failure and the settings round-trip', async () => {
  const f = fixture(); f.suggest.mockResolvedValue({ ok: false, code: 'ASSISTANT_NOT_CONFIGURED', state: { status: 'operation-error', message: '请先连接模型。' } });
  render(<MemoryRouter initialEntries={['/desk']}><Routes><Route path="/desk" element={<ProjectWorkbench api={f.api} projectId={projectId} files={<p>隔离资料</p>} />} /><Route path="/settings" element={<Link to="/desk">返回项目</Link>} /></Routes></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: '策划选题' }));
  fireEvent.change(screen.getByRole('textbox', { name: '选题要求' }), { target: { value: '给家长策划三条课堂观察选题。' } });
  fireEvent.click(screen.getByRole('button', { name: '根据资料策划' }));
  fireEvent.click(await screen.findByRole('link', { name: '模型设置' }));
  fireEvent.click(await screen.findByRole('link', { name: '返回项目' }));
  fireEvent.click(await screen.findByRole('button', { name: '策划选题' }));
  expect(screen.getByRole('textbox', { name: '选题要求' })).toHaveValue('给家长策划三条课堂观察选题。');
  expect(f.create).not.toHaveBeenCalled();
});

it('refuses local adoption beyond 100 sources and leaves the manuscript saveable', async () => {
  const sources = Array.from({ length: 100 }, (_, index) => ({ id: `S${index + 1}`, path: `project:${projectId}/资料${index + 1}.md`, title: `资料${index + 1}`, kind: 'read' as const }));
  const f = fixture({ ...original, sources });
  f.suggest.mockResolvedValue(ok(suggestion({ task: 'revise', replacement: { before: '原来的开头。', after: '新开头 [S101]', start: 0, end: 6 }, sources: [{ id: 'S101', path: `project:${projectId}/新资料.md`, title: '新资料', kind: 'read' }] })));
  render(<MemoryRouter>{editor(f)}</MemoryRouter>); await ready();
  const body = screen.getByRole('textbox', { name: '脚本正文' }) as HTMLTextAreaElement;
  body.focus(); body.setSelectionRange(0, 6); fireEvent.select(body);
  fireEvent.click(screen.getByRole('button', { name: '修改选中段落' }));
  fireEvent.click(await screen.findByRole('button', { name: '采用到正文' }));
  expect(await screen.findByText(/超过100条参考来源/u)).toBeVisible();
  expect(body).toHaveValue(original.body);
  expect(f.save).not.toHaveBeenCalled();
  expect(localStorage.getItem(`creation-draft-v1:${projectId}:${itemId}`)).toBeNull();
  expect(screen.getByRole('button', { name: '采用到正文' })).toBeEnabled();
  fireEvent.change(screen.getByRole('textbox', { name: '内容标题' }), { target: { value: '继续手写的标题' } });
  await waitFor(() => expect(f.save).toHaveBeenCalledOnce());
  expect(f.save.mock.calls[0]![2]).toMatchObject({ title: '继续手写的标题', body: original.body, sources });
  expect(await screen.findByText('已保存到本机')).toBeVisible();
});

it('ignores an old planner response after stopping it and starting a new request', async () => {
  const f = fixture(); const oldPlan = deferred<ApiClientResult<CreationSuggestion>>(); const nextPlan = deferred<ApiClientResult<CreationSuggestion>>();
  const oldTopic = { title: '旧轮选题', audience: '家长', angle: '旧角度', rationale: '旧依据' };
  const newTopic = { title: '新轮选题', audience: '家长', angle: '新角度', rationale: '新依据' };
  f.suggest.mockReturnValueOnce(oldPlan.promise).mockReturnValueOnce(nextPlan.promise);
  render(<MemoryRouter><ProjectWorkbench api={f.api} projectId={projectId} files={<p>隔离资料</p>} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: '策划选题' }));
  fireEvent.change(screen.getByRole('textbox', { name: '选题要求' }), { target: { value: '第一轮要求' } });
  fireEvent.click(screen.getByRole('button', { name: '根据资料策划' }));
  await waitFor(() => expect(f.suggest).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: '停止策划' }));
  fireEvent.change(screen.getByRole('textbox', { name: '选题要求' }), { target: { value: '第二轮要求，不能被旧结果关闭' } });
  fireEvent.click(screen.getByRole('button', { name: '根据资料策划' }));
  await waitFor(() => expect(f.suggest).toHaveBeenCalledTimes(2));
  await act(async () => oldPlan.resolve(ok(suggestion({ task: 'topics', reply: '旧轮回复不可覆盖新轮', topics: [oldTopic] }))));
  expect(screen.getByRole('textbox', { name: '选题要求' })).toHaveValue('第二轮要求，不能被旧结果关闭');
  expect(screen.getByRole('button', { name: '停止策划' })).toBeEnabled();
  expect(screen.queryByText('旧轮回复不可覆盖新轮')).not.toBeInTheDocument();
  expect(screen.getByRole('tab', { name: '创作台' })).toHaveAttribute('aria-selected', 'true');
  await act(async () => nextPlan.resolve(ok(suggestion({ task: 'topics', reply: '新轮已经完成', topics: [newTopic] }))));
  expect(await screen.findByText('新轮已经完成')).toBeVisible();
  expect(screen.getByRole('checkbox', { name: '保留选题：新轮选题' })).toBeVisible();
  expect(screen.queryByRole('checkbox', { name: '保留选题：旧轮选题' })).not.toBeInTheDocument();
  expect(f.create).not.toHaveBeenCalled();
});

it('keeps the planner open and explains an empty topic result without losing the request', async () => {
  const f = fixture(); f.suggest.mockResolvedValue(ok(suggestion({ task: 'topics', topics: [], reply: '项目事实待补充，请补充课程安排。' })));
  render(<MemoryRouter><ProjectWorkbench api={f.api} projectId={projectId} files={<p>隔离资料</p>} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: '策划选题' }));
  fireEvent.change(screen.getByRole('textbox', { name: '选题要求' }), { target: { value: '根据课程安排策划选题' } });
  fireEvent.click(screen.getByRole('button', { name: '根据资料策划' }));
  expect(await screen.findByText('这次还没有可保存的选题。项目事实待补充，请补充课程安排。')).toBeVisible();
  expect(screen.getByRole('textbox', { name: '选题要求' })).toHaveValue('根据课程安排策划选题');
  expect(screen.getByRole('button', { name: '根据资料策划' })).toBeEnabled();
  expect(f.create).not.toHaveBeenCalled();
});
