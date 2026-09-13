import { basename, join } from 'node:path';
import { buildServer } from './app.js';
import { registerClientAssets } from './client-assets.js';
import { openStateKernel } from './db/database.js';
import { SearchIndexer } from './index/SearchIndexer.js';
import { createIndexRepository } from './index/index-repository.js';
import { loadIndexMetadata } from './index/index-metadata.js';
import { IndexScheduler, type IndexRefreshAttempt } from './index/index-scheduler.js';
import { IndexStateController } from './index/index-state.js';
import { createLoopbackPolicy } from './security/loopback-policy.js';
import { DEVELOPMENT_HTTP_ORIGIN } from './security/origin-host.js';
import { createDirectReadHealthService, createHealthService, type HealthService } from './services/health-service.js';
import type { OpenableVaultGateway, VaultGateway } from './vault/VaultGateway.js';
import { ensurePrivateDirectory } from './db/permissions.js';
import { openPersonalArchive, type PersonalArchivePort } from './archive/sandbox-native.js';
import { createIntakeService, type IntakeService } from './services/intake-service.js';
import { loadRuleBundle } from './rules/rule-bundle.js';
import { PublicApiError } from '../shared/api/errors.js';
import type { ModelCredentialsPort } from './ai/model-credentials.js';
import { createExtractionService, type ExtractionService } from './services/extraction-service.js';
import { createIngestionService, type IngestionService } from './ingestion/ingestion-service.js';
import type { PersonalIngestionPort } from './ingestion/ingestion-native.js';
import { createTrashService, type TrashService } from './trash/trash-service.js';
import type { PersonalTrashPort } from './trash/trash-native.js';
import { createIntakeTrashService, type IntakeTrashService } from './trash/intake-trash-service.js';
import type { PersonalIntakeTrashPort } from './trash/intake-trash-native.js';
import { createIntakeMutationGate } from './services/intake-mutation-gate.js';
import { listIntakeArchives } from './archive/intake-archive.js';
import { createDeepSeekAssistantAdapter } from './assistant/deepseek-adapter.js';
import { createAttachmentService, type AttachmentService } from './attachments/service.js';

export interface EmbeddedServerConfig {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly appDataDir: string;
  readonly vaultRealRoot: string;
  readonly clientRoot: string;
  readonly modelBaseUrl: string;
  readonly modelName?: string;
  readonly gateway: OpenableVaultGateway;
  readonly adapter?: 'filesystem' | 'local-rest';
  readonly personalArchiveAddonPath?: string;
  readonly modelCredentials?: ModelCredentialsPort;
  readonly legacyHealth?: {
    readonly writeEnabled: boolean;
    readonly profileDirectory: string;
    readonly gateway: Pick<VaultGateway, 'fingerprint' | 'readOpenApi'>;
    readonly development?: boolean;
  };
}

export interface StartedServer {
  readonly origin: string;
  readonly port: number;
  requestRefresh(): Promise<IndexRefreshAttempt | undefined>;
  close(): Promise<void>;
}

