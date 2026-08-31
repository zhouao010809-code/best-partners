import Fastify from 'fastify';
import { createCsrfProtector } from './security/csrf.js';
import { registerHtmlCsp } from './security/csp.js';
import { isAllowedHost, isAllowedOrigin } from './security/origin-host.js';
import { createSessionManager } from './security/session.js';

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MUTATION_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

interface SafeErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

function safeError(code: string, message: string): SafeErrorBody {
  return { error: { code, message } };
}

function safeFailureForStatus(statusCode: number): SafeErrorBody {
  if (statusCode === 413) {
    return safeError('PAYLOAD_TOO_LARGE', 'Request body is too large');
  }
  if (statusCode >= 500) {
    return safeError('INTERNAL_ERROR', 'Request failed');
  }
  return safeError('REQUEST_REJECTED', 'Request rejected');
}

function errorStatusCode(error: unknown): number {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) {
    return 500;
  }
  const candidate = error.statusCode;
  return typeof candidate === 'number' && candidate >= 400 && candidate <= 599
    ? candidate
    : 500;
}

export function buildServer() {
  const app = Fastify({ logger: false, bodyLimit: MAX_JSON_BODY_BYTES });
  const nodeEnv = process.env.NODE_ENV;
  const sessions = createSessionManager();
  const csrf = createCsrfProtector();

  registerHtmlCsp(app);
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = errorStatusCode(error);
    return reply
      .code(statusCode)
      .type('application/json; charset=utf-8')
      .send(safeFailureForStatus(statusCode));
  });
  app.setNotFoundHandler((_request, reply) => reply
    .code(404)
    .send(safeError('NOT_FOUND', 'Resource not found')));

  app.addHook('onRequest', async (request, reply) => {
    if (!isAllowedHost(request.headers.host)) {
      return reply.code(421).send(safeError('MISDIRECTED_REQUEST', 'Request authority rejected'));
    }
    const isMutation = MUTATION_METHODS.has(request.method);
    if (!isAllowedOrigin(request.headers.origin, nodeEnv, isMutation)) {
      return reply.code(403).send(safeError('ORIGIN_FORBIDDEN', 'Origin rejected'));
    }
    if (!isMutation) {
      return;
    }

    const sessionId = sessions.read(request.headers.cookie);
    if (sessionId === undefined) {
      return reply.code(401).send(safeError('SESSION_REQUIRED', 'Session required'));
    }
    const csrfHeader = request.headers['x-csrf-token'];
    const token = typeof csrfHeader === 'string' ? csrfHeader : undefined;
    if (!csrf.verify(sessionId, token)) {
      return reply.code(403).send(safeError('CSRF_INVALID', 'CSRF token rejected'));
    }
  });

  app.get('/api/v1/health', async () => ({
    data: {
      status: 'booting' as const,
      apiVersion: 'v1' as const,
      writeGate: 'closed' as const
    },
    version: 1
  }));
  app.get('/api/v1/bootstrap', async (_request, reply) => {
    const session = sessions.issue();
    reply.header('set-cookie', session.setCookie);
    reply.header('cache-control', 'no-store');
    return {
      data: { csrfToken: csrf.issue(session.sessionId) },
      version: 1
    };
  });
  return app;
}
