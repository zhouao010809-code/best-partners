import { expect, it, vi } from 'vitest';
import { createDesktopVaultSwitch } from '../../src/electron/vault-selection.js';

it('keeps the current configuration when an editor cancels closing', async () => {
  const save = vi.fn(async () => {}), requestQuit = vi.fn();
  const switching = createDesktopVaultSwitch({ save, requestQuit });
  const result = switching.request({ vaultRoot: '/brains/next' });
  expect(requestQuit).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
  switching.cancel();
  await expect(result).resolves.toBe(false);
  await expect(switching.commit()).resolves.toBe(false);
  expect(save).not.toHaveBeenCalled();
});

it('commits the selected root once after every window has accepted closing', async () => {
  const save = vi.fn(async () => {});
  const switching = createDesktopVaultSwitch({ save, requestQuit: vi.fn() });
  const result = switching.request({ vaultRoot: '/brains/next' });
  await expect(switching.commit()).resolves.toBe(true);
  await expect(result).resolves.toBe(true);
  expect(save).toHaveBeenCalledExactlyOnceWith({ vaultRoot: '/brains/next' });
  await expect(switching.commit()).resolves.toBe(false);
});

it('does not authorize relaunch after settings fail to save', async () => {
  const switching = createDesktopVaultSwitch({ save: async () => { throw Error('EIO'); }, requestQuit: vi.fn() });
  const result = expect(switching.request({ vaultRoot: '/brains/next' })).rejects.toThrow('EIO');
  await expect(switching.commit()).rejects.toThrow('EIO');
  await result;
  await expect(switching.commit()).resolves.toBe(false);
});
