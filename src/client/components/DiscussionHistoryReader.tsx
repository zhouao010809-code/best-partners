import { ArrowRight, FileText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ReadConsoleApi } from '../api/client.js';
import type { DiscussionHistoryDetail } from '../../shared/api/discussion.js';
import { SafeMarkdown } from './SafeMarkdown.js';

const beijingTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
export function historyTime(startedAt: string) {
  const time = new Date(startedAt);
  return Number.isFinite(time.getTime()) ? beijingTime.format(time) : '';
}

export function DiscussionHistoryReader({ path, service, busy, onContinue }: {
  path: string;
  service: NonNullable<ReadConsoleApi['discussion']>;
  busy: boolean;
  onContinue(): void;
}) {
  const [detail, setDetail] = useState<DiscussionHistoryDetail>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(''); setDetail(undefined);
    void service.readHistory(path, controller.signal).then(value => {
      if (!controller.signal.aborted) setDetail(value);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '暂时无法读取聊天记录。');
    });
    return () => controller.abort();
  }, [path, service, retry]);
  if (error) return <p role="alert" className="discussion-error">{error} <button onClick={() => setRetry(n => n + 1)}>重新读取原文</button></p>;
  if (detail?.path !== path) return <p role="status">正在读取聊天原文…</p>;
  return <section className="discussion-paper" aria-label="历史聊天详情">
    <header className="discussion-heading"><div><span>北京时间 · {historyTime(detail.startedAt)}</span><h2>{detail.title}</h2></div></header>
    {detail.materialPaths.length > 0 && <div className="discussion-sources">{detail.materialPaths.map(source =>
      <Link key={source} to={`/library?${new URLSearchParams({ path: source })}`}><FileText size={14} />{source.split('/').at(-1)?.replace(/\.md$/iu, '') || source}</Link>)}</div>}
    <details className="discussion-archive-text" open><summary>聊天原文</summary>
      <div className="discussion-archive-body"><SafeMarkdown>{detail.body}</SafeMarkdown></div>
    </details>
    <div className="discussion-continue"><p>接续时，AI 会读取这份聊天原文和仍可读取的关联资料。</p>
      <button className="discussion-primary" disabled={busy} onClick={onContinue}>{busy ? '正在接回前情…' : '接着聊'} <ArrowRight size={15} /></button></div>
  </section>;
}
