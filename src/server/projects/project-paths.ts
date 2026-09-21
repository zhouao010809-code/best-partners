import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { projectCategorySchema, isProjectRelativePath, type ProjectCategory } from '../../shared/api/projects.js';

type CodedError = Error & { code: string };

function coded(code: string, message: string): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  return error;
}

function contained(parent: string, candidate: string): boolean {
  const value = relative(parent, candidate);
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

async function canonicalExistingPath(value: string, label: string): Promise<string> {
  const canonical = await realpath(value);
  const info = await lstat(canonical);
  if (!info.isDirectory()) throw coded('PROJECT_ROOT_INVALID', `${label} must be a directory`);
  return canonical;
}

/** Resolve and validate a user-selected project folder without following a symlink root. */
export async function canonicalProjectRoot(selectedPath: string, input: { protectedRoots: readonly string[] }): Promise<string> {
  if (typeof selectedPath !== 'string' || selectedPath.length === 0) throw coded('PROJECT_ROOT_INVALID', 'Project root is required');
  const info = await lstat(selectedPath);
  if (info.isSymbolicLink()) throw coded('PROJECT_ROOT_SYMLINK', 'Project root must not be a symbolic link');
  if (!info.isDirectory()) throw coded('PROJECT_ROOT_INVALID', 'Project root must be a real directory');
  const root = await realpath(selectedPath);
  const afterResolve = await lstat(selectedPath);
  if (afterResolve.isSymbolicLink() || !afterResolve.isDirectory()) throw coded('PROJECT_ROOT_INVALID', 'Project root changed while resolving');
  for (const protectedRoot of input.protectedRoots) {
    const canonicalProtected = await canonicalExistingPath(protectedRoot, 'Protected root');
    if (contained(canonicalProtected, root) || contained(root, canonicalProtected)) {
      throw coded('PROJECT_ROOT_PROTECTED', 'Project root overlaps a protected root');
    }
  }
  return root;
}

export function assertProjectRelativePath(value: string): string {
  if (!isProjectRelativePath(value)) throw coded('PROJECT_PATH_INVALID', 'Project path must be a safe relative path');
  return value;
}

export function resolveProjectPath(root: string, relativePath: string): string {
  const safe = assertProjectRelativePath(relativePath);
  const canonicalRoot = resolve(root);
  const candidate = resolve(canonicalRoot, ...safe.split('/'));
  if (!contained(canonicalRoot, candidate)) throw coded('PROJECT_PATH_INVALID', 'Project path escapes the project root');
  return candidate;
}

export function resolveProjectOutputPath(root: string, category: ProjectCategory, filename: string): string {
  const parsedCategory = projectCategorySchema.safeParse(category);
  if (!parsedCategory.success) throw coded('PROJECT_PATH_INVALID', 'Project output category is invalid');
  if (filename.includes('/')) throw coded('PROJECT_PATH_INVALID', 'Project output filename must be a single path segment');
  assertProjectRelativePath(filename);
  return resolveProjectPath(root, `AI工作区/${parsedCategory.data}/${filename}`);
}
