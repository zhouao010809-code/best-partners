import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps, DragEvent, ReactElement } from 'react';
import { ArrowDownToLine, FolderOpen, RefreshCw, Search, UploadCloud } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ProjectImportProposal } from '../../components/company/ProjectImportProposal.js';
import { useCompanyRuntime } from '../../company/CompanyAppShell.js';
import type { CompanyApiResult, CompanyProject, CompanyProjectProposal, CompanyProjectRun } from '../../components/company/company-api.js';
import { isCancelled } from '../pageSupport.js';

type Resource<T> = { status: 'loading' | 'refreshing' | 'ready' | 'failed'; data?: T; message?: string };

const STATUS_LABELS: Record<CompanyProject['status'], string> = {
  draft: '草稿', active: '服务中', acceptance: '验收中', completed: '已完成', paused: '已暂停', archived: '已封存'
};

function sortProjects(items: readonly CompanyProject[]): CompanyProject[] {
  const order: Record<CompanyProject['status'], number> = { active: 0, acceptance: 1, draft: 2, paused: 3, completed: 4, archived: 5 };
  return [...items].sort((left, right) => (order[left.status] - order[right.status]) || right.updatedAt.localeCompare(left.updatedAt));
}

function projectCard(project: CompanyProject): ReactElement {
  return (
    <Link className="company-project-card" to={`/company/projects/${encodeURIComponent(project.id)}`} key={project.id}>
      <div className="company-project-card__top"><span className={`company-status company-status--${project.status}`}>{STATUS_LABELS[project.status]}</span><small>{new Date(project.updatedAt).toLocaleDateString('zh-CN')}</small></div>
      <h2>{project.name}</h2>
      <p>{project.clientName ?? '客户名称待补齐'}</p>
      <dl><div><dt>项目健康</dt><dd>待 Agent 建立基线</dd></div><div><dt>平台数据</dt><dd>尚未接入</dd></div></dl>
    </Link>
  );
}

