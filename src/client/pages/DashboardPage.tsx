import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { extractionHref } from './ExtractionPage.js';
import { ArrowUpRight } from 'lucide-react';
import type {
  ApiClientResult,
  HealthSnapshot,
  KnowledgePage,
  MaterialPage,
  OperationPage,
  ReadConsoleApi
} from '../api/client.js';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import { PageState } from '../components/PageState.js';
import { MaterialDeck } from '../components/material-deck/MaterialDeck.js';
import type { MaterialDeckCard } from '../components/material-deck/materialDeckLayout.js';
import type { ExtractionQueueItem, ExtractionQueuePage } from '../../shared/api/extraction-queue.js';
import {
  dataFromResource,
  indexCanServe,
  isCancelled,
  stableFailure,
  validationState,
  type PageResource
} from './pageSupport.js';
import '../styles/dashboard-desk.css';
import { DistributionChecklist } from '../components/first-run/DistributionChecklist.js';

const PAGE_LIMIT = 200;

type DashboardSnapshot = {
  readonly materials: readonly MaterialItem[];
  readonly knowledge: readonly KnowledgeItem[];
  readonly operations: OperationPage;
  readonly version: number;
  readonly completedSources: ReadonlySet<string>;
  readonly queue?: DashboardQueue;
};
type DashboardQueue = { items: ExtractionQueueItem[]; counts: ExtractionQueuePage['counts']; pendingReviewCount: number };

type MaterialItem = MaterialPage['items'][number];
type KnowledgeItem = KnowledgePage['items'][number];

type CollectionResult<T> = ApiClientResult<readonly T[]>;

function validationResult<T>(message: string): CollectionResult<T> {
  return { ok: false, state: validationState(message) };
}

async function collectMaterials(
  api: ReadConsoleApi,
  signal: AbortSignal
): Promise<CollectionResult<MaterialItem>> {
  const items: MaterialItem[] = [];
  const paths = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const query = cursor === undefined ? { limit: PAGE_LIMIT } : { cursor, limit: PAGE_LIMIT };
    const result = await api.listMaterials(query, signal);
    if (!result.ok) return result;
    for (const item of result.value.items) {
      if (item.knowledgeStatus === '已入库') {
        return validationResult('总览材料响应包含已入库记录。');
      }
      if (paths.has(item.path)) return validationResult('总览材料响应包含重复路径。');
      paths.add(item.path);
      items.push(item);
    }
    const next = result.value.nextCursor;
    if (next !== undefined) {
      if (result.value.items.length === 0 || cursors.has(next) || next === cursor) {
        return validationResult('总览材料分页游标无效。');
      }
      cursors.add(next);
    }
    cursor = next;
  } while (cursor !== undefined);

  return { ok: true, value: items };
}

async function collectKnowledge(
  api: ReadConsoleApi,
  signal: AbortSignal
): Promise<CollectionResult<KnowledgeItem>> {
  const items: KnowledgeItem[] = [];
  const paths = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const query = cursor === undefined
      ? { includeObsolete: true, limit: PAGE_LIMIT }
      : { includeObsolete: true, cursor, limit: PAGE_LIMIT };
    const result = await api.listKnowledge(query, signal);
    if (!result.ok) return result;
    for (const item of result.value.items) {
      if (paths.has(item.path)) return validationResult('总览知识响应包含重复路径。');
      paths.add(item.path);
      items.push(item);
    }
    const next = result.value.nextCursor;
    if (next !== undefined) {
      if (result.value.items.length === 0 || cursors.has(next) || next === cursor) {
        return validationResult('总览知识分页游标无效。');
      }
      cursors.add(next);
    }
    cursor = next;
  } while (cursor !== undefined);

  return { ok: true, value: items };
}

