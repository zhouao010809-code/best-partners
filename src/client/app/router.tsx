import { ArrowRight, Boxes, CheckCircle2 } from 'lucide-react';
import { Navigate, Route, Routes } from 'react-router-dom';
import type { ReadConsoleApi } from '../api/client.js';
import { SettingsPage } from '../pages/SettingsPage.js';
import { DashboardPage } from '../pages/DashboardPage.js';
import { KnowledgePage } from '../pages/KnowledgePage.js';
import { OperationsPage } from '../pages/OperationsPage.js';
import { QueuePage } from '../pages/QueuePage.js';
import { AppShell } from './AppShell.js';

function ExtractionPlaceholder() {
  return (
    <section className="instrument-panel phase-panel">
      <span className="phase-panel__icon"><Boxes aria-hidden="true" /></span>
      <p>ROUTE RESERVED</p>
      <h2>提炼工作流尚未安装</h2>
      <span>当前阶段只提供读取与检索，不会生成候选内容。</span>
    </section>
  );
}

function WritePlanPlaceholder() {
  return (
    <section className="instrument-panel phase-panel">
      <span className="phase-panel__icon"><CheckCircle2 aria-hidden="true" /></span>
      <p>ROUTE RESERVED</p>
      <h2>安全写入尚未启用</h2>
      <span>写入计划在后续阶段接入，当前不会修改任何正式笔记。</span>
    </section>
  );
}

function NotFoundPlaceholder() {
  return (
    <section className="instrument-panel phase-panel">
      <span className="phase-panel__icon"><ArrowRight aria-hidden="true" /></span>
      <p>UNKNOWN ROUTE</p>
      <h2>这里没有工作区</h2>
      <span>请从主导航返回已开放的只读页面。</span>
    </section>
  );
}

export interface AppRouterProps {
  readonly api?: ReadConsoleApi;
}

export function AppRouter({ api }: AppRouterProps = {}) {
  return (
    <Routes>
      <Route element={<AppShell {...(api === undefined ? {} : { api })} />}>
        <Route index element={<DashboardPage />} />
        <Route path="queue" element={<QueuePage />} />
        <Route path="knowledge" element={<KnowledgePage />} />
        <Route path="operations" element={<OperationsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="connections" element={<Navigate to="/settings" replace />} />
        <Route path="extractions/:id" element={<ExtractionPlaceholder />} />
        <Route path="write-plans/:id" element={<WritePlanPlaceholder />} />
        <Route path="not-found" element={<NotFoundPlaceholder />} />
        <Route path="*" element={<Navigate to="/not-found" replace />} />
      </Route>
    </Routes>
  );
}
