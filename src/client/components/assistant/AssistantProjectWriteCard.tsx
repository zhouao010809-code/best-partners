import { useEffect, useId, useRef, useState } from 'react';
import { Check, FileText, LoaderCircle, X } from 'lucide-react';
import type { AssistantProjectWriteAction } from '../../../shared/api/assistant.js';

type Props = {
  action: AssistantProjectWriteAction;
  onResolved: ((action: AssistantProjectWriteAction) => Promise<void>) | undefined;
  onCancelled: ((action: AssistantProjectWriteAction) => Promise<void>) | undefined;
};

const labels: Record<AssistantProjectWriteAction['status'], string> = {
  pending: '待确认', running: '正在写入', completed: '已保存', failed: '写入未完成', cancelled: '已取消', stale: '计划已失效'
};

export function AssistantProjectWriteCard({ action, onResolved, onCancelled }: Props) {
  const [dialog, setDialog] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const headingId = useId(); const heading = useRef<HTMLHeadingElement>(null); const trigger = useRef<HTMLButtonElement>(null);
  const pending = action.status === 'pending';
  useEffect(() => { if (dialog) heading.current?.focus(); else trigger.current?.focus(); }, [dialog]);
  async function resolve() {
    if (busy || !onResolved) return; setBusy(true); setError('');
    try { await onResolved(action); setDialog(false); } catch (cause) { setError(cause instanceof Error ? cause.message : '项目写入未完成，请重试。'); } finally { setBusy(false); }
  }
  async function cancel() {
    if (busy || !onCancelled) return; setBusy(true); setError('');
    try { await onCancelled(action); setDialog(false); } catch (cause) { setError(cause instanceof Error ? cause.message : '取消未完成，请重试。'); } finally { setBusy(false); }
  }
  return <article className={`assistant-project-write assistant-project-write--${action.status}`} aria-label="项目输出写入计划">
    <div className="assistant-project-write__heading"><div><FileText aria-hidden="true" /><strong>{action.category}</strong></div><span>{labels[action.status]}</span></div>
    <p>{action.projectName} · {action.summary || action.label}</p>
    {pending && <p className="assistant-project-write__not-written">尚未写入项目</p>}
    <dl className="assistant-project-write__meta"><div><dt>目标文件</dt><dd><code>{action.targetPath}</code></dd></div><div><dt>源版本</dt><dd>第 {action.sourceRevision} 次扫描</dd></div></dl>
    {action.problem && <p role="status" className="assistant-project-write__problem">{action.problem}</p>}
    {error && <p role="alert" className="assistant-project-write__error">{error}</p>}
    {pending && onResolved && <div className="assistant-project-write__actions"><button ref={trigger} type="button" disabled={busy} onClick={() => { setError(''); setDialog(true); }}>确认写入</button>{onCancelled && <button type="button" disabled={busy} onClick={() => void cancel()}>取消</button>}</div>}
    {dialog && <div className="assistant-project-write__backdrop" role="presentation"><div className="assistant-project-write__dialog" role="dialog" aria-modal="true" aria-labelledby={headingId}><h2 id={headingId} ref={heading} tabIndex={-1}>确认写入项目</h2><p>将把内容保存到《{action.projectName}》的项目工作区：</p><code>{action.targetPath}</code><p>只会创建新文件，不会覆盖已有文件。</p><div><button type="button" disabled={busy} onClick={() => void resolve()}>{busy ? <><LoaderCircle aria-hidden="true" />正在写入…</> : <><Check aria-hidden="true" />最终确认</>}</button><button type="button" disabled={busy} onClick={() => setDialog(false)}><X aria-hidden="true" />返回</button></div></div></div>}
  </article>;
}
