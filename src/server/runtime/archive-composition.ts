import { join } from 'node:path';
import { ensurePrivateDirectory } from '../db/permissions.js';
import type { StateKernel } from '../db/database.js';
import type { IndexRepository } from '../index/index-repository.js';
import type { IndexScheduler } from '../index/index-scheduler.js';
import { openPersonalArchive, type PersonalArchivePort } from '../archive/sandbox-native.js';
import { createIntakeService, type IntakeService } from '../services/intake-service.js';
import { loadRuleBundle } from '../rules/rule-bundle.js';
import { PublicApiError } from '../../shared/api/errors.js';
import type { OpenableVaultGateway } from '../vault/VaultGateway.js';
import { createIngestionService, type IngestionService } from '../ingestion/ingestion-service.js';
import type { PersonalIngestionPort } from '../ingestion/ingestion-native.js';
import { createTrashService, type TrashService } from '../trash/trash-service.js';
import type { PersonalTrashPort } from '../trash/trash-native.js';
import { createIntakeTrashService, type IntakeTrashService } from '../trash/intake-trash-service.js';
import type { PersonalIntakeTrashPort } from '../trash/intake-trash-native.js';
import { listIntakeArchives } from '../archive/intake-archive.js';
import type { HealthService } from '../services/health-service.js';
import { createRuntimeDisposer, disposeAfterStartupFailure, type RuntimeDisposer } from './runtime-disposer.js';

export type IntakeMutation = <T>(action: () => Promise<T>) => Promise<T>;

export interface ArchiveCompositionConfig {
  readonly stateKernel: StateKernel;
  readonly adapter?: 'filesystem' | 'local-rest';
  readonly repository?: IndexRepository;
  readonly scheduler?: IndexScheduler;
  readonly gateway: OpenableVaultGateway;
  readonly appDataDir: string;
  readonly vaultRealRoot: string;
  readonly personalArchiveAddonPath?: string;
  readonly healthService: HealthService;
  readonly refreshIndex: () => Promise<boolean>;
  readonly intakeMutation: IntakeMutation;
  /** Startup owns acquired resources even before this composition returns. */
  readonly nativeResources: RuntimeDisposer;
  readonly serviceResources: RuntimeDisposer;
}

export interface ArchiveComposition {
  readonly archivePort?: PersonalArchivePort;
  readonly intakeService?: IntakeService;
  readonly ingestionPort?: PersonalIngestionPort;
  readonly ingestionService?: IngestionService;
  readonly trashPort?: PersonalTrashPort;
  readonly trashService?: TrashService;
  readonly intakeTrashPort?: PersonalIntakeTrashPort;
  readonly intakeTrashService?: IntakeTrashService;
}

function capabilityResources(config: ArchiveCompositionConfig) {
  const native = createRuntimeDisposer(), services = createRuntimeDisposer();
  config.nativeResources.add(() => native.dispose());
  config.serviceResources.add(() => services.dispose());
  const rollback = createRuntimeDisposer();
  rollback.add(() => native.dispose());
  rollback.add(() => services.dispose());
  return { native, services, rollback };
}

