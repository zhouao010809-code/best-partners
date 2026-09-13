import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, BookOpen, ChevronRight, FolderOpen, History, LibraryBig, ListFilter, RefreshCw, Search, X } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import type { KnowledgeCatalogFolder, KnowledgeCatalogQuery } from '../../shared/api/knowledge-catalog.js';
import type { KnowledgeRecord, UsageStatus } from '../../shared/domain/records.js';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import { KnowledgeReader } from '../components/knowledge/KnowledgeReader.js';
import { askAssistant } from '../components/assistant/assistantIntent.js';
import { catalogRecord, directoryCrumbs, directoryLabel, noteDirectory, validKnowledgeCatalog, type KnowledgeCatalogData } from '../components/knowledge/knowledgeCatalogResponse.js';
import { catalogSessionKey, readCatalogSession, updateCatalogSession, rememberCatalogPosition, rememberCatalogCount, useCatalogReturn } from '../components/library/catalogSession.js';
import { PageState } from '../components/PageState.js';
import { indexCanServe, isCancelled, stableFailure, validationState, type PageResource } from './pageSupport.js';
import '../styles/knowledge-cabinet.css';

const STATUSES: readonly UsageStatus[] = ['AI总结', '已优化', '定论', '过时'];
const TYPES = ['概念', '原理', '模型', '方法', 'SOP', '标准', '案例', '数据', '观点', '素材'];

function Bookcase({ folders, onOpen, register }: { folders: readonly KnowledgeCatalogFolder[]; onOpen: (path: string) => void; register: (path: string, node: HTMLButtonElement | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(6);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !globalThis.ResizeObserver) return;
    const update = () => setCapacity(Math.max(1, Math.min(6, Math.floor((element.clientWidth - 50) / 76))));
    update(); const observer = new ResizeObserver(update); observer.observe(element); return () => observer.disconnect();
  }, []);
  const rows = Math.ceil(folders.length / capacity);
  const rowSize = Math.ceil(folders.length / Math.max(1, rows));
  return <div className="kb-cabinet" ref={ref} aria-label="知识分类书柜">
    {Array.from({length: rows}, (_, row) => <div className="kb-shelf" key={row}>
      {folders.slice(row * rowSize, (row + 1) * rowSize).map(folder => <button type="button" className="kb-book" key={folder.path}
        ref={node => register(folder.path, node)} aria-label={`打开 ${folder.label} 收藏册`} title={`${folder.label} · ${folder.count} 篇知识`} onClick={() => onOpen(folder.path)}>
        <span className="kb-book-pages-edge" aria-hidden="true" /><span className="kb-book-spine"><span className="kb-book-name" data-latin={/^[a-z]+$/iu.test(folder.label)}>{folder.label}</span></span>
      </button>)}<span className="kb-bookend" aria-hidden="true" />
    </div>)}
  </div>;
}

