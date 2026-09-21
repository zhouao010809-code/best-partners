import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BookOpenText,
  BrainCircuit,
  CircleDot,
  DatabaseZap,
  Archive,
  Inbox,
  GitPullRequestArrow,
  LayoutDashboard,
  ListFilter,
  Settings,
  Search,
  MessageCircle,
  Sparkles
} from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  browserReadConsoleApi,
  type ApiClientResult,
  type ClientFailureState,
  type HealthSnapshot,
  type IndexJob,
  type ReadConsoleApi
} from '../api/client.js';
import type { ConsoleRuntime, Resource } from './ConsoleRuntime.js';
import { useTrashInventory } from '../components/useTrashInventory.js';
import { RecycleBinArtwork } from '../components/RecycleBinArtwork.js';
import { AssistantPanel, AssistantToggle } from '../components/assistant/AssistantPanel.js';
import { GlobalSearch, rememberRecent } from '../components/GlobalSearch.js';
import { ASSISTANT_INTENT_EVENT, askAssistant } from '../components/assistant/assistantIntent.js';
import '../styles/unified-trash.css';
import '../styles/ai-glow.css';

const NAVIGATION = [
  { to: '/', label: '大脑总览', icon: LayoutDashboard, end: true },
  { to: '/intake', label: '收件箱', icon: Inbox, end: false },
  { to: '/queue', label: '提炼队列', icon: ListFilter, end: false },
  { to: '/library', label: '档案库', icon: Archive, end: false },
  { to: '/knowledge', label: '知识库', icon: BookOpenText, end: false },
  { to: '/skills', label: 'Skill 库', icon: Sparkles, end: false },
  { to: '/operations', label: '操作与恢复', icon: GitPullRequestArrow, end: false },
  { to: '/settings', label: '设置', icon: Settings, end: false }
] as const;

const ACTIVE_INDEX_JOB_STATUSES = new Set<IndexJob['status']>(['queued', 'running']);
const POLL_INTERVAL_MS = 250;
const HEALTH_POLL_INTERVAL_MS = 3_000;
let focusCycleSequence = 0;

function isCancelled<T>(
  result: ApiClientResult<T>
): result is { readonly ok: false; readonly cancelled: true } {
  return !result.ok && 'cancelled' in result;
}

function resourceData<T>(resource: Resource<T>): T | undefined {
  return 'data' in resource ? resource.data : undefined;
}

function refreshingResource<T>(data: T | undefined): Resource<T> {
  return data === undefined ? { status: 'refreshing' } : { status: 'refreshing', data };
}

function failedResource<T>(state: ClientFailureState, data?: T): Resource<T> {
  return data === undefined
    ? { status: 'failed', state }
    : { status: 'failed', state, data };
}