export function CompanyProjectLibraryPage(): ReactElement {
  const { api } = useCompanyRuntime();
  const [projects, setProjects] = useState<Resource<{ readonly items: readonly CompanyProject[] }>>({ status: 'loading' });
  const [sourceRef, setSourceRef] = useState('');
  const [dragging, setDragging] = useState(false);
  const [scanState, setScanState] = useState<'idle' | 'analyzing' | 'ready' | 'failed'>('idle');
  const [scanResult, setScanResult] = useState<{ readonly run: CompanyProjectRun; readonly proposal: CompanyProjectProposal }>();
  const [scanError, setScanError] = useState<string>();
  const [query, setQuery] = useState('');
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const scanControllerRef = useRef<AbortController | undefined>(undefined);

  const loadProjects = useCallback(async (refresh = false): Promise<void> => {
    setProjects(current => ({ status: refresh ? 'refreshing' : 'loading', ...(current.data === undefined ? {} : { data: current.data }) }));
    const result = await api.projects.list();
    if (!result.ok) {
      if (isCancelled(result)) return;
      setProjects({ status: 'failed', message: result.state.message || '项目库暂时无法读取。' });
      return;
    }
    setProjects({ status: 'ready', data: result.value });
  }, [api]);

  useEffect(() => { void loadProjects(); }, [loadProjects]);

  const visibleProjects = useMemo(() => {
    const items = sortProjects(projects.data?.items ?? []);
    const normalized = query.trim().toLocaleLowerCase();
    return normalized.length === 0 ? items : items.filter(project => `${project.name} ${project.clientName ?? ''}`.toLocaleLowerCase().includes(normalized));
  }, [projects.data, query]);

  function captureFolder(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files.item(0);
    const candidate = file && 'webkitRelativePath' in file ? (file as File & { webkitRelativePath?: string }).webkitRelativePath : undefined;
    const topLevel = candidate?.split('/')[0];
    if (topLevel) setSourceRef(topLevel.startsWith('incoming/') ? topLevel : `incoming/${topLevel}`);
    else setScanError('浏览器只看到了本机文件，未提交文件内容。请先把项目文件夹放入 Mac mini 的 incoming，再填写相对路径。');
  }

  async function scan(): Promise<void> {
    const normalized = sourceRef.trim().replace(/^\/+|\/+$/gu, '');
    if (!normalized) { setScanError('请填写 Mac mini incoming 下的项目文件夹路径。'); sourceInputRef.current?.focus(); return; }
    setScanState('analyzing'); setScanError(undefined); setScanResult(undefined);
    scanControllerRef.current?.abort();
    const controller = new AbortController();
    scanControllerRef.current = controller;
    const result = await api.projects.scan({ incomingPath: normalized }, controller.signal);
    if (!result.ok) {
      if (isCancelled(result)) return;
      setScanState('failed'); setScanError(result.state.message || '项目资料暂时无法分析，请重试。'); return;
    }
    setScanState('ready'); setScanResult({ run: result.value.run, proposal: result.value.proposal });
  }

  async function confirm(input: Parameters<NonNullable<ComponentProps<typeof ProjectImportProposal>['onConfirm']>>[0]): Promise<CompanyApiResult<unknown>> {
    if (scanResult === undefined) return { ok: false, state: { status: 'operation-error', message: '导入提案已失效，请重新分析。' } };
    const result = await api.projects.confirm(scanResult.run.id, input);
    if (result.ok) {
      setScanResult(undefined); setScanState('idle'); await loadProjects(true);
    }
    return result;
  }

  const isEmpty = projects.status === 'ready' && (projects.data?.items.length ?? 0) === 0;
  return (
    <section className="company-page company-project-library" aria-labelledby="company-project-library-title">
      <header className="company-page__heading"><div><p className="company-eyebrow">PROJECTS / FILE-FIRST ARCHIVE</p><h1 id="company-project-library-title">项目档案库</h1><p>每个客户项目有自己的文件夹。先把资料放进 Mac mini 的 incoming，再由 Agent 提案、人工确认。</p></div><button type="button" className="company-secondary-button" onClick={() => void loadProjects(true)} disabled={projects.status === 'loading' || projects.status === 'refreshing'}><RefreshCw size={15} className={projects.status === 'refreshing' ? 'company-spin' : undefined} />刷新</button></header>
      <section className={`company-drop-zone${dragging ? ' is-dragging' : ''}`} onDragEnter={event => { event.preventDefault(); setDragging(true); }} onDragOver={event => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={captureFolder} aria-label="项目文件夹导入区">
        <span className="company-drop-zone__icon" aria-hidden="true"><UploadCloud size={22} /></span><div><h2>把项目文件夹交给 Agent 分析</h2><p>可从 Finder 拖入作为路径提示；文件不会从浏览器上传，也不会直接写入项目库。</p></div><button type="button" className="company-secondary-button" onClick={() => sourceInputRef.current?.focus()}><FolderOpen size={15} />填写 incoming 路径</button>
        <div className="company-source-row"><label>Mac mini incoming 相对路径<input ref={sourceInputRef} aria-label="incoming 文件夹路径" placeholder="incoming/客户A-教育项目" value={sourceRef} onChange={event => setSourceRef(event.target.value)} /></label><button type="button" className="company-primary-button" onClick={() => void scan()} disabled={scanState === 'analyzing'}>{scanState === 'analyzing' ? <><RefreshCw size={15} className="company-spin" />分析中…</> : <><Search size={15} />分析文件夹</>}</button></div>
        {scanError && <p className="company-inline-error" role="alert">{scanError}</p>}
      </section>

      {scanState === 'ready' && scanResult !== undefined && <ProjectImportProposal run={scanResult.run} proposal={scanResult.proposal} onConfirm={confirm} onCancel={() => { setScanResult(undefined); setScanState('idle'); }} />}
      {projects.status === 'failed' && <section className="company-empty-state"><p role="alert">{projects.message ?? '项目库暂时无法读取。'}</p><button type="button" className="company-secondary-button" onClick={() => void loadProjects()}>重新读取</button></section>}
      {projects.status !== 'failed' && scanResult === undefined && <section className="company-library-section" aria-label="项目列表"><div className="company-section-heading"><div><p className="company-eyebrow">ACTIVE PROJECTS</p><h2>全部项目 <span>{projects.data?.items.length ?? '…'}</span></h2></div><label className="company-search-field"><Search size={15} aria-hidden="true" /><span className="visually-hidden">搜索项目</span><input aria-label="搜索项目" placeholder="按项目或客户搜索" value={query} onChange={event => setQuery(event.target.value)} /></label></div>{projects.status === 'loading' && <p className="company-muted">正在读取项目档案…</p>}{isEmpty && <div className="company-empty-state"><FolderOpen size={22} aria-hidden="true" /><h3>还没有已确认项目</h3><p>把第一个项目文件夹放进 incoming，扫描后确认提案即可建立档案。</p></div>}{visibleProjects.length > 0 && <div className="company-project-grid">{visibleProjects.map(projectCard)}</div>}{projects.status === 'ready' && !isEmpty && visibleProjects.length === 0 && <p className="company-muted">没有匹配的项目。</p>}</section>}
    </section>
  );
}
