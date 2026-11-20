import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, BookOpen, ChevronDown, FileText, MessageCircle, Plus, Send } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { discussionStatusSchema, type DiscussionAction, type DiscussionHistoryItem, type DiscussionSession, type DiscussionStatus, type DiscussionSummary } from '../../shared/api/discussion.js';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import type { MaterialPage, ReadConsoleApi } from '../api/client.js';
import { DiscussionHistoryReader, historyTime } from '../components/DiscussionHistoryReader.js';
import { SafeMarkdown } from '../components/SafeMarkdown.js';
import '../styles/discussion.css';

type Material = MaterialPage['items'][number];
type DiscussionApi = NonNullable<ReadConsoleApi['discussion']>;
const phases: Record<DiscussionSession['phase'], string> = {
  prepared: '待开始', active: '探讨中', paused: '已暂停', ended: '已结束'
};
const fileTitle = (path: string) => path.split('/').at(-1)?.replace(/\.md$/iu, '') || path;
const issue = (error: unknown) => error instanceof Error ? error.message : '读取失败，请重试。';

async function archivedMaterials(api: ReadConsoleApi, signal: AbortSignal): Promise<Material[]> {
  const items: Material[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await api.listMaterials({ limit: 200, ...(cursor ? { cursor } : {}) }, signal);
    if (!page.ok) throw new Error('state' in page ? page.state.message || '资料暂时无法读取。' : '读取已取消。');
    items.push(...page.value.items.filter(item => item.processingStatus === '已归档'));
    cursor = page.value.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('资料列表发生变化，请刷新。');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return items;
}

function SourcePicker({ materials, selected, onChange, disabled, limit = 32 }: {
  materials: readonly Material[]; selected: readonly string[]; onChange(paths: string[]): void; disabled: boolean; limit?: number;
}) {
  const [filter, setFilter] = useState('');
  const visible = materials.filter(item => item.title.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
  return <div className="discussion-picker">
    <input type="search" value={filter} onChange={e => setFilter(e.target.value)} placeholder="按标题查找资料" aria-label="查找探讨资料" />
    <div className="discussion-options">
      {visible.map(item => <label key={item.path}><input type="checkbox" checked={selected.includes(item.path)}
        disabled={disabled || !selected.includes(item.path) && selected.length >= limit}
        onChange={e => onChange(e.target.checked ? [...selected, item.path] : selected.filter(path => path !== item.path))} />
        <span>{item.title}</span><small>{item.knowledgeStatus}</small></label>)}
      {visible.length === 0 && <p>{filter ? '没有匹配的资料。' : '没有可选的已归档资料。'}</p>}
    </div>
  </div>;
}

function SessionWorkspace({ session, api, materials, onChange, onBusy }: {
  session: DiscussionSession; api: DiscussionApi; materials: Material[];
  onChange(value: DiscussionSession): void; onBusy(busy: boolean): void;
}) {
  const [text, setText] = useState('');
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [adjusted, setAdjusted] = useState<Record<string, DiscussionStatus>>({});
  const [additional, setAdditional] = useState<string[]>([]);
  const locked = useRef(false);
  const mounted = useRef(true);
  const latest = useRef<HTMLDivElement>(null);
  const { refreshHealth } = useConsoleRuntime();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { latest.current?.scrollIntoView?.({ block: 'nearest' }); }, [session.messages.length]);
  const title = (path: string) => materials.find(item => item.path === path)?.title || fileTitle(path);
  async function submit(action: Exclude<DiscussionAction, {type: 'start' | 'continueChat'}>) {
    if (locked.current) return;
    locked.current = true; setWorking(action.type); onBusy(true); setError('');
    try {
      const updated = await api.act({ ...action, expectedUpdatedAt: session.updatedAt });
      if (!mounted.current) return;
      onChange(updated);
      if (action.type === 'message') setText('');
      if (action.type === 'addMaterials') setAdditional([]);
      if (action.type === 'confirm') setAdjusted({});
      if (action.type === 'confirm' || action.type === 'diary') void refreshHealth().catch(() => undefined);
    } catch (failure) { if (mounted.current) setError(issue(failure)); }
    finally { locked.current = false; if (mounted.current) { setWorking(''); onBusy(false); } }
  }
  const busy = Boolean(working);
  const active = session.phase === 'active';
  return <section className="discussion-paper" aria-label="探讨会话">
    <header className="discussion-heading"><div><span>{phases[session.phase]}</span><h2>{session.title}</h2></div>
      <div className="discussion-actions">
        {active && <button disabled={busy} onClick={() => void submit({ type: 'pause', id: session.id })}>暂停探讨</button>}
        {session.phase !== 'ended' && <button disabled={busy} onClick={() => void submit({ type: 'end', id: session.id })}>结束交流</button>}
      </div>
    </header>
    {session.materialPaths.length > 0 && <div className="discussion-sources">{session.materialPaths.map(path =>
      <Link key={path} to={`/library?${new URLSearchParams({ path })}`}><FileText size={14} />{title(path)}</Link>)}</div>}
    <div className="discussion-transcript" aria-label="探讨对话">
      {session.messages.map((msg, index) => <article key={index} data-role={msg.role}>
        <strong>{msg.role === 'user' ? '小兆' : 'AI'}</strong><SafeMarkdown>{msg.text}</SafeMarkdown>
      </article>)}<div ref={latest} />
    </div>
    {session.phase === 'prepared' && <button className="discussion-primary" disabled={busy} onClick={() => void submit({ type: 'begin', id: session.id })}>开始探讨 <ArrowRight size={16} /></button>}
    {session.phase === 'paused' && <button className="discussion-primary" disabled={busy} onClick={() => void submit({ type: 'resume', id: session.id })}>继续探讨 <ArrowRight size={16} /></button>}
    {active && <form className="discussion-composer" onSubmit={e => { e.preventDefault(); if (text.trim()) void submit({ type: 'message', id: session.id, text }); }}>
      <label htmlFor="discussion-message">说说你的想法</label>
      <textarea id="discussion-message" rows={3} maxLength={32000} value={text} disabled={busy} onChange={e => setText(e.target.value)} />
      <button className="discussion-primary" disabled={busy || !text.trim()}><Send size={14} />发送</button>
    </form>}
    {(active || session.phase === 'prepared') && session.materialPaths.length < 32 && <details className="discussion-extra"><summary>补充资料 <ChevronDown size={14} /></summary>
      <SourcePicker materials={materials.filter(item => !session.materialPaths.includes(item.path))} selected={additional} onChange={setAdditional} disabled={busy} limit={32 - session.materialPaths.length} />
      <button disabled={busy || !additional.length} onClick={() => void submit({ type: 'addMaterials', id: session.id, materialPaths: additional })}>加入本次探讨</button>
    </details>}
    {session.proposals.length > 0 && <section className="discussion-progress"><h3>确认资料进度</h3>
      {session.proposals.map(item => <div key={item.path}><strong>{title(item.path)}</strong>
        <p>已探讨 · {item.covered || '暂无'}</p><p>待探讨 · {item.remaining || '暂无'}</p>
        <label>探讨状态 <select disabled={busy} value={adjusted[item.path] ?? item.status} onChange={e => setAdjusted({ ...adjusted, [item.path]: e.target.value as DiscussionStatus })}>
          {discussionStatusSchema.options.map(value => <option key={value}>{value}</option>)}</select></label></div>)}
      <button disabled={busy} onClick={() => void submit({ type: 'confirm', id: session.id, progress: session.proposals.map(item => ({path: item.path, status: adjusted[item.path] ?? item.status})) })}>确认进度</button>
    </section>}
    {session.messages.some(message => message.role === 'user') && <div className="discussion-diary"><button disabled={busy} onClick={() => void submit({ type: 'diary', id: session.id })}><BookOpen size={15} />{session.diaryPath ? '更新小兆日记' : '整理小兆日记'}</button></div>}
    {session.chatPath && <p className="discussion-saved">聊天记录已保存 · {fileTitle(session.chatPath)}</p>}
    {session.diaryPath && <section className="discussion-result"><h3>{fileTitle(session.diaryPath)}</h3>
      {session.diaryMarkdown && <SafeMarkdown>{session.diaryMarkdown.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/u,'')}</SafeMarkdown>}
      <h4>本次整理的知识</h4>{session.knowledgePaths.length ? <ul>{session.knowledgePaths.map(path =>
        <li key={path}><Link to={`/knowledge?${new URLSearchParams({ path })}`}>{fileTitle(path)}</Link></li>)}</ul> : <p>本次没有新增或更新知识。</p>}
    </section>}
    {session.notice && <p role="status" className="discussion-notice">{session.notice}</p>}
    {busy && <p role="status">{working === 'diary' ? '正在整理日记和相关知识…' : '正在处理…'}</p>}
    {error && <p role="alert" className="discussion-error">{error} <button disabled={busy} onClick={() => void submit({ type: 'open', id: session.id })}>重新读取会话</button></p>}
  </section>;
}

