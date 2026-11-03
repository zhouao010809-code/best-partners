import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, BookOpen, CalendarDays, Check, FileText, Film, FolderOpen, HardDrive, Image, Music, Plus, RefreshCw, Search, Sparkles, Upload, X } from 'lucide-react';
import type { WorkdiskFile, WorkdiskImportResult, WorkdiskKind, WorkdiskListRequest, WorkdiskSnapshot } from '../../shared/workdisk.js';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import { WorkdiskPreviewDialog } from '../components/workdisk/WorkdiskPreviewDialog.js';
import { WorkdiskNote } from '../components/workdisk/WorkdiskNote.js';
import { WorkdiskNamingResults } from '../components/workdisk/WorkdiskNamingResults.js';
import { WorkdiskAutoCollection } from '../components/workdisk/WorkdiskAutoCollection.js';
import { localDay, useWorkdiskDate } from '../components/workdisk/useWorkdiskDate.js';
import { WorkdiskThumbnail } from '../components/workdisk/WorkdiskThumbnail.js';
import '../styles/workdisk.css';

const TYPES = [
  { key: 'all', label: '全部', icon: FolderOpen }, { key: 'video', label: '视频', icon: Film },
  { key: 'image', label: '图片', icon: Image }, { key: 'document', label: '文档', icon: FileText },
  { key: 'audio', label: '音频', icon: Music }, { key: 'other', label: '其他', icon: HardDrive }
] as const;
export { localDay } from '../components/workdisk/useWorkdiskDate.js';
function sizeLabel(size: number) {
  return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
}
function errorText(error: unknown) { return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /u, '') : '暂时无法完成，请重试。'; }

