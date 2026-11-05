import { describe, expect, it, vi } from 'vitest';
import { changeDesktopVault } from '../../src/electron/vault-selection.js';

function input() {
  return {
    currentRoot: '/brains/current',
    chooseDirectory: vi.fn<() => Promise<string | undefined>>().mockResolvedValue('/brains/next'),
    validate: vi.fn(async (vaultRoot: string) => {
      if (vaultRoot === '/invalid') throw new Error('INVALID');
      return { vaultRoot };
    }),
    showInvalidSelection: vi.fn<() => Promise<'retry' | 'cancel'>>().mockResolvedValue('retry'),
    confirmSwitch: vi.fn(async () => true),
    switchVault: vi.fn(async () => true)
  };
}

describe('changing the active desktop vault', () => {
  it('actually reopens the picker after an invalid selection and only requests the confirmed valid choice', async () => {
    const args = input();
    args.chooseDirectory.mockResolvedValueOnce('/invalid');
    expect(await changeDesktopVault(args)).toEqual({ selected: true, displayName: 'next' });
    expect(args.chooseDirectory).toHaveBeenCalledTimes(2);
    expect(args.showInvalidSelection).toHaveBeenCalledOnce();
    expect(args.confirmSwitch).toHaveBeenCalledExactlyOnceWith({ vaultRoot: '/brains/next' });
    expect(args.switchVault).toHaveBeenCalledExactlyOnceWith({ vaultRoot: '/brains/next' });
  });

  it('keeps current settings when the invalid-selection dialog is cancelled', async () => {
    const args = input();
    args.chooseDirectory.mockResolvedValueOnce('/invalid');
    args.showInvalidSelection.mockResolvedValueOnce('cancel');
    expect(await changeDesktopVault(args)).toEqual({ selected: false, reason: 'cancelled' });
    expect(args.chooseDirectory).toHaveBeenCalledOnce();
    expect(args.confirmSwitch).not.toHaveBeenCalled();
    expect(args.switchVault).not.toHaveBeenCalled();
  });

  it('keeps current settings when the retry picker is cancelled', async () => {
    const args = input();
    args.chooseDirectory.mockResolvedValueOnce('/invalid').mockResolvedValueOnce(undefined);
    expect(await changeDesktopVault(args)).toEqual({ selected: false, reason: 'cancelled' });
    expect(args.chooseDirectory).toHaveBeenCalledTimes(2);
    expect(args.confirmSwitch).not.toHaveBeenCalled();
    expect(args.switchVault).not.toHaveBeenCalled();
  });

  it('does not prompt, save or restart when the current directory is selected', async () => {
    const args = input();
    args.chooseDirectory.mockResolvedValueOnce(args.currentRoot);
    expect(await changeDesktopVault(args)).toEqual({ selected: false, reason: 'unchanged', displayName: 'current' });
    expect(args.confirmSwitch).not.toHaveBeenCalled();
    expect(args.switchVault).not.toHaveBeenCalled();
  });

  it('keeps current settings when final switching confirmation is cancelled', async () => {
    const args = input();
    args.confirmSwitch.mockResolvedValueOnce(false);
    expect(await changeDesktopVault(args)).toEqual({ selected: false, reason: 'cancelled' });
    expect(args.switchVault).not.toHaveBeenCalled();
  });

  it('reports cancellation when an editor vetoes closing', async () => {
    const args = input();
    args.switchVault.mockResolvedValueOnce(false);
    expect(await changeDesktopVault(args)).toEqual({ selected: false, reason: 'cancelled' });
  });

  it('does not report success if committing the chosen directory fails', async () => {
    const args = input();
    args.switchVault.mockRejectedValueOnce(new Error('EIO'));
    await expect(changeDesktopVault(args)).rejects.toThrow('EIO');
  });
});
