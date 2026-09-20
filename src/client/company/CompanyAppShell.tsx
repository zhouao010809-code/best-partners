import { useCallback, useEffect, useMemo, useState, createContext, useContext } from 'react';
import type { FormEvent, ReactNode, ReactElement } from 'react';
import { Activity, Bot, FolderKanban, LayoutDashboard, LogIn, RefreshCw, Sparkles } from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { browserCompanyApi, type CompanyApi, type CompanyApiResult, type CompanySession } from '../components/company/company-api.js';
import '../styles/company.css';

export interface CompanyRuntimeContext {
  readonly api: CompanyApi;
  readonly session?: CompanySession;
  readonly sessionStatus: 'loading' | 'ready' | 'unauthenticated' | 'failed';
  readonly refreshSession: () => Promise<void>;
  readonly acceptSession: (session: CompanySession) => void;
}

const CompanyRuntimeContext = createContext<CompanyRuntimeContext | undefined>(undefined);

export function useCompanyRuntime(): CompanyRuntimeContext {
  const runtime = useContext(CompanyRuntimeContext);
  if (runtime === undefined) throw new Error('useCompanyRuntime must be used inside CompanyAppShell');
  return runtime;
}

export interface CompanyAppShellProps {
  readonly api?: CompanyApi;
  readonly initialSession?: CompanySession;
}

function resultMessage(result: CompanyApiResult<unknown>, fallback: string): string {
  return !result.ok && !('cancelled' in result) ? (result.state.message || fallback) : fallback;
}

function CompanyLogin({ onLoggedIn }: { readonly onLoggedIn: (session: CompanySession) => void }): ReactElement {
  const { api } = useCompanyRuntime();
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    const result = await api.auth.login(displayName.trim(), password);
    setSubmitting(false);
    if (!result.ok) {
      setError(resultMessage(result, '登录公司工作区失败，请重试。'));
      return;
    }
    onLoggedIn(result.value);
  }

  return (
    <section className="company-auth-card" aria-labelledby="company-login-title">
      <span className="company-auth-card__icon" aria-hidden="true"><LogIn size={18} /></span>
      <p className="company-eyebrow">COMPANY WORKSPACE / AUTH</p>
      <h2 id="company-login-title">进入公司工作区</h2>
      <p>项目资料和 Skill 只在公司 Mac mini 的共享工作区内流转。</p>
      <form onSubmit={(event) => void submit(event)}>
        <label>账号<input aria-label="公司账号" value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="username" required /></label>
        <label>密码<input aria-label="公司密码" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
        {error && <p className="company-inline-error" role="alert">{error}</p>}
        <button type="submit" className="company-primary-button" disabled={submitting}>{submitting ? '正在进入…' : '进入工作区'}</button>
      </form>
    </section>
  );
}

function CompanyAuthBoundary({ children }: { readonly children: ReactNode }): ReactElement {
  const runtime = useCompanyRuntime();
  const [loginSession, setLoginSession] = useState<CompanySession>();
  const session = loginSession ?? runtime.session;
  if (runtime.sessionStatus === 'loading') {
    return <section className="company-empty-state" aria-live="polite"><RefreshCw className="company-spin" size={18} />正在连接公司工作区…</section>;
  }
  if (runtime.sessionStatus === 'failed') {
    return <section className="company-empty-state"><p role="alert">公司会话暂时无法读取。</p><button type="button" className="company-secondary-button" onClick={() => void runtime.refreshSession()}>重新连接</button></section>;
  }
  if (runtime.sessionStatus === 'unauthenticated' && session === undefined) {
    return <CompanyLogin onLoggedIn={(next) => { setLoginSession(next); runtime.acceptSession(next); }} />;
  }
  return <>{children}</>;
}

