import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { Suspense } from 'react';
import type { ComponentType } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import type { ReadConsoleApi } from '../api/client.js';
import { AppShell } from './AppShell.js';
import { routePages } from '#client-route-pages';

const {
  DashboardPage: DashboardRoutePage,
  QueuePage: QueueRoutePage,
  IntakePage: IntakeRoutePage,
  LibraryPage: LibraryRoutePage,
  TrashPage: TrashRoutePage,
  KnowledgePage: KnowledgeRoutePage,
  ProjectsPage: ProjectsRoutePage,
  ProjectWorkspacePage: ProjectWorkspaceRoutePage,
  SkillsPage: SkillsRoutePage,
  OperationsPage: OperationsRoutePage,
  SettingsPage: SettingsRoutePage,
  ExtractionPage: ExtractionRoutePage,
  CompanyRouter: CompanyRoute
} = routePages;

export type ClientRuntimeMode = 'pending' | 'personal' | 'company';

function WritePlanPlaceholder() {
  return (
    <section className="instrument-panel phase-panel">
      <span className="phase-panel__icon"><CheckCircle2 aria-hidden="true" /></span>
      <p>ROUTE RESERVED</p>
      <h2>这是旧版写入计划入口</h2>
      <span>个人 App 的知识入库已移至“提炼队列”：审阅候选、预览变化，再确认入库。</span>
    </section>
  );
}

function NotFoundPlaceholder() {
  return (
    <section className="instrument-panel phase-panel">
      <span className="phase-panel__icon"><ArrowRight aria-hidden="true" /></span>
      <p>UNKNOWN ROUTE</p>
      <h2>这里没有工作区</h2>
      <span>请从左侧导航返回工作区。</span>
    </section>
  );
}

function RuntimeModePendingPlaceholder() {
  return (
    <section className="instrument-panel phase-panel" aria-live="polite">
      <p>WORKSPACE MODE</p>
      <h2>正在识别工作区…</h2>
    </section>
  );
}

function RouteLoadingPlaceholder() {
  return (
    <section className="instrument-panel phase-panel" aria-live="polite">
      <p>WORKSPACE</p>
      <h2>正在加载工作区…</h2>
    </section>
  );
}

type RouteComponent = ComponentType<Record<string, never>>;

function RouteElement({ component: Component }: { readonly component: RouteComponent }) {
  return <Suspense fallback={<RouteLoadingPlaceholder />}><Component /></Suspense>;
}

export interface AppRouterProps {
  readonly api?: ReadConsoleApi;
  /** App passes the server bootstrap mode; an injected API remains personal for tests. */
  readonly runtimeMode?: ClientRuntimeMode;
}

export function AppRouter({ api, runtimeMode = 'personal' }: AppRouterProps = {}) {
  if (runtimeMode === 'company' && api === undefined) {
    return <Suspense fallback={<RuntimeModePendingPlaceholder />}><CompanyRoute /></Suspense>;
  }
  return (
    <Routes>
      <Route element={<AppShell {...(api === undefined ? {} : { api })} suspendDataEffects={runtimeMode === 'pending'} />}>
        <Route index element={<RouteElement component={DashboardRoutePage} />} />
        <Route path="queue" element={<RouteElement component={QueueRoutePage} />} />
        <Route path="intake" element={<RouteElement component={IntakeRoutePage} />} />
        <Route path="library" element={<RouteElement component={LibraryRoutePage} />} />
        <Route path="trash" element={<RouteElement component={TrashRoutePage} />} />
        <Route path="knowledge" element={<RouteElement component={KnowledgeRoutePage} />} />
        <Route path="projects" element={<RouteElement component={ProjectsRoutePage} />} />
        <Route path="projects/:id" element={<RouteElement component={ProjectWorkspaceRoutePage} />} />
        <Route path="skills" element={<RouteElement component={SkillsRoutePage} />} />
        <Route path="operations" element={<RouteElement component={OperationsRoutePage} />} />
        <Route path="settings" element={<RouteElement component={SettingsRoutePage} />} />
        <Route path="connections" element={<Navigate to="/settings" replace />} />
        <Route path="extractions/:id" element={<RouteElement component={ExtractionRoutePage} />} />
        <Route path="write-plans/:id" element={<WritePlanPlaceholder />} />
        <Route path="not-found" element={<NotFoundPlaceholder />} />
        <Route path="*" element={runtimeMode === 'pending'
          ? <RuntimeModePendingPlaceholder />
          : <Navigate to="/not-found" replace />} />
      </Route>
    </Routes>
  );
}
