import { SearchIndexer } from '../index/SearchIndexer.js';
import { createIndexRepository } from '../index/index-repository.js';
import { loadIndexMetadata } from '../index/index-metadata.js';
import { IndexScheduler } from '../index/index-scheduler.js';
import { IndexStateController } from '../index/index-state.js';
import type { StateKernel } from '../db/database.js';
import type { OpenableVaultGateway } from '../vault/VaultGateway.js';
import type { IndexRepository } from '../index/index-repository.js';

export interface IndexCompositionConfig {
  readonly stateKernel: StateKernel;
  readonly gateway: OpenableVaultGateway;
  readonly adapter?: 'filesystem' | 'local-rest';
}

export interface IndexComposition {
  readonly repository?: IndexRepository;
  readonly indexer?: SearchIndexer;
  readonly scheduler?: IndexScheduler;
}

export function createIndexComposition(config: IndexCompositionConfig): IndexComposition {
  if (config.stateKernel.mode !== 'normal') return {};
  const repository = createIndexRepository(config.stateKernel.db);
  const metadata = loadIndexMetadata(config.stateKernel.db);
  const indexer = new SearchIndexer({ gateway: config.gateway, repository, maxRawReadsPerPoll: 50 });
  indexer.version = metadata?.version ?? 0;
  const activeIndexer = indexer;
  const now = () => new Date();
  const scheduler = new IndexScheduler({
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
  return { repository, indexer, scheduler };
}
