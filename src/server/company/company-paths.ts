import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface CompanyWorkspacePaths {
  readonly rootPath: string;
  readonly incomingPath: string;
  readonly projectsPath: string;
  readonly skillsPath: string;
  readonly systemPath: string;
}

export interface CompanyWorkspaceOptions {
  readonly workspaceRoot: string;
  readonly stateDirectory: string;
}

function assertRootInput(value: string, label: string): void {
  if (!value || value.includes('\0') || value.includes('\\')) throw new Error(`Invalid ${label}`);
}

async function canonicalExistingAncestor(path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory()) throw new Error('Workspace path is not a directory');
      const canonical = await realpath(current);
      // A configured existing root must not itself be a symlink. System-level
      // aliases (for example /tmp -> /private/tmp) are canonicalized safely.
      if (missing.length === 0 && canonical !== current) throw new Error('Workspace path contains a symlink');
      return join(canonical, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error('No existing ancestor for workspace path');
      missing.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

function assertOutsideState(workspace: string, state: string): void {
  const rel = relative(state, workspace);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    throw new Error('Company workspace must be outside the SQLite state directory');
  }
}

function workspaceArguments(workspaceRoot: string | CompanyWorkspaceOptions, stateDirectory?: string): [string, string] {
  if (typeof workspaceRoot === 'object') return [workspaceRoot.workspaceRoot, workspaceRoot.stateDirectory];
  if (stateDirectory === undefined) throw new Error('SQLite state directory is required');
  return [workspaceRoot, stateDirectory];
}

export async function resolveCompanyWorkspace(workspaceRoot: string | CompanyWorkspaceOptions, stateDirectory?: string): Promise<CompanyWorkspacePaths> {
  const [configuredRoot, configuredState] = workspaceArguments(workspaceRoot, stateDirectory);
  assertRootInput(configuredRoot, 'workspace root');
  assertRootInput(configuredState, 'state directory');
  const root = await canonicalExistingAncestor(configuredRoot);
  const state = await canonicalExistingAncestor(configuredState);
  assertOutsideState(root, state);
  return {
    rootPath: root,
    incomingPath: join(root, 'incoming'),
    projectsPath: join(root, 'projects'),
    skillsPath: join(root, 'skills'),
    systemPath: join(root, 'system')
  };
}

export async function ensureCompanyWorkspace(workspaceRoot: string | CompanyWorkspaceOptions, stateDirectory?: string): Promise<CompanyWorkspacePaths> {
  const paths = await resolveCompanyWorkspace(workspaceRoot, stateDirectory);
  await mkdir(paths.rootPath, { recursive: true, mode: 0o700 });
  for (const child of [paths.incomingPath, paths.projectsPath, paths.skillsPath, paths.systemPath]) {
    try {
      const info = await lstat(child);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Company workspace child is unsafe');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(child, { mode: 0o700 });
    }
  }
  return paths;
}

export function assertCompanyRelativePath(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || isAbsolute(value) || /^[A-Za-z]:\//.test(value)) throw new Error('Invalid company relative path');
  const normalized = value.split('/').filter(Boolean).join('/');
  if (!normalized || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error('Invalid company relative path');
  return normalized;
}
