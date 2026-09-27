import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ReadConsoleApi } from '../../api/client.js';
import type { ProjectCreation } from '../../../shared/api/project-creations.js';
import { creationError, draftFingerprint } from './useCreationDraft.js';

type Action = 'discard' | 'restore';
export type CreationBatchFailure = { item: ProjectCreation; reason: string };
export type CreationBatchReport = { action: Action; count: number; undo: boolean; failures: CreationBatchFailure[] };
type Options = {
  api: ReadConsoleApi; projectId: string; view: string; visible: ProjectCreation[];
  blocked: boolean; mutation: RefObject<boolean>; onUpdate(item: ProjectCreation): void;
};

// A response can be lost after the local server committed. Reconcile one exact revision,
// never infer that a later recycle/restore or an edited item was this batch's result.
function matchesTransition(before: ProjectCreation, after: ProjectCreation, action: Action) {
  return after.id === before.id && after.projectId === before.projectId &&
    after.revision === before.revision + 1 && Boolean(after.discardedAt) === (action === 'discard') &&
    after.finalVersionId === before.finalVersionId && after.createdAt === before.createdAt &&
    draftFingerprint(after) === draftFingerprint(before);
}

export function useCreationBatch({ api, projectId, view, visible, blocked, mutation, onUpdate }: Options) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<ProjectCreation[]>();
  const [report, setReport] = useState<CreationBatchReport>();
  const [undoItems, setUndoItems] = useState<ProjectCreation[]>([]);
  const [progress, setProgress] = useState<{ action: Action; completed: number; total: number }>();
  const generation = useRef(0);
  const latestUpdate = useRef(onUpdate); latestUpdate.current = onUpdate;
  const busy = progress !== undefined;
  const visibleIds = visible.map(item => item.id).join(':');
  useEffect(() => {
    generation.current += 1;
    setSelectedIds([]); setConfirmation(undefined); setReport(undefined); setUndoItems([]); setProgress(undefined);
    return () => { generation.current += 1; };
  }, [projectId]);
  useEffect(() => { setSelectedIds([]); setConfirmation(undefined); }, [view, projectId]);
  useEffect(() => {
    const allowed = new Set(visibleIds.split(':'));
    setSelectedIds(previous => previous.every(id => allowed.has(id)) ? previous : previous.filter(id => allowed.has(id)));
  }, [visibleIds]);
  const selected = visible.filter(item => selectedIds.includes(item.id));
  const locked = blocked || busy;
  function toggle(id: string) {
    if (locked || mutation.current) return;
    setSelectedIds(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]);
  }
  function selectAll() {
    if (locked || mutation.current) return;
    setSelectedIds(selected.length === visible.length ? [] : visible.map(item => item.id));
  }
  function noteRestored(id: string) { setUndoItems(previous => previous.filter(item => item.id !== id)); }
  function requestDiscard() {
    if (locked || mutation.current || !selected.length) return;
    setConfirmation(structuredClone(selected));
  }
  function cancel() { if (!busy && !mutation.current) setConfirmation(undefined); }

  async function run(action: Action, snapshot: ProjectCreation[], undo = false) {
    const service = api.creations; const perform = service?.[action];
    if (!service || !perform || blocked || mutation.current || busy || !snapshot.length) return;
    mutation.current = true;
    const epoch = generation.current;
    const current = () => generation.current === epoch;
    setReport(undefined); setProgress({ action, completed: 0, total: snapshot.length });
    const successes: ProjectCreation[] = []; const failures: CreationBatchFailure[] = [];
    try {
      for (const before of snapshot) {
        // Leaving the project stops unsent operations. Already committed items remain in its recycle bin.
        if (!current()) break;
        let after: ProjectCreation | undefined; let reason = ''; let uncertain = false;
        try {
          const result = await perform(projectId, before.id, { expectedRevision: before.revision });
          if (result.ok && matchesTransition(before, result.value.item, action)) after = result.value.item;
          else if (!result.ok) {
            reason = creationError(result);
            uncertain = !('code' in result && result.code);
          } else uncertain = true;
        } catch { uncertain = true; }
        if (!current()) break;
        if (uncertain) {
          try {
            const checked = await service.get(projectId, before.id);
            if (!current()) break;
            if (checked.ok) {
              latestUpdate.current(checked.value.item);
              if (matchesTransition(before, checked.value.item, action)) after = checked.value.item;
              else reason = checked.value.item.revision === before.revision
                ? '未完成，请保留此项选择后重试。'
                : '内容已变化，无法确认本次结果。请重新读取，在当前列表或回收站核对后操作。';
            } else reason = '结果尚未确认。请重新读取，在当前列表和回收站核对后重试。';
          } catch { reason = '结果尚未确认。请重新读取，在当前列表和回收站核对后重试。'; }
        }
        if (!current()) break;
        if (after) {
          successes.push(after); latestUpdate.current(after);
          setSelectedIds(previous => previous.filter(id => id !== after.id));
          if (action === 'restore') noteRestored(after.id);
        } else failures.push({ item: before, reason: reason || '操作没有完成，请重新读取后重试。' });
        setProgress({ action, completed: successes.length + failures.length, total: snapshot.length });
      }
      if (!current()) return;
      if (action === 'discard' && successes.length) setUndoItems(successes);
      // Undo is tied to the captured recycled revisions. Never adopt a newer revision and
      // silently restore something that was changed or recycled again by another action.
      if (undo) setUndoItems(previous => previous.filter(item => !successes.some(value => value.id === item.id)));
      setReport({ action, count: successes.length, undo, failures });
      setConfirmation(undefined);
      if (successes.length) window.dispatchEvent(new CustomEvent('project-creation-lifecycle', { detail: { projectId } }));
    } finally {
      mutation.current = false;
      if (current()) setProgress(undefined);
    }
  }
  return {
    selectedIds, selectedCount: selected.length, allSelected: visible.length > 0 && selected.length === visible.length,
    confirmation, report, undoItems, progress, busy, toggle, selectAll, requestDiscard, cancel, noteRestored,
    discard: () => run('discard', confirmation ?? []),
    restore: () => run('restore', structuredClone(selected)),
    undo: () => run('restore', structuredClone(undoItems), true),
  };
}
export type CreationBatch = ReturnType<typeof useCreationBatch>;
