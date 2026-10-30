import { afterEach, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkdiskService } from '../../src/server/workdisk/service.js';
import { assertRoot } from '../../src/server/workdisk/paths.js';
import { normalizeVolumeUuid, parseVolumeUuid, resolveVolumeIdentity } from '../../src/server/workdisk/volume-identity.js';

const UUID = '12345678-1234-5678-ABCD-123456789012';
const OTHER_UUID = '87654321-1234-5678-ABCD-123456789012';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'workdisk-volume-'))); cleanup.push(() => rm(base, { recursive: true, force: true }));
  const root = join(base, '工作盘'), other = join(base, '另一工作盘'), vault = join(base, '知识库'), stateDirectory = join(base, 'state');
  await Promise.all([root, other, vault, stateDirectory].map(path => mkdir(path)));
  const resolver = vi.fn(async (_path: string): Promise<string | undefined> => UUID);
  const config = { stateDirectory, protectedRoots: [vault], volumeIdentityResolver: resolver };
  const make = () => { const service = createWorkdiskService(config); cleanup.push(() => service.close()); return service; };
  const service = make(); const binding = await service.bind(root); const path = join(stateDirectory, 'workdisk.json');
  const stored = async () => JSON.parse(await readFile(path, 'utf8'));
  const edit = async (change: (value: Record<string, unknown>) => void) => { const value = await stored(); change(value); await writeFile(path, JSON.stringify(value)); };
  return { base, root, other, vault, stateDirectory, service, binding, config, resolver, path, stored, edit, make };
}

