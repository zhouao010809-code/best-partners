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

function stripIpv6Brackets(host: string): { value: string; bracketed: boolean } | undefined {
  const starts = host.startsWith('[');
  const ends = host.endsWith(']');
  if (starts !== ends) return undefined;
  return starts ? { value: host.slice(1, -1), bracketed: true } : { value: host, bracketed: false };
}

function parseIpv4(value: string): readonly [number, number, number, number] | undefined {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/u.test(part))) return undefined;
  const octets = parts.map(Number);
  if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
  const [first, second, third, fourth] = octets;
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) return undefined;
  return [first, second, third, fourth];
}

function expandIpv6(value: string): readonly number[] | undefined {
  if (value.includes('%')) return undefined;
  const sections = value.split('::');
  if (sections.length > 2) return undefined;
  const parseSection = (section: string): number[] | undefined => {
    if (section === '') return [];
    const parts = section.split(':');
    if (parts.some(part => part === '')) return undefined;
    const groups: number[] = [];
    for (const [index, part] of parts.entries()) {
      if (part.includes('.')) {
        if (index !== parts.length - 1) return undefined;
        const octets = parseIpv4(part);
        if (octets === undefined) return undefined;
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/iu.test(part)) return undefined;
        groups.push(Number.parseInt(part, 16));
      }
    }
    return groups;
  };
  const left = parseSection(sections[0] ?? '');
  const right = sections.length === 2 ? parseSection(sections[1] ?? '') : [];
  if (left === undefined || right === undefined) return undefined;
  if (sections.length === 1) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  return missing > 0 ? [...left, ...Array(missing).fill(0), ...right] : undefined;
}

function isUnspecifiedIp(host: string): boolean {
  const stripped = stripIpv6Brackets(host);
  if (stripped === undefined) return false;
  const value = stripped.value;
  const ipv4 = parseIpv4(value);
  if (ipv4 !== undefined) return ipv4.every(octet => octet === 0);
  if (!value.includes(':')) return false;
  const groups = expandIpv6(value);
  if (groups === undefined) return false;
  if (groups.every(group => group === 0)) return true;
  return groups.slice(0, 5).every(group => group === 0)
    && groups[5] === 0xffff && groups[6] === 0 && groups[7] === 0;
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
  const stripped = stripIpv6Brackets(host);
  if (stripped === undefined) throw new Error('COMPANY_HOST must be an explicit non-wildcard host');
  return { host: stripped.value, port: readPort(env.COMPANY_PORT, 'COMPANY_PORT') };
}

export function isValidCompanyHost(host: string): boolean {
  const stripped = stripIpv6Brackets(host);
  if (stripped === undefined || stripped.value.length === 0 || /[\s/\\%]/u.test(stripped.value)) return false;
  if (stripped.bracketed && !stripped.value.includes(':')) return false;
  if (WILDCARD_HOSTS.has(stripped.value) || isUnspecifiedIp(stripped.value)) return false;
  if (stripped.value.includes(':')) return expandIpv6(stripped.value) !== undefined;
  if (parseIpv4(stripped.value) !== undefined) return true;
  // Node's resolver accepts numeric shorthand such as `0`, `0.0`, and `0x0`
  // as the wildcard address. Do not let malformed numeric hosts bypass the
  // explicit non-wildcard binding policy.
  if (/^[0-9.]+$/u.test(stripped.value) || /^0x[0-9a-f]+$/iu.test(stripped.value)) return false;
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(stripped.value);
}

export function companyHttpOrigin(options: CompanyListenOptions): string {
  const normalizedHost = stripIpv6Brackets(options.host)?.value ?? options.host;
  const host = normalizedHost.includes(':') ? `[${normalizedHost}]` : normalizedHost;
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
