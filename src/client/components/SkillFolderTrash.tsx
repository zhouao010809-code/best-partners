import { useEffect, useRef, useState } from 'react';
import { ArchiveRestore, ChevronDown, Trash2 } from 'lucide-react';
import type { ReadConsoleApi } from '../api/client.js';
import type { SkillFolder, SkillFolderTrashEntry, SkillFolderTrashPreview } from '../../shared/api/skills.js';
import { isCancelled } from '../pages/pageSupport.js';

type SkillsApi = NonNullable<ReadConsoleApi['skills']>;
export function SkillFolderTrash({ api, folder, revision, disabled, onChanged, onMutationChange }: {
  api: SkillsApi;
  folder: SkillFolder | undefined;
  revision: number;
  disabled: boolean;
  onChanged(folderId: string | null): void;
  onMutationChange(busy: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<SkillFolderTrashPreview>();
  const [entries, setEntries] = useState<SkillFolderTrashEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [undo, setUndo] = useState<SkillFolderTrashEntry>();
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const actionRef = useRef<'preview' | 'commit' | 'restore' | undefined>(undefined);
  const operationRef = useRef<AbortController | undefined>(undefined);
  const mountedRef = useRef(true);
  const folderRef = useRef(folder);
  folderRef.current = folder;
  const dialogRef = useRef<HTMLElement>(null);
  const enabled = !!(api.previewFolderTrash && api.trashFolder && api.listFolderTrash && api.restoreFolder);

  useEffect(() => {
    mountedRef.current = true;
    actionRef.current = undefined;
    onMutationChange(false);
    setBusy(false); setPreview(undefined); setUndo(undefined); setMessage(undefined);
    setError(undefined); setEntries([]); setListError(undefined);
    return () => { mountedRef.current = false; operationRef.current?.abort(); onMutationChange(false); };
  }, [api, onMutationChange]);
  useEffect(() => {
    setPreview(undefined);
    if (actionRef.current === 'preview') { operationRef.current?.abort(); actionRef.current = undefined; setBusy(false); }
  }, [folder?.id, api]);
  useEffect(() => { if (preview) dialogRef.current?.focus(); }, [preview]);
  useEffect(() => {
    if (!open || !api.listFolderTrash) return;
    const controller = new AbortController();
    setLoading(true); setListError(undefined);
    void api.listFolderTrash(controller.signal).then(result => {
      if (controller.signal.aborted || isCancelled(result)) return;
      if (result.ok) setEntries(result.value.items.filter(entry => entry.status !== 'restored'));
      else setListError(result.state.message || '回收列表暂时无法读取，请重试。');
    }).catch(() => { if (!controller.signal.aborted) setListError('回收列表暂时无法读取，请重试。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, open, refresh, revision]);

  async function run(kind: 'preview' | 'commit' | 'restore', id: string) {
    if (actionRef.current) return;
    actionRef.current = kind; setBusy(true); setError(undefined); setMessage(undefined);
    if (kind !== 'preview') onMutationChange(true);
    const controller = new AbortController(); operationRef.current = controller;
    try {
      if (kind === 'preview') {
        const result = await api.previewFolderTrash!(id, controller.signal);
        if (!mountedRef.current || controller.signal.aborted || folderRef.current?.id !== id || isCancelled(result)) return;
        if (result.ok) setPreview(result.value);
        else setError(result.state.message || '无法预览文件夹，请刷新后重试。');
      } else {
        const result = await (kind === 'commit' ? api.trashFolder! : api.restoreFolder!)(id, controller.signal);
        if (!mountedRef.current || controller.signal.aborted || isCancelled(result)) return;
        if (!result.ok) { setError(result.state.message || '操作未完成，请刷新后核对。'); setRefresh(value => value + 1); return; }
        const entry = result.value;
        if (entry.status === 'needs-review') { setError(entry.problem || '现有文件已保留，请核对回收记录。'); return; }
        setPreview(undefined); setRefresh(value => value + 1);
        if (entry.status === 'trashed') {
          setUndo(entry); setMessage(`“${entry.name}”已移到文件夹回收站。`); onChanged(null);
        } else {
          setUndo(undefined); setMessage(`“${entry.name}”已恢复到原位置。`); onChanged(entry.folderId);
        }
      }
    } catch {
      if (mountedRef.current && !controller.signal.aborted) setError('操作未完成，请刷新回收列表核对后重试。');
    } finally {
      if (operationRef.current === controller) { actionRef.current = undefined; if (mountedRef.current) { setBusy(false); onMutationChange(false); } }
    }
  }

  if (!enabled) return null;
  return <section className="skills-folder-trash" aria-label="文件夹回收">
    <div className="skills-folder-trash__actions">
      {folder && <button type="button" disabled={disabled || busy} onClick={() => void run('preview', folder.id)}><Trash2 size={14} aria-hidden="true" />移到回收站</button>}
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}><ArchiveRestore size={14} aria-hidden="true" />文件夹回收站<ChevronDown size={14} aria-hidden="true" /></button>
    </div>
    {error && <p role="alert" className="skills-mutation-error">{error}</p>}
    {message && <div role="status" className="skills-folder-trash__status"><span>{message}</span>{undo && <button type="button" disabled={busy} onClick={() => void run('restore', undo.id)}>撤销回收</button>}</div>}
    {preview && <section ref={dialogRef} tabIndex={-1} role="dialog" aria-labelledby="skill-folder-trash-title" className="skills-folder-trash__confirm">
      <h3 id="skill-folder-trash-title">回收“{preview.name}”？</h3>
      <p>整个文件夹及其中所有内容都会一起移到应用回收区，包括隐藏文件和未识别条目。现有文件不会被永久删除，可在这里恢复。</p>
      <p>已识别 {preview.skillCount} 个 Skill · 文件夹内直接包含 {preview.entryCount} 项。回收后，这些 Skill 暂时不再参与推荐。</p>
      <div className="skills-folder-trash__actions"><button type="button" disabled={busy || disabled} onClick={() => void run('commit', preview.id)}>{busy ? '正在处理…' : '确认回收整个文件夹'}</button><button type="button" disabled={busy} onClick={() => { setPreview(undefined); setError(undefined); }}>取消回收</button></div>
    </section>}
    {open && <div className="skills-folder-trash__list">
      <div className="skills-folder-trash__list-heading"><h3>已回收文件夹</h3><button type="button" disabled={loading || busy} onClick={() => setRefresh(value => value + 1)}>刷新回收列表</button></div>
      {loading && <p role="status">正在读取回收列表…</p>}
      {listError && <p role="alert" className="skills-mutation-error">{listError}</p>}
      {!loading && !listError && entries.length === 0 && <p>还没有已回收文件夹。</p>}
      {entries.map(entry => <div key={entry.id} className="skills-folder-trash__row"><div><strong>{entry.name}</strong><p>{entry.skillCount} 个 Skill · {new Date(entry.createdAt).toLocaleString('zh-CN')}{entry.problem && <> · {entry.problem}</>}</p></div><button type="button" disabled={busy || entry.status !== 'trashed'} aria-label={`恢复：${entry.name}`} onClick={() => void run('restore', entry.id)}><ArchiveRestore size={14} aria-hidden="true" />恢复</button></div>)}
    </div>}
  </section>;
}
