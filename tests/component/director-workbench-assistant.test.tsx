import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ApiClientResult, ReadConsoleApi } from '../../src/client/api/client.js';
import type { AssistantProvider } from '../../src/shared/api/assistant.js';
import type { CreationDetail, CreationSave, CreationSuggestion, ProjectCreation } from '../../src/shared/api/project-creations.js';
import { CreationEditor } from '../../src/client/components/projects/CreationEditor.js';
import { ProjectWorkbench } from '../../src/client/components/projects/ProjectWorkbench.js';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const randomUUID = () => crypto.randomUUID();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const projectId = '11111111-1111-4111-8111-111111111111';
const firstId = '22222222-2222-4222-8222-222222222222';
const secondId = '33333333-3333-4333-8333-333333333333';
const timestamp = '2026-09-26T00:00:00.000Z';
const originalBody = '开场保持原样。\n需要修改的这一段。\n结尾保持原样。';
const provider: AssistantProvider = {
  id: 'deepseek', name: 'DeepSeek', status: 'ready', defaultModel: 'deepseek-v4-pro',
  models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', reasoningEfforts: [] }]
};

function creation(id = firstId, title = '第一条内容', body = originalBody): ProjectCreation {
  return { id, projectId, kind: 'script', title, brief: '不虚构事实，保留客户给出的限制。', body,
    audience: '', angle: '', rationale: '', sources: [], revision: 1, createdAt: timestamp, updatedAt: timestamp };
}
function suggestion(overrides: Partial<CreationSuggestion> = {}): CreationSuggestion {
  return { id: randomUUID(), task: 'script', reply: '这是一份尚未采用的建议。', topics: [], body: 'AI 建议的新脚本。',
    sources: [], baseRevision: 1, createdAt: timestamp, ...overrides };
}
function fixture(items = [creation()]) {
  const stored = new Map(items.map(item => [item.id, { item: structuredClone(item), versions: [], messages: [] } as CreationDetail]));
  const get = vi.fn(async (_projectId: string, id: string, _signal?: AbortSignal) => ok(structuredClone(stored.get(id)!)));
  const list = vi.fn(async () => ok({ items: [...stored.values()].map(detail => structuredClone(detail.item)) }));
  const save = vi.fn(async (_projectId: string, id: string, input: CreationSave): Promise<ApiClientResult<CreationDetail>> => {
    const previous = stored.get(id)!;
    if (input.expectedRevision !== previous.item.revision) return { ok: false, code: 'CREATION_REVISION_CONFLICT', state: { status: 'conflict', message: '稿件已有更新。' } };
    const { expectedRevision, ...fields } = input;
    const detail = { ...previous, item: { ...previous.item, ...fields, revision: expectedRevision + 1 } };
    stored.set(id, structuredClone(detail));
    return ok(structuredClone(detail));
  });
  function snapshotValue(id: string, finalize = false): CreationDetail {
    const previous = stored.get(id)!;
    const version = { id: randomUUID(), creationId: id, number: previous.versions.length + 1,
      title: previous.item.title, brief: previous.item.brief, body: previous.item.body, sources: previous.item.sources, createdAt: timestamp };
    const detail = { ...previous, item: { ...previous.item, revision: previous.item.revision + 1,
      ...(finalize ? { finalVersionId: version.id } : {}) }, versions: [version, ...previous.versions] };
    stored.set(id, structuredClone(detail));
    return structuredClone(detail);
  }
  const snapshot = vi.fn(async (_projectId: string, id: string, input: { expectedRevision: number; finalize: boolean }): Promise<ApiClientResult<CreationDetail>> => ok(snapshotValue(id, input.finalize)));
  const suggest = vi.fn<NonNullable<ReadConsoleApi['creations']>['suggest']>().mockResolvedValue(ok(suggestion()));
  const api = { creations: { get, list, save, snapshot, suggest }, assistant: { providers: vi.fn(async () => ok({ providers: [provider] })) } } as unknown as ReadConsoleApi;
  return { api, stored, get, list, save, snapshot, snapshotValue, suggest };
}

