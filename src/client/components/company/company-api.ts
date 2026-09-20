import { z } from 'zod';
import {
  companyBootstrapDataSchema,
  companyBootstrapRequestSchema,
  companySessionDataSchema,
  companySessionResponseSchema,
  companyUserResponseSchema,
  companyLoginRequestSchema
} from '../../../shared/api/company-auth.js';
import {
  companyProjectConfirmRequestSchema,
  companyProjectConfirmResponseSchema,
  companyProjectDetailResponseSchema,
  companyProjectDraftResponseSchema,
  companyProjectListResponseSchema,
  companyProjectScanRequestSchema,
  companyProjectScanResponseSchema
} from '../../../shared/api/company-projects.js';
import {
  skillIdParamsSchema,
  skillsResponseSchema,
  skillResponseSchema,
  type SkillDetail,
  type SkillsPage
} from '../../../shared/api/skills.js';
import {
  companyMetricImportRequestSchema,
  companyMetricImportResponseSchema,
  companyMetricScanResponseSchema,
  companyMetricsStatusResponseSchema,
  companyProjectMetricsResponseSchema,
  type CompanyMetricImport,
  type CompanyMetricImportRequest,
  type CompanyMetricsStatus,
  type CompanyProjectMetrics,
  type CompanyMetricScanResponseData
} from '../../../shared/api/company-metrics.js';
import type { ApiClientResult, ClientFailureState } from '../../api/client.js';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Envelope = { readonly data: unknown };

export type CompanyApiResult<T> = ApiClientResult<T>;
export type CompanyBootstrapRequest = z.infer<typeof companyBootstrapRequestSchema>;
export type CompanySession = z.infer<typeof companySessionDataSchema>;
export type CompanyProjectConfirmRequest = z.infer<typeof companyProjectConfirmRequestSchema>;
export type CompanyProjectScanRequest = z.infer<typeof companyProjectScanRequestSchema>;
export type CompanyProject = z.infer<typeof import('../../../shared/api/company-projects.js').companyProjectSchema>;
export type CompanyProjectProposal = z.infer<typeof import('../../../shared/api/company-projects.js').companyProjectProposalSchema>;
export type CompanyProjectRun = z.infer<typeof import('../../../shared/api/company-projects.js').companyProjectRunSchema>;

export interface CompanyApi {
  readonly auth: {
    bootstrap(input: CompanyBootstrapRequest): Promise<CompanyApiResult<z.infer<typeof companyBootstrapDataSchema>>>;
    login(displayName: string, password: string): Promise<CompanyApiResult<CompanySession>>;
    session(signal?: AbortSignal): Promise<CompanyApiResult<CompanySession>>;
    logout(): Promise<CompanyApiResult<{ readonly loggedOut: true }>>;
  };
  readonly projects: {
    list(signal?: AbortSignal): Promise<CompanyApiResult<{ readonly items: readonly CompanyProject[] }>>;
    scan(input: CompanyProjectScanRequest, signal?: AbortSignal): Promise<CompanyApiResult<{
      readonly reused: boolean;
      readonly run: CompanyProjectRun;
      readonly project: CompanyProject;
      readonly proposal: CompanyProjectProposal;
    }>>;
    draft(id: string, signal?: AbortSignal): Promise<CompanyApiResult<{ readonly run: CompanyProjectRun; readonly project: CompanyProject }>>;
    confirm(id: string, input: CompanyProjectConfirmRequest): Promise<CompanyApiResult<{
      readonly project: CompanyProject;
      readonly run: CompanyProjectRun;
      readonly operationId: string;
    }>>;
    get(id: string, signal?: AbortSignal): Promise<CompanyApiResult<CompanyProject>>;
  };
  readonly skills: {
    list(signal?: AbortSignal): Promise<CompanyApiResult<SkillsPage>>;
    get(id: string, signal?: AbortSignal): Promise<CompanyApiResult<SkillDetail>>;
  };
  readonly metrics?: {
    project(projectId: string, signal?: AbortSignal): Promise<CompanyApiResult<CompanyProjectMetrics>>;
    status(projectId?: string, signal?: AbortSignal): Promise<CompanyApiResult<CompanyMetricsStatus>>;
    scan(): Promise<CompanyApiResult<CompanyMetricScanResponseData>>;
    import(input: CompanyMetricImportRequest): Promise<CompanyApiResult<CompanyMetricImport>>;
  };
}