async function collectCompletedSources(api: ReadConsoleApi, signal: AbortSignal): Promise<CollectionResult<string>> {
  if (!api.extractionQueue) return { ok: true, value: [] };
  const completed: string[] = []; const seenPaths = new Set<string>();
  const scopes = [
    { view: 'ready', reviewState: 'complete' }, { view: 'unfinished', reviewState: 'complete' },
    ...(['pending', 'generating', 'ready', 'unfinished'] as const).map((view) => ({ view, visibility: 'removed' as const }))
  ] as const;
  for (const scope of scopes) {
    let cursor: string | undefined; const seenCursors = new Set<string>();
    do {
      const result = await api.extractionQueue.list({ ...scope, limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) }, signal);
      if (!result.ok) return result;
      for (const item of result.value.items) {
        if (seenPaths.has(item.materialPath)) return validationResult('处理状态列表已变化，请刷新总览。');
        seenPaths.add(item.materialPath);
        const reviewedSha = item.latestReadyRun?.currentSourceSha256 ?? item.latestReadyRun?.sourceRawSha256;
        // Explicit removals persist across edits; completed reviews only hide their verified source version.
        if (item.removedAt !== undefined || item.reviewComplete === true && item.sourceRawSha256 !== undefined && item.sourceRawSha256 === reviewedSha) completed.push(item.materialPath);
      }
      const next = result.value.nextCursor;
      if (next !== undefined) {
        if (!result.value.items.length || next === cursor || seenCursors.has(next)) return validationResult('处理状态分页游标无效。');
        seenCursors.add(next);
      }
      cursor = next;
    } while (cursor !== undefined);
  }
  return { ok: true, value: completed };
}

async function collectActiveQueue(api: ReadConsoleApi, signal: AbortSignal): Promise<ApiClientResult<DashboardQueue | undefined>> {
  if (!api.extractionQueue) return { ok: true, value: undefined };
  const items: ExtractionQueueItem[] = []; const paths = new Set<string>();
  let counts: ExtractionQueuePage['counts'] | undefined;
  for (const view of ['pending', 'generating', 'ready', 'unfinished'] as const) {
    let cursor: string | undefined; const cursors = new Set<string>();
    do {
      const result = await api.extractionQueue.list({ view, ...(view === 'ready' ? { reviewState: 'pending' as const } : {}), limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) }, signal);
      if (!result.ok) return result;
      if (counts && (Object.keys(counts) as Array<keyof typeof counts>).some(key => counts![key] !== result.value.counts[key])) {
        return { ok: false, state: { status: 'conflict', message: '任务阶段已变化，请重新读取。' } };
      }
      counts = result.value.counts;
      for (const item of result.value.items) {
        if (item.view !== view || paths.has(item.materialPath)) return { ok: false, state: validationState('任务列表的资料阶段或路径重复，请刷新总览。') };
        paths.add(item.materialPath); items.push(item);
      }
      const next = result.value.nextCursor;
      if (next !== undefined) {
        if (!result.value.items.length || next === cursor || cursors.has(next)) return { ok: false, state: validationState('任务列表分页游标无效。') };
        cursors.add(next);
      }
      cursor = next;
    } while (cursor !== undefined);
  }
  return { ok: true, value: { items, counts: counts!, pendingReviewCount: items.filter(item => item.view === 'ready' && item.reviewComplete !== true).length } };
}

function queueItemHref(item: ExtractionQueueItem): string {
  const run = item.activeRun ?? (item.view === 'ready' ? item.latestReadyRun ?? item.latestRun : item.latestRun);
  return `/queue?${new URLSearchParams({ view: item.view, materialPath: item.materialPath, ...(run ? { run: run.id, pane: 'result' } : {}) })}`;
}

function stableVersion(snapshot: HealthSnapshot): number | undefined {
  return indexCanServe(snapshot) ? snapshot.index.version : undefined;
}

