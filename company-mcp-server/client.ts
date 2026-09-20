import { z } from 'zod';
import {
  companyLoginRequestSchema,
  companySessionResponseSchema
} from '../src/shared/api/company-auth.js';
import {
  companyProjectConfirmRequestSchema,
  companyProjectConfirmResponseSchema,
  companyProjectDetailResponseSchema,
  companyProjectDraftResponseSchema,
  companyProjectListResponseSchema,
  companyProjectScanRequestSchema,
  companyProjectScanResponseSchema
} from '../src/shared/api/company-projects.js';
import {
  skillIdParamsSchema,
  skillResponseSchema,
  skillsResponseSchema
} from '../src/shared/api/skills.js';
import { isValidCompanyHost } from '../src/server/security/origin-host.js';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type CompanyMcpConfig = {
  readonly origin: string;
  readonly displayName: string;
  readonly password: string;
  readonly writeEnabled: boolean;
  readonly confirmEnabled: boolean;
  readonly confirmIntent: CompanyMcpConfirmIntent | null;
};

const companyMcpIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u);
const companyMcpConfirmIntentSchema = companyProjectConfirmRequestSchema.extend({
  runId: companyMcpIdSchema
}).strict();
export type CompanyMcpConfirmIntent = z.output<typeof companyMcpConfirmIntentSchema>;

export class CompanyMcpError extends Error {
  public readonly name = 'CompanyMcpError';

  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

const sessionCookiePattern = /(?:^|;\s*)(company_session=[A-Za-z0-9_-]{43})(?:;|$)/u;

function configurationError(code: string): never {
  throw new CompanyMcpError(code, code, 500);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1'
    || hostname === 'localhost'
    || hostname === '[::1]'
    || hostname === '::1';
}

export function loadCompanyMcpConfig(env: NodeJS.ProcessEnv): CompanyMcpConfig {
  const rawOrigin = env.COMPANY_API_ORIGIN;
  const displayName = env.COMPANY_DISPLAY_NAME;
  const password = env.COMPANY_PASSWORD;
  if (!rawOrigin) configurationError('COMPANY_API_ORIGIN_REQUIRED');
  if (!displayName) configurationError('COMPANY_DISPLAY_NAME_REQUIRED');
  if (!password) configurationError('COMPANY_PASSWORD_REQUIRED');
  let url: URL;
  try { url = new URL(rawOrigin); } catch { configurationError('COMPANY_API_ORIGIN_INVALID'); }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
    || !isValidCompanyHost(url.hostname)
    || (url.protocol === 'http:' && !isLoopbackHostname(url.hostname))
  ) configurationError('COMPANY_API_ORIGIN_INVALID');
  const confirmEnabled = env.COMPANY_MCP_CONFIRM_ENABLED === 'true';
  let confirmIntent: CompanyMcpConfirmIntent | null = null;
  if (confirmEnabled) {
    if (!env.COMPANY_MCP_CONFIRM_INTENT) configurationError('COMPANY_MCP_CONFIRM_INTENT_REQUIRED');
    try {
      confirmIntent = companyMcpConfirmIntentSchema.parse(JSON.parse(env.COMPANY_MCP_CONFIRM_INTENT));
    } catch {
      configurationError('COMPANY_MCP_CONFIRM_INTENT_INVALID');
    }
  }
  return {
    origin: url.origin,
    displayName,
    password,
    writeEnabled: env.COMPANY_MCP_WRITE_ENABLED === 'true',
    confirmEnabled,
    confirmIntent
  };
}

const failureSchema = z.object({
  error: z.object({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(2_000)
  }).passthrough()
}).passthrough();

function responseError(response: Response, payload: unknown): CompanyMcpError {
  const parsed = failureSchema.safeParse(payload);
  return parsed.success
    ? new CompanyMcpError(parsed.data.error.code, parsed.data.error.message, response.status)
    : new CompanyMcpError('COMPANY_RESPONSE_INVALID', 'Company service returned an invalid error response.', response.status);
}

const scalarPathKeys = new Set(['projectRoot', 'sourceRoot', 'relativePath']);
const pathArrayKeys = new Set(['evidencePaths', 'references']);

