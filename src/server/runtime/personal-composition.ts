import { basename, join } from 'node:path';
import { openStateKernel } from '../db/database.js';
import { type IndexRefreshAttempt } from '../index/index-scheduler.js';
import type { ModelCredentialsPort } from '../ai/model-credentials.js';
import { createExtractionService, type ExtractionService } from '../services/extraction-service.js';
import { createIntakeMutationGate } from '../services/intake-mutation-gate.js';
import { createDeepSeekAssistantAdapter } from '../assistant/deepseek-adapter.js';
import { createAttachmentService, type AttachmentService } from '../attachments/service.js';
import { createSkillCatalogService, type SkillCatalogService } from '../services/skill-catalog.js';
import { createProjectService } from '../projects/project-service.js';
import { createProjectWritePlanService } from '../projects/project-write-plans.js';
import type { ProjectService, ProjectWritePlanService } from '../../shared/api/projects.js';
import type { OpenableVaultGateway, VaultGateway } from '../vault/VaultGateway.js';
import { createRuntimeDisposer, disposeAfterStartupFailure, type RuntimeDisposer } from './runtime-disposer.js';
import type { RuntimeCapabilities } from './capabilities.js';
import { createDirectReadHealthService, createHealthService, type HealthService } from '../services/health-service.js';
import { createIndexComposition } from './index-composition.js';
import { createArchiveComposition } from './archive-composition.js';

export interface PersonalRuntimeConfig {
  readonly appDataDir: string;
  readonly vaultRealRoot: string;
  readonly modelBaseUrl: string;
  readonly modelName?: string;
  readonly gateway: OpenableVaultGateway;
  readonly adapter?: 'filesystem' | 'local-rest';
  readonly skillCatalog?: SkillCatalogService;
  readonly personalArchiveAddonPath?: string;
  readonly modelCredentials?: ModelCredentialsPort;
  readonly legacyHealth?: {
    readonly writeEnabled: boolean;
    readonly profileDirectory: string;
    readonly gateway: Pick<VaultGateway, 'fingerprint' | 'readOpenApi'>;
    readonly development?: boolean;
  };
}

export interface PersonalRuntimeComposition {
  readonly capabilities: RuntimeCapabilities;
  readonly requestRefresh: () => Promise<IndexRefreshAttempt | undefined>;
  startIndexing(): void;
  dispose(): Promise<void>;
}

