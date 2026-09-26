import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type NetworkTestGlobal = typeof globalThis & { updateTestFetch: typeof fetch; updateTestHash: typeof createHash };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'update-network-electron-'));
  const entry = join(root, 'main.cjs');
  const hits: string[] = [];
  const closed: string[] = [];
  const body = Buffer.alloc(48 * 1024 * 1024, 0x61);
  let sent = 0;
  const proxy = createServer((request, response) => {
    const path = new URL(request.url!).pathname;
    hits.push(path);
    response.once('close', () => closed.push(path));
    if (path === '/redirect') {
      response.writeHead(302, { location: 'http://update.invalid/body' }).end();
    } else if (path === '/empty') {
      response.writeHead(204).end();
    } else if (path === '/broken') {
      response.writeHead(200, { 'content-length': 1000 }); response.write('partial');
      setTimeout(() => response.destroy(), 50);
    } else if (path === '/headers-stall') {
      // Keep the request open until the caller cancels it.
    } else if (path === '/stream-stall') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.write('first chunk');
    } else if (path === '/large') {
      response.writeHead(200, { 'content-length': body.length });
      const write = (target: ServerResponse) => {
        while (sent < body.length && !target.destroyed) {
          const chunk = body.subarray(sent, sent + 64 * 1024); sent += chunk.length;
          if (!target.write(chunk)) { target.once('drain', () => write(target)); return; }
        }
        if (!target.destroyed) target.end();
      };
      write(response);
    } else response.end('via isolated proxy');
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('TEST_PROXY_ADDRESS');
  let instance: ElectronApplication | undefined;
  try {
    await build({
      stdin: { contents: `
      import { app, net, session } from 'electron';
      import { createHash } from 'node:crypto';
      import { createUpdateDownloadFetcher } from ${JSON.stringify(resolve('src/electron/update-network.ts'))};
      globalThis.updateTestHash = createHash;
      app.setPath('userData', process.env.UPDATE_NETWORK_TEST_ROOT);
      app.whenReady().then(async () => {
        const isolated = session.fromPartition('update-network-test');
        await isolated.setProxy({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:${address.port}' });
        globalThis.updateTestFetch = createUpdateDownloadFetcher({ request: options => net.request({ ...options, session: isolated }) });
      });
      `, resolveDir: process.cwd() },
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: entry
    });
    instance = await electron.launch({ args: [entry], env: { ...process.env, UPDATE_NETWORK_TEST_ROOT: root } });
    await expect.poll(() => instance!.evaluate(() => typeof (globalThis as NetworkTestGlobal).updateTestFetch)).toBe('function');
  } catch (error) {
    await instance?.close(); proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve()));
    await rm(root, { recursive: true, force: true }); throw error;
  }
  return {
    instance, hits, closed, sent: () => sent, size: body.length,
    digest: createHash('sha256').update(body).digest('hex'),
    async close() {
      await instance!.close(); proxy.closeAllConnections();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  };
}

test('uses the isolated Chromium proxy without Node fetch and exposes each redirect before following', async () => {
  const f = await fixture();
  try {
    const redirected = await f.instance.evaluate(async () => {
      globalThis.fetch = async () => { throw new Error('NODE_FETCH_MUST_NOT_RUN'); };
      const response = await (globalThis as NetworkTestGlobal).updateTestFetch('http://update.invalid/redirect', { redirect: 'manual' });
      return { status: response.status, location: response.headers.get('location'), text: await response.text() };
    });
    expect(redirected).toEqual({ status: 302, location: 'http://update.invalid/body', text: '' });
    expect(f.hits).toEqual(['/redirect']);
    const body = await f.instance.evaluate(async () => (await (globalThis as NetworkTestGlobal).updateTestFetch('http://update.invalid/body', { redirect: 'manual' })).text());
    expect(body).toBe('via isolated proxy');
    expect(f.hits).toEqual(['/redirect', '/body']);
  } finally { await f.close(); }
});

test('propagates a connection failure during the response body', async () => {
  const f = await fixture();
  try {
    const result = await f.instance.evaluate(async () => {
      const response = await (globalThis as NetworkTestGlobal).updateTestFetch('http://update.invalid/broken', { redirect: 'manual' });
      return response.text().then(() => 'unexpected success', error => String(error));
    });
    expect(result).toMatch(/ERR_CONTENT_LENGTH_MISMATCH|ERR_FAILED|ERR_CONNECTION_CLOSED/u);
    await expect.poll(() => f.closed).toContain('/broken');
  } finally { await f.close(); }
});

