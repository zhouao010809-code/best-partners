import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, FileText, Layers3 } from 'lucide-react';
import type { MaterialPage, MaterialQuery } from '../api/client.js';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import {
  MaterialFilters,
  type MaterialFilterDraft
} from '../components/MaterialFilters.js';
import { PageState } from '../components/PageState.js';
import {
  indexCanServe,
  isCancelled,
  isIsoCalendarDate,
  stableFailure,
  trimOrUndefined,
  validationState,
  type PageResource
} from './pageSupport.js';

const EMPTY_FILTERS: MaterialFilterDraft = {
  status: '', sourcePlatform: '', collectedFrom: '', collectedTo: '', title: ''
};
const PAGE_LIMIT = 200;

type QueueData = {
  readonly items: readonly MaterialItem[];
  readonly nextCursor?: string;
  readonly seenCursors: ReadonlySet<string>;
};

type MaterialItem = MaterialPage['items'][number];

function queryFromDraft(draft: MaterialFilterDraft): MaterialQuery | { readonly error: string } {
  const from = trimOrUndefined(draft.collectedFrom);
  const to = trimOrUndefined(draft.collectedTo);
  if ((from !== undefined && !isIsoCalendarDate(from)) || (to !== undefined && !isIsoCalendarDate(to))) {
    return { error: '请输入真实有效的日历日期' };
  }
  if (from !== undefined && to !== undefined && from > to) {
    return { error: '开始日期不能晚于结束日期' };
  }
  const sourcePlatform = trimOrUndefined(draft.sourcePlatform);
  const title = trimOrUndefined(draft.title);
  return {
    ...(draft.status === '' ? {} : { status: draft.status }),
    ...(sourcePlatform === undefined ? {} : { sourcePlatform }),
    ...(from === undefined ? {} : { collectedFrom: from }),
    ...(to === undefined ? {} : { collectedTo: to }),
    ...(title === undefined ? {} : { title }),
    limit: PAGE_LIMIT
  };
}

function validatePage(
  current: readonly MaterialItem[],
  incoming: readonly MaterialItem[],
  requestedCursor: string | undefined,
  nextCursor: string | undefined,
  seenCursors: ReadonlySet<string>
): string | undefined {
  if (incoming.some((item) => item.knowledgeStatus === '已入库')) return '队列响应包含已入库记录';
  const paths = new Set(current.map((item) => item.path));
  for (const item of incoming) {
    if (paths.has(item.path)) return '队列响应包含重复材料路径';
    paths.add(item.path);
  }
  if (nextCursor !== undefined) {
    if (incoming.length === 0) return '队列响应为空但仍提供下一页游标';
    if (nextCursor === requestedCursor || seenCursors.has(nextCursor)) return '队列分页游标重复';
  }
  return undefined;
}

