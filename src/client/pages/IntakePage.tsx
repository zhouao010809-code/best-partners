import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Archive, ArrowRight, ChevronDown, FileText, FolderOpen, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { intakePlatforms, type IntakeList, type IntakePreview, type IntakePreviewRequest, type IntakeOutcome } from '../../shared/api/intake.js';
import type { ApiClientResult } from '../api/client.js';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import { IntakeTray } from './intake/IntakeTray.js';
import { IntakeMailbox } from './intake/IntakeMailbox.js';
import { useIntakeTrash } from './intake/useIntakeTrash.js';
import { extractionHref } from './ExtractionPage.js';
import { IntakeFileImport } from './intake/IntakeFileImport.js';

type Draft = { name: string; mainName: string; title: string; platform: string; collectedAt: string; author: string; url: string };
function message<T>(result: ApiClientResult<T>): string {
  return !result.ok && 'state' in result ? result.state.message ?? '操作未完成，请重试。' : '操作已取消，请重试。';
}
export function IntakePage() {
  const { api, refreshHealth } = useConsoleRuntime(); const intake = api.intake;
  const [data, setData] = useState<IntakeList>(); const [error, setError] = useState('');
  const [listError, setListError] = useState(''); const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(); const [preview, setPreview] = useState<IntakePreview>();
  const [outcome, setOutcome] = useState<IntakeOutcome>();
  const [archivedPath, setArchivedPath] = useState<string>();
  const archiveMainFiles = useRef(new Map<string, string>());
  const continueFocus = useRef(false); const trayLayout = useRef<HTMLDivElement>(null);
  const [mailboxOpen, setMailboxOpen] = useState(false);
  const editedDrafts = useRef(new Map<string, Draft>());
  const trashBlockRef = useRef(false);
  const version = useRef(0); const mounted = useRef(true); const busyRef = useRef(false); const listSequence = useRef(0);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const selectedTrigger = useRef<HTMLElement | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!intake) { setLoading(false); return; }
    const sequence = ++listSequence.current;
    setRefreshing(true);
    try {
      const result = await intake.list(signal);
      if (!mounted.current || signal?.aborted || sequence !== listSequence.current) return;
      if (result.ok) { setData(result.value); setListError(''); }
      else setListError(message(result));
    } catch {
      if (mounted.current && !signal?.aborted && sequence === listSequence.current) setListError('本地连接中断，请刷新收件箱重试。');
    } finally {
      if (mounted.current && !signal?.aborted && sequence === listSequence.current) { setLoading(false); setRefreshing(false); }
    }
  }, [intake]);
  const trash = useIntakeTrash((entry) => {
    if (entry.status === 'trashed') editedDrafts.current.delete(entry.name);
    if (entry.status === 'trashed' && draft?.name === entry.name) {
      version.current += 1; setDraft(undefined); setPreview(undefined); setError('');
    }
    void load();
  });
  const interactionBusy = busy || trash.busy || trash.visible;
  trashBlockRef.current = trash.busy || trash.visible;
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => {
      if (!busyRef.current && !trashBlockRef.current && document.visibilityState !== 'hidden') void load(controller.signal);
    }, 5000);
    return () => { mounted.current = false; controller.abort(); window.clearInterval(timer); version.current += 1; };
  }, [load]);
  useEffect(() => { if (draft) detailHeading.current?.focus(); }, [draft?.name]);
  useEffect(() => { if (preview) previewHeading.current?.focus(); }, [preview]);
  useEffect(() => {
    if (!continueFocus.current || outcome || !mailboxOpen) return;
    continueFocus.current = false;
    (detailHeading.current ?? trayLayout.current?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? refreshButton.current)?.focus();
  }, [outcome, mailboxOpen]);
  const close = useCallback(() => {
    if (busyRef.current || trashBlockRef.current) return;
    version.current += 1; setDraft(undefined); setPreview(undefined); setError('');
    queueMicrotask(() => {
      const trigger = selectedTrigger.current;
      if (trigger?.isConnected && !trigger.matches(':disabled')) trigger.focus();
      else refreshButton.current?.focus();
    });
  }, []);
  useEffect(() => {
    if (!draft) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !busyRef.current) { event.preventDefault(); close(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [Boolean(draft), close]);
  function change(fields: Partial<Draft>) {
    if (!draft) return;
    const next = { ...draft, ...fields };
    editedDrafts.current.set(next.name, next);
    version.current += 1; setDraft(next); setPreview(undefined); setError('');
  }
  function closeMailbox() {
    if (busyRef.current || trashBlockRef.current) return;
    version.current += 1; setDraft(undefined); setPreview(undefined); setError(''); setMailboxOpen(false);
  }
  function select(item: IntakeList['items'][number]) {
    if (busyRef.current || trashBlockRef.current) return;
    selectedTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    version.current += 1; setPreview(undefined); setError(''); setOutcome(undefined); setArchivedPath(undefined);
    setDraft(editedDrafts.current.get(item.name) ?? { name: item.name, mainName: item.mainCandidates.length === 1 ? item.mainCandidates[0]! : '',
      title: item.fields.title ?? '', platform: item.fields.platform ?? '', collectedAt: item.fields.collectedAt ?? '', author: item.fields.author ?? '', url: item.fields.url ?? '' });
  }
  async function run(action: () => Promise<void>) {
    if (busyRef.current || trashBlockRef.current) return; busyRef.current = true; setBusy(true); setError('');
    try { await action(); } catch { if (mounted.current) setError('本地连接中断。请刷新收件箱查看文件和恢复状态，不要重复导入。'); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  async function showPreview() {
    if (!draft || !intake) return;
    const request: IntakePreviewRequest = { name: draft.name, mainName: draft.mainName,
      fields: { platform: draft.platform as IntakePreviewRequest['fields']['platform'], title: draft.title, collectedAt: draft.collectedAt,
        ...(draft.author ? { author: draft.author } : {}), ...(draft.url ? { url: draft.url } : {}) } };
    const expected = version.current;
    await run(async () => {
      const result = await intake.preview(request);
      if (!mounted.current || expected !== version.current) return;
      if (result.ok) setPreview(result.value); else setError(message(result));
    });
  }
  async function archive(token: string, resume = false) {
    if (!intake) return;
    const confirmed = !resume && preview?.token === token ? preview : undefined;
    await run(async () => {
      const result = await (resume ? intake.resume(token) : intake.commit(token));
      if (!mounted.current) return;
      if (result.ok) {
        // target is an archive directory. Only the confirmed preview identifies its main Markdown.
        if (confirmed && confirmed.target === result.value.target) archiveMainFiles.current.set(result.value.id, `${confirmed.target}/${confirmed.mainName}`);
        setArchivedPath(result.value.state === 'archived' ? archiveMainFiles.current.get(result.value.id) : undefined);
        setOutcome(result.value); setPreview(undefined);
        if (result.value.state === 'archived' && !resume) {
          if (draft) editedDrafts.current.delete(draft.name);
          setDraft(undefined);
        }
      }
      else setError(message(result));
      await load(); void refreshHealth();
    });
  }
  const candidates = data?.items.find((item) => item.name === draft?.name)?.mainCandidates ?? [];
  const existingFields = data?.items.find((item) => item.name === draft?.name)?.fields;
  const pending = data?.operations.filter((op) => op.state !== 'archived') ?? [];
  const step = preview ? 1 : 0;
  return <div className="intake-page">
    <div className="intake-toolbar" aria-label="收件规则">
      <span className={`intake-connection${listError || data?.available === false ? ' intake-connection--warning' : ''}`}>
        <i aria-hidden="true" />{loading ? '正在连接' : listError ? '检测中断' : data?.available ? '正在接收' : '尚未连接'}
      </span>
      <span className="intake-toolbar__hint">自动识别 · 预览整理 · 确认后归档</span>
      {window.xiaozhaoDesktop?.installClipperHost && <Link className="intake-clipper-link" to="/settings#browser-clipper">浏览器收藏设置<ArrowRight aria-hidden="true" /></Link>}
      <button ref={refreshButton} type="button" className="intake-refresh" aria-label="刷新收件箱" title="刷新收件箱" disabled={interactionBusy || refreshing} onClick={() => void load()}>
        <RefreshCw className={refreshing ? 'intake-spin' : undefined} aria-hidden="true" />
      </button>
    </div>
    <IntakeFileImport api={api} onArchived={() => { void load(); void refreshHealth(); }} />
    {(error || listError) && <div role="alert" className="intake-notice intake-notice--warning">{error || listError}</div>}
    {outcome && <div role="status" className={`intake-notice${outcome.state === 'archived' ? '' : ' intake-notice--warning'}`}>
      {outcome.state === 'archived' ? (outcome.indexed ? '归档完成，已更新资料列表。知识状态：未提炼。' : '文件已归档，资料列表刷新尚未完成。请刷新列表，不要重复导入。') : '归档需要继续核验。原文件与恢复记录都已保留；下方可以继续处理。'}
      {outcome.target && <small>{outcome.target}</small>}
      {outcome.state === 'archived' && <div className="intake-next-actions">
        {archivedPath ? <Link to={extractionHref(archivedPath)}>提炼这份<ArrowRight aria-hidden="true" /></Link>
          : <Link to={`/library?${new URLSearchParams({ mode: 'source', folder: outcome.target.replace(/^01图书馆\//u, '') })}`}>查看已归档资料<ArrowRight aria-hidden="true" /></Link>}
        <button type="button" disabled={interactionBusy} onClick={() => { continueFocus.current = true; setOutcome(undefined); setArchivedPath(undefined); setMailboxOpen(true); }}>继续整理</button>
      </div>}
    </div>}
    {loading && <div className="intake-system-state" role="status"><RefreshCw className="intake-spin" aria-hidden="true" /><p>正在读取收件箱…</p></div>}
    {!loading && (!intake || !data || data.available === false) && <div className="intake-system-state" role="status"><ShieldCheck aria-hidden="true" /><h2>收件暂未连接</h2><p>{data?.problem ?? (listError ? '连接恢复后，刷新即可继续整理资料。' : '当前连接只提供读取，请使用新版个人桌面 App。')}</p></div>}
    {data?.available && <>
      {data.problem && <p className="intake-notice intake-notice--warning">{data.problem}</p>}
      {pending.length > 0 && <p className="intake-notice intake-notice--warning">有 {pending.length} 项归档待核验，请先处理下方的恢复记录。</p>}
      <>
      <IntakeMailbox open={mailboxOpen} count={data.items.length} busy={interactionBusy} supportsDirectImport={Boolean(api.attachments)}
        onOpen={() => setMailboxOpen(true)} onClose={closeMailbox}>
      <div ref={trayLayout} className={`intake-layout${draft ? ' intake-layout--selected' : ''}`}>
        <IntakeTray items={data.items} selectedName={draft?.name ?? ''} busy={interactionBusy} supportsDirectImport={Boolean(api.attachments)} onSelect={select}
          {...(trash.available ? { onTrash: (item: IntakeList['items'][number]) => {
            if (!busyRef.current && !trashBlockRef.current) trash.open({ name: item.name, title: item.fields.title || item.name });
          } } : {})} />
        {draft && <section key={draft.name} className="intake-editor intake-editor--active" aria-label="归档预览">
          <header className="intake-editor__heading">
            <div><p>ARCHIVE SLIP</p><h2 ref={detailHeading} tabIndex={-1}>整理这份资料</h2></div>
            <button type="button" className="intake-close" aria-label="关闭归档预览" title="关闭 · Esc" disabled={interactionBusy} onClick={close}><X aria-hidden="true" /></button>
          </header>
          <ol className="intake-steps" aria-label="归档步骤">{['核对信息', '预览归档', '完成'].map((label, index) => <li key={label} aria-current={index === step ? 'step' : undefined} data-complete={index < step}>{label}</li>)}</ol>
          <p className="intake-draft-boundary" role="note">尚未归档的整理内容只保留在当前页面；离开前请先预览并确认归档。</p>
          <form key={draft.name} onSubmit={(event) => { event.preventDefault(); void showPreview(); }}>
            <fieldset disabled={interactionBusy} className="intake-fields">
              <label>原始标题<input required maxLength={500} value={draft.title} onChange={(event) => change({ title: event.target.value })} /></label>
              <div className="intake-field-pair"><label>来源平台<select aria-label="来源平台" required value={draft.platform} onChange={(event) => change({ platform: event.target.value })}><option value="">请选择来源</option>{intakePlatforms.map((platform) => <option key={platform}>{platform}</option>)}</select></label>
                <label>采集日期<input type="date" required value={draft.collectedAt} onChange={(event) => change({ collectedAt: event.target.value })} /></label></div>
              <label>主 Markdown<select aria-label="主 Markdown" required value={draft.mainName} onChange={(event) => change({ mainName: event.target.value })}><option value="">请选择主文件</option>{candidates.map((name) => <option key={name}>{name}</option>)}</select></label>
              <details className="intake-provenance"><summary>作者与原始链接<ChevronDown aria-hidden="true" /></summary><div>
              <label>作者（可留空）<input readOnly={Boolean(existingFields?.author)} maxLength={1000} value={draft.author} onChange={(event) => change({ author: event.target.value })} /></label>
              <label>原始链接（可留空）<input readOnly={Boolean(existingFields?.url)} maxLength={4000} value={draft.url} onChange={(event) => change({ url: event.target.value })} /></label>
              {(existingFields?.author || existingFields?.url) && <small>已有作者和原始链接会原样保留；空缺时才可补充。</small>}
              </div></details>
            </fieldset>
            {!preview && <p className="intake-destination-hint"><FolderOpen aria-hidden="true" />归档位置将在预览时确认</p>}
            <button type="submit" className="intake-preview-button" disabled={interactionBusy || pending.length > 0}>{busy ? '正在核验…' : '预览归档结果'}<ArrowRight aria-hidden="true" /></button>
          </form>
          {preview && <div className="intake-preview"><h3 ref={previewHeading} tabIndex={-1}>将归档到</h3><p className="intake-preview__path"><FolderOpen aria-hidden="true" /><span>{preview.target}/{preview.mainName}</span></p><pre aria-label="整理后的 Markdown">{preview.markdown}</pre>{preview.truncated && <small>此处仅显示前 30,000 字符，归档会保留完整原文。</small>}<p>只更新资料信息；原 Markdown 另有恢复副本。</p><button type="button" className="intake-confirm" disabled={busy} onClick={() => void archive(preview.token)}><Archive aria-hidden="true" />{busy ? '正在归档…' : '确认归档'}</button></div>}
          <p className="intake-preserve"><ShieldCheck aria-hidden="true" />原文与附件保留</p>
        </section>}
      </div>
      </IntakeMailbox>
      <section className="intake-history" aria-label="归档记录"><header><h2>{pending.length ? '归档与恢复' : '最近归档'}</h2><span>ARCHIVE HISTORY</span></header>
        {data.operations.length ? <ul>{data.operations.map((op) => <li key={op.id}>
          <details open={op.state !== 'archived'}><summary><FileText aria-hidden="true" /><strong>{op.target.split('/').filter(Boolean).at(-1) || '归档记录'}</strong><span className={`intake-history__state${op.state !== 'archived' ? ' intake-history__state--pending' : ''}`}><i aria-hidden="true" />{op.state === 'archived' ? '已归档' : '待核验'}</span><span className="intake-history__view">查看记录</span><ChevronDown aria-hidden="true" /></summary>
            <div className="intake-history__detail"><span>{op.state === 'archived' ? '文件已归档' : '归档待核验'}</span><p>{op.target}</p><small>记录编号 · {op.id}</small></div>
          </details>
          {op.state !== 'archived' && <button type="button" className="intake-resume" disabled={busy} onClick={() => void archive(op.id, true)}>继续核验归档<ArrowRight aria-hidden="true" /></button>}
        </li>)}</ul> : <p className="intake-history__empty">完成归档后，记录会留在这里。</p>}
      </section>
      </>
      <p className="intake-boundary"><ShieldCheck aria-hidden="true" />只整理文件名和资料信息，保留原文与附件。归档不等于提炼，也不会写入知识库。</p>
    </>}
    {trash.dialog}
  </div>;
}
