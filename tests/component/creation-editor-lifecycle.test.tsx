import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ApiClientResult, ReadConsoleApi } from '../../src/client/api/client.js';
import type { CreationDetail, CreationSave, CreationSuggestion, ProjectCreation } from '../../src/shared/api/project-creations.js';
import { CreationEditor } from '../../src/client/components/projects/CreationEditor.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const time = '2026-09-26T00:00:00.000Z';
const ok = <T,>(value: T) => ({ ok: true as const, value });
const failure = { ok: false as const, state: { status: 'operation-error' as const, message: '本机保存失败，请重试。' } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  let detail: CreationDetail = { item: { id, projectId, revision: 1, kind: 'script', title: '我的稿件', brief: '保持原意',
    body: '我手写的当前稿', audience: '', angle: '', rationale: '', sources: [], referenceSelection: { mode: 'selected', paths: ['采访.md'] }, createdAt: time, updatedAt: time }, versions: [], messages: [] };
  const get = vi.fn(async () => ok(structuredClone(detail)));
  const save = vi.fn(async (_project: string, _id: string, input: CreationSave): Promise<ApiClientResult<CreationDetail>> => {
    const { expectedRevision, ...fields } = input;
    detail = { ...detail, item: { ...detail.item, ...fields, revision: expectedRevision + 1 } };
    return ok(structuredClone(detail));
  });
  function snapshotValue() {
    const item = detail.item;
    const version = { id: crypto.randomUUID(), creationId: id, number: detail.versions.length + 1, title: item.title,
      brief: item.brief, body: item.body, sources: item.sources, referenceSelection: item.referenceSelection, createdAt: time };
    detail = { ...detail, item: { ...item, revision: item.revision + 1 }, versions: [...detail.versions, version] };
    return structuredClone(detail);
  }
  const snapshot = vi.fn(async (): Promise<ApiClientResult<CreationDetail>> => ok(snapshotValue()));
  const suggest = vi.fn(async (_p: string, input: { task: string }): Promise<ApiClientResult<CreationSuggestion>> => {
    const suggestion: CreationSuggestion = { id: crypto.randomUUID(), task: input.task as CreationSuggestion['task'], topics: [], reply: '本次建议',
      ...(input.task === 'discuss' ? {} : { body: 'AI 替换后的稿件' }), sources: [], baseRevision: detail.item.revision, createdAt: time };
    detail.messages.push({ id: crypto.randomUUID(), instruction: '讨论要求', suggestion, createdAt: time });
    return ok(suggestion);
  });
  const dismissSuggestion = vi.fn(async (_p: string, _id: string, suggestionId: string): Promise<ApiClientResult<CreationDetail>> => {
    detail.messages = detail.messages.map(message => message.suggestion.id === suggestionId ? { ...message, dismissedAt: time } : message);
    return ok(structuredClone(detail));
  });
  const api = { creations: { get, save, snapshot, suggest, dismissSuggestion }, assistant: { providers: vi.fn(async () => ok({ providers: [{ id: 'deepseek', status: 'ready', defaultModel: 'model', models: [{ id: 'model', name: '模拟模型' }] }] })) } } as unknown as ReadConsoleApi;
  return { api, get, save, snapshot, snapshotValue, suggest, dismissSuggestion, detail: () => detail };
}
function mount(f: ReturnType<typeof fixture>, callbacks: { onBack?: () => void; onDiscard?: (item: ProjectCreation) => void } = {}) {
  return render(<MemoryRouter><CreationEditor api={f.api} projectId={projectId} id={id} onBack={callbacks.onBack ?? vi.fn()} onSaved={vi.fn()} onOpen={vi.fn()} {...(callbacks.onDiscard ? { onDiscard: callbacks.onDiscard } : {})} /></MemoryRouter>);
}
async function ready() { await screen.findByRole('textbox', { name: '脚本正文' }); await waitFor(() => expect(screen.getByRole('button', { name: '根据资料起草' })).toBeEnabled()); }
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

