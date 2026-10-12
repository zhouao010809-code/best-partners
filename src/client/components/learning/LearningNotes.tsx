import { useEffect, useId, useRef, useState } from 'react';
import { BookOpen, ChevronDown, Save } from 'lucide-react';
import type { ReadConsoleApi } from '../../api/client.js';
import type { LearningSelection } from '../../../shared/api/learning.js';
import { learningNoteSaveSchema, type LearningNote, type LearningNoteSave } from '../../../shared/api/learning-notes.js';
import './LearningNotes.css';

type NoteOrigin = Pick<LearningNote, 'selection' | 'conversationId' | 'messageId'>;
type NoteDraft = NoteOrigin & { id: string; title: string; body: string; revision: number };
/** Owned by the panel for this runtime only; never shared across API/vault scopes. */
export type LearningNoteDraftCache = Map<string, NoteDraft>;
const draftKey = (origin: NoteOrigin) => `${origin.conversationId}:${origin.messageId}`;
function retainDraft(cache: LearningNoteDraftCache | undefined, draft: NoteDraft): void {
  cache?.set(draftKey(draft), draft);
}
type SaveProps = NoteOrigin & {
  api: ReadConsoleApi; initialBody: string; onSaved?: (note: LearningNote) => void; draftCache?: LearningNoteDraftCache;
};