export async function startServer(config: EmbeddedServerConfig): Promise<StartedServer> {
  if (config.host !== '127.0.0.1' || !Number.isInteger(config.port)
    || config.port < 0 || config.port > 65535) throw new Error('INVALID_LOOPBACK_LISTEN');
  if (config.legacyHealth !== undefined && config.adapter !== 'local-rest') {
    throw new Error('INVALID_LEGACY_ADAPTER');
  }
  if (config.adapter === 'local-rest' && config.legacyHealth === undefined) {
    throw new Error('LEGACY_HEALTH_REQUIRED');
  }
  const kernel = openStateKernel({ appDataDir: config.appDataDir, vaultRealRoot: config.vaultRealRoot });
  let scheduler: IndexScheduler | undefined;
  let app: ReturnType<typeof buildServer> | undefined;
  let archivePort: PersonalArchivePort | undefined;
  let extractionService: ExtractionService | undefined;
  let ingestionPort: PersonalIngestionPort | undefined;
  let ingestionService: IngestionService | undefined;
  let trashPort: PersonalTrashPort | undefined;
  let trashService: TrashService | undefined;
  let intakeTrashPort: PersonalIntakeTrashPort | undefined;
  let intakeTrashService: IntakeTrashService | undefined;
  let attachmentService: AttachmentService | undefined;
  const intakeMutation = createIntakeMutationGate();
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      try { try { await attachmentService?.close(); } finally { await extractionService?.close(); } } finally {
        try { await ingestionService?.close(); } finally {
          try { await trashService?.close(); } finally {
            try { await intakeTrashService?.close(); } finally {
              try { await scheduler?.stopAndWait(); } finally {
                try { intakeTrashPort?.close(); } finally {
                  try { trashPort?.close(); } finally {
                    try { ingestionPort?.close(); } finally {
                      try { archivePort?.close(); } finally { if (kernel.mode === 'normal') kernel.close(); }
                    }
                  }
                }
              }
            }
          }
        }
      }
    })();
    return shutdownPromise;
  };
  try {
    const repository = kernel.mode === 'normal' ? createIndexRepository(kernel.db) : undefined;
    let indexer: SearchIndexer | undefined;
    if (kernel.mode === 'normal' && repository !== undefined) {
      const metadata = loadIndexMetadata(kernel.db);
      indexer = new SearchIndexer({ gateway: config.gateway, repository, maxRawReadsPerPoll: 50 });
      indexer.version = metadata?.version ?? 0;
      const activeIndexer = indexer;
      const now = () => new Date();
      scheduler = new IndexScheduler({
        refresh: async (signal) => {
          let result = await activeIndexer.refresh(signal);
          while (config.adapter !== 'local-rest' && result.status === 'refreshing') {
            result = await activeIndexer.refresh(signal);
          }
          return result;
        },
        state: new IndexStateController(now, metadata),
        intervals: { every: (milliseconds, task) => {
          const timer = setInterval(task, milliseconds);
          timer.unref();
          return () => clearInterval(timer);
        } },
        deadlines: { after: (milliseconds, task) => {
          const timer = setTimeout(task, milliseconds);
          timer.unref();
          return () => clearTimeout(timer);
        } },
        now
      });
    }
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
    let intakeService: IntakeService | undefined;
    if (kernel.mode === 'normal' && config.adapter === 'filesystem' && config.personalArchiveAddonPath && scheduler) {
      try {
        // The kernel recovery directory denotes a database fault, not archive history.
        const recoveryRoot = join(config.appDataDir, 'personal-intake-v1');
        ensurePrivateDirectory(recoveryRoot);
        archivePort = openPersonalArchive(config.vaultRealRoot, recoveryRoot, config.personalArchiveAddonPath);
        const getRuleFingerprint = async () => {
          if ((await healthService.getSnapshot()).status !== 'ready') {
            throw new PublicApiError('RECOVERY_REQUIRED', '系统需要先完成恢复或重新连接，已暂停归档。', 409);
          }
          return (await loadRuleBundle(config.gateway)).fingerprint;
        };
        const service = createIntakeService({ port: archivePort, getRuleFingerprint,
          ruleFingerprint: await getRuleFingerprint(), refreshIndex });
        const archiveMutation = <T>(action: () => Promise<T>) => intakeMutation(async () => {
          if (!intakeTrashService) throw new PublicApiError('RECOVERY_REQUIRED', '收件箱回收状态暂时无法核验，请重新打开 App 后再归档。', 409);
          if (intakeTrashService.list().items.some(item => !['trashed', 'restored', 'deleted'].includes(item.status))) {
            throw new PublicApiError('RECOVERY_REQUIRED', '请先到回收站核验未完成的收件箱操作，再归档资料。', 409);
          }
          return action();
        });
        intakeService = { ...service, commit: (token, signal) => archiveMutation(() => service.commit(token, signal)),
          resume: (id, signal) => archiveMutation(() => service.resume(id, signal)) };
      } catch {
        archivePort?.close(); archivePort = undefined;
        // A missing or unsafe writer must not prevent access to the read-only library.
      }
    }
    if (kernel.mode === 'normal' && repository && archivePort && scheduler) {
      try {
        const recoveryRoot = join(config.appDataDir, 'personal-ingestion-v1');
        ensurePrivateDirectory(recoveryRoot);
        ingestionPort = archivePort.openIngestion(recoveryRoot);
        ingestionService = createIngestionService({ database: kernel.db, repository, gateway: config.gateway,
          port: ingestionPort, refreshIndex });
        // Recovery considers persisted confirmed batches only. Complete it before
        // accepting HTTP requests so no GET can initiate or overlap recovery.
        await ingestionService.recover();
      } catch {
        try { await ingestionService?.close(); } finally {
          ingestionService = undefined;
          ingestionPort?.close(); ingestionPort = undefined;
        }
        // An unavailable ingestion recovery port leaves intake and reading usable.
      }
    }
    if (kernel.mode === 'normal' && repository && archivePort && scheduler) {
      try {
        const recoveryRoot = join(config.appDataDir, 'personal-trash-v1');
        ensurePrivateDirectory(recoveryRoot);
        trashPort = archivePort.openTrash(recoveryRoot);
        trashService = createTrashService({ database: kernel.db, repository, port: trashPort, refreshIndex,
          getRuleFingerprint: async () => {
            if ((await healthService.getSnapshot()).status !== 'ready') throw new PublicApiError('RECOVERY_REQUIRED', '请先完成恢复或重新连接大脑。', 409);
            return (await loadRuleBundle(config.gateway)).fingerprint;
          }
        });
        await trashService.recover();
      } catch {
        try { await trashService?.close(); } finally { trashService = undefined; trashPort?.close(); trashPort = undefined; }
      }
    }
    if (archivePort && intakeService) {
      try {
        const recoveryRoot = join(config.appDataDir, 'personal-intake-trash-v1');
        ensurePrivateDirectory(recoveryRoot);
        intakeTrashPort = archivePort.openIntakeTrash(recoveryRoot);
        const owner = archivePort;
        const service = createIntakeTrashService({ port: intakeTrashPort,
          getRuleFingerprint: async () => {
            if ((await healthService.getSnapshot()).status !== 'ready') throw new PublicApiError('RECOVERY_REQUIRED', '请先完成恢复或重新连接大脑。', 409);
            return (await loadRuleBundle(config.gateway)).fingerprint;
          },
          assertIdle: () => {
            if (listIntakeArchives(owner).some(operation => operation.state !== 'archived')) {
              throw new PublicApiError('RECOVERY_REQUIRED', '有未完成的归档，请先在收件箱下方继续核验，再回收资料。', 409);
            }
          }
        });
        intakeTrashService = { ...service,
          commit: id => intakeMutation(() => service.commit(id)),
          restore: id => intakeMutation(() => service.restore(id)),
          retry: id => intakeMutation(() => service.retry(id)),
          ...(service.delete ? { delete: (id: string, token: string) => intakeMutation(() => service.delete!(id, token)) } : {}) };
        await intakeTrashService.recover();
      } catch {
        try { await intakeTrashService?.close(); } finally {
          intakeTrashService = undefined; intakeTrashPort?.close(); intakeTrashPort = undefined;
        }
      }
    }
    if (kernel.mode === 'normal' && config.adapter === 'filesystem') {
      try {
        attachmentService = createAttachmentService({ directory: join(config.appDataDir, 'assistant-attachments-v1'),
          ...(archivePort && intakeService ? { archive: { port: archivePort, intakeService } } : {}) });
        await attachmentService.ready();
      } catch {
        await attachmentService?.close(); attachmentService = undefined;
        // A damaged private attachment ledger must not take the whole library offline.
      }
    }
    const policy = createLoopbackPolicy();
    app = buildServer({
      healthService,
      ...(attachmentService ? { attachmentService } : {}),
      ...(config.adapter === 'filesystem' && kernel.mode === 'normal' ? { assistantAdapters: [
        ...(config.modelCredentials ? [createDeepSeekAssistantAdapter({ credentials: config.modelCredentials })] : [])
      ] } : {}),
      ...(intakeService ? { intakeService } : {}),
      ...(intakeTrashService ? { intakeTrashService } : {}),
      ...(extractionService ? { extractionService } : {}),
      ...(ingestionService ? { ingestionService } : {}),
      ...(trashService ? { trashService } : {}),
      httpPolicy: {
        isAllowedHost: policy.isAllowedHost,
        isAllowedOrigin: (origin, required) => policy.isAllowedOrigin(origin, required)
          || (config.legacyHealth?.development === true && origin === DEVELOPMENT_HTTP_ORIGIN)
      },
      onClose: shutdown,
      ...(kernel.mode !== 'normal' || repository === undefined || scheduler === undefined || indexer === undefined
        ? {} : { readApi: {
          repository, gateway: config.gateway, database: kernel.db,
          indexScheduler: scheduler, currentIndexVersion: () => indexer.version
        } })
    });
    if (config.legacyHealth?.development !== true) await registerClientAssets(app, config.clientRoot);
    await app.listen({ host: config.host, port: config.port });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('INVALID_LOOPBACK_LISTEN');
    const origin = `http://127.0.0.1:${address.port}`;
    policy.bind(origin);
    scheduler?.start();
    void scheduler?.requestFocusRefresh();
    const runningApp = app;
    let closePromise: Promise<void> | undefined;
    return {
      origin,
      port: address.port,
      requestRefresh: async () => scheduler?.requestFocusRefresh(),
      close: () => {
        closePromise ??= (async () => { try { await runningApp.close(); } finally { await shutdown(); } })();
        return closePromise;
      }
    };
  } catch (error) {
    try { await app?.close(); } finally { await shutdown(); }
    throw error;
  }
}