it('checkpoints before adopting AI text and can undo with the complete prior draft preserved', async () => {
  const f = fixture(); const original = structuredClone(f.detail().item); const pending = deferred<ApiClientResult<CreationDetail>>();
  f.snapshot.mockReturnValueOnce(pending.promise);
  mount(f); await ready(); fireEvent.click(screen.getByRole('button', { name: '根据资料起草' }));
  fireEvent.click(await screen.findByRole('button', { name: '采用到正文' }));
  await waitFor(() => expect(f.snapshot).toHaveBeenCalledWith(projectId, id, { expectedRevision: 1, finalize: false }));
  expect(screen.getByRole('textbox', { name: '脚本正文' })).toHaveValue(original.body);
  expect(screen.getByRole('textbox', { name: '脚本正文' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: '内容标题' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: '创作要求' })).toBeDisabled();
  await act(async () => pending.resolve(ok(f.snapshotValue())));
  await waitFor(() => expect(screen.getByRole('textbox', { name: '脚本正文' })).toHaveValue('AI 替换后的稿件'));
  expect(f.detail().versions[0]?.body).toBe(original.body);
  fireEvent.click(screen.getByRole('button', { name: '撤销这次替换' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: '脚本正文' })).toHaveValue(original.body));
  await waitFor(() => expect(f.detail().item.body).toBe(original.body));
  expect(f.detail().item.referenceSelection).toEqual(original.referenceSelection);
  expect(f.detail().versions.map(version => version.body)).toEqual([original.body, 'AI 替换后的稿件']);
});

it('keeps AI preview and current text when preserving the old draft fails', async () => {
  const f = fixture(); f.snapshot.mockResolvedValueOnce(failure);
  mount(f); await ready(); fireEvent.click(screen.getByRole('button', { name: '根据资料起草' }));
  fireEvent.click(await screen.findByRole('button', { name: '采用到正文' }));
  expect(await screen.findByText('本机保存失败，请重试。')).toBeVisible();
  expect(screen.getByRole('textbox', { name: '脚本正文' })).toHaveValue('我手写的当前稿');
  expect(screen.getByRole('button', { name: '采用到正文' })).toBeEnabled();
  expect(f.save).not.toHaveBeenCalled();
});

it('preserves the current draft before loading a version and retains the final designation on undo', async () => {
  const f = fixture(); const version = { id: crypto.randomUUID(), creationId: id, number: 1, title: '之前的标题', brief: '', body: '之前的正文', sources: [], referenceSelection: { mode: 'auto' as const, paths: [] }, createdAt: time };
  f.detail().versions.push(version); f.detail().item.finalVersionId = version.id;
  mount(f); await ready(); fireEvent.click(screen.getByRole('button', { name: '版本记录 · 1' }));
  fireEvent.click(within(screen.getByRole('article', { name: '版本 v1' })).getByRole('button', { name: '载入此版本' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: '脚本正文' })).toHaveValue(version.body));
  expect(f.detail().versions[1]?.body).toBe('我手写的当前稿');
  fireEvent.click(screen.getByRole('button', { name: '撤销这次替换' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: '内容标题' })).toHaveValue('我的稿件'));
  await waitFor(() => expect(f.detail().item.referenceSelection).toEqual({ mode: 'selected', paths: ['采访.md'] }));
  expect(f.detail().item.finalVersionId).toBe(version.id);
});

it.each(['script', 'discuss'])('persists rejection of a %s result and never revives it after reopening', async task => {
  const f = fixture(); let ui = mount(f); await ready();
  if (task === 'script') fireEvent.click(screen.getByRole('button', { name: '根据资料起草' }));
  else {
    fireEvent.change(screen.getByRole('combobox', { name: '处理方式' }), { target: { value: 'discuss' } });
    fireEvent.change(screen.getByRole('textbox', { name: '给问问的要求' }), { target: { value: '先讨论' } });
    fireEvent.click(screen.getByRole('button', { name: '发送给问问' }));
  }
  fireEvent.click(await screen.findByRole('button', { name: '放弃建议' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: '问问的修改建议' })).not.toBeInTheDocument());
  expect(f.dismissSuggestion).toHaveBeenCalledWith(projectId, id, f.detail().messages[0]!.suggestion.id);
  ui.unmount(); ui = mount(f); await ready();
  expect(screen.queryByRole('region', { name: '问问的修改建议' })).not.toBeInTheDocument();
  expect(f.detail().item.body).toBe('我手写的当前稿');
  expect(f.save).not.toHaveBeenCalled();
});

