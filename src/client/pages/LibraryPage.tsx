import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowLeft, ArrowRight, ChevronRight, FileText, Folders, History, Inbox, LibraryBig, ListFilter, RefreshCw, Search, X } from 'lucide-react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import type { KnowledgeStatus } from '../../shared/domain/records.js';
import type { TrashEntry } from '../../shared/api/trash.js';
import type { LiveDocumentDetail, MaterialPage } from '../api/client.js';
import type { LibraryQuery } from '../../shared/api/library.js';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import { PageState } from '../components/PageState.js';
import { MaterialTrashButton, MaterialTrashProvider } from '../components/MaterialTrash.js';
import { SafeMarkdown } from '../components/SafeMarkdown.js';
import { catalogSessionKey, readCatalogSession, updateCatalogSession, rememberCatalogPosition, rememberCatalogCount, useCatalogReturn } from '../components/library/catalogSession.js';
import { CollectionFolder } from '../components/library/CollectionFolder.js';
import { ArchiveControls, ArchiveVault, useArchiveVault } from '../components/library/ArchiveVault.js';
import { validLibraryPage, type LibraryData } from '../components/library/libraryResponse.js';
import { indexCanServe, isCancelled, stableFailure, validationState, type PageResource } from './pageSupport.js';
import '../styles/library.css';

type Material = MaterialPage['items'][number];
const STATUSES: readonly KnowledgeStatus[] = ['未提炼', '部分入库', '已入库'];

function OriginalDetail({ record, revision, onClose, onLoaded }: { record: Pick<Material, 'path' | 'title'> & Partial<Pick<Material, 'rawSha256' | 'upstreamVersion'>>; revision: string; onClose: () => void; onLoaded: (value: LiveDocumentDetail) => void }) {
  const { api } = useConsoleRuntime();
  const [view, setView] = useState<{ key: string; resource: PageResource<LiveDocumentDetail> }>();
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([record.path, record.rawSha256, record.upstreamVersion, revision, retry]);
  const currentKey = useRef(key); currentKey.current = key;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const onLoadedRef = useRef(onLoaded); onLoadedRef.current = onLoaded;
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);
  useEffect(() => {
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && currentKey.current === key;
    setView(previous => {
      const data = previous && 'data' in previous.resource ? previous.resource.data : undefined;
      return { key, resource: data?.path === record.path ? { status: 'refreshing', data } : { status: 'loading' } };
    });
    void api.getDocumentDetail(record.path, controller.signal).then((result) => {
      if (!isCurrent()) return;
      if (isCancelled(result)) { setView({ key, resource: { status: 'failed', state: stableFailure('operation-error', '读取材料') } }); return; }
      if (!result.ok) {
        setView({ key, resource: { status: 'failed', state: stableFailure(result.state.status, '读取材料') } });
        return;
      }
      const detail = result.value;
      if (detail.path !== record.path || record.rawSha256 !== undefined && (detail.versionMarker.rawSha256 !== record.rawSha256
        || detail.versionMarker.upstreamVersion !== record.upstreamVersion)) {
        setView({ key, resource: { status: 'failed', state: validationState('资料版本与列表不一致，请刷新资料后重试') } });
        return;
      }
      setView({ key, resource: { status: 'ready', data: detail } }); onLoadedRef.current(detail);
    }).catch(() => { if (isCurrent()) setView({ key, resource: { status: 'failed', state: stableFailure('operation-error', '读取材料') } }); });
    return () => controller.abort();
  }, [api, key]);
  const previousData = view && 'data' in view.resource ? view.resource.data : undefined;
  const resource: PageResource<LiveDocumentDetail> = view?.key === key ? view.resource
    : previousData?.path === record.path ? { status: 'refreshing', data: previousData } : { status: 'loading' };
  const data = resource.status === 'ready' || resource.status === 'refreshing' ? resource.data : undefined;
  return <aside className="knowledge-detail library-original" role="dialog" aria-modal="false" aria-label={`${record.title} 原文`}>
    <header className="knowledge-detail__header">
      <div><span>ORIGINAL FILE</span><h2 ref={headingRef} tabIndex={-1}>{data?.title ?? record.title}</h2><p className="knowledge-detail__read-state" role="status">{resource.status === 'refreshing' ? '正在核对最新版本，暂保留已读正文…' : '\u00a0'}</p></div>
      <button type="button" aria-label="关闭原文" onClick={onClose}><X aria-hidden="true" /></button>
    </header>

    {resource.status === 'loading' && <PageState state={{ status: 'loading', message: '正在读取原始文件' }} />}
    {resource.status === 'failed' && <>
      <PageState state={resource.state} />
      <button type="button" className="load-more-button" onClick={() => setRetry((value) => value + 1)}>重试读取原文</button>
    </>}
    {data && <>
      <section className="library-original__reading" aria-label="原始文件内容"><SafeMarkdown>{data.markdown.replace(/^\uFEFF?---[\t ]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[\t ]*(?:\r?\n|$)/u, '')}</SafeMarkdown></section>
      <details className="library-original__source"><summary>查看原始 Markdown 与文件信息</summary><p>{record.path}</p><pre className="library-original__text" aria-label="原始 Markdown 与 YAML">{data.markdown}</pre></details>
    </>}
    <footer className="knowledge-detail__footer"><Link to={`/queue?${new URLSearchParams({ view: 'ready', materialPath: record.path })}`}>返回这份资料的提炼工作台</Link><MaterialTrashButton record={record} text /></footer>
  </aside>;
}