function editor(f: ReturnType<typeof fixture>) {
  return render(<MemoryRouter><CreationEditor api={f.api} projectId={projectId} id={firstId} onBack={vi.fn()} onSaved={vi.fn()} onOpen={vi.fn()} /></MemoryRouter>);
}
async function ready() {
  await screen.findByRole('textbox', { name: '脚本正文' });
  await waitFor(() => expect(screen.getByRole('button', { name: '根据资料起草' })).toBeEnabled());
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

it('keeps a manual edit made while AI is running and refuses the late suggestion before adopting anything', async () => {
  const f = fixture();
  const late = deferred<ApiClientResult<CreationSuggestion>>();
  f.suggest.mockReturnValueOnce(late.promise);
  editor(f); await ready();
  fireEvent.click(screen.getByRole('button', { name: '根据资料起草' }));
  await waitFor(() => expect(f.suggest).toHaveBeenCalledOnce());
  expect(f.suggest.mock.calls[0]![1]).toMatchObject({ task: 'script', itemId: firstId, expectedRevision: 1 });
  const manualBody = `${originalBody}\n编导刚刚加入的新限制。`;
  fireEvent.change(screen.getByRole('textbox', { name: '脚本正文' }), { target: { value: manualBody } });
  expect(f.save).not.toHaveBeenCalled();
  await act(async () => late.resolve(ok(suggestion({ body: '已过期的 AI 整稿' }))));
  expect(screen.getByRole('textbox', { name: '脚本正文' })).toHaveValue(manualBody);
  expect(screen.getByRole('button', { name: '采用到正文' })).toBeDisabled();
  expect(screen.getByText(/正文或版本已变化/u)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '采用到正文' }));
  expect(screen.getByRole('textbox', { name: '脚本正文' })).toHaveValue(manualBody);
  await waitFor(() => expect(f.stored.get(firstId)!.item.body).toBe(manualBody));
  expect(f.stored.get(firstId)!.versions).toEqual([]);
});

