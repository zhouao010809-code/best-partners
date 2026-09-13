import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { Navigate, Route, Routes } from 'react-router-dom';
import type { ReadConsoleApi } from '../api/client.js';
import { SettingsPage } from '../pages/SettingsPage.js';
import { DashboardPage } from '../pages/DashboardPage.js';
import { KnowledgePage } from '../pages/KnowledgePage.js';
import { OperationsPage } from '../pages/OperationsPage.js';
import { QueuePage } from '../pages/QueuePage.js';
import { LibraryPage } from '../pages/LibraryPage.js';
import { TrashPage } from '../pages/TrashPage.js';
import { IntakePage } from '../pages/IntakePage.js';
import { ExtractionPage } from '../pages/ExtractionPage.js';
import { AppShell } from './AppShell.js';

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

export interface AppRouterProps {
  readonly api?: ReadConsoleApi;
}

export function AppRouter({ api }: AppRouterProps = {}) {
  return (
    <Routes>
      <Route element={<AppShell {...(api === undefined ? {} : { api })} />}>
        <Route index element={<DashboardPage />} />
        <Route path="queue" element={<QueuePage />} />
        <Route path="intake" element={<IntakePage />} />
        <Route path="library" element={<LibraryPage />} />
        <Route path="trash" element={<TrashPage />} />
        <Route path="knowledge" element={<KnowledgePage />} />
        <Route path="operations" element={<OperationsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="connections" element={<Navigate to="/settings" replace />} />
        <Route path="extractions/:id" element={<ExtractionPage />} />
        <Route path="write-plans/:id" element={<WritePlanPlaceholder />} />
        <Route path="not-found" element={<NotFoundPlaceholder />} />
        <Route path="*" element={<Navigate to="/not-found" replace />} />
      </Route>
    </Routes>
  );
}
