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
    save: vi.fn(async () => {}),
    restart: vi.fn()
  };
}

describe('changing the active desktop vault', () => {
  it('actually reopens the picker after an invalid selection and only saves the confirmed valid choice', async () => {
    const args = input();
    args.chooseDirectory.mockResolvedValueOnce('/invalid');
    expect(await changeDesktopVault(args)).toEqual({ selected: true, displayName: 'next' });
    expect(args.chooseDirectory).toHaveBeenCalledTimes(2);
    expect(args.showInvalidSelection).toHaveBeenCalledOnce();
    expect(args.confirmSwitch).toHaveBeenCalledExactlyOnceWith({ vaultRoot: '/brains/next' });
    expect(args.save).toHaveBeenCalledExactlyOnceWith({ vaultRoot: '/brains/next' });
    expect(args.restart).toHaveBeenCalledOnce();
    expect(args.restart.mock.invocationCallOrder[0]).toBeGreaterThan(args.save.mock.invocationCallOrder[0]!);
  });

  it('keeps current settings when the invalid-selection dialog is cancelled', async () => {
    const args = input();
    args.chooseDirectory.mockResolvedValueOnce('/invalid');
    args.showInvalidSelection.mockResolvedValueOnce('cancel');
    expect(await changeDesktopVault(args)).toEqual({ selected: false, reason: 'cancelled' });
    expect(args.chooseDirectory).toHaveBeenCalledOnce();
    expect(args.confirmSwitch).not.toHaveBeenCalled();
    expect(args.save).not.toHaveBeenCalled();
    expect(args.restart).not.toHaveBeenCalled();
  });

  it('keeps current settings when the retry picker is cancelled', async () => {
    const args = input();
    args.chooseDirectory.mockResolvedValueOnce('/invalid').mockResolvedValueOnce(undefined);
    expect(await changeDesktopVault(args)).toEqual({ selected: false, reason: 'cancelled' });
    expect(args.chooseDirectory).toHaveBeenCalledTimes(2);
    expect(args.confirmSwitch).not.toHaveBeenCalled();
    expect(args.save).not.toHaveBeenCalled();
  });

  it('does not prompt, save or restart when the current directory is selected', async () => {
    const args = input();
    args.chooseDirectory.mockResolvedValueOnce(args.currentRoot);
    expect(await changeDesktopVault(args)).toEqual({ selected: false, reason: 'unchanged', displayName: 'current' });
    expect(args.confirmSwitch).not.toHaveBeenCalled();
    expect(args.save).not.toHaveBeenCalled();
    expect(args.restart).not.toHaveBeenCalled();
  });

  it('keeps current settings when final switching confirmation is cancelled', async () => {
    const args = input();
    args.confirmSwitch.mockResolvedValueOnce(false);
    expect(await changeDesktopVault(args)).toEqual({ selected: false, reason: 'cancelled' });
    expect(args.save).not.toHaveBeenCalled();
    expect(args.restart).not.toHaveBeenCalled();
  });

  it('does not restart or report success if saving the chosen directory fails', async () => {
    const args = input();
    args.save.mockRejectedValueOnce(new Error('EIO'));
    await expect(changeDesktopVault(args)).rejects.toThrow('EIO');
    expect(args.restart).not.toHaveBeenCalled();
  });
});