export function WorkdiskPage() {
  const { api } = useConsoleRuntime();
  const disk = window.xiaozhaoDesktop?.workdisk;
  const [snapshot, setSnapshot] = useState<WorkdiskSnapshot>();
  const [results, setResults] = useState<WorkdiskSnapshot>();
  const [loading, setLoading] = useState(Boolean(disk));
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [nameFromContent, setNameFromContent] = useState(() => {
    try { return sessionStorage.getItem('workdisk-content-naming') !== 'off'; } catch { return true; }
  });
  const [naming, setNaming] = useState<NonNullable<WorkdiskImportResult['naming']>>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [failures, setFailures] = useState<WorkdiskImportResult['failures']>([]);
  const { today, saveDate, followsToday, chooseDate, followToday, dateForSubmission } = useWorkdiskDate();
  const [browseDate, setBrowseDate] = useState('');
  const [kind, setKind] = useState<WorkdiskKind | 'all'>('all');
  const [query, setQuery] = useState('');
  const [searchDescription, setSearchDescription] = useState('');
  const [writing, setWriting] = useState(false);
  const [previewFile, setPreviewFile] = useState<WorkdiskFile>();
  const [dragging, setDragging] = useState(false);
  const generation = useRef(0);
  const searchAbort = useRef<AbortController | undefined>(undefined);
  const backgroundRefresh = useRef(false);
  const activeSearch = useRef<WorkdiskListRequest | undefined>(undefined);
  const alive = useRef(true);
  const actionLock = useRef(false);

  const refresh = useCallback(async () => {
    if (!disk) return;
    backgroundRefresh.current = false;
    const sequence = ++generation.current;
    setLoading(true);
    try {
      const data = await disk.list();
      if (!alive.current || sequence !== generation.current) return;
      setSnapshot(data); setError(''); setUnavailable(false);
      if (activeSearch.current) {
        const found = await disk.list(activeSearch.current);
        if (alive.current && sequence === generation.current) setResults(found);
      }
    } catch (cause) {
      if (!alive.current || sequence !== generation.current) return;
      setError(errorText(cause)); setUnavailable(true); setNotice(''); setNaming([]);
      // Remembered configuration remains useful even while the disk cannot be read.
      const remembered = await disk.status().catch(() => null);
      if (alive.current && sequence === generation.current && remembered) setSnapshot(current => current?.binding ? current
        : { binding: remembered, files: [], scannedAt: new Date().toISOString(), truncated: false, skippedCount: 0 });
    }
    finally { if (alive.current && sequence === generation.current) setLoading(false); }
  }, [disk]);
  useEffect(() => {
    alive.current = true; void refresh();
    const onFocus = () => { if (!actionLock.current && !searchAbort.current) void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { alive.current = false; generation.current++; searchAbort.current?.abort(); window.removeEventListener('focus', onFocus); };
  }, [refresh]);

  async function runAction(action: () => Promise<void>) {
    if (actionLock.current) return;
    actionLock.current = true; setBusy(true); setError(''); setNotice(''); setFailures([]); setNaming([]);
    try { await action(); } catch (cause) { if (alive.current) setError(errorText(cause)); }
    finally {
      actionLock.current = false;
      if (alive.current) {
        setBusy(false);
        if (backgroundRefresh.current && !searchAbort.current) void refresh();
      }
    }
  }
  function clearSearch() {
    searchAbort.current?.abort(); searchAbort.current = undefined; generation.current++; setLoading(false); setSearching(false);
    activeSearch.current = undefined; setResults(undefined); setSearchDescription('');
  }
  async function connect() {
    if (!disk) return;
    await runAction(async () => {
      const bound = await disk.connect();
      if (!bound) { setNotice('已取消选择'); return; }
      clearSearch(); setBrowseDate(''); setPreviewFile(undefined); setWriting(false);
      setSnapshot({ binding: bound, files: [], scannedAt: new Date().toISOString(), truncated: false, skippedCount: 0 });
      await refresh();
    });
  }
  async function collected(result: WorkdiskImportResult | null, submittedDate: string) {
    if (!result) { setNotice('已取消选择'); return; }
    setFailures(result.failures);
    setNaming(result.naming ?? []);
    setNotice(result.files.length ? `已收好 ${result.files.length} 个文件 · ${submittedDate}` : '没有新增文件');
    clearSearch(); setBrowseDate(submittedDate); setKind('all'); await refresh();
  }
  async function importBatch(load: (date: string) => Promise<WorkdiskImportResult | null>) {
    const submittedDate = dateForSubmission();
    await runAction(async () => {
      setImporting(true);
      try { await collected(await load(submittedDate), submittedDate); } finally { if (alive.current) setImporting(false); }
    });
  }
  async function search() {
    if (!disk || !query.trim()) return;
    searchAbort.current?.abort(); const controller = new AbortController(); searchAbort.current = controller;
    const sequence = ++generation.current;
    setLoading(false); setSearching(true); setError('');
    try {
      const parsed = await api.workdiskSearchPlan?.(query.trim(), localDay(), controller.signal);
      if (controller.signal.aborted || !alive.current || sequence !== generation.current) return;
      const plan = parsed?.ok ? parsed.value.plan : undefined;
      const request: WorkdiskListRequest = { query: query.trim(), ...(plan ? { plan: { terms: plan.terms,
        ...(plan.startDate ? { startDate: plan.startDate } : {}), ...(plan.endDate ? { endDate: plan.endDate } : {}), ...(plan.kind ? { kind: plan.kind } : {}) } } : {}) };
      const found = await disk.list(request);
      if (controller.signal.aborted || !alive.current || sequence !== generation.current) return;
      activeSearch.current = request; setResults(found); setBrowseDate(''); setKind('all');
      setSearchDescription(parsed?.ok && parsed.value.mode === 'ai' ? 'AI 已理解描述，以下是本地匹配结果' : parsed?.ok && parsed.value.message ? parsed.value.message : '正在使用本地查找；可输入文件名或正文中的关键词');
    } catch (cause) { if (!controller.signal.aborted && alive.current) setError(errorText(cause)); }
    finally {
      if (searchAbort.current === controller) searchAbort.current = undefined;
      if (!controller.signal.aborted && alive.current && sequence === generation.current) setSearching(false);
      if (alive.current && backgroundRefresh.current && !searchAbort.current && !actionLock.current) void refresh();
    }
  }
  const inventory = snapshot?.files ?? [];
  const displayed = [...(results?.files ?? inventory)].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || b.path.localeCompare(a.path));
  const filtered = displayed.filter(file => (!browseDate || file.date === browseDate) && (kind === 'all' || file.kind === kind));
  const days = useMemo(() => {
    const counts = new Map<string, number>();
    for (const file of inventory) counts.set(file.date, (counts.get(file.date) ?? 0) + 1);
    if (!counts.has(today)) counts.set(today, 0);
    return [...counts].sort(([a], [b]) => b.localeCompare(a));
  }, [inventory, today]);
  const binding = snapshot?.binding;

  return <div className={`workdisk${dragging ? ' workdisk--dragging' : ''}`}
    onDragOver={event => { if (binding && event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={event => { event.preventDefault(); setDragging(false); const files = Array.from(event.dataTransfer.files);
      if (disk?.importDroppedFiles && files.length && binding) void importBatch(date => disk.importDroppedFiles!(files, date, { nameFromContent })); }}>
    <nav className="workdisk-spaces" aria-label="资料空间">
      <span aria-current="page"><HardDrive size={17} />工作盘<small>每天的工作资料</small></span>
      <Link to="/knowledge"><BookOpen size={17} />知识库<small>长期积累与复用</small><ArrowUpRight size={15} /></Link>
    </nav>
    <section className="workdisk-hero">
      <div><h2>把今天的工作，收好。</h2>
        {binding && <div className="workdisk-location" title={binding.rootPath}>{!unavailable && <span className="workdisk-online" />}<FolderOpen size={14} /><strong>{binding.displayName}</strong><span>{binding.rootPath}</span>{unavailable && <small>暂时未连接</small>}<button disabled={busy || searching} onClick={() => void connect()}>{unavailable ? '重新连接' : '更换'}</button></div>}
      </div>
    </section>
    {error && <p className="workdisk-error" role="alert">{error}<button disabled={busy} onClick={() => void refresh()}>重试读取</button></p>}
    {notice && <p className="workdisk-notice" role="status"><Check size={15} />{notice}</p>}
    {failures.length > 0 && <ul className="workdisk-failures" aria-label="未收好的文件">{failures.map((failure, index) => <li key={`${index}-${failure.name}`}>{failure.name}：{failure.message}</li>)}</ul>}
    {!disk ? <div className="workdisk-empty"><HardDrive /><h3>请在桌面应用中打开工作盘</h3><p>桌面版可以直接连接和保存本地文件。</p></div>
      : !binding ? <div className="workdisk-empty workdisk-connect"><div className="workdisk-folder-art"><FolderOpen size={66} /></div><h3>{loading ? '正在读取工作盘…' : '给每天的工作，选一个家'}</h3><p>连接一个本地文件夹，就能在这里浏览、收纳和查找。<br />已有文件会保留在原来的位置。</p><button className="workdisk-primary" disabled={busy || loading} onClick={() => void connect()}><Plus size={17} />连接本地文件夹</button></div>
      : <>
        <form className="workdisk-search" onSubmit={event => { event.preventDefault(); void search(); }}><Sparkles size={21} /><input type="search" aria-label="描述要找的文件" placeholder="比如：上个月28号的招生文案" maxLength={1000} value={query} onChange={event => setQuery(event.target.value)} /><button type="submit" disabled={!query.trim() || searching || busy}><Search size={16} />{searching ? '正在找…' : '找文件'}</button></form>
        {results && <div className="workdisk-search-info"><span>{searchDescription}<small>“{activeSearch.current?.query}” · 跨全部日期</small></span><button onClick={() => clearSearch()}><X size={14} />退出搜索</button></div>}
        <div className="workdisk-collect"><div><Upload size={21} /><span><strong>拖文件到这里，或点击收文件</strong><small>按日期和类型保存副本</small></span></div>
          <div className="workdisk-save-date"><label>收纳日期 · {followsToday ? '跟随今天' : '指定日期'}<input type="date" aria-label="收纳日期" value={saveDate} onChange={event => chooseDate(event.target.value)} disabled={busy} /></label>{!followsToday && <button disabled={busy} onClick={followToday}>改回今天</button>}</div>
          <button disabled={busy || searching} onClick={() => setWriting(value => !value)}><FileText size={16} />写文案</button>
          <button className="workdisk-primary" disabled={busy || searching} onClick={() => void importBatch(date => disk.importFiles(date, { nameFromContent }))}><Plus size={17} />{importing ? nameFromContent ? '正在命名收纳…' : '正在收纳…' : '收文件'}</button>
        </div>
        <div className="workdisk-naming-option">
          <label><input type="checkbox" checked={nameFromContent} disabled={busy} aria-describedby="workdisk-naming-detail" onChange={event => { const checked = event.target.checked; setNameFromContent(checked); try { sessionStorage.setItem('workdisk-content-naming', checked ? 'on' : 'off'); } catch { /* Current choice still applies. */ } }} /><span>根据内容命名</span><Sparkles size={14} /></label>
          <span id="workdisk-naming-detail">{nameFromContent ? '文字与图片识别结果交给已连接的 AI 起名，原件保留。' : '按原名保存，不会为命名发送正文。'}</span>
          <details className="workdisk-naming-help"><summary>命名说明</summary><p>支持文本、有文字的 PDF 和可识别的图片。可读正文会发送给已连接的 AI，图片先在本机识别文字和画面类别；长文使用节选，未连接或读不出内容时按原名保存。<Link to="/settings">连接 AI</Link></p></details>
        </div>
        {importing && <p className="workdisk-notice" role="status">{nameFromContent ? '正在读取正文、生成名称并保存，完成后会列出原名和新名。' : '正在复制文件到所选日期，原文件会保留。'}</p>}
        {naming.length > 0 && <WorkdiskNamingResults receipts={naming} onClose={() => setNaming([])} />}
        {writing && <WorkdiskNote key={binding.id} bindingId={binding.id} date={saveDate} dateForSubmission={dateForSubmission} disk={disk} onBusy={value => { actionLock.current = value; setBusy(value); }} onClose={() => setWriting(false)} onSaved={async file => { setWriting(false); setNotice(`已保存 ${file.name} · ${file.date}`); clearSearch(); setBrowseDate(file.date); setKind('all'); await refresh(); }} />}
        <WorkdiskAutoCollection disk={disk} disabled={busy} onChanged={() => {
          if (actionLock.current || searchAbort.current) backgroundRefresh.current = true; else void refresh();
        }} />
        <div className="workdisk-content"><aside className="workdisk-days" aria-label="按日期浏览"><div><CalendarDays size={15} /><strong>工作日历</strong></div><button className={!browseDate ? 'is-active' : ''} onClick={() => setBrowseDate('')}>全部日期<span>{displayed.length}</span></button>
          {days.slice(0, 31).map(([day, count]) => <button key={day} className={browseDate === day ? 'is-active' : ''} onClick={() => setBrowseDate(day)}><span>{day === today ? '今天' : `${day.slice(5, 7)}月${day.slice(8)}日`}<small>{day.slice(0, 4)}</small></span><span>{count}</span></button>)}
          <label className="workdisk-date-filter">其他日期<input aria-label="按日期查看" type="date" value={browseDate} onChange={event => setBrowseDate(event.target.value)} /></label>
        </aside><section className="workdisk-files" aria-label="工作文件"><div className="workdisk-list-heading"><h3>{results ? '找到的文件' : browseDate ? `${browseDate} 的工作` : '最近文件'}<span>{filtered.length}</span></h3><button aria-label="刷新工作盘" disabled={loading || searching || busy} onClick={() => void refresh()}><RefreshCw size={15} className={loading ? 'workdisk-spin' : ''} />刷新</button></div>
          <div className="workdisk-types" aria-label="文件类型">{TYPES.map(type => <button key={type.key} aria-pressed={kind === type.key} className={kind === type.key ? 'is-active' : ''} onClick={() => setKind(type.key)}><type.icon size={14} />{type.label}</button>)}</div>
          {(snapshot.truncated || results?.truncated) && <p className="workdisk-limit" role="status">文件较多，本次仅展示部分结果。请连接更具体的工作文件夹。</p>}
          {(results ?? snapshot).skippedCount > 0 && <p className="workdisk-limit">有 {(results ?? snapshot).skippedCount} 项未完整读取（如链接、不可读文件或超出正文读取范围），结果可能不完整。</p>}
          {filtered.length === 0 ? <div className="workdisk-empty workdisk-no-files"><FolderOpen /><h3>{results ? '暂时没有找到匹配文件' : '这里还没有文件'}</h3><p>{results ? '换个主题词，或退出搜索查看全部文件。视频和录音目前按文件信息查找。' : '选择日期收下第一份文件，或切换到全部日期。'}</p></div>
            : <div className="workdisk-grid">{filtered.map(file => {
              const type = TYPES.find(item => item.key === file.kind) ?? TYPES[5];
              return <button key={file.path} disabled={busy} className={`workdisk-card workdisk-card--${file.kind}`} aria-label={`预览 ${file.name}`} onClick={() => setPreviewFile(file)}>
                <WorkdiskThumbnail file={file} disk={disk} bindingId={binding.id}><type.icon size={39} strokeWidth={1.15} /><span>{file.name.split('.').pop()?.slice(0, 8).toUpperCase()}</span></WorkdiskThumbnail>
                <div className="workdisk-card-body"><strong title={file.name}>{file.name}</strong><span>{file.date} · {sizeLabel(file.size)}</span>{file.excerpt && <p>{file.excerpt}</p>}<small title={file.path}>{file.matchedBy === 'content' ? '正文匹配 · ' : ''}{file.path}</small></div>
              </button>;
            })}</div>}
          <p className="workdisk-footnote">文件保存在本地 · 可查文本正文、PDF 文字层和图片文字；视频、录音和 Office 文件按名称与路径查找。内容未完整读取时会提示。</p>
        </section></div>
      </>}
    {previewFile && disk && <WorkdiskPreviewDialog file={previewFile} disk={disk} onClose={() => setPreviewFile(undefined)} />}
    {dragging && <div className="workdisk-drop-hint"><Upload size={38} /><strong>松手，收进 {saveDate}</strong><span>按文件类型分好，原件保留</span></div>}
  </div>;
}
