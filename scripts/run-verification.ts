import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type VerificationMode = 'fast' | 'full' | 'all';
export type VerificationPlan = {
  preparations: string[];
  checks: string[];
  builds: string[];
  discoveries: { config: string; directory: string }[];
};
const discovery = {
  unit: { config: 'vitest.config.ts', directory: 'tests/unit' },
  integration: { config: 'vitest.integration.config.ts', directory: 'tests/integration' },
  component: { config: 'vitest.client.config.ts', directory: 'tests/component' },
  native: { config: 'vitest.native.config.ts', directory: 'tests/native' },
  archive: { config: 'vitest.archive.config.ts', directory: 'tests/archive' },
  mcp: { config: 'vitest.mcp.config.ts', directory: 'tests/mcp' },
  companyMcp: { config: 'vitest.company-mcp.config.ts', directory: 'tests/company-mcp' }
};

/** The same prerequisites and directory discovery drive local validation and CI. */
export function verificationPlan(mode: VerificationMode, environment: { platform: NodeJS.Platform; arch: string } = process): VerificationPlan {
  const native = environment.platform === 'darwin' && environment.arch === 'arm64';
  if (mode !== 'fast' && !native) throw Error('NATIVE_VERIFY_REQUIRES_MACOS_ARM64');
  if (mode === 'fast') return {
    preparations: native ? ['build:personal-archive'] : [],
    checks: ['check:architecture', 'typecheck', 'test:unit', 'test:integration', 'test:mcp', 'test:company-mcp'],
    builds: [],
    discoveries: [discovery.unit, discovery.integration, discovery.mcp, discovery.companyMcp].map(value => ({ ...value }))
  };
  return {
    preparations: ['build:native', 'build:sandbox-archive', 'build:personal-archive'],
    checks: [...(mode === 'full' ? ['check:architecture', 'typecheck'] : []),
      'test:unit', 'test:integration', 'test:component', 'test:security', 'test:native', 'test:archive', 'test:mcp', 'test:company-mcp'],
    builds: mode === 'full' ? ['build', 'build:electron', 'build:provenance'] : [],
    discoveries: Object.values(discovery).map(value => ({ ...value }))
  };
}

async function runScript(script: string): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? accept() : reject(Error(`VERIFICATION_STEP_FAILED: ${script} (${signal ?? code})`)));
  });
}

async function main(args: string[]): Promise<void> {
  const [mode, ...flags] = args;
  if (!['fast', 'full', 'all'].includes(mode ?? '')) throw Error('VERIFICATION_MODE_REQUIRED: fast | full | all');
  const planOnly = flags.includes('--plan');
  let platform = process.platform, arch: string = process.arch;
  for (const flag of flags) {
    if (flag === '--plan') continue;
    if (planOnly && flag.startsWith('--platform=')) { platform = flag.slice('--platform='.length) as NodeJS.Platform; continue; }
    if (planOnly && flag.startsWith('--arch=')) { arch = flag.slice('--arch='.length); continue; }
    throw Error(`VERIFICATION_ARGUMENT_INVALID: ${flag}`);
  }
  const plan = verificationPlan(mode as VerificationMode, { platform, arch });
  if (planOnly) { process.stdout.write(`${JSON.stringify(plan)}\n`); return; }
  for (const script of [...plan.preparations, ...plan.checks, ...plan.builds]) await runScript(script);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
