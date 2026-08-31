import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpenText, Filter, Search, Tags } from 'lucide-react';
import type {
  ApiClientResult,
  KnowledgePage as KnowledgePageResponse,
  KnowledgeQuery,
  LiveKnowledgeDetail
} from '../api/client.js';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import { KnowledgeDetail } from '../components/KnowledgeDetail.js';
import { PageState } from '../components/PageState.js';
import type { UsageStatus } from '../../shared/domain/records.js';
import {
  isCancelled,
  stableFailure,
  trimOrUndefined,
  validationState,
  type PageResource
} from './pageSupport.js';

const PAGE_LIMIT = 200;

type KnowledgeFilterDraft = {
  readonly search: string;
  readonly usageStatus: '' | UsageStatus;
  readonly knowledgeType: string;
  readonly topic: string;
};

type KnowledgeData = {
  readonly items: readonly KnowledgeItem[];
  readonly nextCursor?: string;
  readonly seenCursors: ReadonlySet<string>;
};

type KnowledgeItem = KnowledgePageResponse['items'][number];

type InFlightDetail = {
  readonly controller: AbortController;
  readonly promise: Promise<ApiClientResult<LiveKnowledgeDetail>>;
};

const EMPTY_FILTERS: KnowledgeFilterDraft = {
  search: '', usageStatus: '', knowledgeType: '', topic: ''
};

function queryFromDraft(draft: KnowledgeFilterDraft): KnowledgeQuery {
  const search = trimOrUndefined(draft.search);
  const knowledgeType = trimOrUndefined(draft.knowledgeType);
  const topic = trimOrUndefined(draft.topic);
  return {
    ...(search === undefined ? {} : { search }),
    ...(draft.usageStatus === '' ? {} : { usageStatus: draft.usageStatus }),
    ...(draft.usageStatus === '过时' ? { includeObsolete: true } : {}),
    ...(knowledgeType === undefined ? {} : { knowledgeType }),
    ...(topic === undefined ? {} : { topic }),
    limit: PAGE_LIMIT
  };
}

function detailKey(record: KnowledgeItem): string {
  return JSON.stringify([record.path, record.rawSha256, record.upstreamVersion ?? null]);
}

function detailMatches(record: KnowledgeItem, detail: LiveKnowledgeDetail): boolean {
  return detail.path === record.path
    && detail.title === record.title
    && detail.versionMarker.rawSha256 === record.rawSha256
    && detail.versionMarker.upstreamVersion === record.upstreamVersion;
}

function validatePage(
  current: readonly KnowledgeItem[],
  incoming: readonly KnowledgeItem[],
  requestedCursor: string | undefined,
  nextCursor: string | undefined,
  seenCursors: ReadonlySet<string>
): string | undefined {
  const paths = new Set(current.map((item) => item.path));
  for (const item of incoming) {
    if (paths.has(item.path)) return '知识响应包含重复路径';
    paths.add(item.path);
  }
  if (nextCursor !== undefined) {
    if (incoming.length === 0) return '知识响应为空但仍提供下一页游标';
    if (nextCursor === requestedCursor || seenCursors.has(nextCursor)) return '知识分页游标重复';
  }
  return undefined;
}

