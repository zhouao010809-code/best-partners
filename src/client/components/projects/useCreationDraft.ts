import { useCallback, useEffect, useRef, useState } from 'react';
import { projectCreationSchema, type CreationDetail, type CreationSave, type ProjectCreation } from '../../../shared/api/project-creations.js';
import type { ApiClientResult, ReadConsoleApi } from '../../api/client.js';

export type CreationsApi = NonNullable<ReadConsoleApi['creations']>;
export function creationError(result: ApiClientResult<unknown>, fallback = '操作没有完成，请重试。'): string {
  return !result.ok && 'state' in result ? result.state.message || fallback : fallback;
}
export function editable(item: ProjectCreation): Omit<CreationSave, 'expectedRevision'> {
  const { kind, title, brief, body, audience, angle, rationale, sources } = item;
  return { kind, title, brief, body, audience, angle, rationale, sources };
}
export const draftFingerprint = (item: ProjectCreation) => JSON.stringify(editable(item));
const recoveryOwners = new Map<string, symbol>();

/** Each mounted editor owns a serialized save queue. Browser recovery is written before debounce. */
export function useCreationDraft(api: CreationsApi, projectId: string, id: string, onSaved: (item: ProjectCreation) => void) {
  const [detail, setDetail] = useState<CreationDetail>();
  const [draft, setDraft] = useState<ProjectCreation>();
  const [status, setStatus] = useState<'loading' | 'saved' | 'dirty' | 'saving' | 'failed'>('loading');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const current = useRef<ProjectCreation | undefined>(undefined);
  const persisted = useRef<ProjectCreation | undefined>(undefined);
  const blocked = useRef(false);
  const alive = useRef(true);
  const flight = useRef<Promise<ProjectCreation | undefined> | undefined>(undefined);
  const savedCallback = useRef(onSaved); savedCallback.current = onSaved;
  const cacheKey = `creation-draft-v1:${projectId}:${id}`;
  const recoveryOwner = useRef(Symbol(cacheKey));
  const [change, setChange] = useState(0);
  const cache = useCallback((item: ProjectCreation) => {
    if (recoveryOwners.get(cacheKey) !== recoveryOwner.current) return;
    try { localStorage.setItem(cacheKey, JSON.stringify(item)); } catch { /* Server save remains available. */ }
  }, [cacheKey]);
  const clearCache = useCallback(() => { if (recoveryOwners.get(cacheKey) !== recoveryOwner.current) return; try { localStorage.removeItem(cacheKey); } catch { /* Optional recovery store. */ } }, [cacheKey]);

  useEffect(() => {
    alive.current = true;
    recoveryOwners.set(cacheKey, recoveryOwner.current);
    const controller = new AbortController();
    void api.get(projectId, id, controller.signal).then(result => {
      if (!alive.current || controller.signal.aborted) return;
      if (!result.ok) { setStatus('failed'); setError(creationError(result)); return; }
      const data = result.value;
      persisted.current = data.item; current.current = data.item;
      let recovered: ProjectCreation | undefined;
      try { const raw = localStorage.getItem(cacheKey); const parsed = raw && projectCreationSchema.safeParse(JSON.parse(raw));
        if (parsed && parsed.success && parsed.data.id === id && parsed.data.projectId === projectId) recovered = parsed.data;
      } catch { /* Ignore invalid cache without corrupting server data. */ }
      if (recovered && draftFingerprint(recovered) !== draftFingerprint(data.item)) {
        current.current = recovered;
        if (recovered.revision !== data.item.revision) {
          blocked.current = true; setConflict(true); setStatus('failed');
          setError('另一个窗口已更新这篇内容。你的编辑保留在当前窗口，请另存为新脚本。');
        } else { setStatus('dirty'); setChange(value => value + 1); }
      } else { clearCache(); setStatus('saved'); }
      setDetail(data); setDraft(current.current);
    }).catch(() => { if (alive.current) { setStatus('failed'); setError('稿件读取失败，请返回后重试。'); } });
    return () => { alive.current = false; controller.abort(); };
  }, [api, projectId, id, cacheKey, clearCache]);

  const flush = useCallback((): Promise<ProjectCreation | undefined> => {
    if (flight.current) return flight.current;
    if (blocked.current) return Promise.resolve(undefined);
    const run = async (): Promise<ProjectCreation | undefined> => {
      while (current.current && persisted.current && draftFingerprint(current.current) !== draftFingerprint(persisted.current)) {
        const sent = current.current;
        if (!sent.title.trim()) { if (alive.current) { setError('请填写内容标题。'); setStatus('failed'); } return undefined; }
        if (alive.current) { setStatus('saving'); setError(''); }
        try {
          const result = await api.save(projectId, id, { ...editable(sent), expectedRevision: persisted.current.revision });
          if (!result.ok) {
            if (alive.current) { setStatus('failed'); setError(creationError(result, '保存失败，请保持窗口打开并重试，你的编辑仍在。')); }
            if ('code' in result && result.code?.includes('CONFLICT')) { blocked.current = true; if (alive.current) setConflict(true); }
            return undefined;
          }
          persisted.current = result.value.item;
          const latest = current.current!;
          current.current = draftFingerprint(latest) === draftFingerprint(sent)
            ? result.value.item
            : { ...result.value.item, ...editable(latest) };
          cache(current.current);
          if (alive.current) { setDetail(result.value); setDraft(current.current); savedCallback.current(result.value.item); }
        } catch { if (alive.current) { setStatus('failed'); setError('保存失败，请保持窗口打开并重试，你的编辑仍在。'); } return undefined; }
      }
      clearCache();
      if (alive.current) { setStatus('saved'); setError(''); }
      return persisted.current;
    };
    const promise = run(); flight.current = promise;
    void promise.finally(() => { if (flight.current === promise) flight.current = undefined; });
    return promise;
  }, [api, projectId, id, cache, clearCache]);

  useEffect(() => {
    if (change === 0) return;
    const timer = setTimeout(() => { void flush(); }, 450);
    return () => clearTimeout(timer);
  }, [change, flush]);

  useEffect(() => {
    const protectUnsaved = (event: BeforeUnloadEvent) => {
      if (current.current && persisted.current && draftFingerprint(current.current) !== draftFingerprint(persisted.current)) {
        void flush(); event.preventDefault(); event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', protectUnsaved);
    return () => { window.removeEventListener('beforeunload', protectUnsaved); void flush(); };
  }, [flush]);

  const update = (patch: Partial<ReturnType<typeof editable>>) => {
    if (!current.current) return;
    const next = { ...current.current, ...patch };
    current.current = next; cache(next); setDraft(next); setStatus('dirty'); setChange(value => value + 1);
  };
  const replaceDetail = (value: CreationDetail) => {
    persisted.current = value.item; current.current = value.item;
    clearCache(); setDetail(value); setDraft(value.item); setStatus('saved'); setError(''); savedCallback.current(value.item);
  };
  return { detail, draft, status, error, conflict, update, flush, replaceDetail, current };
}
