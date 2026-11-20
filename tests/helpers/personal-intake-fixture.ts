import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createArchiveFixture } from './archive-fixture.js';
export function createPersonalIntakeFixture() {
  const fixture = createArchiveFixture();
  for (const core of ['00大脑规则', '02知识库', '03大讲堂']) mkdirSync(join(fixture.root, core), { mode: 0o700 });
  const recovery = mkdtempSync(join(realpathSync(tmpdir()), 'xiaozhao-intake-recovery-'));
  return { ...fixture, recovery, cleanup() { fixture.cleanup(); rmSync(recovery, { recursive: true }); } };
}

export function createCurrentIntakeFixture() {
  const fixture = createPersonalIntakeFixture();
  writeFileSync(join(fixture.root, '00大脑规则/03知识库规则.md'), '规则');
  renameSync(join(fixture.root, '02知识库'), join(fixture.root, '03知识库'));
  renameSync(join(fixture.root, '03大讲堂'), join(fixture.root, '04大讲堂'));
  renameSync(join(fixture.root, '01图书馆/小兆clipper'), join(fixture.root, '01图书馆/00信息入口'));
  mkdirSync(join(fixture.root, '02日记本'));
  return fixture;
}
