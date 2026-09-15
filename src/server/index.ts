import { join, resolve } from 'node:path';
import { buildServer } from './app.js';
import { createCompanyRuntime } from './company/company-runtime.js';
import { loadConfig } from './config.js';
import { resolveLoopbackListenOptions } from './security/origin-host.js';
import { startServer } from './start-server.js';
import { LocalRest51Gateway } from './vault/LocalRest51Gateway.js';

const listenOptions = resolveLoopbackListenOptions(process.env);

if (process.env.RUNTIME_MODE === 'company') {
  const companyRuntime = createCompanyRuntime(
    process.env.COMPANY_WORKSPACE_ROOT === undefined
      ? {}
      : { workspaceRoot: process.env.COMPANY_WORKSPACE_ROOT }
  );
  const app = buildServer({ runtimeMode: 'company', companyRuntime });
  await app.listen({ host: listenOptions.host, port: listenOptions.port });
} else {
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