function failure(message: string, status: ClientFailureState['status'] = 'operation-error', code?: string): CompanyApiResult<never> {
  return { ok: false, state: { status, message }, ...(code === undefined ? {} : { code }) };
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

function statusForCode(code: string): ClientFailureState['status'] {
  if (code === 'COMPANY_SESSION_REQUIRED') return 'disconnected';
  if (code === 'VALIDATION_ERROR' || code.endsWith('_INVALID')) return 'validation-error';
  if (code === 'COMPANY_FORBIDDEN') return 'operation-error';
  return 'operation-error';
}

async function request<T>(fetcher: FetchLike, path: string, schema: z.ZodType<T>, init: RequestInit): Promise<CompanyApiResult<T>> {
  let response: Response;
  try {
    response = await fetcher(path, init);
  } catch (error) {
    if (isAbortError(error)) return { ok: false, cancelled: true };
    return failure('无法连接公司工作区。', 'disconnected');
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (isAbortError(error)) return { ok: false, cancelled: true };
    return failure('公司服务返回了无法解析的响应。', 'validation-error');
  }
  if (!response.ok) {
    const parsed = z.object({ error: z.object({ code: z.string(), message: z.string() }).passthrough() }).safeParse(payload);
    if (!parsed.success) return failure('公司服务错误结构无法校验。', 'validation-error');
    return failure(parsed.data.error.message, statusForCode(parsed.data.error.code), parsed.data.error.code);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return failure('公司服务响应与当前客户端不兼容。', 'validation-error');
  return { ok: true, value: parsed.data };
}

async function data<T>(fetcher: FetchLike, path: string, schema: z.ZodType<Envelope & { readonly data: T }>, init: RequestInit): Promise<CompanyApiResult<T>> {
  const result = await request(fetcher, path, schema, init);
  return result.ok ? { ok: true, value: result.value.data } : result;
}

function getInit(signal?: AbortSignal): RequestInit {
  return { method: 'GET', credentials: 'same-origin', ...(signal === undefined ? {} : { signal }) };
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): CompanyApiResult<T> {
  const parsed = schema.safeParse(input);
  return parsed.success ? { ok: true, value: parsed.data } : failure('请求参数与公司服务契约不兼容。', 'validation-error');
}

function postInit(body: unknown, csrfToken?: string): RequestInit {
  return {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(csrfToken === undefined ? {} : { 'x-csrf-token': csrfToken })
    },
    body: JSON.stringify(body)
  };
}

/** Browser client for the company namespace. It never accepts arbitrary local paths as uploads. */
export function createBrowserCompanyApi(fetchImplementation?: FetchLike): CompanyApi {
  const fetcher: FetchLike = fetchImplementation ?? ((input, init) => globalThis.fetch(input, init));
  let csrfToken: string | undefined;
  let sessionInFlight: Promise<CompanyApiResult<CompanySession>> | undefined;

  const readSession = (signal?: AbortSignal): Promise<CompanyApiResult<CompanySession>> => {
    if (sessionInFlight !== undefined && signal === undefined) return sessionInFlight;
    const pending = data(fetcher, '/api/company/v1/auth/session', companySessionResponseSchema, getInit(signal)).then(result => {
      if (result.ok) csrfToken = result.value.csrfToken;
      return result;
    });
    if (signal === undefined) {
      sessionInFlight = pending;
      void pending.finally(() => { if (sessionInFlight === pending) sessionInFlight = undefined; });
    }
    return pending;
  };

  async function ensureCsrf(): Promise<CompanyApiResult<string>> {
    if (csrfToken !== undefined) return { ok: true, value: csrfToken };
    const result = await readSession();
    if (!result.ok) return result;
    csrfToken = result.value.csrfToken;
    return { ok: true, value: csrfToken };
  }

  async function mutation<T>(path: string, schema: z.ZodType<Envelope & { readonly data: T }>, body: unknown): Promise<CompanyApiResult<T>> {
    const token = await ensureCsrf();
    if (!token.ok) return token;
    const result = await data(fetcher, path, schema, postInit(body, token.value));
    if (!result.ok && !('cancelled' in result) && result.code === 'CSRF_INVALID') csrfToken = undefined;
    return result;
  }

  return {
    auth: {
      bootstrap: input => {
        const parsed = parseInput(companyBootstrapRequestSchema, input);
        if (!parsed.ok) return Promise.resolve(parsed);
        return data(fetcher, '/api/company/v1/auth/bootstrap', companyUserResponseSchema, postInit(parsed.value));
      },
      login: (displayName, password) => {
        const parsed = parseInput(companyLoginRequestSchema, { displayName, password });
        if (!parsed.ok) return Promise.resolve(parsed);
        return data(fetcher, '/api/company/v1/auth/login', companySessionResponseSchema, postInit(parsed.value)).then(result => {
        if (result.ok) csrfToken = result.value.csrfToken;
        return result;
        });
      },
      session: signal => readSession(signal),
      logout: async () => {
        const result = await mutation('/api/company/v1/auth/logout', z.object({ data: z.object({ loggedOut: z.literal(true) }), version: z.literal(1) }).strict(), {});
        if (result.ok) csrfToken = undefined;
        return result;
      }
    },
    projects: {
      list: signal => data(fetcher, '/api/company/v1/projects', companyProjectListResponseSchema, getInit(signal)),
      scan: (input, signal) => {
        const parsed = parseInput(companyProjectScanRequestSchema, input);
        if (!parsed.ok) return Promise.resolve(parsed);
        const requestInit = postInit(parsed.value, csrfToken);
        return (async () => {
          const token = await ensureCsrf();
          if (!token.ok) return token;
          return data(fetcher, '/api/company/v1/projects/scan', companyProjectScanResponseSchema, { ...requestInit, headers: { ...requestInit.headers, 'x-csrf-token': token.value }, ...(signal === undefined ? {} : { signal }) });
        })();
      },
      draft: (id, signal) => data(fetcher, `/api/company/v1/projects/drafts/${encodeURIComponent(id)}`, companyProjectDraftResponseSchema, getInit(signal)),
      confirm: (id, input) => {
        const parsed = parseInput(companyProjectConfirmRequestSchema, input);
        return parsed.ok
          ? mutation(`/api/company/v1/projects/drafts/${encodeURIComponent(id)}/confirm`, companyProjectConfirmResponseSchema, parsed.value)
          : Promise.resolve(parsed);
      },
      get: (id, signal) => data(fetcher, `/api/company/v1/projects/${encodeURIComponent(id)}`, companyProjectDetailResponseSchema, getInit(signal))
    },
    skills: {
      list: signal => data(fetcher, '/api/company/v1/skills', skillsResponseSchema, getInit(signal)),
      get: (id, signal) => {
        const parsed = parseInput(skillIdParamsSchema, { id });
        return parsed.ok
          ? data(fetcher, `/api/company/v1/skills/${encodeURIComponent(parsed.value.id)}`, skillResponseSchema, getInit(signal))
          : Promise.resolve(parsed);
      }
    },
    metrics: {
      project: (projectId, signal) => data(fetcher, `/api/company/v1/projects/${encodeURIComponent(projectId)}/metrics`, companyProjectMetricsResponseSchema, getInit(signal)),
      status: (projectId, signal) => data(
        fetcher,
        projectId === undefined
          ? '/api/company/v1/metrics/status'
          : `/api/company/v1/metrics/status?projectId=${encodeURIComponent(projectId)}`,
        companyMetricsStatusResponseSchema,
        getInit(signal)
      ),
      scan: async () => {
        const token = await ensureCsrf();
        if (!token.ok) return token;
        return data(fetcher, '/api/company/v1/metrics/scan', companyMetricScanResponseSchema, postInit({}, token.value));
      },
      import: input => {
        const parsed = parseInput(companyMetricImportRequestSchema, input);
        return parsed.ok
          ? mutation('/api/company/v1/metrics/import', companyMetricImportResponseSchema, parsed.value)
          : Promise.resolve(parsed);
      }
    }
  };
}

export const browserCompanyApi = createBrowserCompanyApi();
