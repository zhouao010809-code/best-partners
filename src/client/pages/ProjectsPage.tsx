import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, FolderKanban, FolderPlus, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import type { ProjectScanPreview, ProjectSummary } from '../../shared/api/projects.js';
import type { ApiClientResult } from '../api/client.js';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import { ProjectBindPreview } from '../components/projects/ProjectBindPreview.js';
import { PageState } from '../components/PageState.js';
import { isCancelled } from './pageSupport.js';
import '../styles/projects.css';

function failureMessage(result: ApiClientResult<unknown>, fallback: string): string {
  return !result.ok && !isCancelled(result) ? result.state.message || fallback : fallback;
}

function availabilityLabel(value: ProjectSummary['availability']): string {
  switch (value) {
    case 'ready': return '已连接';
    case 'scanning': return '扫描中';
    case 'unavailable': return '暂时不可用';
    case 'reconnect-required': return '需要重新连接';
  }
}

export function ProjectsPage() {
  const { api } = useConsoleRuntime();
  const navigate = useNavigate();
  const projectsApi = api.projects;
  const [projects, setProjects] = useState<readonly ProjectSummary[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'failed' | 'refreshing'>('loading');
  const [message, setMessage] = useState<string>();
  const [preview, setPreview] = useState<ProjectScanPreview>();
  const [displayName, setDisplayName] = useState('');
  const [binding, setBinding] = useState(false);
  const [scanning, setScanning] = useState(false);
  const listControllerRef = useRef<AbortController | undefined>(undefined);

  const load = useCallback(async (refreshing = false): Promise<void> => {
    listControllerRef.current?.abort();
    const controller = new AbortController();
    listControllerRef.current = controller;
    setState((current) => refreshing || current === 'ready' ? 'refreshing' : 'loading');
    setMessage(undefined);
    if (projectsApi === undefined) {
      setState('failed');
      setMessage('当前连接不提供个人项目。');
      return;
    }
    try {
      const result = await projectsApi.list(controller.signal);
      if (controller.signal.aborted || isCancelled(result)) return;
      if (!result.ok) {
        setState('failed');
        setMessage(failureMessage(result, '项目列表暂时无法读取，请重试。'));
        return;
      }
      setProjects(result.value.projects);
      setState('ready');
    } catch {
      if (!controller.signal.aborted) {
        setState('failed');
        setMessage('项目列表暂时无法读取，请重试。');
      }
    }
  }, [projectsApi]);

  useEffect(() => {
    void load();
    return () => listControllerRef.current?.abort();
  }, [load]);

  async function addProject(): Promise<void> {
    if (scanning || binding) return;
    setMessage(undefined);
    setPreview(undefined);
    const picker = typeof window === 'undefined' ? undefined : window.xiaozhaoDesktop?.chooseProjectDirectory;
    if (picker === undefined) {
      setMessage('当前连接不支持选择项目文件夹，请使用桌面版。');
      return;
    }
    if (projectsApi === undefined) {
      setMessage('当前连接不提供个人项目。');
      return;
    }
    setScanning(true);
    try {
      const selected = await picker();
      if (!selected.selected) {
        if (selected.reason === 'busy') setMessage('已有文件夹选择正在进行，请稍候。');
        else if (selected.reason === 'unavailable') setMessage('所选文件夹暂时不可用，请重新选择。');
        else setMessage('已取消选择，当前项目没有变化。');
        return;
      }
      if (!selected.path) {
        setMessage('没有拿到可用的项目文件夹，请重新选择。');
        return;
      }
      const result = await projectsApi.scan(selected.path);
      if (!result.ok) {
        if (!isCancelled(result)) setMessage(failureMessage(result, '项目扫描未完成，请重新选择。'));
        return;
      }
      setPreview(result.value);
      setDisplayName(result.value.displayName || selected.displayName || '');
    } catch {
      setMessage('项目扫描未完成，请重新选择。');
    } finally {
      setScanning(false);
    }
  }

  async function bindProject(): Promise<void> {
    if (preview === undefined || projectsApi === undefined || binding) return;
    const name = displayName.trim();
    setBinding(true);
    setMessage(undefined);
    try {
      const result = await projectsApi.bind({ scanId: preview.scanId, sourceSha256: preview.sourceSha256, ...(name ? { displayName: name } : {}) });
      if (!result.ok) {
        if (!isCancelled(result)) setMessage(failureMessage(result, '项目绑定未完成，请重试。'));
        return;
      }
      setPreview(undefined);
      navigate(`/projects/${encodeURIComponent(result.value.id)}`);
    } catch {
      setMessage('项目绑定未完成，请重试。');
    } finally {
      setBinding(false);
    }
  }

  if (preview !== undefined) {
    return (
      <section className="projects-page" aria-labelledby="projects-title">
        <header className="projects-page__heading"><div><h1 id="projects-title">添加我的项目</h1><p>选择一个已有项目文件夹即可开始；不需要先填写背景、阶段或目标。</p></div></header>
        {message !== undefined && <p className="projects-inline-message" role="alert">{message}</p>}
        <ProjectBindPreview preview={preview} displayName={displayName} onDisplayNameChange={setDisplayName} onConfirm={() => void bindProject()} onCancel={() => { setPreview(undefined); setDisplayName(''); setMessage('已取消绑定，项目文件夹没有变化。'); }} submitting={binding} />
      </section>
    );
  }

  if (state === 'failed') {
    return <section className="projects-page" aria-labelledby="projects-title"><header className="projects-page__heading"><div><h1 id="projects-title">我的项目</h1><p>连接本地文件夹，围绕项目资料提问和创作。</p></div><button type="button" className="projects-button projects-button--quiet" onClick={() => void load(true)}><RefreshCw size={15} aria-hidden="true" />重新读取</button></header><PageState state={{ status: 'operation-error', message: message ?? '项目列表暂时无法读取。' }} /></section>;
  }

  return (
    <section className="projects-page" aria-labelledby="projects-title">
      <header className="projects-page__heading">
        <div><h1 id="projects-title">我的项目</h1><p>把已有文件夹添加为项目，在里面查看资料、向问问提问，并保存结果。</p></div>
        <button type="button" className="projects-button projects-button--primary" onClick={() => void addProject()} disabled={scanning || binding}>
          {scanning ? <LoaderCircle size={16} className="projects-spin" aria-hidden="true" /> : <FolderPlus size={16} aria-hidden="true" />}
          {scanning ? '正在扫描…' : '添加项目'}
        </button>
      </header>
      {message !== undefined && <p className="projects-inline-message" role="status">{message}</p>}
      {state === 'loading' && <PageState state={{ status: 'loading', message: '正在读取项目列表。' }} />}
      {state !== 'loading' && projects.length === 0 && <section className="projects-empty instrument-panel"><FolderKanban size={28} aria-hidden="true" /><h3>添加你的第一个项目</h3><p>选择电脑上的一个项目文件夹，例如客户资料、课程或创作素材。文件保留在原位置。</p><button type="button" className="projects-button projects-button--primary" onClick={() => void addProject()} disabled={scanning}><FolderPlus size={15} aria-hidden="true" />选择项目文件夹</button></section>}
      {projects.length > 0 && <section className="projects-collection" aria-label="已添加项目">
        <p className="projects-collection__count">共 {projects.length} 个项目</p>
        <div className="projects-list">{projects.map((project) => <Link to={`/projects/${encodeURIComponent(project.id)}`} className="project-list-card" key={project.id}>
          <span className={`project-list-card__icon project-list-card__icon--${project.availability}`}><FolderKanban size={22} aria-hidden="true" /></span>
          <span className="project-list-card__body"><strong>{project.displayName}</strong><small>{project.readableFileCount} 份可阅读资料 · 共 {project.fileCount} 个文件</small></span>
          <span className={`project-list-card__status project-list-card__status--${project.availability}`}>{project.availability === 'reconnect-required' && <TriangleAlert size={14} aria-hidden="true" />}{availabilityLabel(project.availability)}</span>
          <span className="project-list-card__enter">进入项目<ArrowRight size={16} aria-hidden="true" /></span>
        </Link>)}</div>
      </section>}
    </section>
  );
}
