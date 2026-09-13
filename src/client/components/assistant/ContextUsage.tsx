import type { AssistantConversation, AssistantModel } from '../../../shared/api/assistant.js';
import '../../styles/assistant-context.css';

const number = (value: number | undefined) => value === undefined ? '未知' : new Intl.NumberFormat('zh-CN').format(value);
export function ContextUsage({ conversation, model, draftChanged = false, attachmentCount = 0, disabled = false, onContinue }: { conversation?: AssistantConversation | undefined; model?: AssistantModel | undefined; draftChanged?: boolean; attachmentCount?: number; disabled?: boolean; onContinue: () => void }) {
  const latest = conversation?.messages.filter(item => item.role === 'assistant').at(-1);
  const receipt = latest?.usage?.latest;
  // Capacity belongs to the request being measured, not a newly selected model.
  const capacity = latest ? latest.context?.capacity : model?.capacity;
  const input = receipt?.inputTokens;
  const output = receipt?.outputTokens;
  const occupied = input === undefined ? undefined : input + (output ?? 0);
  const lowerBound = input !== undefined && output === undefined;
  const ratio = occupied !== undefined && capacity ? occupied / capacity.contextWindowTokens : undefined;
  const percentage = ratio === undefined ? undefined : Math.round(ratio * 1000) / 10;
  const percentLabel = `${lowerBound ? '≥' : ''}${percentage}%`;
  const history = latest?.context?.history;
  const display = percentage === undefined ? input === undefined ? '尚无用量回执' : `${lowerBound ? '至少 ' : ''}${number(occupied)} tokens · 容量未知` : percentLabel;
  return <details className="assistant-context-usage"><summary aria-label={`上下文用量：${display}`}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" className="assistant-context-usage__track" />{ratio !== undefined && <circle cx="12" cy="12" r="9" className="assistant-context-usage__fill" strokeDasharray={`${Math.min(1, ratio) * 56.55} 56.55`} />}</svg><span>上下文<span>{percentage === undefined ? input === undefined ? '待统计' : '容量未知' : percentLabel}</span></span></summary>
    <div className="assistant-context-usage__detail"><strong>{receipt ? '上一步实际占用' : '上下文清单'}</strong>{receipt && <p>按这一步的输入加已输出 token 计算，包含已生成的内容。</p>}{lowerBound && <p>输出回执缺失，目前只确认输入占用；比例是已知下界。</p>}{draftChanged && <p>输入有变化；圆环保留上一请求回执，不代表下一次发送的占用。下一轮尚未统计，发送前会重新检查预算。</p>}
      <dl><div><dt>所用模型</dt><dd>{latest?.model ?? model?.name ?? conversation?.model ?? '未选择'}</dd></div>{receipt?.measuredAt && <div><dt>回执时间</dt><dd>{new Date(receipt.measuredAt).toLocaleTimeString('zh-CN')}</dd></div>}<div><dt>实际输入</dt><dd>{number(input)} tokens</dd></div><div><dt>模型容量</dt><dd>{capacity ? `${number(capacity.contextWindowTokens)} tokens` : '容量未知'}</dd></div>{receipt?.outputTokens !== undefined && <div><dt>本次已输出</dt><dd>{number(receipt.outputTokens)} tokens</dd></div>}{latest?.context && <><div><dt>输出预留</dt><dd>{number(latest.context.outputReserveTokens)} tokens</dd></div><div><dt>发送前保守估算</dt><dd>{number(latest.context.estimate.inputTokens)} tokens</dd></div></>}
      <div><dt>本对话文件</dt><dd>{attachmentCount} 份</dd></div>{history && <><div><dt>本次带入的历史</dt><dd>{history.selectedMessages} / {history.availableMessages} 条</dd></div><div><dt>较早未带入消息</dt><dd>{history.omittedMessages} 条</dd></div><div><dt>对话消息额度</dt><dd>{history.conversationMessages} / {history.conversationMessageLimit} 条 · 剩余 {history.remainingMessages} 条</dd></div></>}</dl>
      {Boolean(latest?.sources?.length) && <div className="assistant-context-usage__sources"><strong>本轮资料记录</strong><ul>{latest!.sources.map(source => <li key={source.id}>{source.title}<small>{source.kind === 'read' ? '实际读取' : source.kind === 'search' ? '检索线索' : '历史引用'}{source.evidence?.some(item => item.page) ? ` · 原件第 ${[...new Set(source.evidence.map(item => item.page).filter(Boolean))].join('、')} 页` : ''}</small></li>)}</ul></div>}
      {latest?.usage?.total.totalTokens !== undefined && <p>本轮多个步骤累计消耗 {number(latest.usage.total.totalTokens)} tokens，与圆环的单次上下文占用不同。</p>}
      {!receipt && <p>模型返回真实用量后显示占用比例；没有回执时不按零计算。</p>}{latest?.usage?.status === 'partial' && <p>本轮回执不完整；仅显示已经收到的用量。</p>}
      {history && history.omittedMessages > 0 && <p>较早消息仍保留在历史里，本次最多带入最近 {history.messageLimit} 条。需要延续较早结论时，可以带摘要继续。</p>}
      {capacity && <a href={capacity.sourceUrl} target="_blank" rel="noopener noreferrer">容量来源 · 核验于 {capacity.verifiedAt.slice(0, 10)}</a>}
      {Boolean(conversation?.messages.length) && <button type="button" disabled={disabled} onClick={onContinue}>带摘要继续</button>}
    </div>
  </details>;
}
