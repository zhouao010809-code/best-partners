import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useConsoleRuntime } from '../../../app/ConsoleRuntime.js';
import { SafeMarkdown } from '../../../components/SafeMarkdown.js';
import type { CandidateDraft, CandidateTarget, IngestionFile, IngestionMatches, ReviewCandidate } from '../../../../shared/api/ingestion.js';
import { knowledgeContentSchema } from '../../../../shared/api/knowledge-content.js';

const knowledgeTypes: CandidateDraft['knowledgeType'][] = ['概念', '原理', '模型', '方法', 'SOP', '标准', '案例', '数据', '观点', '素材'];
const lines = (text: string) => text.split('\n');
export function incompleteFields(candidate: ReviewCandidate): string[] {
  if (candidate.target.mode === 'reference') return candidate.target.path ? [] : ['已有知识目标'];
  const fields: string[] = [];
  if (!candidate.draft.title.trim()) fields.push('知识标题');
  if (!candidate.draft.coreContent.trim()) fields.push('核心正文');
  if (!candidate.draft.value.trim()) fields.push('复用价值');
  if (!candidate.draft.suggestedPath.startsWith('02知识库/')) fields.push('存放目录');
  const labels: Record<string, string> = { keywords: '关键词 3–6 个', scenarios: '适用场景 2–3 条', conclusion: '核心结论', keyPoints: '关键要点 2–4 条', boundary: '使用边界', quotes: '原文摘录', summaries: '可复用表达 1–3 条' };
  const result = knowledgeContentSchema.safeParse(candidate.draft.draft);
  if (!result.success) for (const issue of result.error.issues) fields.push(labels[String(issue.path[0])] ?? '召回字段');
  if (candidate.target.mode !== 'new' && !candidate.target.path) fields.push('已有知识目标');
  return [...new Set(fields)];
}

