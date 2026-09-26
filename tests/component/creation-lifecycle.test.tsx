import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReadConsoleApi } from '../../src/client/api/client.js';
import { creationCreateSchema, type CreationCreate, type CreationDetail, type ProjectCreation } from '../../src/shared/api/project-creations.js';
import { ProjectWorkbench } from '../../src/client/components/projects/ProjectWorkbench.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const now = '2026-09-26T12:00:00Z';
const ok = <T,>(value: T) => ({ ok: true as const, value });
const item = (): ProjectCreation => ({ id: crypto.randomUUID(), projectId, kind: 'script', title: '可以放弃的草稿', brief: '', body: '仍然可以恢复的正文', audience: '', angle: '', rationale: '', sources: [], revision: 1, createdAt: now, updatedAt: now });
function fixture(seed: ProjectCreation[] = []) {
  const stored = new Map(seed.map(value => [value.id, structuredClone(value)]));
  const detail = (value: ProjectCreation): CreationDetail => ({ item: structuredClone(value), versions: [], messages: [] });
  const create = vi.fn(async (_project: string, input: CreationCreate) => { const value = { ...item(), ...creationCreateSchema.parse(input) }; stored.set(value.id, value); return ok(detail(value)); });
  const discard = vi.fn(async (_project: string, id: string, input: { expectedRevision: number }) => { const value = { ...stored.get(id)!, discardedAt: now, revision: input.expectedRevision + 1 }; stored.set(id, value); return ok(detail(value)); });
  const restore = vi.fn(async (_project: string, id: string, input: { expectedRevision: number }) => { const value = { ...stored.get(id)!, revision: input.expectedRevision + 1 }; delete value.discardedAt; stored.set(id, value); return ok(detail(value)); });
  const suggest = vi.fn(async () => ok({ id: crypto.randomUUID(), task: 'topics', reply: '先挑选喜欢的角度', topics: ['课堂观察', '家长沟通'].map(title => ({ title, audience: '家长', angle: '真实课堂', rationale: '有资料依据' })), sources: [], createdAt: now }));
  const api = { creations: {
    list: vi.fn(async () => ok({ items: [...stored.values()].filter(value => !value.discardedAt) })),
    listDiscarded: vi.fn(async () => ok({ items: [...stored.values()].filter(value => value.discardedAt) })),
    get: vi.fn(async (_project: string, id: string) => ok(detail(stored.get(id)!))), create, discard, restore, suggest
  } } as unknown as ReadConsoleApi;
  const ui = () => <MemoryRouter><ProjectWorkbench api={api} projectId={projectId} files={<p>项目原始资料</p>} /></MemoryRouter>;
  return { api, ui, stored, create, discard, restore, suggest };
}
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); localStorage.clear(); });

it('lets the director select candidates before persisting topics and remembers unaccepted candidates', async () => {
  const f = fixture(); const view = render(f.ui());
  fireEvent.click(await screen.findByRole('button', { name: '策划选题' }));
  fireEvent.change(screen.getByRole('textbox', { name: '选题要求' }), { target: { value: '根据真实课堂找选题' } });
  fireEvent.click(screen.getByRole('button', { name: '根据资料策划' }));
  expect(await screen.findByRole('checkbox', { name: '保留选题：课堂观察' })).not.toBeChecked();
  expect(f.create).not.toHaveBeenCalled();
  view.unmount(); render(f.ui());
  fireEvent.click(await screen.findByRole('checkbox', { name: '保留选题：课堂观察' }));
  fireEvent.click(screen.getByRole('button', { name: '保存所选（1）' }));
  expect(await screen.findByRole('button', { name: '打开创作：课堂观察' })).toBeVisible();
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.create.mock.calls[0]![1]).toMatchObject({ title: '课堂观察', brief: '根据真实课堂找选题' });
  expect(screen.getByRole('checkbox', { name: '保留选题：家长沟通' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '放弃剩余建议' }));
  expect(screen.queryByRole('checkbox', { name: '保留选题：家长沟通' })).not.toBeInTheDocument();
  expect(f.create).toHaveBeenCalledOnce();
});

it('confirms before moving a saved draft, then supports undo and recovery after reopening', async () => {
  const original = item(); const f = fixture([original]); const view = render(f.ui());
  fireEvent.click(await screen.findByRole('button', { name: `移入回收站：${original.title}` }));
  const dialog = await screen.findByRole('dialog', { name: '移入项目回收站' });
  expect(dialog).toHaveTextContent('正文、历史版本和讨论');
  expect(f.discard).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
  expect(f.discard).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: `移入回收站：${original.title}` }));
  fireEvent.click(within(await screen.findByRole('dialog', { name: '移入项目回收站' })).getByRole('button', { name: '确认移入回收站' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: `打开创作：${original.title}` })).not.toBeInTheDocument());
  expect(f.discard).toHaveBeenCalledWith(projectId, original.id, { expectedRevision: 1 });
  fireEvent.click(await screen.findByRole('button', { name: '撤销移入' }));
  expect(await screen.findByRole('button', { name: `打开创作：${original.title}` })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: `移入回收站：${original.title}` }));
  fireEvent.click(within(await screen.findByRole('dialog', { name: '移入项目回收站' })).getByRole('button', { name: '确认移入回收站' }));
  await waitFor(() => expect(f.discard).toHaveBeenCalledTimes(2));
  view.unmount(); render(f.ui());
  fireEvent.click(await screen.findByRole('tab', { name: '回收站' }));
  fireEvent.click(await screen.findByRole('button', { name: `恢复创作：${original.title}` }));
  await waitFor(() => expect(f.restore).toHaveBeenCalledTimes(2));
  expect(f.stored.get(original.id)?.body).toBe(original.body);
  expect(f.stored.get(original.id)?.discardedAt).toBeUndefined();
});