function NoteEditor({ api, initial, onSaved, draftCache }: { api: ReadConsoleApi; initial: NoteDraft; onSaved?: ((note: LearningNote) => void) | undefined; draftCache?: LearningNoteDraftCache | undefined }) {
  // The initial snapshot is intentionally retained across list refreshes. A
  // stale edit conflicts at the service boundary rather than losing text.
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const titleId = useId(); const bodyId = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const update = (field: 'title' | 'body', value: string) => {
    const next = { ...draft, [field]: value };
    retainDraft(draftCache, next); setDraft(next); setSaved(false); setError('');
  };
  async function save() {
    if (!api.learningNotes || pending.current) return;
    const input: LearningNoteSave = { title: draft.title, body: draft.body, selection: draft.selection, conversationId: draft.conversationId, messageId: draft.messageId, expectedRevision: draft.revision };
    const parsed = learningNoteSaveSchema.safeParse(input);
    if (!parsed.success) { setError(parsed.error.issues[0]?.path[0] === 'title' ? '请填写笔记标题（最多 300 字）。' : '请填写笔记正文（最多 100000 字）。'); return; }
    pending.current = true; setBusy(true); setError(''); setSaved(false);
    try {
      const result = await api.learningNotes.save(draft.id, parsed.data);
      if (result.ok) {
        const next = { ...draft, title: result.value.note.title, body: result.value.note.body, revision: result.value.note.revision };
        const cached = draftCache?.get(draftKey(draft));
        // A late acknowledgement may update the retained draft after closing.
        // Never recreate a cleared scope or replace edits made after reopening.
        if (cached?.id === draft.id && cached.revision === draft.revision && cached.title === draft.title && cached.body === draft.body) retainDraft(draftCache, next);
        if (mounted.current) { setDraft(next); setSaved(true); onSaved?.(result.value.note); }
        window.dispatchEvent(new CustomEvent('learning-notes-updated', { detail: { api, path: result.value.note.selection.path, conversationId: result.value.note.conversationId } }));
      } else if (mounted.current) setError('state' in result ? result.state.message ?? '保存未完成，当前文字已保留，请重试。' : '保存已取消，当前文字已保留。');
    } catch { if (mounted.current) setError('保存未完成，当前文字已保留，请重试。'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <form className="learning-note-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
    <label htmlFor={titleId}>笔记标题</label>
    <input id={titleId} value={draft.title} onChange={event => update('title', event.target.value)} maxLength={300} disabled={busy} />
    <label htmlFor={bodyId}>笔记正文</label>
    <textarea id={bodyId} value={draft.body} onChange={event => update('body', event.target.value)} maxLength={100_000} rows={7} disabled={busy} />
    <div className="learning-note-actions">
      <button type="submit" disabled={busy || !draft.title.trim() || !draft.body.trim()}><Save aria-hidden="true" />{busy ? '正在保存…' : draft.revision ? '保存修改' : '确认保存笔记'}</button>
      {saved && <span role="status">已保存为学习笔记</span>}
    </div>
    {error && <p role="alert">{error}</p>}
  </form>;
}

export function SaveLearningNote({ api, selection, conversationId, messageId, initialBody, onSaved, draftCache }: SaveProps) {
  const cached = draftCache?.get(draftKey({ selection, conversationId, messageId }));
  const [open, setOpen] = useState(cached !== undefined);
  const [draft, setDraft] = useState<NoteDraft | undefined>(cached);
  const [saved, setSaved] = useState(false);
  const contentId = useId();
  if (!api.learningNotes) return null;
  const changed = draft && (draft.selection.path !== selection.path || draft.selection.revision !== selection.revision
    || draft.selection.text !== selection.text || draft.conversationId !== conversationId || draft.messageId !== messageId);
  return <section className="learning-note-save">
    <button type="button" className="learning-note-trigger" aria-expanded={open} aria-controls={contentId} onClick={() => {
      if (!draft) {
        const next = { id: crypto.randomUUID(), selection: { ...selection }, conversationId, messageId, title: `${selection.title} · 我的理解`.slice(0, 300), body: initialBody, revision: 0 };
        retainDraft(draftCache, next); setDraft(next);
      }
      setOpen(current => !current);
    }}><Save aria-hidden="true" />{saved ? '已保存理解' : '保存理解'}</button>
    {/* Keep the editor mounted while collapsed so unfinished edits survive. */}
    {draft && <div id={contentId} hidden={!open}>
      <p className="learning-note-hint">编辑后确认，保存在本机 App 的学习笔记中。</p>
      {changed && <p role="status">当前选文已变化；这份笔记保留原来的出处和未保存内容。</p>}
      <div className="learning-note-source"><strong>{draft.selection.title}</strong><blockquote>{draft.selection.text}</blockquote></div>
      <NoteEditor api={api} initial={draft} draftCache={draftCache} onSaved={note => { setSaved(true); onSaved?.(note); }} />
    </div>}
  </section>;
}

function SourceSnapshot({ api, selection, onOpenSource }: { api: ReadConsoleApi; selection: LearningSelection; onOpenSource?: ((path: string) => void) | undefined }) {
  const [state, setState] = useState<'checking' | 'current' | 'changed' | 'missing' | 'trashed' | 'deleted' | 'unknown'>('checking');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setState('checking');
    const read = selection.path.startsWith('02知识库/') ? api.getKnowledgeDetail.bind(api) : api.getDocumentDetail.bind(api);
    void read(selection.path, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.ok) setState(result.value.versionMarker.rawSha256 === selection.revision ? 'current' : 'changed');
      else {
        const code = 'code' in result ? result.code : undefined;
        if (code === 'SOURCE_IN_TRASH' || code === 'KNOWLEDGE_IN_TRASH') setState('trashed');
        else if (code === 'KNOWLEDGE_DELETED') setState('deleted');
        else if (['DOCUMENT_NOT_FOUND', 'KNOWLEDGE_NOT_FOUND', 'FILE_NOT_FOUND', 'PATH_NOT_FOUND'].includes(code ?? '')) setState('missing');
        else if (code === 'VERSION_CONFLICT') setState('changed');
        else setState('unknown');
      }
    }).catch(() => { if (!controller.signal.aborted) setState('unknown'); });
    return () => controller.abort();
  }, [api, selection.path, selection.revision, retry]);
  const status = {
    checking: '正在核验来源…', current: '来源可读取', changed: '原文已更新，下方保留保存时的选文。',
    missing: '来源暂不可读取，可能已移入回收站或删除；选文快照仍保留。',
    trashed: '来源已移入回收站；恢复后可以重新回看。', deleted: '来源已彻底删除；保存的选文快照仍可查看。', unknown: '暂时无法核验来源；选文快照仍保留。'
  }[state];
  return <div className="learning-note-source">
    <strong>{selection.title}</strong><span className="learning-note-path">{selection.path}</span>
    <p role="status">{status}</p>
    {(state === 'current' || state === 'changed') && onOpenSource && <button type="button" onClick={() => onOpenSource(selection.path)}><BookOpen aria-hidden="true" />回看来源</button>}
    {(state === 'unknown' || state === 'missing' || state === 'trashed' || state === 'deleted') && <button type="button" onClick={() => setRetry(value => value + 1)}>重新核验来源</button>}
    <blockquote>{selection.text}</blockquote>
  </div>;
}