export async function createPersonalRuntimeComposition(config: PersonalRuntimeConfig): Promise<PersonalRuntimeComposition> {
  const kernel = openStateKernel({ appDataDir: config.appDataDir, vaultRealRoot: config.vaultRealRoot });
  const disposer: RuntimeDisposer = createRuntimeDisposer();
  if (kernel.mode === 'normal') disposer.add(() => kernel.close());
  let scheduler: ReturnType<typeof createIndexComposition>['scheduler'];
  let extractionService: ExtractionService | undefined;
  let attachmentService: AttachmentService | undefined;
  let skillCatalog: SkillCatalogService | undefined;
  let projectService: (ProjectService & { close(): Promise<void> }) | undefined;
  let projectWritePlans: ProjectWritePlanService | undefined;
  const intakeMutation = createIntakeMutationGate();

  try {
    if (kernel.mode === 'normal' && config.adapter === 'filesystem') {
      projectService = createProjectService({ database: kernel.db, vaultRoot: config.vaultRealRoot, stateRoot: config.appDataDir });
      const ownedProject = projectService;
      disposer.add(() => ownedProject.close());
      projectWritePlans = createProjectWritePlanService({ database: kernel.db });
    }
    // Register lifecycle phases before acquiring their resources. On both
    // startup failure and shutdown, consumers finish before the index scheduler,
    // then borrowed native handles, project state, and the database are released.
    const nativeResources = createRuntimeDisposer();
    disposer.add(() => nativeResources.dispose());
    const { repository, indexer, scheduler: indexScheduler } = createIndexComposition({
      stateKernel: kernel,
      gateway: config.gateway,
      ...(config.adapter === undefined ? {} : { adapter: config.adapter })
    });
    scheduler = indexScheduler;
    disposer.add(() => indexScheduler?.stopAndWait());
    const serviceResources = createRuntimeDisposer();
    disposer.add(() => serviceResources.dispose());
    const commonHealth = {
      stateKernel: kernel,
      indexState: { snapshot: () => scheduler?.snapshot().state
        ?? { status: 'unavailable' as const, reason: 'RECOVERY_ONLY' as const } },
      model: { baseUrl: config.modelBaseUrl, ...(config.modelName === undefined ? {} : { name: config.modelName }) },
      ...(repository === undefined ? {} : { schemaIssues: { count: () => repository.listIssues().length } })
    };
    const baseHealthService = config.legacyHealth === undefined
      ? createDirectReadHealthService({
        ...commonHealth,
        displayName: basename(config.vaultRealRoot),
        ...(config.gateway.probeReadiness === undefined ? {} : {
          probeReadiness: (signal: AbortSignal) => config.gateway.probeReadiness!(signal)
        })
      })
      : createHealthService({
        ...commonHealth,
        writeEnabled: config.legacyHealth.writeEnabled,
        gateway: config.legacyHealth.gateway,
        profileDirectory: config.legacyHealth.profileDirectory
      });
    if (kernel.mode === 'normal' && repository && config.adapter === 'filesystem' && config.modelCredentials) {
      extractionService = createExtractionService({ database: kernel.db, repository, gateway: config.gateway, credentials: config.modelCredentials });
      const ownedExtraction = extractionService;
      serviceResources.add(() => ownedExtraction.close());
    }
    const healthService: HealthService = config.adapter === 'local-rest' ? baseHealthService : {
      getSnapshot: async () => {
        const snapshot = await baseHealthService.getSnapshot();
        const settings = extractionService?.settings();
        return { ...snapshot, model: !settings?.available ? { status: 'unavailable', reason: 'CONFIG_UNAVAILABLE' }
          : settings.configured ? { status: 'configured', providerHost: settings.providerHost, name: settings.model }
            : { status: 'unconfigured', providerHost: settings.providerHost } };
      }
    };
    const refreshIndex = async () => {
      const result = await scheduler?.requestFocusRefresh();
      return result?.outcome === 'succeeded' && result.refresh.status === 'ready';
    };
    const archiveComposition = await createArchiveComposition({
      stateKernel: kernel,
      ...(config.adapter === undefined ? {} : { adapter: config.adapter }),
      ...(repository === undefined ? {} : { repository }),
      ...(scheduler === undefined ? {} : { scheduler }),
      gateway: config.gateway,
      appDataDir: config.appDataDir,
      vaultRealRoot: config.vaultRealRoot,
      ...(config.personalArchiveAddonPath === undefined ? {} : { personalArchiveAddonPath: config.personalArchiveAddonPath }),
      healthService,
      refreshIndex,
      intakeMutation,
      nativeResources,
      serviceResources
    });
    const {
      archivePort,
      intakeService,
      ingestionService,
      trashService,
      intakeTrashService
    } = archiveComposition;
    if (kernel.mode === 'normal' && config.adapter === 'filesystem') {
      const attachmentResources = createRuntimeDisposer();
      serviceResources.add(() => attachmentResources.dispose());
      try {
        attachmentService = createAttachmentService({ directory: join(config.appDataDir, 'assistant-attachments-v1'),
          ...(archivePort && intakeService ? { archive: { port: archivePort, intakeService } } : {}) });
        const ownedAttachments = attachmentService;
        attachmentResources.add(() => ownedAttachments.close());
        await attachmentService.ready();
      } catch (error) {
        await disposeAfterStartupFailure(attachmentResources, error);
        attachmentService = undefined;
        // A damaged private attachment ledger must not take the whole library offline.
      }
    }
    if (config.adapter === 'filesystem') {
      skillCatalog = config.skillCatalog ?? createSkillCatalogService({ skillsRoot: join(config.vaultRealRoot, '.claude', 'skills') });
    }
    const assistantAdapters = config.adapter === 'filesystem' && kernel.mode === 'normal'
      ? (config.modelCredentials ? [createDeepSeekAssistantAdapter({ credentials: config.modelCredentials })] : [])
      : undefined;
    const capabilities: RuntimeCapabilities = {
      health: healthService,
      ...(kernel.mode !== 'normal' || repository === undefined || scheduler === undefined || indexer === undefined
        ? {} : { read: {
          repository, gateway: config.gateway, database: kernel.db,
          indexScheduler: scheduler, currentIndexVersion: () => indexer.version
        } }),
      personal: {
        ...(attachmentService ? { attachmentService } : {}),
        ...(extractionService ? { extractionService } : {}),
        ...(ingestionService ? { ingestionService } : {}),
        ...(intakeService ? { intakeService } : {}),
        ...(intakeTrashService ? { intakeTrashService } : {}),
        ...(trashService ? { trashService } : {}),
        ...(skillCatalog ? { skillCatalog } : {}),
        ...(projectService ? { projectService } : {}),
        ...(projectWritePlans ? { projectWritePlans } : {})
      },
      ...(assistantAdapters === undefined ? {} : { assistant: { adapters: assistantAdapters } })
    };
    return {
      capabilities,
      requestRefresh: async () => scheduler?.requestFocusRefresh(),
      startIndexing: () => {
        scheduler?.start();
        void scheduler?.requestFocusRefresh();
      },
      dispose: () => disposer.dispose()
    };
  } catch (error) {
    await disposeAfterStartupFailure(disposer, error);
    throw error;
  }
}
