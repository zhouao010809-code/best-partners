export const EXPECTED_HTTP_HOST = '127.0.0.1:4317';
export const PRODUCTION_HTTP_ORIGIN = 'http://127.0.0.1:4317';
export const DEVELOPMENT_HTTP_ORIGIN = 'http://127.0.0.1:5173';

export function isAllowedHost(host: string | undefined): boolean {
  return host === EXPECTED_HTTP_HOST;
}

export function isAllowedOrigin(origin: string | undefined, nodeEnv: string | undefined): boolean {
  if (origin === undefined) {
    return true;
  }
  return origin === PRODUCTION_HTTP_ORIGIN
    || (nodeEnv === 'development' && origin === DEVELOPMENT_HTTP_ORIGIN);
}