export function DiscussionPage() {
  const { api, dataRevision, health } = useConsoleRuntime();
  const service = api.discussion;
  const [params, setParams] = useSearchParams();
  const id = params.get('id');
  const source = params.get('materialPath');
  const chatPath = params.get('chatPath');
  const [records, setRecords] = useState<DiscussionHistoryItem[]>();
  const [recordError, setRecordError] = useState('');
  const [sessions, setSessions] = useState<DiscussionSummary[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loadingSources, setLoadingSources] = useState(true);
  const [historyError, setHistoryError] = useState('');
  const [materialError, setMaterialError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string[]>(source ? [source] : []);
  const [session, setSession] = useState<DiscussionSession>();
  const [retry, setRetry] = useState(0);
  const cached = useRef<DiscussionSession | undefined>(undefined);
  const startKey = useRef<{ payload: string; key: string } | undefined>(undefined);
  const starting = useRef(false);
  const locationKey = id || chatPath || source || '';
  const locationRef = useRef(locationKey);
  locationRef.current = locationKey;
  useEffect(() => {
    const controller = new AbortController();
    setLoadingSources(true); setMaterialError('');
    void archivedMaterials(api, controller.signal).then(items => {
      if (!controller.signal.aborted) setMaterials(items);
    }).catch(failure => { if (!controller.signal.aborted) setMaterialError(issue(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoadingSources(false); });
    return () => controller.abort();
  }, [api, dataRevision, retry]);
  useEffect(() => {
    if (!service) return;
    const controller = new AbortController(); setHistoryError('');
    void service.list(controller.signal).then(items => { if (!controller.signal.aborted) setSessions(items); })
      .catch(failure => { if (!controller.signal.aborted) setHistoryError(issue(failure)); });
    return () => controller.abort();
  }, [service, retry]);
  useEffect(() => {
    if (!service) return;
    const controller = new AbortController(); setRecordError('');
    void service.history(controller.signal).then(items => { if (!controller.signal.aborted) setRecords(items); })
      .catch(failure => { if (!controller.signal.aborted) setRecordError(issue(failure)); });
    return () => controller.abort();
  }, [service, dataRevision, retry, session?.chatPath]);
  useEffect(() => {
    setBusy(false); setError(''); setSelected(source ? [source] : []); setText('');
    if (!id || !service) { setSession(undefined); return; }
    if (cached.current?.id === id) { setSession(cached.current); return; }
    setSession(undefined);
    const controller = new AbortController();
    void service.act({ type: 'open', id }, controller.signal).then(value => { if (!controller.signal.aborted) setSession(value); })
      .catch(failure => { if (!controller.signal.aborted) setError(issue(failure)); });
    return () => controller.abort();
  }, [id, source, chatPath, service, retry]);
  const apply = useCallback((value: DiscussionSession) => {
    cached.current = value; setSession(value);
    setSessions(previous => [value, ...previous.filter(item => item.id !== value.id)]);
  }, []);
  function newTopic() {
    cached.current = undefined;
    setParams({}); setSelected([]); setText(''); setError(''); startKey.current = undefined;
  }
  function openSession(next: string) {
    cached.current = undefined; setParams({id: next});
  }
  async function start(action: Extract<DiscussionAction, { type: 'start' | 'continueChat' }>) {
    if (!service || starting.current) return;
    const payload = JSON.stringify(action);
    if (startKey.current?.payload !== payload) startKey.current = { payload, key: crypto.randomUUID() };
    starting.current = true; setBusy(true); setError('');
    const original = locationKey;
    try {
      const value = await service.act({ ...action, requestId: startKey.current.key });
      if (locationRef.current !== original) return;
      apply(value); setParams({ id: value.id }); startKey.current = undefined;
    } catch (failure) { if (locationRef.current === original) setError(issue(failure)); }
    finally { starting.current = false; if (locationRef.current === original) setBusy(false); }
  }
  if (!service) return <p role="alert">当前连接不支持探讨，请打开新版个人桌面应用。</p>;
  const relevant = source ? sessions.find(item => item.phase !== 'ended' && item.materialPaths.includes(source)) : undefined;
  const unknownSource = selected.some(path => !materials.some(item => item.path === path));
  const modelMissing = 'data' in health && health.data?.model.status === 'unconfigured';
  return <div className="discussion-workspace">
    <aside className="discussion-history"><button className="discussion-new" disabled={busy} onClick={newTopic}><Plus size={16} />新探讨</button>
      <h2>最近探讨</h2>
      {sessions.map(item => <button key={item.id} aria-current={id === item.id ? 'page' : undefined} disabled={busy} onClick={() => openSession(item.id)}>
        <MessageCircle size={15} /><span>{item.title}<small>{phases[item.phase]}</small></span></button>)}
      {!sessions.length && !historyError && <p>还没有在此应用中发起的探讨。</p>}
      {historyError && <p role="alert">{historyError} <button onClick={() => setRetry(n => n + 1)}>重新读取</button></p>}
      <h2>大脑里的聊天记录</h2>
      {records?.map(item => <button key={item.path} disabled={busy} aria-current={!id && chatPath === item.path ? 'page' : undefined}
        onClick={() => setParams({ chatPath: item.path })}><FileText size={15} /><span>{item.title}<small>{historyTime(item.startedAt)}</small></span></button>)}
      {!recordError && !records && <p role="status">正在读取记录…</p>}
      {!recordError && records?.length === 0 && <p>日记本里还没有聊天记录。</p>}
      {recordError && <p role="alert">{recordError} <button onClick={() => setRetry(n => n + 1)}>刷新聊天记录</button></p>}
    </aside>
    <div className="discussion-main">
      {modelMissing && <p className="discussion-notice">探讨使用本机的模型设置。<Link to="/settings#ai-model-settings">配置 DeepSeek 密钥</Link></p>}
      {materialError && <p role="alert" className="discussion-error">{materialError} <button onClick={() => setRetry(n => n + 1)}>刷新资料</button></p>}
      {id ? session?.id === id ? <SessionWorkspace key={id} session={session} api={service} materials={materials} onChange={apply} onBusy={setBusy} />
        : !error && <p role="status">正在打开探讨…</p>
        : chatPath ? <DiscussionHistoryReader key={chatPath} path={chatPath} service={service} busy={busy} onContinue={() => void start({type: 'continueChat', chatPath})} />
        : <form className="discussion-paper discussion-start" onSubmit={e => {
          e.preventDefault(); void start({ type: 'start', materialPaths: selected, ...(text.trim() ? { text } : {}) });
        }}>
          <h2>今天想聊什么？</h2>
          <label htmlFor="discussion-topic">想法或问题</label><textarea id="discussion-topic" rows={3} maxLength={32000} disabled={busy} value={text} onChange={e => setText(e.target.value)} placeholder="直接写下想法，也可以从下面选资料。" />
          <h3>选择资料{selected.length > 0 && <small>已选 {selected.length} 份</small>}</h3>
          {loadingSources ? <p role="status">正在读取资料…</p> : <SourcePicker materials={materials} selected={selected} onChange={setSelected} disabled={busy} />}
          {unknownSource && !loadingSources && !materialError && <p className="discussion-notice">所选资料尚未归档或已移动。<Link to="/intake">查看收件箱</Link><button type="button" onClick={() => setSelected(selected.filter(path => materials.some(item => item.path === path)))}>移除失效选择</button></p>}
          {relevant && <button type="button" disabled={busy} onClick={() => openSession(relevant.id)}>打开这份资料上次的探讨 · {relevant.title}</button>}
          <button className="discussion-primary" disabled={busy || unknownSource || (!selected.length && !text.trim())}>{busy ? '正在准备…' : selected.length ? '准备资料' : '开始自由探讨'} <ArrowRight size={16} /></button>
        </form>}
      {error && <p role="alert" className="discussion-error">{error}{id && <button onClick={() => setRetry(n => n + 1)}>重新读取会话</button>}</p>}
    </div>
  </div>;
}