it('shows a selected-passage suggestion without changing the script, then adopts only that passage', async () => {
  const f = fixture(); const user = userEvent.setup();
  const before = '需要修改的这一段。';
  const start = originalBody.indexOf(before); const end = start + before.length;
  const after = '只替换这一段，让口播更直接。';
  const localSuggestion = suggestion({ task: 'revise', body: undefined, replacement: { before, after, start, end } });
  f.suggest.mockResolvedValueOnce(ok(localSuggestion));
  editor(f); await ready();
  const body = screen.getByRole('textbox', { name: '脚本正文' }) as HTMLTextAreaElement;
  body.focus(); body.setSelectionRange(start, end); fireEvent.select(body);
  await waitFor(() => expect(screen.getByRole('button', { name: '修改选中段落' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: '修改选中段落' }));
  const pending = await screen.findByRole('region', { name: '问问的修改建议' });
  expect(f.suggest.mock.calls[0]![1]).toMatchObject({ task: 'revise', itemId: firstId, expectedRevision: 1, selection: { text: before, start, end } });
  expect(within(pending).getByText(after, { exact: true })).toBeVisible();
  expect(body).toHaveValue(originalBody);
  expect(f.save).not.toHaveBeenCalled();
  await user.click(within(pending).getByRole('button', { name: '采用到正文' }));
  const adopted = originalBody.slice(0, start) + after + originalBody.slice(end);
  expect(body).toHaveValue(adopted);
  await waitFor(() => expect(f.stored.get(firstId)!.item.body).toBe(adopted));
  expect(adopted.startsWith('开场保持原样。\n')).toBe(true);
  expect(adopted.endsWith('\n结尾保持原样。')).toBe(true);
  expect(f.stored.get(firstId)!.versions).toEqual([]);
});

it('locks suggestion adoption during an in-flight snapshot and never replaces the saved body with that suggestion', async () => {
  const f = fixture(); const user = userEvent.setup();
  const saving = deferred<ApiClientResult<CreationDetail>>();
  f.snapshot.mockReturnValueOnce(saving.promise);
  editor(f); await ready();
  await user.click(screen.getByRole('button', { name: '根据资料起草' }));
  const adopt = await screen.findByRole('button', { name: '采用到正文' });
  expect(adopt).toBeEnabled();
  await user.click(screen.getByRole('button', { name: '保存版本' }));
  await waitFor(() => expect(f.snapshot).toHaveBeenCalledOnce());
  expect(adopt).toBeDisabled();
  expect(screen.getByRole('textbox', { name: '脚本正文' })).toBeDisabled();
  await user.click(adopt);
  expect(screen.getByRole('textbox', { name: '脚本正文' })).toHaveValue(originalBody);
  await act(async () => saving.resolve(ok(f.snapshotValue(firstId))));
  await waitFor(() => expect(screen.getByRole('textbox', { name: '脚本正文' })).toBeEnabled());
  expect(screen.getByRole('textbox', { name: '脚本正文' })).toHaveValue(originalBody);
  expect(f.stored.get(firstId)!.versions[0]!.body).toBe(originalBody);
  expect(f.save).not.toHaveBeenCalled();
});

it('flushes the first item when returning to the workbench and discards its late AI result after opening another item', async () => {
  const f = fixture([creation(), creation(secondId, '第二条内容', '第二条原稿，不能混入第一条。')]);
  const user = userEvent.setup();
  const late = deferred<ApiClientResult<CreationSuggestion>>();
  f.suggest.mockReturnValueOnce(late.promise);
  render(<MemoryRouter><ProjectWorkbench api={f.api} projectId={projectId} files={<p>隔离资料入口</p>} /></MemoryRouter>);
  await user.click(await screen.findByRole('button', { name: '打开创作：第一条内容' }));
  await ready();
  await user.click(screen.getByRole('button', { name: '根据资料起草' }));
  await waitFor(() => expect(f.suggest).toHaveBeenCalledOnce());
  const firstSignal = f.suggest.mock.calls[0]![2]!;
  fireEvent.change(screen.getByRole('textbox', { name: '脚本正文' }), { target: { value: '第一条刚写下的独立编辑。' } });
  await user.click(screen.getByRole('button', { name: '返回创作台' }));
  await user.click(await screen.findByRole('button', { name: '打开创作：第二条内容' }));
  await ready();
  expect(firstSignal.aborted).toBe(true);
  expect(screen.getByRole('textbox', { name: '内容标题' })).toHaveValue('第二条内容');
  expect(screen.getByRole('textbox', { name: '脚本正文' })).toHaveValue('第二条原稿，不能混入第一条。');
  await act(async () => late.resolve(ok(suggestion({ body: '第一条的迟到建议，不应进入第二条。' }))));
  expect(screen.queryByRole('region', { name: '问问的修改建议' })).not.toBeInTheDocument();
  expect(screen.queryByText('第一条的迟到建议，不应进入第二条。')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '脚本正文' })).toHaveValue('第二条原稿，不能混入第一条。');
  expect(f.stored.get(firstId)!.item.body).toBe('第一条刚写下的独立编辑。');
  expect(f.stored.get(secondId)!.item.body).toBe('第二条原稿，不能混入第一条。');
  expect(f.save.mock.calls.every(call => call[1] === firstId)).toBe(true);
  await user.click(screen.getByRole('button', { name: '返回创作台' }));
  await user.click(await screen.findByRole('button', { name: '打开创作：第一条内容' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: '脚本正文' })).toHaveValue('第一条刚写下的独立编辑。'));
});

it('preserves the next instruction typed while the previous AI request is pending', async () => {
  const f = fixture();
  const late = deferred<ApiClientResult<CreationSuggestion>>();
  f.suggest.mockReturnValueOnce(late.promise);
  editor(f); await ready();
  const input = screen.getByRole('textbox', { name: '给问问的要求' });
  fireEvent.change(input, { target: { value: '先修改开头' } });
  fireEvent.click(screen.getByRole('button', { name: '发送给问问' }));
  await waitFor(() => expect(f.suggest).toHaveBeenCalledOnce());
  fireEvent.change(input, { target: { value: '下一条要求还没发送，请保留' } });
  await act(async () => late.resolve(ok(suggestion({ task: 'revise' }))));
  expect(await screen.findByRole('region', { name: '问问的修改建议' })).toBeVisible();
  expect(input).toHaveValue('下一条要求还没发送，请保留');
  expect(f.suggest).toHaveBeenCalledOnce();
  expect(f.suggest.mock.calls[0]![1].instruction).toBe('先修改开头');
});

