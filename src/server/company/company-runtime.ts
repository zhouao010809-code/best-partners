import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { PublicApiError } from '../../shared/api/errors.js';
import { assertCompanyRelativePath } from './company-paths.js';
import type { CompanyWorkspaceManifest } from '../../shared/company/workspace.js';
import {
  createCompanyAuthService,
  type CompanyAuthService,
  type CompanyPrincipal
} from './company-auth-service.js';
import {
  createProjectService,
  type ProjectService
} from './project-service.js';
import {
  createSkillCatalogService,
  type SkillCatalogService
} from '../services/skill-catalog.js';
import {
  createCompanyMetricsService,
  createUnavailableCompanyMetricsService,
  type CompanyMetricsService
} from './company-metrics-service.js';

export interface CompanyPathResolver {
  readonly rootPath: string;
  resolve(relativePath: string): string;
}

export interface CompanyDatabaseProjection {
  readonly kind: 'company';
}

export interface CompanyProjectService {
  list(user?: CompanyPrincipal): Promise<readonly unknown[]>;
  scan?: ProjectService['scan'];
  getDraft?: ProjectService['getDraft'];
  confirm?: ProjectService['confirm'];
  get?: ProjectService['get'];
  create?(input: unknown, user: CompanyPrincipal): Promise<unknown>;
  listProposals?(user: CompanyPrincipal): Promise<readonly unknown[]>;
  approveProposal?(proposalId: string, user: CompanyPrincipal): Promise<unknown>;
  updateWorkspacePath?(path: string, user: CompanyPrincipal): Promise<unknown>;
}

export interface CompanyRuntime {
  readonly workspace: CompanyWorkspaceManifest;
  readonly paths: CompanyPathResolver;
  readonly database: CompanyDatabaseProjection;
  readonly auth: CompanyAuthService;
  readonly projects: CompanyProjectService;
  readonly skills: SkillCatalogService;
  readonly metrics: CompanyMetricsService;
}

export interface CompanyRuntimeOptions {
  readonly workspaceRoot?: string;
  readonly database?: Database.Database;
  readonly auth?: CompanyAuthService;
  readonly projects?: CompanyProjectService;
  readonly skills?: SkillCatalogService;
  readonly metrics?: CompanyMetricsService;
  readonly metricsPollIntervalMs?: number;
}

function unavailableAuth(): CompanyAuthService {
  const unavailable = () => {
    throw new PublicApiError('COMPANY_AUTH_UNAVAILABLE', 'Company auth is unavailable', 503);
  };
  return {
    bootstrap: async () => unavailable(),
    login: async () => unavailable(),
    authenticate: async () => undefined,
    csrfToken: async () => undefined,
    verifyCsrf: async () => false,
    logout: async () => undefined,
    can: () => false,
    requireRole: () => unavailable()
  };
}

export function createCompanyRuntime(options: CompanyRuntimeOptions = {}): CompanyRuntime {
  const rootPath = resolve(options.workspaceRoot ?? join(process.cwd(), 'company-workspace'));
  const workspace: CompanyWorkspaceManifest = {
    id: 'company',
    displayName: 'Company workspace',
    rootPath,
    incomingPath: join(rootPath, 'incoming'),
    projectsPath: join(rootPath, 'projects'),
    skillsPath: join(rootPath, 'skills'),
    systemPath: join(rootPath, 'system')
  };
  const projects: CompanyProjectService = options.projects
    ?? (options.database === undefined
      ? { list: async () => [] }
      : createProjectService({
        database: options.database,
        workspace: {
          id: workspace.id,
          rootPath: workspace.rootPath,
          incomingPath: workspace.incomingPath,
          projectsPath: workspace.projectsPath,
          skillsPath: workspace.skillsPath,
          systemPath: workspace.systemPath
        }
      }));
  const metrics = options.metrics ?? (options.database === undefined || !existsSync(workspace.rootPath)
    ? createUnavailableCompanyMetricsService()
    : createCompanyMetricsService({
      database: options.database,
      workspace: { id: workspace.id, rootPath: workspace.rootPath },
      ...(options.metricsPollIntervalMs === undefined ? {} : { pollIntervalMs: options.metricsPollIntervalMs })
    }));
  return {
    workspace,
    paths: { rootPath, resolve: relativePath => join(rootPath, assertCompanyRelativePath(relativePath)) },
    database: { kind: 'company' },
    auth: options.auth ?? (
      options.database === undefined
        ? unavailableAuth()
        : createCompanyAuthService({
          database: options.database,
          workspace: { id: workspace.id, displayName: workspace.displayName, rootPath }
        })
    ),
    projects,
    metrics,
    skills: options.skills ?? createSkillCatalogService({
      skillsRoot: workspace.skillsPath,
      allowNonCanonicalRoot: true
    })
  };
}
