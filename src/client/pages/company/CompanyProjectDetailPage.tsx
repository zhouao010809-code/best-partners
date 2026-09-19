import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ArrowLeft, CalendarClock, CheckCircle2, Database, FileText, RefreshCw, ShieldQuestion } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { useCompanyRuntime } from '../../company/CompanyAppShell.js';
import type { CompanyProject } from '../../components/company/company-api.js';
import { isCancelled } from '../pageSupport.js';

const STATUS_LABELS: Record<CompanyProject['status'], string> = {
  draft: '草稿', active: '服务中', acceptance: '验收中', completed: '已完成', paused: '已暂停', archived: '已封存'
};

export function CompanyProjectDetailPage(): ReactElement {
  const { id } = useParams();
  const { api } = useCompanyRuntime();
  const [project, setProject] = useState<CompanyProject>();
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [message, setMessage] = useState<string>();

  const load = useCallback(async (): Promise<void> => {
    if (!id) { setState('failed'); setMessage('项目编号缺失。'); return; }
    setState('loading');
    const result = await api.projects.get(id);
    if (!result.ok) {
      if (isCancelled(result)) return;
      setState('failed'); setMessage(result.state.message); return;
    }
    setProject(result.value); setState('ready');
  }, [api, id]);
  useEffect(() => { void load(); }, [load]);

  if (state === 'failed') return <section className="company-empty-state"><p role="alert">{message ?? '项目档案暂时无法读取。'}</p><button type="button" className="company-secondary-button" onClick={() => void load()}>重新读取</button></section>;
  if (state === 'loading' || project === undefined) return <section className="company-empty-state" aria-live="polite"><RefreshCw className="company-spin" size={18} />正在读取项目档案…</section>;

  return (
    <section className="company-page company-project-detail" aria-labelledby="company-project-detail-title">
      <Link className="company-back-link" to="/company/projects"><ArrowLeft size={15} />返回项目档案库</Link>
      <header className="company-page__heading"><div><p className="company-eyebrow">PROJECT / FILE-FIRST RECORD</p><h1 id="company-project-detail-title">{project.name}</h1><p>{project.clientName ?? '客户名称待补齐'} · 项目档案由确认后的文件夹构成</p></div><span className={`company-status company-status--${project.status}`}>{STATUS_LABELS[project.status]}</span></header>
      <section className="company-detail-grid" aria-label="项目基本信息"><article><span><FileText size={16} aria-hidden="true" />项目配置</span><strong>已建立</strong><small>配置指纹 <code>{project.configSha256.slice(0, 16)}…</code></small></article><article><span><Database size={16} aria-hidden="true" />数据覆盖</span><strong>尚未接入</strong><small>平台数据连接将在后续版本配置</small></article><article><span><CalendarClock size={16} aria-hidden="true" />最近活动</span><strong>{new Date(project.updatedAt).toLocaleDateString('zh-CN')}</strong><small>{new Date(project.updatedAt).toLocaleString('zh-CN', { hour12: false })}</small></article></section>
      <section className="company-record-panel"><h2>文件与证据</h2><dl><div><dt>项目目录</dt><dd>{project.projectRoot}</dd></div><div><dt>来源目录</dt><dd>{project.sourceRoot}</dd></div><div><dt>选用 Skill</dt><dd>{project.confidence && Object.keys(project.confidence).length > 0 ? '已记录在项目配置' : '尚未选择定制 Skill'}</dd></div></dl></section>
      <section className="company-record-panel"><h2><CheckCircle2 size={16} aria-hidden="true" />交付状态</h2><p className="company-muted">当前只记录项目生命周期状态；播放量、互动量、咨询量等平台指标尚未接入，不显示为 0。</p><p className="company-detail-note"><ShieldQuestion size={15} aria-hidden="true" />如果 Agent 读取到新的背景资料，请回到项目档案库重新扫描并由人工确认。</p></section>
    </section>
  );
}
