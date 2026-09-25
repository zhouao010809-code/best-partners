import type Database from 'better-sqlite3';
import type { AssistantAdapter } from '../assistant/types.js';
import type { AttachmentService } from '../attachments/service.js';
import type { CompanyRuntime } from '../company/company-runtime.js';
import type { IndexRepository } from '../index/index-repository.js';
import type { IndexSchedulerPort } from '../services/index-job-service.js';
import type { ExtractionService } from '../services/extraction-service.js';
import type { HealthService } from '../services/health-service.js';
import type { IngestionService } from '../ingestion/ingestion-service.js';
import type { IntakeService } from '../services/intake-service.js';
import type { IntakeTrashService } from '../trash/intake-trash-service.js';
import type { OpenableVaultGateway } from '../vault/VaultGateway.js';
import type { ProjectService, ProjectWritePlanService } from '../../shared/api/projects.js';
import type { SkillCatalogService } from '../services/skill-catalog.js';
import type { TrashService } from '../trash/trash-service.js';

export interface RuntimeReadCapabilities {
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

export interface RuntimePersonalCapabilities {
  readonly attachmentService?: AttachmentService;
  readonly extractionService?: ExtractionService;
  readonly ingestionService?: IngestionService;
  readonly intakeService?: IntakeService;
  readonly intakeTrashService?: IntakeTrashService;
  readonly trashService?: TrashService;
  readonly skillCatalog?: SkillCatalogService;
  readonly projectService?: ProjectService;
  readonly projectWritePlans?: ProjectWritePlanService;
}

export interface RuntimeAssistantCapabilities {
  readonly adapters: AssistantAdapter[];
}

export interface RuntimeCompanyCapabilities {
  readonly runtime: CompanyRuntime;
  readonly bootstrapToken?: string;
}

export interface RuntimeCapabilities {
  readonly health: HealthService;
  readonly read?: RuntimeReadCapabilities;
  readonly personal?: RuntimePersonalCapabilities;
  readonly assistant?: RuntimeAssistantCapabilities;
  readonly company?: RuntimeCompanyCapabilities;
}

export interface RuntimeCapabilityHost {
  readonly capabilities?: RuntimeCapabilities;
  readonly runtimeMode?: 'personal' | 'company';
  readonly companyRuntime?: CompanyRuntime;
  readonly companyBootstrapToken?: string;
  readonly assistantAdapters?: AssistantAdapter[];
  readonly attachmentService?: AttachmentService;
  readonly trashService?: TrashService;
  readonly ingestionService?: IngestionService;
  readonly extractionService?: ExtractionService;
  readonly intakeService?: IntakeService;
  readonly intakeTrashService?: IntakeTrashService;
  readonly healthService?: HealthService;
  readonly readApi?: RuntimeReadCapabilities;
  readonly skillCatalog?: SkillCatalogService;
  readonly projectService?: ProjectService;
  readonly projectWritePlans?: ProjectWritePlanService;
}

/**
 * Converts the explicit capability object to the legacy BuildServerOptions
 * shape. Keeping this adapter at the boundary lets existing callers migrate
 * incrementally without exposing concrete services to new composition code.
 */
export function applyRuntimeCapabilities<T extends RuntimeCapabilityHost>(options: T): T {
  const capabilities = options.capabilities;
  if (capabilities === undefined) return options;
  const personal = capabilities.personal;
  const company = capabilities.company;
  return {
    ...options,
    capabilities: undefined,
    runtimeMode: company === undefined ? 'personal' : 'company',
    companyRuntime: company?.runtime,
    companyBootstrapToken: company?.bootstrapToken,
    healthService: capabilities.health,
    readApi: capabilities.read,
    assistantAdapters: capabilities.assistant?.adapters,
    attachmentService: personal?.attachmentService,
    extractionService: personal?.extractionService,
    ingestionService: personal?.ingestionService,
    intakeService: personal?.intakeService,
    intakeTrashService: personal?.intakeTrashService,
    trashService: personal?.trashService,
    skillCatalog: personal?.skillCatalog,
    projectService: personal?.projectService,
    projectWritePlans: personal?.projectWritePlans
  } as T;
}