export function CompanyAppShell({ api = browserCompanyApi, initialSession }: CompanyAppShellProps): ReactElement {
  const location = useLocation();
  const [session, setSession] = useState<CompanySession | undefined>(initialSession);
  const [sessionStatus, setSessionStatus] = useState<CompanyRuntimeContext['sessionStatus']>(initialSession ? 'ready' : 'loading');
  const [agentOpen, setAgentOpen] = useState(false);

  const refreshSession = useCallback(async (): Promise<void> => {
    setSessionStatus('loading');
    const result = await api.auth.session();
    if (result.ok) {
      setSession(result.value);
      setSessionStatus('ready');
    } else if ('code' in result && result.code === 'COMPANY_SESSION_REQUIRED') {
      setSession(undefined);
      setSessionStatus('unauthenticated');
    } else if ('cancelled' in result) {
      return;
    } else {
      setSessionStatus('failed');
    }
  }, [api]);

  useEffect(() => {
    if (initialSession !== undefined) return;
    void refreshSession();
  }, [initialSession, refreshSession]);

  const acceptSession = useCallback((next: CompanySession): void => {
    setSession(next);
    setSessionStatus('ready');
  }, []);
  const runtime = useMemo<CompanyRuntimeContext>(() => ({ api, ...(session === undefined ? {} : { session }), sessionStatus, refreshSession, acceptSession }), [acceptSession, api, refreshSession, session, sessionStatus]);
  const activeLabel = location.pathname.includes('/skills') ? 'Skill 库' : location.pathname.includes('/projects') ? '项目档案库' : '项目数据看板';

  return (
    <CompanyRuntimeContext.Provider value={runtime}>
      <div className="company-app-frame">
        <a className="company-skip-link" href="#company-main-content">跳到主内容</a>
        <aside className="company-sidebar" aria-label="公司工作区侧边栏">
          <div className="company-brand"><span className="company-brand__mark" aria-hidden="true"><FolderKanban size={19} /></span><span><strong>最佳拍档</strong><small>COMPANY OPS</small></span></div>
          <div className="company-sidebar__workspace"><span className="company-sidebar__dot" aria-hidden="true" />公司项目工作区</div>
          <nav className="company-navigation" aria-label="公司主导航">
            <NavLink to="/company/dashboard" end className={({ isActive }) => `company-nav-item${isActive ? ' is-active' : ''}`}><LayoutDashboard size={17} aria-hidden="true" /><span>项目数据看板</span></NavLink>
            <NavLink to="/company/projects" className={({ isActive }) => `company-nav-item${isActive ? ' is-active' : ''}`}><FolderKanban size={17} aria-hidden="true" /><span>项目档案库</span></NavLink>
            <NavLink to="/company/skills" className={({ isActive }) => `company-nav-item${isActive ? ' is-active' : ''}`}><Sparkles size={17} aria-hidden="true" /><span>Skill 库</span></NavLink>
          </nav>
          <div className="company-sidebar__footer">
            <button type="button" className={`company-agent-button${agentOpen ? ' is-open' : ''}`} aria-label="打开 Agent 连接说明" onClick={() => setAgentOpen(value => !value)}><Bot size={17} aria-hidden="true" /><span>Agent 连接</span><span className="company-agent-button__status" aria-hidden="true" /></button>
            <div className="company-user-badge" role="status" aria-label="公司会话状态"><span>{session?.user.displayName ?? '未登录'}</span><small>{session?.user.role ?? '需要登录'}</small></div>
          </div>
        </aside>
        <section className="company-workspace" aria-label="公司项目工作区">
          <header className="company-topbar"><div><Activity size={16} aria-hidden="true" /><span>{activeLabel}</span></div><span className="company-topbar__mode">SHARED / MAC MINI</span></header>
          {agentOpen && <aside className="company-agent-popover" role="status" aria-label="Agent 连接说明"><strong>Agent 连接</strong><div className="company-agent-popover__badges"><span>外部 Codex / WorkBuddy</span><span>默认只读</span></div><p>项目助理会生成带当前项目范围的受控任务提示，复制后交给外部 Agent。网页不内置聊天；扫描、导入和项目确认仍需显式开启对应写入。</p></aside>}
          <main id="company-main-content" className="company-main" tabIndex={-1}><CompanyAuthBoundary><Outlet /></CompanyAuthBoundary></main>
        </section>
      </div>
    </CompanyRuntimeContext.Provider>
  );
}
