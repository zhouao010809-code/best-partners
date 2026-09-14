import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
describe('desktop distribution contents', () => {
  it('keeps the public starter vault and clipper package in the source distribution', async () => {
    await expect(access(join(root, 'templates/default-vault/template-manifest.json'))).resolves.toBeUndefined();
    await expect(access(join(root, 'browser-extension/manifest.json'))).resolves.toBeUndefined();
    const manifest = JSON.parse(await readFile(join(root, 'browser-extension/manifest.json'), 'utf8')) as { key?: string };
    expect(manifest.key).toBeTruthy();
    const script = await readFile(join(root, 'scripts/package-desktop.ts'), 'utf8');
    expect(script).toContain('templates/default-vault');
    expect(script).toContain('clipper-extension');
    expect(script).toContain("name: '最佳拍档'");
  });
});
