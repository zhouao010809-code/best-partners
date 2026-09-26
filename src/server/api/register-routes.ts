import { registerProjectCreationRoutes } from './routes/project-creations.js';
import { createCreationAssistant } from '../projects/creation-assistant.js';
import { PublicApiError } from '../../shared/api/errors.js';
import type { CreationGenerator, CreationSuggestion } from '../../shared/api/project-creations.js';
import type { FastifyInstance } from 'fastify';
import type { BuildServerOptions } from '../app.js';
import type { CompanyRuntime } from '../company/company-runtime.js';
import type { CompanyRuntimeMode } from '../../shared/company/workspace.js';
import type { HealthService } from '../services/health-service.js';
import type { IndexJobService } from '../services/index-job-service.js';
import type { createAssistantService } from '../assistant/service.js';
import type { createReadService } from '../services/read-service.js';
import { createAssistantDraftService } from '../assistant/draft-service.js';
import { registerMaterialRoutes } from './routes/materials.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerKnowledgeRoutes } from './routes/knowledge.js';
import { registerOperationRoutes } from './routes/operations.js';
import { registerIndexJobRoutes } from './routes/index-jobs.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerIntakeRoutes } from './routes/intake.js';
import { registerExtractionRoutes } from './routes/extractions.js';
import { registerIngestionRoutes } from './routes/ingestion.js';
import { registerTrashRoutes } from './routes/trash.js';
import { registerIntakeTrashRoutes } from './routes/intake-trash.js';
import { registerAssistantRoutes } from './routes/assistant.js';
import { registerAttachmentRoutes } from './routes/attachments.js';
import { registerAssistantDraftRoutes } from './routes/assistant-drafts.js';
import { registerSkillRoutes } from './routes/skills.js';
import { registerCompanyAuthRoutes } from './routes/company-auth.js';
import { registerCompanyProjectRoutes } from './routes/company-projects.js';
import { registerCompanySkillRoutes } from './routes/company-skills.js';
import { registerCompanyMetricRoutes } from './routes/company-metrics.js';
import { registerProjectRoutes } from './routes/projects.js';
import { createSkillMatcherService } from '../services/skill-matcher.js';

export interface ApplicationRouteRegistryInput {
  readonly app: FastifyInstance;
  readonly options: BuildServerOptions;
  readonly runtimeMode: CompanyRuntimeMode;
  readonly companyRuntime?: CompanyRuntime;
  readonly healthService: HealthService;
  readonly assistant?: ReturnType<typeof createAssistantService>;
  readonly readService?: ReturnType<typeof createReadService>;
  readonly indexJobs?: IndexJobService;
  readonly operationId: () => string;
}

export function registerApplicationRoutes(input: ApplicationRouteRegistryInput): void {
  const { app, options, runtimeMode, companyRuntime, healthService, assistant, readService, indexJobs, operationId } = input;
  registerHealthRoutes(app, healthService);
  registerAssistantRoutes(app, assistant);
  registerAttachmentRoutes(app, options.attachmentService);
  registerAssistantDraftRoutes(app, { ...(options.readApi ? {
    assistantDrafts: createAssistantDraftService({
      database: options.readApi.database,
      projectExists: projectId => options.readApi!.database.prepare('SELECT 1 AS present FROM personal_projects WHERE id = ?').get(projectId) !== undefined
    })
  } : {}) });
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
    intakeTrash: options.intakeTrashService ? () => options.intakeTrashService!.list() : undefined,
    projectOperations: options.projectWritePlans ? async () => {
      const projects = options.readApi?.database.prepare('SELECT id FROM personal_projects').all() as Array<{ id: string }> | undefined;
      if (!projects) return [];
      const rows = await Promise.all(projects.map(project => options.projectWritePlans!.operations(project.id)));
      return rows.flat();
    } : undefined });
  registerIndexJobRoutes(app, indexJobs);
  if (runtimeMode === 'personal') {
    registerProjectRoutes(app, options.projectService, options.projectWritePlans);
    const adapter = options.assistantAdapters?.find(value => value.id === 'deepseek');
    const creations = options.projectCreations;
    let generate: CreationGenerator | undefined;
    if (adapter && creations && options.projectService && options.projectWritePlans) {
      const writer = createCreationAssistant({ adapter, projectService: options.projectService, projectWritePlans: options.projectWritePlans, getProfileContext: projectId => creations.getProfileContext(projectId), ...(readService ? { readService } : {}) });
      const shutdown = new AbortController();
      const pending = new Map<string, Promise<CreationSuggestion>>();
      generate = (projectId, request, signal) => {
        const key = `${projectId}:${request.itemId ?? 'topics'}`;
        if (pending.has(key)) throw new PublicApiError('CREATION_BUSY', '这条内容正在生成建议，请等本次完成或停止后重试。', 409);
        if (pending.size >= 4) throw new PublicApiError('CREATION_BUSY', '当前创作任务较多，请稍后重试。', 409);
        const active = AbortSignal.any([shutdown.signal, AbortSignal.timeout(300_000), ...(signal ? [signal] : [])]);
        const done = (async () => {
          active.throwIfAborted();
          const detail = request.itemId ? await creations.get(projectId, request.itemId) : undefined;
          if (detail?.item.discardedAt) throw new PublicApiError('CREATION_DISCARDED', '这条创作已丢弃，请先恢复后再继续。', 409);
          const suggestion = await writer.generate(projectId, request, detail?.item, active, detail?.messages.filter(message => !message.dismissedAt));
          active.throwIfAborted();
          if (request.itemId) await creations.recordExchange(projectId, request.itemId, { instruction: request.instruction, suggestion });
          return suggestion;
        })();
        pending.set(key, done);
        void done.then(() => pending.delete(key), () => pending.delete(key));
        return done;
      };
      app.addHook('preClose', async () => { shutdown.abort(); await Promise.allSettled(pending.values()); });
    }
    registerProjectCreationRoutes(app, creations, generate);
  }
  if (companyRuntime !== undefined) {
    registerCompanyAuthRoutes(app, {
      auth: companyRuntime.auth,
      ...(options.companyBootstrapToken === undefined
        ? {}
        : { bootstrapToken: options.companyBootstrapToken })
    });
    registerCompanyProjectRoutes(app, { ...companyRuntime, runtime: companyRuntime });
    registerCompanySkillRoutes(app, companyRuntime);
    registerCompanyMetricRoutes(app, companyRuntime);
  }
}
