import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BookOpenText,
  BrainCircuit,
  CircleDot,
  DatabaseZap,
  GitPullRequestArrow,
  LayoutDashboard,
  ListFilter,
  Settings
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

const NAVIGATION = [
  { to: '/', label: '大脑总览', icon: LayoutDashboard, end: true },
  { to: '/queue', label: '提炼队列', icon: ListFilter, end: false },
  { to: '/knowledge', label: '知识库', icon: BookOpenText, end: false },
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
      eyebrow: 'EXTRACTION / PHASE 2',
      title: '提炼工作区',
      description: '将原始材料收束为可审阅的知识候选。'
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
    case '/':
      return {
        eyebrow: 'BRAIN / OVERVIEW',
        title: '大脑总览',
        description: '观察材料、知识与本地系统的当前状态。'
      };
    case '/queue':
      return {
        eyebrow: 'LIBRARY / INBOX',
        title: '提炼队列',
        description: '筛选尚未入库的原始材料，安排下一次提炼。'
      };
    case '/knowledge':
      return {
        eyebrow: 'KNOWLEDGE / RETRIEVAL',
        title: '知识库',
        description: '按标题与 YAML 召回字段检索已结构化的知识。'
      };
    case '/operations':
      return {
        eyebrow: 'SYSTEM / LEDGER',
        title: '操作与恢复',
        description: '查看本地操作记录；恢复功能将在后续阶段启用。'
      };
    case '/connections':
    case '/settings':
      return {
        eyebrow: 'SYSTEM / DIAGNOSTICS',
        title: '设置',
        description: '管理大脑文件夹，查看索引、模型与只读状态。'
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
}

export function AppShell({ api = browserReadConsoleApi }: AppShellProps) {
  const location = useLocation();
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
  }, [publishHealth, readHealth]);

  useEffect(() => {
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
  }, [refreshHealth]);

  useEffect(() => {
    const handleFocus = (): void => {
      void runFocusCycle();
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [runFocusCycle]);

  useEffect(() => {
    if (previousPath.current !== undefined && previousPath.current !== location.pathname) {
      headingRef.current?.focus({ preventScroll: true });
    }
    previousPath.current = location.pathname;
  }, [location.pathname]);

  const runtime = useMemo<ConsoleRuntime>(() => ({
    api,
    health,
    dataRevision,
    refreshHealth
  }), [api, dataRevision, health, refreshHealth]);
  const connection = connectionPresentation(health);
  const indexStatus = indexPresentation(health);
  const vaultSource = resourceData(health)?.vaultSource;

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">跳到主内容</a>

      <aside className="sidebar" aria-label="小兆大脑侧边栏">
        <div className="brand-lockup" aria-label="小兆大脑">
          <span className="brand-mark" aria-hidden="true">
            <BrainCircuit strokeWidth={1.7} />
          </span>
          <span className="brand-copy">
            <strong>小兆大脑</strong>
            <small>LOCAL MIND OS</small>
          </span>
        </div>

        <div className="sidebar-section-label">WORKSPACE</div>
        <nav className="main-navigation" aria-label="主导航">
          {NAVIGATION.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
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
            <span>本地只读控制台</span>
          </div>
          <div className="workspace-bar__status" role="status" aria-label="索引运行状态">
            <CircleDot aria-hidden="true" />
            <span>{indexStatus}</span>
          </div>
        </header>

        <main id="main-content" className="main-content" tabIndex={-1}>
          <header className="page-heading">
            <div>
              <p className="page-heading__eyebrow">{identity.eyebrow}</p>
              <h1 ref={headingRef} tabIndex={-1}>{identity.title}</h1>
              <p className="page-heading__description">{identity.description}</p>
            </div>
            <div className="read-only-seal" aria-label="当前模式：只读">
              <span aria-hidden="true" />
              READ ONLY
            </div>
          </header>

          <div className="page-stage">
            <Outlet context={runtime} />
          </div>
        </main>
      </section>
    </div>
  );
}
