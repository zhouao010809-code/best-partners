import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Archive, CircleAlert, Search, SlidersHorizontal, Maximize2, Minimize2, X } from 'lucide-react';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import { MaterialTrashProvider } from '../components/MaterialTrash.js';
import { ReadOnlyQueuePage } from './ReadOnlyQueuePage.js';
import { QueueDetail } from './queue/QueueDetail.js';
import { QueueCabinet, type CabinetDrawerState } from './queue/QueueCabinet.js';
import type { ExtractionQueueItem, ExtractionQueuePage, ExtractionQueueQuery, ExtractionQueueView } from '../../shared/api/extraction-queue.js';
import type { ExtractionRun } from '../../shared/api/extraction.js';
import { isIsoCalendarDate } from './pageSupport.js';
import { intakePlatforms } from '../../shared/api/intake.js';
import '../styles/queue-drawer-workspace.css';

const VIEWS = [{ id: 'pending', label: '待提炼' }, { id: 'generating', label: '提炼中' }, { id: 'ready', label: '已有结果' }, { id: 'unfinished', label: '未完成' }] as const;
const DRAWERS = [{ id: 'pending', label: '待提炼' }, { id: 'generating', label: '提炼中' }, { id: 'ready', label: '待确认' }] as const;
const SOURCES = intakePlatforms;

export function QueuePage() {
  const { api, health, refreshHealth } = useConsoleRuntime();
  const [, setParams] = useSearchParams();
  const [revision, setRevision] = useState(0);
  const source = 'data' in health ? health.data?.vaultSource : undefined;
  const legacyAdapter = source?.status === 'ready' && source.adapter === 'local-rest';
  // Read-only adapters retain their existing material-list capability.
  return <MaterialTrashProvider onChanged={entry => {
    if (entry.status === 'trashed' || entry.status === 'deleted') setParams(current => { const next = new URLSearchParams(current); if (next.get('materialPath') === entry.materialPath) { next.delete('materialPath'); next.delete('run'); next.delete('pane'); } return next; }, { replace: true });
    setRevision(value => value + 1); void refreshHealth?.().catch(() => undefined);
  }}>{api.extractionQueue && !legacyAdapter ? <ExtractionQueueWorkspace key={revision} /> : <ReadOnlyQueuePage key={revision} />}</MaterialTrashProvider>;
}

