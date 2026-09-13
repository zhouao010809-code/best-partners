import { afterEach, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPersonalIntakeFixture } from '../helpers/personal-intake-fixture.js';
import { openPersonalArchive } from '../../src/server/archive/sandbox-native.js';
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const f = createPersonalIntakeFixture(); cleanup.push(f.cleanup);
  const port = openPersonalArchive(f.root, f.recovery, resolve('dist/native/personal-archive.node')); cleanup.push(() => port.close());
  const staging = join(f.recovery, 'upload-stage'); mkdirSync(staging, { mode: 0o700 });
  const name = randomUUID(), folder = join(staging, name); mkdirSync(folder, { mode: 0o700 }); mkdirSync(join(folder, '附件'), { mode: 0o700 });
  const main = Buffer.from('正文'), original = Buffer.from('%PDF-audit');
  writeFileSync(join(folder, '资料.md'), main, { mode: 0o600 }); writeFileSync(join(folder, '附件/原件.pdf'), original, { mode: 0o600 });
  return { ...f, port, staging, name, folder, main, original };
}
it('publishes only the exact validated attachment package and refuses collisions', () => {
  const f = fixture(); expect(f.port.publishAttachmentPackage).toBeTypeOf('function');
  f.port.publishAttachmentPackage!(f.staging, f.name, '资料.md', f.main, '原件.pdf', f.original);
  expect(readFileSync(join(f.root, '01图书馆/小兆clipper', f.name, '附件/原件.pdf'))).toEqual(f.original);
  expect(() => f.port.publishAttachmentPackage!(f.staging, f.name, '资料.md', f.main, '原件.pdf', f.original)).toThrow();
});
it.each(['extra', 'changed', 'link'] as const)('rejects an %s package without publishing', (kind) => {
  const f = fixture(); expect(f.port.publishAttachmentPackage).toBeTypeOf('function');
  if (kind === 'extra') writeFileSync(join(f.folder, 'extra.txt'), 'unapproved');
  if (kind === 'changed') writeFileSync(join(f.folder, '资料.md'), 'different');
  if (kind === 'link') symlinkSync('/tmp', join(f.folder, 'shortcut'));
  expect(() => f.port.publishAttachmentPackage!(f.staging, f.name, '资料.md', f.main, '原件.pdf', f.original)).toThrow();
  expect(f.port.stat(`01图书馆/小兆clipper/${f.name}`)).toBeNull();
});