it('does not clear an unsent instruction when a quick drafting action finishes', async () => {
  const f = fixture();
  editor(f); await ready();
  const input = screen.getByRole('textbox', { name: '给问问的要求' });
  fireEvent.change(input, { target: { value: '稍后再问的独立问题' } });
  fireEvent.click(screen.getByRole('button', { name: '根据资料起草' }));
  await screen.findByRole('region', { name: '问问的修改建议' });
  expect(input).toHaveValue('稍后再问的独立问题');
  expect(f.suggest).toHaveBeenCalledOnce();
  expect(f.suggest.mock.calls[0]![1].instruction).not.toBe('稍后再问的独立问题');
});

it('keeps the reopened editor recovery draft when an unmounted editor finishes an older save', async () => {
  const f = fixture();
  const oldSave = deferred<ApiClientResult<CreationDetail>>();
  f.save.mockReturnValueOnce(oldSave.promise);
  const old = editor(f); await ready();
  const oldBody = '旧编辑器等待保存的内容。';
  fireEvent.change(screen.getByRole('textbox', { name: '脚本正文' }), { target: { value: oldBody } });
  await waitFor(() => expect(f.save).toHaveBeenCalledOnce());
  old.unmount();
  editor(f); await ready();
  expect(screen.getByRole('textbox', { name: '脚本正文' })).toHaveValue(oldBody);
  const newerBody = '重新打开之后刚写的新内容，不能被旧请求清掉。';
  fireEvent.change(screen.getByRole('textbox', { name: '脚本正文' }), { target: { value: newerBody } });
  const cacheKey = `creation-draft-v1:${projectId}:${firstId}`;
  expect(JSON.parse(localStorage.getItem(cacheKey)!)).toMatchObject({ body: newerBody });
  const oldResult = { ...f.stored.get(firstId)!, item: { ...creation(), body: oldBody, revision: 2 } };
  f.stored.set(firstId, structuredClone(oldResult));
  await act(async () => oldSave.resolve(ok(oldResult)));
  expect(screen.getByRole('textbox', { name: '脚本正文' })).toHaveValue(newerBody);
  expect(JSON.parse(localStorage.getItem(cacheKey)!)).toMatchObject({ body: newerBody });
});

it('accepts a server-normalized title after one save instead of repeatedly saving the whitespace', async () => {
  const f = fixture();
  f.save.mockImplementation(async (_projectId, id, input) => {
    if (f.save.mock.calls.length > 1) return { ok: false, state: { status: 'operation-error', message: '重复保存应当被测试捕获。' } };
    const { expectedRevision, ...fields } = input;
    const previous = f.stored.get(id)!;
    const detail = { ...previous, item: { ...previous.item, ...fields, title: fields.title.trim(), revision: expectedRevision + 1 } };
    f.stored.set(id, detail);
    return ok(detail);
  });
  editor(f); await ready();
  fireEvent.change(screen.getByRole('textbox', { name: '内容标题' }), { target: { value: '  正常标题  ' } });
  await waitFor(() => expect(f.save).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByRole('textbox', { name: '内容标题' })).toHaveValue('正常标题'));
  expect(screen.getByText('已保存到本机', { exact: true })).toBeVisible();
  expect(f.save).toHaveBeenCalledOnce();
  expect(f.stored.get(firstId)!.item).toMatchObject({ title: '正常标题', revision: 2 });
});

it('does not revive an old AI suggestion against newer unsaved recovery text that still has the same revision', async () => {
  const f = fixture();
  const historySuggestion = suggestion({ body: '旧历史建议，不能覆盖恢复中的手稿。' });
  f.stored.get(firstId)!.messages = [{ id: randomUUID(), instruction: '旧的创作要求', suggestion: historySuggestion, createdAt: timestamp }];
  const recoveredBody = '保存前中断，后来恢复的编导手稿。';
  localStorage.setItem(`creation-draft-v1:${projectId}:${firstId}`, JSON.stringify({ ...creation(), body: recoveredBody }));
  editor(f); await ready();
  expect(screen.getByRole('textbox', { name: '脚本正文' })).toHaveValue(recoveredBody);
  expect(screen.queryByRole('region', { name: '问问的修改建议' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '采用到正文' })).not.toBeInTheDocument();
  expect(f.suggest).not.toHaveBeenCalled();
  await waitFor(() => expect(f.stored.get(firstId)!.item.body).toBe(recoveredBody));
});
