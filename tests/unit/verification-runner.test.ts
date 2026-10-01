import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

type Environment = { platform: string; arch: string };
async function entrySteps(entry: string, environment: Environment): Promise<string[]> {
  const { scripts } = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { scripts: Record<string, string> };
  async function expand(name: string): Promise<string[]> {
    const command = scripts[name];
    const runner = command?.match(/^tsx scripts\/run-verification\.ts (fast|full|all)$/u);
    if (runner) {
      const { stdout } = await promisify(execFile)(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'),
        resolve('scripts/run-verification.ts'), runner[1]!, '--plan', `--platform=${environment.platform}`, `--arch=${environment.arch}`]);
      const plan = JSON.parse(stdout) as { preparations: string[]; checks: string[]; builds: string[] };
      return [...plan.preparations, ...plan.checks, ...plan.builds];
    }
    const children = command?.split(' && ').map(part => part.match(/^npm run ([\w:-]+)$/u)?.[1]).filter((child): child is string => !!child) ?? [];
    return [name, ...(await Promise.all(children.map(expand))).flat()];
  }
  return expand(entry);
}
it('prepares the personal archive before macOS fast integration on a clean checkout', async () => {
  const steps = await entrySteps('verify:fast', { platform: 'darwin', arch: 'arm64' });
  expect(steps.indexOf('build:personal-archive')).toBeGreaterThanOrEqual(0);
  expect(steps.indexOf('build:personal-archive')).toBeLessThan(steps.indexOf('test:integration'));
});
it('keeps Linux fast validation free of unsupported native build steps', async () => {
  const steps = await entrySteps('verify:fast', { platform: 'linux', arch: 'x64' });
  expect(steps).not.toContain('build:personal-archive');
  expect(steps).toEqual(expect.arrayContaining(['test:unit', 'test:integration', 'test:mcp', 'test:company-mcp']));
});
it('discovers all native and archive files in the full gate and standalone all-tests entry', async () => {
  for (const entry of ['verify:full', 'test:all']) {
    const steps = await entrySteps(entry, { platform: 'darwin', arch: 'arm64' });
    expect(steps, entry).toEqual(expect.arrayContaining(['test:native', 'test:archive']));
    for (const preparation of ['build:native', 'build:sandbox-archive', 'build:personal-archive']) {
      expect(steps.indexOf(preparation), `${entry}/${preparation}`).toBeGreaterThanOrEqual(0);
      expect(steps.indexOf(preparation)).toBeLessThan(steps.indexOf('test:integration'));
    }
  }
  const { scripts } = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { scripts: Record<string, string> };
  expect(scripts['test:native']).toMatch(/--config vitest\.native\.config\.ts tests\/native$/u);
  expect(scripts['test:archive']).toMatch(/--config vitest\.archive\.config\.ts tests\/archive$/u);
});
