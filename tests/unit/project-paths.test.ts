import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertProjectRelativePath, canonicalProjectRoot, resolveProjectOutputPath, resolveProjectPath } from '../../src/server/projects/project-paths.js';

async function folder(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `xiaozhao-${name}-`));
}

describe('project paths', () => {
  it('canonicalizes a real directory and rejects symlink roots', async () => {
    const root = await folder('root');
    const parent = await folder('parent');
    const link = join(parent, 'link');
    await symlink(root, link);
    await expect(canonicalProjectRoot(root, { protectedRoots: [] })).resolves.toBe(await realpath(root));
    await expect(canonicalProjectRoot(link, { protectedRoots: [] })).rejects.toMatchObject({ code: 'PROJECT_ROOT_SYMLINK' });
  });

  it('rejects protected roots in either containment direction', async () => {
    const parent = await folder('protected');
    const child = join(parent, 'child');
    await mkdir(child);
    await expect(canonicalProjectRoot(child, { protectedRoots: [parent] })).rejects.toMatchObject({ code: 'PROJECT_ROOT_PROTECTED' });
    await expect(canonicalProjectRoot(parent, { protectedRoots: [child] })).rejects.toMatchObject({ code: 'PROJECT_ROOT_PROTECTED' });
  });

  it('validates relative paths and output paths', async () => {
    for (const value of ['', '.', '..', './note.md', '../note.md', 'a/../b', 'a\\b', '/tmp/x', 'C:/tmp/x', 'a//b', `a\u0000b`]) {
      expect(() => assertProjectRelativePath(value)).toThrow();
    }
    expect(assertProjectRelativePath('docs/note.md')).toBe('docs/note.md');
    const root = await folder('output');
    const resolved = resolveProjectPath(root, 'docs/note.md');
    expect(resolved).toBe(join(root, 'docs', 'note.md'));
    expect(() => resolveProjectPath(root, '../outside')).toThrow();
    expect(resolveProjectOutputPath(root, '内容草稿', 'week-1.md')).toBe(join(root, 'AI工作区', '内容草稿', 'week-1.md'));
    expect(() => resolveProjectOutputPath(root, '内容草稿', 'nested/week-1.md')).toThrow();
  });

  it('does not mistake a valid file for a root directory', async () => {
    const root = await folder('file');
    const file = join(root, 'file.txt');
    await writeFile(file, 'x');
    await expect(canonicalProjectRoot(file, { protectedRoots: [] })).rejects.toThrow();
  });
});
