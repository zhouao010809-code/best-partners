import { useId, useState } from 'react';
import { ArrowUpRight, BookOpen, ChevronDown, ChevronUp, CircleCheck, FileText, Inbox, LoaderCircle, RefreshCw } from 'lucide-react';
import type { ExtractionQueueItem, ExtractionQueueView } from '../../../shared/api/extraction-queue.js';
import '../../styles/queue-cabinet.css';

export interface CabinetDrawerState {
  id: ExtractionQueueView;
  label: string;
  count: number | string;
  items: readonly ExtractionQueueItem[];
  loading?: boolean;
  error?: string;
  expanded?: boolean;
  hasMore?: boolean;
  moreBusy?: boolean;
  stale?: boolean;
}

export interface QueueCabinetProps {
  drawers: readonly CabinetDrawerState[];
  selectedPath: string;
  onSelect(item: ExtractionQueueItem): void;
  onToggleAll(id: ExtractionQueueView, expanded: boolean): void;
  onLoadMore(id: ExtractionQueueView): void;
  onRetry(id: ExtractionQueueView): void;
}

const emptyText: Record<ExtractionQueueView, string> = {
  pending: '当前没有待提炼资料',
  generating: '没有正在进行的提炼',
  ready: '还没有待确认的候选',
  unfinished: '没有未完成的提炼'
};

export function QueueCabinet({ drawers, ...props }: QueueCabinetProps) {
  return <div className="queue-cabinet">
    {drawers.map(drawer => <CabinetDrawer key={drawer.id} drawer={drawer} {...props} />)}
  </div>;
}

function CabinetDrawer({ drawer, selectedPath, onSelect, onToggleAll, onLoadMore, onRetry }:
  Omit<QueueCabinetProps, 'drawers'> & { drawer: CabinetDrawerState }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const items = drawer.expanded ? drawer.items : drawer.items.slice(0, 3);
  const hasHiddenItems = drawer.items.length > 3 || Number(drawer.count) > 3 || drawer.hasMore;

  return <section className="queue-drawer" data-view={drawer.id} data-open={open} data-empty={!drawer.loading && !drawer.error && drawer.items.length === 0} role="region" aria-label={drawer.label}>
    <div className="queue-drawer-pocket" aria-hidden="true" />
    <div className="queue-drawer-rail queue-drawer-rail--left" aria-hidden="true" />
    <div className="queue-drawer-rail queue-drawer-rail--right" aria-hidden="true" />
    <div className="queue-drawer-slide">
    <div id={bodyId} className="queue-drawer-reveal" aria-hidden={!open} inert={!open}>
    <div className="queue-drawer-reveal-clip"><div className="queue-drawer-cavity">
      <div className="queue-drawer-floor" aria-hidden="true" />
      <div className="queue-drawer-back" aria-hidden="true" />
      <div className="queue-drawer-wall queue-drawer-wall--left" aria-hidden="true" />
      <div className="queue-drawer-wall queue-drawer-wall--right" aria-hidden="true" />
      {drawer.stale && <div className="queue-drawer-feedback" role="status">
        <span>资料状态已更新。</span><button type="button" aria-label={`刷新${drawer.label}`} onClick={() => onRetry(drawer.id)}><RefreshCw aria-hidden="true" />刷新</button>
      </div>}
      {drawer.error && <div className="queue-drawer-feedback queue-drawer-feedback--error" role="alert">
        <span>{drawer.error}</span><button type="button" aria-label={`重试${drawer.label}`} disabled={drawer.loading} onClick={() => onRetry(drawer.id)}><RefreshCw aria-hidden="true" />重试</button>
      </div>}
      {drawer.loading && items.length === 0 && <div className="queue-drawer-empty" role="status"><LoaderCircle className="queue-drawer-spinner" aria-hidden="true" /><span>正在读取资料…</span></div>}
      {!drawer.loading && !drawer.error && items.length === 0 && <div className="queue-drawer-empty"><Inbox aria-hidden="true" /><span>{emptyText[drawer.id]}</span></div>}
      {items.length > 0 && <div className={`queue-drawer-grid queue-drawer-grid--${drawer.id}`}>
        {items.map(item => <CabinetItem key={item.materialPath} item={item} selected={selectedPath === item.materialPath} onSelect={onSelect} />)}
      </div>}
      {hasHiddenItems && <div className="queue-drawer-pagination">
        <button type="button" aria-label={drawer.expanded ? `收起${drawer.label}更多资料` : `查看全部${drawer.label}`}
          disabled={drawer.loading} onClick={() => onToggleAll(drawer.id, !drawer.expanded)}>
          {drawer.expanded ? '收起更多' : '查看全部'}{drawer.expanded ? <ChevronUp aria-hidden="true" /> : <ArrowUpRight aria-hidden="true" />}
        </button>
        {drawer.expanded && drawer.hasMore && <button type="button" disabled={drawer.moreBusy || drawer.loading} onClick={() => onLoadMore(drawer.id)}>
          {drawer.moreBusy ? <><LoaderCircle className="queue-drawer-spinner" aria-hidden="true" />正在加载更多资料…</> : <>加载更多资料<ChevronDown aria-hidden="true" /></>}
        </button>}
      </div>}
    </div></div></div>
    <div className="queue-drawer-fascia">
    <h2 className="queue-drawer-label">{drawer.label} <span>{drawer.count}</span></h2>
    <button type="button" className="queue-drawer-front" aria-label={`${open ? '收起' : '展开'}${drawer.label}抽屉`}
      aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(value => !value)}>
      <span className="queue-drawer-handle" aria-hidden="true" />
      <span className="queue-drawer-front-action"><span>{open ? '收起' : '展开'}</span>{open ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</span>
    </button>
    </div></div>
  </section>;
}

