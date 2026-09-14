import { useEffect, useId, useRef, useState } from 'react';
import { Check, FileText, LoaderCircle, RotateCcw, ShieldAlert, X } from 'lucide-react';
import type { AssistantPlanAction } from '../../../shared/api/assistant.js';

type Props = {
  action: AssistantPlanAction;
  onResolved: () => Promise<void>;
  onCancelled: () => Promise<void>;
  onRegenerate?: () => void;
};

const statusLabel: Record<AssistantPlanAction['status'], string> = {
  pending: '待确认',
  running: '正在归档',
  completed: '已归档',
  failed: '归档未完成',
  cancelled: '已取消',
  stale: '文件已变化，未写入'
};

function expiryText(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
}

function isDuplicate(action: AssistantPlanAction): boolean {
  return /相同内容|复用已有归档|已存在/u.test(action.summary);
}

export function AssistantActionPlanCard({ action, onResolved, onCancelled, onRegenerate }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [details, setDetails] = useState(false);
  const confirmTrigger = useRef<HTMLButtonElement>(null);
  const dialogHeading = useRef<HTMLHeadingElement>(null);
  const dialogHeadingId = useId();

  useEffect(() => {
    if (!confirming) return;
    dialogHeading.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return;
      event.preventDefault();
      setConfirming(false);
      setError('');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, confirming]);

  useEffect(() => {
    if (!confirming) confirmTrigger.current?.focus();
  }, [confirming]);

  const canConfirm = action.status === 'pending';
  const terminal = action.status !== 'pending' && action.status !== 'running';
  const duplicate = isDuplicate(action);

  async function resolve() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await onResolved();
      setConfirming(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '确认归档未完成，请重试。');
    } finally { setBusy(false); }
  }

  async function cancel() {
    if (busy) return;
    setBusy(true); setError('');
    try { await onCancelled(); setConfirming(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '取消未完成，请重试。'); }
    finally { setBusy(false); }
  }

  return <article className={`assistant-action-plan assistant-action-plan--${action.status}`} aria-label="待确认的归档计划">
    <div className="assistant-action-plan__heading">
      <div><FileText aria-hidden="true" /><strong>{action.label}</strong></div>
      <span>{statusLabel[action.status]}</span>
    </div>
    <p className="assistant-action-plan__source">{action.sourceTitle}</p>
    <p className="assistant-action-plan__summary">{action.summary}</p>
    <div className="assistant-action-plan__target" aria-label="归档目标"><span>归档目标</span><code>{action.targetPath}</code><span>/</span><code>{action.mainName}</code></div>
    <small className="assistant-action-plan__meta">原件 SHA-256：{action.sourceSha256.slice(0, 8)} · 计划有效至 {expiryText(action.expiresAt)}</small>
    {duplicate && <p className="assistant-action-plan__warning"><ShieldAlert aria-hidden="true" />检测到相同内容，确认后会复用已有归档。</p>}
    {action.status === 'pending' && <p className="assistant-action-plan__not-written">尚未写入资料</p>}
    {action.problem && <p className="assistant-action-plan__problem" role="status">{action.problem}</p>}
    {error && <p className="assistant-action-plan__error" role="alert">{error}</p>}
    <div className="assistant-action-plan__footer">
      <button type="button" className="assistant-action-plan__details" onClick={() => setDetails(value => !value)} aria-expanded={details}>{details ? '收起计划' : '查看计划'}</button>
      {canConfirm && <>
        <button ref={confirmTrigger} type="button" className="assistant-action-plan__confirm" disabled={busy} onClick={() => { setError(''); setConfirming(true); }}>确认归档</button>
        <button type="button" className="assistant-action-plan__cancel" disabled={busy} onClick={() => void cancel()}>取消</button>
      </>}
      {onRegenerate && terminal && action.status !== 'completed' && <button type="button" className="assistant-action-plan__regenerate" disabled={busy} onClick={onRegenerate}><RotateCcw aria-hidden="true" />重新生成计划</button>}
    </div>
    {details && <div className="assistant-action-plan__details-body"><p>{action.summary}</p><p>目标文件：{action.targetPath}/{action.mainName}</p><p>计划编号：{action.id}</p></div>}
    {confirming && <div className="assistant-action-plan__backdrop" role="presentation"><div className="assistant-action-plan__dialog" role="dialog" aria-modal="true" aria-labelledby={dialogHeadingId}>
      <h2 id={dialogHeadingId} ref={dialogHeading} tabIndex={-1}>确认归档</h2>
      <p>将把《{action.sourceTitle}》归档到：</p><code>{action.targetPath}/{action.mainName}</code>
      <p className="assistant-action-plan__dialog-note">确认后才会写入资料；原件会保留，目标路径由本地服务提供。</p>
      {duplicate && <p className="assistant-action-plan__warning"><ShieldAlert aria-hidden="true" />这份内容已有归档，确认后复用已有资料。</p>}
      <div className="assistant-action-plan__dialog-actions">
        <button type="button" className="assistant-action-plan__confirm" disabled={busy} onClick={() => void resolve()}>{busy ? <><LoaderCircle className="assistant-spin" aria-hidden="true" />正在归档…</> : <><Check aria-hidden="true" />最终确认归档</>}</button>
        <button type="button" className="assistant-action-plan__cancel" disabled={busy} onClick={() => { setConfirming(false); setError(''); }}><X aria-hidden="true" />取消</button>
      </div>
    </div></div>}
  </article>;
}
