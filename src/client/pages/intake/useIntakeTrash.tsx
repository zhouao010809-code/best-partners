import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useMatch } from 'react-router-dom';
import { ArchiveRestore, CheckCircle2, RefreshCw, Trash2, X } from 'lucide-react';
import { z } from 'zod';
import { intakeTrashIdSchema, intakeTrashNameSchema, type IntakeTrashEntry, type IntakeTrashPreview, type IntakeTrashDeletePreview } from '../../../shared/api/intake-trash.js';
import type { ApiClientResult, ReadConsoleApi } from '../../api/client.js';
import { useConsoleRuntime } from '../../app/ConsoleRuntime.js';
import '../../styles/intake-trash.css';

type Item = { name: string; title: string };
type Action = 'commit' | 'restore' | 'retry';
type Service = NonNullable<ReadConsoleApi['intakeTrash']>;
const storageKey = 'brain-intake-trash-pending-operation';
const pendingBase = z.object({
  id: intakeTrashIdSchema,
  name: intakeTrashNameSchema,
  title: z.string(),
});
const pendingSchema = z.union([pendingBase.extend({ action: z.enum(['commit', 'restore', 'retry']) }), pendingBase.extend({ action: z.literal('delete'), token: intakeTrashIdSchema })]);
type Pending = z.infer<typeof pendingSchema>;
const statusText: Record<IntakeTrashEntry['status'], string> = {
  moving: '正在移入回收站', trashed: '已移入回收站', restoring: '正在恢复',
  restored: '已恢复到收件箱', 'needs-review': '需要核验', deleting: '正在彻底删除', deleted: '已彻底删除'
};
const settled = (entry: IntakeTrashEntry) => entry.status === 'trashed' || entry.status === 'restored' || entry.status === 'deleted';
const footprint = (item: { fileCount: number; bytes: number }) => `${item.fileCount.toLocaleString()} 个文件 · ${item.bytes.toLocaleString()} 字节`;
function readPending(): Pending | undefined {
  try {
    const result = pendingSchema.safeParse(JSON.parse(localStorage.getItem(storageKey) ?? 'null'));
    return result.success ? result.data : undefined;
  } catch { return undefined; }
}
function failureMessage(result: ApiClientResult<unknown>): string {
  return !result.ok && 'state' in result ? result.state.message ?? '操作暂未完成，请核对本次结果。' : '请求已取消，请核对本次结果。';
}