export function QueuePage() {
  const runtime = useConsoleRuntime();
  const readUnavailable = runtime.health.status === 'failed'
    || ('data' in runtime.health && runtime.health.data !== undefined && !indexCanServe(runtime.health.data));
  const [draft, setDraft] = useState<MaterialFilterDraft>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<MaterialQuery>({ limit: PAGE_LIMIT });
  const [applyRevision, setApplyRevision] = useState(0);
  const [localError, setLocalError] = useState<string>();
  const [resource, setResource] = useState<PageResource<QueueData>>({ status: 'loading' });
  const resourceRef = useRef(resource);
  const generationRef = useRef(0);
  const paginationFocusIntentRef = useRef<{
    readonly generation: number;
    readonly trigger: HTMLButtonElement;
  } | undefined>(undefined);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const loadMoreRef = useRef<HTMLButtonElement>(null);
  resourceRef.current = resource;

  const requestPage = useCallback(async (
    baseQuery: MaterialQuery,
    cursor: string | undefined,
    append: boolean,
    generation: number,
    controller: AbortController
  ): Promise<void> => {
    const query = cursor === undefined ? baseQuery : { ...baseQuery, cursor };
    const result = await runtime.api.listMaterials(query, controller.signal);
    if (controller.signal.aborted || generationRef.current !== generation || isCancelled(result)) return;
    const prior = resourceRef.current.status === 'ready'
      || resourceRef.current.status === 'refreshing'
      || resourceRef.current.status === 'failed'
      ? resourceRef.current.data
      : undefined;
    if (!result.ok) {
      setResource(prior === undefined
        ? { status: 'failed', state: stableFailure(result.state.status, '读取材料') }
        : { status: 'failed', state: stableFailure(result.state.status, '读取材料'), data: prior });
      return;
    }
    const currentItems = append ? prior?.items ?? [] : [];
    const seenCursors = append ? prior?.seenCursors ?? new Set<string>() : new Set<string>();
    const error = validatePage(
      currentItems,
      result.value.items,
      cursor,
      result.value.nextCursor,
      seenCursors
    );
    if (error !== undefined) {
      setResource(prior === undefined
        ? { status: 'failed', state: validationState(error) }
        : { status: 'failed', state: validationState(error), data: prior });
      return;
    }
    const nextSeen = new Set(seenCursors);
    if (result.value.nextCursor !== undefined) nextSeen.add(result.value.nextCursor);
    setResource({
      status: 'ready',
      data: {
        items: [...currentItems, ...result.value.items],
        ...(result.value.nextCursor === undefined ? {} : { nextCursor: result.value.nextCursor }),
        seenCursors: nextSeen
      }
    });
  }, [runtime.api]);

  useEffect(() => {
    if (readUnavailable) return;
    paginationFocusIntentRef.current = undefined;
    generationRef.current += 1;
    const generation = generationRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const prior = resourceRef.current.status === 'ready'
      || resourceRef.current.status === 'refreshing'
      || resourceRef.current.status === 'failed'
      ? resourceRef.current.data
      : undefined;
    setResource(prior === undefined ? { status: 'loading' } : { status: 'refreshing', data: prior });
    void requestPage(applied, undefined, false, generation, controller);
    return () => controller.abort();
  }, [applied, applyRevision, readUnavailable, requestPage, runtime.dataRevision]);

  useEffect(() => {
    const intent = paginationFocusIntentRef.current;
    if (intent === undefined
      || intent.generation !== generationRef.current
      || resource.status === 'loading'
      || resource.status === 'refreshing') return;
    paginationFocusIntentRef.current = undefined;
    if (document.activeElement !== document.body && document.activeElement !== intent.trigger) return;
    const target = resource.status === 'ready' && resource.data.nextCursor !== undefined
      ? loadMoreRef.current
      : resultsHeadingRef.current;
    (target ?? resultsHeadingRef.current)?.focus({ preventScroll: true });
  }, [resource]);

  function applyFilters(): void {
    const query = queryFromDraft(draft);
    if ('error' in query) {
      setLocalError(query.error);
      return;
    }
    setLocalError(undefined);
    setApplied(query);
    setApplyRevision((revision) => revision + 1);
  }

  function loadMore(): void {
    if (resource.status !== 'ready' || resource.data.nextCursor === undefined) return;
    const trigger = loadMoreRef.current;
    const ownedFocus = trigger !== null && document.activeElement === trigger;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    generationRef.current += 1;
    const generation = generationRef.current;
    paginationFocusIntentRef.current = ownedFocus ? { generation, trigger } : undefined;
    setResource({ status: 'refreshing', data: resource.data });
    void requestPage(applied, resource.data.nextCursor, true, generation, controller);
  }

  const data = resource.status === 'ready' || resource.status === 'refreshing' || resource.status === 'failed'
    ? resource.data
    : undefined;
  const paginationBusy = resource.status === 'refreshing' && data?.nextCursor !== undefined;

  return (
    <section className="instrument-panel workspace-panel live-list-page" aria-labelledby="queue-results-title">
      <MaterialFilters draft={draft} onChange={setDraft} onSubmit={applyFilters} />
      {localError !== undefined && <PageState state={{ status: 'validation-error', message: localError }} />}
      {runtime.health.status === 'failed' ? <PageState state={runtime.health.state} /> : <>
        {resource.status === 'loading' && <PageState state={{ status: 'loading', message: '正在读取待处理材料' }} />}
        {resource.status === 'refreshing' && <PageState state={{ status: 'refreshing', message: '正在更新材料结果，旧结果仍可查看' }} />}
        {resource.status === 'failed' && <PageState state={resource.state} />}
      </>}

      <header className="results-heading">
        <div><p>READ-ONLY QUEUE</p><h2 id="queue-results-title" ref={resultsHeadingRef} tabIndex={-1}>材料结果</h2></div>
        <span>已加载 {data?.items.length ?? 0} 条</span>
      </header>

      {data !== undefined && data.items.length > 0 ? (
        <ul className="record-list" aria-label="材料结果">
          {data.items.map((item) => (
            <li key={item.path}>
              <span className="record-list__icon"><FileText aria-hidden="true" /></span>
              <span className="record-list__primary"><strong>{item.title}</strong><small>{item.path}</small></span>
              <span className="record-list__meta"><span><Layers3 aria-hidden="true" />{item.sourcePlatform}</span><span><CalendarDays aria-hidden="true" />{item.collectedAt ?? '日期未记录'}</span></span>
              <span className={`record-status record-status--${item.knowledgeStatus === '未提炼' ? 'pending' : 'partial'}`}>{item.knowledgeStatus}</span>
            </li>
          ))}
        </ul>
      ) : resource.status === 'ready' ? (
        <PageState state={{ status: 'empty', message: '当前筛选范围内没有待处理材料' }} />
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
  );
}
