import { z } from 'zod';
import { creativeProfileResponseSchema, type ProjectCreativeProfile, type CreativeProfileSave } from '../../shared/api/creative-profile.js';
import { creationListResponseSchema, creationDetailResponseSchema, creationSuggestionResponseSchema, creationExportResponseSchema,
  type ProjectCreation, type CreationDetail, type CreationCreate, type CreationSave, type CreationSuggestion, type CreationGenerateRequest, type CreationExport } from '../../shared/api/project-creations.js';
import { attachmentResponseSchema, attachmentPagesResponseSchema, attachmentListResponseSchema, attachmentArchiveResponseSchema, type Attachment, type AttachmentPages, type AttachmentArchiveResult } from '../../shared/api/attachments.js';
import { assistantDraftListResponseSchema, assistantDraftResponseSchema, assistantDraftDeleteResponseSchema, type AssistantDraft, type AssistantDraftList, type AssistantDraftSave, type AssistantDraftQuery } from '../../shared/api/assistant-drafts.js';
import { assistantProvidersResponseSchema, assistantConversationResponseSchema, assistantHistoryResponseSchema, assistantLoginResponseSchema,
  type AssistantProvider, type AssistantConversation, type AssistantSend, type AssistantHistoryPage, type AssistantHistoryQuery } from '../../shared/api/assistant.js';
import { libraryPageResponseSchema, type LibraryQuery, type LibraryPage } from '../../shared/api/library.js';
export type { LibraryQuery, LibraryPage } from '../../shared/api/library.js';
import { knowledgeCatalogPageResponseSchema, type KnowledgeCatalogQuery, type KnowledgeCatalogPage } from '../../shared/api/knowledge-catalog.js';
export type { KnowledgeCatalogQuery, KnowledgeCatalogPage, KnowledgeCatalogFolder } from '../../shared/api/knowledge-catalog.js';
import {
  apiFailureSchema,
  bootstrapResponseSchema,
  documentIssuePageResponseSchema,
  documentIssuePageSchema,
  liveDocumentDetailResponseSchema,
  liveDocumentDetailSchema,
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
import { intakeListResponseSchema, intakePreviewResponseSchema, intakeOutcomeResponseSchema,
  type IntakeList, type IntakePreview, type IntakePreviewRequest, type IntakeOutcome } from '../../shared/api/intake.js';
import { deepSeekSettingsResponseSchema, extractionListResponseSchema, extractionPreviewResponseSchema, extractionRunResponseSchema,
  type DeepSeekSettings, type ExtractionPreview, type ExtractionPreviewRequest, type ExtractionRun } from '../../shared/api/extraction.js';
import { extractionQueueResponseSchema, extractionHistoryResponseSchema, extractionQueueSourceResponseSchema,
  type ExtractionQueueQuery, type ExtractionQueuePage, type ExtractionHistoryQuery, type ExtractionHistoryPage, type ExtractionQueueSource } from '../../shared/api/extraction-queue.js';
import { ingestionReviewResponseSchema, reviewCandidateResponseSchema, ingestionMatchesResponseSchema, ingestionPreviewResponseSchema,
  ingestionBatchResponseSchema, ingestionRecoveryPreviewResponseSchema, type IngestionReview, type ReviewCandidate,
  type SaveCandidateRequest, type IngestionMatches, type IngestionPreviewRequest, type IngestionPreview, type IngestionBatch,
  type IngestionRecoveryPreview } from '../../shared/api/ingestion.js';
import { trashPreviewResponseSchema, trashDeletePreviewResponseSchema, trashEntryResponseSchema, trashListResponseSchema,
  type TrashPreview, type TrashDeletePreview, type TrashEntry, type TrashList } from '../../shared/api/trash.js';
import { intakeTrashPreviewResponseSchema, intakeTrashDeletePreviewResponseSchema, intakeTrashEntryResponseSchema, intakeTrashListResponseSchema,
  type IntakeTrashPreview, type IntakeTrashDeletePreview, type IntakeTrashEntry, type IntakeTrashList } from '../../shared/api/intake-trash.js';
import {
  projectFilePageResponseSchema,
  projectFileResponseSchema,
  projectListResponseSchema,
  projectOperationsResponseSchema,
  projectScanPreviewResponseSchema,
  projectSummaryResponseSchema,
  projectWriteActionResponseSchema,
  type ProjectFileDetail,
  type ProjectFilePage,
  type ProjectOperation,
  type ProjectScanPreview,
  type ProjectSummary,
  type ProjectWriteAction
} from '../../shared/api/projects.js';
import {
  skillResponseSchema,
  skillsResponseSchema,
  skillFolderResponseSchema,
  skillMoveResponseSchema,
  skillsMatchResponseSchema,
  type SkillDetail,
  type SkillsPage,
  type SkillFolder,
  type SkillSummary,
  type SkillMatchCandidate
} from '../../shared/api/skills.js';
export type { SkillDetail, SkillsPage, SkillFolder, SkillSummary } from '../../shared/api/skills.js';
export type { SkillMatchCandidate } from '../../shared/api/skills.js';

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
    readonly code?: string;
  }
  | { readonly ok: false; readonly cancelled: true };

