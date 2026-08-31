import { z } from 'zod';
import {
  apiFailureSchema,
  bootstrapResponseSchema,
  healthResponseSchema,
  healthSnapshotSchema,
  indexJobResponseSchema,
  indexJobSchema,
  knowledgePageResponseSchema,
  knowledgePageSchema,
  liveKnowledgeDetailResponseSchema,
  liveKnowledgeDetailSchema,
  materialPageResponseSchema,
  materialPageSchema,
  openKnowledgeResponseSchema,
  openKnowledgeResultSchema,
  operationPageResponseSchema,
  operationPageSchema
} from '../../shared/api/schemas.js';
import type { KnowledgeStatus, UsageStatus } from '../../shared/domain/records.js';
import type { PageStateValue } from '../components/PageState.js';

type ClientFailureStatus =
  | 'disconnected'
  | 'validation-error'
  | 'operation-error'
  | 'busy'
  | 'conflict'
  | 'recovery-required';

export type ClientFailureState = Extract<
  PageStateValue,
  { readonly status: ClientFailureStatus }
>;

export type ApiClientResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
    readonly ok: false;
    readonly state: ClientFailureState;
    readonly operationId?: string;
  }
  | { readonly ok: false; readonly cancelled: true };

export type MaterialPage = z.infer<typeof materialPageSchema>;
export type KnowledgePage = z.infer<typeof knowledgePageSchema>;
export type LiveKnowledgeDetail = z.infer<typeof liveKnowledgeDetailSchema>;
export type OperationPage = z.infer<typeof operationPageSchema>;
export type OpenKnowledgeResult = z.infer<typeof openKnowledgeResultSchema>;
export type IndexJob = z.infer<typeof indexJobSchema>;
export type HealthSnapshot = z.infer<typeof healthSnapshotSchema>;

