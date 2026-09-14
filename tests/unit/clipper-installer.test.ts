import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIPPER_EXTENSION_ID, CLIPPER_HOST_NAME } from '../../src/shared/api/clipper.js';
import { clipperPaths, installClipperHost } from '../../src/electron/clipper-installer.js';

describe('clipper native host installer', () => {
  it('installs a private config, executable wrapper and locked manifests', async () => {
    const home = await mkdtemp(join(tmpdir(), 'clipper-installer-home-'));
    const state = await mkdtemp(join(tmpdir(), 'clipper-installer-state-'));
    const configPath = join(state, 'clipper-bridge.json');
    const wrapperPath = join(state, 'clipper-host-wrapper');
    const result = await installClipperHost({
      executablePath: '/Applications/最佳拍档.app/Contents/MacOS/最佳拍档',
      configPath, wrapperPath, vaultRoot: '/tmp/test-vault', home
    });
    expect(result.token).toMatch(/^[a-f0-9]{64}$/u);
    expect(await readFile(wrapperPath, 'utf8')).toContain("--clipper-host");
    expect((await stat(wrapperPath)).mode & 0o777).toBe(0o755);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    for (const manifestPath of Object.values(clipperPaths(home))) {
      expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      expect(manifest).toMatchObject({ name: CLIPPER_HOST_NAME, path: wrapperPath, type: 'stdio', allowed_origins: [`chrome-extension://${CLIPPER_EXTENSION_ID}/`] });
    }
  });
});
