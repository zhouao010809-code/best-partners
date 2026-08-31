import {
  ArrowRight,
  BookOpenCheck,
  Boxes,
  CheckCircle2,
  CircleDashed,
  FileStack,
  Filter,
  Fingerprint,
  FolderSearch,
  Gauge,
  History,
  KeyRound,
  LibraryBig,
  LockKeyhole,
  Search,
  ServerCog,
  ShieldCheck,
  Sparkles,
  Waypoints
} from 'lucide-react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { PageState } from '../components/PageState.js';
import { AppShell } from './AppShell.js';

function MetricStrip() {
  const metrics = [
    { label: '待提炼', icon: FileStack, tone: 'green' },
    { label: '部分入库', icon: CircleDashed, tone: 'amber' },
    { label: '正式知识', icon: BookOpenCheck, tone: 'blue' },
    { label: '结构问题', icon: ShieldCheck, tone: 'red' }
  ] as const;

  return (
    <section className="metric-strip" aria-label="大脑状态摘要">
      {metrics.map(({ label, icon: Icon, tone }) => (
        <article key={label} className={`metric-cell metric-cell--${tone}`}>
          <div className="metric-cell__label">
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </div>
          <strong>—</strong>
          <small>等待本地索引</small>
        </article>
      ))}
    </section>
  );
}

function DashboardPlaceholder() {
  return (
    <div className="dashboard-grid">
      <MetricStrip />

      <section className="instrument-panel instrument-panel--wide" aria-labelledby="pulse-title">
        <header className="panel-heading">
          <div>
            <p>KNOWLEDGE PULSE</p>
            <h2 id="pulse-title">知识脉冲</h2>
          </div>
          <span className="panel-chip">本地索引</span>
        </header>
        <div className="pulse-field" aria-hidden="true">
          <span className="pulse-orbit pulse-orbit--outer" />
          <span className="pulse-orbit pulse-orbit--inner" />
          <span className="pulse-core"><Waypoints strokeWidth={1.1} /></span>
          <span className="pulse-node pulse-node--one" />
          <span className="pulse-node pulse-node--two" />
          <span className="pulse-node pulse-node--three" />
        </div>
        <div className="pulse-legend">
          <span><i className="legend-dot legend-dot--green" />索引中的知识</span>
          <span><i className="legend-dot legend-dot--silver" />待连接材料</span>
        </div>
      </section>

      <section className="instrument-panel" aria-labelledby="activity-title">
        <header className="panel-heading">
          <div>
            <p>RECENT SIGNAL</p>
            <h2 id="activity-title">最近动态</h2>
          </div>
          <History aria-hidden="true" />
        </header>
        <div className="signal-list">
          <div className="signal-row">
            <span className="signal-row__rail" aria-hidden="true" />
            <div><strong>等待第一次同步</strong><small>连接本地 Obsidian 后显示</small></div>
            <span className="signal-row__time">NOW</span>
          </div>
          <div className="signal-row signal-row--muted">
            <span className="signal-row__rail" aria-hidden="true" />
            <div><strong>操作记录保持只读</strong><small>工作流将在后续阶段启用</small></div>
            <span className="signal-row__time">—</span>
          </div>
        </div>
      </section>
    </div>
  );
}

function QueuePlaceholder() {
  return (
    <section className="instrument-panel workspace-panel">
      <div className="control-rail" aria-label="队列筛选预览">
        <div className="control-search">
          <Search aria-hidden="true" />
          <span>搜索原始标题…</span>
          <kbd>⌘ K</kbd>
        </div>
        <button className="quiet-button" type="button" disabled>
          <Filter aria-hidden="true" />筛选
        </button>
      </div>
      <div className="queue-preview" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((index) => (
          <span key={index} className={`queue-preview__sheet queue-preview__sheet--${index}`} />
        ))}
        <span className="queue-preview__active">
          <Sparkles />
          <strong>待提炼材料</strong>
          <small>在同步后显示</small>
        </span>
      </div>
      <PageState state={{ status: 'loading', message: '正在等待本地材料索引' }} />
    </section>
  );
}

