import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { BookOpen, ChevronDown, ChevronRight, FileText, Folder, LoaderCircle, Search, X } from 'lucide-react';
import type { ReadConsoleApi } from '../../api/client.js';
import type { ProjectFile, ProjectFileDetail } from '../../../shared/api/projects.js';
import { isCancelled } from '../../pages/pageSupport.js';
import '../../styles/project-files.css';

interface ProjectFilesPanelProps {
  readonly api: ReadConsoleApi;
  readonly projectId: string;
  readonly revision?: number;
  readonly onAsk?: () => void;
}

type FileOrigin = 'source' | 'output';
interface FileCollection {
  readonly items: readonly ProjectFile[];
  readonly total: number;
  readonly status: 'loading' | 'ready' | 'failed';
  readonly message?: string;
}
interface FileNode {
  file: ProjectFile;
  readonly children: Map<string, FileNode>;
}
const FILE_LIMIT = 200;
const LABELS: Record<FileOrigin, string> = { source: '项目资料', output: '已保存产出' };
const emptyCollection = (): FileCollection => ({ items: [], total: 0, status: 'loading' });
const basename = (path: string): string => path.split('/').at(-1) ?? path;
const directory = (path: string): string => path.split('/').slice(0, -1).join('/');
const isHidden = (path: string): boolean => path.split('/').some(part => part.startsWith('.'));

function fileStatus(file: ProjectFile): string {
  switch (file.parseStatus) {
    case 'unsupported': return '暂不支持预览';
    case 'too-large': return '文件较大，暂不支持预览';
    case 'failed': return '解析失败，暂不支持预览';
    case 'readable': return '可预览';
    default: return '文件';
  }
}
function fileSize(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  const divisor = bytes >= 1024 * 1024 ? 1024 * 1024 : 1024;
  const value = bytes === 0 ? 0 : Math.max(0.1, Math.round(bytes / divisor * 10) / 10);
  return ` · ${value} ${divisor === 1024 ? 'KB' : 'MB'}`;
}
function buildTree(files: readonly ProjectFile[]): Map<string, FileNode> {
  const root = new Map<string, FileNode>();
  for (const file of files) {
    const parts = file.relativePath.split('/');
    let siblings = root;
    for (let index = 0; index < parts.length; index += 1) {
      const path = parts.slice(0, index + 1).join('/');
      let node = siblings.get(path);
      if (node === undefined) {
        node = { file: { relativePath: path, kind: 'directory' }, children: new Map() };
        siblings.set(path, node);
      }
      if (index === parts.length - 1) node.file = file;
      siblings = node.children;
    }
  }
  return root;
}
function sortedNodes(nodes: Map<string, FileNode>): FileNode[] {
  return [...nodes.values()].sort((a, b) => {
    if (a.file.kind !== b.file.kind) return a.file.kind === 'directory' ? -1 : 1;
    return basename(a.file.relativePath).localeCompare(basename(b.file.relativePath), 'zh-CN', { numeric: true });
  });
}