export function KnowledgePage() {
  const runtime = useConsoleRuntime();
  const [draft, setDraft] = useState<KnowledgeFilterDraft>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<KnowledgeQuery>({ limit: PAGE_LIMIT });
  const [applyRevision, setApplyRevision] = useState(0);
  const [resource, setResource] = useState<PageResource<KnowledgeData>>({ status: 'loading' });
  const [selected, setSelected] = useState<KnowledgeItem>();
  const [detailView, setDetailView] = useState<{
    readonly key: string;
    readonly resource: PageResource<LiveKnowledgeDetail>;
  }>();
  const [openState, setOpenState] = useState<'idle' | 'opening' | 'opened' | 'failed'>('idle');
  const resourceRef = useRef(resource);
  const selectedRef = useRef(selected);
  const generationRef = useRef(0);
  const listControllerRef = useRef<AbortController | undefined>(undefined);
  const detailCacheRef = useRef(new Map<string, LiveKnowledgeDetail>());
  const detailInFlightRef = useRef(new Map<string, InFlightDetail>());
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const loadMoreRef = useRef<HTMLButtonElement>(null);
  resourceRef.current = resource;
  selectedRef.current = selected;

  const closeDetail = useCallback(() => {
    const closing = selectedRef.current;
    setSelected(undefined);
    setOpenState('idle');
    queueMicrotask(() => {
      const trigger = closing === undefined ? undefined : triggerRefs.current.get(closing.path);
      (trigger ?? resultsHeadingRef.current)?.focus({ preventScroll: true });
    });
  }, []);

  const requestPage = useCallback(async (
    baseQuery: KnowledgeQuery,
    cursor: string | undefined,
    append: boolean,
    generation: number,
    controller: AbortController
  ): Promise<void> => {
    const query = cursor === undefined ? baseQuery : { ...baseQuery, cursor };
    const result = await runtime.api.listKnowledge(query, controller.signal);
    if (controller.signal.aborted || generationRef.current !== generation || isCancelled(result)) return;
    const prior = resourceRef.current.status === 'ready'
      || resourceRef.current.status === 'refreshing'
      || resourceRef.current.status === 'failed'
      ? resourceRef.current.data
      : undefined;
    if (!result.ok) {
      setResource(prior === undefined
        ? { status: 'failed', state: stableFailure(result.state.status, '读取知识') }
        : { status: 'failed', state: stableFailure(result.state.status, '读取知识'), data: prior });
      return;
    }
    const currentItems = append ? prior?.items ?? [] : [];
    const seenCursors = append ? prior?.seenCursors ?? new Set<string>() : new Set<string>();
    const error = validatePage(currentItems, result.value.items, cursor, result.value.nextCursor, seenCursors);
    if (error !== undefined) {
      setResource(prior === undefined
        ? { status: 'failed', state: validationState(error) }
        : { status: 'failed', state: validationState(error), data: prior });
      return;
    }
    const nextSeen = new Set(seenCursors);
    if (result.value.nextCursor !== undefined) nextSeen.add(result.value.nextCursor);
    const items = [...currentItems, ...result.value.items];
    const hadFocusedLoadMore = document.activeElement === loadMoreRef.current;
    setResource({
      status: 'ready',
      data: {
        items,
        ...(result.value.nextCursor === undefined ? {} : { nextCursor: result.value.nextCursor }),
        seenCursors: nextSeen
      }
    });
    const currentSelected = selectedRef.current;
    if (currentSelected !== undefined) {
      const replacement = items.find((item) => item.path === currentSelected.path);
      if (replacement === undefined) {
        closeDetail();
      } else if (detailKey(replacement) !== detailKey(currentSelected)) {
        setSelected(replacement);
      }
    }
    if (hadFocusedLoadMore && result.value.nextCursor === undefined) {
      queueMicrotask(() => resultsHeadingRef.current?.focus({ preventScroll: true }));
    }
  }, [closeDetail, runtime.api]);

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    listControllerRef.current?.abort();
    const controller = new AbortController();
    listControllerRef.current = controller;
    const prior = resourceRef.current.status === 'ready'
      || resourceRef.current.status === 'refreshing'
      || resourceRef.current.status === 'failed'
      ? resourceRef.current.data
      : undefined;
    setResource(prior === undefined ? { status: 'loading' } : { status: 'refreshing', data: prior });
    void requestPage(applied, undefined, false, generation, controller);
    return () => controller.abort();
  }, [applied, applyRevision, requestPage, runtime.dataRevision]);

  useEffect(() => {
    for (const pending of detailInFlightRef.current.values()) pending.controller.abort();
    detailInFlightRef.current.clear();
    detailCacheRef.current.clear();
    setDetailView(undefined);
    setSelected(undefined);
    setOpenState('idle');
  }, [runtime.dataRevision]);

  useEffect(() => () => {
    for (const pending of detailInFlightRef.current.values()) pending.controller.abort();
    detailInFlightRef.current.clear();
    detailCacheRef.current.clear();
  }, []);

  useEffect(() => {
    if (selected === undefined) return;
    const key = detailKey(selected);
    const cached = detailCacheRef.current.get(key);
    if (cached !== undefined) {
      setDetailView({ key, resource: { status: 'ready', data: cached } });
      return;
    }
    setDetailView({ key, resource: { status: 'loading' } });
    let pending = detailInFlightRef.current.get(key);
    if (pending === undefined) {
      const controller = new AbortController();
      const promise = runtime.api.getKnowledgeDetail(selected.path, controller.signal);
      pending = { controller, promise };
      detailInFlightRef.current.set(key, pending);
      void promise.finally(() => {
        if (detailInFlightRef.current.get(key)?.promise === promise) {
          detailInFlightRef.current.delete(key);
        }
      });
    }
    const activePromise = pending.promise;
    void activePromise.then((result) => {
      if (isCancelled(result)) return;
      if (!result.ok) {
        if (selectedRef.current !== undefined && detailKey(selectedRef.current) === key) {
          setDetailView({ key, resource: { status: 'failed', state: stableFailure(result.state.status, '读取知识') } });
        }
        return;
      }
      if (!detailMatches(selected, result.value)) {
        if (selectedRef.current !== undefined && detailKey(selectedRef.current) === key) {
          setDetailView({ key, resource: { status: 'failed', state: stableFailure('conflict', '读取知识') } });
        }
        return;
      }
      detailCacheRef.current.set(key, result.value);
      if (selectedRef.current !== undefined && detailKey(selectedRef.current) === key) {
        setDetailView({ key, resource: { status: 'ready', data: result.value } });
      }
    });
  }, [runtime.api, selected]);

  function applyFilters(): void {
    setApplied(queryFromDraft(draft));
    setApplyRevision((revision) => revision + 1);
  }

  function loadMore(): void {
    if (resource.status !== 'ready' || resource.data.nextCursor === undefined) return;
    listControllerRef.current?.abort();
    const controller = new AbortController();
    listControllerRef.current = controller;
    generationRef.current += 1;
    const generation = generationRef.current;
    setResource({ status: 'refreshing', data: resource.data });
    void requestPage(applied, resource.data.nextCursor, true, generation, controller);
  }

  async function openSelected(): Promise<void> {
    const record = selectedRef.current;
    if (record === undefined) return;
    setOpenState('opening');
    const result = await runtime.api.openKnowledge(record.path);
    if (selectedRef.current?.path !== record.path || isCancelled(result)) return;
    if (!result.ok || result.value.path !== record.path || !result.value.opened) {
      setOpenState('failed');
      return;
    }
    setOpenState('opened');
  }

  const data = resource.status === 'ready' || resource.status === 'refreshing' || resource.status === 'failed'
    ? resource.data
    : undefined;
  const paginationBusy = resource.status === 'refreshing' && data?.nextCursor !== undefined;
  const selectedDetailKey = selected === undefined ? undefined : detailKey(selected);
  const visibleDetailResource: PageResource<LiveKnowledgeDetail> = selectedDetailKey !== undefined
    && detailView?.key === selectedDetailKey
    ? detailView.resource
    : { status: 'loading' };

  return (
    <div className={`knowledge-workspace${selected === undefined ? '' : ' knowledge-workspace--detail'}`}>
      <section className="instrument-panel workspace-panel live-list-page" aria-labelledby="knowledge-results-title">
        <form className="filter-panel knowledge-filters" aria-label="知识筛选" onSubmit={(event) => { event.preventDefault(); applyFilters(); }}>
          <label className="filter-field filter-field--search"><span>标题与 YAML 召回字段</span><span className="filter-input"><Search aria-hidden="true" /><input value={draft.search} onChange={(event) => setDraft({ ...draft, search: event.target.value })} placeholder="标题、主题、关键词、场景与结论" /></span></label>
          <label className="filter-field"><span>使用状态</span><select value={draft.usageStatus} onChange={(event) => setDraft({ ...draft, usageStatus: event.target.value as KnowledgeFilterDraft['usageStatus'] })}><option value="">活跃知识</option><option value="AI总结">AI总结</option><option value="已优化">已优化</option><option value="定论">定论</option><option value="过时">过时</option></select></label>
          <label className="filter-field"><span>知识类型</span><input value={draft.knowledgeType} onChange={(event) => setDraft({ ...draft, knowledgeType: event.target.value })} /></label>
          <label className="filter-field"><span>领域</span><input value={draft.topic} onChange={(event) => setDraft({ ...draft, topic: event.target.value })} /></label>
          <button className="primary-filter-button" type="submit"><Filter aria-hidden="true" />应用筛选</button>
        </form>
        <p className="search-disclosure">仅搜索标题与 YAML 召回字段</p>
        {resource.status === 'loading' && <PageState state={{ status: 'loading', message: '正在读取知识索引' }} />}
        {resource.status === 'refreshing' && <PageState state={{ status: 'refreshing', message: '正在更新知识结果，旧结果仍可查看' }} />}
        {resource.status === 'failed' && <PageState state={resource.state} />}
        <header className="results-heading">
          <div><p>INDEXED KNOWLEDGE</p><h2 id="knowledge-results-title" ref={resultsHeadingRef} tabIndex={-1}>知识结果</h2></div>
          <span>已加载 {data?.items.length ?? 0} 条</span>
        </header>
        {data !== undefined && data.items.length > 0 ? (
          <ul className="record-list knowledge-record-list" aria-label="知识结果">
            {data.items.map((item) => (
              <li key={item.path}>
                <button
                  ref={(node) => { if (node) triggerRefs.current.set(item.path, node); else triggerRefs.current.delete(item.path); }}
                  type="button"
                  aria-label={`查看 ${item.title} 详情`}
                  aria-expanded={selected?.path === item.path}
                  onClick={() => { setSelected(item); setOpenState('idle'); }}
                >
                  <span className="record-list__icon"><BookOpenText aria-hidden="true" /></span>
                  <span className="record-list__primary"><strong>{item.title}</strong><small>{item.path}</small></span>
                  <span className="record-list__meta"><span><Tags aria-hidden="true" />{item.knowledgeType}</span><span>{item.usageStatus}</span></span>
                </button>
              </li>
            ))}
          </ul>
        ) : resource.status === 'ready' ? (
          <PageState state={{ status: 'empty', message: '当前筛选范围内没有知识记录' }} />
        ) : null}
        {data?.nextCursor !== undefined && (
          <button
            ref={loadMoreRef}
            className="load-more-button"
            type="button"
            onClick={loadMore}
            disabled={resource.status !== 'ready'}
            aria-busy={paginationBusy}
          >
            {paginationBusy ? '加载中' : '加载更多'}
          </button>
        )}
      </section>
      {selected !== undefined && (
        <KnowledgeDetail key={selected.path} record={selected} resource={visibleDetailResource} openState={openState} onClose={closeDetail} onOpen={() => { void openSelected(); }} />
      )}
    </div>
  );
}
