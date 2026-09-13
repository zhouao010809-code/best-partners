import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createArchiveFixture } from './archive-fixture.js';
export function createPersonalIntakeFixture() {
  const fixture = createArchiveFixture();
  for (const core of ['00大脑规则', '02知识库', '03大讲堂']) mkdirSync(join(fixture.root, core), { mode: 0o700 });
  const recovery = mkdtempSync(join(realpathSync(tmpdir()), 'xiaozhao-intake-recovery-'));
  return { ...fixture, recovery, cleanup() { fixture.cleanup(); rmSync(recovery, { recursive: true }); } };
}
