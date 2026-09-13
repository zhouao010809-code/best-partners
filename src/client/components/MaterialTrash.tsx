import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useMatch } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { ArchiveRestore, CheckCircle2, RefreshCw, Trash2, X } from 'lucide-react';
import { z } from 'zod';
import { trashIdSchema, trashPathRequestSchema, type TrashEntry, type TrashPreview, type TrashDeletePreview } from '../../shared/api/trash.js';
import type { ApiClientResult } from '../api/client.js';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import '../styles/material-trash.css';

type Material = { path: string; title: string; origin?: 'library' | 'queue' | 'knowledge' };
const pendingBase = z.object({ id: trashIdSchema, materialPath: trashPathRequestSchema.shape.materialPath, title: z.string() });
const pendingSchema = z.union([
  pendingBase.extend({ action: z.enum(['commit', 'restore', 'retry']) }),
  pendingBase.extend({ action: z.literal('delete'), token: trashIdSchema })
]);
type Pending = z.infer<typeof pendingSchema>;
const storageKey = 'brain-trash-pending-operation';
function readPending(): Pending | undefined {
  try { const parsed = pendingSchema.safeParse(JSON.parse(localStorage.getItem(storageKey) ?? 'null')); return parsed.success ? parsed.data : undefined; } catch { return undefined; }
}
function message(result: ApiClientResult<unknown>): string { return !result.ok && 'state' in result ? result.state.message ?? '操作暂未完成，请核对本次结果。' : '请求已取消，请核对本次结果。'; }
const statusText: Record<TrashEntry['status'], string> = { moving: '正在移入', trashed: '已移入回收站', restoring: '正在恢复', restored: '已恢复到原路径', 'needs-review': '需要核验', deleting: '正在彻底删除', deleted: '已彻底删除' };
const isSettled = (entry: TrashEntry) => entry.indexed && (entry.status === 'trashed' || entry.status === 'restored' || entry.status === 'deleted');
const Context = createContext<{ available: boolean; canPermanentlyDelete: boolean; busy: boolean; revision: number; open: (record: Material) => void; openDelete: (entry: TrashEntry) => void; perform: (entry: TrashEntry, action: 'restore' | 'retry') => void } | null>(null);
export function useMaterialTrash() { return useContext(Context)!; }

function References({ preview, permanent = false }: { preview: TrashPreview; permanent?: boolean }) {
  return <section className="material-trash-references"><h4>已有知识引用 · {preview.referencedKnowledge.length}</h4>
    {preview.referencedKnowledge.length ? <ul>{preview.referencedKnowledge.map((note) => <li key={note.path}><Link to={`/knowledge?path=${encodeURIComponent(note.path)}`}>{note.title}</Link><small>{note.path}</small></li>)}</ul> : <p>当前索引未发现知识引用。</p>}
    <p>{permanent ? '已有知识不会删除，但其中指向这份原始资料的链接将无法继续追溯。' : 'Obsidian 中的原路径链接暂时失效，恢复后可继续追溯。'}</p>
  </section>;
}

