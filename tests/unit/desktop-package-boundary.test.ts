import { expect, it, vi } from 'vitest';

it('packages the read helper but excludes unapproved sandbox writers and test hooks', async () => {
  let ignore: ((path: string) => boolean) | undefined;
  let zipDirectory: string | undefined;
  const calls: string[] = [];
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
  vi.stubEnv('XIAOZHAO_ELECTRON_ZIP_DIR', '/private/tmp/verified-electron-cache');
  vi.doMock('@electron/packager', () => ({ packager: async (options: { ignore(path: string): boolean; electronZipDir?: string }) => {
    calls.push('package');
    zipDirectory = options.electronZipDir;
    ignore = options.ignore; return [];
  } }));
  vi.doMock('@electron/rebuild', () => ({ rebuild: async () => {} }));
  vi.doMock('../../scripts/build-provenance.js', () => ({
    verifyBuildManifest: async () => { calls.push('verify'); return { status: 'passed' }; },
    verifyPackagedDesktop: async () => ({ status: 'passed' })
  }));
  try {
    // Inspect the macOS arm64 packaging policy on every CI host; the packager
    // and rebuild are mocked, so this never performs a cross-platform build.
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    Object.defineProperty(process, 'arch', { ...arch, value: 'arm64' });
    await import('../../scripts/package-desktop.js');
    expect(calls).toEqual(['verify', 'package']);
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
    vi.doUnmock('@electron/packager'); vi.doUnmock('@electron/rebuild'); vi.doUnmock('../../scripts/build-provenance.js'); vi.resetModules(); vi.unstubAllEnvs();
  }
});

it('does not invoke the packager when build provenance verification fails', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
  const packageApp = vi.fn(async () => []);
  vi.doMock('@electron/packager', () => ({ packager: packageApp }));
  vi.doMock('@electron/rebuild', () => ({ rebuild: async () => {} }));
  vi.doMock('../../scripts/build-provenance.js', () => ({
    verifyBuildManifest: async () => { throw Error('BUILD_SOURCE_CHANGED'); },
    verifyPackagedDesktop: async () => ({ status: 'passed' })
  }));
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    Object.defineProperty(process, 'arch', { ...arch, value: 'arm64' });
    await expect(import('../../scripts/package-desktop.js')).rejects.toThrow('BUILD_SOURCE_CHANGED');
    expect(packageApp).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', arch);
    vi.doUnmock('@electron/packager'); vi.doUnmock('@electron/rebuild'); vi.doUnmock('../../scripts/build-provenance.js'); vi.resetModules();
  }
});
