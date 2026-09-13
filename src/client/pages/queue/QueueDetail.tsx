import { useEffect, useRef, useState } from 'react';
import { FileText, Sparkles, ListMinus, ListPlus } from 'lucide-react';
import { useConsoleRuntime } from '../../app/ConsoleRuntime.js';
import { SafeMarkdown } from '../../components/SafeMarkdown.js';
import { MaterialTrashButton } from '../../components/MaterialTrash.js';
import { ExtractionWorkbench } from '../ExtractionPage.js';
import type { ExtractionQueueItem, ExtractionHistoryPage } from '../../../shared/api/extraction-queue.js';
import type { ExtractionRun } from '../../../shared/api/extraction.js';
import type { LiveDocumentDetail } from '../../api/client.js';

interface Props {
  materialPath: string;
  item: ExtractionQueueItem | undefined;
  runId: string;
  pane: string;
  onPane: (pane: string) => void;
  onSelectRun: (id: string) => void;
  onRun: (run: ExtractionRun, started: boolean) => void;
  onChanged: () => void;
  onReviewBusy?: (busy: boolean, durableDraft?: boolean) => void;
  onVisibility?: (removed: boolean) => void;
  visibilityBusy?: boolean;
  onNextMaterial?: () => void;
}

export function QueueDetail({ materialPath, item, runId, pane, onPane, onSelectRun, onRun, onChanged, onReviewBusy, onVisibility, visibilityBusy, onNextMaterial }: Props) {
  const { api } = useConsoleRuntime();
  const [original, setOriginal] = useState<LiveDocumentDetail>();
  const [originalError, setOriginalError] = useState('');
  const [originalRevision, setOriginalRevision] = useState(0);
  const [preparing, setPreparing] = useState(pane === 'prepare');
  const [retryReadingState, setRetryReadingState] = useState<'未看' | '已看'>('未看');
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const evidenceReturn = useRef<HTMLElement | null>(null);
  const evidenceClose = useRef<HTMLButtonElement>(null);
  const closeEvidence = () => { setEvidenceOpen(false); requestAnimationFrame(() => evidenceReturn.current?.focus({ preventScroll: true })); };
  useEffect(() => {
    if (!evidenceOpen) return;
    evidenceClose.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); setEvidenceOpen(false); evidenceReturn.current?.focus({ preventScroll: true }); } };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [evidenceOpen]);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [materialPath]);
  useEffect(() => { if (pane === 'prepare') setPreparing(true); }, [pane]);
  useEffect(() => {
    const controller = new AbortController(); setOriginal(undefined); setOriginalError('');
    void api.getDocumentDetail(materialPath, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (!result.ok) { if ('state' in result) setOriginalError(result.state.message ?? '原资料暂时无法读取，已保存结果仍可查看。'); return; }
      if (result.value.path !== materialPath) { setOriginalError('原文路径不匹配，请重新读取。'); return; }
      setOriginal(result.value);
    });
    return () => controller.abort();
  }, [api.getDocumentDetail, materialPath, originalRevision, item?.sourceRawSha256]);
  const currentSha = original?.versionMarker.rawSha256 ?? item?.sourceRawSha256;
  const currentSummary = [item?.latestRun, item?.latestReadyRun, item?.activeRun].find((summary) => summary?.id === runId);
  const comparableSha = currentSha && currentSha === currentSummary?.currentSourceSha256 ? currentSummary.sourceRawSha256 : currentSha;
  const retry = (readingState: '未看' | '已看' = '未看') => { setRetryReadingState(readingState); setPreparing(true); onPane('prepare'); };
  const canStart = item?.canExtract === true && !item.activeRun && !item.removedAt;
  const title = item?.title ?? materialPath.split('/').at(-1)?.replace(/\.md$/u, '') ?? '资料';
  return <div className="queue-detail">
    <header className="queue-detail-header"><p className="queue-eyebrow">{pane === 'original' ? 'SOURCE / READ' : pane === 'prepare' ? 'EXTRACT / PREPARE' : 'EXTRACTION / RESULT'}</p><h2 tabIndex={-1} ref={heading}>{title}</h2><p className="queue-detail-meta">{item?.sourcePlatform || '原始资料'}{item?.collectedAt && ` · ${item.collectedAt} 采集`}</p></header>
    <div className="queue-detail-toolbar"><div className="queue-segment" aria-label="资料视图"><button type="button" aria-pressed={pane === 'original'} onClick={() => { setEvidenceOpen(false); onPane('original'); }}><FileText aria-hidden="true" />原文</button>{runId && <button type="button" aria-pressed={pane === 'result'} onClick={() => onPane('result')}><Sparkles aria-hidden="true" />提炼结果</button>}{preparing && <button type="button" aria-pressed={pane === 'prepare'} onClick={() => onPane('prepare')}>提炼准备</button>}{pane === 'result' && <button type="button" aria-expanded={evidenceOpen} onPointerDown={() => { evidenceReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }} onClick={event => { if (evidenceOpen) closeEvidence(); else { if (event.detail === 0 || !evidenceReturn.current || evidenceReturn.current === document.body) evidenceReturn.current = event.currentTarget; setEvidenceOpen(true); } }}><FileText aria-hidden="true" />查看依据</button>}</div>
      <div className="queue-source-actions">{(pane === 'original' || pane === 'result') && canStart && <button type="button" className="quiet-button extraction-primary ai-glow-control" onClick={() => retry()}><Sparkles aria-hidden="true" />{pane === 'result' ? '继续提炼' : item?.latestRun ? '重新提炼' : '开始提炼'}</button>}
      {item && onVisibility && <button type="button" className="quiet-button" disabled={visibilityBusy || Boolean(item.activeRun)} title={item.activeRun ? '请先停止本次提炼' : undefined} onClick={() => onVisibility(!item.removedAt)}>{item.removedAt ? <ListPlus aria-hidden="true" /> : <ListMinus aria-hidden="true" />}{item.removedAt ? '重新加入' : '移出队列'}</button>}
      {item && <MaterialTrashButton record={{ path: materialPath, title, origin: 'queue' }} text disabled={Boolean(visibilityBusy || item.activeRun)} />}</div>
    </div>
    {item?.activeRun && onVisibility && <p className="extraction-muted queue-removal-help">移出前请先停止本次提炼。<button type="button" className="queue-text-button" onClick={() => { onSelectRun(item.activeRun!.id); onPane('result'); }}>查看当前提炼</button></p>}
    {item?.removedAt && <p className="extraction-muted queue-removal-help">已移出 · {new Date(item.removedAt).toLocaleString('zh-CN')}。原文、候选及入库记录均保留。</p>}
    {item?.latestReadyRun && item.latestReadyRun.id !== runId && <button type="button" className="queue-previous-result" onClick={() => onSelectRun(item.latestReadyRun!.id)}>查看上次成功结果<span>{item.latestReadyRun.candidateCount ?? 0} 条候选 ↗</span></button>}
    <div className={`queue-detail-content${pane === 'result' && evidenceOpen ? ' queue-detail-content--evidence' : ''}`}>
    <section hidden={pane !== 'original' && !(pane === 'result' && evidenceOpen)} className={`queue-original${pane === 'result' ? ' queue-evidence' : ''}`} aria-label={pane === 'result' ? '原文依据' : '原文阅读'}>
      {pane === 'result' && <header className="queue-evidence-heading"><div><strong>原文依据</strong><span>核对后继续审阅，编辑会保留</span></div><button type="button" ref={evidenceClose} className="quiet-button" onClick={closeEvidence}>收起依据</button></header>}
      {!original && !originalError && <p role="status">正在读取原文…</p>}
      {originalError && <div className="extraction-notice" role="alert"><p>{originalError}</p><button type="button" className="quiet-button" onClick={() => setOriginalRevision((v) => v + 1)}>重新读取原文</button></div>}
      {original && <>{item?.sourceRawSha256 && item.sourceRawSha256 !== original.versionMarker.rawSha256 && <p className="extraction-notice">原文已有更新，以下显示当前文件内容。</p>}<SafeMarkdown>{original.markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '')}</SafeMarkdown></>}
      {item && !item.canExtract && <p className="extraction-muted">这份资料当前不在待提炼范围，已保存的结果仍可查看。</p>}
      <details className="queue-file-info"><summary>文件信息</summary><p>{materialPath}</p>{currentSha && <p>原文版本 {currentSha.slice(0, 12)}</p>}</details>
    </section>
    {preparing && <div hidden={pane !== 'prepare'}>{canStart ? <ExtractionWorkbench key={`new:${materialPath}:${retryReadingState}`} id="new" materialPath={materialPath} initialReadingState={retryReadingState} embedded onRun={(run) => { setPreparing(false); onRun(run, true); }} /> : <p role="status">请先确认资料仍可提炼；正在进行的任务可在“提炼结果”中查看。</p>}</div>}
    {runId && <div hidden={pane !== 'result'} className="queue-review-content"><ExtractionWorkbench key={runId} id={runId} materialPath={materialPath} embedded onRun={(run) => onRun(run, false)} onChanged={onChanged} {...(onReviewBusy ? { onReviewBusy } : {})} {...(onNextMaterial ? { onNextMaterial } : {})} {...(canStart ? { onRetry: retry } : {})} {...(comparableSha ? { currentSourceSha: comparableSha } : {})} /></div>}
    </div>
    {(item?.latestRun || runId) && <QueueRunHistory materialPath={materialPath} currentRun={runId} revision={`${item?.latestRun ? item.latestRun.id + item.latestRun.status : runId}:${item?.pendingCandidateCount ?? ''}`} onSelect={onSelectRun} />}
  </div>;
}

