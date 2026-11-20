import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, FileText, Sparkles } from 'lucide-react';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import { SafeMarkdown } from '../components/SafeMarkdown.js';
import type { DeepSeekSettings, ExtractionPreview, ExtractionRun } from '../../shared/api/extraction.js';
import { CandidateReview } from './queue/CandidateReview.js';
import '../styles/ai-glow.css';

export function extractionHref(materialPath: string, readingState?: '未看' | '已看'): string {
  const query = new URLSearchParams({ materialPath });
  if (readingState) query.set('readingState', readingState);
  return `/extractions/new?${query}`;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

export function ExtractionPage() {
  const { id = 'new' } = useParams();
  const [query] = useSearchParams();
  const materialPath = query.get('materialPath') ?? '';
  const initialReadingState = query.get('readingState') === '已看' ? '已看' : '未看';
  return <ExtractionWorkbench key={`${id}:${materialPath}:${initialReadingState}`} id={id} materialPath={materialPath} initialReadingState={initialReadingState} />;
}

interface ExtractionWorkbenchProps {
  id: string;
  materialPath: string;
  embedded?: boolean;
  onRun?: (run: ExtractionRun) => void;
  onRetry?: (readingState: '未看' | '已看') => void;
  currentSourceSha?: string;
  onChanged?: () => void;
  onReviewBusy?: (busy: boolean, durableDraft?: boolean) => void;
  onNextMaterial?: () => void;
  initialReadingState?: '未看' | '已看';
}

export function ExtractionWorkbench(props: ExtractionWorkbenchProps) {
  return <ExtractionWorkbenchContent key={`${props.id}:${props.materialPath}`} {...props} />;
}

function ExtractionWorkbenchContent({ id, materialPath, embedded = false, onRun, onRetry, currentSourceSha, onChanged, onReviewBusy, onNextMaterial, initialReadingState = '未看' }: ExtractionWorkbenchProps) {
  const { api, dataRevision = 0 } = useConsoleRuntime();
  const service = api.extraction;
  const navigate = useNavigate();
  const [settings, setSettings] = useState<DeepSeekSettings>();
  const [readingState, setReadingState] = useState<'未看' | '已看'>(initialReadingState);
  const [preview, setPreview] = useState<ExtractionPreview>();
  const [run, setRun] = useState<ExtractionRun>();
  const [startedRunId, setStartedRunId] = useState<string>();
  const [history, setHistory] = useState<ExtractionRun[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidence, setEvidence] = useState<{ markdown: string; sha: string }>();
  const [evidenceError, setEvidenceError] = useState('');
  const [evidenceRevision, setEvidenceRevision] = useState(0);
  const evidenceReturn = useRef<HTMLElement | null>(null);
  const evidenceClose = useRef<HTMLButtonElement>(null);
  const [revision, setRevision] = useState(0);
  const [continuationRevision, setContinuationRevision] = useState(0);
  const [continuation, setContinuation] = useState<{ key: string; allowed: boolean; error?: string }>();
  const lifetime = useRef<AbortController | undefined>(undefined);
  const pending = useRef(false);
  const runEpoch = useRef(0);
  const lastNotified = useRef<string | undefined>(undefined);
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const selectedRunId = id === 'new' ? startedRunId : id;
  const evidencePath = run?.materialPath || materialPath;
  const partialRange = Boolean(run?.sourceRange && run.sourceRange.coversWholeSource !== true);
  const continuationKey = JSON.stringify([run?.id, dataRevision, continuationRevision]);
  useEffect(() => {
    if (embedded || !partialRange || run?.status !== 'ready' || !api.extractionQueue) return;
    const controller = new AbortController(); const path = run.materialPath;
    void api.extractionQueue.get(path, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (!result.ok) { setContinuation({ key: continuationKey, allowed: false, error: '后续提炼状态暂时无法读取。' }); return; }
      const item = result.value.item;
      setContinuation({ key: continuationKey, allowed: Boolean(item?.materialPath === path && item.canExtract && !item.activeRun && !item.removedAt && !item.pendingCandidateCount) });
    }).catch(() => { if (!controller.signal.aborted) setContinuation({ key: continuationKey, allowed: false, error: '后续提炼状态暂时无法读取。' }); });
    return () => controller.abort();
  }, [api.extractionQueue, embedded, partialRange, run?.id, run?.materialPath, run?.status, continuationKey]);
  function reviewChanged() {
    if (!embedded && partialRange) setContinuationRevision(value => value + 1);
    onChanged?.();
  }
  useEffect(() => {
    if (!evidenceOpen || embedded || !evidencePath) return;
    const controller = new AbortController(); setEvidence(undefined); setEvidenceError('');
    evidenceClose.current?.focus({ preventScroll: true });
    void api.getDocumentDetail(evidencePath, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.ok && result.value.path === evidencePath) setEvidence({ markdown: result.value.markdown, sha: result.value.versionMarker.rawSha256 });
      else setEvidenceError('原文依据暂时无法读取，请重试。');
    }).catch(() => { if (!controller.signal.aborted) setEvidenceError('原文依据暂时无法读取，请重试。'); });
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); setEvidenceOpen(false); evidenceReturn.current?.focus({ preventScroll: true }); } };
    window.addEventListener('keydown', escape);
    return () => { controller.abort(); window.removeEventListener('keydown', escape); };
  }, [api.getDocumentDetail, embedded, evidenceOpen, evidencePath, evidenceRevision]);

  function receiveRun(value: ExtractionRun): void {
    setRun(value);
    const state = `${value.id}:${value.status}`;
    if (lastNotified.current !== state) {
      lastNotified.current = state;
      onRunRef.current?.(value);
    }
  }

  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function loadRun() {
      if (!service || selectedRunId === undefined) return;
      const epoch = runEpoch.current;
      const result = await service.get(selectedRunId, controller.signal);
      if (controller.signal.aborted || epoch !== runEpoch.current) return;
      setLoaded(true);
      if (!result.ok) { if ('state' in result) setError(result.state.message ?? '提炼状态暂时不可用，请重试。'); return; }
      if (result.value.id !== selectedRunId || (embedded && result.value.materialPath !== materialPath)) {
        setRun(undefined); setError('提炼记录与当前选择不匹配，请重新读取状态。'); return;
      }
      receiveRun(result.value); setError('');
      if (result.value.status === 'generating') timer = setTimeout(() => void loadRun(), 1500);
    }
    async function loadSetup() {
      if (!service || !api.deepSeek) return;
      const [config, previous] = await Promise.all([api.deepSeek.get(controller.signal), embedded ? undefined : service.list(materialPath, controller.signal)]);
      if (controller.signal.aborted) return;
      setLoaded(true);
      if (!config.ok) { if ('state' in config) setError(config.state.message ?? '模型设置暂时不可用，请重试。'); return; }
      if (previous && !previous.ok) { if ('state' in previous) setError(previous.state.message ?? '提炼记录暂时不可用，请重试。'); return; }
      setSettings(config.value); setHistory(previous?.value.items ?? []); setError('');
    }
    if (selectedRunId !== undefined) void loadRun();
    else if (materialPath !== '') void loadSetup();
    else setLoaded(true);
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [selectedRunId, materialPath, embedded, service, api.deepSeek, revision]);

  async function act(kind: 'preview' | 'start' | 'cancel') {
    const signal = lifetime.current?.signal;
    if (!service || pending.current || signal?.aborted) return;
    if (kind === 'start' && !preview || kind === 'cancel' && !run) return;
    if (kind === 'cancel') runEpoch.current += 1;
    pending.current = true; setBusy(true); setError('');
    if (kind === 'start') setStarting(true);
    try {
      if (kind === 'preview') {
        setPreview(undefined);
        const result = await service.preview({ materialPath, readingState });
        if (signal?.aborted) return;
        if (result.ok) setPreview(result.value);
        else if ('state' in result) setError(result.state.message ?? '提炼预览未能生成，请重试。');
      } else {
        const result = kind === 'start' ? await service.start(preview!.token) : await service.cancel(run!.id);
        if (signal?.aborted) return;
        if (result.ok) {
          if ((embedded && result.value.materialPath !== materialPath) || (kind === 'cancel' && result.value.id !== run!.id)) {
            setRun(undefined); setError('提炼记录与当前选择不匹配，请重新读取状态。'); return;
          }
          if (kind === 'start' && !embedded) navigate(`/extractions/${result.value.id}`, { replace: true });
          else {
            if (kind === 'start') setStartedRunId(result.value.id);
            setPreview(undefined); receiveRun(result.value);
          }
        } else if ('state' in result) setError(result.state.message ?? '本次操作没有完成，请重试。');
      }
    } catch { if (!signal?.aborted) setError('本次操作没有完成，请重新读取状态后再试。'); }
    finally {
      if (kind === 'cancel') runEpoch.current += 1;
      pending.current = false;
      if (!signal?.aborted) {
        setBusy(false);
        setStarting(false);
        if (kind === 'cancel') setRevision((v) => v + 1);
      }
    }
  }

  const runRecord = run && (
        <section className={`instrument-panel extraction-panel${run.status === 'ready' && api.ingestion ? ' extraction-panel--review-record' : ''}`}>
          <details open={run.status !== 'ready' || !api.ingestion} className="extraction-result-record"><summary>提炼记录 · {run.status === 'ready' ? '候选已保存' : run.status === 'generating' ? '正在提炼' : '本次已结束'}</summary>
          {!embedded && <><header className="panel-heading"><div><p>EXTRACTION / {run.status.toUpperCase()}</p><h2>{run.title}</h2></div><Sparkles aria-hidden="true" /></header>
          <p className="extraction-path">{run.materialPath}</p></>}
          <p>阅读状态判断：{run.readingState}{run.readingState === '未看' ? '（不确定时按未看处理）' : ''}</p>
          <p className="extraction-muted">{new Date(run.createdAt).toLocaleString('zh-CN')} · {run.model} · 原文版本 {run.sourceRawSha256.slice(0, 12)}</p>
          {!api.ingestion && currentSourceSha !== undefined && currentSourceSha !== run.sourceRawSha256 && <p className="extraction-notice" role="status">资料已变化：以下提炼记录来自旧版资料。</p>}
          {run.status === 'generating' && <><p role="status">DeepSeek 正在提炼…可以离开此页，稍后回来查看。</p><p className="extraction-muted">停止请求不保证免除已经产生的 API 费用。关闭 App 会中断本次提炼，不会自动重试。</p><button type="button" className="quiet-button" disabled={busy} onClick={() => void act('cancel')}>停止本次提炼</button></>}
          {(run.status === 'failed' || run.status === 'cancelled') && <><p role="status">{run.problem ?? '本次提炼已停止，原文未修改。'}</p>{/密钥|模型设置|安全保存/u.test(run.problem ?? '') && !embedded
            ? <div className="extraction-actions"><Link className="quiet-button" to="/settings">去设置更新密钥</Link><Link className="quiet-button" to={extractionHref(run.materialPath, run.readingState)}>重新预览后再试</Link></div>
            : embedded
              ? <button className="quiet-button" type="button" disabled={onRetry === undefined} onClick={() => onRetry?.(run.readingState)}>重新预览后再试</button>
              : <Link className="quiet-button" to={extractionHref(run.materialPath, run.readingState)}>重新预览后再试</Link>}</>}
          {run.status === 'ready' && <p className="extraction-notice" role="status">{api.ingestion ? '提炼结果已保存在本机。请审阅候选；正式入库状态见下方回执。' : '候选已保存在本机，尚未入库。以下为 AI 候选，请核对；原文及正式知识库没有被修改。'}</p>}
          </details>
        </section>
  );
  const runBriefing = run?.result && ((run.readingState === '未看' || run.result.candidates.length === 0) && <details open={!api.ingestion} className="extraction-briefing"><summary>资料导读</summary><section className="instrument-panel extraction-panel" aria-label="资料导读"><h2>这份资料讲了什么</h2>{run.result.briefing.sentences.map((sentence, index) => <p key={index}>{sentence}</p>)}<h3>主要知识点</h3><ul>{run.result.briefing.keyPoints.map((point, index) => <li key={index}>{point}</li>)}</ul><h3>对你有什么用</h3><p>{run.result.briefing.usefulness}</p>{run.result.briefing.caution && <><h3>判断提醒</h3><p>{run.result.briefing.caution}</p></>}</section></details>);

  if (!service || !api.deepSeek) return <section className="instrument-panel extraction-panel"><h2>当前版本暂不支持提炼</h2><p>请打开最新版桌面 App。原文和知识库没有被修改。</p></section>;
  return (
    <div className={`extraction-workbench${embedded ? ' extraction-workbench--embedded' : ''}${!embedded && evidenceOpen ? ' extraction-workbench--evidence' : ''}`} data-ai-active={starting || run?.status === 'generating' || undefined}>
      <div className="extraction-workbench-main">
      {!embedded && <div className="extraction-actions"><Link className="quiet-button" to="/queue"><ArrowLeft aria-hidden="true" />返回提炼队列</Link>{run && <button type="button" className="quiet-button" aria-expanded={evidenceOpen} onPointerDown={() => { evidenceReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }} onClick={event => { if (event.detail === 0 || !evidenceReturn.current || evidenceReturn.current === document.body) evidenceReturn.current = event.currentTarget; setEvidenceOpen(!evidenceOpen); }}>查看依据</button>}<span className="extraction-muted">提炼生成草稿；核对并确认预览后才正式入库</span></div>}
      {error && <div className="extraction-notice" role="alert"><p>{error}</p><button className="quiet-button" type="button" disabled={busy} onClick={() => { setPreview(undefined); setRevision((v) => v + 1); }}>重新读取状态</button></div>}
      {!loaded && <p role="status">正在读取提炼状态…</p>}
      {selectedRunId === undefined && <section className="instrument-panel extraction-panel" aria-label="提炼准备">
        {!embedded && <><header className="panel-heading"><div><p>EXTRACT / PREPARE</p><h2>{preview?.title ?? (materialPath.split('/').at(-1)?.replace(/\.md$/u, '') || '先选择一份资料')}</h2></div><FileText aria-hidden="true" /></header>
        <p className="extraction-path">{materialPath}</p></>}
        {!embedded && history.length > 0 && <div className="extraction-history"><h3>这份资料已有提炼记录</h3>{history.map((item) => <Link key={item.id} to={`/extractions/${item.id}`}>
          {item.status === 'ready' ? '查看已保存候选' : item.status === 'generating' ? '查看正在进行的提炼' : '查看上次提炼记录'} · {new Date(item.createdAt).toLocaleString('zh-CN')}</Link>)}</div>}
        {loaded && settings && (!settings.available ? <p role="status">{settings.problem || '当前提炼服务不可用，请检查桌面 App 设置。'}</p> : !settings.configured ? <div className="extraction-actions"><p>先配置 DeepSeek 密钥。此时没有发送任何资料。</p><Link className="quiet-button extraction-primary" to="/settings">配置 DeepSeek</Link></div> : <>
          <fieldset className="extraction-reading" disabled={busy}><legend>这份资料你看过了吗？</legend>
            {(['未看', '已看'] as const).map((state) => <label key={state}><input type="radio" name="reading-state" checked={readingState === state} onChange={() => { setReadingState(state); setPreview(undefined); }} />{state === '未看' ? '未看过 / 不确定' : '已看过'}</label>)}
          </fieldset>
          <p className="extraction-muted">{readingState === '未看' ? '先帮你理解资料，再展示可复用的知识候选。' : '直接展示知识候选，供你审阅。'}</p>
          <p>下一步先在本机预览发送内容。只有确认发送后，才会将所选资料及提炼规则交给 DeepSeek，并可能产生 API 费用。</p>
          <button className="quiet-button extraction-primary" type="button" disabled={busy || materialPath === '' || error !== ''} onClick={() => void act('preview')}>{busy ? '正在准备…' : '预览发送内容'}</button>
        </>)}
      </section>}
      {preview && <section className="instrument-panel extraction-panel" aria-label="发送前确认">
        <header className="panel-heading"><div><p>REVIEW / SEND</p><h2>确认发送给 DeepSeek 的内容</h2></div><Sparkles aria-hidden="true" /></header>
        <p>{preview.providerHost} · {preview.model}</p>
        <p className="extraction-muted">以下为完整发送文本，包含所选原文、提炼规则和目录信息。不发送其他笔记正文，不下载图片。请先检查是否含有不想外传的信息。</p>
        <p className="extraction-notice" role="status">本次发送内容约 {formatBytes(new TextEncoder().encode(JSON.stringify(preview.messages)).byteLength)}，上限 500 KB。超出上限时不会发送。</p>
        {preview.messages.map((message, index) => <details className="extraction-message" key={index} open={!embedded && message.role === 'user'}><summary>{message.role === 'system' ? '提炼规则与输出要求' : '资料与目录上下文'}</summary><pre>{message.content}</pre></details>)}
        <div className="extraction-actions"><button className="quiet-button extraction-primary ai-glow-control" type="button" disabled={busy} onClick={() => void act('start')}>{busy ? '正在提交…' : '确认发送并提炼'}</button><button className="quiet-button" type="button" disabled={busy} onClick={() => setPreview(undefined)}>暂不发送</button></div>
      </section>}
      {run && <>
        {!(run.status === 'ready' && api.ingestion) && runRecord}
        {run.status === 'ready' && run.result && <>
          {partialRange && <aside className="extraction-notice" aria-label="本轮提炼范围"><p>本次范围：{run.sourceRange!.label}；仅覆盖部分原文。继续提炼会重新预览整份资料，也可在问问选择其他页继续。</p>{!embedded && continuation?.key === continuationKey && continuation.allowed && <Link className="quiet-button" to={extractionHref(run.materialPath)}>继续提炼</Link>}{!embedded && continuation?.key === continuationKey && continuation.error && <p>{continuation.error}<button type="button" className="quiet-button" onClick={() => setContinuationRevision(value => value + 1)}>重新读取后续状态</button></p>}</aside>}
          {!api.ingestion && runBriefing}
          {api.ingestion ? <CandidateReview run={run} onChanged={reviewChanged} {...(onReviewBusy ? { onReviewBusy } : {})} {...(onNextMaterial ? { onNextMaterial } : {})} /> : <><section className="extraction-candidates" aria-label="建议提炼"><h2>建议提炼 · {run.result.candidates.length} 条</h2>
            {run.result.candidates.length === 0 && <p>这份资料暂未识别出适合长期复用的知识，不需要为了数量强行入库。</p>}
            {run.result.candidates.map((candidate, index) => <article className="instrument-panel extraction-panel" key={index}><h3>{index + 1}. {candidate.title}</h3>
              <dl className="extraction-facts"><div><dt>知识类型</dt><dd>{candidate.knowledgeType}</dd></div><div><dt>建议路径</dt><dd>{candidate.suggestedPath}</dd></div><div><dt>所属主题</dt><dd>{candidate.topics.join('、') || '暂不关联主题'}</dd></div></dl>
              <h4>核心内容</h4><SafeMarkdown>{candidate.coreContent}</SafeMarkdown><h4>价值</h4><p>{candidate.value}</p>
            </article>)}
          </section>
          <p className="extraction-muted">当前版本尚未提供候选审阅与入库服务，可以查看已保存候选。</p></>}
        </>}
        {run.status === 'ready' && api.ingestion && <>{runBriefing}{runRecord}</>}
      </>}
      </div>
      {!embedded && <section hidden={!evidenceOpen} className="extraction-source-evidence" aria-label="原文依据"><header><strong>原文依据</strong><button ref={evidenceClose} type="button" className="quiet-button" onClick={() => { setEvidenceOpen(false); evidenceReturn.current?.focus({ preventScroll: true }); }}>收起依据</button></header>{!evidence && !evidenceError && <p role="status">正在读取原文…</p>}{evidenceError && <div role="alert"><p>{evidenceError}</p><button type="button" className="quiet-button" onClick={() => setEvidenceRevision(value => value + 1)}>重新读取原文</button></div>}{evidence && <>{run && run.sourceRawSha256 !== evidence.sha && <p className="extraction-notice">当前原文已有更新，请核对候选是否仍有依据。</p>}<SafeMarkdown>{evidence.markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '')}</SafeMarkdown></>}</section>}
    </div>
  );
}
