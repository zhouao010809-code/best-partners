import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpenCheck,
  CircleDashed,
  FileStack,
  History,
  ShieldCheck
} from 'lucide-react';
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
import {
  dataFromResource,
  indexCanServe,
  isCancelled,
  stableFailure,
  validationState,
  type PageResource
} from './pageSupport.js';

const PAGE_LIMIT = 200;

type DashboardSnapshot = {
  readonly materials: readonly MaterialItem[];
  readonly knowledge: readonly KnowledgeItem[];
  readonly operations: OperationPage;
  readonly version: number;
};

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

function stableVersion(snapshot: HealthSnapshot): number | undefined {
  return indexCanServe(snapshot) ? snapshot.index.version : undefined;
}

function dateForSort(record: KnowledgeItem): string | undefined {
  return record.updatedAt ?? record.createdAt;
}

function recentKnowledge(records: readonly KnowledgeItem[]): readonly KnowledgeItem[] {
  return [...records].sort((left, right) => {
    const leftDate = dateForSort(left);
    const rightDate = dateForSort(right);
    if (leftDate === undefined && rightDate !== undefined) return 1;
    if (leftDate !== undefined && rightDate === undefined) return -1;
    const byDate = (rightDate ?? '').localeCompare(leftDate ?? '');
    return byDate === 0 ? left.path.localeCompare(right.path, 'zh-CN') : byDate;
  }).slice(0, 6);
}

function deckCards(materials: readonly MaterialItem[]): readonly MaterialDeckCard[] {
  return materials.flatMap((record): MaterialDeckCard[] => (
    record.knowledgeStatus !== '未提炼' ? [] : [{
      key: record.path,
      path: record.path,
      title: record.title,
      sourcePlatform: record.sourcePlatform,
      ...(record.collectedAt === undefined ? {} : { collectedAt: record.collectedAt }),
      knowledgeStatus: record.knowledgeStatus,
      nextAction: 'start'
    }]
  ));
}

function DashboardMetrics({ snapshot }: { readonly snapshot: DashboardSnapshot }) {
  const pending = snapshot.materials.filter((item) => item.knowledgeStatus === '未提炼').length;
  const partial = snapshot.materials.filter((item) => item.knowledgeStatus === '部分入库').length;
  const upgradeable = snapshot.knowledge.filter(
    (item) => item.usageStatus === 'AI总结' || item.usageStatus === '已优化'
  ).length;
  const metrics = [
    { testId: 'metric-pending', label: '待提炼', value: pending, icon: FileStack, tone: 'green', note: '尚未形成正式知识' },
    { testId: 'metric-partial', label: '部分入库', value: partial, icon: CircleDashed, tone: 'amber', note: '已有部分知识产出' },
    { testId: 'metric-knowledge', label: '正式知识', value: snapshot.knowledge.length, icon: BookOpenCheck, tone: 'blue', note: '包含标记为过时的知识' },
    { testId: 'metric-upgradeable', label: '可升级', value: upgradeable, icon: ShieldCheck, tone: 'red', note: '定论受保护，过时不活跃' }
  ] as const;

  return (
    <section className="metric-strip" aria-label="大脑状态摘要">
      {metrics.map(({ testId, label, value, icon: Icon, tone, note }) => (
        <article key={testId} className={`metric-cell metric-cell--${tone}`} data-testid={testId}>
          <div className="metric-cell__label"><Icon aria-hidden="true" /><span>{label}</span></div>
          <strong>{value}</strong>
          <small>{note}</small>
        </article>
      ))}
    </section>
  );
}

