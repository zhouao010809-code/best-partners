import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PROCESS_CSRF_SECRET = randomBytes(32);
const BASE64URL_256_BIT = /^[A-Za-z0-9_-]{43}$/u;

function tokenForSession(sessionId: string, secret: Buffer): string {
  return createHmac('sha256', secret)
    .update('xiaozhao-csrf\0', 'utf8')
    .update(sessionId, 'utf8')
    .digest('base64url');
}

function constantTimeTokenEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export interface CsrfProtector {
  issue(sessionId: string): string;
  verify(sessionId: string, token: string | undefined): boolean;
}

export function createCsrfProtector(secret: Buffer = PROCESS_CSRF_SECRET): CsrfProtector {
  return {
    issue(sessionId) {
      return tokenForSession(sessionId, secret);
    },
    verify(sessionId, token) {
      return token !== undefined
        && BASE64URL_256_BIT.test(token)
        && constantTimeTokenEqual(token, tokenForSession(sessionId, secret));
    }
  };
}
