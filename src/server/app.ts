import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import { createCsrfProtector } from './security/csrf.js';
import { registerHtmlCsp } from './security/csp.js';
import { isAllowedHost, isAllowedOrigin } from './security/origin-host.js';
import { createSessionManager } from './security/session.js';
import type { HealthService, HealthSnapshot } from './services/health-service.js';
import type { IndexRepository } from './index/index-repository.js';
import type { OpenableVaultGateway } from './vault/VaultGateway.js';
import { PublicApiError } from '../shared/api/errors.js';
import {
  API_VERSION,
  apiFailureSchema,
  bootstrapDataSchema,
  bootstrapResponseSchema
} from '../shared/api/schemas.js';
import { createReadService } from './services/read-service.js';
import {
  IndexJobService,
  type IndexSchedulerPort
} from './services/index-job-service.js';
import { registerMaterialRoutes } from './api/routes/materials.js';
import { registerKnowledgeRoutes } from './api/routes/knowledge.js';
import { registerOperationRoutes } from './api/routes/operations.js';
import { registerIndexJobRoutes } from './api/routes/index-jobs.js';
import { registerHealthRoutes } from './api/routes/health.js';
import { parseApiOutput } from './api/route-validation.js';

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MUTATION_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

interface SafeErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly operationId: string;
    readonly fields?: Readonly<Record<string, string>> | undefined;
  };
}

function safeError(
  code: string,
  message: string,
  operationId: string,
  fields?: Readonly<Record<string, string>>
): SafeErrorBody {
  return apiFailureSchema.parse({
    error: {
      code,
      message,
      operationId,
      ...(fields === undefined ? {} : { fields })
    }
  });
}

function safeFailureForStatus(statusCode: number, operationId: string): SafeErrorBody {
  if (statusCode === 413) {
    return safeError('PAYLOAD_TOO_LARGE', 'Request body is too large', operationId);
  }
  if (statusCode >= 500) {
    return safeError('INTERNAL_ERROR', 'Request failed', operationId);
  }
  return safeError('REQUEST_REJECTED', 'Request rejected', operationId);
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

const DEFAULT_HEALTH_SNAPSHOT: HealthSnapshot = {
  status: 'recovery-only',
  plugin: {
    status: 'unavailable',
    reason: 'PLUGIN_UNAVAILABLE'
  },
  index: {
    status: 'unavailable',
    reason: 'READ_API_UNAVAILABLE'
  },
  model: {
    status: 'unavailable',
    reason: 'CONFIG_UNAVAILABLE'
  },
  writeGate: {
    status: 'blocked',
    missing: ['profile', 'database'],
    fingerprintMatches: false
  },
  schemaIssues: {
    status: 'unavailable',
    count: 0,
    reason: 'INDEX_UNAVAILABLE'
  }
};

const DEFAULT_HEALTH_SERVICE: HealthService = {
  getSnapshot: async () => DEFAULT_HEALTH_SNAPSHOT
};

export interface ReadApiDependencies {
  readonly repository: IndexRepository;
  readonly gateway: OpenableVaultGateway;
  readonly database: Database.Database;
  readonly indexScheduler: IndexSchedulerPort;
  readonly currentIndexVersion: () => number;
  readonly cursorSecret?: Uint8Array;
  readonly now?: () => string;
  readonly operationIdFactory?: () => string;
  readonly jobIdFactory?: () => string;
}

export interface BuildServerOptions {
  readonly healthService?: HealthService;
  readonly operationIdFactory?: () => string;
  readonly readApi?: ReadApiDependencies;
  readonly onClose?: () => void | Promise<void>;
}

function createSafeOperationId(factory: () => string): () => string {
  return () => {
    try {
      const candidate = factory();
      if (
        candidate.length > 0
        && candidate.length <= 128
        && /^[a-z0-9._:-]+$/iu.test(candidate)
      ) {
        return candidate;
      }
    } catch {
      // Fall through to a private server-generated identifier.
    }
    return randomUUID();
  };
}

export function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify({ logger: false, bodyLimit: MAX_JSON_BODY_BYTES });
  const nodeEnv = process.env.NODE_ENV;
  const sessions = createSessionManager();
  const csrf = createCsrfProtector();
  const healthService = options.healthService ?? DEFAULT_HEALTH_SERVICE;
  const operationId = createSafeOperationId(
    options.operationIdFactory
      ?? options.readApi?.operationIdFactory
      ?? randomUUID
  );
  const readService = options.readApi === undefined
    ? undefined
    : createReadService({
      repository: options.readApi.repository,
      gateway: options.readApi.gateway,
      currentIndexVersion: options.readApi.currentIndexVersion,
      cursorSecret: options.readApi.cursorSecret ?? randomBytes(32)
    });
  const indexJobs = options.readApi === undefined
    ? undefined
    : new IndexJobService({
      database: options.readApi.database,
      scheduler: options.readApi.indexScheduler,
      currentIndexVersion: options.readApi.currentIndexVersion,
      now: options.readApi.now ?? (() => new Date().toISOString()),
      operationIdFactory: operationId,
      jobIdFactory: options.readApi.jobIdFactory ?? randomUUID
    });

  registerHtmlCsp(app);
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = errorStatusCode(error);
    const body = error instanceof PublicApiError
      ? safeError(error.code, error.message, operationId(), error.fields)
      : safeFailureForStatus(statusCode, operationId());
    return reply
      .code(statusCode)
      .type('application/json; charset=utf-8')
      .send(body);
  });
  app.setNotFoundHandler((_request, reply) => reply
    .code(404)
    .send(safeError('NOT_FOUND', 'Resource not found', operationId())));

  app.addHook('onRequest', async (request, reply) => {
    if (!isAllowedHost(request.headers.host)) {
      return reply.code(421).send(safeError(
        'MISDIRECTED_REQUEST',
        'Request authority rejected',
        operationId()
      ));
    }
    const isMutation = MUTATION_METHODS.has(request.method);
    if (!isAllowedOrigin(request.headers.origin, nodeEnv, isMutation)) {
      return reply.code(403).send(safeError('ORIGIN_FORBIDDEN', 'Origin rejected', operationId()));
    }
    if (!isMutation) {
      return;
    }

    const sessionId = sessions.read(request.headers.cookie);
    if (sessionId === undefined) {
      return reply.code(401).send(safeError('SESSION_REQUIRED', 'Session required', operationId()));
    }
    const csrfHeader = request.headers['x-csrf-token'];
    const token = typeof csrfHeader === 'string' ? csrfHeader : undefined;
    if (!csrf.verify(sessionId, token)) {
      return reply.code(403).send(safeError('CSRF_INVALID', 'CSRF token rejected', operationId()));
    }
  });

  registerHealthRoutes(app, healthService);
  registerMaterialRoutes(app, readService);
  registerKnowledgeRoutes(app, {
    ...(readService === undefined ? {} : { service: readService }),
    operationId
  });
  registerOperationRoutes(app);
  registerIndexJobRoutes(app, indexJobs);
  app.get('/api/v1/bootstrap', async (_request, reply) => {
    const session = sessions.issue();
    reply.header('set-cookie', session.setCookie);
    reply.header('cache-control', 'no-store');
    const data = parseApiOutput(bootstrapDataSchema, {
      csrfToken: csrf.issue(session.sessionId)
    });
    return parseApiOutput(bootstrapResponseSchema, { data, version: API_VERSION });
  });
  if (indexJobs !== undefined || options.onClose !== undefined) {
    app.addHook('onClose', async () => {
      await indexJobs?.close();
      await options.onClose?.();
    });
  }
  return app;
}
