import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createDesktopVaultSwitch } from '../../src/electron/vault-selection.js';

it('cancels a vault switch with the editor and relaunches only after a later accepted switch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-vault-switch-'));
  try {
    const source = await readFile(resolve('src/electron/main.ts'), 'utf8');
    const quit = source.match(/app\.on\('will-quit', \(event\) => \{[\s\S]*?\n\}\);/u)?.[0];
    const veto = source.match(/created\.webContents\.on\('will-prevent-unload', \(\) => \{[\s\S]*?\n  \}\);/u)?.[0];
    expect(quit).toBeDefined(); expect(veto).toBeDefined();
    const script = join(directory, 'switch.cjs');
    await writeFile(script, `
      const { app, BrowserWindow } = require('electron');
      app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))});
      let quitState = 'idle', installRequested = false, relaunchRequested = false;
      let savedRoot = '/brains/current', relaunches = 0, closed = 0;
      const updateController = undefined, closeWorkdisk = undefined;
      const autoUpdater = { quitAndInstall() { throw Error('unexpected install'); } };
      const dialog = { showErrorBox() { throw Error('unexpected persistence failure'); } };
      const started = { close: async () => { closed++; } };
      const createDesktopVaultSwitch = ${createDesktopVaultSwitch.toString()};
      const vaultSwitch = createDesktopVaultSwitch({ save: async config => { savedRoot = config.vaultRoot; }, requestQuit: () => setImmediate(() => app.quit()) });
      app.relaunch = () => { relaunches++; };
      ${quit}
      app.on('quit', () => process.stdout.write(JSON.stringify({ finished: true, savedRoot, relaunches, closed }) + '\\n'));
      app.whenReady().then(async () => {
        const created = new BrowserWindow({ show: false });
        ${veto}
        created.webContents.once('will-prevent-unload', () => {
          process.stdout.write(JSON.stringify({ blocked: true, savedRoot, relaunches, closed }) + '\\n');
          setTimeout(async () => {
            await created.webContents.executeJavaScript('window.onbeforeunload = null');
            void vaultSwitch.request({ vaultRoot: '/brains/accepted' });
          }, 30);
        });
        await created.loadURL('data:text/html,<script>window.onbeforeunload = () => false;</script>');
        const accepted = await vaultSwitch.request({ vaultRoot: '/brains/cancelled' });
        process.stdout.write(JSON.stringify({ firstSwitchAccepted: accepted }) + '\\n');
      }).catch(error => { process.stderr.write(String(error)); app.exit(1); });
    `);
    const result = await promisify(execFile)(resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [script], { timeout: 10_000, killSignal: 'SIGKILL' });
    const events = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    expect(events).toContainEqual({ blocked: true, savedRoot: '/brains/current', relaunches: 0, closed: 0 });
    expect(events).toContainEqual({ firstSwitchAccepted: false });
    expect(events).toContainEqual({ finished: true, savedRoot: '/brains/accepted', relaunches: 1, closed: 1 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
