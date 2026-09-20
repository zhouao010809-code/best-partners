import { isAbsolute, join, resolve } from 'node:path';
import { buildServer } from './app.js';
import { createCompanyRuntime } from './company/company-runtime.js';
import { ensureCompanyWorkspace } from './company/company-paths.js';
import { loadConfig } from './config.js';
import {
  resolveCompanyBootstrapToken,
  resolveCompanyListenOptions,
  resolveLoopbackListenOptions
} from './security/origin-host.js';
import { createCompanyHttpPolicy } from './security/loopback-policy.js';
import { openStateKernel } from './db/database.js';
import { startServer } from './start-server.js';
import { LocalRest51Gateway } from './vault/LocalRest51Gateway.js';
import { registerClientAssets } from './client-assets.js';
import { ensurePrivateDirectory } from './db/permissions.js';
import { acquireCompanyServerLock } from './company/company-operations.js';
import { installCompanySignalHandlers } from './company/graceful-shutdown.js';
import { resolveCompanyMetricsPollInterval } from './company/company-metrics-service.js';

if (process.env.RUNTIME_MODE === 'company') {
  const listenOptions = resolveCompanyListenOptions(process.env);
  const companyBootstrapToken = resolveCompanyBootstrapToken(process.env);
  const configuredWorkspaceRoot = process.env.COMPANY_WORKSPACE_ROOT;
  const appDataDir = process.env.COMPANY_DATA_DIR;
  if (configuredWorkspaceRoot === undefined || !isAbsolute(configuredWorkspaceRoot)) {
    throw new Error('COMPANY_WORKSPACE_ROOT must be an absolute path');
  }
  if (appDataDir === undefined || !isAbsolute(appDataDir)) {
    throw new Error('COMPANY_DATA_DIR must be an absolute path');
  }
  const workspace = await ensureCompanyWorkspace(configuredWorkspaceRoot, appDataDir);
  ensurePrivateDirectory(appDataDir);
  const serverLock = acquireCompanyServerLock(appDataDir);
  let kernel: ReturnType<typeof openStateKernel>;
  try {
    kernel = openStateKernel({ appDataDir, vaultRealRoot: workspace.rootPath });
  } catch (error) {
    serverLock.release();
    throw error;
  }
  if (kernel.mode !== 'normal') {
    serverLock.release();
    throw new Error('COMPANY_DATABASE_UNAVAILABLE');
  }
  let closed = false;
  let stopCompanyMetrics: (() => Promise<void>) | undefined;
  const closeCompanyResources = async () => {
    if (closed) return;
    closed = true;
    try {
      await stopCompanyMetrics?.();
    } finally {
      try { kernel.close(); } finally { serverLock.release(); }
    }
  };
  try {
    const metricsPollIntervalMs = resolveCompanyMetricsPollInterval(process.env.COMPANY_METRICS_POLL_MS);
    const companyRuntime = createCompanyRuntime({
      workspaceRoot: workspace.rootPath,
      database: kernel.db,
      ...(metricsPollIntervalMs === undefined ? {} : { metricsPollIntervalMs })
    });
    stopCompanyMetrics = companyRuntime.metrics.start().stop;
    const app = buildServer({
      runtimeMode: 'company',
      companyRuntime,
      companyBootstrapToken,
      httpPolicy: createCompanyHttpPolicy(listenOptions),
      onClose: closeCompanyResources
    });
    // The company runtime is a browser-accessible LAN application as well as
    // an API. Keep its static client registration at the composition boundary
    // so the company server still never loads the personal vault client setup.
    await registerClientAssets(app, process.env.COMPANY_CLIENT_ROOT ?? resolve('dist/client'));
    await app.listen({ host: listenOptions.host, port: listenOptions.port });
    installCompanySignalHandlers(() => app.close());
  } catch (error) {
    await closeCompanyResources();
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
