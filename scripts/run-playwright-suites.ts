import { spawn } from 'node:child_process';

export const fixtureSuites = [
  'tests/e2e/overview-desk.config.ts',
  'tests/e2e/intake-tray.config.ts',
  'tests/e2e/queue-drawer.config.ts',
  'tests/e2e/unified-trash.config.ts',
  'tests/e2e/archive-motion.config.ts',
  'tests/e2e/operations.config.ts'
] as const;

function runSuite(config: string, extraArgs: readonly string[]): Promise<number> {
  const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return new Promise(resolve => {
    const child = spawn(executable, ['playwright', 'test', '--config', config, ...extraArgs], {
      stdio: 'inherit',
      env: process.env
    });
    child.on('error', () => resolve(1));
    child.on('exit', (code, signal) => resolve(code ?? (signal === null ? 1 : 1)));
  });
}

async function main(): Promise<void> {
  const extraArgs = process.argv.slice(2);
  for (const suite of fixtureSuites) {
    console.log(`\n▶ Playwright fixture suite: ${suite}`);
    const code = await runSuite(suite, extraArgs);
    if (code !== 0) {
      process.exitCode = code;
      return;
    }
  }
}

if (process.argv[1]?.endsWith('run-playwright-suites.ts')) void main();
