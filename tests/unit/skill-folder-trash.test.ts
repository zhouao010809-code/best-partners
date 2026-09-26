import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { renameSync } from 'node:fs';
import { createSkillCatalogService } from '../../src/server/services/skill-catalog.js';

const roots: string[] = [];
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
afterEach(async () => {
  vi.useRealTimers();
  vi.mocked(renameSync).mockReset();
  vi.mocked(renameSync).mockImplementation((await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync);
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('keeps completed restore history completed when users later reorganize the restored folder', async () => {
  const f = await fixture();
  const preview = await f.catalog.previewFolderTrash!(f.folder.id);
  const entry = await f.catalog.trashFolder!(preview.id);
  await f.catalog.restoreFolder!(entry.id);
  await writeFile(join(f.path, 'later-file'), 'new content');
  await rename(f.path, join(f.root, 'later-name'));
  expect((await f.catalog.listFolderTrash!()).items[0]?.status).toBe('restored');
  expect((await f.catalog.restoreFolder!(entry.id)).status).toBe('restored');
});

it('does not report success on rename failure or journal failure and recovers a completed move after restart', async () => {
  const f = await fixture();
  await writeFile(join(f.path, 'keep'), 'original');
  const failed = await f.catalog.previewFolderTrash!(f.folder.id);
  vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('simulated rename failure'); });
  await expect(f.catalog.trashFolder!(failed.id)).rejects.toMatchObject({ code: 'SKILL_FOLDER_TRASH_FAILED' });
  await expect(readFile(join(f.path, 'keep'), 'utf8')).resolves.toBe('original');
  const completed = await f.catalog.previewFolderTrash!(f.folder.id);
  const actual = (await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync;
  vi.mocked(renameSync).mockImplementation((source, destination) => {
    if (String(source).includes('.metadata-')) throw new Error('simulated journal failure');
    actual(source, destination);
  });
  await expect(f.catalog.trashFolder!(completed.id)).rejects.toMatchObject({ code: 'SKILL_FOLDER_TRASH_FAILED' });
  vi.mocked(renameSync).mockImplementation(actual);
  const reopened = createSkillCatalogService({ skillsRoot: f.root });
  expect((await reopened.listFolderTrash!()).items.find(item => item.id === completed.id)?.status).toBe('trashed');
  await reopened.restoreFolder!(completed.id);
  await expect(readFile(join(f.path, 'keep'), 'utf8')).resolves.toBe('original');
});
async function fixture(name = '写作') {
  const vault = await mkdtemp(join(tmpdir(), 'skill-folder-trash-'));
  roots.push(vault);
  const root = join(vault, '.claude', 'skills');
  await mkdir(root, { recursive: true });
  const catalog = createSkillCatalogService({ skillsRoot: root });
  const folder = await catalog.createFolder(name);
  return { vault, root, catalog, folder, path: join(root, name) };
}

it('moves an entire populated folder without rewriting hidden or unrecognized files and restores after restart', async () => {
  const f = await fixture();
  await mkdir(join(f.path, 'writer'));
  await writeFile(join(f.path, 'writer', 'SKILL.md'), '# Writer\r\n');
  await mkdir(join(f.path, 'unknown', 'nested'), { recursive: true });
  const bytes = Buffer.from([0, 255, 1, 13, 10]);
  await writeFile(join(f.path, 'unknown', 'nested', '.private'), bytes);
  await writeFile(join(f.path, '.hidden'), 'hidden');
  const skill = (await f.catalog.list()).items[0]!;
  const preview = await f.catalog.previewFolderTrash!(f.folder.id);
  expect(preview).toMatchObject({ folderId: f.folder.id, name: '写作', skillCount: 1, entryCount: 3 });
  expect(await readdir(f.path)).toHaveLength(3);
  expect(JSON.stringify(preview)).not.toContain(f.root);
  const entry = await f.catalog.trashFolder!(preview.id);
  expect(entry.status).toBe('trashed');
  await expect(readFile(join(f.path, '.hidden'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await f.catalog.list()).toEqual({ folders: [], items: [] });
  const reopened = createSkillCatalogService({ skillsRoot: f.root });
  expect((await reopened.listFolderTrash!()).items).toEqual([entry]);
  expect((await reopened.restoreFolder!(entry.id)).status).toBe('restored');
  await expect(readFile(join(f.path, 'unknown', 'nested', '.private'))).resolves.toEqual(bytes);
  await expect(readFile(join(f.path, '.hidden'), 'utf8')).resolves.toBe('hidden');
  await expect(readFile(join(f.path, 'writer', 'SKILL.md'), 'utf8')).resolves.toBe('# Writer\r\n');
  expect((await reopened.list()).items[0]?.id).toBe(skill.id);
  expect((await reopened.restoreFolder!(entry.id)).status).toBe('restored');
});

it('recycles an empty category and supports repeat confirmation and immediate undo', async () => {
  const f = await fixture();
  const preview = await f.catalog.previewFolderTrash!(f.folder.id);
  expect(preview.entryCount).toBe(0);
  const first = await f.catalog.trashFolder!(preview.id);
  expect(await f.catalog.trashFolder!(preview.id)).toEqual(first);
  await f.catalog.restoreFolder!(first.id);
  expect(await readdir(f.path)).toEqual([]);
});

it('refuses restore when the original name now belongs to an empty directory, preserving both versions', async () => {
  const f = await fixture();
  await writeFile(join(f.path, 'keep'), 'original');
  const preview = await f.catalog.previewFolderTrash!(f.folder.id);
  const entry = await f.catalog.trashFolder!(preview.id);
  await mkdir(f.path);
  await expect(f.catalog.restoreFolder!(entry.id)).rejects.toMatchObject({ code: 'SKILL_FOLDER_RESTORE_CONFLICT' });
  expect(await readdir(f.path)).toEqual([]);
  expect((await f.catalog.listFolderTrash!()).items[0]?.status).toBe('trashed');
  await rename(f.path, join(f.root, 'new-name'));
  await f.catalog.restoreFolder!(entry.id);
  await expect(readFile(join(f.path, 'keep'), 'utf8')).resolves.toBe('original');
});

it('rejects unclassified skill directories, invalid identifiers and company capabilities', async () => {
  const f = await fixture();
  await writeFile(join(f.path, 'SKILL.md'), '# This is a skill');
  await expect(f.catalog.previewFolderTrash!(f.folder.id)).rejects.toMatchObject({ code: 'SKILL_FOLDER_NOT_FOUND' });
  await expect(f.catalog.previewFolderTrash!('../outside')).rejects.toMatchObject({ code: 'SKILL_FOLDER_INVALID' });
  const company = createSkillCatalogService({ skillsRoot: f.root, allowNonCanonicalRoot: true });
  expect(company.previewFolderTrash).toBeUndefined();
  expect(company.restoreFolder).toBeUndefined();
});

it('rejects expired previews and changed or replaced folders without moving either version', async () => {
  const f = await fixture();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-26T12:00:00Z'));
  const expired = await f.catalog.previewFolderTrash!(f.folder.id);
  vi.setSystemTime(new Date('2026-09-26T12:10:00Z'));
  await expect(f.catalog.trashFolder!(expired.id)).rejects.toMatchObject({ code: 'SKILL_FOLDER_PREVIEW_STALE' });
  const changed = await f.catalog.previewFolderTrash!(f.folder.id);
  await writeFile(join(f.path, '.new-file'), 'keep');
  await expect(f.catalog.trashFolder!(changed.id)).rejects.toMatchObject({ code: 'SKILL_FOLDER_PREVIEW_STALE' });
  const replaced = await f.catalog.previewFolderTrash!(f.folder.id);
  await rename(f.path, join(f.root, 'held-original'));
  await mkdir(f.path);
  await expect(f.catalog.trashFolder!(replaced.id)).rejects.toMatchObject({ code: 'SKILL_FOLDER_PREVIEW_STALE' });
  await expect(readFile(join(f.root, 'held-original', '.new-file'), 'utf8')).resolves.toBe('keep');
});

it('rejects root identity replacement and symlinked descendants or recycle areas', async () => {
  const f = await fixture();
  const preview = await f.catalog.previewFolderTrash!(f.folder.id);
  await rename(f.root, join(f.vault, '.claude', 'held-skills'));
  await mkdir(f.path, { recursive: true });
  await expect(f.catalog.trashFolder!(preview.id)).rejects.toMatchObject({ code: 'SKILL_FOLDER_ROOT_CHANGED' });
  const g = await fixture('linked');
  await symlink(g.vault, join(g.path, 'outside'));
  await expect(g.catalog.previewFolderTrash!(g.folder.id)).rejects.toMatchObject({ code: 'SKILL_FOLDER_UNSAFE' });
  await rm(join(g.path, 'outside'));
  const safe = await g.catalog.previewFolderTrash!(g.folder.id);
  await symlink(g.vault, join(g.root, '.trash'));
  await expect(g.catalog.trashFolder!(safe.id)).rejects.toMatchObject({ code: 'SKILL_FOLDER_TRASH_UNSAFE' });
  expect(await readdir(g.path)).toEqual([]);
});

it('does not claim preexisting .trash content and refuses tampered recycle metadata', async () => {
  const f = await fixture();
  await mkdir(join(f.root, '.trash'));
  await writeFile(join(f.root, '.trash', 'owned-by-user'), 'keep');
  const preview = await f.catalog.previewFolderTrash!(f.folder.id);
  await expect(f.catalog.trashFolder!(preview.id)).rejects.toMatchObject({ code: 'SKILL_FOLDER_TRASH_UNSAFE' });
  await expect(readFile(join(f.root, '.trash', 'owned-by-user'), 'utf8')).resolves.toBe('keep');
  const g = await fixture();
  const p = await g.catalog.previewFolderTrash!(g.folder.id);
  const entry = await g.catalog.trashFolder!(p.id);
  await writeFile(join(g.root, '.trash', entry.id, 'metadata.json'), '{broken');
  await expect(g.catalog.restoreFolder!(entry.id)).rejects.toMatchObject({ code: 'SKILL_FOLDER_TRASH_UNSAFE' });
  expect((await g.catalog.listFolderTrash!()).items[0]?.status).toBe('needs-review');
});

it('retains both versions when the recycle payload is changed or replaced with a symlink', async () => {
  const f = await fixture();
  await writeFile(join(f.path, 'keep'), 'original');
  const preview = await f.catalog.previewFolderTrash!(f.folder.id);
  const entry = await f.catalog.trashFolder!(preview.id);
  const payload = join(f.root, '.trash', entry.id, 'folder');
  await writeFile(join(payload, 'keep'), 'externally changed');
  await expect(f.catalog.restoreFolder!(entry.id)).rejects.toMatchObject({ code: 'SKILL_FOLDER_TRASH_UNSAFE' });
  await expect(readFile(join(payload, 'keep'), 'utf8')).resolves.toBe('externally changed');
  await rename(payload, join(f.vault, 'held-recycle'));
  await symlink(f.vault, payload);
  await expect(f.catalog.restoreFolder!(entry.id)).rejects.toMatchObject({ code: 'SKILL_FOLDER_TRASH_UNSAFE' });
  await expect(readFile(join(f.vault, 'held-recycle', 'keep'), 'utf8')).resolves.toBe('externally changed');
});

it('reconciles a restore interrupted after directory rename without overwriting or moving it again', async () => {
  const f = await fixture();
  await writeFile(join(f.path, 'keep'), 'original');
  const preview = await f.catalog.previewFolderTrash!(f.folder.id);
  const entry = await f.catalog.trashFolder!(preview.id);
  const actual = (await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync;
  let journals = 0;
  vi.mocked(renameSync).mockImplementation((source, destination) => {
    if (String(source).includes('.metadata-') && ++journals === 2) throw Error('interrupted restore receipt');
    actual(source, destination);
  });
  await expect(f.catalog.restoreFolder!(entry.id)).rejects.toMatchObject({ code: 'SKILL_FOLDER_TRASH_FAILED' });
  vi.mocked(renameSync).mockImplementation(actual);
  const reopened = createSkillCatalogService({ skillsRoot: f.root });
  expect((await reopened.listFolderTrash!()).items[0]?.status).toBe('restored');
  expect((await reopened.restoreFolder!(entry.id)).status).toBe('restored');
  await expect(readFile(join(f.path, 'keep'), 'utf8')).resolves.toBe('original');
});

it('shows an empty recycle list before the personal Skill root exists without creating it or hiding unsafe roots', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'skill-folder-trash-fresh-')); roots.push(vault);
  const root = join(vault, '.claude', 'skills');
  const catalog = createSkillCatalogService({ skillsRoot: root });
  expect(await catalog.listFolderTrash!()).toEqual({ items: [] });
  expect(await readdir(vault)).toEqual([]);
  await symlink(vault, join(vault, '.claude'));
  await expect(catalog.listFolderTrash!()).rejects.toMatchObject({ code: 'SKILL_CATALOG_UNAVAILABLE' });
});

it('refuses restoration when it would introduce a duplicate Skill directory elsewhere in the catalog', async () => {
  const f = await fixture();
  await mkdir(join(f.path, 'writer'));
  await writeFile(join(f.path, 'writer', 'SKILL.md'), '# Original writer');
  const preview = await f.catalog.previewFolderTrash!(f.folder.id);
  const entry = await f.catalog.trashFolder!(preview.id);
  await mkdir(join(f.root, 'other', 'writer'), { recursive: true });
  await writeFile(join(f.root, 'other', 'writer', 'SKILL.md'), '# A different writer');
  await expect(f.catalog.restoreFolder!(entry.id)).rejects.toMatchObject({ code: 'SKILL_FOLDER_RESTORE_CONFLICT' });
  expect((await f.catalog.list()).items).toHaveLength(1);
  expect((await f.catalog.listFolderTrash!()).items[0]?.status).toBe('trashed');
  await expect(readFile(join(f.root, '.trash', entry.id, 'folder', 'writer', 'SKILL.md'), 'utf8')).resolves.toBe('# Original writer');
});

it('persists reconciliation when listing a completed restore so later live edits do not revive a pending operation', async () => {
  const f = await fixture();
  const entry = await f.catalog.trashFolder!((await f.catalog.previewFolderTrash!(f.folder.id)).id);
  const actual = (await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync;
  let journals = 0;
  vi.mocked(renameSync).mockImplementation((source, destination) => {
    if (String(source).includes('.metadata-') && ++journals === 2) throw Error('lost receipt');
    actual(source, destination);
  });
  await expect(f.catalog.restoreFolder!(entry.id)).rejects.toMatchObject({ code: 'SKILL_FOLDER_TRASH_FAILED' });
  vi.mocked(renameSync).mockImplementation(actual);
  const reopened = createSkillCatalogService({ skillsRoot: f.root });
  expect((await reopened.listFolderTrash!()).items[0]?.status).toBe('restored');
  await writeFile(join(f.path, 'later'), 'a normal edit');
  expect((await reopened.listFolderTrash!()).items[0]?.status).toBe('restored');
});
