import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReadConsoleApi } from '../../src/client/api/client.js';
import type { CreationCreate, CreationDetail, ProjectCreation } from '../../src/shared/api/project-creations.js';
import type { ProjectCreativeProfile } from '../../src/shared/api/creative-profile.js';
import { CreationEditor } from '../../src/client/components/projects/CreationEditor.js';
import { ProjectWorkbench } from '../../src/client/components/projects/ProjectWorkbench.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const now = '2026-09-26T12:00:00Z';
const ok = <T,>(value: T) => ({ ok: true as const, value });
const original = (): ProjectCreation => ({ id: crypto.randomUUID(), projectId, kind: 'script', title: '回收检查', brief: '', body: '已存旧稿', audience: '', angle: '', rationale: '', sources: [], revision: 1, createdAt: now, updatedAt: now });
const detail = (item: ProjectCreation): CreationDetail => ({ item: structuredClone(item), versions: [], messages: [] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
function fixture(seed: ProjectCreation[] = []) {
  const stored = new Map(seed.map(item => [item.id, item]));
  const create = vi.fn(async (_projectId: string, input: CreationCreate) => { const value = { ...original(), ...input } as ProjectCreation; stored.set(value.id, value); return ok(detail(value)); });
  const api = { creations: {
    list: vi.fn(async () => ok({ items: [...stored.values()].filter(item => !item.discardedAt) })),
    listDiscarded: vi.fn(async () => ok({ items: [...stored.values()].filter(item => !!item.discardedAt) })),
    get: vi.fn(async (_p: string, id: string) => ok(detail(stored.get(id)!))), create,
    discard: vi.fn(async (_p: string, id: string, input: { expectedRevision: number }) => { const item = { ...stored.get(id)!, discardedAt: now, revision: input.expectedRevision + 1 }; stored.set(id, item); return ok(detail(item)); }),
    restore: vi.fn(async (_p: string, id: string, input: { expectedRevision: number }) => { const item = { ...stored.get(id)!, revision: input.expectedRevision + 1 }; delete item.discardedAt; stored.set(id, item); return ok(detail(item)); })
  } } as unknown as ReadConsoleApi;
  return { stored, create, api, ui: () => <MemoryRouter><ProjectWorkbench api={api} projectId={projectId} files={null} /></MemoryRouter> };
}
function seedCandidate(profileRevision?: number) {
  localStorage.setItem(`creation-candidates-v1:${projectId}`, JSON.stringify({ suggestion: { id: crypto.randomUUID(), task: 'topics', reply: '候选', topics: [{ title: '同一候选', audience: '', angle: '', rationale: '' }], sources: [], createdAt: now, ...(profileRevision === undefined ? {} : { profileRevision }) }, brief: '要求', references: { mode: 'auto', paths: [] }, remaining: [0], picked: [0] }));
}
afterEach(() => { cleanup(); localStorage.clear(); });

it('retains a previous failed-save recovery draft when its list card is discarded', async () => {
  const item = original(); const f = fixture([item]);
  const key = `creation-draft-v1:${projectId}:${item.id}`;
  localStorage.setItem(key, JSON.stringify({ ...item, body: '保存失败时唯一保留的新正文' }));
  render(f.ui());
  fireEvent.click(await screen.findByRole('button', { name: `移入回收站：${item.title}` }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '确认移入回收站' }));
  await screen.findByRole('button', { name: '撤销移入' });
  expect(JSON.parse(localStorage.getItem(key) ?? 'null')?.body).toBe('保存失败时唯一保留的新正文');
});

it('does not save the same candidate again after navigating while its first save is pending', async () => {
  seedCandidate(); const f = fixture(); const pending = deferred<ReturnType<typeof ok<CreationDetail>>>();
  const input: CreationCreate = { kind: 'topic', title: '同一候选' };
  const created = { ...original(), ...input } as ProjectCreation;
  f.create.mockImplementationOnce(async () => { f.stored.set(created.id, created); return pending.promise; });
  const first = render(f.ui());
  fireEvent.click(await screen.findByRole('button', { name: '保存所选（1）' }));
  await waitFor(() => expect(f.create).toHaveBeenCalledTimes(1));
  first.unmount(); render(f.ui());
  await act(async () => { pending.resolve(ok(detail(created))); });
  const save = screen.queryByRole('button', { name: '保存所选（1）' });
  if (save) fireEvent.click(save);
  await act(async () => {});
  expect(f.create).toHaveBeenCalledTimes(1);
});

it('does not accept recovered candidates before their profile revision has been checked', async () => {
  seedCandidate(1); const f = fixture(); const profile = deferred<ReturnType<typeof ok<ProjectCreativeProfile>>>();
  f.api.creations!.getProfile = vi.fn(async () => profile.promise);
  render(f.ui());
  fireEvent.click(await screen.findByRole('button', { name: '保存所选（1）' }));
  await act(async () => {});
  expect(f.create).not.toHaveBeenCalled();
  await act(async () => { profile.resolve(ok({ projectId, revision: 2, audience: '', goal: '', style: '', facts: '', avoid: '', samples: [] })); });
});

it('shows an unsaved empty-title draft after its item is restored instead of losing its only body', async () => {
  const item = { ...original(), revision: 3 }; const f = fixture([item]);
  const key = `creation-draft-v1:${projectId}:${item.id}`;
  localStorage.setItem(key, JSON.stringify({ ...item, revision: 1, title: '', body: '未保存但必须可以找回的正文' }));
  render(<MemoryRouter><CreationEditor api={f.api} projectId={projectId} id={item.id} onBack={vi.fn()} onOpen={vi.fn()} onSaved={vi.fn()} /></MemoryRouter>);
  expect(await screen.findByRole('textbox', { name: '脚本正文' })).toHaveValue('未保存但必须可以找回的正文');
  expect(screen.getByRole('textbox', { name: '内容标题' })).toHaveValue('');
  expect(screen.getByRole('button', { name: '另存为新脚本' })).toBeVisible();
  expect(JSON.parse(localStorage.getItem(key) ?? 'null').body).toBe('未保存但必须可以找回的正文');
});
