import { useEffect, useRef } from 'react';
import {
  Activity,
  BookOpenText,
  BrainCircuit,
  CircleDot,
  DatabaseZap,
  GitPullRequestArrow,
  LayoutDashboard,
  ListFilter,
  RadioTower
} from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

const NAVIGATION = [
  { to: '/', label: '大脑总览', icon: LayoutDashboard, end: true },
  { to: '/queue', label: '提炼队列', icon: ListFilter, end: false },
  { to: '/knowledge', label: '知识库', icon: BookOpenText, end: false },
  { to: '/operations', label: '操作记录', icon: GitPullRequestArrow, end: false },
  { to: '/connections', label: '系统连接', icon: RadioTower, end: false }
] as const;

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
        title: '操作记录',
        description: '查看可追溯的本地任务与安全结果。'
      };
    case '/connections':
      return {
        eyebrow: 'SYSTEM / DIAGNOSTICS',
        title: '系统连接',
        description: '检查 Obsidian、索引、模型与写入门的实时状态。'
      };
    default:
      return {
        eyebrow: 'SYSTEM / 404',
        title: '页面未找到',
        description: '该路径不在当前的本地工作区中。'
      };
  }
}

export function AppShell() {
  const location = useLocation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousPath = useRef<string | undefined>(undefined);
  const identity = pageIdentity(location.pathname);

  useEffect(() => {
    if (previousPath.current !== undefined && previousPath.current !== location.pathname) {
      headingRef.current?.focus({ preventScroll: true });
    }
    previousPath.current = location.pathname;
  }, [location.pathname]);

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
            className="connection-badge connection-badge--pending"
            role="status"
            aria-label="本地连接状态"
          >
            <span className="connection-badge__signal" aria-hidden="true" />
            <span>
              <strong>连接待检查</strong>
              <small>127.0.0.1 · 未验证</small>
            </span>
          </div>
          <div className="vault-signature">
            <DatabaseZap aria-hidden="true" />
            <span>
              <small>ACTIVE VAULT</small>
              <strong>我的大脑</strong>
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
          <div className="workspace-bar__status">
            <CircleDot aria-hidden="true" />
            <span>索引待同步</span>
          </div>
        </header>

        <main id="main-content" className="main-content">
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
            <Outlet />
          </div>
        </main>
      </section>
    </div>
  );
}
