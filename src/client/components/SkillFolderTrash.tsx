import { useEffect, useRef, useState } from 'react';
import { ArchiveRestore, ChevronDown, Trash2 } from 'lucide-react';
import type { ReadConsoleApi } from '../api/client.js';
import type { SkillFolder, SkillFolderTrashEntry, SkillFolderTrashPreview } from '../../shared/api/skills.js';
import { isCancelled } from '../pages/pageSupport.js';

type SkillsApi = NonNullable<ReadConsoleApi['skills']>;
type PreviewBatch = { items: SkillFolderTrashPreview[]; bulk: boolean };
type UndoBatch = { items: SkillFolderTrashEntry[]; bulk: boolean };
type Failure = { name: string; message: string };
const NO_FOLDERS: SkillFolder[] = [];
export function SkillFolderTrash({ api, folder, selectedFolders = NO_FOLDERS, onSelectionChange, revision, disabled, onChanged, onMutationChange }: {
  api: SkillsApi;
  folder: SkillFolder | undefined;
  selectedFolders?: SkillFolder[];
  onSelectionChange?(ids: string[]): void;
  revision: number;
  disabled: boolean;
  onChanged(folderId: string | null): void;
  onMutationChange(busy: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewBatch>();
  const [expired, setExpired] = useState(false);
  const [entries, setEntries] = useState<SkillFolderTrashEntry[]>([]);
  const [selectedTrash, setSelectedTrash] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string>();
  const [failures, setFailures] = useState<Failure[]>([]);
  const [message, setMessage] = useState<string>();
  const [progress, setProgress] = useState<string>();
  const [undo, setUndo] = useState<UndoBatch>();
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const actionRef = useRef<'preview' | 'commit' | 'restore' | undefined>(undefined);
  const operationRef = useRef<AbortController | undefined>(undefined);
  const mountedRef = useRef(true);
  const scopeRef = useRef(api);
  scopeRef.current = api;
  const previewScope = JSON.stringify([folder?.id, selectedFolders.map(value => value.id), revision]);
  const previewScopeRef = useRef(previewScope);
  previewScopeRef.current = previewScope;
  const dialogRef = useRef<HTMLElement>(null);
  const enabled = !!(api.previewFolderTrash && api.trashFolder && api.listFolderTrash && api.restoreFolder);

  useEffect(() => {
    mountedRef.current = true;
    actionRef.current = undefined;
    onMutationChange(false);
    setBusy(false); setPreview(undefined); setUndo(undefined); setMessage(undefined); setProgress(undefined);
    setFailures([]); setEntries([]); setSelectedTrash([]); setListError(undefined);
    return () => { mountedRef.current = false; operationRef.current?.abort(); onMutationChange(false); };
  }, [api, onMutationChange]);
  useEffect(() => { setPreview(undefined); }, [previewScope]);
  useEffect(() => {
    if (!preview) { setExpired(false); return; }
    dialogRef.current?.focus();
    const remaining = Math.min(...preview.items.map(value => Date.parse(value.expiresAt))) - Date.now();
    setExpired(!Number.isFinite(remaining) || remaining <= 0);
    if (remaining <= 0 || !Number.isFinite(remaining)) return;
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [preview]);
  useEffect(() => {
    if (!open || !api.listFolderTrash) return;
    const controller = new AbortController();
    setLoading(true); setListError(undefined);
    void api.listFolderTrash(controller.signal).then(result => {
      if (controller.signal.aborted || isCancelled(result)) return;
      if (result.ok) {
        const next = result.value.items.filter(entry => entry.status !== 'restored');
        setEntries(next);
        setSelectedTrash(current => current.filter(id => next.some(entry => entry.id === id && entry.status === 'trashed')));
      } else setListError(result.state.message || '回收列表暂时无法读取，请重试。');
    }).catch(() => { if (!controller.signal.aborted) setListError('回收列表暂时无法读取，请重试。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, open, refresh, revision]);

  function begin(kind: 'preview' | 'commit' | 'restore') {
    if (actionRef.current || disabled) return;
    actionRef.current = kind; setBusy(true); setFailures([]); setMessage(undefined);
    onMutationChange(true);
    const controller = new AbortController(); operationRef.current = controller;
    return controller;
  }
  function current(controller: AbortController) {
    return mountedRef.current && !controller.signal.aborted && operationRef.current === controller && scopeRef.current === api;
  }
  function finish(controller: AbortController) {
    if (operationRef.current !== controller || !current(controller)) return;
    actionRef.current = undefined; setBusy(false); setProgress(undefined); onMutationChange(false);
  }
  async function previewFolders(targets: SkillFolder[], bulk: boolean) {
    if (targets.length === 0) return;
    const controller = begin('preview'); if (!controller) return;
    const scope = previewScopeRef.current;
    setPreview(undefined);
    const collected: SkillFolderTrashPreview[] = []; const failed: Failure[] = [];
    try {
      for (const target of targets) {
        if (!current(controller) || previewScopeRef.current !== scope) return;
        setProgress(`正在核对文件夹 ${collected.length + failed.length + 1}/${targets.length}：${target.name}`);
        try {
          const result = await api.previewFolderTrash!(target.id, controller.signal);
          if (!current(controller) || previewScopeRef.current !== scope) return;
          if (result.ok) collected.push(result.value);
          else failed.push({ name: target.name, message: isCancelled(result) ? '预览中断，请重试。' : result.state.message || '无法预览，请刷新后重试。' });
        } catch { if (current(controller)) failed.push({ name: target.name, message: '无法预览，请刷新后重试。' }); }
      }
      if (!current(controller)) return;
      setFailures(failed);
      if (failed.length === 0) setPreview({ items: collected, bulk });
    } finally { finish(controller); }
  }
  async function mutate(kind: 'commit' | 'restore', targets: (SkillFolderTrashPreview | SkillFolderTrashEntry)[], bulk: boolean) {
    if (targets.length === 0) return;
    if (kind === 'commit' && targets.some(value => 'expiresAt' in value && Date.parse(value.expiresAt) <= Date.now())) { setExpired(true); return; }
    const controller = begin(kind); if (!controller) return;
    const succeeded: SkillFolderTrashEntry[] = []; const failed: Failure[] = []; const failedIds: string[] = [];
    let uncertain = false;
    try {
      for (let index = 0; index < targets.length; index++) {
        if (!current(controller)) return;
        const target = targets[index]!;
        setProgress(`正在${kind === 'commit' ? '回收' : '恢复'}文件夹 ${index + 1}/${targets.length}：${target.name}`);
        try {
          const result = await (kind === 'commit' ? api.trashFolder! : api.restoreFolder!)(target.id, controller.signal);
          if (!current(controller)) return;
          const expected = kind === 'commit' ? 'trashed' : 'restored';
          if (result.ok && result.value.status === expected) succeeded.push(result.value);
          else {
            if (!result.ok && (isCancelled(result) || result.state.status === 'disconnected')) uncertain = true;
            failedIds.push(kind === 'commit' ? target.folderId : target.id);
            failed.push({ name: target.name, message: result.ok ? result.value.problem || '记录状态已变化，请刷新回收列表核对。' : isCancelled(result) ? '结果未确认，请刷新回收列表核对。' : result.state.message || '操作未完成，请刷新回收列表核对。' });
          }
        } catch {
          if (!current(controller)) return;
          uncertain = true; failedIds.push(kind === 'commit' ? target.folderId : target.id);
          failed.push({ name: target.name, message: '结果未确认，请刷新回收列表核对后重试。' });
        }
      }
      if (!current(controller)) return;
      setFailures(failed);
      const verb = kind === 'commit' ? '回收' : '恢复';
      setMessage(bulk ? `已${verb} ${succeeded.length} 个文件夹${failed.length ? `，${failed.length} 个未完成。` : '。'}` : succeeded[0] ? `“${succeeded[0].name}”已${kind === 'commit' ? '移到文件夹回收站' : '恢复到原位置'}。` : undefined);
      if (kind === 'commit') {
        if (succeeded.length) setUndo({ items: succeeded, bulk });
        if (bulk) onSelectionChange?.(failedIds);
        if (succeeded.length || bulk || uncertain) setPreview(undefined);
      } else {
        setSelectedTrash(currentIds => currentIds.filter(id => !succeeded.some(entry => entry.id === id)));
        setUndo(currentUndo => {
          if (!currentUndo) return undefined;
          const remaining = currentUndo.items.filter(entry => !succeeded.some(value => value.id === entry.id));
          return remaining.length ? { ...currentUndo, items: remaining } : undefined;
        });
      }
      if (succeeded.length || uncertain) onChanged(kind === 'restore' && !bulk && succeeded.length === 1 ? succeeded[0]!.folderId : null);
      setRefresh(value => value + 1);
    } finally { finish(controller); }
  }

  if (!enabled) return null;
  const restorable = entries.filter(entry => entry.status === 'trashed');
  const allTrashSelected = restorable.length > 0 && restorable.every(entry => selectedTrash.includes(entry.id));
  return <section className="skills-folder-trash" aria-label="文件夹回收" aria-busy={busy}>
    <div className="skills-folder-trash__actions">
      {folder && selectedFolders.length === 0 && <button type="button" disabled={disabled || busy} onClick={() => void previewFolders([folder], false)}><Trash2 size={14} aria-hidden="true" />移到回收站</button>}
      {selectedFolders.length > 0 && <button type="button" disabled={disabled || busy} onClick={() => void previewFolders(selectedFolders, true)}><Trash2 size={14} aria-hidden="true" />批量移到回收站（{selectedFolders.length}）</button>}
      <button type="button" disabled={busy} aria-expanded={open} onClick={() => { setOpen(value => !value); setSelectedTrash([]); }}><ArchiveRestore size={14} aria-hidden="true" />文件夹回收站<ChevronDown size={14} aria-hidden="true" /></button>
    </div>
    {progress && <p role="status">{progress}。请停留在此页；如离开，请到文件夹回收站核对已完成项。</p>}
    {failures.length > 0 && <div role="alert" className="skills-mutation-error"><p>以下文件夹未完成；现有内容均保留，可核对后重试。</p><ul>{failures.map((failure, index) => <li key={`${failure.name}-${index}`}>{failure.name}：{failure.message}</li>)}</ul></div>}
    {message && <div role="status" className="skills-folder-trash__status"><span>{message}</span>{undo && <button type="button" disabled={busy || disabled} onClick={() => void mutate('restore', undo.items, undo.bulk)}>{undo.bulk ? '撤销本批回收' : '撤销回收'}</button>}</div>}
    {preview && <section ref={dialogRef} tabIndex={-1} role="dialog" aria-labelledby="skill-folder-trash-title" className="skills-folder-trash__confirm">
      <h3 id="skill-folder-trash-title">{preview.bulk ? `回收选中的 ${preview.items.length} 个文件夹？` : `回收“${preview.items[0]!.name}”？`}</h3>
      <p>整个文件夹及其中所有内容都会一起移到应用回收区，包括隐藏文件和未识别条目。现有文件不会被永久删除，可在这里恢复。</p>
      {preview.bulk && <ul className="skills-folder-trash__preview-items">{preview.items.map(item => <li key={item.id}><strong>{item.name}</strong> · {item.skillCount} 个 Skill · 直接包含 {item.entryCount} 项</li>)}</ul>}
      <p>已识别 {preview.items.reduce((count, value) => count + value.skillCount, 0)} 个 Skill · 文件夹内直接包含 {preview.items.reduce((count, value) => count + value.entryCount, 0)} 项。回收后，这些 Skill 暂时不再参与推荐。</p>
      {expired && <p role="alert">回收预览已过期，请重新预览后再确认。</p>}
      <div className="skills-folder-trash__actions"><button type="button" disabled={busy || disabled || expired} onClick={() => void mutate('commit', preview.items, preview.bulk)}>{busy ? '正在处理…' : preview.bulk ? `确认回收这 ${preview.items.length} 个文件夹` : '确认回收整个文件夹'}</button>{expired && <button type="button" disabled={busy || disabled} onClick={() => void previewFolders(preview.items.map(value => ({ id: value.folderId, name: value.name, skillCount: value.skillCount })), preview.bulk)}>重新预览所选文件夹</button>}<button type="button" disabled={busy} onClick={() => { setPreview(undefined); setFailures([]); }}>取消回收</button></div>
    </section>}
    {open && <div className="skills-folder-trash__list">
      <div className="skills-folder-trash__list-heading"><h3>已回收文件夹</h3><button type="button" disabled={loading || busy} onClick={() => { setSelectedTrash([]); setRefresh(value => value + 1); }}>刷新回收列表</button></div>
      {loading && <p role="status">正在读取回收列表…</p>}
      {listError && <p role="alert" className="skills-mutation-error">{listError}</p>}
      {!loading && !listError && entries.length === 0 && <p>还没有已回收文件夹。</p>}
      {restorable.length > 0 && <div className="skills-folder-trash__actions"><span>已选 {selectedTrash.length} 个回收文件夹</span><button type="button" disabled={busy || loading || !!listError || disabled} onClick={() => setSelectedTrash(allTrashSelected ? [] : restorable.map(entry => entry.id))}>{allTrashSelected ? '取消全选可恢复文件夹' : '全选可恢复文件夹'}</button><button type="button" disabled={busy || loading || !!listError || disabled || selectedTrash.length === 0} onClick={() => void mutate('restore', restorable.filter(entry => selectedTrash.includes(entry.id)), true)}>批量恢复（{selectedTrash.length}）</button></div>}
      {entries.map(entry => <div key={entry.id} className="skills-folder-trash__row"><input type="checkbox" aria-label={`选择回收文件夹：${entry.name}`} checked={selectedTrash.includes(entry.id)} disabled={busy || loading || !!listError || disabled || entry.status !== 'trashed'} onChange={event => setSelectedTrash(values => event.target.checked ? [...values, entry.id] : values.filter(id => id !== entry.id))} /><div><strong>{entry.name}</strong><p>{entry.skillCount} 个 Skill · {new Date(entry.createdAt).toLocaleString('zh-CN')}{entry.problem && <> · {entry.problem}</>}</p></div><button type="button" disabled={busy || loading || !!listError || disabled || entry.status !== 'trashed'} aria-label={`恢复：${entry.name}`} onClick={() => void mutate('restore', [entry], false)}><ArchiveRestore size={14} aria-hidden="true" />恢复</button></div>)}
    </div>}
  </section>;
}