it('keeps the suggestion available when persisting rejection fails', async () => {
  const f = fixture(); f.dismissSuggestion.mockResolvedValueOnce(failure);
  mount(f); await ready(); fireEvent.click(screen.getByRole('button', { name: '根据资料起草' }));
  fireEvent.click(await screen.findByRole('button', { name: '放弃建议' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('本机保存失败');
  expect(screen.getByRole('region', { name: '问问的修改建议' })).toBeVisible();
  expect(screen.getByRole('button', { name: '放弃建议' })).toBeEnabled();
});

it('does not return to the workbench when the latest edit cannot be saved', async () => {
  const f = fixture(); f.save.mockResolvedValue(failure); const onBack = vi.fn(); const onDiscard = vi.fn();
  mount(f, { onBack, onDiscard }); await ready();
  fireEvent.change(screen.getByRole('textbox', { name: '脚本正文' }), { target: { value: '还没有保存成功的编辑' } });
  fireEvent.click(screen.getByRole('button', { name: '返回创作台' }));
  await waitFor(() => expect(f.save).toHaveBeenCalled());
  expect(onBack).not.toHaveBeenCalled(); expect(onDiscard).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: '脚本正文' })).toHaveValue('还没有保存成功的编辑');
});

it.each(['empty-title', 'save-failure', 'revision-conflict'])('can request recycle confirmation after %s while preserving unsaved recovery', async reason => {
  const f = fixture(); const persisted = structuredClone(f.detail().item); const onDiscard = vi.fn();
  f.save.mockResolvedValue(reason === 'revision-conflict' ? { ...failure, code: 'CREATION_CONFLICT' } : failure);
  const ui = mount(f, { onDiscard }); await ready();
  const body = '回收前尚未保存但需要保留的编辑';
  fireEvent.change(screen.getByRole('textbox', { name: '脚本正文' }), { target: { value: body } });
  if (reason === 'empty-title') fireEvent.change(screen.getByRole('textbox', { name: '内容标题' }), { target: { value: '' } });
  if (reason === 'revision-conflict') {
    fireEvent.click(screen.getByRole('button', { name: '返回创作台' }));
    await screen.findByRole('button', { name: '另存为新脚本' });
  }
  const discard = screen.getByRole('button', { name: '移入回收站' });
  expect(discard).toBeEnabled(); fireEvent.click(discard);
  await waitFor(() => expect(onDiscard).toHaveBeenCalledExactlyOnceWith(persisted));
  const cacheKey = `creation-draft-v1:${projectId}:${id}`;
  const expectedRecovery = { id, projectId, revision: persisted.revision, title: reason === 'empty-title' ? '' : persisted.title, body };
  expect(JSON.parse(localStorage.getItem(cacheKey)!)).toMatchObject(expectedRecovery);
  expect(f.detail().item).toEqual(persisted); expect(f.get).toHaveBeenCalledTimes(1);
  if (reason === 'empty-title') expect(f.save).not.toHaveBeenCalled();
  ui.unmount();
  await act(async () => {});
  expect(JSON.parse(localStorage.getItem(cacheKey)!)).toMatchObject(expectedRecovery);
});

it('passes the saved revision to the parent before requesting the discard confirmation', async () => {
  const f = fixture(); const onDiscard = vi.fn(); mount(f, { onDiscard }); await ready();
  fireEvent.change(screen.getByRole('textbox', { name: '脚本正文' }), { target: { value: '回收前保留的编辑' } });
  fireEvent.click(screen.getByRole('button', { name: '移入回收站' }));
  await waitFor(() => expect(onDiscard).toHaveBeenCalledWith(expect.objectContaining({ body: '回收前保留的编辑', revision: 2 })));
});

it('does not allow modifying or generating against a discarded creation', async () => {
  const f = fixture(); f.detail().item.discardedAt = time;
  mount(f); await screen.findByRole('textbox', { name: '脚本正文' });
  expect(screen.getByRole('textbox', { name: '脚本正文' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: '内容标题' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '根据资料起草' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '保存版本' })).toBeDisabled();
});
