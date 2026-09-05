export interface HttpPolicy {
  isAllowedHost(host: string | undefined): boolean;
  isAllowedOrigin(origin: string | undefined, originRequired?: boolean): boolean;
}

export interface LoopbackPolicy extends HttpPolicy {
  bind(origin: string): void;
}

export function createLoopbackPolicy(): LoopbackPolicy {
  let boundOrigin: string | undefined;
  let boundHost: string | undefined;
  return {
    bind(origin) {
      if (boundOrigin !== undefined) throw new Error('LOOPBACK_POLICY_ALREADY_BOUND');
      const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(origin);
      if (match === null || Number(match[1]) > 65535) throw new Error('INVALID_LOOPBACK_ORIGIN');
      boundOrigin = origin;
      boundHost = origin.slice('http://'.length);
    },
    isAllowedHost: (host) => boundHost !== undefined && host === boundHost,
    isAllowedOrigin: (origin, originRequired = false) => origin === undefined
      ? !originRequired
      : boundOrigin !== undefined && origin === boundOrigin
  };
}
