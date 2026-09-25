import { lazy } from 'react';
import type { ComponentType } from 'react';

const page = (path: string, exportName: string, loader: () => Promise<Record<string, unknown>>) => lazy(async () => {
  const module = await loader();
  const component = module[exportName];
  if (typeof component !== 'function') throw new Error(`ROUTE_COMPONENT_MISSING:${path}:${exportName}`);
  return { default: component as ComponentType<Record<string, never>> };
});

export const routePages = {
  DashboardPage: page('../pages/DashboardPage.js', 'DashboardPage', async () => import('../pages/DashboardPage.js')),
  QueuePage: page('../pages/QueuePage.js', 'QueuePage', async () => import('../pages/QueuePage.js')),
  IntakePage: page('../pages/IntakePage.js', 'IntakePage', async () => import('../pages/IntakePage.js')),
  LibraryPage: page('../pages/LibraryPage.js', 'LibraryPage', async () => import('../pages/LibraryPage.js')),
  TrashPage: page('../pages/TrashPage.js', 'TrashPage', async () => import('../pages/TrashPage.js')),
  KnowledgePage: page('../pages/KnowledgePage.js', 'KnowledgePage', async () => import('../pages/KnowledgePage.js')),
  ProjectsPage: page('../pages/ProjectsPage.js', 'ProjectsPage', async () => import('../pages/ProjectsPage.js')),
  ProjectWorkspacePage: page('../pages/ProjectWorkspacePage.js', 'ProjectWorkspacePage', async () => import('../pages/ProjectWorkspacePage.js')),
  SkillsPage: page('../pages/SkillsPage.js', 'SkillsPage', async () => import('../pages/SkillsPage.js')),
  OperationsPage: page('../pages/OperationsPage.js', 'OperationsPage', async () => import('../pages/OperationsPage.js')),
  SettingsPage: page('../pages/SettingsPage.js', 'SettingsPage', async () => import('../pages/SettingsPage.js')),
  ExtractionPage: page('../pages/ExtractionPage.js', 'ExtractionPage', async () => import('../pages/ExtractionPage.js')),
  CompanyRouter: page('../company/company-router.js', 'CompanyRouter', async () => import('../company/company-router.js'))
};