function QueueRunHistory({ materialPath, currentRun, revision, onSelect }: { materialPath: string; currentRun: string; revision: string; onSelect: (id: string) => void }) {
  const service = useConsoleRuntime().api.extractionQueue!;
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<ExtractionHistoryPage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const pending = useRef(false);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); lifetime.current = controller; seen.current.clear(); pending.current = true;
    setPage(undefined); setBusy(true); setError('');
    void service.history({ materialPath, limit: 10 }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setBusy(false); pending.current = false;
      if (result.ok) setPage(result.value);
      else if ('state' in result) setError(result.state.message ?? '历史记录暂时不可用');
    });
    return () => controller.abort();
  }, [open, materialPath, revision, reload, service]);
  async function more() {
    if (!page?.nextCursor || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    const cursor = page.nextCursor; const signal = lifetime.current?.signal;
    const result = await service.history({ materialPath, limit: 10, cursor }, signal);
    if (signal?.aborted) return;
    setBusy(false); pending.current = false;
    if (!result.ok) { if ('state' in result) setError(result.state.message ?? '历史记录已变化，请重新读取'); return; }
    if (result.value.items.some((run) => page.items.some((old) => old.id === run.id)) || result.value.nextCursor && (result.value.nextCursor === cursor || seen.current.has(result.value.nextCursor) || result.value.items.length === 0)) { setError('历史记录已变化，请重新读取'); return; }
    seen.current.add(cursor); setPage({ ...result.value, items: [...page.items, ...result.value.items] });
  }
  return <details className="queue-run-history" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>历史提炼记录</summary>
    {error && <div role="alert"><p>{error}</p><button type="button" className="quiet-button" onClick={() => setReload((v) => v + 1)}>重新读取历史</button></div>}
    {page?.items.map((run) => <button key={run.id} type="button" aria-pressed={run.id === currentRun} onClick={() => onSelect(run.id)}><span>{new Date(run.createdAt).toLocaleString('zh-CN')}</span><span>{run.status === 'ready' ? run.reviewComplete === true ? '已处理' : `${run.pendingCandidateCount ?? run.candidateCount ?? 0} 条候选待处理` : run.status === 'generating' ? '提炼中' : run.status === 'cancelled' ? '已停止' : '未完成'}</span></button>)}
    {busy && <p role="status">正在读取历史…</p>}{page?.nextCursor && <button type="button" disabled={busy} onClick={() => void more()}>加载更早记录</button>}
  </details>;
}
