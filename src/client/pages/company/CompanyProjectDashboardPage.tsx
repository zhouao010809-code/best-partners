import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Activity, ArrowRight, CheckCircle2, CircleDashed, FolderKanban, RefreshCw, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useCompanyRuntime } from '../../company/CompanyAppShell.js';
import type { CompanyMetricsStatus, CompanyProjectMetrics } from '../../../shared/api/company-metrics.js';
import type { CompanyProject } from '../../components/company/company-api.js';
import { isCancelled } from '../pageSupport.js';

const STATUS_LABELS: Record<CompanyProject['status'], string> = {
  draft: '草稿', active: '服务中', acceptance: '验收中', completed: '已完成', paused: '已暂停', archived: '已封存'
};

const COVERAGE_LABELS: Record<CompanyMetricsStatus['coverage'], string> = {
  not_configured: '尚未接入', connected: '数据已同步', stale: '数据过期', import_required: '待导出', error: '同步失败', attention: '需处理'
};

function metricValue(value: number | undefined): string {
  return value === undefined ? '—' : new Intl.NumberFormat('zh-CN').format(value);
}

function platformLabel(platform: string): string {
  if (platform === 'douyin') return '抖音';
  if (platform === 'xiaohongshu') return '小红书';
  return '视频号';
}

function statusIcon(status: CompanyProject['status']): ReactElement {
  if (status === 'active' || status === 'acceptance') return <Activity size={16} aria-hidden="true" />;
  if (status === 'completed') return <CheckCircle2 size={16} aria-hidden="true" />;
  if (status === 'archived') return <FolderKanban size={16} aria-hidden="true" />;
  return <CircleDashed size={16} aria-hidden="true" />;
}