type AssistantDraftListClient = {
  (signal?: AbortSignal, query?: AssistantDraftQuery): Promise<ApiClientResult<AssistantDraftList>>;
  /** Compatibility with the pre-query client signature. */
  (projectId?: string, signal?: AbortSignal): Promise<ApiClientResult<AssistantDraftList>>;
};

export type MaterialPage = z.infer<typeof materialPageSchema>;
export type BootstrapData = z.infer<typeof bootstrapResponseSchema>['data'];
export type KnowledgePage = z.infer<typeof knowledgePageSchema>;
export type LiveKnowledgeDetail = z.infer<typeof liveKnowledgeDetailSchema>;
export type OperationPage = z.infer<typeof operationPageSchema>;
export type OpenKnowledgeResult = z.infer<typeof openKnowledgeResultSchema>;
export type IndexJob = z.infer<typeof indexJobSchema>;
export type HealthSnapshot = z.infer<typeof healthSnapshotSchema>;
export type DocumentIssuePage = z.infer<typeof documentIssuePageSchema>;
export type LiveDocumentDetail = z.infer<typeof liveDocumentDetailSchema>;

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
  readonly creations?: {
    getProfile?(projectId: string, signal?: AbortSignal): Promise<ApiClientResult<ProjectCreativeProfile>>;
    saveProfile?(projectId: string, input: CreativeProfileSave): Promise<ApiClientResult<ProjectCreativeProfile>>;
    list(projectId: string, signal?: AbortSignal): Promise<ApiClientResult<{ items: ProjectCreation[] }>>;
    get(projectId: string, id: string, signal?: AbortSignal): Promise<ApiClientResult<CreationDetail>>;
    create(projectId: string, input: CreationCreate): Promise<ApiClientResult<CreationDetail>>;
    save(projectId: string, id: string, input: CreationSave): Promise<ApiClientResult<CreationDetail>>;
    snapshot(projectId: string, id: string, input: { expectedRevision: number; finalize: boolean }): Promise<ApiClientResult<CreationDetail>>;
    exportVersion(projectId: string, id: string, versionId: string): Promise<ApiClientResult<CreationExport>>;
    suggest(projectId: string, input: CreationGenerateRequest, signal?: AbortSignal): Promise<ApiClientResult<CreationSuggestion>>;
  };
  readonly skills?: {
    list(signal?: AbortSignal): Promise<ApiClientResult<SkillsPage>>;
    get(id: string, signal?: AbortSignal): Promise<ApiClientResult<SkillDetail>>;
    match?(message: string, signal?: AbortSignal): Promise<ApiClientResult<{ candidates: SkillMatchCandidate[] }>>;
    createFolder?(name: string, signal?: AbortSignal): Promise<ApiClientResult<SkillFolder>>;
    move?(id: string, folderId: string | null, signal?: AbortSignal): Promise<ApiClientResult<SkillSummary>>;
  };
  attachments?: {
    list(signal?: AbortSignal): Promise<ApiClientResult<{ attachments: Attachment[] }>>;
    archive(id: string, fields?: Partial<IntakePreviewRequest['fields']>): Promise<ApiClientResult<{ result: AttachmentArchiveResult }>>;
    upload(file: File, uploadId: string, groupId: string, signal?: AbortSignal): Promise<ApiClientResult<{ attachment: Attachment }>>;
    get(id: string, signal?: AbortSignal): Promise<ApiClientResult<{ attachment: Attachment }>>;
    pages(id: string, startPage?: number, endPage?: number, signal?: AbortSignal): Promise<ApiClientResult<AttachmentPages>>;
    retry(id: string): Promise<ApiClientResult<{ attachment: Attachment }>>;
    cancel(id: string): Promise<ApiClientResult<{ attachment: Attachment }>>;
  };
  assistantDrafts?: {
    list: AssistantDraftListClient;
    save(id: string, input: AssistantDraftSave, signal?: AbortSignal): Promise<ApiClientResult<{ draft: AssistantDraft }>>;
    delete(id: string, revision: number, signal?: AbortSignal): Promise<ApiClientResult<{ deleted: true }>>;
  };
  readonly projects?: {
    scan(rootPath: string): Promise<ApiClientResult<ProjectScanPreview>>;
    bind(input: { scanId: string; sourceSha256: string; displayName?: string }): Promise<ApiClientResult<ProjectSummary>>;
    reconnect(id: string, input: { scanId: string; sourceSha256: string; displayName?: string }): Promise<ApiClientResult<ProjectSummary>>;
    list(signal?: AbortSignal): Promise<ApiClientResult<{ projects: ProjectSummary[] }>>;
    get(id: string, signal?: AbortSignal): Promise<ApiClientResult<ProjectSummary>>;
    refresh(id: string): Promise<ApiClientResult<ProjectSummary>>;
    files(id: string, query: { search?: string; origin?: 'source' | 'output'; limit?: number }, signal?: AbortSignal): Promise<ApiClientResult<ProjectFilePage>>;
    file(id: string, relativePath: string, signal?: AbortSignal): Promise<ApiClientResult<ProjectFileDetail>>;
    operations(id: string, signal?: AbortSignal): Promise<ApiClientResult<{ operations: ProjectOperation[] }>>;
    confirmWritePlan(projectId: string, planId: string, clientRequestId: string): Promise<ApiClientResult<ProjectWriteAction>>;
    cancelWritePlan(projectId: string, planId: string, clientRequestId: string): Promise<ApiClientResult<ProjectWriteAction>>;
  };
  readonly assistant?: {
    providers(signal?: AbortSignal): Promise<ApiClientResult<{ providers: AssistantProvider[] }>>;
    history(signal?: AbortSignal, query?: AssistantHistoryQuery): Promise<ApiClientResult<AssistantHistoryPage>>;
    get(id: string, signal?: AbortSignal): Promise<ApiClientResult<AssistantConversation>>;
    send(input: AssistantSend): Promise<ApiClientResult<AssistantConversation>>;
    stop(id: string): Promise<ApiClientResult<AssistantConversation>>;
    confirmAction(id: string, clientRequestId: string): Promise<ApiClientResult<AssistantConversation>>;
    cancelAction(id: string, clientRequestId: string): Promise<ApiClientResult<AssistantConversation>>;
    login(providerId: string): Promise<ApiClientResult<{ authUrl?: string | undefined; message: string }>>;
  };
  listKnowledgeCatalog?(query: KnowledgeCatalogQuery, signal?: AbortSignal): Promise<ApiClientResult<KnowledgeCatalogPage>>;
  listLibrary(query: LibraryQuery, signal?: AbortSignal): Promise<ApiClientResult<LibraryPage>>;
  readonly trash?: {
    list(signal?: AbortSignal): Promise<ApiClientResult<TrashList>>;
    get(id: string, signal?: AbortSignal): Promise<ApiClientResult<TrashEntry>>;
    preview(materialPath: string, origin?: 'library' | 'queue' | 'knowledge'): Promise<ApiClientResult<TrashPreview>>;
    commit(id: string): Promise<ApiClientResult<TrashEntry>>;
    restore(id: string): Promise<ApiClientResult<TrashEntry>>;
    retry(id: string): Promise<ApiClientResult<TrashEntry>>;
    previewDelete(id: string, signal?: AbortSignal): Promise<ApiClientResult<TrashDeletePreview>>;
    delete(id: string, token: string): Promise<ApiClientResult<TrashEntry>>;
  };
  readonly ingestion?: {
    review(runId: string, signal?: AbortSignal): Promise<ApiClientResult<IngestionReview>>;
    save(runId: string, input: SaveCandidateRequest): Promise<ApiClientResult<ReviewCandidate>>;
    matches(runId: string, candidateId: string, search?: string, signal?: AbortSignal): Promise<ApiClientResult<IngestionMatches>>;
    preview(input: IngestionPreviewRequest): Promise<ApiClientResult<IngestionPreview>>;
    commit(id: string): Promise<ApiClientResult<IngestionBatch>>;
    batch(id: string, signal?: AbortSignal): Promise<ApiClientResult<IngestionBatch>>;
    resume(id: string): Promise<ApiClientResult<IngestionBatch>>;
    recoveryPreview(id: string, sourceChoice?: 'current' | 'preserved', newTargets?: Record<string, string>): Promise<ApiClientResult<IngestionRecoveryPreview>>;
    resolve(id: string): Promise<ApiClientResult<IngestionBatch>>;
  };
  readonly extractionQueue?: {
    setVisibility?(materialPath: string, removed: boolean): Promise<ApiClientResult<ExtractionQueueSource>>;
    get(materialPath: string, signal?: AbortSignal): Promise<ApiClientResult<ExtractionQueueSource>>;
    list(query: ExtractionQueueQuery, signal?: AbortSignal): Promise<ApiClientResult<ExtractionQueuePage>>;
    history(query: ExtractionHistoryQuery, signal?: AbortSignal): Promise<ApiClientResult<ExtractionHistoryPage>>;
  };
  readonly deepSeek?: {
    get(signal?: AbortSignal): Promise<ApiClientResult<DeepSeekSettings>>;
    setKey(apiKey: string): Promise<ApiClientResult<DeepSeekSettings>>;
    clearKey(): Promise<ApiClientResult<DeepSeekSettings>>;
    verifyConnection?(): Promise<ApiClientResult<DeepSeekSettings>>;
  };
  readonly extraction?: {
    list(materialPath?: string, signal?: AbortSignal): Promise<ApiClientResult<{ items: ExtractionRun[] }>>;
    get(id: string, signal?: AbortSignal): Promise<ApiClientResult<ExtractionRun>>;
    preview(input: ExtractionPreviewRequest): Promise<ApiClientResult<ExtractionPreview>>;
    start(token: string): Promise<ApiClientResult<ExtractionRun>>;
    cancel(id: string): Promise<ApiClientResult<ExtractionRun>>;
  };
  readonly intake?: {
    list(signal?: AbortSignal): Promise<ApiClientResult<IntakeList>>;
    preview(input: IntakePreviewRequest): Promise<ApiClientResult<IntakePreview>>;
    commit(token: string): Promise<ApiClientResult<IntakeOutcome>>;
    resume(id: string): Promise<ApiClientResult<IntakeOutcome>>;
  };
  readonly intakeTrash?: {
    list(signal?: AbortSignal): Promise<ApiClientResult<IntakeTrashList>>;
    get(id: string, signal?: AbortSignal): Promise<ApiClientResult<IntakeTrashEntry>>;
    preview(name: string, signal?: AbortSignal): Promise<ApiClientResult<IntakeTrashPreview>>;
    commit(id: string): Promise<ApiClientResult<IntakeTrashEntry>>;
    restore(id: string): Promise<ApiClientResult<IntakeTrashEntry>>;
    retry(id: string): Promise<ApiClientResult<IntakeTrashEntry>>;
    previewDelete(id: string, signal?: AbortSignal): Promise<ApiClientResult<IntakeTrashDeletePreview>>;
    delete(id: string, token: string): Promise<ApiClientResult<IntakeTrashEntry>>;
  };
  listDocumentIssues(query: { cursor?: string; limit?: number }, signal?: AbortSignal): Promise<ApiClientResult<DocumentIssuePage>>;
  getDocumentDetail(path: string, signal?: AbortSignal): Promise<ApiClientResult<LiveDocumentDetail>>;
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
  listOperations(signal?: AbortSignal, query?: import('../../shared/api/schemas.js').OperationQuery): Promise<ApiClientResult<OperationPage>>;
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
    case 'ASSISTANT_DRAFT_CONFLICT':
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
      operationId,
      ...(options.path.startsWith('/api/v1/assistant/') || options.path.startsWith('/api/v1/ingestion/') || options.path.startsWith('/api/v1/trash') || options.path.startsWith('/api/v1/intake-trash') || options.path.startsWith('/api/v1/skills') || options.path.startsWith('/api/v1/projects') || options.path.startsWith('/api/v1/knowledge/') && ['KNOWLEDGE_IN_TRASH', 'KNOWLEDGE_DELETED'].includes(code) || ['SESSION_REQUIRED', 'CSRF_INVALID'].includes(code) ? { code } : {})
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

