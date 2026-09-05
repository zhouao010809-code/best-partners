import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function contained(root: string, path: string): boolean {
  const difference = relative(root, path);
  return difference !== '' && difference !== '..'
    && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
}

function notFound(reply: FastifyReply) {
  return reply.code(404).type('application/json; charset=utf-8').send({
    error: { code: 'NOT_FOUND', message: 'Resource not found', operationId: randomUUID() }
  });
}

function acceptsHtml(accept: string | undefined): boolean {
  return accept?.split(',').some((range) => {
    const [type, ...parameters] = range.trim().toLowerCase().split(';');
    if (type !== 'text/html' && type !== 'application/xhtml+xml') return false;
    const quality = parameters.find((parameter) => parameter.trim().startsWith('q='));
    return quality === undefined || Number(quality.trim().slice(2)) > 0;
  }) ?? false;
}

export async function registerClientAssets(app: FastifyInstance, clientRoot: string): Promise<void> {
  const root = await realpath(clientRoot);
  const indexPath = await realpath(join(root, 'index.html'));
  if (!contained(root, indexPath)) throw new Error('INVALID_CLIENT_ASSETS');
  const html = await readFile(indexPath);
  const assetRoot = join(root, 'assets');

  app.route({
    method: ['GET', 'HEAD'],
    url: '/assets/*',
    async handler(request, reply) {
      try {
        const name = (request.params as { '*': string })['*'];
        const path = await realpath(join(assetRoot, name));
        if (!contained(assetRoot, path) || !(await stat(path)).isFile()) return notFound(reply);
        const mime = CONTENT_TYPES[extname(path)];
        if (mime === undefined) return notFound(reply);
        const bytes = await readFile(path);
        return reply.type(mime).header('x-content-type-options', 'nosniff').send(bytes);
      } catch {
        return notFound(reply);
      }
    }
  });

  app.route({ method: ['GET', 'HEAD'], url: '/*', handler: (request, reply) => {
    let path: string;
    try { path = decodeURIComponent(request.url.split('?')[0] ?? ''); } catch { return notFound(reply); }
    if ((request.method !== 'GET' && request.method !== 'HEAD')
      || path === '/api' || path.startsWith('/api/')
      || path === '/assets' || path.startsWith('/assets/')
      || extname(path) !== '' || !acceptsHtml(request.headers.accept)) return notFound(reply);
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(Buffer.from(html));
  } });
}
