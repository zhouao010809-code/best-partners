import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, symlink, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { chooseProjectDirectory, normalizeProjectSelection, validateProjectSelection } from '../../src/electron/project-selection.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('project directory selection', () => {
  it('normalizes cancellation and selected paths without exposing dialog internals', async () => {
    await expect(normalizeProjectSelection({ canceled: true, filePaths: [] })).resolves.toEqual({ selected: false, reason: 'cancelled' });
    const root = '/tmp/客户项目';
    await expect(normalizeProjectSelection({ canceled: false, filePaths: [root] })).resolves.toEqual({ selected: true, path: root, displayName: basename(root) });
  });

  it('returns busy before invoking the native picker and maps cancellation', async () => {
    const chooseDirectory = vi.fn(async () => '/tmp/ignored');
    await expect(chooseProjectDirectory({ busy: true, chooseDirectory, validateDirectory: async (value) => value })).resolves.toEqual({ selected: false, reason: 'busy' });
    expect(chooseDirectory).not.toHaveBeenCalled();
    await expect(chooseProjectDirectory({ busy: false, chooseDirectory: async () => undefined, validateDirectory: async (value) => value })).resolves.toEqual({ selected: false, reason: 'cancelled' });
  });

  it('canonicalizes a real directory and rejects protected or symlink roots', async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'xiaozhao-project-selection-')));
    temporaryRoots.push(parent);
    const project = join(parent, 'client-project');
    const vault = join(parent, 'vault');
    const appData = join(parent, 'user-data');
    await Promise.all([mkdir(project), mkdir(vault), mkdir(appData)]);
    await expect(validateProjectSelection(project, [vault, appData])).resolves.toBe(project);
    await expect(validateProjectSelection(vault, [vault, appData])).rejects.toMatchObject({ code: 'PROJECT_ROOT_PROTECTED' });
    const alias = join(parent, 'alias');
    await symlink(project, alias);
    await expect(validateProjectSelection(alias, [vault, appData])).rejects.toMatchObject({ code: 'PROJECT_ROOT_SYMLINK' });
  });

  it('returns unavailable when validation fails without leaking the selected path', async () => {
    await expect(chooseProjectDirectory({ busy: false, chooseDirectory: async () => '/private/client', validateDirectory: async () => { throw new Error('absolute path detail'); } })).resolves.toEqual({ selected: false, reason: 'unavailable' });
  });
});
