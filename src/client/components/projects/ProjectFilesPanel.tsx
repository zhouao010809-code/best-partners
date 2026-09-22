import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, FileText, Folder, LoaderCircle, Search, X } from 'lucide-react';
import type { ApiClientResult, ReadConsoleApi } from '../../api/client.js';
import type { ProjectFile, ProjectFileDetail } from '../../../shared/api/projects.js';
import { PageState } from '../PageState.js';
import { isCancelled } from '../../pages/pageSupport.js';

interface ProjectFilesPanelProps {
  readonly api: ReadConsoleApi;
  readonly projectId: string;
  readonly revision?: number;
}

type FileOrigin = 'source' | 'output';

function fileStatus(file: ProjectFile): string {
  switch (file.parseStatus) {
    case 'unsupported': return '暂不支持内容读取';
    case 'too-large': return '文件过大，未建立正文索引';
    case 'failed': return '解析失败，保留文件记录';
    case 'readable': return '可读取';
    default: return file.kind === 'directory' ? '文件夹' : '已记录';
  }
}

function failure<T>(result: ApiClientResult<T>, fallback: string): { status: 'disconnected' | 'validation-error' | 'operation-error'; message: string } {
  if (!result.ok && !isCancelled(result)) {
    return {
      status: result.state.status === 'disconnected' || result.state.status === 'validation-error' ? result.state.status : 'operation-error',
      message: result.state.message || fallback
    };
  }
  return { status: 'operation-error', message: fallback };
}

