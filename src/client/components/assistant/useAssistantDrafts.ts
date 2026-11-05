import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReadConsoleApi } from '../../api/client.js';
import type { AssistantDraft, AssistantDraftFields } from '../../../shared/api/assistant-drafts.js';
import type { AssistantConversation } from '../../../shared/api/assistant.js';

type LocalDraft = AssistantDraftFields & { id: string; revision: number };
const fresh = (): LocalDraft => ({ id: crypto.randomUUID(), revision: 0, text: '', attachments: [], groupId: crypto.randomUUID(), scope: 'brain' });
const fields = ({ id: _id, revision: _revision, ...value }: LocalDraft): AssistantDraftFields => {
  const { text, attachments, groupId, scope, conversationId, contextPath, projectId, projectRevision, purpose, selection } = value;
  return { text, attachments, groupId, scope, ...(conversationId ? { conversationId } : {}), ...(contextPath ? { contextPath } : {}), ...(projectId ? { projectId } : {}), ...(projectRevision !== undefined ? { projectRevision } : {}), ...(purpose ? { purpose } : {}), ...(selection ? { selection } : {}) };
};
const fingerprint = (draft: LocalDraft) => JSON.stringify({ id: draft.id, ...fields(draft) });

type DraftContext = {
  service: ReadConsoleApi['assistantDrafts'];
  projectId: string | undefined;
  current: LocalDraft;
  drafts: AssistantDraft[];
  acknowledged: string;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  error: string;
  conflict: boolean;
  notice: string;
  sequence: number;
  inFlight?: Promise<boolean> | undefined;
};

