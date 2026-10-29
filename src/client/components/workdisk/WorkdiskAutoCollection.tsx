import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Download, FolderOpen, Pause, Pencil, Play, Sparkles } from 'lucide-react';
import type { DesktopWorkdiskApi } from '../../../shared/desktop/bridge.js';
import type { WorkdiskAutoReceipt, WorkdiskAutoState } from '../../../shared/workdisk-auto.js';

function message(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /u, '') : '自动收纳暂时未完成，请稍后重试。';
}
export function WorkdiskAutoCollection({ disk, disabled = false, onChanged }: { disk: DesktopWorkdiskApi; disabled?: boolean; onChanged(): void }) {
  const [state, setState] = useState<WorkdiskAutoState>();
  const [naming, setNaming] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<{ id: string; title: string; receipt: WorkdiskAutoReceipt }>();
  const alive = useRef(true), action = useRef(false), generation = useRef(0), fingerprint = useRef('');
  const changed = useRef(onChanged); changed.current = onChanged;
  const accept = useCallback((next: WorkdiskAutoState) => {
    if (!alive.current) return;
    setState(next);
    if (next.source) setNaming(next.nameFromContent);
    const signature = JSON.stringify(next.receipts.filter(receipt => receipt.status === 'saved').map(receipt => [receipt.id, receipt.path]));
    if (signature !== fingerprint.current) {
      const hadFiles = fingerprint.current && fingerprint.current !== '[]'; fingerprint.current = signature;
      if (hadFiles || signature !== '[]') changed.current();
    }
  }, []);
  useEffect(() => {
    alive.current = true; let live = true, reading = false;
    const load = async () => {
      if (!disk.autoStatus || reading || action.current) return;
      reading = true; const sequence = generation.current;
      try { const next = await disk.autoStatus(); if (live && sequence === generation.current) { accept(next); setReadError(''); } }
      catch (cause) { if (live && sequence === generation.current) setReadError(message(cause)); }
      finally { reading = false; }
    };
    void load(); const timer = setInterval(() => void load(), 2000);
    return () => { live = false; alive.current = false; generation.current++; clearInterval(timer); };
  }, [disk, accept]);
  async function run(operation: () => Promise<WorkdiskAutoState | null | void>, after?: () => void) {
    if (action.current) return;
    action.current = true; generation.current++; setBusy(true); setError('');
    try { const next = await operation(); if (alive.current) { if (next) accept(next); after?.(); } }
    catch (cause) { if (alive.current) setError(message(cause)); }
    finally { action.current = false; if (alive.current) setBusy(false); }
  }
  if (!disk.autoStatus || !disk.chooseAutoSource || !disk.setAutoEnabled || !disk.setAutoNaming) return null;
  const blocked = busy || disabled;
  const savingNaming = Boolean(state?.source && naming !== state.nameFromContent);
  const phase = state?.phase === 'processing' ? '正在收纳' : state?.phase === 'error' ? '需要处理' : state?.enabled ? '正在接收' : state?.source ? '已暂停' : '尚未开启';
  const visibleReceipts = state?.receipts.slice(0, expanded ? undefined : 5) ?? [];
  if (editing && !visibleReceipts.some(receipt => receipt.id === editing.id)) visibleReceipts.push(editing.receipt);
  return <section className="workdisk-auto" aria-label="自动收纳">
    <header><div><Download size={22} /><span><h3>下载以后，自动收好</h3><p>照常保存文件，工作盘在后台接收、命名和分类。</p></span></div><span className={`workdisk-auto-state${state?.enabled ? ' is-on' : ''}`} role="status">{state ? phase : '正在读取设置…'}{state?.pendingCount ? ` · ${state.pendingCount} 份待收纳` : ''}</span></header>
    {state?.source && <div className="workdisk-auto-source"><FolderOpen size={15} /><strong>{state.source.displayName}</strong><span title={state.source.rootPath}>{state.source.rootPath}</span></div>}
    <div className="workdisk-auto-controls">
      <label><input type="checkbox" checked={naming} disabled={blocked || !state} aria-describedby="workdisk-auto-disclosure" onChange={event => {
        if (action.current) return;
        const value = event.target.checked, previous = naming;
        setNaming(value);
        if (state?.source) void run(async () => {
          try { return await disk.setAutoNaming!(value); }
          catch (cause) { if (alive.current) setNaming(previous); throw cause; }
        });
      }} /><span>自动根据内容命名</span><Sparkles size={14} /></label>
      <div>{!state?.source ? <button className="workdisk-primary" disabled={blocked || !state} onClick={() => void run(() => disk.chooseAutoSource!({ nameFromContent: naming }))}><Play size={14} />开启自动收纳</button>
        : <><button disabled={blocked} onClick={() => void run(() => disk.setAutoEnabled!(!state.enabled))}>{state.enabled ? <Pause size={14} /> : <Play size={14} />}{state.enabled ? '暂停自动收纳' : '继续自动收纳'}</button>
          <button disabled={blocked} onClick={() => void run(() => disk.chooseAutoSource!({ nameFromContent: naming }))}>更换接收文件夹</button>
          {disk.openAutoSource && <button disabled={busy} onClick={() => void run(() => disk.openAutoSource!())}>打开接收文件夹</button>}</>}
      </div>
    </div>
    <p id="workdisk-auto-disclosure" className="workdisk-auto-detail">{savingNaming ? '正在保存命名设置；保存完成前仍按之前的设置处理。' : naming ? <>文字和图片识别结果会发送给已连接的 AI，长文使用节选，原图留在本机；无法识别时保留原名。<Link to="/settings">连接 AI</Link></> : '按原名收纳，不会为自动命名发送内容。'}</p>
    <p className="workdisk-auto-detail">仅接收启用后新增的文件，不处理以前的下载；原件保留。应用运行时后台接收，关闭或暂停期间的新文件会在下次启动或继续时补收。请将要收纳的文件保存到上面的接收文件夹。</p>
    {state?.message && <p className="workdisk-auto-message">{state.message}</p>}
    {(error || readError) && <p className="workdisk-error" role="alert">{error || readError}</p>}
    {state && visibleReceipts.length > 0 && <div className="workdisk-auto-receipts"><h4>最近自动收纳 <span>保留最近 {state.receipts.length} 份结果</span>{(expanded || state.receipts.length > 5) && <button onClick={() => setExpanded(value => !value)}>{expanded ? '收起记录' : `查看全部 ${state.receipts.length} 条记录`}</button>}</h4><ul>
      {visibleReceipts.map(receipt => <li key={receipt.id} className={receipt.status === 'saved' ? '' : 'needs-attention'}>
        <div className="workdisk-auto-result"><span>{receipt.sourceName}</span><span aria-hidden="true">→</span><strong>{receipt.savedName ?? (receipt.status === 'uncertain' ? '需核对结果' : '未收好')}</strong>
          {receipt.status === 'saved' && receipt.path && <div className="workdisk-auto-result-actions"><button disabled={busy} aria-label={`打开 ${receipt.savedName}`} onClick={() => void run(() => disk.openFile(receipt.path!))}>打开</button>
            {disk.renameAutoReceipt && <button disabled={blocked} aria-label={`修改 ${receipt.savedName} 的名称`} onClick={() => { setError(''); setEditing({ id: receipt.id, title: (receipt.savedName ?? '').replace(/\.[^.]+$/u, ''), receipt }); }}><Pencil size={12} />改名</button>}</div>}
        </div>
        <p>{receipt.reason}</p>{receipt.path && <small>{receipt.path}</small>}
        {editing?.id === receipt.id && <form className="workdisk-auto-rename" onSubmit={event => { event.preventDefault(); void run(() => disk.renameAutoReceipt!(editing.id, editing.title.trim()), () => setEditing(undefined)); }}>
          <label>新的文件名称<input autoFocus aria-label="新的文件名称" value={editing.title} maxLength={60} disabled={busy} onChange={event => setEditing({ ...editing, title: event.target.value })} /></label>
          <button className="workdisk-primary" disabled={busy || !editing.title.trim()}><Check size={13} />保存名称</button><button type="button" disabled={busy} onClick={() => setEditing(undefined)}>取消</button><small>只改工作盘副本的名称，文件格式和原下载文件保留。</small>
        </form>}
      </li>)}
    </ul></div>}
  </section>;
}