it('records a stable volume and root birth time without exposing them or resolving on every poll', async () => {
  const f = await fixture(); const actual = await lstat(f.root);
  expect(await f.stored()).toMatchObject({ volumeUuid: UUID, birthtimeMs: actual.birthtimeMs });
  expect(f.binding).not.toHaveProperty('volumeUuid'); expect(f.binding).not.toHaveProperty('birthtimeMs');
  await f.service.validateBinding(); await f.service.list(); await f.service.validateBinding(); expect(f.resolver).toHaveBeenCalledTimes(1);
});
it('recovers a cold-start remount from list using the recorded UUID, inode and birth time', async () => {
  const f = await fixture(); await writeFile(join(f.root, '保留.txt'), '原件'); await f.service.close();
  const actual = await lstat(f.root); await f.edit(value => { value.dev = actual.dev - 1; });
  const resumed = f.make(); const snapshot = await resumed.list();
  expect(snapshot.binding?.id).toBe(f.binding.id); expect(snapshot.files[0]?.name).toBe('保留.txt');
  expect(await f.stored()).toMatchObject({ dev: actual.dev, volumeUuid: UUID, ino: actual.ino, birthtimeMs: actual.birthtimeMs, id: f.binding.id });
  await resumed.createNote({ title: '恢复后', body: 'new', date: '2026-10-30' });
  expect(await readFile(join(f.root, '保留.txt'), 'utf8')).toBe('原件'); expect(f.resolver).toHaveBeenCalledTimes(2);
});
it.each([OTHER_UUID, undefined, 'untrusted-volume-value'])('refuses remount when the stable volume cannot be verified as %s', async volume => {
  const f = await fixture(); await f.service.close(); const actual = await lstat(f.root); await f.edit(value => { value.dev = actual.dev - 1; });
  f.resolver.mockResolvedValue(volume); const resumed = f.make();
  await expect(resumed.validateBinding()).rejects.toMatchObject({ code: 'WORKDISK_UNAVAILABLE' });
  expect((await f.stored()).dev).toBe(actual.dev - 1);
});
it('backfills legacy records only while the original device and inode still match', async () => {
  const f = await fixture(); await f.service.close();
  await f.edit(value => { delete value.volumeUuid; delete value.birthtimeMs; });
  const resumed = f.make(); expect((await resumed.validateBinding()).id).toBe(f.binding.id);
  expect(await f.stored()).toMatchObject({ volumeUuid: UUID, birthtimeMs: (await lstat(f.root)).birthtimeMs });
  await resumed.validateBinding(); expect(f.resolver).toHaveBeenCalledTimes(2);
});
it('requires an explicit bind for a legacy remount, preserving its id for the same path only', async () => {
  const f = await fixture(); await f.service.close(); const actual = await lstat(f.root);
  await f.edit(value => { delete value.volumeUuid; delete value.birthtimeMs; value.dev = actual.dev - 1; });
  const resumed = f.make(); await expect(resumed.validateBinding()).rejects.toMatchObject({ code: 'WORKDISK_UNAVAILABLE' });
  const repaired = await resumed.bind(f.root); expect(repaired.id).toBe(f.binding.id);
  expect(await f.stored()).toMatchObject({ volumeUuid: UUID, dev: actual.dev });
  expect((await resumed.bind(f.other)).id).not.toBe(f.binding.id);
});
it.each(['directory', 'symlink'])('refuses a replaced root %s even when the resolver would report the original UUID', async type => {
  const f = await fixture(); await f.service.close(); const identity = await lstat(f.root);
  await rename(f.root, `${f.root}-old`); if (type === 'directory') await mkdir(f.root); else await symlink(`${f.root}-old`, f.root);
  const resumed = f.make(); await expect(resumed.validateBinding()).rejects.toMatchObject({ code: 'WORKDISK_UNAVAILABLE' });
  await expect(assertRoot(f.root, identity)).rejects.toMatchObject({ code: 'WORKDISK_UNAVAILABLE' });
  expect(f.resolver).toHaveBeenCalledTimes(1);
});
it('rejects a mismatched root birth time even if the device and inode match', async () => {
  const f = await fixture(); await f.service.close(); await f.edit(value => { value.birthtimeMs = (value.birthtimeMs as number) + 1; });
  await expect(f.make().validateBinding()).rejects.toMatchObject({ code: 'WORKDISK_UNAVAILABLE' });
});
it('does not record remount metadata if the root is replaced while resolving the volume', async () => {
  const f = await fixture(); await f.service.close(); const actual = await lstat(f.root); await f.edit(value => { value.dev = actual.dev - 1; });
  f.resolver.mockImplementationOnce(async () => { await rename(f.root, `${f.root}-old`); await mkdir(f.root); return UUID; });
  await expect(f.make().validateBinding()).rejects.toMatchObject({ code: 'WORKDISK_UNAVAILABLE' });
  expect((await f.stored()).dev).toBe(actual.dev - 1);
});
it('serializes metadata recovery with an explicit bind so the old binding cannot overwrite the new one', async () => {
  const f = await fixture(); await f.service.close(); await f.edit(value => { delete value.birthtimeMs; delete value.volumeUuid; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.resolver.mockImplementationOnce(async () => { entered(); await gate; return UUID; });
  const resumed = f.make(); const recovering = resumed.validateBinding();
  try {
    await vi.waitFor(() => expect(f.resolver).toHaveBeenCalledTimes(2)); await started;
    const rebinding = resumed.bind(f.other); release(); await recovering; const next = await rebinding;
    expect((await f.stored()).rootPath).toBe(f.other); expect((await resumed.status())?.id).toBe(next.id); expect(next.id).not.toBe(f.binding.id);
  } finally { release(); await recovering.catch(() => undefined); }
});
it('only accepts one literal, bounded VolumeUUID value from diskutil output', () => {
  const valid = `<plist><dict><key>VolumeUUID</key><string>${UUID.toLowerCase()}</string></dict></plist>`;
  expect(parseVolumeUuid(valid)).toBe(UUID);
  for (const value of [valid + valid, valid + 'x'.repeat(128 * 1024), '<key>DiskUUID</key><string>' + UUID + '</string>', '<key>VolumeUUID</key><string>&external;</string>']) expect(parseVolumeUuid(value)).toBeUndefined();
  expect(normalizeVolumeUuid(`${UUID}\n`)).toBeUndefined();
  expect(normalizeVolumeUuid(` ${UUID}`)).toBeUndefined();
});
it('safely keeps legacy identity without repeated volume processes when metadata is unavailable', async () => {
  const f = await fixture(); await f.service.close(); await f.edit(value => { delete value.birthtimeMs; delete value.volumeUuid; });
  f.resolver.mockResolvedValue(undefined); const resumed = f.make(); await resumed.validateBinding(); await resumed.validateBinding(); await resumed.list();
  expect(f.resolver).toHaveBeenCalledTimes(2); expect((await f.stored()).volumeUuid).toBeUndefined(); expect((await f.stored()).birthtimeMs).toBe((await lstat(f.root)).birthtimeMs);
});
it.skipIf(process.platform !== 'darwin')('reads the real local volume identity for an isolated temporary folder without modifying it', async () => {
  const f = await fixture(); const before = await lstat(f.root); const uuid = await resolveVolumeIdentity(f.root);
  expect(normalizeVolumeUuid(uuid)).toBe(uuid); expect(uuid).toMatch(/^[0-9A-F-]{36}$/u);
  expect(await resolveVolumeIdentity(f.root)).toBe(uuid); const after = await lstat(f.root);
  expect({ dev: after.dev, ino: after.ino, birthtime: after.birthtimeMs, mtime: after.mtimeMs }).toEqual({ dev: before.dev, ino: before.ino, birthtime: before.birthtimeMs, mtime: before.mtimeMs });
});
