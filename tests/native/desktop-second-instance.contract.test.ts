// Prevents a second launch from throwing against a window destroyed during shutdown.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('does not touch a destroyed BrowserWindow when a second instance arrives', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaozhao-second-instance-'));
  try {
    const source = await readFile(resolve('src/electron/main.ts'), 'utf8');
    // Execute the shipped listener with Electron's real destroyed-object behavior.
    const listener = source.match(/app\.on\('second-instance', \(\) => \{[\s\S]*?\}\);/u)?.[0];
    expect(listener).toBeDefined();
    const script = join(directory, 'second-instance.cjs');
    await writeFile(script, `
      const { app, BrowserWindow } = require('electron');
      app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))});
      let window;
      ${listener}
      app.whenReady().then(() => {
        window = new BrowserWindow({ show: false });
        window.destroy();
        let error = null;
        try { app.emit('second-instance'); } catch (failure) { error = failure.message; }
        process.stdout.write(JSON.stringify({ destroyed: window.isDestroyed(), error }) + '\\n');
        app.exit(0);
      }).catch(error => { process.stderr.write(String(error)); app.exit(1); });
    `);
    const { stdout } = await promisify(execFile)(resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [script], { timeout: 10_000, killSignal: 'SIGKILL' });
    const result = stdout.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).at(-1);
    expect(result).toEqual({ destroyed: true, error: null });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