function SavedNote({ api, note, onSaved, onOpenSource }: { api: ReadConsoleApi; note: LearningNote; onSaved: (note: LearningNote) => void; onOpenSource?: ((path: string) => void) | undefined }) {
  const [open, setOpen] = useState(false); const [opened, setOpened] = useState(false); const contentId = useId();
  return <article className="learning-note-item">
    <button type="button" className="learning-note-heading" aria-expanded={open} aria-controls={contentId} onClick={() => { setOpen(value => !value); setOpened(true); }}><ChevronDown aria-hidden="true" /><span>{note.title}</span></button>
    {opened && <div id={contentId} hidden={!open}>
      <SourceSnapshot api={api} selection={note.selection} onOpenSource={onOpenSource} />
      <NoteEditor api={api} initial={note} onSaved={onSaved} />
    </div>}
  </article>;
}

type LearningNotesProps = {
  api: ReadConsoleApi; path?: string; conversationId?: string; refreshKey?: string | number;
  onOpenSource?: (path: string) => void;
};

export function LearningNotes({ api, path, conversationId, refreshKey, onOpenSource }: LearningNotesProps) {
  const [open, setOpen] = useState(false); const [notes, setNotes] = useState<LearningNote[]>([]);
  const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [retry, setRetry] = useState(0);
  const contentId = useId();
  const scope = `${path ?? ''}\0${conversationId ?? ''}`; const previousScope = useRef(scope);
  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ api: ReadConsoleApi; path: string; conversationId: string }>).detail;
      if (detail?.api === api && (!path || path === detail.path) && (!conversationId || conversationId === detail.conversationId)) setRetry(value => value + 1);
    };
    window.addEventListener('learning-notes-updated', refresh);
    return () => window.removeEventListener('learning-notes-updated', refresh);
  }, [api, path, conversationId]);
  useEffect(() => {
    if (previousScope.current !== scope) { previousScope.current = scope; setNotes([]); }
    if (!open || !api.learningNotes || !path && !conversationId) return;
    const controller = new AbortController(); setLoading(true); setError('');
    void api.learningNotes.list({ ...(path ? { path } : {}), ...(conversationId ? { conversationId } : {}) }, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.ok) setNotes(result.value.notes);
      else if ('state' in result) setError(result.state.message ?? '学习笔记暂时无法读取，请重试。');
    }).catch(() => { if (!controller.signal.aborted) setError('学习笔记暂时无法读取，请重试。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, scope, path, conversationId, open, refreshKey, retry]);
  if (!api.learningNotes || !path && !conversationId) return null;
  return <section className="learning-notes">
    <button type="button" className="learning-note-heading" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen(value => !value)}><ChevronDown aria-hidden="true" />学习笔记</button>
    <div id={contentId} hidden={!open}>
      {loading && <p role="status">正在读取学习笔记…</p>}
      {error && <p role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></p>}
      {!loading && !error && notes.length === 0 && <p className="learning-note-hint">还没有学习笔记。可在回答下选择“保存理解”。</p>}
      {notes.map(note => <SavedNote key={`${scope}:${note.id}`} api={api} note={note} onOpenSource={onOpenSource} onSaved={saved => setNotes(current => current.map(value => value.id === saved.id ? saved : value))} />)}
    </div>
  </section>;
}
