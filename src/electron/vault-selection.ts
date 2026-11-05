import { basename } from 'node:path';
import type { DesktopVaultSelection } from '../shared/desktop/bridge.js';
import { selectValidatedVaultDirectory, type DesktopSettings } from './settings-store.js';

export function createDesktopVaultSwitch(input: {
  save(config: DesktopSettings): Promise<void>;
  requestQuit(): void;
}) {
  let pending: { config: DesktopSettings; resolve(value: boolean): void; reject(error: unknown): void } | undefined;
  return {
    request(config: DesktopSettings): Promise<boolean> {
      if (pending) return Promise.reject(Error('VAULT_SWITCH_PENDING'));
      return new Promise((resolve, reject) => {
        pending = { config, resolve, reject };
        try { input.requestQuit(); } catch (error) { pending = undefined; reject(error); }
      });
    },
    cancel(): void { const request = pending; pending = undefined; request?.resolve(false); },
    async commit(): Promise<boolean> {
      const request = pending; pending = undefined;
      if (!request) return false;
      try { await input.save(request.config); request.resolve(true); return true; }
      catch (error) { request.reject(error); throw error; }
    }
  };
}

export async function changeDesktopVault(input: {
  readonly currentRoot: string;
  readonly chooseDirectory: () => Promise<string | undefined>;
  readonly validate: (root: string) => Promise<DesktopSettings>;
  readonly showInvalidSelection: () => Promise<void | 'retry' | 'cancel'>;
  readonly confirmSwitch: (config: DesktopSettings) => Promise<boolean>;
  readonly switchVault: (config: DesktopSettings) => Promise<boolean>;
}): Promise<DesktopVaultSelection> {
  const config = await selectValidatedVaultDirectory(input);
  if (config === undefined) return { selected: false, reason: 'cancelled' };
  if (config.vaultRoot === input.currentRoot) {
    return { selected: false, reason: 'unchanged', displayName: basename(config.vaultRoot) };
  }
  if (!await input.confirmSwitch(config)) return { selected: false, reason: 'cancelled' };
  if (!await input.switchVault(config)) return { selected: false, reason: 'cancelled' };
  return { selected: true, displayName: basename(config.vaultRoot) };
}
