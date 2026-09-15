import { mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCompanyRelativePath, ensureCompanyWorkspace, resolveCompanyWorkspace } from '../../src/server/company/company-paths.js';

const roots: string[] = [];
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'company-paths-')); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('company workspace paths', () => {
  it('resolves the four workspace children without creating them', async () => {
    const base = await fixture();
    const workspaceRoot = join(base, 'workspace');
    const paths = await resolveCompanyWorkspace(workspaceRoot, join(base, 'state'));
    const canonicalBase = await realpath(base);
    expect(paths.rootPath).toBe(join(canonicalBase, 'workspace'));
    expect(paths.incomingPath).toBe(join(canonicalBase, 'workspace', 'incoming'));
    expect(paths.projectsPath).toBe(join(canonicalBase, 'workspace', 'projects'));
    expect(paths.skillsPath).toBe(join(canonicalBase, 'workspace', 'skills'));
    expect(paths.systemPath).toBe(join(canonicalBase, 'workspace', 'system'));
    await expect(realpath(workspaceRoot)).rejects.toThrow();
  });

  it('creates children only through ensureCompanyWorkspace', async () => {
    const base = await fixture();
    const workspaceRoot = join(base, 'workspace');
    await resolveCompanyWorkspace(workspaceRoot, join(base, 'state'));
    await expect(readFile(join(workspaceRoot, 'incoming'))).rejects.toThrow();
    await ensureCompanyWorkspace(workspaceRoot, join(base, 'state'));
    await expect(realpath(join(workspaceRoot, 'incoming'))).resolves.toBe(join(await realpath(base), 'workspace', 'incoming'));
  });

  it.each(['../escape', 'projects/../../escape', '/absolute', '\\absolute', 'projects\\x', 'nul\0x'])('rejects unsafe relative path %s', path => {
    expect(() => assertCompanyRelativePath(path)).toThrow();
  });

  it('rejects a symlink escape in the configured root', async () => {
    const base = await fixture();
    const outside = await fixture();
    await symlink(outside, join(base, 'workspace'));
    await expect(resolveCompanyWorkspace(join(base, 'workspace'), join(base, 'state'))).rejects.toThrow();
  });

  it('rejects a workspace root equal to or nested in the state directory', async () => {
    const base = await fixture();
    const state = join(base, 'state');
    await expect(resolveCompanyWorkspace(state, state)).rejects.toThrow();
    await expect(resolveCompanyWorkspace(join(state, 'workspace'), state)).rejects.toThrow();
  });
});