export interface MaterialQuery {
  readonly status?: KnowledgeStatus;
  readonly sourcePlatform?: string;
  readonly collectedFrom?: string;
  readonly collectedTo?: string;
  readonly title?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface KnowledgeQuery {
  readonly search?: string;
  readonly includeObsolete?: boolean;
  readonly usageStatus?: UsageStatus;
  readonly knowledgeType?: string;
  readonly topic?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ReadConsoleApi {
  getHealth(signal?: AbortSignal): Promise<ApiClientResult<HealthSnapshot>>;
  listMaterials(
    query: MaterialQuery,
    signal?: AbortSignal
  ): Promise<ApiClientResult<MaterialPage>>;
  listKnowledge(
    query: KnowledgeQuery,
    signal?: AbortSignal
  ): Promise<ApiClientResult<KnowledgePage>>;
  getKnowledgeDetail(
    path: string,
    signal?: AbortSignal
  ): Promise<ApiClientResult<LiveKnowledgeDetail>>;
  listOperations(signal?: AbortSignal): Promise<ApiClientResult<OperationPage>>;
  openKnowledge(path: string): Promise<ApiClientResult<OpenKnowledgeResult>>;
  rebuildIndex(indexVersion: number, idempotencyKey: string): Promise<ApiClientResult<IndexJob>>;
  getIndexJob(id: string, signal?: AbortSignal): Promise<ApiClientResult<IndexJob>>;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface ApiRequestOptions<T> {
  readonly path: string;
  readonly schema: z.ZodType<T>;
  readonly fetcher: FetchLike;
  readonly init: RequestInit;
}

function validationFailure(message: string): ApiClientResult<never> {
  return {
    ok: false,
    state: { status: 'validation-error', message }
  };
}

function failureStatus(code: string): ClientFailureStatus {
  switch (code) {
    case 'RECOVERY_REQUIRED':
    case 'READ_API_UNAVAILABLE':
      return 'recovery-required';
    case 'VALIDATION_ERROR':
      return 'validation-error';
    case 'INDEX_BUSY':
      return 'busy';
    case 'VERSION_CONFLICT':
    case 'IDEMPOTENCY_CONFLICT':
      return 'conflict';
    default:
      return 'operation-error';
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

async function requestApi<T>(options: ApiRequestOptions<T>): Promise<ApiClientResult<T>> {
  let response: Response;
  try {
    response = await options.fetcher(options.path, options.init);
  } catch (error) {
    if (isAbortError(error)) return { ok: false, cancelled: true };
    return {
      ok: false,
      state: {
        status: 'disconnected',
        message: '无法连接本地服务。'
      }
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (isAbortError(error)) return { ok: false, cancelled: true };
    return validationFailure('服务返回了无法解析的响应。');
  }

  if (!response.ok) {
    const failure = apiFailureSchema.safeParse(payload);
    if (!failure.success) {
      return validationFailure('服务错误结构无法校验。');
    }

    const { code, message, operationId } = failure.data.error;
    return {
      ok: false,
      state: { status: failureStatus(code), message },
      operationId
    };
  }

  const parsed = options.schema.safeParse(payload);
  if (!parsed.success) {
    return validationFailure('响应结构与当前客户端不兼容。');
  }

  return { ok: true, value: parsed.data };
}

type Envelope = { readonly data: unknown };

async function requestData<S extends z.ZodType<Envelope>>(
  fetcher: FetchLike,
  path: string,
  schema: S,
  init: RequestInit
): Promise<ApiClientResult<z.output<S>['data']>> {
  const result = await requestApi({ path, schema, fetcher, init });
  if (!result.ok) return result;
  return { ok: true, value: result.value.data };
}

function getInit(signal?: AbortSignal): RequestInit {
  return {
    method: 'GET',
    credentials: 'same-origin',
    ...(signal === undefined ? {} : { signal })
  };
}

function appendQuery(
  parameters: URLSearchParams,
  key: string,
  value: string | number | boolean | undefined
): void {
  if (value !== undefined) parameters.set(key, String(value));
}

function withQuery(path: string, build: (parameters: URLSearchParams) => void): string {
  const parameters = new URLSearchParams();
  build(parameters);
  const query = parameters.toString();
  return query.length === 0 ? path : `${path}?${query}`;
}

export function createBrowserReadConsoleApi(fetchImplementation?: FetchLike): ReadConsoleApi {
  const fetcher: FetchLike = (input, init) => (
    fetchImplementation === undefined
      ? globalThis.fetch(input, init)
      : fetchImplementation(input, init)
  );
  let csrfToken: string | undefined;
  let bootstrapInFlight: Promise<ApiClientResult<string>> | undefined;

  function getCsrfToken(): Promise<ApiClientResult<string>> {
    if (csrfToken !== undefined) return Promise.resolve({ ok: true, value: csrfToken });
    if (bootstrapInFlight !== undefined) return bootstrapInFlight;

    const request = requestData(
      fetcher,
      '/api/v1/bootstrap',
      bootstrapResponseSchema,
      getInit()
    ).then((result): ApiClientResult<string> => {
      if (!result.ok) return result;
      csrfToken = result.value.csrfToken;
      return { ok: true, value: csrfToken };
    });
    bootstrapInFlight = request;
    void request.finally(() => {
      if (bootstrapInFlight === request) bootstrapInFlight = undefined;
    });
    return request;
  }

  async function postWithCsrf<S extends z.ZodType<Envelope>>(
    path: string,
    schema: S,
    body: Readonly<Record<string, unknown>>,
    idempotencyKey?: string
  ): Promise<ApiClientResult<z.output<S>['data']>> {
    const token = await getCsrfToken();
    if (!token.ok) return token;
    return requestData(fetcher, path, schema, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': token.value,
        ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey })
      },
      body: JSON.stringify(body)
    });
  }

  return {
    getHealth: (signal) => requestData(
      fetcher,
      '/api/v1/health',
      healthResponseSchema,
      getInit(signal)
    ),
    listMaterials: (query, signal) => requestData(
      fetcher,
      withQuery('/api/v1/materials', (parameters) => {
        appendQuery(parameters, 'status', query.status);
        appendQuery(parameters, 'sourcePlatform', query.sourcePlatform);
        appendQuery(parameters, 'collectedFrom', query.collectedFrom);
        appendQuery(parameters, 'collectedTo', query.collectedTo);
        appendQuery(parameters, 'title', query.title);
        appendQuery(parameters, 'cursor', query.cursor);
        appendQuery(parameters, 'limit', query.limit);
      }),
      materialPageResponseSchema,
      getInit(signal)
    ),
    listKnowledge: (query, signal) => requestData(
      fetcher,
      withQuery('/api/v1/knowledge', (parameters) => {
        appendQuery(parameters, 'search', query.search);
        appendQuery(parameters, 'includeObsolete', query.includeObsolete);
        appendQuery(parameters, 'usageStatus', query.usageStatus);
        appendQuery(parameters, 'knowledgeType', query.knowledgeType);
        appendQuery(parameters, 'topic', query.topic);
        appendQuery(parameters, 'cursor', query.cursor);
        appendQuery(parameters, 'limit', query.limit);
      }),
      knowledgePageResponseSchema,
      getInit(signal)
    ),
    getKnowledgeDetail: (path, signal) => requestData(
      fetcher,
      withQuery('/api/v1/knowledge/file', (parameters) => appendQuery(parameters, 'path', path)),
      liveKnowledgeDetailResponseSchema,
      getInit(signal)
    ),
    listOperations: (signal) => requestData(
      fetcher,
      '/api/v1/operations',
      operationPageResponseSchema,
      getInit(signal)
    ),
    openKnowledge: (path) => postWithCsrf(
      '/api/v1/knowledge/open',
      openKnowledgeResponseSchema,
      { path }
    ),
    rebuildIndex: (indexVersion, idempotencyKey) => postWithCsrf(
      '/api/v1/index-jobs/rebuild',
      indexJobResponseSchema,
      { indexVersion },
      idempotencyKey
    ),
    getIndexJob: (id, signal) => requestData(
      fetcher,
      `/api/v1/index-jobs/${encodeURIComponent(id)}`,
      indexJobResponseSchema,
      getInit(signal)
    )
  };
}

export const browserReadConsoleApi = createBrowserReadConsoleApi();