function itemStatus(item: ExtractionQueueItem): string {
  if (item.view === 'generating') return '正在提炼';
  if (item.view === 'ready') {
    const readyRun = item.latestReadyRun ?? (item.latestRun?.status === 'ready' ? item.latestRun : undefined);
    if ((item.reviewComplete ?? readyRun?.reviewComplete) === true) return '已处理';
    const count = item.pendingCandidateCount ?? readyRun?.pendingCandidateCount ?? readyRun?.candidateCount;
    return count === undefined ? '待处理 · 候选数量未记录' : `待处理 · ${count} 条候选`;
  }
  if (item.view === 'unfinished') return item.latestRun?.status === 'cancelled' ? '已停止' : '未完成';
  return '待提炼';
}

function CabinetItem({ item, selected, onSelect }: { item: ExtractionQueueItem; selected: boolean; onSelect: QueueCabinetProps['onSelect'] }) {
  const ready = item.view === 'ready';
  const running = item.view === 'generating';
  const status = itemStatus(item);
  const problem = item.view === 'unfinished'
    ? item.latestRun?.status === 'cancelled'
      ? `已停止${item.canExtract ? ' · 可以重新提炼' : ''}`
      : item.latestRun?.problem || `上次未完成${item.canExtract ? ' · 可以重试' : ''}`
    : undefined;

  return <button type="button" className={`queue-cabinet-item queue-cabinet-item--${running ? 'running' : ready ? 'knowledge' : 'file'}`}
    aria-label={`打开 ${item.title}`} aria-pressed={selected} title={item.title} onClick={() => onSelect(item)}>
    <span className="queue-cabinet-item-face">
      <span className="queue-cabinet-item-icon" aria-hidden="true">{running ? <span className="queue-cabinet-running-dot" /> : ready ? <BookOpen /> : <FileText />}</span>
      <strong className="queue-cabinet-item-title">{item.title}</strong>
      <span className="queue-cabinet-item-meta"><span>来源：{item.sourcePlatform || '未记录'}</span><span>采集：{item.collectedAt || '未记录'}</span></span>
      <span className={`queue-cabinet-item-status queue-cabinet-item-status--${item.view}`}>
        {status === '已处理' && <CircleCheck aria-hidden="true" />}{status}
      </span>
      {problem && <span className="queue-cabinet-item-problem">{problem}</span>}
      {ready && <ArrowUpRight className="queue-cabinet-item-open" aria-hidden="true" />}
    </span>
  </button>;
}