function nextFocusIdempotencyKey(): string {
  focusCycleSequence += 1;
  const randomPart = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${focusCycleSequence.toString(36)}`;
  return `focus-${randomPart}`;
}

function waitForNextPoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(done, POLL_INTERVAL_MS);
    function done(): void {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function stableRuntimeFailure(status: ClientFailureState['status']): ClientFailureState {
  switch (status) {
    case 'busy':
      return { status, message: '已有索引任务正在执行。' };
    case 'conflict':
      return { status, message: '索引版本已变化，将在下次聚焦时重试。' };
    case 'disconnected':
      return { status, message: '无法连接本地服务。' };
    case 'validation-error':
      return { status, message: '本地服务响应与当前客户端不兼容。' };
    case 'recovery-required':
      return { status, message: '系统正处于恢复模式。' };
    case 'operation-error':
      return { status, message: '索引刷新未完成。' };
  }
}

function connectionPresentation(resource: Resource<HealthSnapshot>): {
  readonly className: string;
  readonly title: string;
  readonly detail: string;
} {
  const snapshot = resourceData(resource);
  if (
    resource.status === 'failed'
    && (resource.state.status === 'disconnected' || resource.state.status === 'recovery-required')
  ) {
    return {
      className: 'connection-badge--unavailable',
      title: resource.state.status === 'recovery-required' ? '需要恢复' : '未连接',
      detail: '本地服务无可用实时快照'
    };
  }
  if (snapshot?.vaultSource.status === 'ready') {
    return {
      className: 'connection-badge--connected',
      title: '已连接',
      detail: `${snapshot.vaultSource.adapter === 'filesystem' ? '本地文件' : 'Local REST'} · ${snapshot.vaultSource.displayName}`
    };
  }
  if (snapshot !== undefined) {
    return {
      className: 'connection-badge--unavailable',
      title: '大脑文件夹不可用',
      detail: '本地服务已响应'
    };
  }
  if (resource.status === 'failed') {
    return {
      className: 'connection-badge--unavailable',
      title: resource.state.status === 'recovery-required' ? '需要恢复' : '未连接',
      detail: '本地服务无可用快照'
    };
  }
  return {
    className: 'connection-badge--pending',
    title: '正在检查',
    detail: '本地服务握手中'
  };
}

function indexPresentation(resource: Resource<HealthSnapshot>): string {
  if (resource.status === 'loading') return '索引检查中';
  if (resource.status === 'refreshing') return '索引刷新中';
  if (resource.status === 'failed') {
    switch (resource.state.status) {
      case 'busy': return '索引任务进行中';
      case 'conflict': return '索引版本冲突';
      case 'disconnected': return '索引服务未连接';
      case 'validation-error': return '索引响应校验失败';
      case 'recovery-required': return '索引需要恢复';
      case 'operation-error': return '索引刷新失败';
    }
  }

  switch (resource.data.index.status) {
    case 'building': return `索引 v${resource.data.index.version} 构建中`;
    case 'ready': return `索引 v${resource.data.index.version} 已就绪`;
    case 'stale': return `索引 v${resource.data.index.version} 待刷新`;
    case 'failed': return `索引 v${resource.data.index.version} 失败`;
    case 'unavailable': return '索引不可用';
  }
}

type PageIdentity = {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
};

function pageIdentity(pathname: string): PageIdentity {
  if (pathname.startsWith('/extractions/')) {
    return {
      eyebrow: 'EXTRACTION / CANDIDATES',
      title: '提炼工作区',
      description: '提炼、编辑与核对候选，确认后保存为正式知识。'
    };
  }
  if (pathname.startsWith('/write-plans/')) {
    return {
      eyebrow: 'WRITE PLAN / PHASE 3',
      title: '写入计划',
      description: '在真正写入前核对路径、版本与变更摘要。'
    };
  }

  const canonicalPath = pathname.length > 1 ? pathname.replace(/\/+$/u, '') : pathname;

  switch (canonicalPath) {
    case '/intake':
      return { eyebrow: 'INCOMING / PERSONAL ARCHIVE', title: '收件箱', description: '收藏的下一站。' };
    case '/':
      return {
        eyebrow: 'BRAIN / OVERVIEW',
        title: '大脑总览',
        description: '把收藏的资料变成可复用的知识。'
      };
    case '/queue':
      return {
        eyebrow: 'BRAIN / EXTRACTION',
        title: '提炼工作台',
        description: '读懂资料，留下值得复用的知识。'
      };
    case '/library':
      return {
        eyebrow: 'LIBRARY / ORIGINALS',
        title: '档案库',
        description: '妥善封存，按需调阅。'
      };
    case '/knowledge':
      return {
        eyebrow: 'KNOWLEDGE / RETRIEVAL',
        title: '知识库',
        description: '按标题与 YAML 召回字段检索已结构化的知识。'
      };
    case '/skills':
      return {
        eyebrow: 'SKILLS / LOCAL METHODS',
        title: 'Skill 库',
        description: '浏览本地可复用的方法说明；可创建文件夹并手动整理，Skill 内容保持只读。'
      };
    case '/trash':
      return { eyebrow: 'RECYCLE / LOCAL STORAGE', title: '回收站', description: '收件箱、档案库、提炼队列与知识库的暂存处。' };
    case '/operations':
      return {
        eyebrow: 'SYSTEM / LEDGER',
        title: '操作与恢复',
        description: '查看进展，继续未完成的操作。'
      };
    case '/connections':
    case '/settings':
      return {
        eyebrow: 'PREFERENCES / LOCAL WORKSPACE',
        title: '设置',
        description: '管理大脑位置、AI 连接和应用版本。'
      };
    default:
      return {
        eyebrow: 'SYSTEM / 404',
        title: '页面未找到',
        description: '该路径不在当前的本地工作区中。'
      };
  }
}

export interface AppShellProps {
  readonly api?: ReadConsoleApi;
  /** Keep the synchronous personal shell visible while the host runtime is resolving,
   * but do not call any personal data endpoints during that window. */
  readonly suspendDataEffects?: boolean;
}

export function AppShell({ api = browserReadConsoleApi, suspendDataEffects = false }: AppShellProps) {
  const location = useLocation();
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedPassage, setSelectedPassage] = useState('');
  const [assistantRunning, setAssistantRunning] = useState(false);
  const [assistantWidth, setAssistantWidth] = useState(430);
  const resizeAssistant = useCallback((width: number) => setAssistantWidth([360, 430, 520, 600].reduce((nearest, item) => Math.abs(item - width) < Math.abs(nearest - width) ? item : nearest, 430)), []);
  const closeAssistant = useCallback(() => setAssistantOpen(false), []);
  const queueHref = useRef('/queue');
  if (location.pathname.replace(/\/+$/u, '') === '/queue') {
    const filters = new URLSearchParams(location.search);
    for (const key of ['materialPath', 'run', 'pane']) filters.delete(key);
    queueHref.current = `/queue${filters.size ? `?${filters}` : ''}`;
  }
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousPath = useRef<string | undefined>(undefined);
  const mountedRef = useRef(false);
  const healthRef = useRef<Resource<HealthSnapshot>>({ status: 'loading' });
  const healthRequestRef = useRef<Promise<ApiClientResult<HealthSnapshot>> | undefined>(undefined);
  const latestHealthRequestRef = useRef<Promise<ApiClientResult<HealthSnapshot>> | undefined>(undefined);
  const focusCycleRef = useRef<Promise<void> | undefined>(undefined);
  const healthOwnerSequenceRef = useRef(0);
  const activeFocusOwnerRef = useRef<number | undefined>(undefined);
  const controllersRef = useRef(new Set<AbortController>());
  const publishedIndexVersionRef = useRef<number | undefined>(undefined);
  const [health, setHealth] = useState<Resource<HealthSnapshot>>({ status: 'loading' });
  const [dataRevision, setDataRevision] = useState(0);
  const trashInventory = useTrashInventory(api, dataRevision, !suspendDataEffects);
  const trashCountDescription = trashInventory.complete
    ? `${trashInventory.active.length} 份暂存`
    : trashInventory.loading ? '正在读取回收站数量' : '回收站数量暂不可用';
  const lastTrashNavigation = useRef(location.pathname);
  useEffect(() => {
    if (lastTrashNavigation.current !== location.pathname && location.pathname === '/trash') trashInventory.refresh();
    lastTrashNavigation.current = location.pathname;
  }, [location.pathname, trashInventory.refresh]);
  const identity = pageIdentity(location.pathname);

  healthRef.current = health;

  const publishHealth = useCallback((snapshot: HealthSnapshot): void => {
    if (snapshot.index.status === 'ready' || snapshot.index.status === 'stale') {
      const previousVersion = publishedIndexVersionRef.current;
      publishedIndexVersionRef.current = snapshot.index.version;
      if (previousVersion !== undefined && previousVersion !== snapshot.index.version) {
        setDataRevision((revision) => revision + 1);
      }
    }
    setHealth({ status: 'ready', data: snapshot });
  }, []);

  const readHealth = useCallback((forceFresh = false): Promise<ApiClientResult<HealthSnapshot>> => {
    if (!forceFresh && healthRequestRef.current !== undefined) return healthRequestRef.current;

    const controller = new AbortController();
    controllersRef.current.add(controller);
    const request = api.getHealth(controller.signal).finally(() => {
      controllersRef.current.delete(controller);
      if (healthRequestRef.current === request) healthRequestRef.current = undefined;
    });
    healthRequestRef.current = request;
    latestHealthRequestRef.current = request;
    return request;
  }, [api]);

  const refreshHealth = useCallback(async (passive = false): Promise<void> => {
    if (activeFocusOwnerRef.current !== undefined) {
      if (!passive) await readHealth();
      return;
    }

    healthOwnerSequenceRef.current += 1;
    const refreshOwner = healthOwnerSequenceRef.current;
    const currentData = resourceData(healthRef.current);
    if (!passive) setHealth(refreshingResource(currentData));
    const request = readHealth();
    const result = await request;
    if (
      !mountedRef.current
      || activeFocusOwnerRef.current !== undefined
      || healthOwnerSequenceRef.current !== refreshOwner
      || latestHealthRequestRef.current !== request
      || isCancelled(result)
    ) return;
    if (result.ok) {
      publishHealth(result.value);
      return;
    }
    setHealth(failedResource(stableRuntimeFailure(result.state.status), currentData));
  }, [publishHealth, readHealth]);

  const executeFocusCycle = useCallback(async (focusOwner: number): Promise<void> => {
    const ownsFocusState = (): boolean => (
      mountedRef.current && activeFocusOwnerRef.current === focusOwner
    );
    const previousData = resourceData(healthRef.current);
    setHealth(refreshingResource(previousData));
    const authoritativeResult = await readHealth();
    if (!ownsFocusState() || isCancelled(authoritativeResult)) return;
    if (!authoritativeResult.ok) {
      setHealth(failedResource(
        stableRuntimeFailure(authoritativeResult.state.status),
        previousData
      ));
      return;
    }

    const authoritative = authoritativeResult.value;
    setHealth({ status: 'refreshing', data: authoritative });
    if (authoritative.index.status === 'unavailable') {
      publishHealth(authoritative);
      return;
    }

    const idempotencyKey = nextFocusIdempotencyKey();
    let rebuild = await api.rebuildIndex(authoritative.index.version, idempotencyKey);
    if (
      !rebuild.ok
      && !isCancelled(rebuild)
      && rebuild.state.status === 'disconnected'
      && ownsFocusState()
    ) {
      rebuild = await api.rebuildIndex(authoritative.index.version, idempotencyKey);
    }
    if (!ownsFocusState() || isCancelled(rebuild)) return;
    if (!rebuild.ok) {
      setHealth(failedResource(stableRuntimeFailure(rebuild.state.status), authoritative));
      return;
    }

    const cycleController = new AbortController();
    controllersRef.current.add(cycleController);
    let job = rebuild.value;
    try {
      while (ACTIVE_INDEX_JOB_STATUSES.has(job.status)) {
        if (!ownsFocusState() || cycleController.signal.aborted) return;
        const jobResult = await api.getIndexJob(job.id, cycleController.signal);
        if (!ownsFocusState() || cycleController.signal.aborted || isCancelled(jobResult)) return;
        if (!jobResult.ok) {
          setHealth(failedResource(stableRuntimeFailure(jobResult.state.status), authoritative));
          return;
        }
        job = jobResult.value;
        if (ACTIVE_INDEX_JOB_STATUSES.has(job.status)) {
          await waitForNextPoll(cycleController.signal);
        }
      }
    } finally {
      controllersRef.current.delete(cycleController);
    }

    if (!ownsFocusState() || cycleController.signal.aborted) return;
    const finalHealthRequest = readHealth(true);
    const finalHealth = await finalHealthRequest;
    if (
      !ownsFocusState()
      || latestHealthRequestRef.current !== finalHealthRequest
      || isCancelled(finalHealth)
    ) return;
    if (!finalHealth.ok) {
      setHealth(failedResource(stableRuntimeFailure(finalHealth.state.status), authoritative));
      return;
    }

    if (job.status === 'completed') {
      publishHealth(finalHealth.value);
      return;
    }
    setHealth(failedResource(
      stableRuntimeFailure('operation-error'),
      finalHealth.value
    ));
  }, [api, publishHealth, readHealth]);

  const runFocusCycle = useCallback((): Promise<void> => {
    if (focusCycleRef.current !== undefined) return focusCycleRef.current;
    healthOwnerSequenceRef.current += 1;
    const focusOwner = healthOwnerSequenceRef.current;
    activeFocusOwnerRef.current = focusOwner;
    const cycle = executeFocusCycle(focusOwner).finally(() => {
      if (focusCycleRef.current === cycle) {
        focusCycleRef.current = undefined;
        if (activeFocusOwnerRef.current === focusOwner) activeFocusOwnerRef.current = undefined;
      }
    });
    focusCycleRef.current = cycle;
    return cycle;
  }, [executeFocusCycle]);

  useEffect(() => {
    if (suspendDataEffects) return undefined;
    mountedRef.current = true;
    const initialOwner = healthOwnerSequenceRef.current;
    const request = readHealth();
    void request.then((result) => {
      if (
        !mountedRef.current
        || healthOwnerSequenceRef.current !== initialOwner
        || activeFocusOwnerRef.current !== undefined
        || latestHealthRequestRef.current !== request
        || isCancelled(result)
      ) return;
      if (result.ok) {
        publishHealth(result.value);
      } else {
        setHealth(failedResource(stableRuntimeFailure(result.state.status)));
      }
    });
    return () => {
      mountedRef.current = false;
      healthOwnerSequenceRef.current += 1;
      activeFocusOwnerRef.current = undefined;
      for (const controller of controllersRef.current) controller.abort();
      controllersRef.current.clear();
      healthRequestRef.current = undefined;
      latestHealthRequestRef.current = undefined;
      focusCycleRef.current = undefined;
    };
  }, [publishHealth, readHealth, suspendDataEffects]);

  useEffect(() => {
    if (suspendDataEffects) return undefined;
    let disposed = false;
    let timer: number;
    const poll = async (): Promise<void> => {
      try {
        if (document.visibilityState !== 'hidden') await refreshHealth(true);
      } finally {
        if (!disposed) timer = window.setTimeout(() => void poll(), HEALTH_POLL_INTERVAL_MS);
      }
    };
    timer = window.setTimeout(() => void poll(), HEALTH_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [refreshHealth, suspendDataEffects]);

  useEffect(() => {
    if (suspendDataEffects) return undefined;
    const handleFocus = (): void => {
      void runFocusCycle();
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [runFocusCycle, suspendDataEffects]);

  useEffect(() => {
    if (previousPath.current !== undefined && previousPath.current !== location.pathname) {
      headingRef.current?.focus({ preventScroll: true });
    }
    previousPath.current = location.pathname;
  }, [location.pathname]);

  const runtime = useMemo<ConsoleRuntime>(() => ({
    api,
    runtimeMode: 'personal',
    health,
    dataRevision,
    refreshHealth
  }), [api, dataRevision, health, refreshHealth]);
  const connection = connectionPresentation(health);
  const indexStatus = indexPresentation(health);
  const quietOverview = location.pathname === '/' && health.status === 'ready'
    && health.data.index.status === 'ready' && health.data.vaultSource.status === 'ready';
  const vaultSource = resourceData(health)?.vaultSource;
  const vaultName = vaultSource?.status === 'ready' ? vaultSource.displayName : 'local';
  useEffect(() => {
    const openAssistant = () => setAssistantOpen(true);
    const keys = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !event.isComposing) { event.preventDefault(); setSearchOpen(value => !value); } };
    window.addEventListener(ASSISTANT_INTENT_EVENT, openAssistant); window.addEventListener('keydown', keys);
    return () => { window.removeEventListener(ASSISTANT_INTENT_EVENT, openAssistant); window.removeEventListener('keydown', keys); };
  }, []);
  useEffect(() => {
    setSelectedPassage('');
    const query = new URLSearchParams(location.search);
    const path = ['/library', '/knowledge'].includes(location.pathname) ? query.get('path') : location.pathname === '/queue' ? query.get('materialPath') : undefined;
    if (path) rememberRecent(vaultName, { href: `${location.pathname}${location.search}`, title: path.split('/').at(-1)?.replace(/\.md$/iu, '') || path });
    const selection = () => {
      const value = window.getSelection();
      const parent = value?.anchorNode?.parentElement;
      const end = value?.focusNode?.parentElement;
      const readingSelector = location.pathname === '/library' ? '.library-original__reading .safe-markdown' : location.pathname === '/knowledge' ? '.knowledge-detail__body section[aria-label="知识正文"] .safe-markdown' : '.queue-original .safe-markdown';
      const reading = parent?.closest(readingSelector);
      setSelectedPassage(path && reading && end && reading.contains(end) && !parent?.closest('#assistant-panel') ? value!.toString().trim().slice(0, 6000) : '');
    };
    document.addEventListener('selectionchange', selection);
    return () => document.removeEventListener('selectionchange', selection);
  }, [location.pathname, location.search, vaultName]);

  return (
    <div className={`app-frame app-frame--assistant-${assistantWidth}${assistantOpen ? ' app-frame--assistant-open' : ''}`}>
      <a className="skip-link" href="#main-content">跳到主内容</a>

      <aside className="sidebar" aria-label="最佳拍档侧边栏">
        <div className="brand-lockup" aria-label="最佳拍档">
          <span className="brand-mark" aria-hidden="true">
            <BrainCircuit strokeWidth={1.7} />
          </span>
          <span className="brand-copy">
            <strong>最佳拍档</strong>
            <small>LOCAL MIND OS</small>
          </span>
        </div>

        <button type="button" className="global-search-trigger" aria-label="搜索大脑" title="搜索大脑 · ⌘ K" onClick={() => setSearchOpen(true)}><Search size={16} /><span>搜索大脑</span><kbd>⌘ K</kbd></button>
        <div className="sidebar-section-label">WORKSPACE</div>
        <nav className="main-navigation" aria-label="主导航">
          {NAVIGATION.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to === '/queue' ? queueHref.current : to}
              end={end}
              aria-label={label}
              title={label}
              className={({ isActive }) => `nav-item${isActive ? ' nav-item--active' : ''}`}
            >
              <Icon aria-hidden="true" strokeWidth={1.65} />
              <span>{label}</span>
              <span className="nav-item__trace" aria-hidden="true" />
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <NavLink to="/trash" aria-label="回收站" aria-describedby="sidebar-trash-description" title="回收站" className={({ isActive }) => `sidebar-trash${isActive ? ' sidebar-trash--active' : ''}`}>
            <RecycleBinArtwork hasPapers={trashInventory.active.length > 0} count={trashInventory.complete ? trashInventory.active.length : undefined} />
            <span id="sidebar-trash-description" className="visually-hidden">{trashCountDescription}</span>
          </NavLink>
          <div
            className={`connection-badge ${connection.className}`}
            role="status"
            aria-label="本地连接状态"
          >
            <span className="connection-badge__signal" aria-hidden="true" />
            <span>
              <strong>{connection.title}</strong>
              <small>{connection.detail}</small>
            </span>
          </div>
          <div className="vault-signature">
            <DatabaseZap aria-hidden="true" />
            <span>
              <small>ACTIVE VAULT</small>
              <strong>{vaultSource?.status === 'ready'
                ? vaultSource.displayName
                : '未连接'}</strong>
            </span>
          </div>
        </div>
      </aside>

      <section className="workspace" aria-label="当前工作区">
        <header className="workspace-bar">
          <div className="workspace-bar__context">
            <Activity aria-hidden="true" />
            <span>{location.pathname === '/intake' ? '个人本地归档' : location.pathname.startsWith('/extractions/') || location.pathname === '/queue' ? '个人知识提炼' : location.pathname === '/settings' ? '本地应用设置' : '本地大脑管理'}</span>
          </div>
          <div className="workspace-bar__actions"><div className={`workspace-bar__status${quietOverview ? ' workspace-bar__status--quiet' : ''}`} role="status" aria-label="索引运行状态" title={indexStatus}>
            <CircleDot aria-hidden="true" />
            <span>{health.status === 'ready' && health.data.index.status === 'ready' ? '资料已就绪' : indexStatus}</span>
          </div><AssistantToggle open={assistantOpen} running={assistantRunning} onClick={() => setAssistantOpen(value => !value)} /></div>
        </header>

        <main id="main-content" className="main-content" tabIndex={-1}>
          <header className="page-heading">
            <div>
              {location.pathname !== '/' && <p className="page-heading__eyebrow">{identity.eyebrow}</p>}
              <h1 ref={headingRef} tabIndex={-1}>{identity.title}</h1>
              <p className="page-heading__description">{identity.description}</p>
            </div>
            {location.pathname !== '/' && location.pathname !== '/operations' && <div className="read-only-seal" aria-label={location.pathname === '/intake' ? '当前模式：归档需确认' : location.pathname.startsWith('/extractions/') || location.pathname === '/queue' ? api.ingestion ? '当前模式：入库需确认' : '当前模式：候选不入库' : location.pathname === '/settings' ? '当前模式：本地设置' : location.pathname === '/skills' ? '当前模式：内容只读，整理可编辑' : ['/trash', '/library', '/knowledge'].includes(location.pathname) && api.trash ? '当前模式：删除需确认' : '当前模式：只读'}>
              <span aria-hidden="true" />
              {location.pathname === '/intake' ? 'CONFIRM TO ARCHIVE' : location.pathname.startsWith('/extractions/') || location.pathname === '/queue' ? api.ingestion ? 'CONFIRM TO KEEP' : 'CANDIDATES ONLY' : location.pathname === '/settings' ? 'LOCAL SETTINGS' : location.pathname === '/skills' ? 'ORGANIZE LOCALLY' : (location.pathname === '/trash' || location.pathname.startsWith('/library') || location.pathname === '/knowledge') && api.trash ? 'MANUAL CONFIRM' : 'READ ONLY'}
            </div>}
          </header>

          <div className="page-stage">
            <Outlet context={runtime} />
          </div>
        </main>
      </section>
      {searchOpen && <GlobalSearch api={api} vault={vaultName} onClose={() => setSearchOpen(false)} />}
      {selectedPassage && !searchOpen && <button type="button" className="selection-ask" onMouseDown={event => event.preventDefault()} onClick={() => { const query = new URLSearchParams(location.search); const path = query.get('materialPath') || query.get('path'); askAssistant({ prompt: `请解释这段原文，并结合上下文说明：\n\n“${selectedPassage}”`, ...(path ? { contextPath: path } : {}) }); setSelectedPassage(''); window.getSelection()?.removeAllRanges(); }}><MessageCircle size={16} />问问这段内容</button>}
      <AssistantPanel api={api} open={assistantOpen} onClose={closeAssistant} width={assistantWidth} onWidthChange={resizeAssistant} onRunningChange={setAssistantRunning} dataRevision={dataRevision} />
    </div>
  );
}
