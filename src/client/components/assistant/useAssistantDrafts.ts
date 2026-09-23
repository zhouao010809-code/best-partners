import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReadConsoleApi } from '../../api/client.js';
import type { AssistantDraft, AssistantDraftFields } from '../../../shared/api/assistant-drafts.js';
import type { AssistantConversation } from '../../../shared/api/assistant.js';

type LocalDraft = AssistantDraftFields & { id: string; revision: number };
const fresh = (): LocalDraft => ({ id: crypto.randomUUID(), revision: 0, text: '', attachments: [], groupId: crypto.randomUUID(), scope: 'brain' });
const fields = ({ id: _id, revision: _revision, ...value }: LocalDraft): AssistantDraftFields => {
  const { text, attachments, groupId, scope, conversationId, contextPath, projectId, projectRevision } = value;
  return { text, attachments, groupId, scope, ...(conversationId ? { conversationId } : {}), ...(contextPath ? { contextPath } : {}), ...(projectId ? { projectId } : {}), ...(projectRevision !== undefined ? { projectRevision } : {}) };
};
const fingerprint = (draft: LocalDraft) => JSON.stringify({ id: draft.id, ...fields(draft) });

export function useAssistantDrafts(service: ReadConsoleApi['assistantDrafts'], projectId?: string) {
  const [current, setCurrent] = useState<LocalDraft>(fresh);
  const currentRef = useRef(current); currentRef.current = current;
  const [drafts, setDrafts] = useState<AssistantDraft[]>([]);
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  const [ready, setReady] = useState(!service);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState('');
  const acknowledged = useRef(fingerprint(current));
  const inFlight = useRef<Promise<boolean> | undefined>(undefined);
  const mounted = useRef(true);
  const loadSequence = useRef(0);

  const replace = useCallback((draft: LocalDraft) => { currentRef.current = draft; setCurrent(draft); }, []);
  const update = useCallback((patch: Partial<AssistantDraftFields>) => { replace({ ...currentRef.current, ...patch }); }, [replace]);
  const load = useCallback(async (requestedProjectId = projectId) => {
    if (!service) { setReady(true); return; }
    const sequence = ++loadSequence.current; setError('');
    try {
      const result = await service.list(undefined, requestedProjectId === undefined ? undefined : { projectId: requestedProjectId }); if (!mounted.current || sequence !== loadSequence.current) return;
      if (!result.ok) { setError('state' in result ? result.state.message ?? '未能恢复本机草稿。' : '未能恢复本机草稿。'); return; }
      setDrafts(result.value.drafts); draftsRef.current = result.value.drafts;
      const active = result.value.drafts.find(item => item.id === result.value.activeId);
      if (active) { replace(active); acknowledged.current = fingerprint(active); }
      else {
        const blank = fresh();
        replace(requestedProjectId === undefined ? blank : { ...blank, scope: 'project', projectId: requestedProjectId });
        acknowledged.current = fingerprint(currentRef.current);
      }
      setReady(true);
    } catch { if (mounted.current && sequence === loadSequence.current) setError('未能恢复本机草稿，请重新连接后重试。'); }
  }, [projectId, service, replace]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; loadSequence.current += 1; }; }, [load]);

  const flush = useCallback((): Promise<boolean> => {
    if (!service) return Promise.resolve(true);
    if (inFlight.current) return inFlight.current;
    const request = (async () => {
      setSaving(true);
      try {
        while (acknowledged.current !== fingerprint(currentRef.current)) {
          const snapshot = currentRef.current;
          const result = await service.save(snapshot.id, { ...fields(snapshot), expectedRevision: snapshot.revision, active: true });
          if (!result.ok) {
            setConflict('code' in result && result.code === 'ASSISTANT_DRAFT_CONFLICT');
            setError('state' in result ? result.state.message ?? '草稿尚未保存，请重试。' : '草稿尚未保存，请重试。'); return false;
          }
          const saved = result.value.draft;
          draftsRef.current = [saved, ...draftsRef.current.filter(item => item.id !== saved.id)]; setDrafts(draftsRef.current);
          acknowledged.current = fingerprint(snapshot);
          if (currentRef.current.id === snapshot.id) replace({ ...currentRef.current, revision: saved.revision });
        }
        setError(''); setConflict(false); return true;
      } catch { setError('草稿尚未保存到本机，文字仍在此处。请重试后再切换对话。'); return false; }
      finally { setSaving(false); }
    })();
    inFlight.current = request;
    void request.finally(() => { if (inFlight.current === request) inFlight.current = undefined; });
    return request;
  }, [service, replace]);

  useEffect(() => {
    if (!ready || !service || acknowledged.current === fingerprint(current)) return;
    const timer = setTimeout(() => void flush(), 300); return () => clearTimeout(timer);
  }, [current, ready, service, flush]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!service || acknowledged.current === fingerprint(currentRef.current)) return;
      void flush(); event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload); return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [service, flush]);

  const select = useCallback(async (next: LocalDraft): Promise<boolean> => {
    if (!await flush()) return false;
    if (next.id === currentRef.current.id) next = currentRef.current;
    replace(next); acknowledged.current = ''; setNotice('');
    // Flush also records which draft should be restored after a full app restart.
    await flush(); return true;
  }, [flush, replace]);
  async function newDraft(text = '', attachments: AssistantDraftFields['attachments'] = []): Promise<boolean> {
    return select({ ...fresh(), text, attachments });
  }
  const enterProject = useCallback(async (id: string, sourceRevision: number): Promise<boolean> => {
    // A reconnect or confirmed output can arrive while the user is typing.
    // Persist the current local draft before loading the server's project
    // snapshot, otherwise the snapshot could replace text not yet covered by
    // the debounce autosave.
    if (!await flush()) return false;
    if (service) await load(id);
    const existing = draftsRef.current.find(item => item.projectId === id);
    const next: LocalDraft = existing
      ? { ...existing, scope: 'project', projectId: id, projectRevision: sourceRevision, contextPath: undefined }
      : { ...fresh(), scope: 'project', projectId: id, projectRevision: sourceRevision };
    if (next.id === currentRef.current.id) {
      if (!await flush()) return false;
      replace(next); acknowledged.current = ''; setNotice('');
      return flush();
    }
    return select(next);
  }, [flush, load, select, service]);
  async function forConversation(value: AssistantConversation): Promise<boolean> {
    const existing = draftsRef.current.find(item => item.conversationId === value.id);
    // An existing empty selection represents an explicit removal. Only recover
    // the last sent snapshot when no draft exists for this conversation.
    const attachments = (value.messages.filter(item => item.role === 'user').at(-1)?.attachments ?? []).map(item => ({ id: item.id, ...(item.startPage ? { startPage: item.startPage } : {}), ...(item.endPage ? { endPage: item.endPage } : {}) }));
    return select(existing ?? { ...fresh(), conversationId: value.id, scope: value.scope, attachments, ...(value.contextPath ? { contextPath: value.contextPath } : {}), ...(value.projectId ? { projectId: value.projectId } : {}), ...(value.projectRevision !== undefined ? { projectRevision: value.projectRevision } : {}) });
  }
  async function saveAsCopy(): Promise<boolean> {
    if (inFlight.current) await inFlight.current;
    replace({ ...currentRef.current, id: crypto.randomUUID(), revision: 0 }); acknowledged.current = '';
    const saved = await flush(); if (saved) setNotice('已另存当前草稿；其他窗口的版本也保留在草稿列表中。'); return saved;
  }
  return { current, currentRef, drafts, ready, saving, dirty: acknowledged.current !== fingerprint(current), error, conflict, notice, update, flush, load, select, newDraft, enterProject, forConversation, saveAsCopy };
}