export async function createArchiveComposition(config: ArchiveCompositionConfig): Promise<ArchiveComposition> {
  let archivePort: PersonalArchivePort | undefined;
  let ingestionPort: PersonalIngestionPort | undefined;
  let ingestionService: IngestionService | undefined;
  let trashPort: PersonalTrashPort | undefined;
  let trashService: TrashService | undefined;
  let intakeTrashPort: PersonalIntakeTrashPort | undefined;
  let intakeTrashService: IntakeTrashService | undefined;
  let intakeService: IntakeService | undefined;

  if (config.stateKernel.mode === 'normal' && config.adapter === 'filesystem' && config.scheduler
    && config.personalArchiveAddonPath) {
    const resources = capabilityResources(config);
    try {
      const recoveryRoot = join(config.appDataDir, 'personal-intake-v1');
      ensurePrivateDirectory(recoveryRoot);
      archivePort = openPersonalArchive(config.vaultRealRoot, recoveryRoot, config.personalArchiveAddonPath);
      const ownedArchive = archivePort;
      resources.native.add(() => ownedArchive.close());
      const getRuleFingerprint = async () => {
        if ((await config.healthService.getSnapshot()).status !== 'ready') {
          throw new PublicApiError('RECOVERY_REQUIRED', '系统需要先完成恢复或重新连接，已暂停归档。', 409);
        }
        return (await loadRuleBundle(config.gateway)).fingerprint;
      };
      const service = createIntakeService({ port: archivePort, getRuleFingerprint,
        ruleFingerprint: await getRuleFingerprint(), refreshIndex: config.refreshIndex });
      const archiveMutation = <T>(action: () => Promise<T>) => config.intakeMutation(async () => {
        if (!intakeTrashService) throw new PublicApiError('RECOVERY_REQUIRED', '收件箱回收状态暂时无法核验，请重新打开 App 后再归档。', 409);
        if (intakeTrashService.list().items.some(item => !['trashed', 'restored', 'deleted'].includes(item.status))) {
          throw new PublicApiError('RECOVERY_REQUIRED', '请先到回收站核验未完成的收件箱操作，再归档资料。', 409);
        }
        return action();
      });
      intakeService = { ...service, commit: (token, signal) => archiveMutation(() => service.commit(token, signal)),
        resume: (id, signal) => archiveMutation(() => service.resume(id, signal)) };
    } catch (error) {
      await disposeAfterStartupFailure(resources.rollback, error);
      archivePort = undefined;
      // A missing or unsafe writer must not prevent access to the read-only library.
    }
  }

  if (config.stateKernel.mode === 'normal' && config.repository && archivePort && config.scheduler) {
    const resources = capabilityResources(config);
    try {
      const recoveryRoot = join(config.appDataDir, 'personal-ingestion-v1');
      ensurePrivateDirectory(recoveryRoot);
      ingestionPort = archivePort.openIngestion(recoveryRoot);
      const ownedPort = ingestionPort;
      resources.native.add(() => ownedPort.close());
      ingestionService = createIngestionService({ database: config.stateKernel.db, repository: config.repository, gateway: config.gateway,
        port: ingestionPort, refreshIndex: config.refreshIndex });
      const ownedService = ingestionService;
      resources.services.add(() => ownedService.close());
      // Recovery considers persisted confirmed batches only. Complete it before
      // accepting HTTP requests so no GET can initiate or overlap recovery.
      await ingestionService.recover();
    } catch (error) {
      await disposeAfterStartupFailure(resources.rollback, error);
      ingestionService = undefined;
      ingestionPort = undefined;
      // An unavailable ingestion recovery port leaves intake and reading usable.
    }
  }

  if (config.stateKernel.mode === 'normal' && config.repository && archivePort && config.scheduler) {
    const resources = capabilityResources(config);
    try {
      const recoveryRoot = join(config.appDataDir, 'personal-trash-v1');
      ensurePrivateDirectory(recoveryRoot);
      trashPort = archivePort.openTrash(recoveryRoot);
      const ownedPort = trashPort;
      resources.native.add(() => ownedPort.close());
      trashService = createTrashService({ database: config.stateKernel.db, repository: config.repository, port: trashPort, refreshIndex: config.refreshIndex,
        getRuleFingerprint: async () => {
          if ((await config.healthService.getSnapshot()).status !== 'ready') throw new PublicApiError('RECOVERY_REQUIRED', '请先完成恢复或重新连接大脑。', 409);
          return (await loadRuleBundle(config.gateway)).fingerprint;
        }
      });
      const ownedService = trashService;
      resources.services.add(() => ownedService.close());
      await trashService.recover();
    } catch (error) {
      await disposeAfterStartupFailure(resources.rollback, error);
      trashService = undefined;
      trashPort = undefined;
    }
  }

  if (archivePort && intakeService) {
    const resources = capabilityResources(config);
    try {
      const recoveryRoot = join(config.appDataDir, 'personal-intake-trash-v1');
      ensurePrivateDirectory(recoveryRoot);
      intakeTrashPort = archivePort.openIntakeTrash(recoveryRoot);
      const ownedPort = intakeTrashPort;
      let ownedService: ReturnType<typeof createIntakeTrashService> | undefined;
      // This service closes its own borrowed port. Before construction succeeds,
      // the composition remains responsible for that port instead.
      resources.native.add(() => { if (!ownedService) ownedPort.close(); });
      resources.services.add(() => ownedService?.close());
      const owner = archivePort;
      const service = createIntakeTrashService({ port: intakeTrashPort,
        getRuleFingerprint: async () => {
          if ((await config.healthService.getSnapshot()).status !== 'ready') throw new PublicApiError('RECOVERY_REQUIRED', '请先完成恢复或重新连接大脑。', 409);
          return (await loadRuleBundle(config.gateway)).fingerprint;
        },
        assertIdle: () => {
          if (listIntakeArchives(owner).some(operation => operation.state !== 'archived')) {
            throw new PublicApiError('RECOVERY_REQUIRED', '有未完成的归档，请先在收件箱下方继续核验，再回收资料。', 409);
          }
        }
      });
      ownedService = service;
      intakeTrashService = { ...service,
        commit: id => config.intakeMutation(() => service.commit(id)),
        restore: id => config.intakeMutation(() => service.restore(id)),
        retry: id => config.intakeMutation(() => service.retry(id)),
        ...(service.delete ? { delete: (id: string, token: string) => config.intakeMutation(() => service.delete!(id, token)) } : {}) };
      await intakeTrashService.recover();
    } catch (error) {
      await disposeAfterStartupFailure(resources.rollback, error);
      intakeTrashService = undefined;
      intakeTrashPort = undefined;
    }
  }

  return {
    ...(archivePort ? { archivePort } : {}),
    ...(intakeService ? { intakeService } : {}),
    ...(ingestionPort ? { ingestionPort } : {}),
    ...(ingestionService ? { ingestionService } : {}),
    ...(trashPort ? { trashPort } : {}),
    ...(trashService ? { trashService } : {}),
    ...(intakeTrashPort ? { intakeTrashPort } : {}),
    ...(intakeTrashService ? { intakeTrashService } : {})
  };
}
