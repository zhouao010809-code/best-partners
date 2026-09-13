import { useCallback, useEffect, useState } from 'react';
import type { TrashEntry } from '../../shared/api/trash.js';
import type { IntakeTrashEntry } from '../../shared/api/intake-trash.js';
import type { ReadConsoleApi } from '../api/client.js';

export type TrashOrigin = 'intake' | 'library' | 'queue' | 'knowledge';
export const trashOrigins: { id: TrashOrigin; label: string }[] = [
  { id: 'intake', label: '收件箱' }, { id: 'library', label: '档案库' },
  { id: 'queue', label: '提炼队列' }, { id: 'knowledge', label: '知识库' }
];
export type TrashPaper = { key: string; kind: 'document'; origin: Exclude<TrashOrigin, 'intake'>; entry: TrashEntry }
  | { key: string; kind: 'packet'; origin: 'intake'; entry: IntakeTrashEntry };
type Source<T> = { loading: boolean; items?: T[]; error?: string };
export function useTrashInventory(api: ReadConsoleApi, revision: number) {
  const [documents, setDocuments] = useState<Source<TrashEntry>>({ loading: true });
  const [packets, setPackets] = useState<Source<IntakeTrashEntry>>({ loading: true });
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt(value => value + 1), []);
  useEffect(() => {
    window.addEventListener('brain-trash-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('brain-trash-changed', refresh); window.removeEventListener('focus', refresh); };
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController();
    async function read<T>(service: { list: NonNullable<ReadConsoleApi['trash']>['list'] } | { list: NonNullable<ReadConsoleApi['intakeTrash']>['list'] } | undefined, set: (source: Source<T>) => void) {
      if (!service) { set({ loading: false, error: '当前连接暂不支持此来源' }); return; }
      set({ loading: true });
      try {
        const result = await service.list(controller.signal);
        if (controller.signal.aborted) return;
        if (result.ok) set({ loading: false, items: result.value.items as T[] });
        else set({ loading: false, error: 'state' in result ? result.state.message ?? '暂时无法读取' : '读取已取消' });
      } catch { if (!controller.signal.aborted) set({ loading: false, error: '暂时无法读取，请刷新重试' }); }
    }
    void read(api.trash, setDocuments); void read(api.intakeTrash, setPackets);
    return () => controller.abort();
  }, [api.trash, api.intakeTrash, revision, attempt]);
  const papers: TrashPaper[] = [
    ...(documents.items ?? []).map(entry => ({ key: `document:${entry.id}`, kind: 'document' as const, origin: entry.origin ?? 'library', entry })),
    ...(packets.items ?? []).map(entry => ({ key: `packet:${entry.id}`, kind: 'packet' as const, origin: 'intake' as const, entry }))
  ].sort((a, b) => Date.parse(b.entry.createdAt) - Date.parse(a.entry.createdAt));
  const active = papers.filter(paper => paper.entry.status !== 'restored' && paper.entry.status !== 'deleted');
  const complete = !documents.loading && !packets.loading && !documents.error && !packets.error;
  const counts = Object.fromEntries(trashOrigins.map(({ id }) => [id, (id === 'intake' ? packets : documents).items === undefined ? undefined : active.filter(paper => paper.origin === id).length])) as Record<TrashOrigin, number | undefined>;
  return { documents, packets, papers, active, counts, complete, loading: documents.loading || packets.loading, refresh };
}