export function CompanyProjectDashboardPage(): ReactElement {
  const { api } = useCompanyRuntime();
  const [items, setItems] = useState<readonly CompanyProject[]>();
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [message, setMessage] = useState<string>();
  const [metricsStatus, setMetricsStatus] = useState<CompanyMetricsStatus>();
  const [projectMetrics, setProjectMetrics] = useState<Readonly<Record<string, CompanyProjectMetrics>>>({});
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setState('loading'); setMessage(undefined);
    const [result, metricsResult] = await Promise.all([
      api.projects.list(),
      api.metrics === undefined ? Promise.resolve(undefined) : api.metrics.status()
    ]);
    if (!result.ok) {
      if (isCancelled(result)) return;
      setState('failed'); setMessage(result.state.message); return;
    }
    setItems(result.value.items);
    setMetricsStatus(metricsResult?.ok ? metricsResult.value : undefined);
    if (api.metrics === undefined) {
      setProjectMetrics({});
    } else {
      const metricResults = await Promise.all(result.value.items.map(item => api.metrics!.project(item.id)));
      const nextMetrics: Record<string, CompanyProjectMetrics> = {};
      metricResults.forEach((metricResult, index) => {
        if (metricResult.ok) nextMetrics[result.value.items[index]!.id] = metricResult.value;
      });
      setProjectMetrics(nextMetrics);
    }
    setState('ready');
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const refreshAll = useCallback(async (): Promise<void> => {
    setSyncing(true);
    try {
      if (api.metrics !== undefined) await api.metrics.scan();
      await load();
    } finally {
      setSyncing(false);
    }
  }, [api, load]);

  const prioritized = useMemo(() => [...(items ?? [])].sort((left, right) => {
    const weight: Record<CompanyProject['status'], number> = { active: 0, acceptance: 1, draft: 2, paused: 3, completed: 4, archived: 5 };
    return weight[left.status] - weight[right.status] || right.updatedAt.localeCompare(left.updatedAt);
  }), [items]);
  const activeCount = (items ?? []).filter(item => item.status === 'active' || item.status === 'acceptance').length;
  const acceptanceCount = (items ?? []).filter(item => item.status === 'acceptance').length;
  const draftCount = (items ?? []).filter(item => item.status === 'draft').length;
  const coverage = metricsStatus?.coverage ?? 'not_configured';
  const viewValues = metricsStatus?.platforms
    .map(item => item.totals.views)
    .filter((value): value is number => value !== undefined) ?? [];
  const platformViews = viewValues.length === 0 ? undefined : viewValues.reduce((sum, value) => sum + value, 0);

  return (
    <section className="company-page company-dashboard" aria-labelledby="company-dashboard-title">
      <header className="company-page__heading"><div><p className="company-eyebrow">COMPANY CONTROL DESK / P0</p><h1 id="company-dashboard-title">项目数据看板</h1><p>先看服务中和验收中的项目。平台数据来自官方导出文件，Mac mini 会自动入库；没有来源时不填零。</p></div><button type="button" className="company-secondary-button" onClick={() => void refreshAll()} disabled={state === 'loading' || syncing}><RefreshCw size={15} className={state === 'loading' || syncing ? 'company-spin' : undefined} />{syncing ? '同步中…' : '刷新数据'}</button></header>
      {state === 'failed' && <section className="company-empty-state"><p role="alert">{message ?? '项目数据暂时无法读取。'}</p><button type="button" className="company-secondary-button" onClick={() => void load()}>重新读取</button></section>}
      {state !== 'failed' && <>
        <section className="company-metric-grid" aria-label="项目概览"><article><span>服务中 / 验收中</span><strong>{state === 'loading' ? '…' : activeCount}</strong><small>{acceptanceCount > 0 ? `${acceptanceCount} 个项目正在验收` : '按项目状态自动汇总'}</small></article><article><span>草稿项目</span><strong>{state === 'loading' ? '…' : draftCount}</strong><small>{draftCount > 0 ? '进入项目档案核对后再转为服务中' : '当前没有待完善草稿'}</small></article><article><span>平台数据覆盖</span><strong className="company-metric-text">{COVERAGE_LABELS[coverage]}</strong><small>{coverage === 'connected' ? `抖音 / 视频号 / 小红书 · 播放 ${metricValue(platformViews)}` : '只显示已从官方来源导入的指标'}</small></article><article><span>项目健康</span><strong className="company-metric-text">待建立基线</strong><small>由 Agent 读取交付记录后生成</small></article></section>
        {metricsStatus !== undefined && <section className="company-platform-status" aria-label="平台同步状态"><div className="company-section-heading"><div><p className="company-eyebrow">DATA SOURCES</p><h2>平台同步</h2></div><small>最近一次扫描 {metricsStatus.lastScanAt === null ? '尚未扫描' : new Date(metricsStatus.lastScanAt).toLocaleString('zh-CN', { hour12: false })}</small></div><div className="company-platform-status__grid">{metricsStatus.platforms.map(item => <article key={item.platform}><div><strong>{platformLabel(item.platform)}</strong><span className={`company-data-badge company-data-badge--${item.coverage}`}>{COVERAGE_LABELS[item.coverage]}</span></div><p>播放 {metricValue(item.totals.views)} · 点赞 {metricValue(item.totals.likes)}</p><small>{item.latestMetricDate === null ? '没有可用快照' : `数据截至 ${item.latestMetricDate}`}</small></article>)}</div></section>}
        <section className="company-dashboard-section" aria-label="优先项目"><div className="company-section-heading"><div><p className="company-eyebrow">NOW / PRIORITY</p><h2>优先项目</h2></div><Link className="company-text-link" to="/company/projects">查看项目档案库 <ArrowRight size={14} /></Link></div>{state === 'loading' && <p className="company-muted">正在读取项目状态…</p>}{state === 'ready' && prioritized.length === 0 && <div className="company-empty-state"><ShieldAlert size={22} aria-hidden="true" /><h3>还没有项目数据</h3><p>先在项目档案库导入一个文件夹，确认后这里会按服务阶段排序。</p><Link className="company-primary-button" to="/company/projects">进入项目档案库 <ArrowRight size={15} /></Link></div>}{prioritized.length > 0 && <div className="company-dashboard-list">{prioritized.map(project => { const metrics = projectMetrics[project.id]; return <Link to={`/company/projects/${encodeURIComponent(project.id)}`} className="company-dashboard-row" key={project.id}><span className={`company-dashboard-row__icon company-status--${project.status}`}>{statusIcon(project.status)}</span><span className="company-dashboard-row__main"><strong>{project.name}</strong><small>{project.clientName ?? '客户名称待补齐'} · 最近更新 {new Date(project.updatedAt).toLocaleString('zh-CN', { hour12: false })}</small>{metrics !== undefined && <small className="company-dashboard-row__metrics"><span className={`company-data-badge company-data-badge--${metrics.coverage}`}>{COVERAGE_LABELS[metrics.coverage]}</span>{metrics.totals.views === undefined ? '播放 —' : `播放 ${metricValue(metrics.totals.views)}`}{metrics.totals.likes === undefined ? ' · 点赞 —' : ` · 点赞 ${metricValue(metrics.totals.likes)}`}</small>}</span><span className="company-dashboard-row__status">{STATUS_LABELS[project.status]}</span><ArrowRight size={16} aria-hidden="true" /></Link>; })}</div>}</section>
      </>}
    </section>
  );
}