function assertSafeRelativePath(value: string): void {
  if (
    value.startsWith('/')
    || value.includes('\\')
    || /^[A-Za-z]:[\\/]/u.test(value)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
    || value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new CompanyMcpError('COMPANY_RESPONSE_PATH_UNSAFE', 'Company response exposed an unsafe machine path.', 502);
  }
}

function assertNoMachinePaths(value: unknown, parentKey?: string): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (pathArrayKeys.has(parentKey ?? '') && typeof item === 'string') assertSafeRelativePath(item);
      else assertNoMachinePaths(item, parentKey);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (scalarPathKeys.has(key) && typeof item === 'string') assertSafeRelativePath(item);
    else assertNoMachinePaths(item, key);
  }
}

function safeData<T>(value: T): T {
  assertNoMachinePaths(value);
  return value;
}

async function json(response: Response): Promise<unknown> {
  try { return await response.json(); } catch {
    throw new CompanyMcpError('COMPANY_RESPONSE_INVALID', 'Company service returned an invalid response.', response.status);
  }
}

export interface CompanyMcpClient {
  listProjects(): Promise<unknown>;
  getProject(projectId: string): Promise<unknown>;
  scanProjectFolder(input: unknown): Promise<unknown>;
  getProjectProposal(runId: string): Promise<unknown>;
  confirmProject(runId: string, input: unknown): Promise<unknown>;
  listSkills(): Promise<unknown>;
  getSkill(id: string): Promise<unknown>;
}