export function ProjectFilesPanel({ api, projectId, revision, onAsk }: ProjectFilesPanelProps) {
  const projectsApi = api.projects;
  const panelId = useId();
  const [origin, setOrigin] = useState<FileOrigin>('source');
  const [search, setSearch] = useState('');
  const query = search.trim();
  const [showHidden, setShowHidden] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [collections, setCollections] = useState<Record<FileOrigin, FileCollection>>({ source: emptyCollection(), output: emptyCollection() });
  const [selectedPath, setSelectedPath] = useState<string>();
  const [detail, setDetail] = useState<ProjectFileDetail>();
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [detailMessage, setDetailMessage] = useState<string>();
  const listControllers = useRef<Partial<Record<FileOrigin, AbortController>>>({});
  const detailController = useRef<AbortController | undefined>(undefined);

  const clearPreview = useCallback(() => {
    detailController.current?.abort();
    detailController.current = undefined;
    setSelectedPath(undefined);
    setDetail(undefined);
    setDetailState('idle');
    setDetailMessage(undefined);
  }, []);

  const loadCollection = useCallback(async (target: FileOrigin): Promise<void> => {
    listControllers.current[target]?.abort();
    const controller = new AbortController();
    listControllers.current[target] = controller;
    const current = () => !controller.signal.aborted && listControllers.current[target] === controller;
    setCollections(value => ({ ...value, [target]: emptyCollection() }));
    const fail = (message: string) => {
      if (current()) setCollections(value => ({ ...value, [target]: { items: [], total: 0, status: 'failed', message } }));
    };
    if (projectsApi === undefined) {
      fail('当前连接不提供个人项目。');
      return;
    }
    try {
      const result = await projectsApi.files(projectId, { origin: target, limit: FILE_LIMIT, ...(query ? { search: query } : {}) }, controller.signal);
      if (!current() || isCancelled(result)) return;
      if (!result.ok) {
        fail(result.state.message || '暂时无法读取，请重试。');
        return;
      }
      setCollections(value => ({ ...value, [target]: { items: result.value.items, total: result.value.total, status: 'ready' } }));
    } catch {
      fail('暂时无法读取，请检查连接后重试。');
    }
  }, [projectId, projectsApi, query]);

  useEffect(() => {
    clearPreview();
    setCollections({ source: emptyCollection(), output: emptyCollection() });
    const load = () => { void loadCollection('source'); void loadCollection('output'); };
    const timer = query ? window.setTimeout(load, 180) : undefined;
    if (!query) load();
    return () => {
      window.clearTimeout(timer);
      listControllers.current.source?.abort();
      listControllers.current.output?.abort();
      detailController.current?.abort();
    };
  }, [clearPreview, loadCollection, query, revision]);

  useEffect(() => { setExpanded(new Set()); }, [projectId]);

  const active = collections[origin];
  const visibleFiles = useMemo(() => active.items.filter(file => showHidden || !isHidden(file.relativePath)), [active.items, showHidden]);
  const tree = useMemo(() => buildTree(visibleFiles), [visibleFiles]);
  const outputEmpty = origin === 'output' && !query && !active.items.some(file => file.kind === 'file') && active.total <= active.items.length;

  const openFile = useCallback(async (file: ProjectFile): Promise<void> => {
    if (file.kind !== 'file' || projectsApi === undefined) return;
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    const current = () => !controller.signal.aborted && detailController.current === controller;
    setSelectedPath(file.relativePath);
    setDetail(undefined);
    setDetailState('loading');
    setDetailMessage(undefined);
    try {
      const result = await projectsApi.file(projectId, file.relativePath, controller.signal);
      if (!current() || isCancelled(result)) return;
      if (!result.ok) {
        setDetailState('failed');
        setDetailMessage(result.state.message || '文件正文暂时无法读取。');
        return;
      }
      setDetail(result.value);
      setDetailState('idle');
    } catch {
      if (current()) {
        setDetailState('failed');
        setDetailMessage('文件正文暂时无法读取。');
      }
    }
  }, [projectId, projectsApi]);

  const selectOrigin = (next: FileOrigin) => {
    if (next !== origin) { clearPreview(); setOrigin(next); }
  };
  const fileRow = (file: ProjectFile, showDirectory: boolean) => <button type="button" className={`project-files__file${selectedPath === file.relativePath ? ' is-selected' : ''}`} onClick={() => void openFile(file)} aria-label={`打开文件：${file.relativePath}`} aria-pressed={selectedPath === file.relativePath}>
    <FileText size={17} aria-hidden="true" />
    <span className="project-files__file-label"><strong>{basename(file.relativePath)}</strong>{showDirectory && directory(file.relativePath) && <small className="project-files__path">{directory(file.relativePath)}</small>}<small>{fileStatus(file)}{fileSize(file.bytes)}</small></span>
  </button>;
  const renderNodes = (nodes: Map<string, FileNode>): ReactNode => sortedNodes(nodes).map(node => {
    const path = node.file.relativePath;
    const open = expanded.has(path);
    return <li key={path}>{node.file.kind === 'file' ? fileRow(node.file, false) : <>
      <button type="button" className="project-files__folder" aria-label={`${open ? '收起' : '展开'}文件夹：${path}`} aria-expanded={open} onClick={() => setExpanded(value => { const next = new Set(value); if (next.has(path)) next.delete(path); else next.add(path); return next; })}>
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}<Folder size={17} aria-hidden="true" /><span>{basename(path)}</span>
      </button>
      {open && (node.children.size > 0 ? <ul className="project-files__children">{renderNodes(node.children)}</ul> : <p className="project-files__folder-empty">{active.total > active.items.length ? '当前列表未加载此文件夹内容，请搜索。' : '此文件夹暂无可显示的文件。'}</p>)}
    </>}</li>;
  });

  return <section className="project-files-panel" aria-label="项目资料与产出">
    <div className="project-files__toolbar">
      <div className="project-files__tabs" role="tablist" aria-label="项目文件范围">
        {(['source', 'output'] as const).map(target => <button key={target} id={`${panelId}-${target}`} type="button" role="tab" tabIndex={origin === target ? 0 : -1} aria-controls={`${panelId}-content`} aria-selected={origin === target} onClick={() => selectOrigin(target)} onKeyDown={event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
          event.preventDefault();
          const next = event.key === 'Home' ? 'source' : event.key === 'End' ? 'output' : target === 'source' ? 'output' : 'source';
          selectOrigin(next);
          document.getElementById(`${panelId}-${next}`)?.focus();
        }}>{target === 'source' ? <BookOpen size={16} aria-hidden="true" /> : <Folder size={16} aria-hidden="true" />}{LABELS[target]}</button>)}
      </div>
      <label className="project-files__search"><Search size={16} aria-hidden="true" /><span className="visually-hidden">搜索项目文件</span><input value={search} onChange={event => { clearPreview(); setSearch(event.target.value); }} placeholder="搜索文件名或内容" /></label>
    </div>
    <div className="project-files__options"><label><input type="checkbox" checked={showHidden} onChange={event => { clearPreview(); setShowHidden(event.target.checked); }} />显示隐藏文件</label></div>
    <div id={`${panelId}-content`} role="tabpanel" aria-labelledby={`${panelId}-${origin}`} className="project-files__panel">
      {active.status === 'loading' && <div className="project-files__state" role="status"><LoaderCircle size={20} className="project-files__spinner" aria-hidden="true" /><p>正在读取{LABELS[origin]}…</p></div>}
      {active.status === 'failed' && <div className="project-files__state project-files__state--error" role="alert"><h3>{LABELS[origin]}读取失败</h3><p>{active.message}</p><button type="button" className="project-files__action" aria-label={`重新读取${LABELS[origin]}`} onClick={() => { clearPreview(); void loadCollection(origin); }}>重新读取</button></div>}
      {active.status === 'ready' && <>
        {active.total > FILE_LIMIT && <p className="project-files__limit" role="status">仅显示前 200 项中的可见文件与文件夹。请搜索文件名或内容，查找更多资料。</p>}
        {(outputEmpty || visibleFiles.length === 0) ? <div className="project-files__state">
          <Folder size={26} aria-hidden="true" />
          <h3>{outputEmpty ? '还没有已保存的产出' : query ? '没有找到匹配文件' : '暂无可显示的文件'}</h3>
          <p>{outputEmpty ? '在问问中确认保存后，产出会显示在这里，并保存在项目的 AI工作区 文件夹。' : query ? '试试其他关键词，也可以开启“显示隐藏文件”继续查找。' : '添加项目资料后，在页面上方更新资料；也可以开启“显示隐藏文件”查看。'}</p>
          {outputEmpty && onAsk !== undefined && <button type="button" className="project-files__action" onClick={onAsk}>打开项目问问</button>}
        </div> : <div className="project-files__layout">
          <div className="project-files__browser"><ul className="project-files__list" aria-label={origin === 'output' ? '已保存产出文件' : '项目源文件'}>
            {query ? visibleFiles.map(file => <li key={file.relativePath}>{file.kind === 'file' ? fileRow(file, true) : <div className="project-files__search-folder"><Folder size={17} aria-hidden="true" /><span><strong>{basename(file.relativePath)}</strong><small>{directory(file.relativePath) || '项目根目录'} · 文件夹</small></span></div>}</li>) : renderNodes(tree)}
          </ul></div>
          <div className="project-files__reader" aria-live="polite">
            {selectedPath === undefined && <div className="project-files__reader-empty"><FileText size={27} aria-hidden="true" /><p>选择文件，查看内容</p><small>展开文件夹，找到需要的资料。</small></div>}
            {selectedPath !== undefined && detailState === 'loading' && <div className="project-files__state" role="status"><LoaderCircle size={20} className="project-files__spinner" aria-hidden="true" /><p>正在读取文件内容…</p></div>}
            {selectedPath !== undefined && detailState === 'failed' && <div className="project-files__state project-files__state--error" role="alert"><h3>文件预览失败</h3><p>{detailMessage}</p><button type="button" className="project-files__action" onClick={() => void openFile({ relativePath: selectedPath, kind: 'file' })}>重新读取文件</button></div>}
            {selectedPath !== undefined && detail !== undefined && <article className="project-files__content"><header><div><h3>{basename(detail.relativePath)}</h3><p>{detail.relativePath}</p></div><button type="button" className="project-files__close" aria-label="关闭文件预览" onClick={clearPreview}><X size={17} aria-hidden="true" /></button></header>{detail.content === undefined ? <p className="project-files__notice">{fileStatus(detail)}。{detail.problem}</p> : <pre>{detail.content}</pre>}{detail.truncated && <p className="project-files__notice">文件较长，当前仅预览部分内容。</p>}</article>}
          </div>
        </div>}
      </>}
    </div>
  </section>;
}