export function useAssistantDrafts(service: ReadConsoleApi['assistantDrafts'], projectId?: string) {
  // A save owns its original context for its entire lifetime. Navigating away
  // must not redirect its loop, acknowledgement, or failure into another draft.
  const contexts = useRef(new Map<ReadConsoleApi['assistantDrafts'], Map<string | undefined, DraftContext>>());
  const context = useMemo(() => {
    let projects = contexts.current.get(service);
    if (!projects) { projects = new Map(); contexts.current.set(service, projects); }
    let entry = projects.get(projectId);
    if (!entry) {
      const blank = fresh();
      const current = projectId === undefined ? blank : { ...blank, scope: 'project' as const, projectId };
      entry = { service, projectId, current, drafts: [], acknowledged: fingerprint(current), loaded: !service, loading: false, saving: false, error: '', conflict: false, notice: '', sequence: 0 };
      projects.set(projectId, entry);
    }
    return entry;
  }, [service, projectId]);
  const [, redraw] = useState(0);
  const active = useRef(context); active.current = context;
  const mounted = useRef(false);
  const currentRef = useRef(context.current); currentRef.current = context.current;
  const publish = useCallback((entry: DraftContext) => {
    if (active.current === entry) {
      currentRef.current = entry.current;
      if (mounted.current) redraw(value => value + 1);
    }
  }, []);
  const replace = useCallback((draft: LocalDraft) => { context.current = draft; publish(context); }, [context, publish]);
  const update = useCallback((patch: Partial<AssistantDraftFields>) => { replace({ ...context.current, ...patch }); }, [context, replace]);

  const flushContext = useCallback((entry: DraftContext): Promise<boolean> => {
    if (!entry.service) return Promise.resolve(true);
    if (entry.inFlight) return entry.inFlight;
    const request = (async () => {
      entry.saving = true; publish(entry);
      try {
        while (entry.acknowledged !== fingerprint(entry.current)) {
          const snapshot = entry.current;
          const result = await entry.service!.save(snapshot.id, { ...fields(snapshot), expectedRevision: snapshot.revision, active: true });
          if (!result.ok) {
            entry.conflict = 'code' in result && result.code === 'ASSISTANT_DRAFT_CONFLICT';
            entry.error = 'state' in result ? result.state.message ?? '草稿尚未保存，请重试。' : '草稿尚未保存，请重试。';
            return false;
          }
          const saved = result.value.draft;
          entry.drafts = [saved, ...entry.drafts.filter(item => item.id !== saved.id)];
          entry.acknowledged = fingerprint(snapshot);
          if (entry.current.id === snapshot.id) entry.current = { ...entry.current, revision: saved.revision };
        }
        entry.error = ''; entry.conflict = false; return true;
      } catch { entry.error = '草稿尚未保存到本机，文字仍在此处。请重试后再切换对话。'; return false; }
      finally { entry.saving = false; publish(entry); }
    })();
    entry.inFlight = request;
    void request.finally(() => { if (entry.inFlight === request) entry.inFlight = undefined; });
    return request;
  }, [publish]);
  const flush = useCallback(() => flushContext(context), [context, flushContext]);

  const load = useCallback(async (requestedProjectId = projectId) => {
    if (!service || requestedProjectId !== context.projectId) return;
    const sequence = ++context.sequence;
    context.loading = true; publish(context);
    try {
      // Wait for this project's outgoing save, including one started when the
      // user navigated away. Failed local edits remain recoverable in memory.
      if (context.inFlight) await context.inFlight;
      const result = await service.list(undefined, requestedProjectId === undefined ? undefined : { projectId: requestedProjectId });
      if (sequence !== context.sequence) return;
      if (!result.ok) {
        context.error = 'state' in result ? result.state.message ?? '未能恢复本机草稿。' : '未能恢复本机草稿。';
        return;
      }
      context.drafts = result.value.drafts;
      if (context.acknowledged === fingerprint(context.current)) {
        const selected = result.value.drafts.find(item => item.id === result.value.activeId);
        const blank = fresh();
        context.current = selected ?? (requestedProjectId === undefined ? blank : { ...blank, scope: 'project', projectId: requestedProjectId });
        context.acknowledged = fingerprint(context.current);
        context.error = ''; context.conflict = false;
      }
      context.loaded = true;
    } catch { if (sequence === context.sequence) context.error = '未能恢复本机草稿，请重新连接后重试。'; }
    finally { if (sequence === context.sequence) { context.loading = false; publish(context); } }
  }, [context, projectId, service, publish]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    void load();
    return () => { context.sequence++; context.loading = false; void flushContext(context); };
  }, [context, load, flushContext]);
  const ready = !service || (context.loaded && !context.loading);
  const current = context.current;
  useEffect(() => {
    if (!ready || !service || context.acknowledged === fingerprint(current)) return;
    const timer = setTimeout(() => void flush(), 300); return () => clearTimeout(timer);
  }, [context, current, ready, service, flush]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const unsaved = [...contexts.current.values()].flatMap(projects => [...projects.values()])
        .filter(entry => entry.service && entry.acknowledged !== fingerprint(entry.current));
      if (!unsaved.length) return;
      for (const entry of unsaved) void flushContext(entry);
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload); return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [flushContext]);

  const select = useCallback(async (next: LocalDraft): Promise<boolean> => {
    if (!await flush() || active.current !== context) return false;
    if (next.id === context.current.id) next = context.current;
    replace(next); context.acknowledged = ''; context.notice = '';
    // Also records which draft should be restored after a full app restart.
    const saved = await flush();
    return saved && active.current === context;
  }, [context, flush, replace]);
  async function newDraft(text = '', attachments: AssistantDraftFields['attachments'] = [], learning?: Pick<AssistantDraftFields, 'purpose' | 'selection' | 'scope' | 'contextPath' | 'conversationId'>): Promise<boolean> {
    return select({
      ...fresh(), text, attachments,
      ...(projectId ? {
        scope: 'project', projectId,
        ...(context.current.projectId === projectId && context.current.projectRevision !== undefined ? { projectRevision: context.current.projectRevision } : {})
      } : learning ?? {})
    });
  }
  const enterProject = useCallback(async (id: string, sourceRevision: number): Promise<boolean> => {
    if (id !== context.projectId || !await flush() || active.current !== context) return false;
    if (service) await load(id);
    if (active.current !== context) return false;
    const existing = context.current.projectId === id ? context.current : context.drafts.find(item => item.projectId === id);
    const next: LocalDraft = existing
      ? { ...existing, scope: 'project', projectId: id, projectRevision: sourceRevision, contextPath: undefined }
      : { ...fresh(), scope: 'project', projectId: id, projectRevision: sourceRevision };
    if (next.id === context.current.id) {
      replace(next); context.acknowledged = ''; context.notice = '';
      return flush();
    }
    return select(next);
  }, [context, flush, load, replace, select, service]);
  async function forConversation(value: AssistantConversation): Promise<boolean> {
    const existing = context.drafts.find(item => item.conversationId === value.id);
    const attachments = (value.messages.filter(item => item.role === 'user').at(-1)?.attachments ?? []).map(item => ({ id: item.id, ...(item.startPage ? { startPage: item.startPage } : {}), ...(item.endPage ? { endPage: item.endPage } : {}) }));
    return select(existing ?? { ...fresh(), conversationId: value.id, scope: value.scope, attachments, ...(value.contextPath ? { contextPath: value.contextPath } : {}), ...(value.projectId ? { projectId: value.projectId } : {}), ...(value.projectRevision !== undefined ? { projectRevision: value.projectRevision } : {}), ...(value.purpose ? { purpose: value.purpose } : {}), ...(value.selection ? { selection: value.selection } : {}) });
  }
  async function saveAsCopy(): Promise<boolean> {
    if (context.inFlight) await context.inFlight;
    if (active.current !== context) return false;
    replace({ ...context.current, id: crypto.randomUUID(), revision: 0 }); context.acknowledged = '';
    const saved = await flush();
    if (saved) { context.notice = '已另存当前草稿；其他窗口的版本也保留在草稿列表中。'; publish(context); }
    return saved;
  }
  return { current, currentRef, drafts: context.drafts, ready, saving: context.saving, dirty: context.acknowledged !== fingerprint(current), error: context.error, conflict: context.conflict, notice: context.notice, update, flush, load, select, newDraft, enterProject, forConversation, saveAsCopy };
}
