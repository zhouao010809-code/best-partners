import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createPersonalIntakeFixture } from '../helpers/personal-intake-fixture.js';
import { openPersonalArchive } from '../../src/server/archive/sandbox-native.js';
import { executeIntakeArchive, listIntakeArchives } from '../../src/server/archive/intake-archive.js';
it.each(['intent', 'swapMain', 'renameMain', 'move'])('recovers a real SIGKILL after %s', async (checkpoint) => {
  const f = createPersonalIntakeFixture();
  try {
    const result = await new Promise<{ output: string; signal: string | null }>((accept, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/helpers/intake-crash-worker.ts'), f.root, f.recovery, resolve('dist/native/personal-archive.node'), checkpoint]);
      let output = ''; let error = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('INTAKE_WORKER_TIMEOUT')); }, 10_000);
      child.stdout.on('data', (chunk) => { output += String(chunk); }); child.stderr.on('data', (chunk) => { error += String(chunk); });
      child.on('error', reject); child.on('close', (_code, signal) => { clearTimeout(timer); if (error) reject(new Error(error)); else accept({ output, signal }); });
    });
    expect(result.signal).toBe('SIGKILL');
    const id = /INTAKE_ID:([a-f0-9-]+)/u.exec(result.output)![1]!;
    const port = openPersonalArchive(f.root, f.recovery, resolve('dist/native/personal-archive.node'));
    try {
      expect(listIntakeArchives(port)).toMatchObject([{ id, state: 'pending' }]);
      const outcome = executeIntakeArchive(port, id, 'a'.repeat(64)); expect(outcome.state).toBe('archived');
      expect(readFileSync(join(f.recovery, `${id}.stage.md`))).toEqual(f.original);
      expect(readFileSync(join(f.root, outcome.target, '附件/原图.bin'))).toEqual(Buffer.from([0,255,1,13,10]));
    } finally { port.close(); }
  } finally { f.cleanup(); }
});
