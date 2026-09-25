import { buildServer } from './app.js';
import { registerClientAssets } from './client-assets.js';
import { createLoopbackPolicy } from './security/loopback-policy.js';
import { DEVELOPMENT_HTTP_ORIGIN } from './security/origin-host.js';
import type { OpenableVaultGateway } from './vault/VaultGateway.js';
import type { IndexRefreshAttempt } from './index/index-scheduler.js';
import type { PersonalRuntimeConfig } from './runtime/personal-composition.js';
import { createPersonalRuntimeComposition } from './runtime/personal-composition.js';
import { createRuntimeDisposer, disposeAfterStartupFailure } from './runtime/runtime-disposer.js';

export interface EmbeddedServerConfig extends PersonalRuntimeConfig {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly clientRoot: string;
  readonly gateway: OpenableVaultGateway;
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

  const composition = await createPersonalRuntimeComposition(config);
  let app: ReturnType<typeof buildServer> | undefined;
  try {
    const policy = createLoopbackPolicy();
    app = buildServer({
      capabilities: composition.capabilities,
      manageServiceLifecycles: false,
      httpPolicy: {
        isAllowedHost: policy.isAllowedHost,
        isAllowedOrigin: (origin, required) => policy.isAllowedOrigin(origin, required)
          || (config.legacyHealth?.development === true && origin === DEVELOPMENT_HTTP_ORIGIN)
      },
      onClose: () => composition.dispose()
    });
    if (config.legacyHealth?.development !== true) await registerClientAssets(app, config.clientRoot);
    await app.listen({ host: config.host, port: config.port });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('INVALID_LOOPBACK_LISTEN');
    const origin = `http://127.0.0.1:${address.port}`;
    policy.bind(origin);
    composition.startIndexing();
    const runningApp = app;
    let closePromise: Promise<void> | undefined;
    return {
      origin,
      port: address.port,
      requestRefresh: composition.requestRefresh,
      close: () => {
        closePromise ??= runningApp.close();
        return closePromise;
      }
    };
  } catch (error) {
    const rollback = createRuntimeDisposer();
    rollback.add(() => composition.dispose());
    rollback.add(() => app?.close());
    await disposeAfterStartupFailure(rollback, error);
    throw error;
  }
}
