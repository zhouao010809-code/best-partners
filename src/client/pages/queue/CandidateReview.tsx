import { useContext, useEffect, useRef, useState } from 'react';
import { Link, UNSAFE_NavigationContext, useSearchParams } from 'react-router-dom';
import { CheckCircle2, FileCheck2 } from 'lucide-react';
import { useConsoleRuntime } from '../../app/ConsoleRuntime.js';
import { SafeMarkdown } from '../../components/SafeMarkdown.js';
import { ASSISTANT_REVIEW_EVENT } from '../../components/assistant/assistantIntent.js';
import type { ApiClientResult } from '../../api/client.js';
import type { ExtractionRun } from '../../../shared/api/extraction.js';
import { type IngestionReview, type ReviewCandidate, type IngestionPreview,
  type IngestionBatch, type IngestionRecoveryPreview } from '../../../shared/api/ingestion.js';
import { candidateContentIdentity as contentIdentity, createCandidateDraftStore, type StoredCandidateDraft } from './candidateDraftStore.js';
import { CandidateReading, FileChanges, incompleteFields, MatchPicker, ReadableDocument, ReviewFields } from './ingestion/ReviewFields.js';

type Entry = { value: ReviewCandidate; sync: 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'; problem?: string };
const message = (result: ApiClientResult<unknown>, fallback: string) => !result.ok && 'state' in result ? result.state.message ?? fallback : fallback;
const attemptKey = (runId: string) => `brain-ingestion-attempt:${runId}`;
const draftStorageProblem = '本机临时草稿空间不可用，请保持页面打开并重试保存。';
const titleFromPath = (path: string) => path.split('/').at(-1)?.replace(/\.md$/u, '') ?? path;

export function CandidateReview(props: { run: ExtractionRun; onChanged?: () => void; onReviewBusy?: (busy: boolean, durableDraft?: boolean) => void; onNextMaterial?: () => void }) {
  return <CandidateReviewContent key={props.run.id} {...props} />;
}

function CandidateReviewContent({ run, onChanged, onReviewBusy, onNextMaterial }: { run: ExtractionRun; onChanged?: () => void; onReviewBusy?: (busy: boolean, durableDraft?: boolean) => void; onNextMaterial?: () => void }) {
  const { api } = useConsoleRuntime(); const service = api.ingestion;
  const [draftStore] = useState(() => createCandidateDraftStore(run.id));
  const [recoverable, setRecoverable] = useState<Record<string, StoredCandidateDraft[]>>({});
  const [query] = useSearchParams(); const requestedBatch = query.get('batch');
  const { navigator } = useContext(UNSAFE_NavigationContext);
  const [review, setReview] = useState<IngestionReview>(); const [entries, setEntries] = useState<Record<string, Entry>>({});
  const entriesRef = useRef(entries); const [loaded, setLoaded] = useState(false); const [error, setError] = useState('');
  const [busy, setBusy] = useState(false); const pending = useRef(false); const lifetime = useRef<AbortController | undefined>(undefined);
  const [preview, setPreview] = useState<IngestionPreview>(); const [batch, setBatch] = useState<IngestionBatch>();
  const [attemptId, setAttemptId] = useState<string>(); const [recovery, setRecovery] = useState<IngestionRecoveryPreview>();
  const [recoveryChoices, setRecoveryChoices] = useState<Record<string, { titles: Record<string, string>; sourceChoice?: 'current' | 'preserved' }>>({});
  const recoveryRevision = useRef(0);
  const [source, setSource] = useState<{ markdown: string; sha: string }>(); const [acknowledged, setAcknowledged] = useState(false);
  const [remote, setRemote] = useState<ReviewCandidate>(); const [storageError, setStorageError] = useState('');
  const failedDraftWrites = useRef(new Set<string>());
  const [revision, setRevision] = useState(0); const saving = useRef<Promise<boolean> | undefined>(undefined);
  const onChangedRef = useRef(onChanged); onChangedRef.current = onChanged;
  const [currentCandidate, setCurrentCandidate] = useState('');
  const [compared, setCompared] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<Set<string>>(() => new Set());
  const articles = useRef(new Map<string, HTMLElement>());

  function showCandidate(id: string, field?: string) {
    setCurrentCandidate(id);
    if (field) setEditing(previous => new Set(previous).add(id));
    requestAnimationFrame(() => {
      const article = articles.current.get(id);
      const target = field ? [...(article?.querySelectorAll<HTMLElement>('[data-review-field]') ?? [])].find(node => node.dataset.reviewField === field) : article?.querySelector<HTMLElement>('h3');
      if (!target) return;
      for (let parent = target.parentElement; parent && parent !== article; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
      target.focus({ preventScroll: true }); target.scrollIntoView?.({ block: 'nearest' });
    });
  }

  function replaceEntries(next: Record<string, Entry>) { entriesRef.current = next; setEntries(next); }
  function updateEntry(id: string, entry: Entry) { replaceEntries({ ...entriesRef.current, [id]: entry }); }
  function persist(value: ReviewCandidate): boolean {
    try {
      draftStore.write(value); failedDraftWrites.current.delete(value.id);
      setStorageError(failedDraftWrites.current.size ? draftStorageProblem : ''); return true;
    } catch { failedDraftWrites.current.add(value.id); setStorageError(draftStorageProblem); return false; }
  }
  function clearCached(value: ReviewCandidate) {
    draftStore.clear(value); failedDraftWrites.current.delete(value.id);
    setStorageError(failedDraftWrites.current.size ? draftStorageProblem : '');
    setRecoverable(previous => ({ ...previous, [value.id]: value.state === 'pending' ? draftStore.read(value).copies : [] }));
  }
  function acceptReview(value: IngestionReview) {
    if (value.runId !== run.id || value.materialPath !== run.materialPath) throw new Error('候选记录与当前资料不匹配。');
    const next: Record<string, Entry> = {};
    const copies: Record<string, StoredCandidateDraft[]> = {};
    for (const candidate of value.candidates) {
      if (candidate.state !== 'pending') { next[candidate.id] = { value: candidate, sync: 'saved' }; clearCached(candidate); continue; }
      const current = entriesRef.current[candidate.id];
      const cached = draftStore.read(candidate); copies[candidate.id] = cached.copies;
      const local = current && current.sync !== 'saved' ? current.value : cached.selected?.value;
      if (local && (!current || current.sync === 'saved')) persist(local);
      if (!local || contentIdentity(local) === contentIdentity(candidate)) { next[candidate.id] = { value: candidate, sync: 'saved' }; clearCached(candidate); }
      else if (local.version !== candidate.version) next[candidate.id] = { value: local, sync: 'conflict', problem: '另一窗口已更新草稿；你的编辑保留在这里，请先核对最新版本。' };
      else next[candidate.id] = { value: local, sync: 'dirty' };
    }
    replaceEntries(next); setRecoverable(copies); setReview(value); setLoaded(true);
  }
  async function reloadReview(signal?: AbortSignal) {
    if (!service) return;
    const result = await service.review(run.id, signal);
    if (signal?.aborted) return;
    if (!result.ok) throw new Error(message(result, '候选审阅暂不可用。'));
    acceptReview(result.value);
  }
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    if (!service) { setLoaded(true); return () => controller.abort(); }
    void reloadReview(controller.signal).then(async () => {
      if (controller.signal.aborted) return;
      let stored: string | null = requestedBatch; try { stored ||= localStorage.getItem(attemptKey(run.id)); } catch { /* Initial review still contains saved batches. */ }
      if (stored && /^[a-f0-9-]{36}$/iu.test(stored)) {
        setAttemptId(stored);
        const result = await service.batch(stored, controller.signal);
        if (controller.signal.aborted) return;
        if (!result.ok) throw new Error(message(result, '指定入库批次暂时无法读取。'));
        if (result.value.runId !== run.id || result.value.id !== stored) throw new Error('指定批次与当前提炼不匹配，请返回操作记录重新选择。');
        setBatch(result.value);
        if (result.value.status === 'committed') setAttemptId(undefined);
      }
    }).catch((cause: unknown) => { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : '候选审阅暂不可用，请重试。'); setLoaded(true); } });
    return () => controller.abort();
  }, [service, run.id, run.materialPath, revision, requestedBatch]);

  async function flushDirty(): Promise<boolean> {
    if (saving.current) return saving.current;
    if (!service) return false;
    const signal = lifetime.current?.signal;
    const task = (async () => {
      while (!signal?.aborted) {
        const entry = Object.values(entriesRef.current).find((item) => item.sync === 'dirty' && !item.value.batchId);
        if (!entry) break;
        const snapshot = entry.value;
        updateEntry(snapshot.id, { ...entry, sync: 'saving' });
        try {
          const result = await service.save(run.id, { candidateId: snapshot.id, version: snapshot.version, draft: snapshot.draft, target: snapshot.target, decision: snapshot.decision });
          if (signal?.aborted) return false;
          const latest = entriesRef.current[snapshot.id]; if (!latest) return false;
          if (!result.ok) { updateEntry(snapshot.id, { ...latest, sync: 'state' in result && result.state.status === 'conflict' ? 'conflict' : 'error', problem: message(result, '草稿未保存，请重试。') }); return false; }
          if (result.value.id !== snapshot.id || result.value.version <= snapshot.version) { updateEntry(snapshot.id, { ...latest, sync: 'error', problem: '保存回执与候选不匹配，当前编辑已保留。' }); return false; }
          if (contentIdentity(latest.value) === contentIdentity(snapshot)) { updateEntry(snapshot.id, { value: result.value, sync: 'saved' }); clearCached(result.value); onChangedRef.current?.(); }
          else { const value = { ...latest.value, version: result.value.version }; updateEntry(snapshot.id, { value, sync: 'dirty' }); persist(value); }
        } catch { if (!signal?.aborted) { const latest = entriesRef.current[snapshot.id]!; updateEntry(snapshot.id, { ...latest, sync: 'error', problem: '无法保存草稿，当前编辑已保留，请重试。' }); } return false; }
      }
      return !Object.values(entriesRef.current).some((entry) => entry.sync !== 'saved');
    })();
    saving.current = task;
    try { return await task; } finally { if (saving.current === task) saving.current = undefined; }
  }
  const hasDirty = Object.values(entries).some((entry) => entry.sync === 'dirty');
  const leavingBlocked = busy || Object.values(entries).some((entry) => entry.sync !== 'saved');
  const durableDraft = leavingBlocked && !busy && !storageError && !Object.values(entries).some((entry) => entry.sync === 'saving');
  useEffect(() => { onReviewBusy?.(leavingBlocked, durableDraft); }, [onReviewBusy, leavingBlocked, durableDraft]);
  useEffect(() => () => onReviewBusy?.(false), [onReviewBusy]);
  useEffect(() => { if (!hasDirty) return; const timer = setTimeout(() => void flushDirty(), 450); return () => clearTimeout(timer); }, [entries, hasDirty]);
  useEffect(() => {
    const unsettled = () => Object.values(entriesRef.current).some((entry) => entry.sync !== 'saved');
    const unload = (event: BeforeUnloadEvent) => { if (unsettled()) { event.preventDefault(); event.returnValue = ''; } };
    const navigate = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (link && unsettled() && storageError) { event.preventDefault(); event.stopPropagation(); setError('草稿尚未保存，且临时草稿空间不可用。请先重试保存再离开。'); }
    };
    window.addEventListener('beforeunload', unload); document.addEventListener('click', navigate, true);
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', navigate, true); };
  }, [storageError]);
  useEffect(() => {
    // This app uses BrowserRouter, whose public useBlocker requires a data router.
    // Guard its existing navigation adapter only while no durable copy is available.
    if (!storageError) return;
    const original = { push: navigator.push, replace: navigator.replace, go: navigator.go };
    const blocked = () => {
      if (!Object.values(entriesRef.current).some((entry) => entry.sync !== 'saved')) return false;
      setError('草稿尚未保存，且临时草稿空间不可用。请先重试保存再离开。'); return true;
    };
    const push: typeof navigator.push = (...args) => { if (!blocked()) original.push.apply(navigator, args); };
    const replace: typeof navigator.replace = (...args) => { if (!blocked()) original.replace.apply(navigator, args); };
    const go: typeof navigator.go = (...args) => { if (!blocked()) original.go.apply(navigator, args); };
    navigator.push = push; navigator.replace = replace; navigator.go = go;
    return () => {
      if (navigator.push === push) navigator.push = original.push;
      if (navigator.replace === replace) navigator.replace = original.replace;
      if (navigator.go === go) navigator.go = original.go;
    };
  }, [navigator, storageError]);

  function edit(id: string, value: ReviewCandidate) {
    const entry = entriesRef.current[id]; if (!entry || entry.value.state !== 'pending' || entry.value.batchId || pending.current || attemptId) return;
    persist(value); updateEntry(id, { value, sync: entry.sync === 'conflict' ? 'conflict' : 'dirty', ...(entry.sync === 'conflict' && entry.problem ? { problem: entry.problem } : {}) });
    setPreview(undefined); setRecovery(undefined); setError('');
  }
  async function act(action: () => Promise<void>) {
    if (pending.current || !service) return;
    const signal = lifetime.current?.signal; if (signal?.aborted) return;
    pending.current = true; setBusy(true); setError('');
    try { await action(); } catch (cause) { if (!signal?.aborted) setError(cause instanceof Error ? cause.message : '本次操作未完成，草稿已保留。'); }
    finally { pending.current = false; if (!signal?.aborted) setBusy(false); }
  }
  function active() { return !lifetime.current?.signal.aborted; }
  async function receiveBatch(result: ApiClientResult<IngestionBatch>, expectedId: string) {
    if (!active()) return;
    if (!result.ok) throw new Error(message(result, '暂时无法确认本批结果。请查询同一批次。'));
    if (result.value.id !== expectedId || result.value.runId !== run.id) throw new Error('返回批次与当前资料不匹配。');
    if (batch?.id !== result.value.id || result.value.status !== 'needs-review') { recoveryRevision.current++; setRecovery(undefined); }
    setBatch(result.value);
    if (batch?.id !== result.value.id || batch?.status !== result.value.status) window.dispatchEvent(new Event(ASSISTANT_REVIEW_EVENT));
    if (result.value.status === 'committed') {
      setPreview(undefined); setRecovery(undefined);
      await reloadReview(lifetime.current?.signal);
      if (!active()) return;
      setAttemptId(undefined); try { localStorage.removeItem(attemptKey(run.id)); } catch { /* Read-only recovery can recheck this completed id next time. */ }
      onChangedRef.current?.();
    }
  }
  async function makePreview() {
    if (!service || !review) return;
    if (!(await flushDirty())) throw new Error('请先处理未保存或有版本冲突的草稿。');
    if (!active()) return;
    const values = Object.values(entriesRef.current).map((entry) => entry.value);
    const chosen = values.filter((value) => value.state === 'pending' && value.decision !== 'later');
    if (chosen.length === 0) throw new Error('请先选择要入库或明确放弃的候选。');
    if (chosen.some((value) => value.decision === 'keep' && incompleteFields(value).length)) throw new Error('选入本批的候选仍有字段待补齐，请先完成编辑。');
    const result = await service.preview({ runId: run.id, versions: values.map((value) => ({ id: value.id, version: value.version })), ...(review.sourceChanged && acknowledged && source ? { acknowledgedSourceSha: source.sha } : {}) });
    if (!active()) return;
    if (!result.ok) throw new Error(message(result, '无法生成入库预览，草稿已保留。'));
    if (result.value.runId !== run.id) throw new Error('预览与当前资料不匹配。');
    setPreview(result.value);
  }
  async function confirm() {
    const id = attemptId ?? preview?.id; if (!service || !id) return;
    setAttemptId(id);
    try { localStorage.setItem(attemptKey(run.id), id); } catch { /* Server batch history is also durable. */ }
    await receiveBatch(await service.commit(id), id);
  }
  async function reopenDrafts() {
    if (!service || !attemptId) return;
    const result = await service.batch(attemptId, lifetime.current?.signal); if (!active()) return;
    if (result.ok) { await receiveBatch(result, attemptId); return; }
    if (!('code' in result) || result.code !== 'BATCH_NOT_FOUND') throw new Error(message(result, '尚不能确定本批是否已开始，请保留批次并稍后查询。'));
    await reloadReview(lifetime.current?.signal); if (!active()) return;
    setAttemptId(undefined); setPreview(undefined); setRecovery(undefined); setAcknowledged(false); setSource(undefined);
    try { localStorage.removeItem(attemptKey(run.id)); } catch { /* A later read will recheck the old id. */ }
  }
  async function makeRecovery(sourceChoice?: 'current' | 'preserved') {
    if (!service || !batch) return;
    setRecovery(undefined);
    const choices = recoveryChoices[batch.id];
    const newTargets = Object.fromEntries(batch.knowledgePaths.flatMap((path) => {
      const title = choices?.titles[path]?.trim(); if (!title) return [];
      if (/[/\\\u0000-\u001f\u007f]/u.test(title) || title === '.' || title === '..') throw new Error('新标题不能包含路径分隔符或控制字符。');
      return [[path, `${path.slice(0, path.lastIndexOf('/'))}/${title}.md`]];
    }));
    const choice = sourceChoice ?? choices?.sourceChoice;
    const currentRevision = recoveryRevision.current;
    const result = Object.keys(newTargets).length > 0
      ? await service.recoveryPreview(batch.id, choice, newTargets)
      : await service.recoveryPreview(batch.id, choice);
    if (!active() || currentRevision !== recoveryRevision.current) return;
    if (!result.ok) throw new Error(message(result, '恢复预览暂不可用。'));
    if (result.value.batchId !== batch.id) throw new Error('恢复预览与当前批次不匹配。');
    setRecoveryChoices((previous) => ({ ...previous, [batch.id]: { titles: previous[batch.id]?.titles ?? {}, sourceChoice: result.value.sourceChoice } }));
    setRecovery(result.value);
  }

  if (!service) return <p className="extraction-notice">当前版本尚未提供候选审阅与入库服务，可继续查看已保存候选。</p>;
  if (!review) return <section className="ingestion-review"><h2>候选审阅</h2>{!loaded ? <p role="status">正在读取候选草稿…</p> : <><div className="extraction-notice" role="alert"><p>{error || '候选审阅暂不可用。'}</p><p>当前无法核对正式入库状态，以下仅展示原始提炼结果。</p><button className="quiet-button" onClick={() => { setLoaded(false); setRevision((value) => value + 1); }}>重新读取候选</button></div>{run.result?.candidates.map((candidate, index) => <article className="ingestion-candidate" key={index}><h3>{index + 1}. {candidate.title}</h3><p className="extraction-muted">原始提炼候选 · {candidate.knowledgeType}</p><SafeMarkdown>{candidate.coreContent}</SafeMarkdown><p>{candidate.value}</p></article>)}</>}</section>;
  const values = Object.values(entries); const pendingCount = values.filter((entry) => entry.value.state === 'pending').length;
  const selected = values.filter((entry) => entry.value.state === 'pending' && entry.value.decision === 'keep').length;
  const discarded = values.filter((entry) => entry.value.state === 'pending' && entry.value.decision === 'discard').length;
  const unfinishedBatch = review.batches.some((item) => item.status !== 'committed') || values.some((entry) => entry.value.state === 'pending' && Boolean(entry.value.batchId));
  const locked = busy || Boolean(attemptId) || unfinishedBatch; const sourceReady = !review.sourceChanged || Boolean(source && acknowledged);
  const knownBatches = review.batches.filter((item) => item.id !== batch?.id && (item.status !== 'committed' || !item.indexed));
  const activeCandidate = values.some(entry => entry.value.id === currentCandidate) ? currentCandidate : values.find(entry => entry.value.state === 'pending')?.value.id ?? values[0]?.value.id;
  const activeIndex = values.findIndex(entry => entry.value.id === activeCandidate);
  const selectedMissing = values.filter(entry => entry.value.state === 'pending' && entry.value.decision === 'keep').flatMap(entry => incompleteFields(entry.value).map(field => ({ id: entry.value.id, field })));
  const unsavedCount = values.filter(entry => entry.sync !== 'saved').length;
  return <section className="ingestion-review" aria-label="候选审阅与入库">
    <div className="ingestion-review-summary"><header className="ingestion-heading"><div><p className="extraction-muted">REVIEW / KNOWLEDGE</p><h2>候选审阅</h2><p className="extraction-muted">AI 草稿 · 核对内容，选择本批要处理的候选</p></div><FileCheck2 aria-hidden="true" /></header>
    <div className="ingestion-status-line"><span>待处理 {pendingCount}</span><span>已入库 {values.filter((entry) => entry.value.state === 'committed').length}</span><span>已放弃 {values.filter((entry) => entry.value.state === 'discarded').length}</span><span>原资料：{review.sourceStatus}</span></div></div>
    {review.relatedRuns.some((item) => item.pendingCount > 0) && <aside className="extraction-notice"><p>这份资料还有其他轮次的未决候选：</p>{review.relatedRuns.filter((item) => item.pendingCount > 0).map((item) => <Link key={item.id} to={`/extractions/${item.id}`}>{new Date(item.createdAt).toLocaleString('zh-CN')} · 待处理 {item.pendingCount} 条</Link>)}</aside>}
    {error && <div role="alert" className="extraction-notice">{error}</div>}
    {storageError && <div role="alert" className="extraction-notice">{storageError}</div>}
    {knownBatches.map((item) => <div className="extraction-notice" key={item.id}><p>{item.status === 'needs-review' ? '有一批入库需要核对外部变化。' : item.status === 'committed' ? '有一批已写入，检索尚未更新。' : '有一批入库尚未完成。'}</p><button className="quiet-button" disabled={busy} onClick={() => void act(async () => { setAttemptId(item.id); await receiveBatch(await service.batch(item.id, lifetime.current?.signal), item.id); })}>查看这批结果</button></div>)}
    {review.sourceChanged && <section className="ingestion-source"><h3>原资料已变化，请重新核对依据</h3><p>候选来自较早的资料版本。读取当前原文后，确认这批候选仍然成立。</p>
      <button className="quiet-button" disabled={busy} onClick={() => void act(async () => {
        setSource(undefined); setAcknowledged(false); setPreview(undefined);
        const result = await api.getDocumentDetail(run.materialPath, lifetime.current?.signal); if (!active()) return;
        if (!result.ok) throw new Error(message(result, '当前原资料读取失败。'));
        if (result.value.path !== run.materialPath) throw new Error('当前原资料与所选资料不匹配。');
        setSource({ markdown: result.value.markdown, sha: result.value.versionMarker.rawSha256 });
      })}>读取当前原资料</button>
      {source && <><div className="ingestion-source-body"><ReadableDocument markdown={source.markdown} /></div><label className="ingestion-choice"><input type="checkbox" checked={acknowledged} disabled={locked} onChange={(event) => { setAcknowledged(event.target.checked); setPreview(undefined); }} />我已核对当前原资料，候选仍有依据</label></>}
    </section>}
    {values.length === 0 && <p className="extraction-notice">本轮已处理，无需入库。这份资料暂未识别出适合长期复用的知识。</p>}
    <div className="ingestion-review-layout">{values.length > 0 && <nav className="ingestion-directory" aria-label="候选目录"><ol>{values.map((entry, index) => {
      const candidate = entry.value; const missing = candidate.state === 'pending' ? incompleteFields(candidate).length : 0;
      return <li key={candidate.id} data-current={candidate.id === activeCandidate}><button type="button" aria-label={`查看候选 ${index + 1}：${candidate.draft.title || '未命名候选'}`} aria-current={candidate.id === activeCandidate ? 'true' : undefined} onClick={() => showCandidate(candidate.id)}><span className="ingestion-directory-number">{index + 1}</span><span><strong>{candidate.draft.title || '未命名候选'}</strong><small>{candidate.state === 'committed' ? '已入库' : candidate.state === 'discarded' ? '已放弃' : candidate.decision === 'keep' ? '选入本批' : candidate.decision === 'discard' ? '明确放弃' : '稍后处理'}{missing > 0 && ` · 缺 ${missing} 项`} · {entry.sync === 'saved' ? '草稿已保存' : entry.sync === 'error' ? '保存失败' : entry.sync === 'conflict' ? '版本待核对' : '正在保存'}</small></span></button>{values.length > 1 && <label className="ingestion-compare-choice"><input type="checkbox" aria-label={`同时展开候选 ${index + 1}`} checked={compared.has(candidate.id)} onChange={event => { const checked = event.target.checked; setCompared(previous => { const next = new Set(previous); if (checked) next.add(candidate.id); else next.delete(candidate.id); return next; }); }} />对照</label>}</li>;
    })}</ol></nav>}
    <div className="ingestion-candidates">{values.map((entry, index) => { const candidate = entry.value; const missing = incompleteFields(candidate);
      const otherCopies = (recoverable[candidate.id] ?? []).filter(copy => contentIdentity(copy.value) !== contentIdentity(candidate));
      return <article className={`ingestion-candidate${candidate.state !== 'pending' ? ' ingestion-candidate--settled' : ''}`} hidden={candidate.id !== activeCandidate && !compared.has(candidate.id)} ref={node => { if (node) articles.current.set(candidate.id, node); else articles.current.delete(candidate.id); }} key={candidate.id}>
        <header className="ingestion-row"><h3 tabIndex={-1}>{index + 1}. {candidate.draft.title || '未命名候选'}</h3><span className="ingestion-badge">{candidate.state === 'committed' ? candidate.target.mode === 'reference' ? '已补充来源' : '已入库' : candidate.state === 'discarded' ? '已放弃' : '待处理'}</span>{candidate.state === 'pending' && <div className="ingestion-view-toggle"><button type="button" className="quiet-button" onClick={() => setEditing(previous => { const next = new Set(previous); if (next.has(candidate.id)) next.delete(candidate.id); else next.add(candidate.id); return next; })}>{editing.has(candidate.id) ? '完成编辑，返回阅读' : '编辑候选'}</button></div>}</header>
        {candidate.state === 'pending' ? <>
          {otherCopies.length ? <section className="extraction-notice" aria-label="本机临时草稿恢复"><p>本机保留了其他未同步草稿。核对后可恢复；不会删除其他窗口的副本。</p>{otherCopies.map(copy => <details key={copy.key}><summary>{copy.value.draft.title || '未命名候选'} · {copy.updatedAt ? new Date(copy.updatedAt).toLocaleString('zh-CN') : '旧版草稿'}</summary><p>知识类型：{copy.value.draft.knowledgeType} · 存放目录：{copy.value.draft.suggestedPath || '未选择'}</p><h4>核心正文</h4><SafeMarkdown>{copy.value.draft.coreContent}</SafeMarkdown><p>复用价值：{copy.value.draft.value || '未填写'}</p><p>核心结论：{copy.value.draft.draft.conclusion || '未填写'}</p><p>关键词：{copy.value.draft.draft.keywords.join('、') || '未填写'}</p><button type="button" className="quiet-button" disabled={locked || entry.sync === 'saving'} aria-label={`恢复本机草稿：${copy.value.draft.title || '未命名候选'}`} onClick={() => {
            const authoritative = review.candidates.find(value => value.id === candidate.id)!;
            const conflict = copy.value.version !== Math.max(authoritative.version, candidate.version);
            if (entry.sync !== 'saved' && !persist(candidate)) return;
            draftStore.fork(candidate.id);
            if (!persist(copy.value)) return;
            updateEntry(candidate.id, { value: copy.value, sync: conflict ? 'conflict' : 'dirty', ...(conflict ? { problem: '这份本机草稿与最新版本不同；请先核对另一窗口的草稿。' } : {}) });
            setPreview(undefined); setRecovery(undefined); setError('');
          }}>恢复这份草稿</button></details>)}</section> : null}
          {missing.length > 0 && <div className="ingestion-incomplete"><span>入库前待补齐：</span>{missing.map(field => <button type="button" key={field} disabled={locked} onClick={() => showCandidate(candidate.id, field)}>{field}</button>)}<p>请核对补充缺失字段后再入库。</p></div>}

          <div hidden={editing.has(candidate.id)}><CandidateReading value={candidate.draft} /></div>
          <div hidden={!editing.has(candidate.id)}><ReviewFields value={candidate.draft} directories={review.directories} disabled={locked} onChange={(draft) => edit(candidate.id, { ...candidate, draft })} /></div>
          <fieldset className="ingestion-decisions" disabled={locked}><legend>本轮取舍</legend>{([['later', '稍后处理'], ['keep', '选入本批'], ['discard', '明确放弃']] as const).map(([decision, label]) => <label className={`ingestion-choice${candidate.decision === decision ? ' is-selected' : ''}`} key={decision}><input type="radio" name={`decision-${candidate.id}`} checked={candidate.decision === decision} onChange={() => edit(candidate.id, { ...candidate, decision })} />{label}</label>)}</fieldset>
          {candidate.decision === 'discard' && <p className="extraction-muted">将在本批确认后标记为已放弃；现在仍可改为稍后处理。</p>}
          <p className={`ingestion-save-state${entry.sync === 'error' || entry.sync === 'conflict' ? ' ingestion-save-state--error' : ''}`} role="status">{entry.sync === 'saved' ? '已保存到本机草稿' : entry.sync === 'saving' || entry.sync === 'dirty' ? '正在保存草稿…' : entry.problem}</p>
          {(entry.sync === 'error' || entry.sync === 'conflict') && <div className="extraction-actions">{entry.sync === 'error'
            ? <button className="quiet-button" disabled={busy} onClick={() => { updateEntry(candidate.id, { value: candidate, sync: 'dirty' }); void flushDirty(); }}>重试保存草稿</button>
            : <button className="quiet-button" disabled={busy} onClick={() => void act(async () => { const result = await service.review(run.id, lifetime.current?.signal); if (!active()) return; if (!result.ok) throw new Error(message(result, '无法读取最新草稿。')); const newest = result.value.candidates.find((item) => item.id === candidate.id); if (!newest) throw new Error('最新记录中未找到这条候选。'); setRemote(newest); })}>查看另一窗口的草稿</button>}</div>}
          {remote?.id === candidate.id && <section className="ingestion-existing"><h4>另一窗口的最新草稿 · 版本 {remote.version}</h4><p>{remote.draft.title} · {remote.state === 'pending' ? '待处理' : '已完成取舍'}</p><SafeMarkdown>{remote.draft.coreContent}</SafeMarkdown><details className="ingestion-disclosure"><summary>查看最新完整草稿</summary><pre>{JSON.stringify(remote.draft, null, 2)}</pre></details>
            {remote.state === 'pending' ? <button className="quiet-button" disabled={locked} onClick={() => { const value = { ...candidate, version: remote.version }; setRemote(undefined); persist(value); updateEntry(candidate.id, { value, sync: 'dirty' }); }}>已核对，用我的编辑更新此版本</button> : <p>这条候选已在另一窗口完成取舍，不能再次写入。当前编辑保留供复制。</p>}
          </section>}
          <MatchPicker runId={run.id} candidate={candidate} disabled={locked} onChange={(target) => edit(candidate.id, { ...candidate, target })} />
        </> : <><SafeMarkdown>{candidate.draft.coreContent}</SafeMarkdown>{candidate.committedPath && <Link className="quiet-button" to={`/knowledge?path=${encodeURIComponent(candidate.committedPath)}`}>查看已{candidate.target.mode === 'reference' ? '补充来源的' : '入库'}知识</Link>}</>}
      </article>;
    })}
    </div></div>
    {review.complete && values.length > 0 && <p className="extraction-notice">{values.some((entry) => entry.value.state === 'committed') ? '本轮候选均已完成取舍。' : '本轮已处理，无需入库。'}</p>}
    {preview && <section className="ingestion-preview" aria-label="本批入库预览"><h3>本批将发生的变化</h3><p>选入 {preview.selectedCount} 条 · 明确放弃 {preview.discardedCount} 条 · 剩余待处理 {preview.pendingCount} 条</p><p>原资料入库状态：{preview.sourceStatus}</p><FileChanges files={preview.files} />
      <div className="extraction-actions"><button className="quiet-button extraction-primary" disabled={busy || Boolean(attemptId) || Date.parse(preview.expiresAt) <= Date.now()} onClick={() => void act(confirm)}>{busy ? '正在处理…' : preview.selectedCount === 0 ? '确认本批取舍' : '确认入库'}</button><button className="quiet-button" disabled={busy || Boolean(attemptId)} onClick={() => setPreview(undefined)}>返回修改</button></div>
      {Date.parse(preview.expiresAt) <= Date.now() && <p role="status">预览已过期，请返回修改后重新预览。</p>}
    </section>}
    {attemptId && <section className="ingestion-attempt"><p>批次编号：{attemptId}</p><p>本批提交结果以保存的批次回执为准，恢复期间保留当前草稿。</p><div className="extraction-actions"><button className="quiet-button" disabled={busy} onClick={() => void act(async () => receiveBatch(await service.batch(attemptId, lifetime.current?.signal), attemptId))}>查询本批结果</button>{(!batch || batch.id !== attemptId) && <><button className="quiet-button" disabled={busy} onClick={() => void act(confirm)}>使用同一批次重试确认</button><button className="quiet-button" disabled={busy} onClick={() => void act(reopenDrafts)}>重新核对候选与预览</button></>}</div></section>}
    {batch && <section className="ingestion-receipt" aria-label="入库结果"><header className="ingestion-row"><h3>{batch.status === 'committed' ? '本批已完成' : batch.status === 'needs-review' ? '本批需要核对变化' : '本批尚未写完'}</h3>{batch.status === 'committed' && <CheckCircle2 aria-hidden="true" />}</header>
      {batch.problem && <p role="status">{batch.problem}</p>}
      {batch.status === 'committed' && <><p>{batch.knowledgePaths.length === 0 ? '本批取舍已确认，没有新建或更新知识笔记。' : batch.indexed ? '知识已保存，可在知识库查看。' : '已写入，检索尚未更新。请刷新检索，无需重复入库。'}</p><p>剩余待处理 {batch.pendingCount} 条 · 原资料：{batch.sourceStatus}</p><div className="ingestion-result-links">{batch.knowledgePaths.map((path) => <Link key={path} to={`/knowledge?path=${encodeURIComponent(path)}`}>打开知识：{titleFromPath(path)}</Link>)}<Link to={`/library?path=${encodeURIComponent(run.materialPath)}`}>返回原资料</Link></div></>}
      {(batch.status === 'writing' || batch.status === 'committed' && !batch.indexed) && <button className="quiet-button" disabled={busy} onClick={() => void act(async () => receiveBatch(await service.resume(batch.id), batch.id))}>{batch.status === 'committed' ? '重试更新检索' : '继续完成本批'}</button>}
      {batch.status === 'needs-review' && <>
        {batch.knowledgePaths.length > 0 && <details className="ingestion-disclosure" key={batch.id}><summary>冲突笔记改为新建</summary>
          <p>填写新标题后，候选另存，保留旧笔记；如有交换中保留的旧版本，预览会列出还原内容。新笔记沿用原目录，留空则按原目标核对恢复，不会自动生成标题。定论或过时笔记不会因此解锁。</p>
          <div className="ingestion-metadata">{batch.knowledgePaths.map((path) => <label className="ingestion-field" key={path}>
            <span>为“{titleFromPath(path)}”填写新标题</span>
            <input aria-label={`为“${titleFromPath(path)}”填写新标题`} value={recoveryChoices[batch.id]?.titles[path] ?? ''} disabled={busy} placeholder="可选，不含 .md" onChange={(event) => {
              const title = event.target.value; recoveryRevision.current++; setRecovery(undefined); setError('');
              setRecoveryChoices((previous) => ({ ...previous, [batch.id]: { ...previous[batch.id], titles: { ...previous[batch.id]?.titles, [path]: title } } }));
            }} />
            <small>原目标：{path}</small>
          </label>)}</div>
        </details>}
        <button className="quiet-button" disabled={busy} onClick={() => void act(() => makeRecovery())}>查看并核对恢复变化</button>
      </>}
      {recovery && <section className="ingestion-recovery"><h4>恢复前再次核对</h4><p>下面是当前文件与拟恢复内容。确认仅应用这些可见变化。</p>
        {recovery.hasPreservedSource && <fieldset className="ingestion-decisions" disabled={busy}><legend>恢复原资料使用的版本</legend>{([['preserved', '保留的外部修改版本'], ['current', '当前磁盘版本']] as const).map(([choice, label]) => <label className="ingestion-choice" key={choice}><input type="radio" name="recovery-source" checked={recovery.sourceChoice === choice} onChange={() => void act(() => makeRecovery(choice))} />{label}</label>)}</fieldset>}
        <FileChanges files={recovery.files} /><button className="quiet-button extraction-primary" disabled={busy || Date.parse(recovery.expiresAt) <= Date.now()} onClick={() => void act(async () => receiveBatch(await service.resolve(recovery.id), recovery.batchId))}>确认解决这些变化</button></section>}
    </section>}
    {batch?.status === 'committed' && <div className="ingestion-next-actions" aria-label="入库后的下一步">{batch.knowledgePaths[0] && <Link className="quiet-button" to={`/knowledge?path=${encodeURIComponent(batch.knowledgePaths[0])}`}>使用这篇知识</Link>}{onNextMaterial ? <button className="quiet-button" disabled={busy} onClick={onNextMaterial}>处理下一份</button> : <Link className="quiet-button" to="/queue">返回处理柜</Link>}</div>}
    {pendingCount > 0 && !preview && !attemptId && !unfinishedBatch && <footer className="ingestion-batch-bar" aria-label="当前批次操作">{values.length > 1 && <div className="ingestion-step-navigation"><button type="button" className="quiet-button" aria-label="上一条候选" disabled={activeIndex <= 0} onClick={() => showCandidate(values[activeIndex - 1]!.value.id)}>上一条</button><span>{activeIndex + 1} / {values.length}</span><button type="button" className="quiet-button" aria-label="下一条候选" disabled={activeIndex >= values.length - 1} onClick={() => showCandidate(values[activeIndex + 1]!.value.id)}>下一条</button></div>}<div className="ingestion-batch-status"><strong>选入本批 {selected} 条</strong><span role="status">{unsavedCount ? `${unsavedCount} 条草稿尚未保存完成` : '草稿已保存 · 待确认入库'}{selectedMissing.length > 0 && ` · 本批待补 ${selectedMissing.length} 项`}</span></div><div className="extraction-actions">{selectedMissing[0] && <button type="button" className="quiet-button" disabled={locked} onClick={() => showCandidate(selectedMissing[0]!.id, selectedMissing[0]!.field)}>补齐本批缺项</button>}<button className="quiet-button extraction-primary" disabled={busy || !sourceReady || selected + discarded === 0 || values.some((entry) => entry.sync === 'conflict')} onClick={() => void act(makePreview)}>{busy ? '正在准备…' : '预览本批变化'}</button></div><details className="ingestion-batch-details"><summary>本批详情</summary><div><p>明确放弃 {discarded} 条 · 稍后处理 {pendingCount - selected - discarded} 条</p><p>稍后处理继续保留。核对下一步预览并确认后，才会正式入库。</p></div></details></footer>}
  </section>;
}