function deckCards(materials: readonly MaterialItem[], completed: ReadonlySet<string>, queue?: DashboardQueue): readonly MaterialDeckCard[] {
  const tasks = new Map(queue?.items.map(item => [item.materialPath, item]));
  return materials.flatMap((record): MaterialDeckCard[] => (
    (record.knowledgeStatus !== '未提炼' && !tasks.has(record.path)) || completed.has(record.path) ? [] : [{
      key: record.path,
      path: record.path,
      title: record.title,
      sourcePlatform: record.sourcePlatform,
      ...(record.collectedAt === undefined ? {} : { collectedAt: record.collectedAt }),
      knowledgeStatus: record.knowledgeStatus === '未提炼' ? '未提炼' : '部分入库',
      ...(record.processingStatus === '已归档' ? {} : {
        primaryActionDisabledReason: '请先到收件箱归档这份资料，再开始提炼。'
      }),
      nextAction: tasks.get(record.path)?.view === 'ready' ? 'resume' : tasks.get(record.path)?.view === 'generating' ? 'progress' : tasks.get(record.path)?.view === 'unfinished' ? 'recover' : 'start'
    }]
  ));
}

export function DashboardPage() {
  const navigate = useNavigate();
  const runtime = useConsoleRuntime();
  const [resource, setResource] = useState<PageResource<DashboardSnapshot>>({ status: 'loading' });
  const resourceRef = useRef(resource);
  resourceRef.current = resource;
  const health = dataFromResource(runtime.health);
  const refreshing = runtime.health.status === 'refreshing';
  const canLoad = (runtime.health.status === 'ready' || refreshing)
    && indexCanServe(health);

  useEffect(() => {
    if (!canLoad) return undefined;
    // A new page can load now; an existing page retries when focus refresh finishes.
    if (refreshing && resourceRef.current.status !== 'loading') return undefined;
    const controller = new AbortController();
    const prior = resourceRef.current.status === 'ready' || resourceRef.current.status === 'refreshing'
      ? resourceRef.current.data
      : resourceRef.current.status === 'failed'
        ? resourceRef.current.data
        : undefined;
    setResource(prior === undefined
      ? { status: 'loading' }
      : { status: 'refreshing', data: prior });

    void (async () => {
      let queueChanged = false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = await runtime.api.getHealth(controller.signal);
        if (controller.signal.aborted || isCancelled(before)) return;
        if (!before.ok) {
          setResource(prior === undefined
            ? { status: 'failed', state: stableFailure(before.state.status) }
            : { status: 'failed', state: stableFailure(before.state.status), data: prior });
          return;
        }
        const beforeVersion = stableVersion(before.value);
        if (beforeVersion === undefined) {
          setResource(prior === undefined
            ? { status: 'refreshing', message: '索引尚未就绪，等待稳定快照' }
            : { status: 'refreshing', data: prior, message: '索引尚未就绪，等待稳定快照' });
          return;
        }

        const personalQueue = before.value.vaultSource.status === 'ready' && before.value.vaultSource.adapter === 'filesystem';
        const [materials, knowledge, operations, completed, queue] = await Promise.all([
          collectMaterials(runtime.api, controller.signal),
          collectKnowledge(runtime.api, controller.signal),
          runtime.api.listOperations(controller.signal),
          personalQueue ? collectCompletedSources(runtime.api, controller.signal) : Promise.resolve({ ok: true as const, value: [] as string[] }),
          personalQueue ? collectActiveQueue(runtime.api, controller.signal) : Promise.resolve({ ok: true as const, value: undefined })
        ]);
        if (controller.signal.aborted
          || isCancelled(materials)
          || isCancelled(knowledge)
          || isCancelled(operations) || isCancelled(completed) || isCancelled(queue)) return;
        const failed = [materials, knowledge, operations, completed, queue].find((result) => !result.ok);
        if (failed !== undefined && !failed.ok && !isCancelled(failed)) {
          if (failed.state.status === 'conflict') { if (failed === queue) queueChanged = true; continue; }
          setResource(prior === undefined
            ? { status: 'failed', state: stableFailure(failed.state.status) }
            : { status: 'failed', state: stableFailure(failed.state.status), data: prior });
          return;
        }
        if (!materials.ok || !knowledge.ok || !operations.ok || !completed.ok || !queue.ok) return;

        const after = await runtime.api.getHealth(controller.signal);
        if (controller.signal.aborted || isCancelled(after)) return;
        if (!after.ok) {
          setResource(prior === undefined
            ? { status: 'failed', state: stableFailure(after.state.status) }
            : { status: 'failed', state: stableFailure(after.state.status), data: prior });
          return;
        }
        if (stableVersion(after.value) === beforeVersion) {
          setResource({
            status: 'ready',
            data: {
              materials: materials.value,
              knowledge: knowledge.value,
              operations: operations.value,
              version: beforeVersion,
              completedSources: new Set(completed.value), ...(queue.value ? { queue: queue.value } : {})
            }
          });
          return;
        }
      }

      const message = queueChanged ? '任务阶段仍在变化，等待稳定快照' : '索引版本仍在变化，等待稳定快照';
      setResource(prior === undefined ? { status: 'refreshing', message } : { status: 'refreshing', data: prior, message });
    })();

    return () => controller.abort();
  }, [canLoad, refreshing, runtime.api, runtime.dataRevision]);

  const data = resource.status === 'ready' || resource.status === 'refreshing' || resource.status === 'failed'
    ? resource.data
    : undefined;
  const cards = useMemo(() => deckCards(data?.materials ?? [], data?.completedSources ?? new Set(), data?.queue), [data?.materials, data?.completedSources, data?.queue]);

  if (runtime.health.status === 'failed' && (data === undefined || !indexCanServe(health))) {
    return <PageState state={stableFailure(runtime.health.state.status)} />;
  }

  if (health !== undefined && !indexCanServe(health)) {
    const status = health?.index.status;
    const message = status === 'building'
      ? '索引正在构建，完成前不会显示不完整数字'
      : status === 'failed'
        ? '索引失败，当前不显示可能过时的数字'
        : '索引不可用，当前无法读取统计数据';
    return <PageState state={{ status: 'refreshing', message }} />;
  }

  if (!canLoad && data === undefined) {
    return <PageState state={{ status: 'refreshing', message: '索引不可用，当前无法读取统计数据' }} />;
  }

  if (resource.status === 'loading') {
    return <PageState state={{ status: 'loading', message: '正在核对同一索引版本的数据' }} />;
  }
  if (resource.status === 'refreshing' && data === undefined) {
    return <PageState state={{ status: 'refreshing', ...(resource.message === undefined ? {} : { message: resource.message }) }} />;
  }
  if (resource.status === 'failed' && data === undefined) {
    return <PageState state={resource.state} />;
  }
  if (data === undefined) return null;
  const review = data.queue?.items.find(item => item.view === 'ready' && item.reviewComplete !== true);
  const unfinished = data.queue?.items.find(item => item.view === 'unfinished');
  const generating = data.queue?.items.find(item => item.view === 'generating');

  return (
    <div className="dashboard-reading-desk">
      {runtime.health.status === 'failed' ? (
        <div className="dashboard-status"><PageState state={stableFailure(runtime.health.state.status)} /></div>
      ) : (resource.status === 'refreshing' || runtime.health.status === 'refreshing') && (
        <div className="dashboard-status"><PageState state={{ status: 'refreshing', ...(resource.status === 'refreshing' && resource.message !== undefined ? { message: resource.message } : {}) }} /></div>
      )}
      {runtime.health.status !== 'failed' && resource.status === 'failed' && (
        <div className="dashboard-status"><PageState state={resource.state} /></div>
      )}

      {data.queue && <nav className="dashboard-next" aria-label="继续工作">
        <header><h2>继续工作</h2><span>从上次停下的地方继续</span></header>
        <p className="dashboard-next__explanation">把收藏的资料变成可复用的知识；“待提炼”表示还没有生成知识候选。</p>
        {health?.model.status === 'unconfigured' && data.queue.counts.pending > 0 && (
          <Link className="dashboard-preflight" to="/settings">开始提炼前需要配置 DeepSeek 密钥 · 去设置<ArrowUpRight aria-hidden="true" /></Link>
        )}
        <div className="dashboard-stage-links">
          <Link to="/queue?view=pending">待提炼 <strong data-testid="metric-pending">{data.queue.counts.pending}</strong></Link>
          <Link to="/queue?view=generating">提炼中 <strong>{data.queue.counts.generating}</strong></Link>
          <Link to="/queue?view=ready&reviewState=pending">待确认 <strong>{data.queue.pendingReviewCount}</strong></Link>
          <Link to="/queue?view=unfinished">未完成 <strong>{data.queue.counts.unfinished}</strong></Link>
        </div>
        <div className="dashboard-next-actions">
          {review && <Link className="dashboard-next-card dashboard-next-card--primary" to={queueItemHref(review)}><span>继续审阅</span><strong>{review.title}</strong><small>候选已备好，确认后才会入库</small><ArrowUpRight aria-hidden="true" /></Link>}
          {unfinished && <Link className="dashboard-next-card" to={queueItemHref(unfinished)}><span>处理未完成任务</span><strong>{unfinished.title}</strong><small>查看上次进展，再决定如何继续</small><ArrowUpRight aria-hidden="true" /></Link>}
          {generating && <Link className="dashboard-next-card" to={queueItemHref(generating)}><span>查看提炼进度</span><strong>{generating.title}</strong><small>任务进行中，可查看状态或停止</small><ArrowUpRight aria-hidden="true" /></Link>}
          {runtime.api.intake && <Link className="dashboard-next-card" to="/intake"><span>整理新收件</span><strong>把收藏放进大脑</strong><small>核对信息，预览后归档</small><ArrowUpRight aria-hidden="true" /></Link>}
        </div>
      </nav>}
      {typeof window !== 'undefined' && window.xiaozhaoDesktop?.installClipperHost && <DistributionChecklist />}
      <div className="dashboard-workspace">
      <section className="dashboard-materials" aria-labelledby="materials-title">
        <header className="dashboard-section-heading">
          <div><h2 id="materials-title">{data.queue ? '待处理资料' : '待提炼材料'} <span {...(data.queue ? {} : { 'data-testid': 'metric-pending' })}>{cards.length} 份</span></h2></div>
          <div className="dashboard-heading-links">
            <Link to="/knowledge" className="dashboard-knowledge-total" data-testid="metric-knowledge" title="包含已标记为过时的知识笔记">已积累 {data.knowledge.length} 篇知识</Link>
            <Link to="/queue" className="dashboard-text-link">提炼队列 <ArrowUpRight aria-hidden="true" /></Link>
          </div>
        </header>
        <MaterialDeck
          appearance="showcase"
          cards={cards}
          {...(runtime.api.extraction ? {} : { primaryActionDisabledReason: '请打开最新版桌面 App 使用提炼' })}
          onPrimaryAction={(card) => { const item = data.queue?.items.find(item => item.materialPath === card.path); navigate(item && card.nextAction !== 'start' ? queueItemHref(item) : extractionHref(card.path)); }}
        />
        {cards.length === 0 && runtime.api.intake && (
          <Link className="dashboard-empty-action" to="/intake">去收件箱整理新收件<ArrowUpRight aria-hidden="true" /></Link>
        )}
      </section>
      </div>
      <footer className="dashboard-footer">
        <span><span aria-hidden="true" />收藏成为知识，思考留下痕迹。</span>
        <Link to="/operations" title={data.operations.issues?.length ? '部分操作记录暂未读取' : (data.operations.counts?.all ?? data.operations.items.length) === 0 ? '当前尚无操作记录' : '查看操作进展与历史'}>操作记录 <ArrowUpRight aria-hidden="true" /></Link>
      </footer>
    </div>
  );
}
