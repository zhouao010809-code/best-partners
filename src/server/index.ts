import { join, resolve } from 'node:path';
import { buildServer } from './app.js';
import { createCompanyRuntime } from './company/company-runtime.js';
import { loadConfig } from './config.js';
import { resolveCompanyListenOptions, resolveLoopbackListenOptions } from './security/origin-host.js';
import { createCompanyHttpPolicy } from './security/loopback-policy.js';
import { openStateKernel } from './db/database.js';
import { startServer } from './start-server.js';
import { LocalRest51Gateway } from './vault/LocalRest51Gateway.js';

if (process.env.RUNTIME_MODE === 'company') {
  const listenOptions = resolveCompanyListenOptions(process.env);
  const workspaceRoot = process.env.COMPANY_WORKSPACE_ROOT ?? join(process.cwd(), 'company-workspace');
  const appDataDir = process.env.COMPANY_DATA_DIR ?? join(process.cwd(), 'company-state');
  const kernel = openStateKernel({ appDataDir, vaultRealRoot: workspaceRoot });
  if (kernel.mode !== 'normal') throw new Error('COMPANY_DATABASE_UNAVAILABLE');
  let closed = false;
  const closeKernel = () => {
    if (closed) return;
    closed = true;
    kernel.close();
  };
  try {
    const companyRuntime = createCompanyRuntime({ workspaceRoot, database: kernel.db });
    const app = buildServer({
      runtimeMode: 'company',
      companyRuntime,
      httpPolicy: createCompanyHttpPolicy(listenOptions),
      onClose: closeKernel
    });
    await app.listen({ host: listenOptions.host, port: listenOptions.port });
  } catch (error) {
    closeKernel();
    throw error;
  }
} else {
  const listenOptions = resolveLoopbackListenOptions(process.env);
  const config = loadConfig(process.env);
  const gateway = new LocalRest51Gateway(config.obsidianApiUrl, config.obsidianApiKey, fetch);

  await startServer({
    host: '127.0.0.1',
    port: listenOptions.port,
    appDataDir: config.appDataDir,
    vaultRealRoot: config.vaultRealRoot,
    clientRoot: resolve('dist/client'),
    modelBaseUrl: config.modelBaseUrl,
    ...(config.modelName === undefined || config.modelApiKey === undefined
      ? {} : { modelName: config.modelName }),
    gateway,
    adapter: 'local-rest',
    legacyHealth: {
      gateway,
      writeEnabled: config.writeEnabled,
      profileDirectory: join(config.appDataDir, 'contract-profiles'),
      development: process.env.NODE_ENV === 'development'
    }
  });
}