export function CandidateReading({ value }: { value: CandidateDraft }) {
  return <div className="ingestion-reading">
    <div className="ingestion-reading-meta"><span>{value.knowledgeType}</span><span>{value.suggestedPath.replace(/^02知识库\//u, '') || '尚未选择目录'}</span></div>
    <SafeMarkdown>{value.coreContent || '核心正文待补充。'}</SafeMarkdown>
    <div className="ingestion-reading-value"><strong>复用价值</strong><p>{value.value || '待补充'}</p></div>
    <p className="ingestion-reading-evidence" role="status">原文依据：{value.draft.quotes.length ? `已找到 ${value.draft.quotes.length} 条逐字摘录` : '暂无直接摘录，请打开原文依据核对。'}</p>
    <details className="ingestion-disclosure"><summary>查看召回信息与原文摘录</summary>
      <dl className="ingestion-reading-facts">{value.topics.length > 0 && <div><dt>所属主题</dt><dd>{value.topics.join('、')}</dd></div>}<div><dt>关键词</dt><dd>{value.draft.keywords.join('、') || '待补充'}</dd></div><div><dt>适用场景</dt><dd>{value.draft.scenarios.join('；') || '待补充'}</dd></div><div><dt>核心结论</dt><dd>{value.draft.conclusion || '待补充'}</dd></div><div><dt>关键要点</dt><dd>{value.draft.keyPoints.join('；') || '待补充'}</dd></div><div><dt>使用边界</dt><dd>{value.draft.boundary || '待补充'}</dd></div><div><dt>原文摘录</dt><dd>{value.draft.quotes.join('\n') || '未摘录'}</dd></div><div><dt>可复用表达</dt><dd>{value.draft.summaries.join('；') || '待补充'}</dd></div></dl>
    </details>
  </div>;
}

export function ReviewFields({ value, directories, disabled, onChange }: {
  value: CandidateDraft; directories: string[]; disabled: boolean; onChange: (draft: CandidateDraft) => void;
}) {
  const metadata = value.draft;
  const set = <K extends keyof CandidateDraft>(key: K, next: CandidateDraft[K]) => onChange({ ...value, [key]: next });
  const setMeta = <K extends keyof CandidateDraft['draft']>(key: K, next: CandidateDraft['draft'][K]) => set('draft', { ...metadata, [key]: next });
  return <fieldset className="ingestion-fields" disabled={disabled}>
    <label className="ingestion-field">知识标题<input data-review-field="知识标题" maxLength={300} value={value.title} onChange={(event) => set('title', event.target.value)} /></label>
    <label className="ingestion-field ingestion-field--body">核心正文<textarea data-review-field="核心正文" rows={8} maxLength={20_000} value={value.coreContent} onChange={(event) => set('coreContent', event.target.value)} /></label>
    <details className="ingestion-disclosure"><summary>预读正文</summary><SafeMarkdown>{value.coreContent}</SafeMarkdown></details>
    <label className="ingestion-field">复用价值<textarea data-review-field="复用价值" rows={2} maxLength={3000} value={value.value} onChange={(event) => set('value', event.target.value)} /></label>
    <div className="ingestion-field-row">
      <label className="ingestion-field">知识类型<select value={value.knowledgeType} onChange={(event) => set('knowledgeType', event.target.value as CandidateDraft['knowledgeType'])}>{knowledgeTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
      <label className="ingestion-field ingestion-field--wide">存放目录<select data-review-field="存放目录" value={value.suggestedPath} onChange={(event) => set('suggestedPath', event.target.value)}>{!directories.includes(value.suggestedPath) && <option value={value.suggestedPath}>{value.suggestedPath || '请选择现有目录'}</option>}{directories.map((path) => <option key={path}>{path}</option>)}</select></label>
    </div>
    <label className="ingestion-field">所属主题（每行一个已有主题路径，可留空）<textarea rows={2} value={value.topics.join('\n')} onChange={(event) => set('topics', event.target.value === '' ? [] : lines(event.target.value))} /></label>
    <details className="ingestion-disclosure"><summary>召回字段与可复用表达</summary><div className="ingestion-metadata">
      <label className="ingestion-field">关键词（3–6 个，每行一个）<textarea data-review-field="关键词 3–6 个" rows={3} value={metadata.keywords.join('\n')} onChange={(event) => setMeta('keywords', lines(event.target.value))} /></label>
      <label className="ingestion-field">适用场景（2–3 条，每行一条）<textarea data-review-field="适用场景 2–3 条" rows={3} value={metadata.scenarios.join('\n')} onChange={(event) => setMeta('scenarios', lines(event.target.value))} /></label>
      <label className="ingestion-field">核心结论<textarea data-review-field="核心结论" rows={3} maxLength={600} value={metadata.conclusion} onChange={(event) => setMeta('conclusion', event.target.value)} /></label>
      <label className="ingestion-field">关键要点（2–4 条，每行一条）<textarea data-review-field="关键要点 2–4 条" rows={4} value={metadata.keyPoints.join('\n')} onChange={(event) => setMeta('keyPoints', lines(event.target.value))} /></label>
      <label className="ingestion-field">使用边界<textarea data-review-field="使用边界" rows={3} maxLength={600} value={metadata.boundary} onChange={(event) => setMeta('boundary', event.target.value)} /></label>
      <label className="ingestion-field">原文摘录（可留空，每行一条）<textarea data-review-field="原文摘录" rows={3} value={metadata.quotes.join('\n')} onChange={(event) => setMeta('quotes', event.target.value === '' ? [] : lines(event.target.value))} /></label>
      <label className="ingestion-field">可复用表达（1–3 条，每行一条）<textarea data-review-field="可复用表达 1–3 条" rows={3} value={metadata.summaries.join('\n')} onChange={(event) => setMeta('summaries', lines(event.target.value))} /></label>
    </div></details>
  </fieldset>;
}

export function MatchPicker({ runId, candidate, disabled, onChange }: { runId: string; candidate: ReviewCandidate; disabled: boolean; onChange: (target: CandidateTarget) => void }) {
  const { api } = useConsoleRuntime();
  const [search, setSearch] = useState(''); const [revision, setRevision] = useState(0);
  const [items, setItems] = useState<IngestionMatches['items']>(); const [error, setError] = useState('');
  const [detail, setDetail] = useState<{ path: string; markdown: string }>(); const [reading, setReading] = useState(false);
  const epoch = useRef(0); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current += 1; }; }, []);
  useEffect(() => {
    const controller = new AbortController(); setItems(undefined); setError('');
    const timer = setTimeout(() => {
      void api.ingestion?.matches(runId, candidate.id, search || undefined, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        if (result.ok) setItems(result.value.items);
        else if ('state' in result) setError(result.state.message ?? '查重暂不可用，不能据此判断没有重复。');
      }).catch(() => { if (!controller.signal.aborted) setError('查重暂不可用，不能据此判断没有重复。'); });
    }, search ? 250 : 0);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api.ingestion, runId, candidate.id, candidate.version, search, revision]);
  async function read(path: string) {
    const request = ++epoch.current; setReading(true); setDetail(undefined);
    try { const result = await api.getKnowledgeDetail(path); if (!mounted.current || request !== epoch.current) return;
      if (result.ok && result.value.path === path) setDetail({ path, markdown: result.value.markdown });
      else setError(result.ok ? '返回的知识与所选目标不匹配。' : 'state' in result ? result.state.message ?? '正文读取失败。' : '正文读取已取消。');
    } catch { if (mounted.current && request === epoch.current) setError('正文读取失败，请重试。'); }
    finally { if (mounted.current && request === epoch.current) setReading(false); }
  }
  return <details className="ingestion-disclosure"><summary>查重与存放方式</summary>
    <p className="extraction-muted">根据已有笔记的标题与召回字段查找；匹配结果供你判断。</p>
    <label className="ingestion-field">搜索已有知识<input data-review-field="已有知识目标" type="search" maxLength={200} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    <div className="ingestion-target"><button type="button" className="quiet-button" disabled={disabled} aria-pressed={candidate.target.mode === 'new'} onClick={() => onChange({ mode: 'new' })}>新建知识笔记</button><span>{candidate.target.mode === 'new' ? '当前：新建' : `当前：${candidate.target.mode === 'merge' ? '合并内容' : '只补充来源'} → ${candidate.target.path}`}</span></div>
    {candidate.target.mode === 'reference' && <p className="extraction-notice">只补充来源，不会把这条候选的新判断写入已有正文。</p>}
    {candidate.target.mode === 'merge' && <label className="ingestion-choice ingestion-legacy-confirm"><input type="checkbox" checked={candidate.target.confirmLegacySources ?? false} disabled={disabled} onChange={(event) => onChange({ ...candidate.target, confirmLegacySources: event.target.checked })} />我已核对旧笔记来源，并确认原有正文由已登记来源共同支撑</label>}
    {error && <p role="alert">{error}<button type="button" className="quiet-button" onClick={() => setRevision((value) => value + 1)}>重新查重</button></p>}
    {!items && !error && <p role="status">正在查找相关知识…</p>}
    {items?.length === 0 && <p className="extraction-muted">当前检索没有找到相关笔记；仍请核对标题和存放目录。</p>}
    <div className="ingestion-matches">{items?.map((item) => <section className="ingestion-match" key={item.path}>
      <div className="ingestion-row"><h4>{item.title}</h4><span className={`ingestion-badge${item.usageStatus === '过时' ? ' ingestion-badge--warning' : ''}`}>{item.usageStatus}</span></div>
      <p>{item.conclusion}</p><p className="extraction-muted">{item.reason}</p><p className="extraction-path">{item.path}</p>
      <div className="extraction-actions"><button type="button" className="quiet-button" disabled={reading} onClick={() => void read(item.path)}>查看正文：{item.title}</button>
        {item.usageStatus !== '定论' && item.usageStatus !== '过时' && <button type="button" className="quiet-button" disabled={disabled} onClick={() => onChange({ mode: 'merge', path: item.path })}>合并到 {item.title}</button>}
        {item.usageStatus !== '过时' && <button type="button" className="quiet-button" disabled={disabled} onClick={() => onChange({ mode: 'reference', path: item.path })}>只补充来源到 {item.title}</button>}
      </div>{item.usageStatus === '过时' && <p className="extraction-muted">此笔记已过时，不能作为本次写入目标。</p>}
      {item.usageStatus === '定论' && <p className="extraction-muted">定论仅允许补充来源。</p>}
    </section>)}</div>
    {reading && <p role="status">正在读取已有正文…</p>}
    {detail && <section className="ingestion-existing" aria-label="已有知识正文"><div className="ingestion-row"><h4>已有知识正文</h4><Link to={`/knowledge?path=${encodeURIComponent(detail.path)}`}>打开完整知识</Link></div><SafeMarkdown>{detail.markdown}</SafeMarkdown></section>}
  </details>;
}

