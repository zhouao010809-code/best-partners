import type { ClientRequest, ClientRequestConstructorOptions } from 'electron';
import { Readable } from 'node:stream';

type UpdateNetwork = { request(options: ClientRequestConstructorOptions): ClientRequest };

function responseHeaders(values: Record<string, string | string[]>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

// Electron's fetch rejects manual redirects instead of returning the 3xx response.
// Use Chromium requests for system proxy support, but expose each redirect so the
// downloader can validate its destination before another connection is opened.
export function createUpdateDownloadFetcher(network: UpdateNetwork): typeof fetch {
  return async (input, init) => {
    const source = new Request(input, init);
    source.signal.throwIfAborted();
    if (!['GET', 'HEAD'].includes(source.method) || source.redirect !== 'manual') {
      throw new Error('UPDATE_NETWORK_REQUEST_INVALID');
    }
    return new Promise<Response>((resolve, reject) => {
      const request = network.request({ url: source.url, method: source.method, redirect: 'manual', credentials: 'omit' });
      let incoming: Readable | undefined;
      let stopped = false;
      const cleanup = () => source.signal.removeEventListener('abort', onAbort);
      const stop = () => {
        if (stopped) return;
        stopped = true;
        cleanup();
        request.abort();
      };
      const fail = (error: Error) => {
        if (stopped) return;
        // Error the response before request.abort() destroys it without a reason.
        incoming?.destroy(error);
        stop();
        reject(error);
      };
      const onAbort = () => fail(source.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      source.signal.addEventListener('abort', onAbort, { once: true });
      request.on('error', fail);
      request.on('redirect', (status, _method, location, values) => {
        if (stopped) return;
        try {
          const headers = responseHeaders(values);
          if (!headers.has('location')) headers.set('location', location);
          resolve(new Response(null, { status, headers }));
          // Abort synchronously: Electron otherwise reports an unfollowed redirect
          // as an error after this listener returns.
          stop();
        } catch (error) { fail(error as Error); }
      });
      request.on('response', response => {
        if (stopped) return;
        incoming = response as unknown as Readable;
        incoming.once('error', fail);
        incoming.once('end', cleanup);
        // Readable.toWeb cancellation destroys the response, but does not cancel
        // Electron's ClientRequest. Release its connection when the body closes.
        incoming.once('close', stop);
        try {
          const noBody = source.method === 'HEAD' || [204, 205, 304].includes(response.statusCode);
          const body = noBody ? null : Readable.toWeb(incoming, {
            strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength }
          });
          resolve(new Response(body as ReadableStream<Uint8Array> | null, {
            status: response.statusCode, statusText: response.statusMessage, headers: responseHeaders(response.headers)
          }));
          if (noBody) stop();
        } catch (error) { fail(error as Error); }
      });
      try {
        for (const [name, value] of source.headers) request.setHeader(name, value);
        if (source.signal.aborted) onAbort();
        else request.end();
      } catch (error) { fail(error as Error); }
    });
  };
}
