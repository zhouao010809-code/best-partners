import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('keeps the backend alive when an unsaved editor cancels quit, then closes it once after exit is allowed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaozhao-quit-contract-'));
  try {
    const source = await readFile(resolve('src/electron/main.ts'), 'utf8');
    // Execute the production listener against real Electron lifecycle events.
    const listener = source.match(/app\.on\('(before|will)-quit', \(event\) => \{[\s\S]*?\n\}\);/u)?.[0];
    expect(listener).toBeDefined();
    const script = join(directory, 'quit-contract.cjs');
    await writeFile(script, `
      const { app, BrowserWindow } = require('electron');
      app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))});
      let quitState = 'idle';
      let closeCount = 0;
      let closeFinished = false;
      const started = { close: async () => {
        closeCount += 1;
        // Repeated Cmd+Q must not bypass an unfinished service shutdown.
        setTimeout(() => app.quit(), 20);
        await new Promise(resolve => setTimeout(resolve, 150));
        closeFinished = true;
      } };
      ${listener}
      app.on('window-all-closed', () => app.quit());
      app.on('quit', () => process.stdout.write(JSON.stringify({ finished: true, closeCount, closeFinished }) + '\\n'));
      app.whenReady().then(async () => {
        const window = new BrowserWindow({ show: false });
        let allowExit = false;
        window.webContents.on('will-prevent-unload', event => {
          if (allowExit) { event.preventDefault(); return; }
          process.stdout.write(JSON.stringify({ blocked: true, backendClosed: closeCount > 0, windowAlive: !window.isDestroyed() }) + '\\n');
          allowExit = true;
          // A second quit must occur after Electron finishes cancelling the first.
          setTimeout(() => app.quit(), 50);
        });
        await window.loadURL('data:text/html,<script>addEventListener("beforeunload", event => { event.preventDefault(); event.returnValue = ""; });</script>');
        app.quit();
      }).catch(error => { process.stderr.write(String(error)); app.exit(1); });
    `);
    const { stdout } = await promisify(execFile)(resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [script], { timeout: 10_000, killSignal: 'SIGKILL' });
    const events = stdout.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    expect(events).toContainEqual({ blocked: true, backendClosed: false, windowAlive: true });
    expect(events).toContainEqual({ finished: true, closeCount: 1, closeFinished: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
