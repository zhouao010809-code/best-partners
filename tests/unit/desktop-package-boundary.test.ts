import { expect, it, vi } from 'vitest';

it('packages the read helper but excludes unapproved sandbox writers and test hooks', async () => {
  let ignore: ((path: string) => boolean) | undefined;
  let zipDirectory: string | undefined;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
  vi.stubEnv('XIAOZHAO_ELECTRON_ZIP_DIR', '/private/tmp/verified-electron-cache');
  vi.doMock('@electron/packager', () => ({ packager: async (options: { ignore(path: string): boolean; electronZipDir?: string }) => {
    zipDirectory = options.electronZipDir;
    ignore = options.ignore; return [];
  } }));
  vi.doMock('@electron/rebuild', () => ({ rebuild: async () => {} }));
  try {
    // Inspect the macOS arm64 packaging policy on every CI host; the packager
    // and rebuild are mocked, so this never performs a cross-platform build.
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    Object.defineProperty(process, 'arch', { ...arch, value: 'arm64' });
    await import('../../scripts/package-desktop.js');
    expect(zipDirectory).toBe('/private/tmp/verified-electron-cache');
    expect(ignore?.('/dist/native/atomic-file-helper')).toBe(false);
    expect(ignore?.('/dist/native/personal-archive.node')).toBe(false);
    expect(ignore?.('/dist/native/sandbox-archive.node')).toBe(true);
    expect(ignore?.('/dist/native/sandbox-archive-test.node')).toBe(true);
    expect(ignore?.('/dist/server/index.js')).toBe(false);
    expect(ignore?.('/native/macos/sandbox-archive.c')).toBe(true);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    Object.defineProperty(process, 'arch', arch);
    vi.doUnmock('@electron/packager'); vi.doUnmock('@electron/rebuild'); vi.resetModules(); vi.unstubAllEnvs();
  }
});
