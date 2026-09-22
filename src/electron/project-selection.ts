import { basename } from 'node:path';
import type { DesktopProjectDirectorySelection } from '../shared/desktop/bridge.js';
import { canonicalProjectRoot } from '../server/projects/project-paths.js';

export interface ProjectDirectoryDialogResult {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}

export async function normalizeProjectSelection(
  result: ProjectDirectoryDialogResult
): Promise<DesktopProjectDirectorySelection> {
  if (result.canceled || result.filePaths.length === 0 || result.filePaths[0] === undefined) {
    return { selected: false, reason: 'cancelled' };
  }
  const path = result.filePaths[0];
  return { selected: true, path, displayName: basename(path) };
}

export async function chooseProjectDirectory(input: {
  readonly busy: boolean;
  readonly chooseDirectory: () => Promise<string | undefined>;
  readonly validateDirectory: (path: string) => Promise<string>;
}): Promise<DesktopProjectDirectorySelection> {
  if (input.busy) return { selected: false, reason: 'busy' };
  let selected: string | undefined;
  try {
    selected = await input.chooseDirectory();
  } catch {
    return { selected: false, reason: 'unavailable' };
  }
  if (selected === undefined || selected.length === 0) return { selected: false, reason: 'cancelled' };
  try {
    const canonical = await input.validateDirectory(selected);
    return { selected: true, path: canonical, displayName: basename(canonical) };
  } catch {
    return { selected: false, reason: 'unavailable' };
  }
}

export async function validateProjectSelection(selectedPath: string, protectedRoots: readonly string[]): Promise<string> {
  return canonicalProjectRoot(selectedPath, { protectedRoots });
}
