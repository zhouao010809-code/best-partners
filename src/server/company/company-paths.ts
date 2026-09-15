import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ensurePrivateDirectory } from '../db/permissions.js';

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
      if (info.isSymbolicLink()) {
        if (missing.length === 0) throw new Error('Configured workspace/state root must not be a symlink');
        const canonical = await realpath(current);
        return join(canonical, ...missing.reverse());
      }
      if (!info.isDirectory()) throw new Error('Workspace/state path is not a directory');
      const canonical = await realpath(current);
      if (missing.length === 0) {
        const parentCanonical = await realpath(dirname(current));
        if (canonical !== join(parentCanonical, basename(current))) throw new Error('Configured workspace/state root must not be a symlink');
      }
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

function sameOrContainedBy(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertOutsideState(workspace: string, state: string): void {
  if (sameOrContainedBy(state, workspace) || sameOrContainedBy(workspace, state)) {
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
  ensurePrivateDirectory(paths.rootPath);
  for (const child of [paths.incomingPath, paths.projectsPath, paths.skillsPath, paths.systemPath]) {
    ensurePrivateDirectory(child);
  }
  return paths;
}

export function assertCompanyRelativePath(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || isAbsolute(value) || /^[A-Za-z]:\//.test(value)) throw new Error('Invalid company relative path');
  const segments = value.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) throw new Error('Invalid company relative path');
  return segments.join('/');
}
