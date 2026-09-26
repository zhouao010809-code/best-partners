import { expect, it, vi } from 'vitest';
import { supportsAutomaticUpdates } from '../../src/electron/update-signature.js';

const input = { packaged: true, platform: 'darwin', arch: 'arm64', executable: '/Applications/最佳拍档.app/Contents/MacOS/最佳拍档' };
it('checks the installed bundle rather than requiring a developer certificate on the recipient machine', async () => {
  const verify = vi.fn(async () => {});
  expect(await supportsAutomaticUpdates({ ...input, verify })).toBe(true);
  expect(verify).toHaveBeenCalledWith('/Applications/最佳拍档.app');
});
it('keeps unsigned builds on the installer path', async () => {
  expect(await supportsAutomaticUpdates({ ...input, verify: async () => { throw new Error('unsigned'); } })).toBe(false);
});
it.each([{ packaged: false }, { platform: 'linux' }, { arch: 'x64' }, { executable: '/tmp/node' }])('does not activate native updates for %j', async overrides => {
  const verify = vi.fn(async () => {});
  expect(await supportsAutomaticUpdates({ ...input, ...overrides, verify })).toBe(false);
  expect(verify).not.toHaveBeenCalled();
});