export function MaterialTrashProvider({ children, onChanged, allowPermanentDelete = false }: { children: ReactNode; onChanged: (entry: TrashEntry) => void; allowPermanentDelete?: boolean }) {
  const { api } = useConsoleRuntime(); const service = api.trash;
  const trashRoute = useMatch('/trash');
  const canPermanentlyDelete = allowPermanentDelete && Boolean(trashRoute);
  const permanentDeleteAllowed = useRef(canPermanentlyDelete); permanentDeleteAllowed.current = canPermanentlyDelete;
  const [pending, setPending] = useState<Pending | undefined>(readPending);
  const [visible, setVisible] = useState(Boolean(pending));
  const [target, setTarget] = useState<Material | undefined>(pending ? { path: pending.materialPath, title: pending.title } : undefined);
  const [preview, setPreview] = useState<TrashPreview>(); const [entry, setEntry] = useState<TrashEntry>();
  const [deletePreview, setDeletePreview] = useState<TrashDeletePreview>(); const [deleteMode, setDeleteMode] = useState(false);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [revision, setRevision] = useState(0);
  const [notRegistered, setNotRegistered] = useState(false);
  const [deleteNotRegistered, setDeleteNotRegistered] = useState(false);
  const epoch = useRef(0); const alive = useRef(true); const mutation = useRef(false);
  const previewRequest = useRef<AbortController | undefined>(undefined);
  const dialog = useRef<HTMLElement>(null); const trigger = useRef<HTMLElement | null>(null);
  const onChangedRef = useRef(onChanged); onChangedRef.current = onChanged;
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current += 1; previewRequest.current?.abort(); }; }, []);
  const close = useCallback(() => { if (mutation.current) return; epoch.current += 1; previewRequest.current?.abort(); setVisible(false); setPreview(undefined); setDeletePreview(undefined); setDeleteMode(false); setEntry(undefined); setBusy(false); setError(''); if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }); }, []);
  useEffect(() => { if (!canPermanentlyDelete && deleteMode) close(); }, [canPermanentlyDelete, deleteMode, close]);
  useEffect(() => {
    if (!visible) return;
    dialog.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),[tabindex="0"]') ?? []);
      const first = controls[0]; const last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', keydown, true); return () => window.removeEventListener('keydown', keydown, true);
  }, [visible, close]);
  function remember(next: Pending) {
    try { localStorage.setItem(storageKey, JSON.stringify(next)); setPending(next); return true; }
    catch { setError('无法在本机保留操作编号，尚未发送操作。请检查本机存储后重试。'); return false; }
  }
  function receive(value: TrashEntry, expected: Pending, queried: boolean) {
    if (value.id !== expected.id || value.materialPath !== expected.materialPath) { setError('返回记录与本次操作不匹配，请查询本次结果。'); return; }
    setEntry(value); setPreview(undefined); setDeletePreview(undefined); setDeleteMode(false); setError(''); setRevision((v) => v + 1); onChangedRef.current(value); window.dispatchEvent(new Event('brain-trash-changed'));
    if (expected.action === 'delete' && value.status !== 'deleted') {
      remember(expected);
      if (queried && (value.status === 'trashed' || value.status === 'restored')) setDeleteNotRegistered(true);
    }
    else if (expected.action === 'restore' && value.status === 'trashed') remember(expected);
    else if (isSettled(value)) { setPending(undefined); try { localStorage.removeItem(storageKey); } catch { /* A stale receipt can still be safely queried. */ } }
    else remember({ ...expected, action: 'retry' });
  }
  async function execute(operation: Pending, query = false) {
    if (!service || mutation.current) return;
    if (!query && operation.action === 'delete' && !permanentDeleteAllowed.current) return;
    // Verifying a deletion must not replace its durable confirmation token or send another delete.
    const retained = operation.action === 'retry' && pending?.action === 'delete' && pending.id === operation.id ? pending : operation;
    if (!query && !remember(retained)) return;
    setPreview(undefined); setDeletePreview(undefined); setDeleteMode(false);
    const current = ++epoch.current; const controller = new AbortController(); mutation.current = !query; setBusy(true); setError(''); setNotRegistered(false); setDeleteNotRegistered(false);
    try {
      const result = await (query ? service.get(operation.id, controller.signal) : operation.action === 'delete' ? service.delete(operation.id, operation.token) : service[operation.action](operation.id));
      if (!alive.current || current !== epoch.current) return;
      if (result.ok) receive(result.value, retained, query);
      else { setError(message(result)); if (query && operation.action === 'commit' && 'code' in result && result.code === 'TRASH_NOT_FOUND') setNotRegistered(true); }
    } catch { if (alive.current && current === epoch.current) setError('未收到明确结果，请使用本次操作编号查询，勿重新创建操作。'); }
    finally { if (current === epoch.current) { mutation.current = false; if (alive.current) setBusy(false); } }
  }
  async function open(record: Material) {
    if (!service || busy) return;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setVisible(true); setError(''); setPreview(undefined); setDeletePreview(undefined); setDeleteMode(false); setEntry(undefined);
    if (pending) { setTarget({ path: pending.materialPath, title: pending.title }); return; }
    setTarget(record); const current = ++epoch.current; setBusy(true);
    try { const result = await (record.origin ? service.preview(record.path, record.origin) : service.preview(record.path)); if (!alive.current || current !== epoch.current) return;
      if (result.ok) { if (result.value.materialPath !== record.path) setError('预览与所选资料不匹配，尚未移动任何文件。'); else setPreview(result.value); }
      else setError(message(result));
    } catch { if (alive.current && current === epoch.current) setError('预览暂不可用，尚未移动任何文件。'); }
    finally { if (alive.current && current === epoch.current) setBusy(false); }
  }
  async function openDelete(value: TrashEntry) {
    if (!permanentDeleteAllowed.current || !service || busy || !['trashed', 'deleting'].includes(value.status)) return;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setVisible(true); setError(''); setPreview(undefined); setDeletePreview(undefined); setEntry(undefined);
    if (pending && pending.id !== value.id) { setDeleteMode(false); setTarget({ path: pending.materialPath, title: pending.title }); return; }
    setDeleteMode(true); setTarget({ path: value.materialPath, title: value.title, ...(value.origin ? { origin: value.origin } : {}) });
    const current = ++epoch.current; previewRequest.current?.abort(); const controller = new AbortController(); previewRequest.current = controller; setBusy(true);
    try {
      const result = await service.previewDelete(value.id, controller.signal); if (!alive.current || current !== epoch.current || !permanentDeleteAllowed.current) return;
      if (result.ok) {
        if (result.value.id !== value.id || result.value.materialPath !== value.materialPath) setError('删除预览与所选资料不匹配，尚未发送删除。');
        else setDeletePreview(result.value);
      } else setError(message(result));
    } catch { if (alive.current && current === epoch.current) setError('删除预览暂不可用，尚未发送删除。'); }
    finally { if (alive.current && current === epoch.current) setBusy(false); }
  }
  function perform(value: TrashEntry, action: 'restore' | 'retry') {
    if (busy) return;
    if (action === 'restore' && (value.status !== 'trashed' || pending?.action === 'delete')) return;
    setDeleteMode(false); setDeletePreview(undefined);
    if (pending && pending.id !== value.id) { setVisible(true); setTarget({ path: pending.materialPath, title: pending.title }); setEntry(undefined); setPreview(undefined); return; }
    setVisible(true); setTarget({ path: value.materialPath, title: value.title }); setEntry(value); setPreview(undefined);
    void execute({ id: value.id, materialPath: value.materialPath, title: value.title, action });
  }
  function cancelAttempt() {
    try { localStorage.removeItem(storageKey); } catch { setError('无法清除本机尝试记录，请检查本机存储后重试。'); return; }
    setPending(undefined); setNotRegistered(false); setDeleteNotRegistered(false); close();
  }
  const knowledge = target?.path.startsWith('02知识库/');
  const noun = knowledge ? '知识文档' : '原始资料';
  const restoreStillTrashed = pending?.action === 'restore' && entry?.status === 'trashed';
  return <Context.Provider value={{ available: Boolean(service), canPermanentlyDelete, busy, revision, open: (record) => void open(record), openDelete: (value) => void openDelete(value), perform }}>
    {children}
    {pending && !visible && <div className="material-trash-pending" role="status">有一项回收操作待核验。<button type="button" onClick={() => { setTarget({ path: pending.materialPath, title: pending.title }); setVisible(true); }}>查看待核验操作</button></div>}
    {visible && createPortal(<div className="material-trash-overlay"><section className="material-trash-dialog" role="dialog" aria-modal="true" aria-label={deleteMode ? `彻底删除${noun}` : entry || pending ? '回收操作结果' : '移入回收站'} ref={dialog} tabIndex={-1}>
      <header><div><p className="material-trash-eyebrow">{knowledge ? 'KNOWLEDGE' : 'DOCUMENT'} / {deleteMode ? 'PERMANENT DELETE' : 'RECYCLE'}</p><h2>{deleteMode ? `彻底删除${noun}` : restoreStillTrashed ? '尚未恢复到原路径' : entry ? statusText[entry.status] : pending ? '核对本次回收操作' : '移入回收站'}</h2></div><button type="button" aria-label="关闭回收操作" disabled={busy && mutation.current} onClick={close}><X aria-hidden="true" /></button></header>
      <h3>{target?.title}</h3><p className="material-trash-path">{target?.path}</p>
      {!service && <p role="alert">当前连接不支持文档回收，请使用本机文件服务。</p>}
      {busy && <p role="status">{mutation.current ? '正在处理，请保留本次操作编号…' : '正在核对资料…'}</p>}
      {error && <p className="material-trash-error" role="alert">{error}</p>}
      {preview && !pending && <>
        <p>{knowledge ? `只移动选中的这一篇知识 Markdown（${preview.bytes.toLocaleString()} 字节）；原始资料、附件、其他知识和入库历史保持不变。` : `只移动这份 Markdown（${preview.bytes.toLocaleString()} 字节）；附件、目录、知识和提炼历史保持不变。`}</p>
        {knowledge ? <p>指向这篇知识的原路径链接暂时失效，恢复后可继续访问。</p> : <References preview={preview} />}
        {Date.parse(preview.expiresAt) <= Date.now() && <p role="status">预览已过期，请取消后重新预览。</p>}
        <div className="material-trash-actions"><button type="button" className="material-trash-confirm" disabled={busy || Date.parse(preview.expiresAt) <= Date.now()} onClick={() => {
          if (Date.parse(preview.expiresAt) <= Date.now()) { setError('预览已过期，请取消后重新预览。'); return; }
          void execute({ id: preview.id, materialPath: preview.materialPath, title: preview.title, action: 'commit' });
        }}><Trash2 aria-hidden="true" />确认移入回收站</button><button type="button" onClick={close} disabled={busy && mutation.current}>取消</button></div>
      </>}
      {canPermanentlyDelete && deleteMode && deletePreview && <>
        <p className="material-trash-irreversible">这份 Markdown 将被彻底删除，无法从 App 恢复。</p>
        <p>{knowledge ? `只删除选中的这一篇知识 Markdown（${deletePreview.bytes.toLocaleString()} 字节）；原始资料、附件、其他知识和入库历史保持不变。` : `只删除回收站中的这份 Markdown（${deletePreview.bytes.toLocaleString()} 字节）；附件、目录、知识和提炼历史保持不变。`}</p>
        {knowledge ? <p>指向这篇知识的链接将失效。</p> : <References preview={deletePreview} permanent />}
        {Date.parse(deletePreview.expiresAt) <= Date.now() && <p role="status">删除预览已过期，请取消后重新预览。</p>}
        <div className="material-trash-actions"><button type="button" className="material-trash-danger" disabled={busy || Date.parse(deletePreview.expiresAt) <= Date.now()} onClick={() => {
          if (Date.parse(deletePreview.expiresAt) <= Date.now()) { setError('删除预览已过期，请取消后重新预览。'); return; }
          void execute({ id: deletePreview.id, materialPath: deletePreview.materialPath, title: deletePreview.title, action: 'delete', token: deletePreview.token });
        }}><Trash2 aria-hidden="true" />确认彻底删除</button><button type="button" onClick={close} disabled={busy && mutation.current}>取消</button></div>
      </>}
      {!preview && !deletePreview && !entry && (!pending || deleteMode) && <button type="button" onClick={close}>取消</button>}
      {(pending || entry) && <p className="material-trash-operation">操作编号：{pending?.id ?? entry?.id}</p>}
      {entry && <>
        {entry.problem && <p role="status">{entry.problem}</p>}
        {entry.status === 'trashed' && <p>{knowledge ? '这篇知识已移入本机回收站，原始资料与其他知识均保留。' : '原资料已移入本机回收站，附件和已有知识均保留。'}</p>}
        {entry.status === 'restored' && <p>Markdown 已恢复，原路径链接可继续追溯。</p>}
        {entry.status === 'deleted' && <p>{knowledge ? '这篇知识 Markdown 已彻底删除，无法从 App 恢复。原始资料、其他知识和入库历史仍保留。' : '这份原始 Markdown 已彻底删除，无法从 App 恢复。附件、知识和提炼历史仍保留。'}</p>}
        {entry.status === 'deleting' && <p>本次删除已登记。继续核验只检查状态；如需继续删除，请再次明确确认。</p>}
        {!entry.indexed && <p role="status">文件操作状态已保留，检索尚未更新。请继续核验，无需重新移入回收站。</p>}
        <div className="material-trash-actions">
          {entry.status === 'trashed' && pending?.action !== 'delete' && <button type="button" disabled={busy} onClick={() => perform(entry, 'restore')}><ArchiveRestore aria-hidden="true" />{knowledge ? '恢复知识文档' : '恢复原资料'}</button>}
          {canPermanentlyDelete && (entry.status === 'trashed' && pending?.action !== 'delete' || entry.status === 'deleting') && <button type="button" className="material-trash-danger" disabled={busy} onClick={() => void openDelete(entry)}><Trash2 aria-hidden="true" />{entry.status === 'deleting' ? '重新确认彻底删除' : '彻底删除'}</button>}
          {!isSettled(entry) && <button type="button" disabled={busy} onClick={() => perform(entry, 'retry')}><RefreshCw aria-hidden="true" />继续核验</button>}
          {entry.status === 'restored' && <Link to={`/${knowledge ? 'knowledge' : 'library'}?path=${encodeURIComponent(entry.materialPath)}`} onClick={close}>查看恢复的文档</Link>}
          <Link to="/trash" onClick={close}>查看回收站</Link>
        </div>
      </>}
      {pending && !deleteMode && <div className="material-trash-actions"><button type="button" disabled={busy || !service} onClick={() => void execute(pending, true)}>查询本次结果</button>
        {pending.action === 'delete' ? canPermanentlyDelete && !deleteNotRegistered && <button type="button" className="material-trash-danger" disabled={busy || !service} onClick={() => void execute(pending)}>使用同一确认重试删除</button> : (!entry || restoreStillTrashed) && <button type="button" disabled={busy || !service} onClick={() => void execute(pending)}>使用同一编号重试{pending.action === 'commit' ? '确认' : pending.action === 'restore' ? '恢复' : '核验'}</button>}
      </div>}
      {!canPermanentlyDelete && (pending?.action === 'delete' || entry?.status === 'deleting') && <p>彻底删除需要在统一回收站内确认。<Link to="/trash" onClick={close}>前往回收站处理</Link></p>}
      {pending && notRegistered && <div className="material-trash-unregistered"><p>服务已确认此编号尚未登记。可以取消本次尝试，再重新预览资料；不会移动任何文件。</p><button type="button" disabled={busy} onClick={cancelAttempt}>取消本次尝试</button></div>}
      {pending?.action === 'delete' && deleteNotRegistered && !deleteMode && <div className="material-trash-unregistered"><p>{entry?.status === 'restored' ? '服务已确认资料已恢复，本次未删除。可以取消本次删除尝试；不会删除文件。' : '服务已确认删除尚未登记，资料仍在回收站。可以取消本次删除尝试，再重新预览；不会删除文件。'}</p><button type="button" disabled={busy} onClick={cancelAttempt}>取消本次删除尝试</button></div>}
    </section></div>, document.body)}
  </Context.Provider>;
}

