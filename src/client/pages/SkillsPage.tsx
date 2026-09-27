import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, FileText, Folder, FolderOpen, FolderPlus, MoreHorizontal, RefreshCw, Search, X } from 'lucide-react';
import type {
  ApiClientResult,
  ClientFailureState,
  SkillDetail,
  SkillsPage as SkillsPageData
} from '../api/client.js';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import { PageState } from '../components/PageState.js';
import { SafeMarkdown } from '../components/SafeMarkdown.js';
import { SkillFolderTrash } from '../components/SkillFolderTrash.js';
import { isCancelled, type PageResource } from './pageSupport.js';
import '../styles/skills.css';

type SkillSummary = SkillsPageData['items'][number];
type DetailResource = PageResource<SkillDetail>;

function SkillCard({ skill, folders, busy, moving, revealing, onOpen, onMove, onReveal }: {
  skill: SkillSummary;
  folders: SkillsPageData['folders'];
  busy: boolean;
  moving: boolean;
  revealing: boolean;
  onOpen: (skill: SkillSummary, trigger: HTMLButtonElement) => void;
  onMove: ((skill: SkillSummary, target: string) => Promise<void>) | undefined;
  onReveal: ((id: string) => Promise<void>) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!actionsRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return <article className="skills-card">
    <div className="skills-card__topline">
      <span className="skills-card__icon" aria-hidden="true"><FileText size={20} strokeWidth={1.6} /></span>
      <span className="skills-card__folder" title={skill.folderName ?? '未分类'}>{skill.folderName ?? '未分类'}</span>
      {(onMove || onReveal) && <div className="skills-card__actions" ref={actionsRef} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
        <button ref={triggerRef} type="button" className="skills-icon-button" aria-label={`更多操作：${skill.name}`} title="更多操作" aria-expanded={open} aria-controls={`skill-actions-${skill.id}`} disabled={busy} onClick={() => setOpen(value => !value)}><MoreHorizontal size={18} /></button>
        {open && <div className="skills-card__popover" id={`skill-actions-${skill.id}`} data-escape-layer>
          {onReveal && <button type="button" className="skills-card__reveal" onClick={() => void onReveal(skill.id)} disabled={revealing} aria-label={`在 Finder 中打开：${skill.name}`}><FolderOpen size={15} />{revealing ? '正在打开…' : '在 Finder 中打开'}</button>}
          {onMove && <label className="skills-card__move">移动到文件夹<select aria-label={`移动到：${skill.name}`} value={skill.folderId ?? ''} disabled={moving || busy} onChange={(event) => void onMove(skill, event.target.value)}><option value="">未分类</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>}
        </div>}
      </div>}
    </div>
    <h3 title={skill.name}>{skill.name}</h3>
    <p className="skills-card__description">{skill.description}</p>
    <div className="skills-card__footer"><code>版本 {skill.revision.slice(0, 8)}</code><button id={`skill-open-${skill.id}`} type="button" disabled={busy} onClick={(event) => onOpen(skill, event.currentTarget)} aria-label={`查看方法：${skill.name}`}>查看方法<ArrowRight size={14} aria-hidden="true" /></button></div>
  </article>;
}

function unavailableState(): ClientFailureState {
  return {
    status: 'operation-error',
    message: '当前连接不提供 Skill 库。'
  };
}

function failureState<T>(result: ApiClientResult<T>, fallback: string): ClientFailureState {
  if (!result.ok && !isCancelled(result)) {
    if (result.code === 'SKILL_CATALOG_UNAVAILABLE') return unavailableState();
    return {
      status: result.state.status,
      message: result.state.message || fallback
    };
  }
  return { status: 'operation-error', message: fallback };
}

function resourceData<T>(resource: PageResource<T>): T | undefined {
  return 'data' in resource ? resource.data : undefined;
}

function pageStateForResource<T>(resource: PageResource<T>): Extract<PageResource<T>, { status: 'loading' | 'refreshing' | 'failed' }> | undefined {
  if (resource.status === 'loading' || resource.status === 'refreshing' || resource.status === 'failed') return resource;
  return undefined;
}

export function SkillsPage() {
  const { api } = useConsoleRuntime();
  const skillsApi = api.skills;
  const [listResource, setListResource] = useState<PageResource<SkillsPageData>>({ status: 'loading' });
  const [selected, setSelected] = useState<SkillSummary>();
  const [detailResource, setDetailResource] = useState<DetailResource>();
  const [detailRetryToken, setDetailRetryToken] = useState(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const [folderId, setFolderId] = useState<string | null>('all');
  const [query, setQuery] = useState('');
  const [folderFormOpen, setFolderFormOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [mutationError, setMutationError] = useState<string>();
  const [folderSubmitting, setFolderSubmitting] = useState(false);
  const [folderTrashBusy, setFolderTrashBusy] = useState(false);
  const [selectedFolderIds, setSelectedFolderIds] = useState<string[]>([]);
  const [movingId, setMovingId] = useState<string>();
  const pendingFolderIdRef = useRef<string | undefined>(undefined);
  const [revealingId, setRevealingId] = useState<string>();
  const [revealStatus, setRevealStatus] = useState<string | undefined>(undefined);
  const listControllerRef = useRef<AbortController | null>(null);
  const detailControllerRef = useRef<AbortController | null>(null);
  const selectedButtonRef = useRef<HTMLButtonElement | null>(null);
  const detailRetryButtonRef = useRef<HTMLButtonElement | null>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const mountedRef = useRef(true);
  const mutationControllersRef = useRef<Set<AbortController>>(new Set());

  const refresh = useCallback(() => {
    setRefreshToken((value) => value + 1);
  }, []);
  const onFolderTrashChanged = useCallback((restoredFolderId: string | null) => {
    setFolderId(restoredFolderId);
    setQuery('');
    pendingFolderIdRef.current = restoredFolderId ?? undefined;
    refresh();
  }, [refresh]);

  useEffect(() => {
    listControllerRef.current?.abort();
    const controller = new AbortController();
    listControllerRef.current = controller;
    const previous = resourceData(listResource);
    setListResource(previous === undefined ? { status: 'loading' } : { status: 'refreshing', data: previous });

    if (skillsApi === undefined) {
      setListResource({ status: 'failed', state: unavailableState() });
      return () => controller.abort();
    }

    void skillsApi.list(controller.signal)
      .then((result) => {
        if (controller.signal.aborted || isCancelled(result)) return;
        if (!result.ok) {
          setListResource({ status: 'failed', state: failureState(result, 'Skill 目录暂时无法读取，请重试。'), ...(previous === undefined ? {} : { data: previous }) });
          return;
        }
        setListResource({ status: 'ready', data: result.value });
        setSelectedFolderIds(current => current.filter(id => result.value.folders.some(folder => folder.id === id)));
        setFolderId(current => current && current !== 'all' && !result.value.folders.some(folder => folder.id === current) ? 'all' : current);
        if (pendingFolderIdRef.current !== undefined && (result.value.folders ?? []).some((folder) => folder.id === pendingFolderIdRef.current)) {
          setFolderId(pendingFolderIdRef.current);
          pendingFolderIdRef.current = undefined;
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setListResource({ status: 'failed', state: { status: 'disconnected', message: 'Skill 目录暂时无法读取，请重试。' }, ...(previous === undefined ? {} : { data: previous }) });
        }
      });

    return () => controller.abort();
  }, [refreshToken, skillsApi]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      listControllerRef.current?.abort();
      detailControllerRef.current?.abort();
      mutationControllersRef.current.forEach((controller) => controller.abort());
      mutationControllersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    detailControllerRef.current?.abort();
    if (selected === undefined) {
      setDetailResource(undefined);
      return;
    }
    if (skillsApi === undefined) {
      setDetailResource({ status: 'failed', state: unavailableState() });
      return;
    }
    const controller = new AbortController();
    detailControllerRef.current = controller;
    setDetailResource({ status: 'loading' });
    void skillsApi.get(selected.id, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || isCancelled(result)) return;
        if (!result.ok) {
          setDetailResource({ status: 'failed', state: failureState(result, 'Skill 方法暂时无法读取，请重试。') });
          return;
        }
        setDetailResource({ status: 'ready', data: result.value });
        queueMicrotask(() => detailHeadingRef.current?.focus({ preventScroll: true }));
      })
      .catch(() => {
        if (!controller.signal.aborted) setDetailResource({ status: 'failed', state: { status: 'disconnected', message: 'Skill 方法暂时无法读取，请重试。' } });
      });
    return () => controller.abort();
  }, [detailRetryToken, selected, skillsApi]);

  useEffect(() => {
    if (detailResource?.status === 'failed') detailRetryButtonRef.current?.focus({ preventScroll: true });
  }, [detailResource]);

  useEffect(() => {
    if (selected === undefined && selectedButtonRef.current) {
      document.getElementById(selectedButtonRef.current.id)?.focus({ preventScroll: true });
      selectedButtonRef.current = null;
    }
  }, [selected]);

  const listData = resourceData(listResource);
  const showListState = pageStateForResource(listResource);
  const detailData = detailResource?.status === 'ready' ? detailResource.data : undefined;
  const displayedSkill = detailData ?? selected;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const folderItems = listData?.items.filter(item => folderId === 'all' || item.folderId === folderId) ?? [];
  const visibleItems = folderItems.filter(item => `${item.name} ${item.description}`.toLocaleLowerCase().includes(normalizedQuery));

  function openDetail(skill: SkillSummary, trigger: HTMLButtonElement): void {
    selectedButtonRef.current = trigger;
    setSelected(skill);
  }

  function closeDetail(): void {
    setSelected(undefined);
    setDetailResource(undefined);
  }

  function retryDetail(): void {
    if (selected !== undefined) setDetailRetryToken((value) => value + 1);
  }

  const canWrite = skillsApi?.createFolder !== undefined && skillsApi.move !== undefined;
  const canRecycle = !!(skillsApi?.previewFolderTrash && skillsApi.trashFolder && skillsApi.listFolderTrash && skillsApi.restoreFolder);
  const selectableFolders = listData?.folders ?? [];
  const allFoldersSelected = selectableFolders.length > 0 && selectableFolders.every(folder => selectedFolderIds.includes(folder.id));
  useEffect(() => { setSelectedFolderIds([]); }, [skillsApi, selected]);
  function selectFolder(id: string | null) { setFolderId(id); setSelectedFolderIds([]); setQuery(''); }
  function refreshCatalog() { setSelectedFolderIds([]); refresh(); }
  const revealSkill = typeof window !== 'undefined' ? window.xiaozhaoDesktop?.revealSkill : undefined;

  function validateFolderName(value: string): string | undefined {
    const name = value.trim();
    if (!name) return '请输入文件夹名称。';
    if (new TextEncoder().encode(name).byteLength > 255) return '文件夹名称不能超过 255 个 UTF-8 字节。';
    if (/[\\/]/u.test(name)) return '文件夹名称不能包含 / 或 \\。';
    if (/^\./u.test(name)) return '文件夹名称不能是隐藏名。';
    if (/[\u0000-\u001f\u007f]/u.test(name)) return '文件夹名称不能包含控制字符。';
    if (/^(scripts|env)$/iu.test(name)) return '这个名称不能使用。';
    return undefined;
  }

  async function submitFolder(): Promise<void> {
    if (!skillsApi?.createFolder || folderSubmitting || !mountedRef.current) return;
    const validation = validateFolderName(folderName);
    if (validation) { setMutationError(validation); return; }
    setMutationError(undefined);
    setFolderSubmitting(true);
    const controller = new AbortController();
    mutationControllersRef.current.add(controller);
    try {
      const result = await skillsApi.createFolder(folderName.trim(), controller.signal);
      if (!mountedRef.current) return;
      if (!result.ok) { if (isCancelled(result)) return; setMutationError(result.state.message || '创建文件夹失败，请重试。'); return; }
      setFolderFormOpen(false); setFolderName(''); setQuery(''); pendingFolderIdRef.current = result.value.id; refresh();
    } catch {
      if (mountedRef.current) setMutationError('创建文件夹失败，请重试。');
    } finally {
      mutationControllersRef.current.delete(controller);
      if (mountedRef.current) setFolderSubmitting(false);
    }
  }

  async function moveSkill(skill: SkillSummary, target: string): Promise<void> {
    if (!skillsApi?.move || movingId !== undefined || target === (skill.folderId ?? '')) return;
    setMovingId(skill.id); setMutationError(undefined);
    const controller = new AbortController();
    mutationControllersRef.current.add(controller);
    try {
      const result = await skillsApi.move(skill.id, target || null, controller.signal);
      if (!mountedRef.current) return;
      setMovingId(undefined);
      if (!result.ok) { if (isCancelled(result)) return; setMutationError('移动失败，请刷新后重试。'); return; }
      refresh();
    } catch {
      if (mountedRef.current) { setMovingId(undefined); setMutationError('移动失败，请刷新后重试。'); }
    } finally {
      mutationControllersRef.current.delete(controller);
    }
  }

  async function reveal(skillId: string): Promise<void> {
    if (!revealSkill) return;
    setRevealingId(skillId); setRevealStatus(undefined);
    try { await revealSkill(skillId); setRevealStatus('已在 Finder 中打开。'); }
    catch { setRevealStatus('无法在 Finder 中打开，请重试。'); }
    finally { setRevealingId(undefined); }
  }

  return (
    <section className="skills-page" aria-label="Skill 库">
      {!selected && <header className="skills-page__toolbar">
        <div className="skills-search">
          <Search size={17} aria-hidden="true" />
          <input type="search" aria-label="搜索 Skill" placeholder="搜索名称或描述…" value={query} disabled={folderTrashBusy} onChange={event => setQuery(event.target.value)} />
          {query && <button type="button" className="skills-icon-button" aria-label="清除搜索" disabled={folderTrashBusy} onClick={() => setQuery('')}><X size={15} /></button>}
        </div>
        <div className="skills-page__actions">
          {canWrite && <button type="button" className="skills-page__refresh skills-page__create" disabled={folderTrashBusy} onClick={() => { setFolderFormOpen(true); setMutationError(undefined); }}><FolderPlus size={16} aria-hidden="true" />新建文件夹</button>}
          <button type="button" className="skills-icon-button" aria-label="刷新 Skill 库" title="刷新 Skill 库" disabled={folderTrashBusy || listResource.status === 'loading' || listResource.status === 'refreshing'} onClick={refreshCatalog}><RefreshCw size={17} className={listResource.status === 'refreshing' ? 'skills-spin' : undefined} /></button>
        </div>
      </header>}

      {selected ? (
        <article className="skills-detail" aria-labelledby="skill-detail-title">
          <button type="button" className="skills-back" onClick={closeDetail}>
            <ArrowLeft size={16} aria-hidden="true" />返回 Skill 库
          </button>
          <div className="skills-detail__heading">
            <div>
              <p className="skills-page__eyebrow">SKILL / METHOD NOTE</p>
              <h2 id="skill-detail-title" ref={detailHeadingRef} tabIndex={-1}>{displayedSkill?.name ?? selected.name}</h2>
              <p>{displayedSkill?.description ?? selected.description}</p>
            </div>
            <code>版本 {(displayedSkill?.revision ?? selected.revision).slice(0, 8)}</code>
            {revealSkill && <button type="button" className="skills-page__refresh" onClick={() => void reveal(selected.id)} disabled={revealingId === selected.id}>{revealingId === selected.id ? '正在打开…' : '在 Finder 中打开'}</button>}
          </div>
          {revealStatus && <div className="skills-mutation-status" role="status">{revealStatus}</div>}
          {detailResource?.status === 'loading' && <PageState state={{ status: 'loading', message: '正在读取 Skill 方法。' }} />}
          {detailResource?.status === 'failed' && <div className="skills-detail__error"><PageState state={detailResource.state} /><button ref={detailRetryButtonRef} type="button" onClick={retryDetail}>重新读取 Skill 方法</button></div>}
          {detailResource?.status === 'ready' && <>
            <div className="skills-detail__readonly"><FileText size={15} />以下内容来自本地 <code>SKILL.md</code>，当前仅供阅读。</div>
            <section className="skills-detail__body" aria-label="Skill 方法正文"><SafeMarkdown>{detailResource.data.markdown}</SafeMarkdown></section>
            <section className="skills-references" aria-labelledby="skill-references-title">
              <h3 id="skill-references-title">配套参考文档</h3>
              {detailResource.data.references.length > 0 ? <ul>{detailResource.data.references.map((reference) => <li key={reference}><code>{reference}</code></li>)}</ul> : <p>这个 Skill 没有可读取的配套 Markdown 文档。</p>}
            </section>
          </>}
        </article>
      ) : (
        <>
          {mutationError && <div className="skills-mutation-error" role="alert">{mutationError}</div>}
          {revealStatus && <div className="skills-mutation-status" role="status">{revealStatus}</div>}
          {folderFormOpen && <form className="skills-folder-form" onSubmit={(event) => { event.preventDefault(); void submitFolder(); }}>
            <label htmlFor="skills-folder-name">文件夹名称</label>
            <input id="skills-folder-name" value={folderName} onChange={(event) => setFolderName(event.target.value)} autoFocus />
            <button type="submit" disabled={folderSubmitting || folderTrashBusy}>{folderSubmitting ? '正在保存…' : '保存文件夹'}</button><button type="button" disabled={folderSubmitting || folderTrashBusy} onClick={() => { setFolderFormOpen(false); setFolderName(''); setMutationError(undefined); }}>取消</button>
          </form>}
          <div className="skills-organization">
          {listResource.status === 'ready' && listData !== undefined && <nav className="skills-folders" aria-label="Skill 文件夹">
            <button type="button" disabled={folderTrashBusy} aria-pressed={folderId === 'all'} onClick={() => selectFolder('all')}>全部 <span>{listData.items.length}</span></button>
            <button type="button" disabled={folderTrashBusy} aria-pressed={folderId === null} onClick={() => selectFolder(null)}>未分类 <span>{listData.items.filter((item) => item.folderId === null).length}</span></button>
            {(listData.folders ?? []).map((folder) => <div className="skills-folder-choice" key={folder.id}>{canRecycle && <input type="checkbox" aria-label={`选择文件夹：${folder.name}`} checked={selectedFolderIds.includes(folder.id)} disabled={folderTrashBusy || folderSubmitting || movingId !== undefined} onChange={event => setSelectedFolderIds(ids => event.target.checked ? [...ids, folder.id] : ids.filter(id => id !== folder.id))} />}<button type="button" disabled={folderTrashBusy} aria-pressed={folderId === folder.id} onClick={() => selectFolder(folder.id)}><Folder size={13} aria-hidden="true" />{folder.name} <span>{folder.skillCount}</span></button></div>)}
          </nav>}
          {skillsApi && <SkillFolderTrash api={skillsApi} selectedFolders={selectableFolders.filter(folder => selectedFolderIds.includes(folder.id))} onSelectionChange={setSelectedFolderIds} folder={listData?.folders.find(folder => folder.id === folderId)} revision={refreshToken} disabled={folderSubmitting || movingId !== undefined || listResource.status !== 'ready'} onChanged={onFolderTrashChanged} onMutationChange={setFolderTrashBusy} />}
          {canRecycle && selectableFolders.length > 0 && <div className="skills-folder-selection"><span>已选 {selectedFolderIds.length} 个文件夹</span><button type="button" disabled={folderTrashBusy || folderSubmitting || movingId !== undefined || listResource.status !== 'ready'} onClick={() => setSelectedFolderIds(allFoldersSelected ? [] : selectableFolders.map(folder => folder.id))}>{allFoldersSelected ? '取消全选文件夹' : '全选文件夹'}</button><span>勾选分类可批量回收；未分类不在范围内。</span></div>}
          </div>
          {showListState?.status === 'loading' && <PageState state={{ status: 'loading', message: '正在读取本地 Skill 目录。' }} />}
          {showListState?.status === 'refreshing' && <PageState state={{ status: 'refreshing', message: '正在刷新本地 Skill 目录。' }} />}
          {showListState?.status === 'failed' && <div className="skills-list__error"><PageState state={showListState.state} /><button type="button" onClick={refreshCatalog}>重新读取 Skill 库</button>{showListState.state.message === '当前连接不提供 Skill 库。' && <p>请使用支持本地文件 Skill 的桌面连接。</p>}</div>}
          {listData && <div className="skills-list-heading"><span>{normalizedQuery ? `找到 ${visibleItems.length} 个 Skill` : `${folderId === 'all' ? '全部方法' : listData.folders.find(folder => folder.id === folderId)?.name ?? '未分类'} · ${visibleItems.length} 个 Skill`}</span><span className="skills-page__seal">内容只读 · 可整理</span></div>}
          {listResource.status === 'ready' && listData !== undefined && visibleItems.length === 0 && <div className="skills-empty">
            {normalizedQuery ? <><Search size={25} aria-hidden="true" /><h3>没有找到匹配的 Skill</h3><p>换个关键词，或清除搜索查看当前分类。</p><button type="button" className="skills-page__refresh" onClick={() => setQuery('')}>清除搜索</button></> : <><PageState state={{ status: 'empty', message: (folderId === 'all' || folderId === null) && listData.items.length === 0 ? '在 .claude/skills 下添加 Skill 文件夹' : '这里还没有 Skill' }} /><h3>{(folderId === 'all' || folderId === null) && listData.items.length === 0 ? '当前还没有可浏览的 Skill。' : '这里还没有 Skill。'}</h3><p>{(folderId === 'all' || folderId === null) && listData.items.length === 0 ? <>每个 Skill 文件夹需要包含一个 <code>SKILL.md</code>。</> : '可以把 Skill 移动到这个文件夹。'}</p></>}
          </div>}
          {visibleItems.length > 0 && <section className="skills-grid" aria-label="Skill 列表">{visibleItems.map(skill => <SkillCard key={skill.id} skill={skill} folders={listData?.folders ?? []} busy={folderTrashBusy} moving={movingId !== undefined} revealing={revealingId === skill.id} onOpen={openDetail} onMove={skillsApi?.move ? moveSkill : undefined} onReveal={revealSkill ? reveal : undefined} />)}</section>}
          {listData && <p className="skills-page__source"><FolderOpen size={13} aria-hidden="true" />本地目录 <code>.claude/skills</code><span>·</span>打开方法查看完整说明</p>}
        </>
      )}
    </section>
  );
}
