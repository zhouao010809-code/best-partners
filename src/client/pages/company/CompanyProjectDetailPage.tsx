import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ArrowLeft, CalendarClock, CheckCircle2, Database, FileText, RefreshCw, ShieldQuestion } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { useCompanyRuntime } from '../../company/CompanyAppShell.js';
import type { CompanyProject } from '../../components/company/company-api.js';
import type { CompanyProjectMetrics } from '../../../shared/api/company-metrics.js';
import { isCancelled } from '../pageSupport.js';

const STATUS_LABELS: Record<CompanyProject['status'], string> = {
  draft: '草稿', active: '服务中', acceptance: '验收中', completed: '已完成', paused: '已暂停', archived: '已封存'
};

const COVERAGE_LABELS: Record<CompanyProjectMetrics['coverage'], string> = {
  not_configured: '尚未接入', connected: '数据已同步', stale: '数据过期', import_required: '待导出', error: '同步失败', attention: '需处理'
};

const IMPORT_STATE_LABELS: Record<CompanyProjectMetrics['recentImports'][number]['state'], string> = {
  imported: '已导入', partial: '部分导入', duplicate: '重复文件', conflict: '需处理', failed: '失败'
};

function metricValue(value: number | undefined): string {
  return value === undefined ? '—' : new Intl.NumberFormat('zh-CN').format(value);
}

export function CompanyProjectDetailPage(): ReactElement {
  const { id } = useParams();
  const { api } = useCompanyRuntime();
  const [project, setProject] = useState<CompanyProject>();
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [message, setMessage] = useState<string>();
  const [metrics, setMetrics] = useState<CompanyProjectMetrics>();

  const load = useCallback(async (): Promise<void> => {
    if (!id) { setState('failed'); setMessage('项目编号缺失。'); return; }
    setState('loading');
    const [result, metricsResult] = await Promise.all([
      api.projects.get(id),
      api.metrics === undefined ? Promise.resolve(undefined) : api.metrics.project(id)
    ]);
    if (!result.ok) {
      if (isCancelled(result)) return;
      setState('failed'); setMessage(result.state.message); return;
    }
    setProject(result.value);
    if (metricsResult?.ok) setMetrics(metricsResult.value);
    setState('ready');
  }, [api, id]);
  useEffect(() => { void load(); }, [load]);

  if (state === 'failed') return <section className="company-empty-state"><p role="alert">{message ?? '项目档案暂时无法读取。'}</p><button type="button" className="company-secondary-button" onClick={() => void load()}>重新读取</button></section>;
  if (state === 'loading' || project === undefined) return <section className="company-empty-state" aria-live="polite"><RefreshCw className="company-spin" size={18} />正在读取项目档案…</section>;

  return (
    <section className="company-page company-project-detail" aria-labelledby="company-project-detail-title">
      <Link className="company-back-link" to="/company/projects"><ArrowLeft size={15} />返回项目档案库</Link>
      <header className="company-page__heading"><div><p className="company-eyebrow">PROJECT / FILE-FIRST RECORD</p><h1 id="company-project-detail-title">{project.name}</h1><p>{project.clientName ?? '客户名称待补齐'} · 项目档案由确认后的文件夹构成</p></div><span className={`company-status company-status--${project.status}`}>{STATUS_LABELS[project.status]}</span></header>
      <section className="company-detail-grid" aria-label="项目基本信息"><article><span><FileText size={16} aria-hidden="true" />项目配置</span><strong>已建立</strong><small>配置指纹 <code>{project.configSha256.slice(0, 16)}…</code></small></article><article><span><Database size={16} aria-hidden="true" />数据覆盖</span><strong>{COVERAGE_LABELS[metrics?.coverage ?? 'not_configured']}</strong><small>{metrics === undefined ? '指标服务未连接' : `快照 ${metrics.snapshotCount} 条 · 内容 ${metrics.contentCount} 个`}</small></article><article><span><CalendarClock size={16} aria-hidden="true" />最近活动</span><strong>{new Date(project.updatedAt).toLocaleDateString('zh-CN')}</strong><small>{new Date(project.updatedAt).toLocaleString('zh-CN', { hour12: false })}</small></article></section>
      {metrics !== undefined && <section className="company-record-panel company-project-metrics-panel"><h2><Database size={16} aria-hidden="true" />平台指标</h2><div className="company-project-metrics__totals"><div><span>播放</span><strong>{metricValue(metrics.totals.views)}</strong></div><div><span>点赞</span><strong>{metricValue(metrics.totals.likes)}</strong></div><div><span>评论</span><strong>{metricValue(metrics.totals.comments)}</strong></div><div><span>分享</span><strong>{metricValue(metrics.totals.shares)}</strong></div></div><p className="company-muted">{metrics.latestMetricDate === null ? '还没有可用的官方导出快照。' : `数据截至 ${metrics.latestMetricDate}，最近观测 ${new Date(metrics.latestObservedAt ?? metrics.latestMetricDate).toLocaleString('zh-CN', { hour12: false })}`}</p><p className="company-metrics-source">来源：官方后台导出 · 原始文件和行级证据已留存</p><div className="company-platform-mini-list">{metrics.platforms.map(item => <div key={item.platform}><span>{item.platform === 'douyin' ? '抖音' : item.platform === 'xiaohongshu' ? '小红书' : '视频号'}</span><strong>{COVERAGE_LABELS[item.coverage]}</strong><small>播放 {metricValue(item.totals.views)} · 点赞 {metricValue(item.totals.likes)}</small></div>)}</div>{metrics.recentImports.length > 0 && <div className="company-import-history"><h3>最近导入</h3>{metrics.recentImports.slice(0, 5).map(item => <div className="company-import-history__row" key={item.id}><span className={`company-data-badge company-data-badge--${item.state === 'imported' || item.state === 'duplicate' ? 'connected' : item.state === 'partial' ? 'stale' : 'attention'}`}>{IMPORT_STATE_LABELS[item.state]}</span><code>{item.sourceRelativePath}</code><small>{item.importedCount} 行入库 · {item.rejectedCount} 行待处理</small></div>)}</div>}</section>}
      <section className="company-record-panel company-drop-folder-panel"><h2>平台导出目录</h2><p className="company-muted">在官方后台点击导出后，把文件复制到 Mac mini 的对应目录；服务会自动扫描，不需要手填数据。</p><div className="company-drop-folder-list"><code>platform-data/douyin/{project.id}/</code><code>platform-data/wechat-channels/{project.id}/</code><code>platform-data/xiaohongshu/{project.id}/</code></div></section>
      <section className="company-record-panel"><h2>文件与证据</h2><dl><div><dt>项目目录</dt><dd>{project.projectRoot}</dd></div><div><dt>来源目录</dt><dd>{project.sourceRoot}</dd></div><div><dt>选用 Skill</dt><dd>{project.selectedSkillIds.length > 0 ? <span className="company-chip-list">{project.selectedSkillIds.map(skillId => <code className="company-chip" key={skillId}>{skillId}</code>)}</span> : '尚未选择定制 Skill'}</dd></div></dl></section>
      <section className="company-record-panel"><h2><CheckCircle2 size={16} aria-hidden="true" />交付状态</h2><p className="company-muted">当前记录项目生命周期状态；平台指标只来自官方后台导出，不显示无法证实的零值。</p><p className="company-detail-note"><ShieldQuestion size={15} aria-hidden="true" />如果 Agent 读取到新的背景资料，请回到项目档案库重新扫描并由人工确认。</p></section>
    </section>
  );
}