export function DashboardPage() {
  const runtime = useConsoleRuntime();
  const [resource, setResource] = useState<PageResource<DashboardSnapshot>>({ status: 'loading' });
  const resourceRef = useRef(resource);
  resourceRef.current = resource;
  const health = dataFromResource(runtime.health);
  const canLoad = runtime.health.status === 'ready' && indexCanServe(health);

  useEffect(() => {
    if (!canLoad) return undefined;
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

        const [materials, knowledge, operations] = await Promise.all([
          collectMaterials(runtime.api, controller.signal),
          collectKnowledge(runtime.api, controller.signal),
          runtime.api.listOperations(controller.signal)
        ]);
        if (controller.signal.aborted
          || isCancelled(materials)
          || isCancelled(knowledge)
          || isCancelled(operations)) return;
        const failed = [materials, knowledge, operations].find((result) => !result.ok);
        if (failed !== undefined && !failed.ok && !isCancelled(failed)) {
          if (failed.state.status === 'conflict') continue;
          setResource(prior === undefined
            ? { status: 'failed', state: stableFailure(failed.state.status) }
            : { status: 'failed', state: stableFailure(failed.state.status), data: prior });
          return;
        }
        if (!materials.ok || !knowledge.ok || !operations.ok) return;
        if (operations.value.nextCursor !== undefined) {
          setResource(prior === undefined
            ? { status: 'failed', state: validationState('总览操作响应包含意外游标。') }
            : { status: 'failed', state: validationState('总览操作响应包含意外游标。'), data: prior });
          return;
        }

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
              version: beforeVersion
            }
          });
          return;
        }
      }

      setResource(prior === undefined
        ? { status: 'refreshing', message: '索引版本仍在变化，等待稳定快照' }
        : { status: 'refreshing', data: prior, message: '索引版本仍在变化，等待稳定快照' });
    })();

    return () => controller.abort();
  }, [canLoad, runtime.api, runtime.dataRevision]);

  const data = resource.status === 'ready' || resource.status === 'refreshing' || resource.status === 'failed'
    ? resource.data
    : undefined;
  const cards = useMemo(() => deckCards(data?.materials ?? []), [data?.materials]);
  const recent = useMemo(() => recentKnowledge(data?.knowledge ?? []), [data?.knowledge]);

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

  return (
    <div className="dashboard-grid dashboard-grid--live">
      <DashboardMetrics snapshot={data} />
      {runtime.health.status === 'failed' ? (
        <div className="dashboard-status"><PageState state={stableFailure(runtime.health.state.status)} /></div>
      ) : (resource.status === 'refreshing' || runtime.health.status === 'refreshing') && (
        <div className="dashboard-status"><PageState state={{ status: 'refreshing', ...(resource.status === 'refreshing' && resource.message !== undefined ? { message: resource.message } : {}) }} /></div>
      )}
      {runtime.health.status !== 'failed' && resource.status === 'failed' && (
        <div className="dashboard-status"><PageState state={resource.state} /></div>
      )}

      <section className="instrument-panel instrument-panel--wide dashboard-deck" aria-labelledby="materials-title">
        <header className="panel-heading">
          <div><p>MATERIAL SIGNALS</p><h2 id="materials-title">待提炼材料</h2></div>
          <span className="panel-chip">INDEX v{data.version}</span>
        </header>
        <MaterialDeck
          cards={cards}
          primaryActionDisabledReason="提炼工作流将在 Phase 2 启用"
          onPrimaryAction={() => undefined}
        />
      </section>

      <section className="instrument-panel" aria-labelledby="recent-title">
        <header className="panel-heading">
          <div><p>RECENT KNOWLEDGE</p><h2 id="recent-title">最近知识</h2></div>
          <History aria-hidden="true" />
        </header>
        {recent.length === 0 ? (
          <p className="quiet-empty">当前没有正式知识</p>
        ) : (
          <ul className="recent-knowledge" aria-label="最近知识">
            {recent.map((item) => (
              <li key={item.path}>
                <span className={`status-dot status-dot--${item.usageStatus === '过时' ? 'muted' : 'active'}`} aria-hidden="true" />
                <span><strong>{item.title}</strong><small>{item.path}</small></span>
                <time>{dateForSort(item) ?? '日期未标注'}</time>
              </li>
            ))}
          </ul>
        )}
        <div className="operation-honesty">
          <strong>操作记录</strong>
          <span>{data.operations.items.length === 0 ? '当前尚无提炼/写入工作流操作' : '已读取操作记录'}</span>
        </div>
      </section>
    </div>
  );
}
