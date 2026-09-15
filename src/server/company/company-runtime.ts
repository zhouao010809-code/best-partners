import { join, resolve } from 'node:path';
import { assertCompanyRelativePath } from './company-paths.js';
import type { CompanyWorkspaceManifest } from '../../shared/company/workspace.js';

export interface CompanyPathResolver {
  readonly rootPath: string;
  resolve(relativePath: string): string;
}

export interface CompanyDatabaseProjection {
  readonly kind: 'company';
}

export interface CompanyAuthService {
  authenticate(request: unknown): Promise<{ readonly subject: string } | undefined>;
}

export interface CompanyProjectService {
  list(): Promise<readonly unknown[]>;
}

export interface CompanyRuntime {
  readonly workspace: CompanyWorkspaceManifest;
  readonly paths: CompanyPathResolver;
  readonly database: CompanyDatabaseProjection;
  readonly auth: CompanyAuthService;
  readonly projects: CompanyProjectService;
}

export interface CompanyRuntimeOptions {
  readonly workspaceRoot?: string;
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
  return {
    workspace,
    paths: { rootPath, resolve: relativePath => join(rootPath, assertCompanyRelativePath(relativePath)) },
    database: { kind: 'company' },
    auth: { authenticate: async () => undefined },
    projects: { list: async () => [] }
  };
}
