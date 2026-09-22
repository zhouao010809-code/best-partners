import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, ChevronRight, Clock3, FileText, History, RefreshCw, ShieldCheck, Target, X } from 'lucide-react';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import type { OperationPage } from '../api/client.js';
import type { OperationQuery, OperationRecord } from '../../shared/api/schemas.js';
import { indexCanServe } from './pageSupport.js';
import '../styles/operations.css';

type View = NonNullable<OperationQuery['view']>;
const views: { id: View; label: string }[] = [{ id: 'attention', label: '需要处理' }, { id: 'running', label: '进行中' }, { id: 'all', label: '全部记录' }];
const kinds: Record<OperationRecord['kind'], string> = { archive: '资料归档', extraction: 'AI 提炼', ingestion: '知识入库', trash: '移入回收站', restore: '恢复资料', delete: '彻底删除', 'project-write': '项目输出' };
const dateLabel = (record: OperationRecord) => record.occurredAt ? new Date(record.occurredAt).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : '历史记录 · 时间未记录';
const timeLabel = (record: OperationRecord) => record.occurredAt ? new Date(record.occurredAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '时间未记录';

export function OperationsPage() {
  const { api, dataRevision, health } = useConsoleRuntime();
  const healthReady = health.status !== 'failed' && 'data' in health && indexCanServe(health.data);
  const [view, setView] = useState<View>('all');
  const chooseInitialView = useRef(true);
  const [data, setData] = useState<OperationPage>();
  const [selectedId, setSelectedId] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const mutation = useRef(false);
  const request = useRef<AbortController | undefined>(undefined);
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  const sheetTitle = useRef<HTMLHeadingElement | null>(null);
  const alive = useRef(true);
  const selected = data?.items.find(item => item.id === selectedId);

  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current?.abort(); }; }, []);
  useEffect(() => {
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    setLoading(true); setError('');
    void api.listOperations(controller.signal, { view: view || 'all' }).then(result => {
      if (controller.signal.aborted) return;
      if (!result.ok) { setError('操作记录暂时无法读取，请重试。已有记录可能不是最新状态。'); return; }
      if (chooseInitialView.current) {
        chooseInitialView.current = false;
        if ((result.value.counts?.attention || 0) > 0) { setView('attention'); return; }
      }
      setData(result.value);
    }).catch(() => { if (!controller.signal.aborted) setError('操作记录暂时无法读取，请重试。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, dataRevision, revision, view, healthReady]);
  useEffect(() => {
    if (!data?.counts?.running || busy || loading || error) return;
    const timer = window.setTimeout(() => setRevision(v => v + 1), 5000);
    return () => window.clearTimeout(timer);
  }, [data, busy, loading, error]);
  useEffect(() => { if (selectedId) sheetTitle.current?.focus({ preventScroll: true }); }, [selectedId]);
  function closeSheet() { setSelectedId(undefined); selectedButton.current?.focus(); }
  async function more() {
    if (!data?.nextCursor || loading) return;
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    setLoading(true); setError('');
    try {
      const result = await api.listOperations(controller.signal, { view: view || 'all', cursor: data.nextCursor });
      if (controller.signal.aborted) return;
      if (!result.ok) { setError('后续记录暂时无法读取，请重试。'); return; }
      setData(previous => ({ ...result.value, items: [...new Map([...(previous?.items || []), ...result.value.items].map(item => [item.id, item])).values()] }));
    } catch { if (!controller.signal.aborted) setError('后续记录暂时无法读取，请重试。'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  async function act(record: OperationRecord) {
    if (mutation.current) return;
    if (record.action.kind === 'refresh') { setRevision(v => v + 1); return; }
    mutation.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (record.action.kind === 'resume-archive') {
        if (!api.intake) throw new Error('当前连接不支持归档核验，请使用个人桌面 App。');
        const result = await api.intake.resume(record.sourceId);
        if (!alive.current) return;
        if (!result.ok) throw new Error('state' in result ? result.state.message || '归档核验未完成，请重试。' : '请求已中断，请刷新查看归档状态。');
        if (result.value.state !== 'archived') throw new Error('本次核验尚未完成，原文件与恢复记录仍保留。');
        setNotice(result.value.indexed ? '归档核验完成，检索已更新。' : '归档已完成，检索尚未更新，可在设置中刷新索引。');
      } else if (record.action.kind === 'resume-index') {
        if (!api.ingestion) throw new Error('当前连接不支持更新入库检索，请使用个人桌面 App。');
        const result = await api.ingestion.resume(record.sourceId);
        if (!alive.current) return;
        if (!result.ok) throw new Error('state' in result ? result.state.message || '检索更新未完成，请重试。' : '请求已中断，请刷新查看检索状态。');
        if (!result.value.indexed) throw new Error('文件已写入，检索仍未更新，请稍后重试。');
        setNotice('检索已更新，没有重复写入知识文件。');
      }
      if (alive.current) setRevision(v => v + 1);
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '操作未完成，请刷新查看状态。'); }
    finally { mutation.current = false; if (alive.current) setBusy(false); }
  }
  const groups = new Map<string, OperationRecord[]>();
  for (const record of data?.items || []) { const key = dateLabel(record); groups.set(key, [...(groups.get(key) || []), record]); }
  function changeView(next: View) { chooseInitialView.current = false; if (view === next) return; setView(next); setData(undefined); setSelectedId(undefined); }
  return <section className="operation-desk" aria-label="操作记录台" onKeyDown={event => { if (event.key === 'Escape' && !busy) closeSheet(); }}>
    <div className="operation-toolbar"><div className="operation-tabs" role="tablist" aria-label="操作记录视图">
      {views.map((tab, index) => <button key={tab.id} id={`operation-tab-${tab.id}`} type="button" role="tab" aria-controls="operation-records" aria-selected={(view || 'all') === tab.id} tabIndex={(view || 'all') === tab.id ? 0 : -1} disabled={busy}
        onKeyDown={event => { const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0; if (!delta) return; event.preventDefault(); const next = views[(index + delta + views.length) % views.length]!; changeView(next.id); document.getElementById(`operation-tab-${next.id}`)?.focus(); }} onClick={() => changeView(tab.id)}>
        {tab.label}{data?.counts && <span>{data.counts[tab.id]}{data.issues?.length ? '+' : ''}</span>}
      </button>)}
    </div><button type="button" className="operation-refresh" aria-label="刷新操作记录" title="刷新操作记录" disabled={loading || busy} onClick={() => setRevision(v => v + 1)}><RefreshCw size={17} className={loading ? 'operation-spinning' : ''} /></button></div>
    {data?.issues && data.issues.length > 0 && <div className="operation-warning" role="status"><strong>记录未完整读取</strong><span>{data.issues.join('；')}。数量仅包含已读取记录。</span></div>}
    {error && <div className="operation-warning" role="alert"><span>{error}</span><button disabled={busy || loading} onClick={() => setRevision(v => v + 1)}>重新读取</button></div>}
    {notice && <p className="operation-notice" role="status"><Check size={16} />{notice}</p>}
    <div className={`operation-layout${selected ? ' has-selection' : ''}`}>
      <div className="operation-records" id="operation-records" role="tabpanel" aria-labelledby={`operation-tab-${view || 'all'}`} aria-busy={loading}>
        {loading && !data && <div className="operation-empty" role="status"><RefreshCw className="operation-spinning" /><h2>正在读取操作记录</h2><p>整理本机保存的操作进展。</p></div>}
        {!loading && data && !data.items.length && <div className="operation-empty"><span className="operation-empty-mark">{view === 'attention' ? <Check /> : <History />}</span><h2>{view === 'attention' ? '当前没有需要处理的操作' : view === 'running' ? '当前没有进行中的操作' : '还没有操作记录'}</h2><p>{data.issues?.length ? '部分来源尚未读取，当前结果不代表全部记录。' : view === 'attention' ? '已完成的操作都保留在全部记录中。' : view === 'running' ? '有操作开始后，进展会显示在这里。' : '归档、提炼、入库与回收的记录会汇集在这里。'}</p></div>}
        {[...groups].map(([day, items]) => <section className="operation-day" key={day}><h2>{day}</h2><div className="operation-timeline">{items.map(record => <button type="button" key={record.id} disabled={busy} className={`operation-row is-${record.bucket}${selectedId === record.id ? ' is-selected' : ''}`} aria-expanded={selectedId === record.id} aria-controls={selectedId === record.id ? 'operation-work-slip' : undefined} onClick={event => { selectedButton.current = event.currentTarget; setSelectedId(record.id); setError(''); }}>
          <span className="operation-event-icon"><FileText size={21} strokeWidth={1.4} /></span><span className="operation-row-copy"><small>{kinds[record.kind]}</small><strong>{record.title}</strong><span>{record.summary}</span></span>
          <span className="operation-row-meta"><span className="operation-status">{record.bucket === 'attention' ? <Clock3 size={13} /> : record.bucket === 'running' ? <RefreshCw size={13} /> : <Check size={13} />}{record.statusLabel}</span><time title={record.timeLabel}>{timeLabel(record)}</time></span><ChevronRight size={18} className="operation-row-arrow" />
        </button>)}</div></section>)}
        {data?.nextCursor && <button className="operation-more" disabled={loading || busy} onClick={() => void more()}>{loading ? '正在读取…' : '加载更多记录'}<ChevronRight size={15} /></button>}
        {Boolean(data?.items.length) && <p className="operation-ledger-foot">{view === 'attention' ? '只呈现仍需处理的操作' : view === 'running' ? '进展会自动刷新' : '本机操作记录 · 原始状态可追溯'}</p>}
      </div>
      {selected && <aside id="operation-work-slip" className="operation-work-slip" aria-labelledby="operation-slip-title">
        <div className="operation-slip-clip" aria-hidden="true" /><button className="operation-slip-close" type="button" aria-label="关闭工作单" disabled={busy} onClick={closeSheet}><X size={21} /></button>
        <p className="operation-eyebrow">RECOVERY NOTE</p><h2 ref={sheetTitle} tabIndex={-1} id="operation-slip-title">恢复工作单</h2><div className="operation-slip-document"><h3>{selected.title}</h3><p>{kinds[selected.kind]} · {selected.statusLabel}</p></div>
        <div className="operation-slip-section"><Clock3 /><div><h3>发生了什么</h3><p>{selected.summary}</p></div></div><div className="operation-slip-section"><ShieldCheck /><div><h3>已经保留</h3><p>{selected.preserved}</p></div></div><div className="operation-slip-section"><Target /><div><h3>接下来</h3><p>{selected.nextStep}</p></div></div>
        <details key={selected.id} className="operation-technical"><summary>查看操作细节<ChevronRight size={15} /></summary><dl><dt>操作编号</dt><dd>{selected.sourceId}</dd><dt>{selected.timeLabel || '记录时间'}</dt><dd>{selected.occurredAt ? new Date(selected.occurredAt).toLocaleString('zh-CN') : '旧记录未保存时间'}</dd><dt>涉及位置</dt><dd>{selected.paths.map(path => <span key={path}>{path}</span>)}</dd></dl></details>
        {selected.action.kind === 'navigate' && selected.action.href ? <Link className="operation-primary" to={selected.action.href}>{selected.action.label}<ArrowRight size={18} /></Link> : <button type="button" className="operation-primary" disabled={busy || loading || (selected.action.kind === 'resume-archive' && !api.intake) || (selected.action.kind === 'resume-index' && !api.ingestion)} onClick={() => void act(selected)}>{busy ? '核验中…' : selected.action.label}<ArrowRight size={18} /></button>}
        <p className="operation-slip-foot">{selected.action.kind === 'resume-archive' ? '核验原操作，不重复归档' : selected.action.kind === 'resume-index' ? '只更新检索，不重复写入' : '沿用原操作流程，保留处理记录'}</p>
      </aside>}
    </div><footer className="operation-trash-note"><History size={18} /><span>删除资料的恢复与彻底删除，请前往回收站。</span><Link to="/trash">前往回收站<ChevronRight size={16} /></Link></footer>
  </section>;
}
