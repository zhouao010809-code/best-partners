import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, FolderKanban, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import type { ApiClientResult } from '../api/client.js';
import type { ProjectScanPreview, ProjectSummary } from '../../shared/api/projects.js';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import { ProjectBindPreview } from '../components/projects/ProjectBindPreview.js';
import { ProjectFilesPanel } from '../components/projects/ProjectFilesPanel.js';
import { ProjectStatusCard } from '../components/projects/ProjectStatusCard.js';
import { PageState } from '../components/PageState.js';
import { isCancelled } from './pageSupport.js';
import { askAssistant, PROJECT_WORKSPACE_UPDATED_EVENT } from '../components/assistant/assistantIntent.js';
import '../styles/projects.css';

function resultMessage(result: ApiClientResult<unknown>, fallback: string): string {
  return !result.ok && !isCancelled(result) ? result.state.message || fallback : fallback;
}

function reconnectFailureCode(result: ApiClientResult<unknown>): boolean {
  if (result.ok || isCancelled(result)) return false;
  return result.code === 'PROJECT_ROOT_RECONNECT_REQUIRED'
    || result.code === 'PROJECT_ROOT_UNAVAILABLE'
    || result.code === 'PROJECT_NOT_FOUND';
}

export function ProjectWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const { api } = useConsoleRuntime();
  const projectsApi = api.projects;
  const [project, setProject] = useState<ProjectSummary>();
  const [state, setState] = useState<'loading' | 'ready' | 'failed' | 'refreshing'>('loading');
  const [message, setMessage] = useState<string>();
  const [reconnectPreview, setReconnectPreview] = useState<ProjectScanPreview>();
  const [reconnectName, setReconnectName] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [staleNotice, setStaleNotice] = useState(false);
  const [filesRefreshVersion, setFilesRefreshVersion] = useState(0);
  const controllerRef = useRef<AbortController | undefined>(undefined);

  const load = useCallback(async (): Promise<void> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((current) => current === 'ready' ? 'refreshing' : 'loading');
    setMessage(undefined);
    if (!id || projectsApi === undefined) {
      setState('failed');
      setMessage(!id ? '项目编号缺失。' : '当前连接不提供个人项目。');
      return;
    }
    try {
      const result = await projectsApi.get(id, controller.signal);
      if (controller.signal.aborted || isCancelled(result)) return;
      if (!result.ok) {
        setState('failed');
        setMessage(resultMessage(result, '项目工作区暂时无法读取。'));
        return;
      }
      setProject(result.value);
      setState('ready');
    } catch {
      if (!controller.signal.aborted) {
        setState('failed');
        setMessage('项目工作区暂时无法读取。');
      }
    }
  }, [id, projectsApi]);

  useEffect(() => {
    void load();
    return () => controllerRef.current?.abort();
  }, [load]);

  useEffect(() => {
    const refreshFiles = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (!id || detail?.projectId !== id) return;
      setFilesRefreshVersion(value => value + 1);
    };
    window.addEventListener(PROJECT_WORKSPACE_UPDATED_EVENT, refreshFiles);
    return () => window.removeEventListener(PROJECT_WORKSPACE_UPDATED_EVENT, refreshFiles);
  }, [id]);

  async function refreshProject(): Promise<void> {
    if (!id || projectsApi === undefined || project === undefined || refreshing || reconnecting) return;
    setRefreshing(true);
    setMessage(undefined);
    try {
      const result = await projectsApi.refresh(id);
      if (!result.ok) {
        if (isCancelled(result)) return;
        if (reconnectFailureCode(result)) {
          setProject({ ...project, availability: 'reconnect-required' });
          setMessage('项目文件夹已变化，请重新连接；当前项目会话仍保留。');
        } else {
          setMessage(resultMessage(result, '项目索引刷新未完成。'));
        }
        return;
      }
      setProject(result.value);
      setMessage('项目索引已刷新。');
    } catch {
      setMessage('项目索引刷新未完成，请重试。');
    } finally {
      setRefreshing(false);
    }
  }

  async function beginReconnect(): Promise<void> {
    if (!id || projectsApi === undefined || reconnecting) return;
    const picker = typeof window === 'undefined' ? undefined : window.xiaozhaoDesktop?.chooseProjectDirectory;
    if (picker === undefined) {
      setMessage('当前连接不支持选择项目文件夹，请使用桌面版。');
      return;
    }
    setReconnecting(true);
    setMessage(undefined);
    try {
      const selected = await picker();
      if (!selected.selected) {
        if (selected.reason === 'busy') setMessage('已有文件夹选择正在进行，请稍候。');
        else if (selected.reason === 'unavailable') setMessage('所选文件夹暂时不可用，请重新选择。');
        else setMessage('已取消重新连接，当前项目和会话没有变化。');
        return;
      }
      if (!selected.path) {
        setMessage('没有拿到可用的项目文件夹，请重新选择。');
        return;
      }
      const scan = await projectsApi.scan(selected.path);
      if (!scan.ok) {
        if (!isCancelled(scan)) setMessage(resultMessage(scan, '项目扫描未完成，请重新选择。'));
        return;
      }
      setReconnectPreview(scan.value);
      setReconnectName(scan.value.displayName || selected.displayName || project?.displayName || '');
    } catch {
      setMessage('项目扫描未完成，请重新选择。');
    } finally {
      setReconnecting(false);
    }
  }

  async function confirmReconnect(): Promise<void> {
    if (!id || projectsApi === undefined || reconnectPreview === undefined || reconnecting) return;
    const name = reconnectName.trim();
    setReconnecting(true);
    setMessage(undefined);
    try {
      const result = await projectsApi.reconnect(id, {
        scanId: reconnectPreview.scanId,
        sourceSha256: reconnectPreview.sourceSha256,
        ...(name ? { displayName: name } : {})
      });
      if (!result.ok) {
        if (!isCancelled(result)) setMessage(resultMessage(result, '项目重新连接未完成，请重试。'));
        return;
      }
      setProject(result.value);
      setReconnectPreview(undefined);
      setStaleNotice(true);
      // Keep an already-open project AssistantPanel on the same source
      // revision. The panel owns the draft binding, so it must refresh its
      // summary and re-enter the project after reconnect succeeds.
      window.dispatchEvent(new CustomEvent(PROJECT_WORKSPACE_UPDATED_EVENT, { detail: { projectId: id } }));
      setMessage('项目已重新连接；旧的项目写入计划已标记为过期，需要重新确认。');
    } catch {
      setMessage('项目重新连接未完成，请重试。');
    } finally {
      setReconnecting(false);
    }
  }

  if (state === 'failed') {
    return <section className="projects-page" aria-labelledby="project-workspace-title"><Link className="projects-back-link" to="/projects"><ArrowLeft size={15} aria-hidden="true" />返回我的项目</Link><header className="projects-page__heading"><div><p className="projects-eyebrow">PROJECT / LOCAL WORKSPACE</p><h2 id="project-workspace-title">项目工作区</h2></div></header><PageState state={{ status: 'operation-error', message: message ?? '项目工作区暂时无法读取。' }} /><button type="button" className="projects-button projects-button--quiet" onClick={() => void load()}><RefreshCw size={15} aria-hidden="true" />重新读取</button></section>;
  }
  if (state === 'loading' || project === undefined) {
    return <section className="projects-page" aria-labelledby="project-workspace-title"><header className="projects-page__heading"><div><p className="projects-eyebrow">PROJECT / LOCAL WORKSPACE</p><h2 id="project-workspace-title">项目工作区</h2></div></header><PageState state={{ status: 'loading', message: '正在读取项目工作区。' }} /></section>;
  }

  if (reconnectPreview !== undefined) {
    return <section className="projects-page" aria-labelledby="project-workspace-title"><Link className="projects-back-link" to="/projects"><ArrowLeft size={15} aria-hidden="true" />返回我的项目</Link><header className="projects-page__heading"><div><p className="projects-eyebrow">PROJECT / RECONNECT</p><h2 id="project-workspace-title">重新连接 {project.displayName}</h2><p>项目编号和现有问问会话保持不变；请选择新的本地项目文件夹。</p></div></header>{message !== undefined && <p className="projects-inline-message" role="alert">{message}</p>}<ProjectBindPreview preview={reconnectPreview} displayName={reconnectName} onDisplayNameChange={setReconnectName} onConfirm={() => void confirmReconnect()} onCancel={() => { setReconnectPreview(undefined); setReconnectName(''); setMessage('已取消重新连接，当前项目和会话没有变化。'); }} submitting={reconnecting} reconnecting /></section>;
  }

  return (
    <section className="projects-page project-workspace" aria-labelledby="project-workspace-title">
      <Link className="projects-back-link" to="/projects"><ArrowLeft size={15} aria-hidden="true" />返回我的项目</Link>
      <header className="projects-page__heading project-workspace__heading">
        <div><p className="projects-eyebrow">PROJECT / ISOLATED WORKSPACE</p><h2 id="project-workspace-title"><FolderKanban size={22} aria-hidden="true" />{project.displayName}</h2><p>项目语料、项目问问和 AI 工作区各自独立；全局知识库只作为可检索的辅助来源。</p></div>
        <button type="button" className="projects-button projects-button--primary" onClick={() => askAssistant({ prompt: ' ', scope: 'project', projectId: project.id, projectRevision: project.sourceRevision })}>打开项目问问</button>
      </header>
      {message !== undefined && <p className="projects-inline-message" role="status">{message}</p>}
      {staleNotice && <p className="project-stale-notice" role="status"><ShieldCheck size={15} aria-hidden="true" />重新连接后，旧的项目写入计划不会自动执行；请重新确认当前资料。</p>}
      <ProjectStatusCard project={project} onRefresh={() => void refreshProject()} onReconnect={() => void beginReconnect()} refreshing={refreshing} reconnecting={reconnecting} {...(project.availability === 'reconnect-required' ? { message: '请重新选择原项目文件夹或它的新位置。' } : {})} />
      <section className="project-context-strip" aria-label="项目问问范围">
        <div><BookOpen size={16} aria-hidden="true" /><span><strong>项目语料：{project.availability === 'ready' ? '已连接' : project.availability === 'scanning' ? '扫描中' : '需要重新连接'}</strong><small>只读取当前项目文件夹的索引</small></span></div>
        <div><Sparkles size={16} aria-hidden="true" /><span><strong>全局知识库：可检索</strong><small>按本次任务召回相关方法和证据</small></span></div>
        <div><ShieldCheck size={16} aria-hidden="true" /><span><strong>写入范围：{project.displayName} / AI工作区</strong><small>确认后才会生成项目产出</small></span></div>
      </section>
      <ProjectFilesPanel key={`${project.id}:${filesRefreshVersion}`} api={api} projectId={project.id} revision={project.sourceRevision} />
    </section>
  );
}
