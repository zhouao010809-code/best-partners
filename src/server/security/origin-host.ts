import { isIP } from 'node:net';

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

export interface CompanyListenOptions {
  readonly host: string;
  readonly port: number;
}

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '::0', '*']);

function isUnspecifiedIp(host: string): boolean {
  const value = host.replace(/^\[|\]$/gu, '');
  const version = isIP(value);
  if (version === 4) return value === '0.0.0.0';
  if (version !== 6) return false;
  const groups = value.split('::');
  const left = groups[0] ? groups[0].split(':') : [];
  const right = groups.length > 1 && groups[1] ? groups[1].split(':') : [];
  const expandDotted = (parts: string[]): string[] | false => {
    const dotted = parts.at(-1);
    if (!dotted?.includes('.')) return parts;
    const octets = dotted.split('.').map(Number);
    if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
    return [...parts.slice(0, -1), ((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16)];
  };
  const expandedLeft = expandDotted(left);
  const expandedRight = expandDotted(right);
  if (expandedLeft === false || expandedRight === false) return false;
  const expanded = groups.length === 2
    ? [...expandedLeft, ...Array(8 - expandedLeft.length - expandedRight.length).fill('0'), ...expandedRight]
    : expandedLeft;
  if (expanded.length !== 8) return false;
  const zero = (group: string) => /^0+$/u.test(group);
  if (expanded.every(zero)) return true;
  return expanded.slice(0, 5).every(zero)
    && expanded[5]?.toLowerCase() === 'ffff'
    && zero(expanded[6] ?? '') && zero(expanded[7] ?? '');
}

function readPort(value: string | undefined, name: string): number {
  if (value === undefined || !/^[1-9][0-9]{0,4}$/u.test(value)) {
    throw new Error(`${name} must be a TCP port`);
  }
  const port = Number(value);
  if (port > 65535) throw new Error(`${name} must be a TCP port`);
  return port;
}

export function resolveCompanyListenOptions(env: NodeJS.ProcessEnv): CompanyListenOptions {
  const host = env.COMPANY_HOST;
  if (host === undefined || !isValidCompanyHost(host)) {
    throw new Error(host === undefined
      ? 'COMPANY_HOST must be an explicit non-wildcard host'
      : `COMPANY_HOST ${host} must be an explicit non-wildcard host`);
  }
  return { host, port: readPort(env.COMPANY_PORT, 'COMPANY_PORT') };
}

export function isValidCompanyHost(host: string): boolean {
  return host.length > 0
    && !WILDCARD_HOSTS.has(host)
    && !isUnspecifiedIp(host)
    && !/[\s/\\]/u.test(host);
}

export function companyHttpOrigin(options: CompanyListenOptions): string {
  const host = options.host.includes(':') && !options.host.startsWith('[')
    ? `[${options.host}]`
    : options.host;
  return `http://${host}:${options.port}`;
}

export function isAllowedCompanyHost(
  host: string | undefined,
  options: CompanyListenOptions
): boolean {
  const expectedHost = companyHttpOrigin(options).slice('http://'.length);
  return host === expectedHost;
}

export function isAllowedCompanyOrigin(
  origin: string | undefined,
  options: CompanyListenOptions,
  originRequired = false
): boolean {
  return origin === undefined ? !originRequired : origin === companyHttpOrigin(options);
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
