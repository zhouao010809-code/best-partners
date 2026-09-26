import { useCreationInput } from './useCreationInput.js';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, Send, Square, Check } from 'lucide-react';
import type { AssistantProvider } from '../../../shared/api/assistant.js';
import type { CreationExchange, CreationGenerateRequest, CreationSuggestion, ProjectCreation } from '../../../shared/api/project-creations.js';
import type { ReadConsoleApi } from '../../api/client.js';
import { SafeMarkdown } from '../SafeMarkdown.js';
import { CreationSources } from './CreationSources.js';
import { creationError, draftFingerprint } from './useCreationDraft.js';

type Props = {
  api: ReadConsoleApi; projectId: string; draft: ProjectCreation; messages: CreationExchange[];
  persistedDraft: ProjectCreation;
  selection?: { text: string; start: number; end: number } | undefined;
  locked?: boolean;
  flush(): Promise<ProjectCreation | undefined>;
  onAdopt(body: string, suggestion: CreationSuggestion): boolean;
};
export function CreationAssistant({ api, projectId, draft, persistedDraft, messages, selection, flush, onAdopt, locked = false }: Props) {
  const [provider, setProvider] = useState<AssistantProvider>();
  const [providerError, setProviderError] = useState('');
  const [model, setModel] = useState('');
  const [instruction, setInstruction] = useCreationInput(`creation-input-v1:${projectId}:${draft.id}`);
  const [task, setTask] = useState<'revise' | 'discuss'>('revise');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{ suggestion: CreationSuggestion; fingerprint: string }>();
  const [history, setHistory] = useState<CreationExchange[]>(messages);
  const [dismissed, setDismissed] = useState('');
  const controller = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const restored = useRef(false);
  async function refreshProvider() {
    if (!api.assistant) { setProviderError('当前连接不提供问问。'); return; }
    try {
      const result = await api.assistant.providers();
      if (!mounted.current) return;
      if (!result.ok) { setProviderError(creationError(result)); return; }
      const entry = result.value.providers.find(item => item.id === 'deepseek');
      setProvider(entry); setProviderError(entry ? '' : '请先配置 DeepSeek，再让问问协助创作。');
      setModel(current => current || entry?.defaultModel || entry?.models[0]?.id || '');
    } catch { if (mounted.current) setProviderError('模型配置暂时无法读取，请刷新。'); }
  }
  useEffect(() => { mounted.current = true; void refreshProvider(); return () => { mounted.current = false; controller.current?.abort(); }; }, [api]);
  useEffect(() => {
    setHistory(previous => [...new Map([...previous, ...messages].map(message => [message.suggestion.id, message])).values()].slice(-100));
    if (!restored.current && messages.length) {
      restored.current = true;
      const last = messages.at(-1)!.suggestion;
      if (last.baseRevision === draft.revision && draftFingerprint(draft) === draftFingerprint(persistedDraft)
        && (last.body !== undefined || last.replacement)) setPending({ suggestion: last, fingerprint: draftFingerprint(persistedDraft) });
    }
  }, [messages]);
  async function generate(selectedTask: CreationGenerateRequest['task'], text: string, range?: Props['selection']) {
    if (busy || locked || !api.creations) return;
    setBusy(true); setError(''); setDismissed(''); setPending(undefined);
    const active = new AbortController(); controller.current = active;
    try {
      const saved = await flush();
      if (!saved) { setError('请先保存当前编辑，再让问问继续。'); return; }
      if (active.signal.aborted) return;
      const result = await api.creations.suggest(projectId, { task: selectedTask, instruction: text, itemId: saved.id, expectedRevision: saved.revision,
        ...(model ? { model } : {}), ...(range ? { selection: range } : {}) }, active.signal);
      if (!mounted.current || active.signal.aborted) return;
      if (!result.ok) { setError(creationError(result)); return; }
      setPending({ suggestion: result.value, fingerprint: draftFingerprint(saved) });
      setHistory(previous => [...previous, { id: result.value.id, instruction: text, suggestion: result.value, createdAt: result.value.createdAt }].slice(-100));
      if (instruction.trim() === text) setInstruction(current => current.trim() === text ? '' : current);
    } catch { if (mounted.current && !active.signal.aborted) setError('问问本次没有完成，请重试；正文已保留。'); }
    finally { if (mounted.current && controller.current === active) setBusy(false); }
  }
  const ready = provider?.status === 'ready' && !!model;
  const stale = pending && (pending.fingerprint !== draftFingerprint(draft) || pending.suggestion.baseRevision !== draft.revision);
  const suggestion = pending?.suggestion;
  const canAdopt = suggestion && (suggestion.body !== undefined || suggestion.replacement !== undefined);
  function adopt() {
    if (!suggestion || stale || locked) return;
    const range = suggestion.replacement;
    if (range && draft.body.slice(range.start, range.end) !== range.before) { setError('这段正文已经变化，请重新生成建议。'); return; }
    const body = range ? draft.body.slice(0, range.start) + range.after + draft.body.slice(range.end) : suggestion.body;
    if (body === undefined || body.length > 60000) { setError('稿件超出长度限制，请缩小修改范围。'); return; }
    if (!onAdopt(body, suggestion)) return;
    setPending(undefined); setDismissed('已采用到正文，可在版本记录中保留这一稿。');
  }
  return <aside className="creation-assistant" aria-label="本条内容的问问">
    <header><Sparkles size={18} /><div><h3>问问</h3><small>围绕这条内容一起打磨</small></div></header>
    <div className="creation-model"><label>创作模型<select aria-label="创作模型" value={model} onChange={event => setModel(event.target.value)} disabled={busy}>{provider?.models.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label><button type="button" onClick={() => void refreshProvider()} disabled={busy}>刷新配置</button></div>
    {!ready && <p className="creation-notice" role="status">{provider?.problem || providerError || (provider ? '请先配置 DeepSeek，再让问问协助创作。' : '正在读取模型配置…')} <Link to="/settings">前往模型设置</Link></p>}
    <div className="creation-ai-tools">
      <button type="button" className="projects-button" disabled={busy || locked || !ready} onClick={() => void generate('script', '根据项目资料、选题和创作要求起草短视频脚本；事实不够时明确标注待补充。')}>根据资料起草</button>
      <button type="button" className="projects-button" disabled={busy || locked || !ready || !selection} onClick={() => void generate('revise', instruction.trim() || '优化选中的这段表达，让口播直接、自然，保持原意。', selection)}>修改选中段落</button>
    </div>
    <p className="creation-hint">选中正文可只改这一段；建议经你采用后进入正文。</p>
    <label className="creation-label">给问问的要求<textarea aria-label="给问问的要求" rows={3} maxLength={4000} value={instruction} onChange={event => setInstruction(event.target.value)} placeholder="例如：开头更直接，保留原有案例" /></label>
    <div className="creation-ai-submit"><select aria-label="处理方式" value={task} onChange={event => setTask(event.target.value as 'revise' | 'discuss')}><option value="revise">改脚本</option><option value="discuss">先讨论</option></select><button type="button" className="projects-button projects-button--primary" disabled={busy || locked || !ready || !instruction.trim()} onClick={() => void generate(task, instruction.trim())}><Send size={14} />发送给问问</button></div>
    {busy && <p role="status" className="creation-progress">正在读取资料、构思内容…<button type="button" onClick={() => { controller.current?.abort(); setBusy(false); setDismissed('已停止本次生成，正文未变。'); }}><Square size={12} />停止</button></p>}
    {error && <p className="creation-notice" role="alert">{error}</p>}
    {dismissed && <p role="status" className="creation-hint">{dismissed}</p>}
    {suggestion && <section className="creation-suggestion" aria-label="问问的修改建议"><SafeMarkdown>{suggestion.reply}</SafeMarkdown>
      {suggestion.replacement && <><small>原文</small><pre>{suggestion.replacement.before}</pre><small>建议替换为</small><pre>{suggestion.replacement.after}</pre></>}
      {suggestion.body !== undefined && <pre>{suggestion.body}</pre>}
      <CreationSources sources={suggestion.sources} api={api} />
      {stale && canAdopt && <p role="status" className="creation-notice">正文或版本已变化，请重新生成建议，以保留你的最新修改。</p>}
      {canAdopt && <div className="creation-actions"><button type="button" className="projects-button projects-button--primary" disabled={!!stale || locked} onClick={adopt}><Check size={14} />采用到正文</button><button type="button" className="projects-button" onClick={() => { setPending(undefined); setDismissed('已保留原文，建议留在讨论记录中。'); }}>保留原文</button></div>}
    </section>}
    {!!history.length && <details className="creation-history"><summary>本条讨论 · {history.length}</summary>{history.slice().reverse().map(message => <article key={message.id}><strong>{message.instruction}</strong><SafeMarkdown>{message.suggestion.reply}</SafeMarkdown>{(message.suggestion.body || message.suggestion.replacement) && <details><summary>查看当时建议</summary><pre>{message.suggestion.body ?? message.suggestion.replacement?.after}</pre></details>}<CreationSources sources={message.suggestion.sources} api={api} /></article>)}</details>}
  </aside>;
}
