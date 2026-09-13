import { useEffect, useState } from 'react';
import { ArrowRight, Check, Copy, FileText, MessageCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { AssistantMessage, AssistantSource, AssistantReviewAction, AssistantArchiveAction } from '../../../shared/api/assistant.js';
import { attachmentContentHref } from './AttachmentPicker.js';
import { SafeMarkdown } from '../SafeMarkdown.js';

export const assistantSourceHref = (path: string) => `${path.startsWith('02知识库/') ? '/knowledge' : '/library'}?${new URLSearchParams({ path })}`;
export const assistantPathTitle = (path: string) => path.split('/').at(-1)?.replace(/\.md$/iu, '') ?? path;

function Citation({ source }: { source: AssistantSource }) {
  const [open, setOpen] = useState(false);
  return <span className="assistant-citation"><button type="button" aria-label={`查看引用 ${source.id}`} aria-expanded={open} onClick={() => setOpen(value => !value)}>{source.attachmentId ? '文件' : source.id.replace(/^S/u, '')}</button>{open && <span className="assistant-evidence" role="region" aria-label={`${source.title}的引用预览`}>
    <strong>{source.title}</strong>
    {source.evidence?.length ? source.evidence.map((evidence, index) => <span className="assistant-evidence__passage" key={index}><q>{evidence.excerpt}</q><small>{evidence.page ? `原件第 ${evidence.page} 页` : `原文第 ${evidence.startLine}–${evidence.endLine} 行`} · 阅读时的版本 {evidence.revision.slice(0, 8)}</small></span>) : <span>{source.kind === 'search' ? '这是一份检索到的相关资料，尚无已读原文片段。' : '这条历史引用未记录原文片段，可打开完整资料核对。'}</span>}
    <SourceLink source={source}>打开完整资料 <ArrowRight size={13} /></SourceLink>
  </span>}</span>;
}

function ReviewCard({ action }: { action: AssistantReviewAction }) {
  const status = action.status;
  const label = status === 'empty' ? '已完成 · 无候选' : status === 'committed' ? '已入库' : status === 'partial' ? '部分已处理' : status === 'writing' ? '正在入库' : status === 'discarded' ? '已放弃' : status === 'unavailable' ? '记录暂不可用' : status === 'needs-review' ? '需要核验' : status === 'ready' ? '待审阅' : '查看处理状态';
  return <section className="assistant-task-card" aria-label="提炼任务结果"><div className="assistant-task-card__heading"><strong>{action.candidateCount === undefined ? '知识候选' : `${action.candidateCount} 条知识候选`}</strong><span>{label}</span></div>
    {action.materialTitle && <p>{action.materialTitle}</p>}{action.sourceRange && <p>本次提炼范围：{action.sourceRange.label}</p>}
    <div className="assistant-task-card__footer"><small>{status === 'empty' ? '本轮未发现适合保存的知识，可查看导读。' : action.status === 'unavailable' ? '打开后可重新核验' : action.discardedCount && !action.committedCount ? `已放弃 ${action.discardedCount} 条` : action.committedCount ? `已入库 ${action.committedCount} 条` : '候选经你确认后入库'}</small><Link className="assistant-review" to={`/extractions/${encodeURIComponent(action.runId)}`}><Check /><span>{action.label}</span><ArrowRight /></Link></div>
  </section>;
}

function SourceLink({ source, children }: { source: AssistantSource; children: React.ReactNode }) {
  const attachmentId = source.attachmentId ?? (source.path.startsWith('attachment:') ? source.path.slice(11) : undefined);
  return attachmentId ? <a href={attachmentContentHref(attachmentId)} download={source.title} aria-label={`${source.id} ${source.title}`}>{children}</a> : <Link title={source.path} aria-label={`${source.id} ${source.title}`} to={assistantSourceHref(source.path)}>{children}</Link>;
}
function ArchiveCard({ action }: { action: AssistantArchiveAction }) {
  return <section className="assistant-task-card" aria-label="文件归档结果"><div className="assistant-task-card__heading"><strong>{action.materialTitle}</strong><span>{action.duplicate ? '已在档案库' : '已归档'}</span></div><p>{action.indexed === false ? '原件已保存，索引待更新。' : '资料已保存到档案库。'}</p><div className="assistant-task-card__footer"><a href={attachmentContentHref(action.attachmentId)} download={action.materialTitle}>下载原件</a><Link className="assistant-review" to={assistantSourceHref(action.materialPath)}><Check /><span>查看归档资料</span><ArrowRight /></Link></div></section>;
}

export function AssistantMessageView({ message, onFollowUp }: { message: AssistantMessage; onFollowUp: (text: string) => void }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => setCopied(false), [message.text]);
  const [selection, setSelection] = useState('');
  const sources = new Map(message.sources.map(source => [source.id, source]));
  async function copy() {
    try { await navigator.clipboard.writeText(message.text); setCopied(true); setCopyError(false); }
    catch { setCopyError(true); }
  }
  return <article className={`assistant-message assistant-message--${message.role}`} aria-label={message.role === 'user' ? '你的消息' : '问问的回答'} onMouseUp={event => { if ((event.target as Element).closest('.assistant-answer-tools')) return; const selected = window.getSelection(); setSelection(selected && event.currentTarget.contains(selected.anchorNode) && event.currentTarget.contains(selected.focusNode) ? selected.toString().trim().slice(0, 6000) : ''); }}>
    {message.role === 'assistant' && <div className="assistant-message__byline"><span className="assistant-eyes" aria-hidden="true"><i /><i /></span><span>问问</span>{message.model && <small title={message.model}>{message.model}</small>}</div>}
    {message.role === 'user' && message.scope && <div className="assistant-message__context"><FileText size={12} />{message.scope === 'current' ? message.contextPath ? `本轮检索：仅《${message.contextTitle || assistantPathTitle(message.contextPath)}》${message.attachments?.length ? '和已选文件' : ''}` : '本轮检索：仅已选文件' : '本轮检索：整个大脑'}</div>}
    {message.attachments?.length ? <div className="assistant-message__attachments">{message.attachments.map(file => <a key={file.id} href={attachmentContentHref(file.id)} download={file.name}><FileText size={12} />{file.name}{file.startPage || file.endPage ? ` · 第 ${file.startPage ?? 1}–${file.endPage ?? file.pageCount} 页` : ''}</a>)}</div> : null}
    {message.text && <SafeMarkdown renderCitation={id => { const source = sources.get(id); return source ? <Citation source={source} /> : undefined; }}>{message.text}</SafeMarkdown>}
    {message.sources.length > 0 && <details className="assistant-sources"><summary>相关资料 · {message.sources.length}</summary><div>{message.sources.map(source => <SourceLink key={source.id} source={source}><span>{source.id}</span><FileText /><span>{source.title}</span><small>{source.kind === 'read' ? '已读取' : source.kind === 'search' ? '检索结果' : '历史引用'}</small></SourceLink>)}</div></details>}
    {message.actions.map(action => action.type === 'archive' ? <ArchiveCard key={action.id} action={action} /> : <ReviewCard key={action.id} action={action} />)}
    {message.role === 'assistant' && message.text && <div className="assistant-answer-tools"><button type="button" className="assistant-icon-button" aria-label={copied ? '已复制回答' : '复制回答'} title={copied ? '已复制' : '复制回答'} onClick={() => void copy()}>{copied ? <Check /> : <Copy />}</button><button type="button" className="assistant-text-button" onMouseDown={event => event.preventDefault()} onClick={() => onFollowUp(selection ? `请进一步解释这段内容：\n\n“${selection}”` : '请举一个具体例子，说明这个观点怎么用。')}><MessageCircle />{selection ? '追问选中段落' : '继续追问'}</button>{copyError && <span role="status">复制失败，可选中文字复制。</span>}</div>}
  </article>;
}
