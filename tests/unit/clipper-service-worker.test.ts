import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetModules(); });

async function connection(response: unknown) {
  vi.useFakeTimers();
  let listener: (message: unknown, sender: unknown, reply: (value: unknown) => void) => boolean;
  let nativeMessage: (response: unknown) => void;
  const addListener = vi.fn();
  vi.stubGlobal('chrome', {
    runtime: { id: 'fixture-extension', onInstalled: { addListener },
      onMessage: { addListener: (value: typeof listener) => { listener = value; } },
      connectNative: () => ({ onMessage: { addListener: (value: typeof nativeMessage) => { nativeMessage = value; } },
        onDisconnect: { addListener }, disconnect: vi.fn(), postMessage: () => queueMicrotask(() => nativeMessage(response)) }) },
    storage: { local: { get: async () => ({ clipperToken: 't'.repeat(32) }) } },
    contextMenus: { onClicked: { addListener } }, action: { onClicked: { addListener } }
  });
  await import(new URL('../../browser-extension/src/service-worker.js', import.meta.url).href);
  return new Promise(resolve => listener({ type: 'test-connection' }, {}, resolve));
}

it('reports the native host pairing rejection as a failed connection', async () => {
  await expect(connection({ ok: false, error: '浏览器插件未配对，请重新连接' }))
    .resolves.toEqual({ ok: false, error: '浏览器插件未配对，请重新连接' });
});

it('only reports success for an acknowledged native ping', async () => {
  await expect(connection({ ok: true, pong: true })).resolves.toMatchObject({ ok: true });
});
