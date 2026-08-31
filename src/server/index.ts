import { join } from 'node:path';
import { buildServer } from './app.js';
import { loadConfig } from './config.js';
import { openStateKernel } from './db/database.js';
import { SearchIndexer } from './index/SearchIndexer.js';
import { createIndexRepository } from './index/index-repository.js';
import { IndexScheduler, type IndexScheduler as IndexSchedulerInstance } from './index/index-scheduler.js';
import { IndexStateController } from './index/index-state.js';
import { resolveLoopbackListenOptions } from './security/origin-host.js';
import { createHealthService } from './services/health-service.js';
import { loadPersistedIndexVersion } from './services/index-job-service.js';
import { LocalRest51Gateway } from './vault/LocalRest51Gateway.js';

const listenOptions = resolveLoopbackListenOptions(process.env);
const config = loadConfig(process.env);
const stateKernel = openStateKernel({
  appDataDir: config.appDataDir,
  vaultRealRoot: config.vaultRealRoot
});
let stateKernelClosed = false;
let indexScheduler: IndexSchedulerInstance | undefined;
let shutdownPromise: Promise<void> | undefined;

function closeStateKernel(): void {
  if (stateKernelClosed || stateKernel.mode !== 'normal') return;
  stateKernelClosed = true;
  stateKernel.close();
}

function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    await indexScheduler?.stopAndWait();
    closeStateKernel();
  })();
  return shutdownPromise;
}

try {
  const gateway = new LocalRest51Gateway(
    config.obsidianApiUrl,
    config.obsidianApiKey,
    fetch
  );
  const healthService = createHealthService({
    writeEnabled: config.writeEnabled,
    gateway,
    profileDirectory: join(config.appDataDir, 'contract-profiles'),
    stateKernel
  });
  const app = stateKernel.mode === 'normal'
    ? (() => {
      const repository = createIndexRepository(stateKernel.db);
      const indexer = new SearchIndexer({
        gateway,
        repository,
        maxRawReadsPerPoll: 50
      });
      indexer.version = loadPersistedIndexVersion(stateKernel.db, 0);
      const now = () => new Date();
      const scheduler = new IndexScheduler({
        refresh: async (signal) => {
          const result = await indexer.refresh(signal);
          if (result.status === 'ready') {
            stateKernel.db.prepare(`
              UPDATE index_metadata SET version = ?, updated_at = ? WHERE singleton = 1
            `).run(result.version, now().toISOString());
          }
          return result;
        },
        state: new IndexStateController(now),
        intervals: {
          every: (milliseconds, task) => {
            const timer = setInterval(task, milliseconds);
            timer.unref();
            return () => clearInterval(timer);
          }
        },
        deadlines: {
          after: (milliseconds, task) => {
            const timer = setTimeout(task, milliseconds);
            timer.unref();
            return () => clearTimeout(timer);
          }
        },
        now
      });
      indexScheduler = scheduler;
      const server = buildServer({
        healthService,
        onClose: shutdown,
        readApi: {
          repository,
          gateway,
          database: stateKernel.db,
          indexScheduler: scheduler,
          currentIndexVersion: () => indexer.version
        }
      });
      scheduler.start();
      void scheduler.requestFocusRefresh();
      return server;
    })()
    : buildServer({ healthService, onClose: shutdown });

  await app.listen(listenOptions);
} catch (error) {
  await shutdown();
  throw error;
}