function ExtractionQueueWorkspace() {
  const { api, dataRevision, health, refreshHealth } = useConsoleRuntime();
  const indexReady = 'data' in health && health.data?.index.status === 'ready';
  const service = api.extractionQueue!;
  const [params, setParams] = useSearchParams();
  const paramsRef = useRef(params); paramsRef.current = params;
  const updateQuery = useCallback((values: Record<string, string | undefined>, replace = true) => {
    const next = new URLSearchParams(paramsRef.current);
    for (const [key, value] of Object.entries(values)) { if (value) next.set(key, value); else next.delete(key); }
    paramsRef.current = next; setParams(next, { replace });
  }, [setParams]);
  const updateQueryRef = useRef(updateQuery); updateQueryRef.current = updateQuery;
  const view = VIEWS.find((v) => v.id === params.get('view'))?.id ?? 'pending';
  const visibility = params.get('visibility') === 'removed' ? 'removed' : 'active';
  const title = params.get('title') ?? '';
  const sourcePlatform = params.get('sourcePlatform') ?? '';
  const collectedFrom = params.get('collectedFrom') ?? '';
  const collectedTo = params.get('collectedTo') ?? '';
  const reviewState = view === 'ready' ? params.get('reviewState') === 'complete' ? 'complete' : 'pending' : undefined;
  const selectedPath = params.get('materialPath') ?? '';
  const selectedRun = params.get('run') ?? '';
  const pane = params.get('pane') ?? '';
  const [search, setSearch] = useState(title);
  const [advanced, setAdvanced] = useState(Boolean(collectedFrom || collectedTo));
  const [page, setPage] = useState<ExtractionQueuePage>();
  const pageRef = useRef(page); pageRef.current = page;
  const pageScope = useRef('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [moreBusy, setMoreBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selectedCache, setSelectedCache] = useState<ExtractionQueueItem>();
  const [selectionError, setSelectionError] = useState('');
  const [pageStale, setPageStale] = useState(false);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const visibilityPending = useRef(false);
  const [visibilityError, setVisibilityError] = useState('');
  const [notice, setNotice] = useState<{ message: string; undoPath?: string }>();
  const [expandedView, setExpandedView] = useState<ExtractionQueueView | undefined>(params.has('view') ? view : undefined);
  const [wideReading, setWideReading] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const expandedReview = useRef('');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [canKeepDraft, setCanKeepDraft] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<ExtractionQueueItem | 'close'>();
  const followingPaths = useRef<string[]>([]);
  const onReviewBusy = useCallback((busy: boolean, durableDraft = false) => { setReviewBusy(busy); setCanKeepDraft(durableDraft); }, []);
  const detailPane = useRef<HTMLElement>(null);
  const cabinetPane = useRef<HTMLElement>(null);
  const [previews, setPreviews] = useState<Partial<Record<ExtractionQueueView, ExtractionQueuePage>>>({});
  const [previewErrors, setPreviewErrors] = useState<Partial<Record<ExtractionQueueView, string>>>({});
  const [previewRevision, setPreviewRevision] = useState(0);
  const previewScope = useRef('');
  const chooseAvailableView = useRef(false);
  const generation = useRef(0);
  const morePending = useRef(false);
  const seenCursors = useRef(new Set<string>());
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const query = useMemo<ExtractionQueueQuery>(() => ({ view, visibility, limit: 40, ...(reviewState ? { reviewState } : {}), ...(title ? { title } : {}), ...(sourcePlatform ? { sourcePlatform } : {}), ...(collectedFrom ? { collectedFrom } : {}), ...(collectedTo ? { collectedTo } : {}) }), [view, visibility, reviewState, title, sourcePlatform, collectedFrom, collectedTo]);
  const dateError = (collectedFrom && !isIsoCalendarDate(collectedFrom) || collectedTo && !isIsoCalendarDate(collectedTo)) ? '请输入真实有效的日期' : collectedFrom && collectedTo && collectedFrom > collectedTo ? '开始日期不能晚于结束日期' : '';
  // Each other drawer reads only a first row, never document bodies or model actions.
  useEffect(() => {
    const controller = new AbortController();
    const scope = JSON.stringify([visibility, title, sourcePlatform, collectedFrom, collectedTo]);
    // Keep the last row visible during status polling and drawer navigation.
    // A different filter or visibility scope must never display stale results.
    if (previewScope.current !== scope) { previewScope.current = scope; setPreviews({}); }
    setPreviewErrors({});
    if (dateError) return () => controller.abort();
    for (const entry of DRAWERS) {
      if (entry.id === view && reviewState !== 'complete') continue;
      const request: ExtractionQueueQuery = { ...query, view: entry.id, reviewState: entry.id === 'ready' ? 'pending' : undefined, limit: 3 };
      void service.list(request, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        if (result.ok) setPreviews((old) => ({ ...old, [entry.id]: result.value }));
        else if ('state' in result) setPreviewErrors((old) => ({ ...old, [entry.id]: result.state.message ?? '这个抽屉暂时无法读取，请重试。' }));
      }).catch(() => {
        if (!controller.signal.aborted) setPreviewErrors((old) => ({ ...old, [entry.id]: '这个抽屉暂时无法读取，请重试。' }));
      });
    }
    return () => controller.abort();
  }, [service, query, view, reviewState, revision, previewRevision, dataRevision, indexReady, dateError]);
  useEffect(() => { setSearch(title); }, [title]);
  useEffect(() => {
    if (search === title) return;
    const timer = setTimeout(() => updateQuery({ title: search.trim() }), 250);
    return () => clearTimeout(timer);
  }, [search, title, updateQuery]);
  useEffect(() => {
    const controller = new AbortController(); controllerRef.current = controller;
    const current = ++generation.current; seenCursors.current.clear(); morePending.current = false;
    const scope = JSON.stringify(query);
    const keepVisible = pageScope.current === scope && Boolean(pageRef.current);
    pageScope.current = scope;
    setMoreBusy(false); setLoading(!keepVisible); setError('');
    if (!keepVisible) setPage(undefined);
    setPageStale(false);
    if (dateError) { setLoading(false); return () => controller.abort(); }
    void service.list(query, controller.signal).then((result) => {
      if (controller.signal.aborted || current !== generation.current) return;
      setLoading(false);
      if (result.ok) {
        setPage(result.value);
        if (chooseAvailableView.current) {
          chooseAvailableView.current = false;
          const available = VIEWS.find((entry) => result.value.counts[entry.id] > 0);
          if (result.value.counts[view] === 0 && available) updateQueryRef.current({ view: available.id });
        }
      }
      else if ('state' in result) setError(result.state.message ?? '提炼队列暂时无法读取，请重试。');
    });
    return () => controller.abort();
  }, [service, query, dataRevision, revision, dateError, indexReady, view]);
  useEffect(() => {
    if (!page || page.counts.generating === 0 || moreBusy) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const result = await service.list(query, controller.signal);
      if (controller.signal.aborted) return;
      if (result.ok) {
        if (seenCursors.current.size > 0) {
          // Do not discard expanded pages or move the reader during a live update.
          if (JSON.stringify(page.items.slice(0, result.value.items.length)) !== JSON.stringify(result.value.items) || JSON.stringify(page.counts) !== JSON.stringify(result.value.counts)) setPageStale(true);
          setPage({ ...page, counts: result.value.counts });
        } else setPage(result.value);
        setError('');
        setPreviewRevision((value) => value + 1);
      }
      else if ('state' in result) setError(result.state.message ?? '状态更新失败，请刷新。');
    }, 2000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [service, query, page, moreBusy]);
  const selected = page?.items.find((item) => item.materialPath === selectedPath) ?? Object.values(previews).flatMap((preview) => preview.items).find((item) => item.materialPath === selectedPath) ?? (selectedCache?.materialPath === selectedPath ? selectedCache : undefined);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  useEffect(() => { if (selected) setSelectedCache(selected); }, [selected]);
  useEffect(() => {
    if (!selectedPath || loading || page?.items.some((item) => item.materialPath === selectedPath)) { setSelectionError(''); return; }
    const controller = new AbortController(); setSelectionError('');
    void service.get(selectedPath, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok && result.value.item?.materialPath === selectedPath) setSelectedCache(result.value.item);
      else {
        setSelectedCache(undefined);
        setSelectionError(result.ok ? '这份资料暂不在可处理范围；已保存的提炼结果仍可查看。' : 'state' in result ? result.state.message ?? '资料状态暂时无法读取，请刷新列表。' : '');
      }
    });
    return () => controller.abort();
  }, [service, selectedPath, page, loading, revision, dataRevision]);

  async function loadMore() {
    if (!page?.nextCursor || morePending.current) return;
    const cursor = page.nextCursor; const current = generation.current;
    morePending.current = true; setMoreBusy(true); setError('');
    const result = await service.list({ ...query, cursor }, controllerRef.current?.signal);
    if (current !== generation.current || controllerRef.current?.signal.aborted) return;
    morePending.current = false; setMoreBusy(false);
    if (!result.ok) { if ('state' in result) setError(result.state.message ?? '未能加载更多，请刷新列表。'); return; }
    const paths = new Set(page.items.map((item) => item.materialPath));
    const invalid = result.value.items.some((item) => { if (paths.has(item.materialPath)) return true; paths.add(item.materialPath); return false; });
    if (invalid || result.value.nextCursor && (result.value.items.length === 0 || result.value.nextCursor === cursor || seenCursors.current.has(result.value.nextCursor))) { setError('列表已变化，请刷新后继续。'); return; }
    seenCursors.current.add(cursor);
    setPage({ ...result.value, items: [...page.items, ...result.value.items] });
  }
  function select(item: ExtractionQueueItem, keepDraft = false) {
    if (reviewBusy && !keepDraft) { if (canKeepDraft) setPendingNavigation(item); else setNotice({ message: '请等待当前草稿保存完成，或处理保存提示后再切换资料。' }); return; }
    setPendingNavigation(undefined);
    const position = visibleItems.findIndex((entry) => entry.materialPath === item.materialPath);
    followingPaths.current = position < 0 ? [] : visibleItems.slice(position + 1).map((entry) => entry.materialPath);
    setSelectedCache(item);
    updateQuery({ view: item.view, reviewState: item.view === 'ready' && item.reviewComplete ? 'complete' : undefined, materialPath: item.materialPath, run: (item.activeRun ?? item.latestRun)?.id, pane: item.latestRun ? 'result' : 'original' }, false);
    if (window.matchMedia?.('(max-width: 820px)').matches) requestAnimationFrame(() => detailPane.current?.scrollIntoView({ block: 'start' }));
  }
  const onRun = useCallback((run: ExtractionRun, starting: boolean) => {
    if (paramsRef.current.get('materialPath') !== run.materialPath) return;
    if (run.status === 'ready' && expandedReview.current !== `${run.materialPath}:${run.id}` && paramsRef.current.get('pane') !== 'prepare') {
      expandedReview.current = `${run.materialPath}:${run.id}`; setWideReading(true); setNavigationOpen(false);
    }
    const known = [selectedRef.current?.latestRun, selectedRef.current?.activeRun, selectedRef.current?.latestReadyRun].find((value) => value?.id === run.id);
    // Opening an existing result is a read, not a queue mutation or pagination reset.
    if (!starting && (!known || known.status === run.status)) return;
    setSelectedCache((previous) => {
      if (!previous || previous.materialPath !== run.materialPath || !starting && previous.latestRun?.id !== run.id && previous.activeRun?.id !== run.id) return previous;
      const summary = { id: run.id, status: run.status, createdAt: run.createdAt, sourceRawSha256: run.sourceRawSha256, ...(run.result ? { candidateCount: run.result.candidates.length } : {}), ...(run.problem ? { problem: run.problem } : {}) };
      return { ...previous, canExtract: false, view: run.status === 'generating' ? 'generating' : run.status === 'ready' ? 'ready' : 'unfinished', latestRun: summary, activeRun: run.status === 'generating' ? summary : undefined, latestReadyRun: run.status === 'ready' ? summary : previous.latestReadyRun };
    });
    updateQuery({ run: run.id, ...(starting ? { pane: 'result' } : {}) });
    setRevision((value) => value + 1);
  }, [updateQuery]);
  const onChanged = useCallback(() => {
    setRevision((value) => value + 1);
    void refreshHealth?.();
  }, [refreshHealth]);
  async function setVisibility(materialPath: string, removed: boolean) {
    if (!service.setVisibility || visibilityPending.current) return;
    visibilityPending.current = true; setVisibilityBusy(true); setVisibilityError(''); setNotice(undefined);
    try {
      const result = await service.setVisibility(materialPath, removed);
      if (!result.ok) { if ('state' in result) setVisibilityError(result.state.message ?? '队列调整失败，请重试。'); return; }
      if (paramsRef.current.get('materialPath') === materialPath) setSelectedCache(result.value.item ?? undefined);
      setPage(undefined);
      setNotice(removed ? { message: '已移出队列，原文和全部提炼记录已保留。', undoPath: materialPath } : { message: '已重新加入队列。' });
      onChanged();
    } catch { setVisibilityError('队列调整失败，请重试。'); }
    finally { visibilityPending.current = false; setVisibilityBusy(false); }
  }
  const activeRun = selectedRun || (selected?.activeRun ?? selected?.latestRun)?.id || '';
  const currentPane = pane || (activeRun ? 'result' : 'original');
  const filterActive = Boolean(title || sourcePlatform || collectedFrom || collectedTo);
  const extraOpen = view === 'unfinished' || reviewState === 'complete';
  const drawers: CabinetDrawerState[] = DRAWERS.map((entry) => {
    const primary = entry.id === view && !extraOpen;
    const preview = previewScope.current === JSON.stringify([visibility, title, sourcePlatform, collectedFrom, collectedTo]) ? previews[entry.id] : undefined;
    // Promoting a preview drawer must keep its buttons mounted until the main list arrives.
    // Otherwise a pointer press begun before the promotion loses its click on mouseup.
    const data = primary ? (pageScope.current === JSON.stringify(query) ? page : undefined) ?? preview : preview;
    const items = (data?.items ?? []).filter((item) => item.view === entry.id && (entry.id !== 'ready' || item.reviewComplete !== true));
    const issue = primary ? error : previewErrors[entry.id];
    return { ...entry, items, count: !data || issue ? '—' : entry.id === 'ready' ? `${items.length}${data.nextCursor ? '+' : ''}` : data.counts[entry.id],
      loading: !dateError && (primary ? loading : !data && !issue), error: issue || dateError,
      expanded: primary && expandedView === entry.id, hasMore: Boolean(data?.nextCursor),
      moreBusy: primary && moreBusy, stale: primary && pageStale };
  });
  const visibleItems = [...new Map([...drawers.flatMap((drawer) => drawer.items), ...(extraOpen ? page?.items ?? [] : [])].map((item) => [item.materialPath, item])).values()];
  const selectedIndex = visibleItems.findIndex((item) => item.materialPath === selectedPath);
  const nextItem = loading ? undefined : selectedIndex >= 0 ? visibleItems[selectedIndex + 1]
    : followingPaths.current.map((path) => visibleItems.find((item) => item.materialPath === path)).find(Boolean);
  function closeDetail(keepDraft = false) {
    if (reviewBusy && !keepDraft) { if (canKeepDraft) setPendingNavigation('close'); return; }
    setPendingNavigation(undefined);
    setWideReading(false);
    setNavigationOpen(false); expandedReview.current = '';
    const previous = selectedPath;
    updateQuery({ materialPath: undefined, run: undefined, pane: undefined });
    requestAnimationFrame(() => {
      const cards = [...(cabinetPane.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
      const available = (card: HTMLButtonElement) => !card.disabled && !card.closest('[inert], [hidden]');
      const original = cards.find((card) => card.getAttribute('aria-label') === `打开 ${selected?.title ?? previous}`);
      const handle = original?.closest('.queue-drawer')?.querySelector<HTMLButtonElement>('.queue-drawer-front');
      const target = original && available(original) ? original : handle ?? cards.find(available);
      target?.focus();
    });
  }
  function showAll(id: ExtractionQueueView, expanded: boolean) {
    setExpandedView(expanded ? id : undefined);
    if (expanded) updateQuery({ view: id, reviewState: id === 'ready' ? 'pending' : undefined }, false);
  }
  function changeScope(removed: boolean) {
    if (reviewBusy) return;
    chooseAvailableView.current = true;
    setWideReading(false);
    updateQuery({ visibility: removed ? 'removed' : undefined, reviewState: undefined, materialPath: undefined, run: undefined, pane: undefined }, false);
  }

  return <section className={`queue-workspace queue-workspace--cabinet${selectedPath ? ' queue-workspace--selected' : ''}${wideReading && selectedPath ? ' queue-workspace--reading' : ''}${wideReading && navigationOpen ? ' queue-workspace--navigation' : ''}`} aria-label="提炼工作台" data-ai-active={(page?.counts.generating ?? 0) > 0 || undefined}>
    <div className="queue-workspace-top"><span className="queue-cabinet-caption">资料处理柜</span><div className="queue-visibility" aria-label="队列范围">
      <button type="button" disabled={reviewBusy} aria-pressed={visibility === 'active'} onClick={() => changeScope(false)}>队列中</button>
      <button type="button" disabled={reviewBusy} aria-pressed={visibility === 'removed'} onClick={() => changeScope(true)}>已移出</button>
    </div></div>
    {notice && <div className="queue-visibility-notice" role="status"><span>{notice.message}</span>{notice.undoPath && <button type="button" className="queue-text-button" disabled={visibilityBusy} onClick={() => void setVisibility(notice.undoPath!, false)}>撤销移出</button>}</div>}
    {visibilityError && <p className="queue-visibility-notice" role="alert">{visibilityError}</p>}
    <div className="queue-toolbar">
      <label className="queue-search"><Search aria-hidden="true" /><input type="search" aria-label="搜索资料标题" placeholder="在处理柜中查找…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <select aria-label="来源平台" value={sourcePlatform} onChange={(event) => updateQuery({ sourcePlatform: event.target.value })}><option value="">全部来源</option>{[...new Set([...SOURCES, sourcePlatform])].filter(Boolean).map((source) => <option key={source}>{source}</option>)}</select>
      <button type="button" className="quiet-button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}><SlidersHorizontal aria-hidden="true" />日期{(collectedFrom || collectedTo) && <span className="queue-filter-dot" />}</button>
      {filterActive && <button type="button" className="queue-text-button" onClick={() => { setSearch(''); updateQuery({ title: undefined, sourcePlatform: undefined, collectedFrom: undefined, collectedTo: undefined }); }}>清除筛选</button>}
    </div>
    {advanced && <div className="queue-date-filters"><label>采集自<input type="date" aria-label="采集开始日期" value={collectedFrom} onChange={(e) => updateQuery({ collectedFrom: e.target.value })} /></label><span>至</span><label>采集至<input type="date" aria-label="采集结束日期" value={collectedTo} onChange={(e) => updateQuery({ collectedTo: e.target.value })} /></label></div>}
    <div className="queue-columns">
      <section className="queue-list-pane" aria-label="资料列表" ref={cabinetPane} hidden={Boolean(selectedPath && wideReading && !navigationOpen)}>
        <QueueCabinet drawers={drawers} selectedPath={selectedPath} onSelect={select} onToggleAll={showAll} onLoadMore={() => void loadMore()} onRetry={() => setRevision((v) => v + 1)} />
        <div className="queue-secondary-views">
          <button type="button" aria-pressed={view === 'unfinished'} onClick={() => updateQuery({ view: view === 'unfinished' ? 'pending' : 'unfinished', reviewState: undefined }, false)}><CircleAlert aria-hidden="true" />未完成任务 <span>{page?.counts.unfinished ?? '—'}</span></button>
          <button type="button" aria-pressed={reviewState === 'complete'} onClick={() => updateQuery({ view: 'ready', reviewState: reviewState === 'complete' ? 'pending' : 'complete' }, false)}><Archive aria-hidden="true" />已处理结果</button>
        </div>
        {extraOpen && <section className="queue-extra-results" aria-label={view === 'unfinished' ? '未完成任务列表' : '已处理结果列表'}>
          <div className="queue-list-caption"><span>{view === 'unfinished' ? '需要继续处理的资料' : '已经完成取舍的资料'}</span>{reviewState === 'complete' && <span>入库和放弃均保留记录</span>}</div>
          {loading && <p role="status" className="queue-feedback">正在读取资料…</p>}
          {(error || dateError) && <div role="alert" className="queue-feedback">{error || dateError}<button type="button" className="queue-text-button" onClick={() => setRevision((v) => v + 1)}>刷新列表</button></div>}
          {pageStale && <p role="status" className="queue-feedback">列表已更新，请刷新后继续。<button type="button" onClick={() => setRevision((v) => v + 1)}>刷新列表</button></p>}
          {!loading && !error && !dateError && page?.items.length === 0 && <p className="queue-feedback">{filterActive ? '没有符合筛选的资料。' : view === 'unfinished' ? '没有未完成的提炼。' : '暂时没有已处理的结果。'}</p>}
          <ul className="queue-extra-items">{page?.items.map((item) => <li key={item.materialPath}><button type="button" className="queue-item" aria-label={`打开 ${item.title}`} aria-pressed={item.materialPath === selectedPath} onClick={() => select(item)}><strong>{item.title}</strong><span>{item.sourcePlatform || '来源未记录'} · {item.collectedAt || '日期未记录'}</span><small>{item.view === 'unfinished' ? item.latestRun?.status === 'cancelled' ? '已停止 · 可查看历史' : item.latestRun?.problem || '上次提炼未完成' : '已完成取舍 · 查看结果'}</small></button></li>)}</ul>
          {page?.nextCursor && <button type="button" className="quiet-button queue-more" disabled={moreBusy} onClick={() => void loadMore()}>{moreBusy ? '正在加载…' : '加载更多资料'}</button>}
        </section>}
        <p className="queue-cabinet-footer">提炼生成候选 · 入库由你确认 <Link to="/library">浏览原始资料 <ArrowRight aria-hidden="true" /></Link></p>
      </section>
      {selectedPath && <section className="queue-detail-pane" aria-label="资料工作区" ref={detailPane}>
          <div className="queue-reader-controls"><button type="button" className="queue-text-button" aria-label={wideReading ? '收起阅读' : '展开阅读'} onClick={() => { setWideReading(!wideReading); setNavigationOpen(false); }}>{wideReading ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}<span>{wideReading ? '收起阅读' : '展开阅读'}</span></button>{wideReading && <button type="button" className="queue-text-button" aria-expanded={navigationOpen} onClick={() => setNavigationOpen(!navigationOpen)}>资料导航</button>}<button type="button" className="queue-text-button" disabled={!nextItem || reviewBusy && !canKeepDraft} onClick={() => nextItem && select(nextItem)}>下一份 <ArrowRight aria-hidden="true" /></button><button type="button" className="queue-text-button" aria-label="关闭资料详情" disabled={reviewBusy && !canKeepDraft} onClick={() => closeDetail()}><X aria-hidden="true" /></button></div>
          <button type="button" className="queue-back queue-text-button" disabled={reviewBusy && !canKeepDraft} onClick={() => closeDetail()}><ArrowLeft aria-hidden="true" />返回资料列表</button>
          {pendingNavigation && <div className="queue-navigation-confirm" role="group" aria-label="保留草稿后切换"><p>修改已暂存在本机，尚未同步到草稿记录。保留修改并切换？</p><button type="button" className="quiet-button" disabled={reviewBusy && !canKeepDraft} onClick={() => pendingNavigation === 'close' ? closeDetail(true) : select(pendingNavigation, true)}>保留草稿并切换</button><button type="button" className="queue-text-button" onClick={() => setPendingNavigation(undefined)}>留在当前资料</button></div>}
          {reviewBusy && !pendingNavigation && <p className="queue-reader-saving" role="status">{canKeepDraft ? '尚有未同步的修改，本机临时草稿已保留。' : '正在保存或处理候选，完成后可切换资料。'}</p>}
          {selectionError && <p className="extraction-notice" role="alert">{selectionError}</p>}
          <QueueDetail key={selectedPath} materialPath={selectedPath} item={selected} runId={activeRun} pane={currentPane} onPane={(next) => updateQuery({ pane: next })} onSelectRun={(id) => updateQuery({ run: id, pane: 'result' })} onRun={onRun} onChanged={onChanged} onReviewBusy={onReviewBusy} {...(nextItem ? { onNextMaterial: () => select(nextItem) } : {})} visibilityBusy={visibilityBusy} {...(service.setVisibility ? { onVisibility: (removed: boolean) => void setVisibility(selectedPath, removed) } : {})} />
      </section>}
    </div>
  </section>;
}
