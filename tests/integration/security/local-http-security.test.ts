import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../../src/server/app.js';

const EXPECTED_HOST = '127.0.0.1:4317';
const PRODUCTION_ORIGIN = 'http://127.0.0.1:4317';
const DEVELOPMENT_ORIGIN = 'http://127.0.0.1:5173';

type TestServer = ReturnType<typeof buildServer>;

const servers: TestServer[] = [];

function createServer(): TestServer {
  const server = buildServer();
  servers.push(server);

  server.post('/api/v1/__security-test/mutation', async () => ({ data: { accepted: true } }));
  server.get('/__security-test/html', async (_request, reply) => reply
    .type('text/html; charset=utf-8')
    .send('<!doctype html><html><head><meta name="csp-nonce" content="__CSP_NONCE__"></head><body></body></html>'));
  server.get('/api/v1/__security-test/error', async () => {
    throw new Error(
      'Authorization: Bearer top-secret; apiKey=obsidian-secret; '
      + 'MODEL_API_KEY=model-secret; /Users/ao/我的大脑/02知识库/private.md'
    );
  });

  return server;
}

function hostHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { host: EXPECTED_HOST, ...extra };
}

function sessionCookie(response: Awaited<ReturnType<TestServer['inject']>>): string {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) {
    throw new Error('bootstrap response did not set a session cookie');
  }
  return value.split(';', 1)[0] ?? '';
}

async function bootstrap(server: TestServer): Promise<{ cookie: string; csrfToken: string }> {
  const response = await server.inject({
    method: 'GET',
    url: '/api/v1/bootstrap',
    headers: hostHeaders()
  });
  expect(response.statusCode).toBe(200);
  return {
    cookie: sessionCookie(response),
    csrfToken: response.json<{ data: { csrfToken: string } }>().data.csrfToken
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('loopback Host and Origin boundary', () => {
  it('rejects every Host except the exact API authority', async () => {
    const server = createServer();

    for (const host of ['localhost:4317', '127.0.0.1', '127.0.0.1:5173', 'evil.test']) {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/health',
        headers: { host }
      });
      expect(response.statusCode, host).toBe(421);
    }

    const accepted = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: hostHeaders()
    });
    expect(accepted.statusCode).toBe(200);
  });

  it('allows only the production Origin outside development', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const server = createServer();

    const accepted = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: hostHeaders({ origin: PRODUCTION_ORIGIN })
    });
    expect(accepted.statusCode).toBe(200);

    for (const origin of [DEVELOPMENT_ORIGIN, 'http://localhost:4317', 'https://127.0.0.1:4317', 'null']) {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/health',
        headers: hostHeaders({ origin })
      });
      expect(response.statusCode, origin).toBe(403);
    }
  });

  it('allows the one fixed Vite Origin only in development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const server = createServer();

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: hostHeaders({ origin: DEVELOPMENT_ORIGIN })
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('signed session and bound CSRF protection', () => {
  it('issues a hardened session cookie and a non-cookie CSRF token at bootstrap', async () => {
    const server = createServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: hostHeaders()
    });

    expect(response.statusCode).toBe(200);
    const setCookie = response.headers['set-cookie'];
    expect(setCookie).toEqual(expect.stringMatching(/HttpOnly/i));
    expect(setCookie).toEqual(expect.stringMatching(/SameSite=Strict/i));
    expect(setCookie).toEqual(expect.stringMatching(/Path=\//i));
    const body = response.json<{ data: { csrfToken: string }; version: number }>();
    expect(body).toEqual({
      data: { csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) },
      version: 1
    });
    expect(String(setCookie)).not.toContain(body.data.csrfToken);
  });

  it('returns 401 when a mutation has no valid signed session cookie', async () => {
    const server = createServer();

    const missing = await server.inject({
      method: 'POST',
      url: '/api/v1/__security-test/mutation',
      headers: hostHeaders({ origin: PRODUCTION_ORIGIN })
    });
    expect(missing.statusCode).toBe(401);

    const session = await bootstrap(server);
    const tamperedCookie = `${session.cookie.slice(0, -1)}${session.cookie.endsWith('A') ? 'B' : 'A'}`;
    const tampered = await server.inject({
      method: 'POST',
      url: '/api/v1/__security-test/mutation',
      headers: hostHeaders({
        origin: PRODUCTION_ORIGIN,
        cookie: tamperedCookie,
        'x-csrf-token': session.csrfToken
      })
    });
    expect(tampered.statusCode).toBe(401);
  });

  it('returns 403 unless the CSRF token is bound to that session', async () => {
    const server = createServer();
    const first = await bootstrap(server);
    const second = await bootstrap(server);

    const missing = await server.inject({
      method: 'POST',
      url: '/api/v1/__security-test/mutation',
      headers: hostHeaders({
        origin: PRODUCTION_ORIGIN,
        cookie: first.cookie
      })
    });
    expect(missing.statusCode).toBe(403);

    const mismatched = await server.inject({
      method: 'POST',
      url: '/api/v1/__security-test/mutation',
      headers: hostHeaders({
        origin: PRODUCTION_ORIGIN,
        cookie: first.cookie,
        'x-csrf-token': second.csrfToken
      })
    });
    expect(mismatched.statusCode).toBe(403);

    const accepted = await server.inject({
      method: 'POST',
      url: '/api/v1/__security-test/mutation',
      headers: hostHeaders({
        origin: PRODUCTION_ORIGIN,
        cookie: first.cookie,
        'x-csrf-token': first.csrfToken
      })
    });
    expect(accepted.statusCode).toBe(200);
  });
});