function KnowledgePlaceholder() {
  return (
    <div className="split-stage">
      <section className="instrument-panel workspace-panel">
        <div className="control-rail">
          <div className="control-search control-search--wide">
            <FolderSearch aria-hidden="true" />
            <span>搜索标题、主题、关键词与核心结论</span>
          </div>
        </div>
        <div className="knowledge-scaffold" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <PageState state={{ status: 'loading', message: '正在读取知识投影' }} />
      </section>
      <aside className="context-panel" aria-label="检索范围">
        <p>SEARCH SURFACE</p>
        <h2>召回范围</h2>
        <ul>
          <li><Fingerprint aria-hidden="true" /><span><strong>YAML 字段</strong><small>主题、关键词、场景</small></span></li>
          <li><LibraryBig aria-hidden="true" /><span><strong>知识标题</strong><small>不预读 Markdown 正文</small></span></li>
        </ul>
      </aside>
    </div>
  );
}

function OperationsPlaceholder() {
  return (
    <section className="instrument-panel workspace-panel empty-ledger">
      <div className="ledger-ruler" aria-hidden="true">
        <span>TIME</span><span>OPERATION</span><span>STATUS</span><span>TRACE</span>
      </div>
      <PageState state={{ status: 'empty', message: '当前尚无可追溯操作，这是预期状态' }} />
    </section>
  );
}

function ConnectionsPlaceholder() {
  const diagnostics = [
    { label: 'Obsidian Local REST', note: '等待连接诊断', icon: ServerCog, tone: 'blue' },
    { label: '本地索引', note: '尚未接收快照', icon: Gauge, tone: 'amber' },
    { label: '模型配置', note: '仅显示主机与模型名', icon: KeyRound, tone: 'silver' },
    { label: '形式写入门', note: '当前强制关闭', icon: LockKeyhole, tone: 'red' }
  ] as const;

  return (
    <section className="diagnostic-grid" aria-label="系统诊断预览">
      {diagnostics.map(({ label, note, icon: Icon, tone }) => (
        <article className={`diagnostic-row diagnostic-row--${tone}`} key={label}>
          <span className="diagnostic-row__icon"><Icon aria-hidden="true" /></span>
          <div><strong>{label}</strong><small>{note}</small></div>
          <span className="diagnostic-row__state"><i aria-hidden="true" />待检查</span>
        </article>
      ))}
    </section>
  );
}

function ExtractionPlaceholder() {
  return (
    <section className="instrument-panel phase-panel">
      <span className="phase-panel__icon"><Boxes aria-hidden="true" /></span>
      <p>ROUTE RESERVED</p>
      <h2>提炼工作流尚未安装</h2>
      <span>当前阶段只提供读取与检索，不会生成候选内容。</span>
    </section>
  );
}

function WritePlanPlaceholder() {
  return (
    <section className="instrument-panel phase-panel">
      <span className="phase-panel__icon"><CheckCircle2 aria-hidden="true" /></span>
      <p>ROUTE RESERVED</p>
      <h2>安全写入尚未启用</h2>
      <span>写入计划在后续阶段接入，当前不会修改任何正式笔记。</span>
    </section>
  );
}

function NotFoundPlaceholder() {
  return (
    <section className="instrument-panel phase-panel">
      <span className="phase-panel__icon"><ArrowRight aria-hidden="true" /></span>
      <p>UNKNOWN ROUTE</p>
      <h2>这里没有工作区</h2>
      <span>请从主导航返回已开放的只读页面。</span>
    </section>
  );
}

export function AppRouter() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPlaceholder />} />
        <Route path="queue" element={<QueuePlaceholder />} />
        <Route path="knowledge" element={<KnowledgePlaceholder />} />
        <Route path="operations" element={<OperationsPlaceholder />} />
        <Route path="connections" element={<ConnectionsPlaceholder />} />
        <Route path="extractions/:id" element={<ExtractionPlaceholder />} />
        <Route path="write-plans/:id" element={<WritePlanPlaceholder />} />
        <Route path="not-found" element={<NotFoundPlaceholder />} />
        <Route path="*" element={<Navigate to="/not-found" replace />} />
      </Route>
    </Routes>
  );
}
