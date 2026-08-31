import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const CSP_NONCE_PLACEHOLDER = '__CSP_NONCE__';

function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    `style-src-elem 'self' 'nonce-${nonce}'`,
    "style-src-attr 'none'",
    "img-src 'self' data: blob:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'"
  ].join('; ');
}

function isHtmlContentType(value: unknown): boolean {
  return typeof value === 'string' && value.toLowerCase().startsWith('text/html');
}

export function registerHtmlCsp(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply, payload) => {
    if (!isHtmlContentType(reply.getHeader('content-type'))) {
      return payload;
    }

    const nonce = randomBytes(32).toString('base64url');
    reply.header('content-security-policy', contentSecurityPolicy(nonce));

    if (typeof payload === 'string') {
      return payload.replaceAll(CSP_NONCE_PLACEHOLDER, nonce);
    }
    if (Buffer.isBuffer(payload)) {
      return Buffer.from(payload.toString('utf8').replaceAll(CSP_NONCE_PLACEHOLDER, nonce), 'utf8');
    }
    return payload;
  });
}