describe('HTTP payload, CSP, and error containment', () => {
  it('rejects a JSON body above 1 MiB', async () => {
    const server = createServer();
    const session = await bootstrap(server);
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/__security-test/mutation',
      headers: hostHeaders({
        origin: PRODUCTION_ORIGIN,
        cookie: session.cookie,
        'x-csrf-token': session.csrfToken,
        'content-type': 'application/json'
      }),
      payload: JSON.stringify({ content: 'x'.repeat(1024 * 1024) })
    });

    expect(response.statusCode).toBe(413);
  });

  it('delivers a fresh HTML nonce in both CSP and the nonce meta element', async () => {
    const server = createServer();
    const responses = await Promise.all([
      server.inject({ method: 'GET', url: '/__security-test/html', headers: hostHeaders() }),
      server.inject({ method: 'GET', url: '/__security-test/html', headers: hostHeaders() })
    ]);

    const nonces = responses.map((response) => {
      expect(response.statusCode).toBe(200);
      const csp = response.headers['content-security-policy'];
      expect(csp).toEqual(expect.stringContaining("default-src 'self'"));
      expect(csp).toEqual(expect.stringContaining("script-src 'self'"));
      expect(csp).toEqual(expect.stringContaining("connect-src 'self'"));
      expect(csp).toEqual(expect.stringContaining("object-src 'none'"));
      expect(csp).toEqual(expect.stringContaining("frame-ancestors 'none'"));
      expect(csp).toEqual(expect.stringContaining("base-uri 'none'"));
      expect(csp).toEqual(expect.stringContaining("style-src-attr 'none'"));
      expect(csp).not.toContain("'unsafe-inline'");
      const metaNonce = response.body.match(/<meta name="csp-nonce" content="([A-Za-z0-9_-]+)"/u)?.[1];
      expect(metaNonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(csp).toContain(`style-src-elem 'self' 'nonce-${metaNonce}'`);
      expect(csp?.match(/'nonce-/gu)).toHaveLength(1);
      expect(response.body).not.toContain('__CSP_NONCE__');
      return metaNonce;
    });

    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it('never reflects secrets or absolute vault content in error envelopes', async () => {
    const server = createServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/__security-test/error',
      headers: hostHeaders({ authorization: 'Bearer request-secret' })
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Request failed'
      }
    });
    for (const forbidden of [
      'Authorization',
      'request-secret',
      'apiKey',
      'obsidian-secret',
      'MODEL_API_KEY',
      'model-secret',
      '/Users/ao/',
      'private.md'
    ]) {
      expect(response.body).not.toContain(forbidden);
    }
  });
});
