export const EXPECTED_HTTP_HOST = '127.0.0.1:4317';
const EXPECTED_HTTP_URL = new URL(`http://${EXPECTED_HTTP_HOST}`);

export const LOOPBACK_HTTP_HOST = EXPECTED_HTTP_URL.hostname;
export const LOOPBACK_HTTP_PORT = Number(EXPECTED_HTTP_URL.port);
export const PRODUCTION_HTTP_ORIGIN = EXPECTED_HTTP_URL.origin;
export const DEVELOPMENT_HTTP_ORIGIN = `http://${LOOPBACK_HTTP_HOST}:5173`;

export interface LoopbackListenOptions {
  readonly host: string;
  readonly port: number;
}

export function resolveLoopbackListenOptions(env: NodeJS.ProcessEnv): LoopbackListenOptions {
  const host = env.APP_HOST ?? LOOPBACK_HTTP_HOST;
  if (host !== LOOPBACK_HTTP_HOST) {
    throw new Error('Invalid APP_HOST: loopback binding is required');
  }

  const port = env.APP_PORT ?? String(LOOPBACK_HTTP_PORT);
  if (port !== String(LOOPBACK_HTTP_PORT)) {
    throw new Error('Invalid APP_PORT: the fixed API port is required');
  }
  return { host: LOOPBACK_HTTP_HOST, port: LOOPBACK_HTTP_PORT };
}

export function isAllowedHost(host: string | undefined): boolean {
  return host === EXPECTED_HTTP_HOST;
}

export function isAllowedOrigin(
  origin: string | undefined,
  nodeEnv: string | undefined,
  originRequired = false
): boolean {
  if (origin === undefined) {
    return !originRequired;
  }
  return origin === PRODUCTION_HTTP_ORIGIN
    || (nodeEnv === 'development' && origin === DEVELOPMENT_HTTP_ORIGIN);
}