export function KnowledgeCabinetPage() {
  const runtime = useConsoleRuntime();
  const [params, setParams] = useSearchParams();
  const source = 'data' in runtime.health ? runtime.health.data?.vaultSource : undefined;
  const sessionKey = catalogSessionKey('knowledge', source?.status === 'ready' ? source.displayName : 'current');
  const returnReady = useCatalogReturn(sessionKey, params, setParams);
  const linkedPath = params.get('path') ?? '';
  const folder = params.get('folder') ?? noteDirectory(linkedPath);
  const searchScope = params.get('scope') === 'all' || !folder ? 'all' : 'current';
  const layout = params.get('layout') === 'compact' ? 'compact' : params.get('layout') === 'papers' ? 'papers' : readCatalogSession(sessionKey).layout ?? 'papers';
  const search = params.get('search')?.trim() ?? '';
  const status = STATUSES.find(value => value === params.get('usageStatus'));
  const knowledgeType = params.get('knowledgeType')?.trim() ?? '';
  const topic = params.get('topic')?.trim() ?? '';
  const [draft, setDraft] = useState({search, status: status ?? '', knowledgeType, topic});
  useEffect(() => setDraft({search, status: status ?? '', knowledgeType, topic}), [search, status, knowledgeType, topic]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [recent, setRecent] = useState(() => readCatalogSession(sessionKey).recent);
  const [motion, setMotion] = useState<'none' | 'folder' | 'paper'>('none');
  const query = useMemo<KnowledgeCatalogQuery>(() => ({path: searchScope === 'all' ? '' : folder, limit: 200,
    ...(search ? {search} : {}), ...(status ? {usageStatus: status} : {}), ...(status === '过时' ? {includeObsolete: true} : {}),
    ...(knowledgeType ? {knowledgeType} : {}), ...(topic ? {topic} : {})
  }), [folder, search, status, knowledgeType, topic, searchScope]);
  const healthIndex = 'data' in runtime.health ? runtime.health.data?.index : undefined;
  const indexVersion = healthIndex && 'version' in healthIndex ? healthIndex.version : undefined;
  const unavailable = runtime.health.status === 'failed' || 'data' in runtime.health && runtime.health.data !== undefined && !indexCanServe(runtime.health.data);
  const scope = JSON.stringify([query, refresh, runtime.dataRevision, indexVersion, unavailable]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const [resource, setResource] = useState<PageResource<KnowledgeCatalogData>>({status: 'loading'});
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const recordsRef = useRef(new Map<string, KnowledgeRecord>());
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const pageFocusRef = useRef(false);
  const restoreRef = useRef<{target: string; scroll: number; trigger: Element | null} | undefined>(undefined);
  const positionsRef = useRef(new Map<string, number>());
  const readingScrollRef = useRef(0);
  const listPositionKey = JSON.stringify(query);
  const lastData = useRef<{ key: string; data: KnowledgeCatalogData } | undefined>(undefined);
  const lastPositionScope = useRef('');
  useEffect(() => {
    if (linkedPath) return;
    const track = () => rememberCatalogPosition(sessionKey, listPositionKey, window.scrollY);
    window.addEventListener('scroll', track, { passive: true });
    return () => window.removeEventListener('scroll', track);
  }, [sessionKey, listPositionKey, linkedPath]);
  const register = (path: string, node: HTMLButtonElement | null) => { if (node) triggerRefs.current.set(path, node); else triggerRefs.current.delete(path); };

  const requestPage = useCallback((prior?: KnowledgeCatalogData, cursor?: string) => {
    controllerRef.current?.abort(); const controller = new AbortController(); controllerRef.current = controller;
    const retained = prior ?? (lastData.current?.key === listPositionKey ? lastData.current.data : undefined);
    const restoreCount = prior ? 0 : readCatalogSession(sessionKey).loadedCounts?.[listPositionKey] ?? 0;
    setResource(retained ? {status: 'refreshing', data: retained} : {status: 'loading'});
    const list = runtime.api.listKnowledgeCatalog;
    if (!list) return;
    void (async () => {
      let accumulated = prior; let nextCursor = cursor;
      while (!controller.signal.aborted) {
        const result = await list({...query, ...(nextCursor ? {cursor: nextCursor} : {})}, controller.signal);
        if (controller.signal.aborted || scopeRef.current !== scope || isCancelled(result)) return;
        if (!result.ok) { setResource({status: 'failed', state: stableFailure(result.state.status, '读取知识'), ...(prior ? {data: prior} : {})}); return; }
        if (!validKnowledgeCatalog(result.value, query, accumulated, nextCursor)) {
          setResource({status: 'failed', state: validationState('知识目录响应不符合当前路径或分页规则，请刷新重试。'), ...(prior ? {data: prior} : {})}); return;
        }
        const page = result.value; const seenCursors = new Set(accumulated?.seenCursors);
        if (page.nextCursor) seenCursors.add(page.nextCursor);
        const next: KnowledgeCatalogData = {...page, items: [...(accumulated?.items ?? []), ...page.items.map(catalogRecord)], scope, seenCursors};
        if (next.nextCursor && next.items.length < restoreCount) { accumulated = next; nextCursor = next.nextCursor; continue; }
        lastData.current = { key: listPositionKey, data: next };
        rememberCatalogCount(sessionKey, listPositionKey, next.items.length);
        setResource({status: 'ready', data: next});
        return;
      }
    })().catch(() => { if (!controller.signal.aborted && scopeRef.current === scope) setResource({status: 'failed', state: stableFailure('operation-error', '读取知识'), ...(prior ? {data: prior} : {})}); });
  }, [runtime.api, query, scope, listPositionKey, sessionKey]);
  useEffect(() => {
    recordsRef.current.clear(); controllerRef.current?.abort();
    // Wait for the initial index identity so its arrival cannot replace a just-restored paper.
    if (!unavailable && indexVersion !== undefined && returnReady) requestPage();
    return () => controllerRef.current?.abort();
  }, [requestPage, unavailable, indexVersion, returnReady]);
  const data = 'data' in resource && resource.data?.scope === scope ? resource.data : lastData.current?.key === listPositionKey ? lastData.current.data : undefined;
  const busy = resource.status === 'loading' || resource.status === 'refreshing';

  useLayoutEffect(() => {
    if (linkedPath) return;
    if (data && lastPositionScope.current !== listPositionKey) {
      const top = readCatalogSession(sessionKey).positions?.[listPositionKey];
      if (top !== undefined && top !== window.scrollY) window.scrollTo({ top, behavior: 'instant' });
      lastPositionScope.current = listPositionKey;
    }
    const restore = restoreRef.current;
    if (restore && data) {
      const active = document.activeElement;
      if (active === document.body || active === restore.trigger) {
        const target = triggerRefs.current.get(restore.target) ?? headingRef.current;
        target?.focus({preventScroll: true}); if (restore.scroll || window.scrollY) window.scrollTo({top: restore.scroll, behavior: 'instant'});
      }
      restoreRef.current = undefined;
    }
    if (pageFocusRef.current && !busy) {
      if (document.activeElement === document.body || document.activeElement === moreRef.current) (data?.nextCursor ? moreRef.current : headingRef.current)?.focus({preventScroll: true});
      pageFocusRef.current = false;
    }
  }, [linkedPath, data, busy, listPositionKey, sessionKey]);

  function openFolder(path: string, clearSearch = false) {
    positionsRef.current.set(folder, window.scrollY);
    const closingChild = folder.startsWith(path ? `${path}/` : '') && folder !== path ? (path ? `${path}/` : '') + folder.slice(path ? path.length + 1 : 0).split('/')[0] : '';
    restoreRef.current = {target: closingChild, scroll: positionsRef.current.get(path) ?? 0, trigger: document.activeElement};
    setMotion('folder');
    setParams(current => { const next = new URLSearchParams(current); if (path) next.set('folder', path); else next.delete('folder'); next.delete('path'); next.delete('scope'); if (clearSearch) next.delete('search'); return next; });
  }
  function openNote(record: KnowledgeRecord) {
    recordsRef.current.set(record.path, record); readingScrollRef.current = window.scrollY; rememberCatalogPosition(sessionKey, listPositionKey, window.scrollY); setMotion('paper');
    setParams(current => { const next = new URLSearchParams(current); next.set('path', record.path); next.set('folder', folder); return next; });
  }
  const closeNote = useCallback(() => {
    restoreRef.current = {target: linkedPath, scroll: readingScrollRef.current, trigger: document.activeElement}; setMotion('none');
    setParams(current => { const next = new URLSearchParams(current); next.delete('path'); if (!next.has('folder')) next.set('folder', noteDirectory(linkedPath)); return next; }, {replace: true});
  }, [linkedPath, setParams]);
  const recentQuery = useRef(params.toString()); recentQuery.current = params.toString();
  const loaded = useCallback((record: KnowledgeRecord) => { const recent = { path: record.path, title: record.title, query: recentQuery.current }; setRecent(recent); updateCatalogSession(sessionKey, { recent }); }, [sessionKey]);
  const applyFilters = useCallback(() => {
    setMotion('none');
    setParams(current => { const next = new URLSearchParams(current); next.delete('path');
      for (const [key, value] of Object.entries({search: draft.search.trim(), usageStatus: draft.status, knowledgeType: draft.knowledgeType.trim(), topic: draft.topic.trim()})) {
        if (value) next.set(key, value); else next.delete(key);
      } return next;
    }, { replace: true });
  }, [draft, setParams]);
  const composing = useRef(false);
  const [compositionRevision, setCompositionRevision] = useState(0);
  useEffect(() => {
    if (draft.search.trim() === search) return;
    const timer = window.setTimeout(() => { if (!composing.current) applyFilters(); }, 250);
    return () => window.clearTimeout(timer);
  }, [draft.search, search, applyFilters, compositionRevision]);
  const changeSearchScope = (value: string) => { setMotion('none'); setParams(current => { const next = new URLSearchParams(current); next.set('scope', value); next.delete('path'); return next; }); };
  const displayFolder = linkedPath ? noteDirectory(linkedPath) : folder;
  const crumbs = directoryCrumbs(displayFolder);
  const domain = displayFolder.split('/')[0] ?? '';
  const opened = Boolean(folder || search || linkedPath);
  const inFolder = Boolean(displayFolder.includes('/'));
  // Retained catalog rows are for display while refreshing, not a current version assertion.
  const selected = data?.scope === scope ? data.items.find(item => item.path === linkedPath) ?? recordsRef.current.get(linkedPath) : undefined;
  const displayName = crumbs.at(-1)?.label ?? '知识书柜';

  return <section className="knowledge-cabinet-page" aria-label="知识收藏" onKeyDown={event => {
    if (event.key === 'Escape' && !linkedPath && folder) { event.preventDefault(); openFolder(folder.split('/').slice(0, -1).join('/')); }
  }}>
    <div className="kb-topbar">
      <nav className="kb-breadcrumbs" aria-label="知识目录路径"><LibraryBig aria-hidden="true" />{crumbs.map((crumb, index) => <span key={crumb.path}>
        {index > 0 && <ChevronRight aria-hidden="true" />}{index === crumbs.length - 1 && !linkedPath ? <span aria-current="page">{crumb.label}</span> : <button type="button" onClick={() => openFolder(crumb.path, true)}>{crumb.label}</button>}
      </span>)}{linkedPath && <span><ChevronRight aria-hidden="true" /><span aria-current="page">知识阅读</span></span>}</nav>
      <form className="kb-search" role="search" onSubmit={event => {event.preventDefault(); if (!composing.current) applyFilters();}}><Search aria-hidden="true" /><input type="search" aria-label="搜索知识" value={draft.search} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={event => { composing.current = false; const search = event.currentTarget.value; setDraft(value => ({ ...value, search })); setCompositionRevision(value => value + 1); }} onChange={event => setDraft({...draft, search: event.target.value})} placeholder="搜索标题、关键词、结论…" /><button type="submit" aria-label="搜索"><ChevronRight aria-hidden="true" /></button></form>
      <label className="kb-search-scope">查找范围<select aria-label="知识搜索范围" value={searchScope} onChange={event => changeSearchScope(event.target.value)}><option value="all">全部知识</option><option value="current" disabled={!folder}>当前目录及子目录</option></select></label>
      <button type="button" className="kb-icon-button" aria-label="知识筛选" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}><ListFilter aria-hidden="true" />{Boolean(status || knowledgeType || topic) && <span className="kb-filter-dot" />}</button>
      <button type="button" className="kb-icon-button" aria-label="刷新知识" disabled={busy} onClick={() => {setMotion('none'); setRefresh(value => value + 1);}}><RefreshCw aria-hidden="true" /></button>
    </div>
    {filtersOpen && <form className="kb-filters" aria-label="知识筛选条件" onSubmit={event => {event.preventDefault(); applyFilters();}}>
      <label>使用状态<select value={draft.status} onChange={event => setDraft({...draft, status: event.target.value})}><option value="">活跃知识</option>{STATUSES.map(value => <option key={value}>{value}</option>)}</select></label>
      <label>知识类型<select value={draft.knowledgeType} onChange={event => setDraft({...draft, knowledgeType: event.target.value})}><option value="">全部类型</option>{TYPES.map(value => <option key={value}>{value}</option>)}</select></label>
      <label>主题<input value={draft.topic} onChange={event => setDraft({...draft, topic: event.target.value})} placeholder="主题名称或路径" /></label><button type="submit" className="kb-button">应用筛选</button>
      <small>搜索标题、关键词与结论；默认不展示过时知识。</small>
    </form>}
    <header className="kb-section-heading"><div><span>PRIVATE KNOWLEDGE</span><h2 ref={headingRef} tabIndex={-1}>{linkedPath ? '展开阅读' : search ? '搜索结果' : opened ? displayName : '我的知识书柜'}</h2></div><p>{data ? `共 ${data.total} 篇知识` : '本机知识收藏'}{search && <small>{searchScope === 'all' ? '全部知识' : '当前目录及子目录'}</small>}</p></header>
    {!linkedPath && recent && <div className="kb-recent"><History aria-hidden="true" /><span>继续调阅</span><button type="button" aria-label={`继续上次调阅：${recent.title}`} onClick={() => {readingScrollRef.current = window.scrollY; setMotion('paper'); setParams(recent.query);}}>{recent.title}<ArrowUpRight aria-hidden="true" /></button><button type="button" aria-label="清除上次知识调阅" onClick={() => { updateCatalogSession(sessionKey, { recent: undefined }); setRecent(undefined); }}>清除</button></div>}
    {opened && !linkedPath && <div className="kb-layout-switch" role="group" aria-label="知识展示方式">{([{ value: 'papers', label: '知识纸页' }, { value: 'compact', label: '紧凑目录' }] as const).map(item => <button type="button" key={item.value} aria-pressed={layout === item.value} onClick={() => { updateCatalogSession(sessionKey, { layout: item.value }); setMotion('none'); setParams(current => { const next = new URLSearchParams(current); next.set('layout', item.value); return next; }, { replace: true }); }}>{item.label}</button>)}</div>}
    <div className={opened ? 'kb-open-volume' : 'kb-root-collection'} data-folder={inFolder} data-motion={motion}>
      {opened && <div className="kb-volume-spine" aria-hidden="true"><BookOpen /><span>{directoryLabel(domain) || '检索'}</span></div>}
      <div className="kb-contents">
        {opened && <div className="kb-navigation"><div>{!linkedPath && folder && <button type="button" className="kb-button" onClick={() => openFolder(folder.split('/').slice(0, -1).join('/'))}><ArrowLeft aria-hidden="true" />返回上一级</button>}</div><button type="button" className="kb-button" onClick={() => openFolder('', true)}><X aria-hidden="true" />归架</button></div>}
        <div className={inFolder ? 'kb-folder-case' : 'kb-directory'}>
          {inFolder && <div className="kb-folder-tab"><FolderOpen aria-hidden="true" /><span>{displayName}</span></div>}
          <div hidden={Boolean(linkedPath)}>
            {unavailable ? <PageState state={runtime.health.status === 'failed' ? runtime.health.state : {status: 'busy', message: '知识索引暂不可用，请稍后重试'}} /> : <>
              {resource.status === 'loading' && <PageState state={{status: 'loading', message: '正在打开知识目录'}} />}
              {resource.status === 'refreshing' && <p className="kb-loading" role="status">正在更新知识…</p>}
              {resource.status === 'failed' && <><PageState state={resource.state} /><button type="button" className="kb-button" onClick={() => setRefresh(value => value + 1)}>重试读取目录</button></>}
              {data && <>
                {!opened && data.folders.length > 0 && <Bookcase folders={data.folders} onOpen={openFolder} register={register} />}
                {opened && data.folders.length > 0 && <div className="kb-folders" aria-label="子文件夹">{data.folders.map(entry => <button type="button" className="kb-folder" key={entry.path} ref={node => register(entry.path, node)} aria-label={`打开 ${entry.label} 文件夹`} onClick={() => openFolder(entry.path)}><span className="kb-folder-name">{entry.label}</span><span className="kb-folder-meta">{entry.count} 篇知识<ArrowUpRight aria-hidden="true" /></span></button>)}</div>}
                {data.items.length > 0 && <><div className="kb-papers-heading"><span>{search ? '匹配知识' : '知识纸页'}</span><span>{data.items.length} / {data.directTotal} 篇</span></div>
                  <ul className={`kb-papers${layout === 'compact' ? ' kb-papers--compact' : ''}`} aria-label="知识纸页">{data.items.map(record => <li key={record.path}><button type="button" className="kb-paper" ref={node => register(record.path, node)} aria-label={`展开 ${record.title} 知识纸页`} onClick={() => openNote(record)}><span className="kb-paper-front"><span className="kb-paper-meta">{record.knowledgeType}<span>·</span><span data-status={record.usageStatus}>{record.usageStatus}</span></span><strong>{record.title}</strong><span className="kb-paper-summary">{record.recallFields.conclusion || '打开阅读完整知识'}</span><span className="kb-paper-footer"><span>{search ? directoryCrumbs(noteDirectory(record.path)).slice(1).map(crumb => crumb.label).join(' / ') : '展开阅读'}</span><ArrowUpRight aria-hidden="true" /></span></span></button></li>)}</ul></>}
                {data.items.length === 0 && data.folders.length === 0 && <div className="kb-empty"><FolderOpen aria-hidden="true" /><p>{search || status || knowledgeType || topic ? '当前筛选没有匹配的知识' : '这个目录暂时没有知识'}</p><small>{search ? '试试其他关键词，或扩大查找范围。' : '已保留目录，后续入库的知识会显示在这里。'}</small>{search && searchScope === 'current' && <button type="button" className="kb-button" onClick={() => changeSearchScope('all')}>在全库查找</button>}</div>}
                {data.nextCursor && <button ref={moreRef} type="button" className="kb-button kb-load-more" disabled={resource.status !== 'ready'} aria-busy={busy} onClick={() => {if (resource.status === 'ready') {pageFocusRef.current = document.activeElement === moreRef.current; requestPage(data, data.nextCursor);}}}>{busy ? '加载中' : '加载更多'}</button>}
              </>}
            </>}
          </div>
          {linkedPath && <KnowledgeReader key={linkedPath} path={linkedPath} revision={JSON.stringify([refresh, indexVersion])} {...(selected ? {record: selected} : {})} onClose={closeNote} onLoaded={loaded} onUse={record => askAssistant({prompt: '请用这篇知识拟一个文章提纲，标出依据，先给我预览。', contextPath: record.path})} />}
        </div>
      </div>
    </div>
    <footer className="kb-footnote"><span>本机知识 · 只读调阅</span><span>{status === '过时' ? '正在查看过时知识' : '默认不展示过时知识'}</span></footer>
  </section>;
}
