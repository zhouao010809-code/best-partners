import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Activity, ArrowRight, CheckCircle2, CircleDashed, FolderKanban, RefreshCw, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useCompanyRuntime } from '../../company/CompanyAppShell.js';
import type { CompanyProject } from '../../components/company/company-api.js';
import { isCancelled } from '../pageSupport.js';

const STATUS_LABELS: Record<CompanyProject['status'], string> = {
  draft: '草稿', active: '服务中', acceptance: '验收中', completed: '已完成', paused: '已暂停', archived: '已封存'
};

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

  const load = useCallback(async (): Promise<void> => {
    setState('loading'); setMessage(undefined);
    const result = await api.projects.list();
    if (!result.ok) {
      if (isCancelled(result)) return;
      setState('failed'); setMessage(result.state.message); return;
    }
    setItems(result.value.items); setState('ready');
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const prioritized = useMemo(() => [...(items ?? [])].sort((left, right) => {
    const weight: Record<CompanyProject['status'], number> = { active: 0, acceptance: 1, draft: 2, paused: 3, completed: 4, archived: 5 };
    return weight[left.status] - weight[right.status] || right.updatedAt.localeCompare(left.updatedAt);
  }), [items]);
  const activeCount = (items ?? []).filter(item => item.status === 'active' || item.status === 'acceptance').length;
  const acceptanceCount = (items ?? []).filter(item => item.status === 'acceptance').length;

  return (
    <section className="company-page company-dashboard" aria-labelledby="company-dashboard-title">
      <header className="company-page__heading"><div><p className="company-eyebrow">COMPANY CONTROL DESK / P0</p><h1 id="company-dashboard-title">项目数据看板</h1><p>先看服务中和验收中的项目。平台播放量等数据只有接入真实来源后才显示，不用零值填空。</p></div><button type="button" className="company-secondary-button" onClick={() => void load()} disabled={state === 'loading'}><RefreshCw size={15} className={state === 'loading' ? 'company-spin' : undefined} />刷新</button></header>
      {state === 'failed' && <section className="company-empty-state"><p role="alert">{message ?? '项目数据暂时无法读取。'}</p><button type="button" className="company-secondary-button" onClick={() => void load()}>重新读取</button></section>}
      {state !== 'failed' && <>
        <section className="company-metric-grid" aria-label="项目概览"><article><span>服务中 / 验收中</span><strong>{state === 'loading' ? '…' : activeCount}</strong><small>{acceptanceCount > 0 ? `${acceptanceCount} 个项目正在验收` : '按项目状态自动汇总'}</small></article><article><span>待确认提案</span><strong className="company-metric-text">需核对</strong><small>请到项目档案库查看最近一次扫描</small></article><article><span>平台数据覆盖</span><strong className="company-metric-text">尚未接入</strong><small>不展示虚构的播放量、互动量或转化量</small></article><article><span>项目健康</span><strong className="company-metric-text">待建立基线</strong><small>由 Agent 读取交付记录后生成</small></article></section>
        <section className="company-dashboard-section" aria-label="优先项目"><div className="company-section-heading"><div><p className="company-eyebrow">NOW / PRIORITY</p><h2>优先项目</h2></div><Link className="company-text-link" to="/company/projects">查看项目档案库 <ArrowRight size={14} /></Link></div>{state === 'loading' && <p className="company-muted">正在读取项目状态…</p>}{state === 'ready' && prioritized.length === 0 && <div className="company-empty-state"><ShieldAlert size={22} aria-hidden="true" /><h3>还没有项目数据</h3><p>先在项目档案库导入一个文件夹，确认后这里会按服务阶段排序。</p><Link className="company-primary-button" to="/company/projects">进入项目档案库 <ArrowRight size={15} /></Link></div>}{prioritized.length > 0 && <div className="company-dashboard-list">{prioritized.map(project => <Link to={`/company/projects/${encodeURIComponent(project.id)}`} className="company-dashboard-row" key={project.id}><span className={`company-dashboard-row__icon company-status--${project.status}`}>{statusIcon(project.status)}</span><span className="company-dashboard-row__main"><strong>{project.name}</strong><small>{project.clientName ?? '客户名称待补齐'} · 最近更新 {new Date(project.updatedAt).toLocaleString('zh-CN', { hour12: false })}</small></span><span className="company-dashboard-row__status">{STATUS_LABELS[project.status]}</span><ArrowRight size={16} aria-hidden="true" /></Link>)}</div>}</section>
      </>}
    </section>
  );
}
