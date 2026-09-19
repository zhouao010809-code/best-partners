import { Navigate, Route, Routes } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { CompanyApi } from '../components/company/company-api.js';
import { CompanyAppShell } from './CompanyAppShell.js';
import { CompanyProjectDashboardPage } from '../pages/company/CompanyProjectDashboardPage.js';
import { CompanyProjectLibraryPage } from '../pages/company/CompanyProjectLibraryPage.js';
import { CompanyProjectDetailPage } from '../pages/company/CompanyProjectDetailPage.js';
import { CompanySkillLibraryPage } from '../pages/company/CompanySkillLibraryPage.js';

export interface CompanyRouterProps {
  readonly api?: CompanyApi;
}

/** The company route tree is intentionally separate from every personal route. */
export function CompanyRouter({ api }: CompanyRouterProps = {}): ReactElement {
  return (
    <Routes>
      <Route element={<CompanyAppShell {...(api === undefined ? {} : { api })} />}>
        <Route path="company/dashboard" element={<CompanyProjectDashboardPage />} />
        <Route path="company/projects" element={<CompanyProjectLibraryPage />} />
        <Route path="company/projects/:id" element={<CompanyProjectDetailPage />} />
        <Route path="company/skills" element={<CompanySkillLibraryPage />} />
        <Route index element={<Navigate to="/company/dashboard" replace />} />
        <Route path="*" element={<Navigate to="/company/dashboard" replace />} />
      </Route>
    </Routes>
  );
}