export function ProjectFilesPanel({ api, projectId, revision }: ProjectFilesPanelProps) {
  const projectsApi = api.projects;
  const [origin, setOrigin] = useState<FileOrigin>('source');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<Record<FileOrigin, readonly ProjectFile[]>>({ source: [], output: [] });
  const [state, setState] = useState<'loading' | 'ready' | 'failed' | 'refreshing'>('loading');
  const [message, setMessage] = useState<string>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [detail, setDetail] = useState<ProjectFileDetail>();
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [detailMessage, setDetailMessage] = useState<string>();
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const detailControllerRef = useRef<AbortController | undefined>(undefined);

  const load = useCallback(async (refreshing = false): Promise<void> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((current) => refreshing || current === 'ready' ? 'refreshing' : 'loading');
    setMessage(undefined);
    if (projectsApi === undefined) {
      setState('failed');
      setMessage('当前连接不提供个人项目。');
      return;
    }
    try {
      const sourceQuery = { origin: 'source' as const, limit: 200, ...(query ? { search: query } : {}) };
      const outputQuery = { origin: 'output' as const, limit: 200, ...(query ? { search: query } : {}) };
      const [sourceResult, outputResult] = await Promise.all([
        projectsApi.files(projectId, sourceQuery, controller.signal),
        projectsApi.files(projectId, outputQuery, controller.signal)
      ]);
      if (controller.signal.aborted || isCancelled(sourceResult) || isCancelled(outputResult)) return;
      if (!sourceResult.ok && !outputResult.ok) {
        const error = failure(sourceResult, '项目文件暂时无法读取，请刷新后重试。');
        setState('failed');
        setMessage(error.message);
        return;
      }
      setFiles({
        source: sourceResult.ok ? sourceResult.value.items : [],
        output: outputResult.ok ? outputResult.value.items : []
      });
      if (!outputResult.ok && outputResult.code !== 'PROJECT_NOT_FOUND') {
        setMessage('项目文件已读取；AI工作区暂时没有可显示的产出。');
      }
      setState('ready');
    } catch {
      if (!controller.signal.aborted) {
        setState('failed');
        setMessage('项目文件暂时无法读取，请刷新后重试。');
      }
    }
  }, [projectId, projectsApi, query]);

  useEffect(() => {
    void load();
    return () => controllerRef.current?.abort();
  }, [load, revision]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [search]);

  const visibleFiles = useMemo(() => files[origin], [files, origin]);

  const openFile = useCallback(async (file: ProjectFile): Promise<void> => {
    if (file.kind !== 'file' || projectsApi === undefined) return;
    detailControllerRef.current?.abort();
    const controller = new AbortController();
    detailControllerRef.current = controller;
    setSelectedPath(file.relativePath);
    setDetail(undefined);
    setDetailState('loading');
    setDetailMessage(undefined);
    try {
      const result = await projectsApi.file(projectId, file.relativePath, controller.signal);
      if (controller.signal.aborted || isCancelled(result)) return;
      if (!result.ok) {
        setDetailState('failed');
        setDetailMessage(result.state.message || '文件正文暂时无法读取。');
        return;
      }
      setDetail(result.value);
      setDetailState('idle');
    } catch {
      if (!controller.signal.aborted) {
        setDetailState('failed');
        setDetailMessage('文件正文暂时无法读取。');
      }
    }
  }, [projectId, projectsApi]);

  useEffect(() => () => detailControllerRef.current?.abort(), []);

  if (state === 'failed') {
    return <section className="project-files-panel instrument-panel" aria-labelledby="project-files-title"><header className="project-files-panel__heading"><div><p className="projects-eyebrow">PROJECT FILES</p><h2 id="project-files-title">项目语料</h2></div><button type="button" className="projects-button projects-button--quiet" onClick={() => void load(true)}><Search size={15} aria-hidden="true" />重新读取</button></header><PageState state={{ status: 'operation-error', message: message ?? '项目文件暂时无法读取。' }} /></section>;
  }

  return (
    <section className="project-files-panel instrument-panel" aria-labelledby="project-files-title">
      <header className="project-files-panel__heading">
        <div>
          <p className="projects-eyebrow">PROJECT FILES / RELATIVE PATHS</p>
          <h2 id="project-files-title">项目语料与产出</h2>
          <p>只显示项目内相对路径；原始文件不会因为浏览而被改写。</p>
        </div>
        <button type="button" className="projects-button projects-button--quiet" onClick={() => void load(true)} disabled={state === 'loading' || state === 'refreshing'}>
          {state === 'loading' || state === 'refreshing' ? <LoaderCircle size={15} className="projects-spin" aria-hidden="true" /> : <Search size={15} aria-hidden="true" />}
          {state === 'loading' || state === 'refreshing' ? '读取中…' : '刷新文件'}
        </button>
      </header>

      <div className="project-files-panel__toolbar">
        <div className="project-file-tabs" role="tablist" aria-label="项目文件范围">
          <button type="button" role="tab" aria-selected={origin === 'source'} onClick={() => { setOrigin('source'); setSelectedPath(undefined); }}><BookOpen size={15} aria-hidden="true" />项目语料 <span>{files.source.length}</span></button>
          <button type="button" role="tab" aria-selected={origin === 'output'} onClick={() => { setOrigin('output'); setSelectedPath(undefined); }}><Folder size={15} aria-hidden="true" />AI工作区 <span>{files.output.length}</span></button>
        </div>
        <label className="project-file-search"><Search size={14} aria-hidden="true" /><span className="visually-hidden">搜索项目文件</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索相对路径或内容" /></label>
      </div>

      {message !== undefined && <p className="projects-inline-message" role="status">{message}</p>}
      {state === 'loading' && <PageState state={{ status: 'loading', message: '正在读取项目文件。' }} />}
      {state !== 'loading' && visibleFiles.length === 0 && <PageState state={{ status: 'empty', message: origin === 'output' ? '确认项目产出后，AI工作区会显示在这里。' : '当前项目还没有可显示的文件。' }} />}
      {visibleFiles.length > 0 && <div className="project-file-layout">
        <ul className="project-file-list" aria-label={origin === 'output' ? 'AI工作区文件' : '项目源文件'}>
          {visibleFiles.map((file) => <li key={file.relativePath} className={selectedPath === file.relativePath ? 'is-selected' : undefined}>
            <button type="button" onClick={() => void openFile(file)} disabled={file.kind !== 'file'} aria-label={`打开文件：${file.relativePath}`}>
              {file.kind === 'directory' ? <Folder size={15} aria-hidden="true" /> : <FileText size={15} aria-hidden="true" />}
              <span><strong>{file.relativePath}</strong><small>{fileStatus(file)}{file.bytes === undefined ? '' : ` · ${file.bytes} B`}</small></span>
            </button>
          </li>)}
        </ul>
        <div className="project-file-reader" aria-live="polite">
          {selectedPath === undefined && <div className="project-file-reader__empty"><FileText size={22} aria-hidden="true" /><p>选择一个文件查看正文</p><small>读取范围受当前项目和文件解析状态限制。</small></div>}
          {selectedPath !== undefined && detailState === 'loading' && <PageState state={{ status: 'loading', message: '正在读取文件正文。' }} />}
          {selectedPath !== undefined && detailState === 'failed' && <PageState state={{ status: 'operation-error', message: detailMessage ?? '文件正文暂时无法读取。' }} />}
          {detail !== undefined && <article className="project-file-reader__content"><header><div><p className="projects-eyebrow">FILE / {detail.origin === 'output' ? 'AI工作区' : 'PROJECT SOURCE'}</p><h3>{detail.relativePath}</h3></div><button type="button" className="projects-icon-button" aria-label="关闭文件预览" onClick={() => { setSelectedPath(undefined); setDetail(undefined); }}><X size={15} aria-hidden="true" /></button></header>{detail.content === undefined ? <p className="project-file-reader__notice">{fileStatus(detail)}。</p> : <pre>{detail.content}</pre>}{detail.truncated && <p className="project-file-reader__notice">正文已截断，仅显示索引允许的范围。</p>}</article>}
        </div>
      </div>}
    </section>
  );
}