test('returns empty responses and rejects unsupported request modes before opening a connection', async () => {
  const f = await fixture();
  try {
    const result = await f.instance.evaluate(async () => {
      const fetcher = (globalThis as NetworkTestGlobal).updateTestFetch;
      const empty = await fetcher('http://update.invalid/empty', { redirect: 'manual' });
      const head = await fetcher('http://update.invalid/head', { method: 'HEAD', redirect: 'manual' });
      const invalid = await fetcher('http://update.invalid/invalid', { redirect: 'follow' }).then(() => 'unexpected success', error => String(error));
      return { empty: { status: empty.status, body: empty.body }, head: { status: head.status, body: head.body }, invalid };
    });
    expect(result.empty).toEqual({ status: 204, body: null });
    expect(result.head).toEqual({ status: 200, body: null });
    expect(result.invalid).toContain('UPDATE_NETWORK_REQUEST_INVALID');
    expect(f.hits).toEqual(['/empty', '/head']);
  } finally { await f.close(); }
});

test('cancels before response headers and does not issue an already-aborted request', async () => {
  const f = await fixture();
  try {
    const result = await f.instance.evaluate(async () => {
      const controller = new AbortController();
      const pending = (globalThis as NetworkTestGlobal).updateTestFetch('http://update.invalid/headers-stall', { redirect: 'manual', signal: controller.signal });
      setTimeout(() => controller.abort(new Error('cancel before headers')), 150);
      const failed = await pending.then(() => 'unexpected success', error => String(error));
      const already = await (globalThis as NetworkTestGlobal).updateTestFetch('http://update.invalid/must-not-run', { redirect: 'manual', signal: controller.signal })
        .then(() => 'unexpected success', error => String(error));
      return { failed, already };
    });
    expect(result.failed).toContain('cancel before headers');
    expect(result.already).toContain('cancel before headers');
    await expect.poll(() => f.closed).toContain('/headers-stall');
    expect(f.hits).toEqual(['/headers-stall']);
  } finally { await f.close(); }
});

for (const mode of ['signal', 'body'] as const) {
  test(`cancels the underlying network connection during streaming via ${mode}`, async () => {
    const f = await fixture();
    try {
      const result = await f.instance.evaluate(async (_electron, cancellation) => {
        const controller = new AbortController();
        const response = await (globalThis as NetworkTestGlobal).updateTestFetch('http://update.invalid/stream-stall', { redirect: 'manual', signal: controller.signal });
        const reader = response.body!.getReader();
        const first = new TextDecoder().decode((await reader.read()).value);
        if (cancellation === 'body') { await reader.cancel(); return { first, failure: 'cancelled' }; }
        controller.abort(new Error('cancel during body'));
        const failure = await reader.read().then(() => 'unexpected success', error => String(error));
        return { first, failure };
      }, mode);
      expect(result.first).toBe('first chunk');
      expect(result.failure).toContain(mode === 'body' ? 'cancelled' : 'cancel during body');
      await expect.poll(() => f.closed).toContain('/stream-stall');
    } finally { await f.close(); }
  });
}

test('applies backpressure while the consumer pauses and preserves streamed bytes', async () => {
  const f = await fixture();
  try {
    await f.instance.evaluate(async () => {
      const state = globalThis as NetworkTestGlobal & { updateBody?: ReadableStream<Uint8Array> };
      state.updateBody = (await state.updateTestFetch('http://update.invalid/large', { redirect: 'manual' })).body!;
    });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(f.sent()).toBeLessThan(f.size);
    const digest = await f.instance.evaluate(async () => {
      const stream = (globalThis as NetworkTestGlobal & { updateBody: ReadableStream<Uint8Array> }).updateBody;
      const hash = (globalThis as NetworkTestGlobal).updateTestHash('sha256');
      for await (const bytes of stream) hash.update(bytes);
      return hash.digest('hex');
    });
    expect(digest).toBe(f.digest);
  } finally { await f.close(); }
});