export function createBrowserReadConsoleApi(fetchImplementation?: FetchLike, initialBootstrap?: BootstrapData): ReadConsoleApi {
  const fetcher: FetchLike = (input, init) => (
    fetchImplementation === undefined
      ? globalThis.fetch(input, init)
      : fetchImplementation(input, init)
  );
  let csrfToken: string | undefined = initialBootstrap?.csrfToken;
  let bootstrapInFlight: Promise<ApiClientResult<string>> | undefined;

  async function getCsrfToken(signal?: AbortSignal): Promise<ApiClientResult<string>> {
    if (signal?.aborted) return { ok: false, cancelled: true };
    if (csrfToken !== undefined) return { ok: true, value: csrfToken };
    if (bootstrapInFlight !== undefined) {
      const result = await bootstrapInFlight;
      return signal?.aborted ? { ok: false, cancelled: true } : result;
    }

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
    const result = await request;
    return signal?.aborted ? { ok: false, cancelled: true } : result;
  }

  async function postWithCsrf<S extends z.ZodType<Envelope>>(
    path: string,
    schema: S,
    body: Readonly<Record<string, unknown>>,
    idempotencyKey?: string,
    signal?: AbortSignal,
    refreshedAuthentication = false
  ): Promise<ApiClientResult<z.output<S>['data']>> {
    const token = await getCsrfToken(signal);
    if (!token.ok) return token;
    const result = await requestData(fetcher, path, schema, {
      method: 'POST',
      credentials: 'same-origin',
      ...(signal === undefined ? {} : { signal }),
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': token.value,
        ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey })
      },
      body: JSON.stringify(body)
    });
    // These two failures are produced before route handlers execute. Reconnect
    // once without ever replaying a request whose mutation outcome is unknown.
    if (!refreshedAuthentication && !result.ok && 'code' in result
      && (result.code === 'SESSION_REQUIRED' || result.code === 'CSRF_INVALID')) {
      if (csrfToken === token.value) csrfToken = undefined;
      if (signal?.aborted) return { ok: false, cancelled: true };
      return postWithCsrf(path, schema, body, idempotencyKey, signal, true);
    }
    return result;
  }

  async function writeWithCsrf<S extends z.ZodType<Envelope>>(path: string, schema: S, method: 'POST' | 'PUT' | 'DELETE', body?: BodyInit, contentType = 'application/json', signal?: AbortSignal, refreshed = false): Promise<ApiClientResult<z.output<S>['data']>> {
    const token = await getCsrfToken(signal); if (!token.ok) return token;
    const result = await requestData(fetcher, path, schema, { method, credentials: 'same-origin', ...(signal === undefined ? {} : { signal }), headers: { ...(body === undefined ? {} : { 'content-type': contentType }), 'x-csrf-token': token.value }, ...(body === undefined ? {} : { body }) });
    if (!refreshed && !result.ok && 'code' in result && (result.code === 'SESSION_REQUIRED' || result.code === 'CSRF_INVALID')) {
      if (csrfToken === token.value) csrfToken = undefined;
      if (signal?.aborted) return { ok: false, cancelled: true };
      return writeWithCsrf(path, schema, method, body, contentType, signal, true);
    }
    return result;
  }

  const creationsPath = (projectId: string, id?: string) => `/api/v1/projects/${encodeURIComponent(projectId)}/creations${id ? `/${encodeURIComponent(id)}` : ''}`;
  return {
    creations: {
      getProfile: (p, signal) => requestData(fetcher, `/api/v1/projects/${encodeURIComponent(p)}/creative-profile`, creativeProfileResponseSchema, getInit(signal)),
      saveProfile: (p, input) => writeWithCsrf(`/api/v1/projects/${encodeURIComponent(p)}/creative-profile`, creativeProfileResponseSchema, 'PUT', JSON.stringify(input)),
      list: (p, signal) => requestData(fetcher, creationsPath(p), creationListResponseSchema, getInit(signal)),
      get: (p, id, signal) => requestData(fetcher, creationsPath(p, id), creationDetailResponseSchema, getInit(signal)),
      create: (p, input) => postWithCsrf(creationsPath(p), creationDetailResponseSchema, input),
      save: (p, id, input) => writeWithCsrf(creationsPath(p, id), creationDetailResponseSchema, 'PUT', JSON.stringify(input)),
      snapshot: (p, id, input) => postWithCsrf(`${creationsPath(p, id)}/versions`, creationDetailResponseSchema, input),
      exportVersion: (p, id, versionId) => postWithCsrf(`${creationsPath(p, id)}/versions/${encodeURIComponent(versionId)}/export`, creationExportResponseSchema, {}),
      suggest: (p, input, signal) => postWithCsrf(`/api/v1/projects/${encodeURIComponent(p)}/creation-suggestions`, creationSuggestionResponseSchema, input, undefined, signal)
    },
    skills: {
      list: signal => requestData(fetcher, '/api/v1/skills', skillsResponseSchema, getInit(signal)),
      get: (id, signal) => requestData(fetcher, `/api/v1/skills/${encodeURIComponent(id)}`, skillResponseSchema, getInit(signal)),
      match: (message, signal) => postWithCsrf('/api/v1/skills/match', skillsMatchResponseSchema, { message }, undefined, signal),
      createFolder: (name, signal) => postWithCsrf('/api/v1/skills/folders', skillFolderResponseSchema, { name }, undefined, signal),
      move: (id, folderId, signal) => postWithCsrf(`/api/v1/skills/${encodeURIComponent(id)}/move`, skillMoveResponseSchema, { folderId }, undefined, signal)
    },
    attachments: {
      list: signal => requestData(fetcher, '/api/v1/assistant/attachments', attachmentListResponseSchema, getInit(signal)),
      archive: (id, fields) => postWithCsrf(`/api/v1/assistant/attachments/${encodeURIComponent(id)}/archive`, attachmentArchiveResponseSchema, fields ? { fields } : {}),
      upload: (file, uploadId, groupId, signal) => writeWithCsrf(withQuery('/api/v1/assistant/attachments', parameters => { parameters.set('name', file.name); parameters.set('uploadId', uploadId); parameters.set('groupId', groupId); }), attachmentResponseSchema, 'POST', file, 'application/octet-stream', signal),
      get: (id, signal) => requestData(fetcher, `/api/v1/assistant/attachments/${encodeURIComponent(id)}`, attachmentResponseSchema, getInit(signal)),
      pages: (id, startPage, endPage, signal) => requestData(fetcher, withQuery(`/api/v1/assistant/attachments/${encodeURIComponent(id)}/pages`, parameters => { appendQuery(parameters, 'startPage', startPage); appendQuery(parameters, 'endPage', endPage); }), attachmentPagesResponseSchema, getInit(signal)),
      retry: id => postWithCsrf(`/api/v1/assistant/attachments/${encodeURIComponent(id)}/retry`, attachmentResponseSchema, {}),
      cancel: id => postWithCsrf(`/api/v1/assistant/attachments/${encodeURIComponent(id)}/cancel`, attachmentResponseSchema, {})
    },
    projects: {
      scan: rootPath => postWithCsrf('/api/v1/projects/scan', projectScanPreviewResponseSchema, { rootPath }),
      bind: input => postWithCsrf('/api/v1/projects', projectSummaryResponseSchema, input),
      reconnect: (id, input) => postWithCsrf(`/api/v1/projects/${encodeURIComponent(id)}/reconnect`, projectSummaryResponseSchema, input),
      list: signal => requestData(fetcher, '/api/v1/projects', projectListResponseSchema, getInit(signal)),
      get: (id, signal) => requestData(fetcher, `/api/v1/projects/${encodeURIComponent(id)}`, projectSummaryResponseSchema, getInit(signal)),
      refresh: id => postWithCsrf(`/api/v1/projects/${encodeURIComponent(id)}/refresh`, projectSummaryResponseSchema, {}),
      files: (id, query, signal) => requestData(fetcher, withQuery(`/api/v1/projects/${encodeURIComponent(id)}/files`, parameters => {
        appendQuery(parameters, 'search', query.search);
        appendQuery(parameters, 'origin', query.origin);
        appendQuery(parameters, 'limit', query.limit);
      }), projectFilePageResponseSchema, getInit(signal)),
      file: (id, relativePath, signal) => requestData(fetcher, withQuery(`/api/v1/projects/${encodeURIComponent(id)}/file`, parameters => {
        parameters.set('path', relativePath);
      }), projectFileResponseSchema, getInit(signal)),
      operations: (id, signal) => requestData(fetcher, `/api/v1/projects/${encodeURIComponent(id)}/operations`, projectOperationsResponseSchema, getInit(signal)),
      confirmWritePlan: (projectId, planId, clientRequestId) => postWithCsrf(
        `/api/v1/projects/${encodeURIComponent(projectId)}/write-plans/${encodeURIComponent(planId)}/confirm`,
        projectWriteActionResponseSchema,
        { clientRequestId },
        clientRequestId
      ),
      cancelWritePlan: (projectId, planId, clientRequestId) => postWithCsrf(
        `/api/v1/projects/${encodeURIComponent(projectId)}/write-plans/${encodeURIComponent(planId)}/cancel`,
        projectWriteActionResponseSchema,
        { clientRequestId },
        clientRequestId
      )
    },
    assistantDrafts: {
      list: ((first?: string | AbortSignal, second?: AbortSignal | AssistantDraftQuery) => {
        const projectId = typeof first === 'string'
          ? first
          : second !== undefined && !(second instanceof AbortSignal) ? second.projectId : undefined;
        const signal = typeof first === 'string'
          ? (second instanceof AbortSignal ? second : undefined)
          : first instanceof AbortSignal ? first : undefined;
        return requestData(fetcher, withQuery('/api/v1/assistant/drafts', parameters => {
          appendQuery(parameters, 'projectId', projectId);
        }), assistantDraftListResponseSchema, getInit(signal));
      }) as AssistantDraftListClient,
      save: (id, input, signal) => writeWithCsrf(`/api/v1/assistant/drafts/${encodeURIComponent(id)}`, assistantDraftResponseSchema, 'PUT', JSON.stringify(input), 'application/json', signal),
      delete: (id, revision, signal) => writeWithCsrf(`/api/v1/assistant/drafts/${encodeURIComponent(id)}?revision=${revision}`, assistantDraftDeleteResponseSchema, 'DELETE', undefined, 'application/json', signal)
    },
    assistant: {
      providers: (signal) => requestData(fetcher, '/api/v1/assistant/providers', assistantProvidersResponseSchema, getInit(signal)),
      history: (signal, query = {}) => requestData(fetcher, withQuery('/api/v1/assistant/conversations', parameters => {
        appendQuery(parameters, 'search', query.search); appendQuery(parameters, 'projectId', query.projectId); appendQuery(parameters, 'cursor', query.cursor); appendQuery(parameters, 'limit', query.limit);
      }), assistantHistoryResponseSchema, getInit(signal)),
      get: (id, signal) => requestData(fetcher, `/api/v1/assistant/conversations/${encodeURIComponent(id)}`, assistantConversationResponseSchema, getInit(signal)),
      send: (input) => postWithCsrf('/api/v1/assistant/messages', assistantConversationResponseSchema, input),
      stop: (id) => postWithCsrf(`/api/v1/assistant/conversations/${encodeURIComponent(id)}/stop`, assistantConversationResponseSchema, {}),
      confirmAction: (id, clientRequestId) => postWithCsrf(`/api/v1/assistant/action-plans/${encodeURIComponent(id)}/confirm`, assistantConversationResponseSchema, { clientRequestId }, clientRequestId),
      cancelAction: (id, clientRequestId) => postWithCsrf(`/api/v1/assistant/action-plans/${encodeURIComponent(id)}/cancel`, assistantConversationResponseSchema, { clientRequestId }, clientRequestId),
      login: (id) => postWithCsrf(`/api/v1/assistant/providers/${encodeURIComponent(id)}/login`, assistantLoginResponseSchema, {})
    },
    trash: {
      list: (signal) => requestData(fetcher, '/api/v1/trash', trashListResponseSchema, getInit(signal)),
      get: (id, signal) => requestData(fetcher, `/api/v1/trash/${encodeURIComponent(id)}`, trashEntryResponseSchema, getInit(signal)),
      preview: (materialPath, origin) => postWithCsrf('/api/v1/trash/preview', trashPreviewResponseSchema, { materialPath, ...(origin ? { origin } : {}) }),
      commit: (id) => postWithCsrf('/api/v1/trash/commit', trashEntryResponseSchema, { id }),
      restore: (id) => postWithCsrf(`/api/v1/trash/${encodeURIComponent(id)}/restore`, trashEntryResponseSchema, {}),
      retry: (id) => postWithCsrf(`/api/v1/trash/${encodeURIComponent(id)}/retry`, trashEntryResponseSchema, {}),
      previewDelete: (id, signal) => postWithCsrf(`/api/v1/trash/${encodeURIComponent(id)}/delete-preview`, trashDeletePreviewResponseSchema, {}, undefined, signal),
      delete: (id, token) => postWithCsrf(`/api/v1/trash/${encodeURIComponent(id)}/delete`, trashEntryResponseSchema, { token })
    },
    ingestion: {
      review: (id, signal) => requestData(fetcher, `/api/v1/ingestion/reviews/${encodeURIComponent(id)}`, ingestionReviewResponseSchema, getInit(signal)),
      save: (id, input) => postWithCsrf(`/api/v1/ingestion/reviews/${encodeURIComponent(id)}/candidates`, reviewCandidateResponseSchema, input),
      matches: (id, candidateId, search, signal) => requestData(fetcher, withQuery(`/api/v1/ingestion/reviews/${encodeURIComponent(id)}/matches`, (parameters) => {
        appendQuery(parameters, 'candidateId', candidateId); appendQuery(parameters, 'search', search);
      }), ingestionMatchesResponseSchema, getInit(signal)),
      preview: (input) => postWithCsrf('/api/v1/ingestion/previews', ingestionPreviewResponseSchema, input),
      commit: (id) => postWithCsrf('/api/v1/ingestion/commit', ingestionBatchResponseSchema, { id }),
      batch: (id, signal) => requestData(fetcher, `/api/v1/ingestion/batches/${encodeURIComponent(id)}`, ingestionBatchResponseSchema, getInit(signal)),
      resume: (id) => postWithCsrf(`/api/v1/ingestion/batches/${encodeURIComponent(id)}/resume`, ingestionBatchResponseSchema, {}),
      recoveryPreview: (id, sourceChoice, newTargets) => postWithCsrf(`/api/v1/ingestion/batches/${encodeURIComponent(id)}/recovery-preview`, ingestionRecoveryPreviewResponseSchema, { ...(sourceChoice ? { sourceChoice } : {}), ...(newTargets ? { newTargets } : {}) }),
      resolve: (id) => postWithCsrf('/api/v1/ingestion/resolve', ingestionBatchResponseSchema, { id })
    },
    extractionQueue: {
      setVisibility: (materialPath, removed) => postWithCsrf('/api/v1/extraction-queue/visibility', extractionQueueSourceResponseSchema, { materialPath, removed }),
      get: (materialPath, signal) => requestData(fetcher, withQuery('/api/v1/extraction-queue/source', (parameters) => appendQuery(parameters, 'materialPath', materialPath)), extractionQueueSourceResponseSchema, getInit(signal)),
      list: (query, signal) => requestData(fetcher, withQuery('/api/v1/extraction-queue', (parameters) => {
        for (const [key, value] of Object.entries(query)) appendQuery(parameters, key, value);
      }), extractionQueueResponseSchema, getInit(signal)),
      history: (query, signal) => requestData(fetcher, withQuery('/api/v1/extraction-history', (parameters) => {
        for (const [key, value] of Object.entries(query)) appendQuery(parameters, key, value);
      }), extractionHistoryResponseSchema, getInit(signal))
    },
    deepSeek: {
      get: (signal) => requestData(fetcher, '/api/v1/deepseek', deepSeekSettingsResponseSchema, getInit(signal)),
      setKey: (apiKey) => postWithCsrf('/api/v1/deepseek/key', deepSeekSettingsResponseSchema, { apiKey }),
      clearKey: () => postWithCsrf('/api/v1/deepseek/clear', deepSeekSettingsResponseSchema, {}),
      verifyConnection: () => postWithCsrf('/api/v1/deepseek/verify', deepSeekSettingsResponseSchema, {})
    },
    extraction: {
      list: (materialPath, signal) => requestData(fetcher, withQuery('/api/v1/extractions', (parameters) => appendQuery(parameters, 'materialPath', materialPath)), extractionListResponseSchema, getInit(signal)),
      get: (id, signal) => requestData(fetcher, `/api/v1/extractions/${encodeURIComponent(id)}`, extractionRunResponseSchema, getInit(signal)),
      preview: (input) => postWithCsrf('/api/v1/extractions/preview', extractionPreviewResponseSchema, input),
      start: (token) => postWithCsrf('/api/v1/extractions/start', extractionRunResponseSchema, { token }),
      cancel: (id) => postWithCsrf(`/api/v1/extractions/${encodeURIComponent(id)}/cancel`, extractionRunResponseSchema, {})
    },
    intakeTrash: {
      list: signal => requestData(fetcher, '/api/v1/intake-trash', intakeTrashListResponseSchema, getInit(signal)),
      get: (id, signal) => requestData(fetcher, `/api/v1/intake-trash/${encodeURIComponent(id)}`, intakeTrashEntryResponseSchema, getInit(signal)),
      preview: (name, signal) => postWithCsrf('/api/v1/intake-trash/preview', intakeTrashPreviewResponseSchema, { name }, undefined, signal),
      commit: id => postWithCsrf(`/api/v1/intake-trash/${encodeURIComponent(id)}/commit`, intakeTrashEntryResponseSchema, {}),
      restore: id => postWithCsrf(`/api/v1/intake-trash/${encodeURIComponent(id)}/restore`, intakeTrashEntryResponseSchema, {}),
      retry: id => postWithCsrf(`/api/v1/intake-trash/${encodeURIComponent(id)}/retry`, intakeTrashEntryResponseSchema, {}),
      previewDelete: (id, signal) => postWithCsrf(`/api/v1/intake-trash/${encodeURIComponent(id)}/delete-preview`, intakeTrashDeletePreviewResponseSchema, {}, undefined, signal),
      delete: (id, token) => postWithCsrf(`/api/v1/intake-trash/${encodeURIComponent(id)}/delete`, intakeTrashEntryResponseSchema, { token })
    },
    intake: {
      list: (signal) => requestData(fetcher, '/api/v1/intake', intakeListResponseSchema, getInit(signal)),
      preview: (input) => postWithCsrf('/api/v1/intake/preview', intakePreviewResponseSchema, input),
      commit: (token) => postWithCsrf('/api/v1/intake/commit', intakeOutcomeResponseSchema, { token }),
      resume: (id) => postWithCsrf('/api/v1/intake/resume', intakeOutcomeResponseSchema, { id })
    },
    getHealth: (signal) => requestData(
      fetcher,
      '/api/v1/health',
      healthResponseSchema,
      getInit(signal)
    ),
    listLibrary: (query, signal) => requestData(
      fetcher,
      withQuery('/api/v1/library', (parameters) => {
        appendQuery(parameters, 'mode', query.mode);
        appendQuery(parameters, 'path', query.path);
        appendQuery(parameters, 'status', query.status);
        appendQuery(parameters, 'title', query.title);
        appendQuery(parameters, 'cursor', query.cursor);
        appendQuery(parameters, 'limit', query.limit);
      }),
      libraryPageResponseSchema,
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
    listKnowledgeCatalog: (query, signal) => requestData(
      fetcher,
      withQuery('/api/v1/knowledge/catalog', (parameters) => {
        appendQuery(parameters, 'path', query.path);
        appendQuery(parameters, 'search', query.search);
        appendQuery(parameters, 'includeObsolete', query.includeObsolete);
        appendQuery(parameters, 'usageStatus', query.usageStatus);
        appendQuery(parameters, 'knowledgeType', query.knowledgeType);
        appendQuery(parameters, 'topic', query.topic);
        appendQuery(parameters, 'cursor', query.cursor);
        appendQuery(parameters, 'limit', query.limit);
      }),
      knowledgeCatalogPageResponseSchema,
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
    listDocumentIssues: (query, signal) => requestData(
      fetcher,
      withQuery('/api/v1/documents/issues', (parameters) => {
        appendQuery(parameters, 'cursor', query.cursor);
        appendQuery(parameters, 'limit', query.limit);
      }),
      documentIssuePageResponseSchema,
      getInit(signal)
    ),
    getDocumentDetail: (path, signal) => requestData(
      fetcher,
      withQuery('/api/v1/documents/file', (parameters) => parameters.set('path', path)),
      liveDocumentDetailResponseSchema,
      getInit(signal)
    ),
    listOperations: (signal, query = {}) => requestData(
      fetcher,
      withQuery('/api/v1/operations', (parameters) => {
        appendQuery(parameters, 'view', query.view);
        appendQuery(parameters, 'cursor', query.cursor);
        appendQuery(parameters, 'limit', query.limit);
      }),
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
