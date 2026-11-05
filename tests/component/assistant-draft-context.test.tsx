import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAssistantDrafts } from '../../src/client/components/assistant/useAssistantDrafts.js';
import type { AssistantDraft, AssistantDraftSave } from '../../src/shared/api/assistant-drafts.js';

afterEach(cleanup);
function fixture() {
  const projectA = crypto.randomUUID(), projectB = crypto.randomUUID();
  const make = (projectId: string): AssistantDraft => ({ id: crypto.randomUUID(), revision: 1, text: projectId === projectA ? 'A old' : 'B old', attachments: [], groupId: crypto.randomUUID(), scope: 'project', projectId, projectRevision: 1, updatedAt: '2026-11-05', lastActive: '2026-11-05' });
  const a = make(projectA), b = make(projectB); const records = new Map([[a.id, a], [b.id, b]]);
  const service = {
    list: vi.fn(async (signalOrProject?: AbortSignal | string, query?: AbortSignal | { projectId?: string | undefined }) => {
      const requestedProject = typeof signalOrProject === 'string' ? signalOrProject : query && 'projectId' in query ? query.projectId : undefined;
      const drafts = [...records.values()].filter(item => item.projectId === requestedProject);
      return { ok: true as const, value: { drafts, activeId: drafts[0]?.id } };
    }),
    save: vi.fn(async (id: string, input: AssistantDraftSave) => {
      const { expectedRevision, active: _, ...fields } = input;
      const draft = { ...fields, id, revision: expectedRevision + 1, updatedAt: '2026-11-05', lastActive: '2026-11-05' };
      records.set(id, draft); return { ok: true as const, value: { draft } };
    }),
    delete: vi.fn(async () => ({ ok: true as const, value: { deleted: true as const } }))
  };
  const view = renderHook(({ projectId }) => useAssistantDrafts(service, projectId), { initialProps: { projectId: projectA } });
  return { view, service, records, projectA, projectB, a, b };
}

it('saves project A immediately when navigating away before the autosave debounce', async () => {
  const f = fixture(); await waitFor(() => expect(f.view.result.current.ready).toBe(true));
  act(() => f.view.result.current.update({ text: 'A unsent latest' }));
  f.view.rerender({ projectId: f.projectB });
  await waitFor(() => expect(f.view.result.current.ready).toBe(true));
  expect(f.view.result.current.current.text).toBe('B old');
  await waitFor(() => expect(f.records.get(f.a.id)?.text).toBe('A unsent latest'));
  f.view.rerender({ projectId: f.projectA });
  await waitFor(() => expect(f.view.result.current.ready).toBe(true));
  expect(f.view.result.current.current.text).toBe('A unsent latest');
});

it('keeps a failed project save locally and restores it instead of its older server snapshot', async () => {
  const f = fixture(); await waitFor(() => expect(f.view.result.current.ready).toBe(true));
  f.service.save.mockRejectedValue(new Error('offline'));
  act(() => f.view.result.current.update({ text: 'A recoverable' }));
  f.view.rerender({ projectId: f.projectB });
  await waitFor(() => expect(f.view.result.current.ready).toBe(true));
  f.view.rerender({ projectId: f.projectA });
  await waitFor(() => expect(f.view.result.current.ready).toBe(true));
  expect(f.view.result.current.current.text).toBe('A recoverable');
  expect(f.view.result.current.dirty).toBe(true);
});

it('keeps an old in-flight save and its revision out of the new project', async () => {
  const f = fixture(); await waitFor(() => expect(f.view.result.current.ready).toBe(true));
  const save = f.service.save.getMockImplementation()!;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.service.save.mockImplementationOnce(async (id, input) => { await gate; return save(id, input); });
  act(() => f.view.result.current.update({ text: 'A pending' }));
  let pending!: Promise<boolean>; act(() => { pending = f.view.result.current.flush(); });
  await waitFor(() => expect(f.service.save).toHaveBeenCalledTimes(1));
  f.view.rerender({ projectId: f.projectB });
  await waitFor(() => expect(f.view.result.current.ready).toBe(true));
  act(() => f.view.result.current.update({ text: 'B separate' }));
  await act(async () => { release(); await pending; });
  expect(f.view.result.current.current).toMatchObject({ id: f.b.id, projectId: f.projectB, text: 'B separate' });
  expect(f.service.save.mock.calls.slice(0, 1).every(([id]) => id === f.a.id)).toBe(true);
  f.view.rerender({ projectId: f.projectA });
  await waitFor(() => expect(f.view.result.current.ready).toBe(true));
  expect(f.view.result.current.current).toMatchObject({ id: f.a.id, revision: 2, text: 'A pending' });
});
