import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE_NAME = 'xiaozhao_session';

const PROCESS_SESSION_SECRET = randomBytes(32);
const BASE64URL_256_BIT = /^[A-Za-z0-9_-]{43}$/u;

function signSessionId(sessionId: string, secret: Buffer): string {
  return createHmac('sha256', secret)
    .update('xiaozhao-session\0', 'utf8')
    .update(sessionId, 'utf8')
    .digest('base64url');
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function findSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) {
    return undefined;
  }

  const matches = cookieHeader.split(';').flatMap((part) => {
    const separator = part.indexOf('=');
    if (separator === -1 || part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) {
      return [];
    }
    return [part.slice(separator + 1).trim()];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export interface IssuedSession {
  readonly sessionId: string;
  readonly setCookie: string;
}

export interface SessionManager {
  issue(): IssuedSession;
  read(cookieHeader: string | undefined): string | undefined;
}

export function createSessionManager(secret: Buffer = PROCESS_SESSION_SECRET): SessionManager {
  return {
    issue() {
      const sessionId = randomBytes(32).toString('base64url');
      const signature = signSessionId(sessionId, secret);
      return {
        sessionId,
        setCookie: `${SESSION_COOKIE_NAME}=${sessionId}.${signature}; Path=/; HttpOnly; SameSite=Strict`
      };
    },
    read(cookieHeader) {
      const value = findSessionCookie(cookieHeader);
      if (value === undefined) {
        return undefined;
      }
      const pieces = value.split('.');
      if (pieces.length !== 2) {
        return undefined;
      }
      const [sessionId, signature] = pieces;
      if (sessionId === undefined || signature === undefined
        || !BASE64URL_256_BIT.test(sessionId) || !BASE64URL_256_BIT.test(signature)) {
        return undefined;
      }
      return constantTimeTextEqual(signature, signSessionId(sessionId, secret)) ? sessionId : undefined;
    }
  };
}