export function LibraryPage() {
  const runtime = useConsoleRuntime(); const [params, setParams] = useSearchParams(); const trashView = params.get('view') === 'trash';
  const [revision, setRevision] = useState(0);
  const source = 'data' in runtime.health ? runtime.health.data?.vaultSource : undefined;
  const sessionKey = catalogSessionKey('library', source?.status === 'ready' ? source.displayName : 'current');
  const initial = useMemo(() => readCatalogSession(sessionKey), [sessionKey]);
  const rememberOpen = useCallback((open: boolean) => updateCatalogSession(sessionKey, { open }), [sessionKey]);
  const onChanged = useCallback((entry: TrashEntry) => {
    setRevision((value) => value + 1);
    if (entry.status === 'trashed') setParams((current) => { const next = new URLSearchParams(current); if (next.get('path') === entry.materialPath) next.delete('path'); return next; }, { replace: true });
    void runtime.refreshHealth?.().catch(() => undefined);
  }, [runtime.refreshHealth, setParams]);
  if (trashView) return <Navigate to="/trash" replace />;
  return <ArchiveVault initialOpen={Boolean(params.get('path') || params.get('title') || params.get('folder') || initial.open)} revealKey={params.get('path') || ''} onOpenChange={rememberOpen} onSeal={() => setParams((current) => { const next = new URLSearchParams(current); next.delete('path'); return next; }, { replace: true })}><MaterialTrashProvider onChanged={onChanged}>
    <LibraryMaterials revision={revision} sessionKey={sessionKey} />
  </MaterialTrashProvider></ArchiveVault>;
}

