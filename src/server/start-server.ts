import { basename } from 'node:path';
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
import { createDirectReadHealthService, createHealthService } from './services/health-service.js';
import type { OpenableVaultGateway, VaultGateway } from './vault/VaultGateway.js';

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
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      try { await scheduler?.stopAndWait(); } finally { if (kernel.mode === 'normal') kernel.close(); }
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
    const healthService = config.legacyHealth === undefined
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
    const policy = createLoopbackPolicy();
    app = buildServer({
      healthService,
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
