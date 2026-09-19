import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import { createCsrfProtector } from './security/csrf.js';
import { registerHtmlCsp } from './security/csp.js';
import { isAllowedHost, isAllowedOrigin } from './security/origin-host.js';
import type { HttpPolicy } from './security/loopback-policy.js';
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
import { registerDocumentRoutes } from './api/routes/documents.js';
import { registerKnowledgeRoutes } from './api/routes/knowledge.js';
import { registerOperationRoutes } from './api/routes/operations.js';
import { registerIndexJobRoutes } from './api/routes/index-jobs.js';
import { registerHealthRoutes } from './api/routes/health.js';
import { parseApiOutput } from './api/route-validation.js';
import { registerIntakeRoutes } from './api/routes/intake.js';
import type { IntakeService } from './services/intake-service.js';
import type { ExtractionService } from './services/extraction-service.js';
import { registerExtractionRoutes } from './api/routes/extractions.js';
import type { IngestionService } from './ingestion/ingestion-service.js';
import { registerIngestionRoutes } from './api/routes/ingestion.js';
import { registerTrashRoutes } from './api/routes/trash.js';
import type { TrashService } from './trash/trash-service.js';
import type { IntakeTrashService } from './trash/intake-trash-service.js';
import { registerIntakeTrashRoutes } from './api/routes/intake-trash.js';
import { registerAssistantRoutes } from './api/routes/assistant.js';
import { createAssistantService } from './assistant/service.js';
import { createAssistantTools } from './assistant/attachment-tools.js';
import { createAssistantActionPlanService } from './assistant/action-plan-service.js';
import { createAssistantActionPlanStore } from './assistant/action-plan-store.js';
import type { AssistantAdapter } from './assistant/types.js';
import type { AttachmentService } from './attachments/service.js';
import { registerAttachmentRoutes } from './api/routes/attachments.js';
import { createAssistantDraftService } from './assistant/draft-service.js';
import { registerAssistantDraftRoutes } from './api/routes/assistant-drafts.js';
import { registerSkillRoutes } from './api/routes/skills.js';
import { registerCompanyAuthRoutes } from './api/routes/company-auth.js';
import { registerCompanyProjectRoutes } from './api/routes/company-projects.js';
import { registerCompanySkillRoutes } from './api/routes/company-skills.js';
import type { SkillCatalogService } from './services/skill-catalog.js';
import { createSkillMatcherService } from './services/skill-matcher.js';
import type { CompanyRuntimeMode } from '../shared/company/workspace.js';
import { createCompanyRuntime, type CompanyRuntime } from './company/company-runtime.js';

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
  vaultSource: {
    status: 'unavailable',
    reason: 'VAULT_UNAVAILABLE'
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
  readonly runtimeMode?: CompanyRuntimeMode;
  readonly companyRuntime?: CompanyRuntime;
  readonly assistantAdapters?: AssistantAdapter[];
  readonly attachmentService?: AttachmentService;
  readonly trashService?: TrashService;
  readonly ingestionService?: IngestionService;
  readonly extractionService?: ExtractionService;
  readonly intakeService?: IntakeService;
  readonly intakeTrashService?: IntakeTrashService;
  readonly httpPolicy?: HttpPolicy;
  readonly healthService?: HealthService;
  readonly operationIdFactory?: () => string;
  readonly readApi?: ReadApiDependencies;
  readonly skillCatalog?: SkillCatalogService;
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
  const runtimeMode = options.runtimeMode
    ?? (process.env.RUNTIME_MODE === 'company' ? 'company' : 'personal');
  const companyRuntime = runtimeMode === 'company'
    ? options.companyRuntime ?? createCompanyRuntime()
    : undefined;
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
      database: options.readApi.database,
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
  const actionPlans = options.readApi && options.attachmentService
    ? createAssistantActionPlanService({
      store: createAssistantActionPlanStore(options.readApi.database),
      attachmentService: options.attachmentService
    })
    : undefined;
  // Keep startup recovery explicit at the composition boundary; reconciliation
  // is idempotent and never writes files.
  actionPlans?.recover();
  const assistant = options.assistantAdapters && options.readApi && readService
    ? createAssistantService({ database: options.readApi.database, adapters: options.assistantAdapters,
      ...(actionPlans ? { actionPlans } : {}),
      ...(options.attachmentService ? { resolveAttachment: (id: string) => options.attachmentService!.get(id) } : {}),
      createTools: context => createAssistantTools({ ...context, readService,
        ...(options.attachmentService ? { attachmentService: options.attachmentService } : {}),
        ...(options.extractionService ? { extractionService: options.extractionService } : {}) }) })
    : undefined;

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
    const pathname = request.url.split('?', 1)[0] ?? request.url;
    const isCompanyPath = /^\/api\/company\/v1(?:\/|$)/u.test(pathname);
    const isCompanyRoute = runtimeMode === 'company' && isCompanyPath;
    const policy = options.httpPolicy;
    if (!(policy?.isAllowedHost(request.headers.host) ?? isAllowedHost(request.headers.host))) {
      return reply.code(421).send(safeError(
        'MISDIRECTED_REQUEST',
        'Request authority rejected',
        operationId()
      ));
    }
    const isMutation = MUTATION_METHODS.has(request.method);
    const originRequired = request.method !== 'GET' && request.method !== 'HEAD';
    if (!(policy?.isAllowedOrigin(request.headers.origin, originRequired)
      ?? isAllowedOrigin(request.headers.origin, nodeEnv, originRequired))) {
      return reply.code(403).send(safeError('ORIGIN_FORBIDDEN', 'Origin rejected', operationId()));
    }
    // A company process has its own authenticated namespace and must never
    // accidentally become a personal-vault HTTP server.  Keep only the public
    // bootstrap probe so the browser can select the company route tree; all
    // other personal endpoints fail closed instead of returning a misleading
    // health snapshot or a 503 from an unconfigured personal service.
    if (
      runtimeMode === 'company'
      && pathname.startsWith('/api/v1/')
      && pathname !== '/api/v1/bootstrap'
    ) {
      return reply.code(404).send(safeError('NOT_FOUND', 'Resource not found', operationId()));
    }
    // In personal mode the company namespace is intentionally absent. Let the
    // request reach the router (and return 404) without requiring a personal
    // mutation session first.
    if (runtimeMode === 'personal' && isCompanyPath) return;
    if (isCompanyRoute) {
      const isBootstrap = request.method === 'POST' && pathname === '/api/company/v1/auth/bootstrap';
      const isLogin = request.method === 'POST' && pathname === '/api/company/v1/auth/login';
      if (isBootstrap || isLogin) return;
      const companyUser = await companyRuntime?.auth.authenticate({
        headers: request.headers as unknown as { readonly cookie?: string | string[]; readonly [key: string]: unknown }
      });
      if (companyUser === undefined) {
        return reply.code(401).send(safeError('COMPANY_SESSION_REQUIRED', 'Company session required', operationId()));
      }
      if (!isMutation) return;
      const csrfHeader = request.headers['x-csrf-token'];
      const token = typeof csrfHeader === 'string' ? csrfHeader : undefined;
      if (!(await companyRuntime!.auth.verifyCsrf({
        headers: request.headers as unknown as { readonly cookie?: string | string[]; readonly [key: string]: unknown }
      }, token))) {
        return reply.code(403).send(safeError('CSRF_INVALID', 'CSRF token rejected', operationId()));
      }
      return;
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
  registerAssistantRoutes(app, assistant);
  registerAttachmentRoutes(app, options.attachmentService);
  registerAssistantDraftRoutes(app, { ...(options.readApi ? { assistantDrafts: createAssistantDraftService({ database: options.readApi.database }) } : {}) });
  registerMaterialRoutes(app, readService);
  registerDocumentRoutes(app, readService);
  registerIntakeRoutes(app, options.intakeService);
  registerIntakeTrashRoutes(app, options.intakeTrashService);
  registerExtractionRoutes(app, options.extractionService, () => options.readApi?.indexScheduler.snapshot().state);
  registerIngestionRoutes(app, options.ingestionService);
  registerTrashRoutes(app, options.trashService);
  registerKnowledgeRoutes(app, {
    ...(readService === undefined ? {} : { service: readService }),
    operationId
  });
  registerSkillRoutes(
    app,
    options.skillCatalog,
    options.skillCatalog === undefined ? undefined : createSkillMatcherService({ catalog: options.skillCatalog })
  );
  registerOperationRoutes(app, { database: options.readApi?.database,
    intakeHistory: options.intakeService?.history,
    trash: options.trashService ? () => options.trashService!.list() : undefined,
    intakeTrash: options.intakeTrashService ? () => options.intakeTrashService!.list() : undefined });
  registerIndexJobRoutes(app, indexJobs);
  if (companyRuntime !== undefined) {
    registerCompanyAuthRoutes(app, companyRuntime);
    registerCompanyProjectRoutes(app, { ...companyRuntime, runtime: companyRuntime });
    registerCompanySkillRoutes(app, companyRuntime);
  }
  app.get('/api/v1/bootstrap', async (request, reply) => {
    let sessionId = sessions.read(request.headers.cookie);
    if (sessionId === undefined) {
      const session = sessions.issue();
      sessionId = session.sessionId;
      reply.header('set-cookie', session.setCookie);
    }
    reply.header('cache-control', 'no-store');
    const data = parseApiOutput(bootstrapDataSchema, {
      csrfToken: csrf.issue(sessionId),
      runtimeMode
    });
    return parseApiOutput(bootstrapResponseSchema, { data, version: API_VERSION });
  });
  if (assistant !== undefined || indexJobs !== undefined || options.onClose !== undefined || options.attachmentService !== undefined || options.extractionService !== undefined || options.ingestionService !== undefined || options.trashService !== undefined || options.intakeTrashService !== undefined) {
    app.addHook('onClose', async () => {
      try { await assistant?.close(); } finally {
        try { try { await options.attachmentService?.close(); } finally { await options.extractionService?.close(); } } finally {
          try { await options.ingestionService?.close(); } finally {
            try { await options.trashService?.close(); } finally {
              try { await options.intakeTrashService?.close(); } finally {
                try { await indexJobs?.close(); } finally { await options.onClose?.(); }
              }
            }
          }
        }
      }
    });
  }
  return app;
}
