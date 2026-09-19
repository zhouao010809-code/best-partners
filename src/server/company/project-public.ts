import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { assertCompanyRelativePath } from './company-paths.js';
import type {
  CompanyProjectProjection,
  ProjectRunProjection
} from './project-service.js';
import type { ProjectScanProposal } from './project-ingestion.js';

const HIDDEN_PATH = '（工作区外路径已隐藏）';

function contained(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

/**
 * Convert an internal filesystem path into a stable company-workspace label.
 * The company browser and external Agent must never receive the Mac mini's
 * absolute path.  Paths outside the configured workspace are deliberately
 * hidden rather than guessed.
 */
export function companyDisplayPath(value: string, workspaceRoot: string): string {
  if (!isAbsolute(value)) {
    try { return assertCompanyRelativePath(value); } catch { return HIDDEN_PATH; }
  }
  let root = resolve(workspaceRoot);
  let candidate = resolve(value);
  if (contained(root, candidate)) return relative(root, candidate).split(sep).join('/');
  try { root = realpathSync(root); } catch { /* A non-existent injected root stays lexical. */ }
  try { candidate = realpathSync(candidate); } catch { /* A missing row path is hidden below. */ }
  if (!contained(root, candidate)) return HIDDEN_PATH;
  return relative(root, candidate).split(sep).join('/');
}

export function publicProjectProjection(
  project: CompanyProjectProjection,
  workspaceRoot: string
): CompanyProjectProjection {
  return {
    ...project,
    projectRoot: companyDisplayPath(project.projectRoot, workspaceRoot),
    sourceRoot: companyDisplayPath(project.sourceRoot, workspaceRoot)
  };
}

export function publicProjectProposal(
  proposal: ProjectScanProposal,
  workspaceRoot: string
): ProjectScanProposal {
  return {
    ...proposal,
    sourceRoot: companyDisplayPath(proposal.sourceRoot, workspaceRoot)
  };
}

export function publicProjectRun(
  run: ProjectRunProjection,
  workspaceRoot: string
): ProjectRunProjection {
  return { ...run, proposal: publicProjectProposal(run.proposal, workspaceRoot) };
}
