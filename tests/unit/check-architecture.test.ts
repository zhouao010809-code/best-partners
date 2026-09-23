import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { findArchitectureViolations, formatArchitectureViolations } from '../../scripts/check-architecture.js';

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'architecture-boundary-'));
  roots.push(root);
  await mkdir(join(root, 'src/shared'), { recursive: true });
  await mkdir(join(root, 'src/client'), { recursive: true });
  await mkdir(join(root, 'src/server'), { recursive: true });
  await mkdir(join(root, 'src/electron'), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('architecture boundary checker', () => {
  it('accepts shared-to-shared and electron-to-server imports', async () => {
    const root = await fixture();
    await writeFile(join(root, 'src/shared/value.ts'), 'export const value = 1;');
    await writeFile(join(root, 'src/shared/schema.ts'), "import { value } from './value.js'; export { value };\n");
    await writeFile(join(root, 'src/server/entry.ts'), "import '../shared/schema.js';\n");
    await writeFile(join(root, 'src/electron/main.ts'), "import '../server/entry.js';\n");

    expect(findArchitectureViolations(root)).toEqual([]);
  });

  it('reports every forbidden cross-layer import with the source file and rule', async () => {
    const root = await fixture();
    await writeFile(join(root, 'src/electron/update.ts'), 'export type Result = unknown;');
    await writeFile(join(root, 'src/shared/bridge.ts'), "import '../electron/update.js';\n");
    await writeFile(join(root, 'src/client/page.tsx'), "const load = () => import('../electron/update.js');\n");
    await writeFile(join(root, 'src/server/entry.ts'), "export { x } from '../client/page.js';\n");

    const violations = findArchitectureViolations(root);
    expect(violations).toHaveLength(3);
    expect(formatArchitectureViolations(violations)).toContain('src/shared/bridge.ts');
    expect(formatArchitectureViolations(violations)).toContain('client may not depend on server or Electron modules');
    expect(formatArchitectureViolations(violations)).toContain('server may not depend on client or Electron modules');
  });
});
