import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { AlertTriangle, CheckCircle2, FileBox, Hash, ShieldQuestion } from 'lucide-react';
import type { CompanyApiResult, CompanyProjectConfirmRequest, CompanyProjectProposal, CompanyProjectRun } from './company-api.js';

export interface ProjectImportProposalProps {
  readonly run: CompanyProjectRun;
  readonly proposal: CompanyProjectProposal;
  readonly onConfirm: (input: CompanyProjectConfirmRequest) => Promise<CompanyApiResult<unknown>>;
  readonly onCancel?: () => void;
}

const FIELD_LABELS: Record<string, string> = {
  clientName: '客户名称',
  serviceStart: '服务开始日期',
  serviceEnd: '服务结束日期'
};

function formatTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString('zh-CN', { hour12: false });
}

export function ProjectImportProposal({ run, proposal, onConfirm, onCancel }: ProjectImportProposalProps): ReactElement {
  const [name, setName] = useState(proposal.suggestedName);
  const [clientName, setClientName] = useState(proposal.suggestedClientName ?? '');
  const [status, setStatus] = useState<'draft' | 'active'>(proposal.suggestedStatus);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([...proposal.selectedSkillIds]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const unknownFields = useMemo(() => Object.entries(proposal.fields).filter(([, field]) => field.confidence === 'unknown'), [proposal.fields]);
  const fileCount = proposal.entries.filter(entry => entry.kind === 'file').length;

  async function confirm(): Promise<void> {
    if (submitting) return;
    if (!name.trim()) { setError('项目名称不能为空。'); return; }
    setSubmitting(true);
    setError(undefined);
    const result = await onConfirm({ name: name.trim(), ...(clientName.trim() ? { clientName: clientName.trim() } : {}), status, sourceSha256: proposal.sourceSha256, selectedSkillIds });
    setSubmitting(false);
    if (!result.ok) {
      if ('cancelled' in result) return;
      setError(result.state.message || '确认项目失败，请重试。');
    }
  }

  function toggleSkill(id: string): void {
    setSelectedSkillIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  }

  return (
    <article className="company-proposal-card" aria-labelledby="project-proposal-title">
      <header className="company-proposal-card__header">
        <div><p className="company-eyebrow">PROJECT INTAKE / REVIEW REQUIRED</p><h2 id="project-proposal-title">导入提案</h2><p className="company-muted">Agent 只做结构化推断；确认前不会写入正式项目目录。</p></div>
        <span className="company-proposal-status"><ShieldQuestion size={15} aria-hidden="true" />待确认</span>
      </header>

      <dl className="company-proposal-meta">
        <div><dt>来源文件夹</dt><dd>{proposal.sourceRoot}</dd></div>
        <div><dt>文件数量</dt><dd><FileBox size={14} aria-hidden="true" />{fileCount} 个文件 / {proposal.entries.length} 项</dd></div>
        <div><dt>扫描时间</dt><dd>{formatTime(run.updatedAt)}</dd></div>
        <div><dt>来源指纹</dt><dd><Hash size={14} aria-hidden="true" /><code>{proposal.sourceSha256.slice(0, 16)}…</code></dd></div>
      </dl>

      <div className="company-proposal-form">
        <label>项目名称<input aria-label="建议项目名称" value={name} onChange={event => setName(event.target.value)} /></label>
        <label>客户名称<input aria-label="客户名称" placeholder="可留空，后续补齐" value={clientName} onChange={event => setClientName(event.target.value)} /></label>
        <label>项目状态<select aria-label="项目状态" value={status} onChange={event => setStatus(event.target.value as 'draft' | 'active')}><option value="draft">草稿</option><option value="active">服务中</option></select></label>
      </div>

      <section className="company-proposal-evidence" aria-label="Agent 推断字段">
        <h3>Agent 读取结果</h3>
        {Object.entries(proposal.fields).map(([key, field]) => (
          <div className={`company-evidence-row company-evidence-row--${field.confidence}`} key={key}>
            <span>{FIELD_LABELS[key] ?? key}</span>
            {field.confidence === 'inferred' ? <><strong>{field.value}</strong><small>推断 · {field.evidencePaths.join('、') || '无明确证据'}</small></> : <><strong aria-label={`待确认：${FIELD_LABELS[key] ?? key}`}><ShieldQuestion size={14} aria-hidden="true" />待确认：{FIELD_LABELS[key] ?? key}</strong><small>{field.evidencePaths.length ? `证据：${field.evidencePaths.join('、')}` : '资料中没有明确证据'}</small></>}
          </div>
        ))}
        {unknownFields.length > 0 && <p className="company-unknown-note"><ShieldQuestion size={15} aria-hidden="true" />有 {unknownFields.length} 项信息未能确认，保留为待补齐，不自动填值。</p>}
      </section>

      <section className="company-proposal-skills" aria-label="建议调用的 Skill">
        <h3>本次项目 Skill</h3>
        {proposal.selectedSkillIds.length === 0 ? <p className="company-muted">尚未匹配定制 Skill；确认后可由 Agent 继续补充。</p> : <div className="company-chip-list">{proposal.selectedSkillIds.map(id => <label key={id} className="company-chip"><input type="checkbox" checked={selectedSkillIds.includes(id)} onChange={() => toggleSkill(id)} />{id}</label>)}</div>}
      </section>

      {proposal.issues.length > 0 && <section className="company-proposal-issues" aria-label="扫描问题"><h3><AlertTriangle size={15} aria-hidden="true" />扫描提示</h3><ul>{proposal.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></section>}
      {error && <p className="company-inline-error" role="alert">{error}</p>}
      <footer className="company-proposal-card__actions"><button type="button" className="company-secondary-button" onClick={onCancel} disabled={submitting}>返回项目库</button><button type="button" className="company-primary-button" onClick={() => void confirm()} disabled={submitting}><CheckCircle2 size={15} aria-hidden="true" />{submitting ? '正在确认…' : '确认并建立项目'}</button></footer>
    </article>
  );
}
