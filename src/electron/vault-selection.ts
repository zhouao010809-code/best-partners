import { basename } from 'node:path';
import type { DesktopVaultSelection } from '../shared/desktop/bridge.js';
import { selectValidatedVaultDirectory, type DesktopSettings } from './settings-store.js';

export async function changeDesktopVault(input: {
  readonly currentRoot: string;
  readonly chooseDirectory: () => Promise<string | undefined>;
  readonly validate: (root: string) => Promise<DesktopSettings>;
  readonly showInvalidSelection: () => Promise<void | 'retry' | 'cancel'>;
  readonly confirmSwitch: (config: DesktopSettings) => Promise<boolean>;
  readonly save: (config: DesktopSettings) => Promise<void>;
  readonly restart: () => void;
}): Promise<DesktopVaultSelection> {
  const config = await selectValidatedVaultDirectory(input);
  if (config === undefined) return { selected: false, reason: 'cancelled' };
  if (config.vaultRoot === input.currentRoot) {
    return { selected: false, reason: 'unchanged', displayName: basename(config.vaultRoot) };
  }
  if (!await input.confirmSwitch(config)) return { selected: false, reason: 'cancelled' };
  await input.save(config);
  input.restart();
  return { selected: true, displayName: basename(config.vaultRoot) };
}