function LibraryMaterials({ revision, sessionKey }: { revision: number; sessionKey: string }) {
  const runtime = useConsoleRuntime();
  const vault = useArchiveVault();
  const [recent, setRecent] = useState(() => readCatalogSession(sessionKey).recent);
  const [params, setParams] = useSearchParams();
  const returnReady = useCatalogReturn(sessionKey, params, setParams);
  const linkedPath = params.get('path') ?? '';
  const linkedRecord = useMemo(() => linkedPath ? { path: linkedPath, title: linkedPath.split('/').at(-1)?.replace(/\.md$/u, '') || '原始资料' } : undefined, [linkedPath]);
  const readUnavailable = runtime.health.status === 'failed'
    || ('data' in runtime.health && runtime.health.data !== undefined && !indexCanServe(runtime.health.data));
  const mode = params.get('mode') === 'source' ? 'source' : 'topic';
  const folder = params.get('folder') ?? '';
  useEffect(() => { if (folder) vault.open(); }, [folder, vault.open]);
  const urlTitle = params.get('title') ?? '';
  const searchScope = params.get('scope') === 'all' || !folder ? 'all' : 'current';
  const status = STATUSES.find((value) => value === params.get('status'));
  const [title, setTitle] = useState(urlTitle);
  const applied = useMemo<LibraryQuery>(() => ({ mode, path: searchScope === 'all' ? '' : folder, limit: 200,
    ...(status ? { status } : {}), ...(urlTitle.trim() ? { title: urlTitle.trim() } : {})
  }), [mode, folder, status, urlTitle, searchScope]);
  useEffect(() => setTitle(urlTitle), [urlTitle]);
  const applyTitle = useCallback(() => {
    if (title.trim() === urlTitle.trim()) { if (title.trim()) vault.open(); return; }
    vault.open();
    setParams(current => { const next = new URLSearchParams(current);
      if (title.trim()) next.set('title', title.trim()); else next.delete('title');
      next.delete('path'); return next;
    }, { replace: true });
  }, [title, urlTitle, setParams, vault.open]);
  const composing = useRef(false);
  const [compositionRevision, setCompositionRevision] = useState(0);
  useEffect(() => {
    if (title.trim() === urlTitle.trim()) return;
    const timer = window.setTimeout(() => { if (!composing.current) applyTitle(); }, 250);
    return () => window.clearTimeout(timer);
  }, [title, urlTitle, applyTitle, compositionRevision]);
  const [refresh, setRefresh] = useState(0);
  const healthIndex = 'data' in runtime.health ? runtime.health.data?.index : undefined;
  const indexVersion = healthIndex && 'version' in healthIndex ? healthIndex.version : undefined;
  const scope = JSON.stringify([applied, refresh, revision, runtime.dataRevision, indexVersion, readUnavailable]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [resource, setResource] = useState<PageResource<LibraryData>>({ status: 'loading' });
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const [selected, setSelected] = useState<{ scope: string; records: ReadonlyMap<string, Material> }>();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listPositionKey = JSON.stringify(applied);
  const scrollPosition = useRef(0);
  const restoredList = useRef({ key: '', path: '' });
  const lastData = useRef<{ key: string; data: LibraryData } | undefined>(undefined);
  useEffect(() => {
    const scroller = rootRef.current?.closest('.archive-vault__contents');
    if (!scroller || linkedPath) return;
    scrollPosition.current = readCatalogSession(sessionKey).positions?.[listPositionKey] ?? scroller.scrollTop;
    const track = () => { scrollPosition.current = scroller.scrollTop; };
    scroller.addEventListener('scroll', track, { passive: true });
    return () => { scroller.removeEventListener('scroll', track); rememberCatalogPosition(sessionKey, listPositionKey, scrollPosition.current); };
  }, [listPositionKey, sessionKey, linkedPath]);

  const requestPage = useCallback((prior?: LibraryData, cursor?: string) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const retained = prior ?? (lastData.current?.key === listPositionKey ? lastData.current.data : undefined);
    const restoreCount = prior ? 0 : readCatalogSession(sessionKey).loadedCounts?.[listPositionKey] ?? 0;
    setResource(retained ? { status: 'refreshing', data: retained } : { status: 'loading' });
    void (async () => {
      let accumulated = prior; let nextCursor = cursor;
      while (!controller.signal.aborted) {
        const result = await runtime.api.listLibrary({ ...applied, ...(nextCursor === undefined ? {} : { cursor: nextCursor }) }, controller.signal);
        if (controller.signal.aborted || scopeRef.current !== scope || isCancelled(result)) return;
        if (!result.ok) {
          setResource({ status: 'failed', state: stableFailure(result.state.status, '读取材料'), ...(prior ? { data: prior } : {}) });
          return;
        }
        const page = result.value;
        const seenCursors = new Set(accumulated?.seenCursors);
        if (!validLibraryPage(page, applied, accumulated, nextCursor)) {
          setResource({ status: 'failed', state: validationState('资料列表响应不符合当前筛选或分页规则'), ...(prior ? { data: prior } : {}) });
          return;
        }
        if (page.nextCursor !== undefined) seenCursors.add(page.nextCursor);
        const next: LibraryData = { ...page, items: [...(accumulated?.items ?? []), ...page.items], seenCursors, scope };
        // Restore the visible extent using fresh pages from one validated snapshot.
        if (next.nextCursor && next.items.length < restoreCount) { accumulated = next; nextCursor = next.nextCursor; continue; }
        lastData.current = { key: listPositionKey, data: next };
        rememberCatalogCount(sessionKey, listPositionKey, next.items.length);
        setResource({ status: 'ready', data: next });
        return;
      }
    })().catch(() => {
      if (!controller.signal.aborted && scopeRef.current === scope) setResource({ status: 'failed', state: stableFailure('operation-error', '读取材料'), ...(prior ? { data: prior } : {}) });
    });
  }, [runtime.api, applied, scope, listPositionKey, sessionKey]);

  useEffect(() => {
    setSelected(undefined);
    controllerRef.current?.abort();
    if (!readUnavailable && vault.activated && returnReady) requestPage();
    return () => controllerRef.current?.abort();
  }, [readUnavailable, requestPage, vault.activated, returnReady]);

  const closeDetail = useCallback(() => {
    setParams((current) => { const next = new URLSearchParams(current); next.delete('path'); return next; }, { replace: true });
    if (triggerRef.current?.isConnected) triggerRef.current.focus({ preventScroll: true });
  }, [setParams]);
  const data = 'data' in resource && resource.data?.scope === scope ? resource.data : lastData.current?.key === listPositionKey ? lastData.current.data : undefined;
  const selection = (selected?.scope === scope ? selected.records.get(linkedPath) : undefined) ?? linkedRecord;
  useLayoutEffect(() => {
    const scroller = rootRef.current?.closest('.archive-vault__contents');
    if (linkedPath) { restoredList.current.path = linkedPath; return; }
    if (data && scroller && (restoredList.current.key !== listPositionKey || restoredList.current.path)) {
      scroller.scrollTop = readCatalogSession(sessionKey).positions?.[listPositionKey] ?? 0;
      restoredList.current = { key: listPositionKey, path: '' };
    }
  }, [data, linkedPath, listPositionKey, sessionKey]);
  const busy = resource.status === 'loading' || resource.status === 'refreshing';
  const openFolder = (path: string) => setParams((current) => {
    const next = new URLSearchParams(current); next.set('mode', mode);
    if (path) next.set('folder', path); else next.delete('folder');
    next.delete('path'); next.delete('scope'); return next;
  });
  const breadcrumbs = data?.breadcrumbs ?? [{ path: '', label: '全部资料' }, ...folder.split('/').filter(Boolean).map((part, index, parts) => ({
    path: parts.slice(0, index + 1).join('/'),
    label: mode === 'topic' ? part === '@unclassified' ? '待分类' : part.replace(/^\d+[\s._、-]*/u, '') || part : index === 0 ? part.replace(/^来自/u, '') || part : part
  }))];
  const folders = data?.folders.filter((entry) => entry.path !== '@unclassified') ?? [];
  const unclassified = data?.folders.find((entry) => entry.path === '@unclassified');

  return <div ref={rootRef} className={`knowledge-workspace library-workspace library-collections${selection ? ' knowledge-workspace--detail' : ''}`}>
    <section className="library-collections-main" aria-labelledby="library-results-title">
      <ArchiveControls>
      {recent && <div className="library-recent"><History aria-hidden="true" /><button type="button" aria-label={`继续上次调阅：${recent.title}`} onClick={() => { vault.open(); setParams(recent.query); }}>继续上次调阅 · {recent.title}</button><button type="button" className="library-recent-clear" aria-label="清除上次调阅" onClick={() => { updateCatalogSession(sessionKey, { recent: undefined }); setRecent(undefined); }}>清除</button></div>}
      <div className="library-topbar">
        <nav className="library-breadcrumbs" aria-label="当前位置"><LibraryBig aria-hidden="true" />{breadcrumbs.map((crumb, index) => <span key={crumb.path}>
          {index > 0 && <ChevronRight aria-hidden="true" />}{index === breadcrumbs.length - 1 ? <span aria-current="page">{crumb.label}</span> : <button type="button" onClick={() => openFolder(crumb.path)}>{crumb.label}</button>}
        </span>)}</nav>
        {folder && <button type="button" className="library-back" onClick={() => openFolder(folder.split('/').slice(0, -1).join('/'))}><ArrowLeft aria-hidden="true" />返回上一级</button>}
        <form className="library-search" role="search" onSubmit={event => { event.preventDefault(); if (!composing.current) applyTitle(); }}><Search aria-hidden="true" /><input type="search" aria-label="资料标题" value={title} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={event => { composing.current = false; setTitle(event.currentTarget.value); setCompositionRevision(value => value + 1); }} onChange={(event) => setTitle(event.target.value)} placeholder="直接搜索资料标题…" /><button type="submit" aria-label="搜索档案"><ArrowRight aria-hidden="true" /></button></form>
        <label className="library-search-scope">查找范围<select aria-label="档案搜索范围" value={searchScope} onChange={event => { const value = event.target.value; vault.open(); setParams(current => { const next = new URLSearchParams(current); next.set('scope', value); next.delete('path'); return next; }); }}><option value="all">全部档案</option><option value="current" disabled={!folder}>当前目录及子目录</option></select></label>
      </div>
      <h2 id="library-results-title" className="visually-hidden">{folder ? breadcrumbs.at(-1)?.label : '全部档案'}</h2>
      <div className="library-toolbar">
        <div className="library-modes" role="group" aria-label="分类方式">{([{ value: 'topic', label: '主题馆藏', icon: Folders }, { value: 'source', label: '来源目录', icon: Archive }] as const).map(({ value, label, icon: Icon }) =>
          <button type="button" key={value} aria-pressed={mode === value} onClick={() => {
            if (mode === value) return;
            setParams((current) => { const next = new URLSearchParams(current); next.set('mode', value); next.delete('folder'); next.delete('path'); return next; });
          }}><Icon aria-hidden="true" />{label}</button>)}</div>
        <div className="library-toolbar-actions"><label className="library-status-filter"><ListFilter aria-hidden="true" /><select aria-label="入库状态" value={status ?? ''} onChange={(event) => {
          const value = event.target.value;
          setParams((current) => { const next = new URLSearchParams(current); if (value) next.set('status', value); else next.delete('status'); next.delete('path'); return next; });
        }}><option value="">全部入库状态</option>{STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <button type="button" className="library-refresh" aria-label="刷新资料" title="刷新资料" onClick={() => setRefresh((value) => value + 1)} disabled={busy}><RefreshCw aria-hidden="true" /></button></div>
      </div>
      </ArchiveControls>
      {readUnavailable ? <PageState state={runtime.health.status === 'failed' ? runtime.health.state : { status: 'busy', message: '资料索引暂不可用，请稍后重试' }} /> : <>
        {resource.status === 'loading' && <PageState state={{ status: 'loading', message: '正在读取原始资料' }} />}
        {resource.status === 'refreshing' && <PageState state={{ status: 'refreshing', message: '正在更新资料列表' }} />}
        {resource.status === 'failed' && <><PageState state={resource.state} /><div className="library-recovery"><button type="button" className="load-more-button" onClick={() => setRefresh((value) => value + 1)}>重试读取资料</button>{folder && <button type="button" className="load-more-button" onClick={() => openFolder('')}>返回全部资料</button>}</div></>}
      </>}
      {data && !readUnavailable && <>
      <div className="library-sectionline"><span>{applied.title ? '搜索结果' : mode === 'topic' ? '馆藏目录' : '来源目录'}{applied.title && <small> · {searchScope === 'all' ? '全部档案' : '当前目录及子目录'}</small>}</span><span>共 {data.total} 份资料</span></div>
      {folders.length > 0 && <div className="library-shelves" aria-label="档案分类">{folders.map((entry) => <CollectionFolder key={entry.path} folder={entry} onOpen={() => openFolder(entry.path)} />)}</div>}
      {unclassified && <button type="button" className="library-unclassified" aria-label="打开 待分类" onClick={() => openFolder(unclassified.path)}><Inbox aria-hidden="true" /><span>{unclassified.label}<small> · {unclassified.count} 份资料</small></span><ArrowRight aria-hidden="true" /></button>}
      {data.items.length > 0 && <div className="library-files-heading"><h3>{applied.title ? '匹配文件' : '原始文件'}</h3><span>已加载 {data.items.length} / {data.directTotal} 份资料</span></div>}
      {data.items.length > 0 && <ul className="library-files" aria-label="原始资料列表">
        {data.items.map((record) => <li key={record.path} className="library-file-row"><button type="button" className="library-file" aria-label={`查看 ${record.title} 原文`} aria-expanded={selection?.path === record.path}
          onClick={(event) => {
            triggerRef.current = event.currentTarget;
            rememberCatalogPosition(sessionKey, listPositionKey, rootRef.current?.closest('.archive-vault__contents')?.scrollTop ?? 0);
            setSelected((current) => {
              const records = new Map(current?.scope === scope ? current.records : undefined);
              records.set(record.path, record); return { scope, records };
            });
            setParams((current) => { const next = new URLSearchParams(current); next.set('path', record.path); return next; });
          }}>
          <span className="library-file-paper"><FileText aria-hidden="true" /></span>
          <span className="library-file-primary"><strong>{record.title}</strong><small>{record.sourcePlatform} · {record.collectedAt ?? '日期未记录'}</small><small className="library-file-path">{record.path}</small></span>
          <span className="library-file-status" data-status={record.knowledgeStatus}>{record.knowledgeStatus}</span><ChevronRight className="library-file-chevron" aria-hidden="true" />
        </button><MaterialTrashButton record={record} /></li>)}
      </ul>}
      {resource.status === 'ready' && data.items.length === 0 && data.folders.length === 0 && <div className="library-empty"><PageState state={{ status: 'empty', message: '当前筛选范围内没有原始资料' }} />{folder && <button type="button" className="load-more-button" onClick={() => openFolder('')}>{applied.title && searchScope === 'current' ? '在全部档案查找' : '返回全部资料'}</button>}</div>}
      {data?.nextCursor !== undefined && <button type="button" className="load-more-button" disabled={resource.status !== 'ready'} aria-busy={resource.status === 'refreshing'}
        onClick={() => { if (resource.status === 'ready') requestPage(data, data.nextCursor); }}>{resource.status === 'refreshing' ? '加载中' : '加载更多'}</button>}
      </>}
    </section>
    {selection && <OriginalDetail key={selection.path} revision={JSON.stringify([runtime.dataRevision, indexVersion, revision, refresh])} record={selection} onClose={closeDetail} onLoaded={value => { const recent = { path: value.path, title: value.title, query: params.toString() }; setRecent(recent); updateCatalogSession(sessionKey, { recent }); }} />}
  </div>;
}
