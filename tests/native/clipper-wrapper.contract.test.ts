import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { installClipperHost } from '../../src/electron/clipper-installer.js';
import { decodeNativeMessage, encodeNativeMessage } from '../../src/electron/clipper-host.js';
import { CLIPPER_EXTENSION_ID } from '../../src/shared/api/clipper.js';

it('launches the development host through its installed wrapper and handles ping and capture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clipper-wrapper-'));
  try {
    const userDataDir = join(root, 'state'), vaultRoot = join(root, 'vault');
    await mkdir(join(vaultRoot, '01图书馆/小兆clipper'), { recursive: true });
    // Native checks run before the desktop build on clean CI. Bundle only the
    // production host into this temporary Electron entry, not workspace dist.
    const appEntry = join(root, 'host.mjs');
    await build({ stdin: { contents: `
      import { app } from 'electron';
      import { runClipperHost } from ${JSON.stringify(resolve('src/electron/clipper-host.ts'))};
      app.setPath('userData', process.env.XIAOZHAO_TEST_USER_DATA);
      if (!process.argv.includes('--clipper-host')) app.exit(2);
      await runClipperHost({ configPath: ${JSON.stringify(join(userDataDir, 'clipper-bridge.json'))} });
      app.exit(0);
    `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm',
      target: 'node22', external: ['electron'], outfile: appEntry });
    const installed = await installClipperHost({
      executablePath: resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      appEntry, configPath: join(userDataDir, 'clipper-bridge.json'),
      home: join(root, 'home'), vaultRoot
    });
    const auth = { extensionId: CLIPPER_EXTENSION_ID, token: installed.token };
    const payload = { packetId: 'wrapper-test', title: 'Fixture clip', content: 'fixture body', url: 'https://example.com', clippedAt: '2026-11-05T00:00:00.000Z' };
    const output = await new Promise<Buffer>((accept, reject) => {
      const child = spawn(installed.wrapperPath, [`chrome-extension://${CLIPPER_EXTENSION_ID}/`], {
        env: { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_USER_DATA: userDataDir }, stdio: ['pipe', 'pipe', 'pipe']
      });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('CLIPPER_WRAPPER_TIMEOUT')); }, 10_000);
      const chunks: Buffer[] = [];
      child.stdout.on('data', chunk => chunks.push(chunk));
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? accept(Buffer.concat(chunks)) : reject(Error(`CLIPPER_WRAPPER_EXIT_${code}`)); });
      child.stdin.on('error', () => {});
      child.stdin.end(Buffer.concat([encodeNativeMessage({ ...auth, type: 'ping' }), encodeNativeMessage({ ...auth, payload })]));
    });
    const firstEnd = output.readUInt32LE(0) + 4;
    expect(decodeNativeMessage(output.subarray(0, firstEnd))).toEqual({ ok: true, pong: true });
    expect(decodeNativeMessage(output.subarray(firstEnd))).toMatchObject({ ok: true, packetId: payload.packetId });
    expect(await readFile(join(vaultRoot, '01图书馆/小兆clipper/wrapper-test/index.md'), 'utf8')).toContain('fixture body');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);