export function useIntakeTrash(onChanged: (entry: IntakeTrashEntry) => void, options: { autoOpenPending?: boolean; allowPermanentDelete?: boolean } = {}): {
  available: boolean; busy: boolean; visible: boolean; open: (item: Item) => void;
  dialog: ReactNode; view: ReactNode; revision: number; openDelete: (entry: IntakeTrashEntry) => void;
  perform: (entry: IntakeTrashEntry, action: 'restore' | 'retry') => void;
} {
  const { api, dataRevision } = useConsoleRuntime();
  const service = api.intakeTrash;
  const trashRoute = useMatch('/trash');
  const canPermanentlyDelete = options.allowPermanentDelete === true && Boolean(trashRoute);
  const permanentDeleteAllowed = useRef(canPermanentlyDelete); permanentDeleteAllowed.current = canPermanentlyDelete;
  const [pending, setPending] = useState<Pending | undefined>(readPending);
  const pendingRef = useRef(pending);
  const [visible, setVisible] = useState(Boolean(pending) && options.autoOpenPending !== false);
  const [target, setTarget] = useState<Item | undefined>(pending);
  const [preview, setPreview] = useState<IntakeTrashPreview>();
  const [deletePreview, setDeletePreview] = useState<IntakeTrashDeletePreview>();
  const [deleteMode, setDeleteMode] = useState(false);
  const [deleteNotRegistered, setDeleteNotRegistered] = useState(false);
  const [entry, setEntry] = useState<IntakeTrashEntry>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notRegistered, setNotRegistered] = useState(false);
  const [revision, setRevision] = useState(0);
  const alive = useRef(true);
  const epoch = useRef(0);
  const busyRef = useRef(false);
  const mutationRef = useRef(false);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const dialogRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(false);
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; epoch.current += 1; requestRef.current?.abort(); busyRef.current = false; mutationRef.current = false; };
  }, []);

  const close = useCallback(() => {
    if (mutationRef.current) return;
    epoch.current += 1;
    requestRef.current?.abort();
    busyRef.current = false;
    restoreFocus.current = true;
    setBusy(false); setVisible(false); setPreview(undefined); setDeletePreview(undefined); setDeleteMode(false); setEntry(undefined); setError(''); setNotRegistered(false);
  }, []);

  useEffect(() => { if (!canPermanentlyDelete && deleteMode) close(); }, [canPermanentlyDelete, deleteMode, close]);

  useEffect(() => {
    if (visible || !restoreFocus.current) return;
    restoreFocus.current = false;
    const trigger = triggerRef.current;
    // Parent controls are disabled while the modal is visible; restore focus after that render commits.
    const fallback = [
      '[aria-label="刷新收件箱回收站"]:not(:disabled)',
      '[aria-label="刷新收件箱"]:not(:disabled)',
      '.intake-trash-toggle:not(:disabled)'
    ].map((selector) => document.querySelector<HTMLElement>(selector)).find(Boolean);
    const destination = trigger?.isConnected && !trigger.matches(':disabled') ? trigger : fallback;
    destination?.focus({ preventScroll: true });
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    dialogRef.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') ?? [])
        .filter((control) => !control.closest('[hidden],[inert]'));
      const first = controls[0]; const last = controls.at(-1);
      if (!first) { event.preventDefault(); dialogRef.current?.focus(); return; }
      const outside = !dialogRef.current?.contains(document.activeElement);
      if (event.shiftKey && (outside || document.activeElement === first || document.activeElement === dialogRef.current)) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (outside || document.activeElement === last)) {
        event.preventDefault(); first.focus();
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [visible, close]);

  function remember(operation: Pending): boolean {
    try {
      localStorage.setItem(storageKey, JSON.stringify(operation));
      pendingRef.current = operation; setPending(operation); return true;
    } catch { setError('无法在本机保留操作编号，尚未发送操作。请检查本机存储后重试。'); return false; }
  }
  function forget(): boolean {
    try { localStorage.removeItem(storageKey); }
    catch { setError('无法清除本机操作记录，请检查本机存储后重试。'); return false; }
    pendingRef.current = undefined; setPending(undefined); return true;
  }
  function receive(value: IntakeTrashEntry, operation: Pending, queried: boolean) {
    if (value.id !== operation.id || value.name !== operation.name) {
      setError('返回记录与本次操作不匹配，请查询本次结果。'); return;
    }
    setEntry(value); setTarget(value); setError(''); setRevision((value) => value + 1); window.dispatchEvent(new Event('brain-trash-changed'));
    // A restore rejected by a path collision must remain a pending restore even if a query returns "trashed".
    if (operation.action === 'delete' && value.status !== 'deleted') {
      if (queried && (value.status === 'trashed' || value.status === 'restored')) setDeleteNotRegistered(true);
    } else if (settled(value) && !(operation.action === 'restore' && value.status === 'trashed')) forget();
    changedRef.current(value);
  }
  async function execute(operation: Pending, query = false) {
    if (!service || busyRef.current) return;
    if (!query && operation.action === 'delete' && !permanentDeleteAllowed.current) return;
    const retained = pendingRef.current?.id === operation.id && pendingRef.current.action === 'delete' ? pendingRef.current : operation;
    if (!query && !remember(operation.action === 'delete' ? operation : retained)) return;
    busyRef.current = true; mutationRef.current = !query;
    const current = ++epoch.current;
    const controller = new AbortController(); requestRef.current = controller;
    setBusy(true); setError(''); setNotRegistered(false); setDeleteNotRegistered(false); setPreview(undefined); setDeletePreview(undefined); setDeleteMode(false); setEntry(undefined);
    try {
      const result = await (query ? service.get(operation.id, controller.signal) : operation.action === 'delete' ? service.delete(operation.id, operation.token) : service[operation.action](operation.id));
      if (!alive.current || current !== epoch.current) return;
      if (result.ok) receive(result.value, operation.action === 'delete' ? operation : retained, query);
      else {
        setError(failureMessage(result));
        if (query && 'code' in result && result.code === 'INTAKE_TRASH_NOT_FOUND') setNotRegistered(true);
      }
    } catch {
      if (alive.current && current === epoch.current) setError('未收到明确结果，请查询本次结果，或使用同一编号重试。');
    } finally {
      if (alive.current && current === epoch.current) {
        busyRef.current = false; mutationRef.current = false; setBusy(false);
      }
    }
  }
  function showPending() {
    const operation = pendingRef.current;
    if (!operation) return;
    rememberTrigger();
    setTarget(operation); setVisible(true); setEntry(undefined); setPreview(undefined); setDeletePreview(undefined); setDeleteMode(false); setError(''); setNotRegistered(false);
  }
  function rememberTrigger() {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !dialogRef.current?.contains(active)) triggerRef.current = active;
  }
  async function open(item: Item) {
    if (!service || busyRef.current) return;
    if (pendingRef.current) { showPending(); return; }
    rememberTrigger();
    busyRef.current = true;
    const current = ++epoch.current;
    const controller = new AbortController(); requestRef.current = controller;
    setVisible(true); setTarget(item); setEntry(undefined); setPreview(undefined); setError(''); setBusy(true); setNotRegistered(false);
    try {
      const result = await service.preview(item.name, controller.signal);
      if (!alive.current || current !== epoch.current) return;
      if (result.ok) {
        if (result.value.name !== item.name) setError('预览与所选资料包不匹配，尚未移动任何文件。');
        else { setPreview(result.value); setTarget(result.value); }
      } else setError(failureMessage(result));
    } catch { if (alive.current && current === epoch.current) setError('暂时无法预览资料包，尚未移动任何文件。'); }
    finally { if (alive.current && current === epoch.current) { busyRef.current = false; setBusy(false); } }
  }
  function perform(value: IntakeTrashEntry, action: Exclude<Action, 'commit'>) {
    if (busyRef.current || !service) return;
    if (pendingRef.current && (pendingRef.current.id !== value.id || action === 'restore')) { showPending(); return; }
    if (action === 'restore' && value.status !== 'trashed') return;
    rememberTrigger();
    setVisible(true); setTarget(value);
    void execute({ id: value.id, name: value.name, title: value.title, action });
  }
  async function openDelete(value: IntakeTrashEntry) {
    if (!permanentDeleteAllowed.current || !service || busyRef.current || !['trashed', 'deleting'].includes(value.status)) return;
    if (pendingRef.current && pendingRef.current.id !== value.id) { showPending(); return; }
    rememberTrigger(); busyRef.current = true;
    const current = ++epoch.current; const controller = new AbortController(); requestRef.current = controller;
    setTarget(value); setVisible(true); setDeleteMode(true); setDeletePreview(undefined); setPreview(undefined); setEntry(undefined); setError(''); setBusy(true);
    try {
      const result = await service.previewDelete(value.id, controller.signal);
      if (!alive.current || current !== epoch.current || !permanentDeleteAllowed.current) return;
      if (result.ok) {
        if (result.value.id !== value.id || result.value.name !== value.name) setError('删除预览与所选资料包不匹配，尚未发送删除。');
        else setDeletePreview(result.value);
      } else setError(failureMessage(result));
    } catch { if (alive.current && current === epoch.current) setError('删除预览暂不可用，尚未发送删除。'); }
    finally { if (alive.current && current === epoch.current) { busyRef.current = false; setBusy(false); } }
  }
  const restoringStillTrashed = entry?.status === 'trashed' && pending?.action === 'restore';
  const expired = preview ? !Number.isFinite(Date.parse(preview.expiresAt)) || Date.parse(preview.expiresAt) <= Date.now() : false;
  const dialog = <>
    {pending && !visible && <div className="intake-trash-pending" role="status">
      <span>有一项收件箱回收操作待核验。</span><button type="button" onClick={showPending}>查看待核验操作</button>
    </div>}
    {visible && createPortal(<div className="intake-trash-overlay">
      <section className="intake-trash-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label={deleteMode ? '彻底删除收件箱资料包' : pending || entry ? '收件箱回收操作' : '移入回收站'} tabIndex={-1}>
        <header><div><p className="intake-trash-eyebrow">INTAKE / RECYCLE</p>
          <h2 className={entry && settled(entry) && !restoringStillTrashed ? 'intake-trash-receipt' : undefined}>
            {entry && settled(entry) && !restoringStillTrashed && <CheckCircle2 aria-hidden="true" />}
            {deleteMode ? '彻底删除收件箱资料包' : restoringStillTrashed ? '尚未恢复到收件箱' : entry ? statusText[entry.status] : pending ? '核对本次回收操作' : '移入回收站'}
          </h2></div>
          <button type="button" aria-label="关闭回收操作" onClick={close} disabled={busy && mutationRef.current}><X aria-hidden="true" /></button>
        </header>
        <h3>{target?.title}</h3><p className="intake-trash-name">{target?.name}</p>
        {!service && <p role="alert">当前连接不支持收件箱回收，请连接本机服务。</p>}
        {busy && <p role="status">{mutationRef.current ? '正在处理资料包…' : '正在核对资料包…'}</p>}
        {error && <p className="intake-trash-error" role="alert">{error}</p>}
        {preview && !pending && <>
          <div className="intake-trash-scope"><p>将整个资料包及其自带附件移入回收站。</p><p>{footprint(preview)}</p><p>无需先填写信息或归档，可从回收站完整恢复。</p></div>
          {expired && <p role="status">预览已过期，请取消后重新预览。</p>}
          <div className="intake-trash-actions"><button type="button" className="intake-trash-confirm" disabled={busy || expired} onClick={() => {
            if (Date.parse(preview.expiresAt) <= Date.now()) { setError('预览已过期，请取消后重新预览。'); return; }
            void execute({ id: preview.id, name: preview.name, title: preview.title, action: 'commit' });
          }}><Trash2 aria-hidden="true" />确认移入回收站</button><button type="button" onClick={close}>取消</button></div>
        </>}
        {canPermanentlyDelete && deleteMode && deletePreview && <>
          <div className="intake-trash-scope intake-trash-irreversible"><p>整个资料包及其自带附件将被彻底删除，无法从 App 恢复。</p><p>{footprint(deletePreview)}</p><p>只删除回收站内的这份资料包，不影响包外文件。</p></div>
          {Date.parse(deletePreview.expiresAt) <= Date.now() && <p role="status">删除预览已过期，请取消后重新预览。</p>}
          <div className="intake-trash-actions"><button type="button" className="intake-trash-danger" disabled={busy || Date.parse(deletePreview.expiresAt) <= Date.now()} onClick={() => {
            if (Date.parse(deletePreview.expiresAt) <= Date.now()) { setError('删除预览已过期，请重新预览。'); return; }
            void execute({ id: deletePreview.id, name: deletePreview.name, title: deletePreview.title, action: 'delete', token: deletePreview.token });
          }}><Trash2 aria-hidden="true" />确认彻底删除</button><button type="button" onClick={close}>取消</button></div>
        </>}
        {!preview && !deletePreview && (!pending || deleteMode) && !entry && <button type="button" onClick={close}>取消</button>}
        {entry && <>
          <p className="intake-trash-footprint">{footprint(entry)}</p>
          {entry.problem && <p role="status">{entry.problem}</p>}
          {entry.status === 'trashed' && <p>{restoringStillTrashed ? '资料仍在回收站，恢复尚未完成。处理冲突后可使用同一编号重试恢复。' : '资料包及其自带附件已保留在本机回收站，可完整恢复。'}</p>}
          {entry.status === 'restored' && <p>资料包及其自带附件已恢复到收件箱，可继续查看或归档。</p>}
          {entry.status === 'deleted' && <p>资料包及其自带附件已彻底删除，无法从 App 恢复。</p>}
          {entry.status === 'deleting' && <p>删除尚未完成。继续核验只检查状态；继续删除需要重新明确确认。</p>}
          <div className="intake-trash-actions">
            {entry.status === 'trashed' && !pending && <button type="button" disabled={busy} onClick={() => perform(entry, 'restore')}><ArchiveRestore aria-hidden="true" />恢复到收件箱</button>}
            {canPermanentlyDelete && entry.status === 'deleting' && <button type="button" disabled={busy} onClick={() => void openDelete(entry)}><Trash2 aria-hidden="true" />重新确认彻底删除</button>}
            {!settled(entry) && <button type="button" disabled={busy || !service} onClick={() => void execute({ id: entry.id, name: entry.name, title: entry.title, action: 'retry' })}><RefreshCw aria-hidden="true" />继续核验</button>}
          </div>
        </>}
        {(pending || entry) && <p className="intake-trash-operation">操作编号：{pending?.id ?? entry?.id}</p>}
        {pending && !deleteMode && <div className="intake-trash-actions">
          <button type="button" disabled={busy || !service} onClick={() => void execute(pending, true)}>查询本次结果</button>
          {(pending.action !== 'delete' || canPermanentlyDelete) && !notRegistered && !deleteNotRegistered && (!entry || restoringStillTrashed) && <button type="button" disabled={busy || !service} onClick={() => void execute(pending)}>{pending.action === 'delete' ? '使用同一确认重试删除' : `使用同一编号重试${pending.action === 'commit' ? '确认' : pending.action === 'restore' ? '恢复' : '核验'}`}</button>}
        </div>}
        {!canPermanentlyDelete && (pending?.action === 'delete' || entry?.status === 'deleting') && <p>彻底删除需要在统一回收站内确认。<Link to="/trash" onClick={close}>前往回收站处理</Link></p>}
        {pending?.action === 'delete' && deleteNotRegistered && !deleteMode && <div className="intake-trash-unregistered"><p>{entry?.status === 'restored' ? '服务已确认资料包已恢复，本次未删除。' : '服务已确认删除尚未登记，资料包仍在回收站。'}可以取消本次删除尝试。</p><button type="button" disabled={busy} onClick={() => { if (forget()) close(); }}>取消本次删除尝试</button></div>}
        {pending && notRegistered && <div className="intake-trash-unregistered"><p>服务未找到本次操作记录。可以取消本次尝试，再重新查看资料包。</p><button type="button" disabled={busy} onClick={() => { if (forget()) close(); }}>取消本次尝试</button></div>}
      </section>
    </div>, document.body)}
  </>;
  return {
    available: Boolean(service), busy, visible, open: (item) => { void open(item); }, dialog, revision, openDelete: (entry) => { void openDelete(entry); }, perform,
    view: <IntakeTrashView service={service} revision={`${dataRevision}:${revision}`} busy={busy || visible} perform={perform} />
  };
}

