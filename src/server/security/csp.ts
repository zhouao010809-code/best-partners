import { randomBytes } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { FastifyInstance } from 'fastify';

const CSP_NONCE_PLACEHOLDER = '__CSP_NONCE__';
const MAX_TRUSTED_HTML_BYTES = 1024 * 1024;
const META_TAG_PATTERN = /<meta\b[^>]*>/giu;
const QUOTED_ATTRIBUTE_PATTERN = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

interface NonceMeta {
  readonly start: number;
  readonly source: string;
  readonly contentAttribute: string;
  readonly contentValue: string;
}

interface DecodedHtml {
  readonly source: string;
  readonly wasBuffer: boolean;
}

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

function decodeTrustedHtml(payload: unknown): DecodedHtml {
  if (typeof payload === 'string') {
    const encoded = Buffer.from(payload, 'utf8');
    if (encoded.length > MAX_TRUSTED_HTML_BYTES || UTF8_DECODER.decode(encoded) !== payload) {
      throw new Error('HTML response is not a bounded UTF-8 template');
    }
    return { source: payload, wasBuffer: false };
  }
  if (Buffer.isBuffer(payload) && payload.length <= MAX_TRUSTED_HTML_BYTES) {
    return { source: UTF8_DECODER.decode(payload), wasBuffer: true };
  }
  throw new Error('HTML response must be a bounded string or Buffer template');
}

function nonceMetaIn(html: string): NonceMeta {
  const candidates: NonceMeta[] = [];

  for (const metaMatch of html.matchAll(META_TAG_PATTERN)) {
    const source = metaMatch[0];
    const attributes = new Map<string, { readonly value: string; readonly source: string }>();
    for (const attributeMatch of source.matchAll(QUOTED_ATTRIBUTE_PATTERN)) {
      const name = attributeMatch[1]?.toLowerCase();
      const value = attributeMatch[2] ?? attributeMatch[3];
      if (name === undefined || value === undefined || attributes.has(name)) {
        throw new Error('HTML nonce meta is ambiguous');
      }
      attributes.set(name, { value, source: attributeMatch[0] });
    }

    if (attributes.get('name')?.value.toLowerCase() !== 'csp-nonce') {
      continue;
    }
    const content = attributes.get('content');
    if (content === undefined) {
      throw new Error('HTML nonce meta has no content attribute');
    }
    candidates.push({
      start: metaMatch.index,
      source,
      contentAttribute: content.source,
      contentValue: content.value
    });
  }

  const placeholderCount = html.split(CSP_NONCE_PLACEHOLDER).length - 1;
  if (candidates.length !== 1 || placeholderCount !== 1
    || candidates[0]?.contentValue !== CSP_NONCE_PLACEHOLDER) {
    throw new Error('HTML response must contain exactly one nonce meta placeholder');
  }
  return candidates[0];
}

function injectNonce(html: string, nonce: string): string {
  const meta = nonceMetaIn(html);
  const updatedMeta = meta.source.replace(
    meta.contentAttribute,
    meta.contentAttribute.replace(CSP_NONCE_PLACEHOLDER, nonce)
  );
  return `${html.slice(0, meta.start)}${updatedMeta}${html.slice(meta.start + meta.source.length)}`;
}

export function registerHtmlCsp(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply, payload) => {
    if (!isHtmlContentType(reply.getHeader('content-type'))) {
      return payload;
    }

    const html = decodeTrustedHtml(payload);
    const nonce = randomBytes(32).toString('base64url');
    const responseBody = injectNonce(html.source, nonce);
    reply.header('content-security-policy', contentSecurityPolicy(nonce));
    return html.wasBuffer ? Buffer.from(responseBody, 'utf8') : responseBody;
  });
}
