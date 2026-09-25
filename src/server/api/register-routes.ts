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
  if (runtimeMode === 'personal') registerProjectRoutes(app, options.projectService, options.projectWritePlans);
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