function IntakeTrashView({ service, revision, busy, perform }: {
  service: Service | undefined; revision: string; busy: boolean;
  perform: (entry: IntakeTrashEntry, action: 'restore' | 'retry') => void;
}) {
  const [items, setItems] = useState<IntakeTrashEntry[]>();
  const [loading, setLoading] = useState(Boolean(service));
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!service) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError('');
    void (async () => {
      try {
        const result = await service.list(controller.signal);
        if (controller.signal.aborted) return;
        if (result.ok) setItems(result.value.items.filter((item) => item.status !== 'restored' && item.status !== 'deleted'));
        else setError(failureMessage(result));
      } catch { if (!controller.signal.aborted) setError('暂时无法读取回收站，请重试。'); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [service, revision, refresh]);
  return <section className="intake-trash-view" aria-label="收件箱回收站" aria-busy={loading}>
    <header><div><p className="intake-trash-eyebrow">INTAKE / RECYCLE</p><h2>收件箱回收站 {items && <span aria-label="回收站资料数量">{items.length}</span>}</h2></div>
      <button type="button" aria-label="刷新收件箱回收站" title="刷新" disabled={busy || loading || !service} onClick={() => setRefresh((value) => value + 1)}><RefreshCw aria-hidden="true" /></button>
    </header>
    {!service && <p role="status">当前连接不支持收件箱回收，请连接本机服务。</p>}
    {loading && <p role="status">正在读取回收站…</p>}
    {error && <p className="intake-trash-error" role="alert">{error}</p>}
    {!loading && !error && items?.length === 0 && <div className="intake-trash-empty"><Trash2 aria-hidden="true" /><p>回收站为空</p></div>}
    {items && items.length > 0 && <ul className="intake-trash-list">{items.map((item) => <li key={item.id}>
      <div className="intake-trash-row-main"><strong>{item.title}</strong><span className={`intake-trash-status intake-trash-status--${item.status}`}>{statusText[item.status]}</span>
        <p>{item.name}</p><p>{footprint(item)}</p>{item.problem && <p className="intake-trash-error">{item.problem}</p>}
      </div>
      {item.status === 'trashed' ? <button type="button" disabled={busy} aria-label={`恢复到收件箱：${item.title}`} onClick={() => perform(item, 'restore')}><ArchiveRestore aria-hidden="true" />恢复到收件箱</button>
        : <button type="button" disabled={busy} aria-label={`继续核验：${item.title}`} onClick={() => perform(item, 'retry')}><RefreshCw aria-hidden="true" />继续核验</button>}
    </li>)}</ul>}
  </section>;
}
