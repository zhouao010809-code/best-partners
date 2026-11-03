import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { WorkdiskFile } from '../../../shared/workdisk.js';
import type { XiaozhaoDesktopApi } from '../../../shared/desktop/bridge.js';

export function WorkdiskNote({ bindingId, date, dateForSubmission, disk, onClose, onSaved, onBusy }: { bindingId: string; date: string; dateForSubmission?(): string; disk: NonNullable<XiaozhaoDesktopApi['workdisk']>; onClose(): void; onSaved(file: WorkdiskFile): Promise<void>; onBusy(value: boolean): void }) {
  const key = `workdisk-note:${bindingId}`;
  const [draft, setDraft] = useState<{ title: string; body: string }>(() => {
    try { const saved: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null'); if (saved && typeof saved === 'object' && 'title' in saved && 'body' in saved && typeof saved.title === 'string' && typeof saved.body === 'string') return { title: saved.title, body: saved.body }; } catch { /* A draft is optional. */ }
    return { title: '', body: '' };
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  function change(next: typeof draft) { setDraft(next); try { sessionStorage.setItem(key, JSON.stringify(next)); } catch { setError('临时草稿未能保存，请将正文保存到工作盘。'); } }
  async function save() {
    if (savingRef.current || !draft.title.trim() || !draft.body.trim()) return;
    savingRef.current = true; setSaving(true); onBusy(true); setError('');
    try {
      const file = await disk.createNote({ ...draft, date: dateForSubmission?.() ?? date });
      try { sessionStorage.removeItem(key); } catch { /* File is already saved. */ }
      await onSaved(file);
    } catch (cause) { setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': Error: /u, '') : '保存失败，正文仍保留在这里。'); }
    finally { savingRef.current = false; setSaving(false); onBusy(false); }
  }
  return <form className="workdisk-note" onSubmit={event => { event.preventDefault(); void save(); }}>
    <header><strong>写一份文案</strong><button type="button" aria-label="收起文案" disabled={saving} onClick={onClose}><X size={16} /></button></header>
    <label>文案标题<input value={draft.title} maxLength={60} disabled={saving} onChange={event => change({ ...draft, title: event.target.value })} placeholder="给这份文案起个名字" required /></label>
    <label>文案正文<textarea value={draft.body} maxLength={250000} disabled={saving} onChange={event => change({ ...draft, body: event.target.value })} placeholder="把今天的想法写下来…" rows={8} required /></label>
    {error && <p role="alert">{error}</p>}<footer><small>将保存到 {date} / 文档 · 临时草稿在本次应用会话中保留</small><button className="workdisk-primary" disabled={saving || !draft.title.trim() || !draft.body.trim()}>{saving ? '正在保存…' : '保存到工作盘'}</button></footer>
  </form>;
}