export function MaterialTrashButton({ record, text = false, label = '移入回收站', disabled = false }: { record: Material; text?: boolean; label?: string; disabled?: boolean }) {
  const context = useContext(Context); if (!context?.available) return null;
  return <button type="button" className="material-trash-trigger" aria-label={`${label}：${record.title}`} title={label} disabled={context.busy || disabled} onClick={() => context.open(record)}><Trash2 aria-hidden="true" />{text && <span>{label}</span>}</button>;
}

export function MaterialTrashView() {
  const { api, dataRevision } = useConsoleRuntime(); const context = useContext(Context)!;
  const [items, setItems] = useState<TrashEntry[]>(); const [error, setError] = useState(''); const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!api.trash) return; const controller = new AbortController(); setError(''); setItems(undefined);
    void api.trash.list(controller.signal).then((result) => { if (controller.signal.aborted) return; if (result.ok) setItems(result.value.items); else setError(message(result)); })
      .catch(() => { if (!controller.signal.aborted) setError('回收站暂时无法读取，请重试。'); });
    return () => controller.abort();
  }, [api.trash, dataRevision, context.revision, refresh]);
  const active = items?.filter((item) => item.status !== 'restored' && item.status !== 'deleted') ?? []; const restored = items?.filter((item) => item.status === 'restored') ?? []; const deleted = items?.filter((item) => item.status === 'deleted') ?? [];
  function rows(values: TrashEntry[]) { return <ul className="material-trash-list">{values.map((item) => <li key={item.id}>
    <div className="material-trash-row-main"><strong>{item.title}</strong><span className={`material-trash-status material-trash-status--${item.status}`}>{statusText[item.status]}</span><p>{item.materialPath}</p><small>{item.status === 'deleted' ? '删除于' : item.status === 'restored' ? '恢复于' : '操作于'} {new Date(item.deletedAt ?? item.restoredAt ?? item.createdAt).toLocaleString('zh-CN')}</small>{item.problem && <p>{item.problem}</p>}{!item.indexed && <p>检索尚未更新</p>}</div>
    <div className="material-trash-actions">{item.status === 'trashed' && <button type="button" disabled={context.busy} aria-label={`恢复：${item.title}`} onClick={() => context.perform(item, 'restore')}><ArchiveRestore aria-hidden="true" />恢复</button>}
      {context.canPermanentlyDelete && (item.status === 'trashed' || item.status === 'deleting') && <button type="button" className="material-trash-danger" disabled={context.busy} aria-label={`${item.status === 'deleting' ? '重新确认彻底删除' : '彻底删除'}：${item.title}`} onClick={() => context.openDelete(item)}><Trash2 aria-hidden="true" />{item.status === 'deleting' ? '重新确认彻底删除' : '彻底删除'}</button>}
      {!isSettled(item) && <button type="button" disabled={context.busy} aria-label={`继续核验：${item.title}`} onClick={() => context.perform(item, 'retry')}><RefreshCw aria-hidden="true" />继续核验</button>}
      {item.status === 'restored' && <Link to={`/library?path=${encodeURIComponent(item.materialPath)}`}>查看原资料</Link>}
    </div></li>)}</ul>; }
  return <section className="material-trash-view" aria-labelledby="material-trash-heading"><header><div><p className="material-trash-eyebrow">LIBRARY / RECYCLE</p><h2 id="material-trash-heading">原始资料回收站</h2><p>仅保管手动移入的 Markdown；恢复到原路径，不覆盖同名文件。</p></div><button type="button" title="刷新回收站" aria-label="刷新回收站" onClick={() => setRefresh((v) => v + 1)}><RefreshCw aria-hidden="true" /></button></header>
    {!api.trash ? <p role="status">当前连接不支持原始资料回收，请使用本机文件服务。</p> : error ? <p role="alert">{error}</p> : !items ? <p role="status">正在读取回收站…</p> : <>
      {active.length ? rows(active) : <p className="material-trash-empty"><CheckCircle2 aria-hidden="true" />回收站为空</p>}
      {restored.length > 0 && <section className="material-trash-restored"><h3>已恢复记录 · {restored.length}</h3>{rows(restored)}</section>}
      {deleted.length > 0 && <details className="material-trash-deleted"><summary>已删除记录 · {deleted.length}</summary><p>这些原始资料已彻底删除，无法从 App 恢复。这里只保留操作记录。</p>{rows(deleted)}</details>}
    </>}
  </section>;
}
