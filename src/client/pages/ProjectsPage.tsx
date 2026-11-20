import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, FolderKanban, FolderPlus, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
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
        <div><h1 id="projects-title">我的项目</h1><p>点开品牌定位，查看该项目的证据链和核心宣传主张。</p></div>
        <button type="button" className="projects-button projects-button--primary" onClick={() => void addProject()} disabled={scanning || binding}>
          {scanning ? <LoaderCircle size={16} className="projects-spin" aria-hidden="true" /> : <FolderPlus size={16} aria-hidden="true" />}
          {scanning ? '正在扫描…' : '添加项目'}
        </button>
      </header>
      {message !== undefined && <p className="projects-inline-message" role="status">{message}</p>}
      {state === 'loading' && <PageState state={{ status: 'loading', message: '正在读取项目列表。' }} />}
      {state !== 'loading' && (
        <section className="project-register" aria-label="已添加项目">
          <div className="project-register__table-wrap">
            <table className="project-register__table" aria-label="项目品牌总表">
              <colgroup><col className="project-register__name-col" /><col className="project-register__category-col" /><col className="project-register__position-col" /><col /></colgroup>
              <thead><tr>{['项目名', '品类', '品牌定位', '购买理由'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
              <tbody>
                {projects.map(project => {
                  const workspace = `/projects/${encodeURIComponent(project.id)}`;
                  const brand = project.brand;
                  return (
                    <tr key={project.id}>
                      <th scope="row">
                        <Link className="project-register__name" to={workspace}>
                          <FolderKanban size={17} aria-hidden="true" />
                          <span>{project.displayName}</span>
                        </Link>
                        {project.availability !== 'ready' && <small className="project-register__status"><TriangleAlert size={12} aria-hidden="true" />{availabilityLabel(project.availability)}</small>}
                      </th>
                      <td>{brand?.category ? <span className="project-register__category">{brand.category}</span> : <span className="project-register__blank" aria-label="未填写">—</span>}</td>
                      <td>
                        <Link className="project-register__position" to={`${workspace}/brand`} aria-label={`${project.displayName}的品牌定位`}>
                          <span>{brand?.positioning || '填写品牌定位'}</span><ChevronRight size={14} aria-hidden="true" />
                        </Link>
                      </td>
                      <td>{brand?.purchaseReason || <span className="project-register__blank" aria-label="未填写">—</span>}</td>
                    </tr>
                  );
                })}
                {projects.length === 0 && (
                  <tr><td colSpan={4}>
                    <div className="project-register__empty">
                      <span className="project-register__empty-icon"><FolderKanban size={26} aria-hidden="true" /></span>
                      <h2>添加你的第一个项目</h2>
                      <p>选择本地项目文件夹后，即可填写品牌资料。</p>
                      <button type="button" className="projects-button" onClick={() => void addProject()} disabled={scanning}><FolderPlus size={15} aria-hidden="true" />选择项目文件夹</button>
                    </div>
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="project-register__count">共 {projects.length} 个项目</p>
        </section>
      )}
    </section>
  );
}