export function FileChanges({ files }: { files: IngestionFile[] }) {
  return <div className="ingestion-changes">{files.map((file) => <section className="ingestion-file" key={file.path}>
    <div className="ingestion-row"><span className="ingestion-badge">{file.kind === 'source' ? '原资料回链与状态' : file.kind === 'new' ? '新建知识' : '更新知识'}</span><h4>{file.path}</h4></div>
    <div className={`ingestion-comparison${file.before === null ? ' ingestion-comparison--new' : ''}`}>
      {file.before !== null && <section><h5>修改前</h5><ReadableDocument markdown={file.before} /></section>}
      <section><h5>{file.before === null ? '将新建的完整内容' : '修改后'}</h5><ReadableDocument markdown={file.after} /></section>
    </div>
    <details className="ingestion-disclosure"><summary>查看完整 Markdown 与 YAML</summary><div className="ingestion-comparison">{file.before !== null && <pre aria-label={`修改前 Markdown：${file.path}`}>{file.before}</pre>}<pre aria-label={`修改后 Markdown：${file.path}`}>{file.after}</pre></div></details>
    {file.preserved !== undefined && <details className="ingestion-disclosure"><summary>竞争时保留的外部修改版本</summary><ReadableDocument markdown={file.preserved} /></details>}
  </section>)}</div>;
}

export function ReadableDocument({ markdown }: { markdown: string }) {
  const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown);
  return <>{frontmatter && <div className="ingestion-document-properties"><p className="extraction-muted">笔记属性</p><pre>{frontmatter[1]}</pre></div>}<SafeMarkdown>{frontmatter ? markdown.slice(frontmatter[0].length) : markdown}</SafeMarkdown></>;
}