export function createCompanyMcpClient(
  config: CompanyMcpConfig,
  fetcher: FetchLike = (input, init) => globalThis.fetch(input, init)
): CompanyMcpClient {
  let cookie: string | undefined;
  let csrfToken: string | undefined;
  let loginFlight: Promise<void> | undefined;
  let confirmationConsumed = false;

  async function login(): Promise<void> {
    loginFlight ??= (async () => {
      const body = companyLoginRequestSchema.parse({
        displayName: config.displayName,
        password: config.password
      });
      let response: Response;
      try {
        response = await fetcher(`${config.origin}/api/company/v1/auth/login`, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json', origin: config.origin },
          body: JSON.stringify(body)
        });
      } catch {
        throw new CompanyMcpError('COMPANY_UNREACHABLE', 'Company service is unreachable.', 503);
      }
      const payload = await json(response);
      if (!response.ok) throw responseError(response, payload);
      const parsed = companySessionResponseSchema.safeParse(payload);
      const setCookie = response.headers.get('set-cookie');
      const match = setCookie?.match(sessionCookiePattern);
      if (!parsed.success || match?.[1] === undefined) {
        throw new CompanyMcpError('COMPANY_RESPONSE_INVALID', 'Company login response is invalid.', 502);
      }
      cookie = match[1];
      csrfToken = parsed.data.data.csrfToken;
    })();
    try { await loginFlight; } finally { loginFlight = undefined; }
  }

  async function refreshSession(): Promise<void> {
    if (!cookie) return login();
    let response: Response;
    try {
      response = await fetcher(`${config.origin}/api/company/v1/auth/session`, {
        method: 'GET', redirect: 'error', headers: { cookie }
      });
    } catch {
      throw new CompanyMcpError('COMPANY_UNREACHABLE', 'Company service is unreachable.', 503);
    }
    const payload = await json(response);
    if (response.status === 401) {
      cookie = undefined;
      csrfToken = undefined;
      return login();
    }
    if (!response.ok) throw responseError(response, payload);
    const parsed = companySessionResponseSchema.safeParse(payload);
    if (!parsed.success) throw new CompanyMcpError('COMPANY_RESPONSE_INVALID', 'Company session response is invalid.', 502);
    csrfToken = parsed.data.data.csrfToken;
  }

  async function request<T>(input: {
    readonly path: string;
    readonly method?: 'GET' | 'POST';
    readonly body?: unknown;
    readonly schema: z.ZodType<T>;
    readonly write?: 'stage' | 'confirm';
  }, retry = true): Promise<T> {
    if (input.write === 'confirm' && (!config.writeEnabled || !config.confirmEnabled)) {
      throw new CompanyMcpError(
        'COMPANY_MCP_CONFIRM_DISABLED',
        'Company Agent confirmation is disabled. Enable it only for one explicitly reviewed confirmation session.',
        403
      );
    }
    if (input.write === 'stage' && !config.writeEnabled) {
      throw new CompanyMcpError(
        'COMPANY_MCP_WRITE_DISABLED',
        'Company Agent writes are disabled. Set COMPANY_MCP_WRITE_ENABLED=true only for an explicitly confirmed operation.',
        403
      );
    }
    if (!cookie || !csrfToken) await login();
    const method = input.method ?? 'GET';
    let response: Response;
    try {
      response = await fetcher(`${config.origin}${input.path}`, {
        method,
        redirect: 'error',
        headers: {
          cookie: cookie!,
          ...(method === 'POST' ? {
            'content-type': 'application/json',
            origin: config.origin,
            'x-csrf-token': csrfToken!
          } : {})
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) })
      });
    } catch {
      throw new CompanyMcpError('COMPANY_UNREACHABLE', 'Company service is unreachable.', 503);
    }
    const payload = await json(response);
    if (!response.ok) {
      const error = responseError(response, payload);
      if (retry && (response.status === 401 || error.code === 'CSRF_INVALID')) {
        if (response.status === 401) { cookie = undefined; csrfToken = undefined; }
        await refreshSession();
        return request(input, false);
      }
      throw error;
    }
    const parsed = input.schema.safeParse(payload);
    if (!parsed.success) throw new CompanyMcpError('COMPANY_RESPONSE_INVALID', 'Company service response is incompatible.', 502);
    return parsed.data;
  }

  return {
    listProjects: async () => safeData((await request({ path: '/api/company/v1/projects', schema: companyProjectListResponseSchema })).data),
    getProject: async (projectId) => {
      const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u).parse(projectId);
      return safeData((await request({ path: `/api/company/v1/projects/${encodeURIComponent(id)}`, schema: companyProjectDetailResponseSchema })).data);
    },
    scanProjectFolder: async (raw) => {
      const body = companyProjectScanRequestSchema.parse(raw);
      return safeData((await request({ path: '/api/company/v1/projects/scan', method: 'POST', body, schema: companyProjectScanResponseSchema, write: 'stage' })).data);
    },
    getProjectProposal: async (runId) => {
      const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u).parse(runId);
      return safeData((await request({ path: `/api/company/v1/projects/drafts/${encodeURIComponent(id)}`, schema: companyProjectDraftResponseSchema })).data);
    },
    confirmProject: async (runId, raw) => {
      const id = companyMcpIdSchema.parse(runId);
      const body = companyProjectConfirmRequestSchema.parse(raw);
      if (!config.writeEnabled || !config.confirmEnabled) {
        throw new CompanyMcpError(
          'COMPANY_MCP_CONFIRM_DISABLED',
          'Company Agent confirmation is disabled. Enable it only for one explicitly reviewed confirmation session.',
          403
        );
      }
      const intent = config.confirmIntent;
      if (
        intent === null
        || intent.runId !== id
        || intent.sourceSha256 !== body.sourceSha256
        || intent.name !== body.name
        || intent.clientName !== body.clientName
        || intent.status !== body.status
        || intent.selectedSkillIds.length !== body.selectedSkillIds.length
        || intent.selectedSkillIds.some((skillId, index) => skillId !== body.selectedSkillIds[index])
      ) {
        throw new CompanyMcpError(
          'COMPANY_MCP_CONFIRM_INTENT_MISMATCH',
          'Confirmation does not match the exact host-authorized proposal intent.',
          403
        );
      }
      if (confirmationConsumed) {
        throw new CompanyMcpError('COMPANY_MCP_CONFIRM_INTENT_CONSUMED', 'Confirmation intent was already consumed.', 409);
      }
      confirmationConsumed = true;
      return safeData((await request({ path: `/api/company/v1/projects/drafts/${encodeURIComponent(id)}/confirm`, method: 'POST', body, schema: companyProjectConfirmResponseSchema, write: 'confirm' })).data);
    },
    listSkills: async () => safeData((await request({ path: '/api/company/v1/skills', schema: skillsResponseSchema })).data),
    getSkill: async (rawId) => {
      const { id } = skillIdParamsSchema.parse({ id: rawId });
      return safeData((await request({ path: `/api/company/v1/skills/${encodeURIComponent(id)}`, schema: skillResponseSchema })).data);
    }
  };
}
