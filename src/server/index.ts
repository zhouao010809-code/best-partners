import { join } from 'node:path';
import { buildServer } from './app.js';
import { loadConfig } from './config.js';
import { openStateKernel } from './db/database.js';
import { resolveLoopbackListenOptions } from './security/origin-host.js';
import { createHealthService } from './services/health-service.js';
import { LocalRest51Gateway } from './vault/LocalRest51Gateway.js';

const listenOptions = resolveLoopbackListenOptions(process.env);
const config = loadConfig(process.env);
const stateKernel = openStateKernel({
  appDataDir: config.appDataDir,
  vaultRealRoot: config.vaultRealRoot
});
let stateKernelClosed = false;

function closeStateKernel(): void {
  if (stateKernelClosed || stateKernel.mode !== 'normal') return;
  stateKernelClosed = true;
  stateKernel.close();
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
  const app = buildServer({ healthService });
  app.addHook('onClose', async () => closeStateKernel());

  await app.listen(listenOptions);
} catch (error) {
  closeStateKernel();
  throw error;
}
