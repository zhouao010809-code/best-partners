# Phase 0 Foundation and Local REST Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Create the independent source repository, secure local runtime, state kernel, and a factual Local REST 5.1.0 capability profile without writing to the formal vault.

**Architecture:** A single TypeScript package exposes a React/Vite client and a Fastify server. The server owns configuration, security, SQLite, and a VaultGateway interface. A guarded contract harness may write only to a sentinel-marked independent test vault and records whether formal write CAS is actually possible.

**Tech Stack:** Node 22.22, npm 10, React 19.2, Vite 8.2, TypeScript 6.0, Fastify 5.12, better-sqlite3 13, Zod 4.5, Vitest 4.1

---

All paths below are relative to PROJECT_ROOT.

### Task 1: Initialize the repository and prove both processes build

**Files:**
- Create: package.json
- Create: .gitignore
- Create: .nvmrc
- Create: .env.example
- Create: index.html
- Create: tsconfig.json
- Create: tsconfig.client.json
- Create: tsconfig.server.json
- Create: vite.config.ts
- Create: vitest.config.ts
- Create: vitest.client.config.ts
- Create: vitest.integration.config.ts
- Create: vitest.contract.config.ts
- Create: src/server/app.ts
- Create: src/server/index.ts
- Create: src/client/main.tsx
- Create: src/client/App.tsx
- Create: scripts/copy-server-assets.ts
- Create: tests/helpers/setup-dom.ts
- Test: tests/integration/health-route.test.ts
- Test: tests/component/app-smoke.test.tsx

- [ ] **Step 1: Initialize Git only in the source directory**

Run:

~~~bash
cd 'PROJECT_ROOT'
git init -b main
~~~

Expected: Initialized empty Git repository under xiaozhao-brain-console/.git. Confirm that git -C ~/我的大脑 rev-parse still fails.

- [ ] **Step 2: Add package and tool configuration**

Write package.json exactly:

~~~json
{
  "name": "xiaozhao-brain-console",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.12"
  },
  "scripts": {
    "dev": "concurrently -k -n WEB,API \"vite --host 127.0.0.1\" \"tsx watch src/server/index.ts\"",
    "build": "npm run typecheck && vite build && npm run build:server",
    "build:server": "tsup src/server/index.ts --format esm --platform node --out-dir dist/server --clean && tsx scripts/copy-server-assets.ts",
    "start": "NODE_ENV=production node dist/server/index.js",
    "typecheck": "tsc -p tsconfig.client.json && tsc -p tsconfig.server.json",
    "test": "vitest run",
    "test:unit": "vitest run --config vitest.config.ts tests/unit",
    "test:integration": "vitest run --config vitest.integration.config.ts tests/integration",
    "test:component": "vitest run --config vitest.client.config.ts tests/component",
    "test:security": "vitest run --config vitest.integration.config.ts tests/integration/security",
    "test:contract:obsidian:probe": "vitest run --config vitest.contract.config.ts tests/contract/obsidian-local-rest-5.1.0 --no-file-parallelism",
    "test:contract:obsidian:restart:prepare": "vitest run --config vitest.contract.config.ts tests/contract/obsidian-local-rest-5.1.0/restart-prepare.contract.test.ts --no-file-parallelism",
    "test:contract:obsidian:restart:verify": "vitest run --config vitest.contract.config.ts tests/contract/obsidian-local-rest-5.1.0/restart-verify.contract.test.ts --no-file-parallelism",
    "gate:write-capability": "tsx scripts/gate-write-capability.ts",
    "test:e2e": "playwright test",
    "verify": "npm run typecheck && npm run test && npm run build"
  },
  "dependencies": {
    "@fastify/cookie": "11.1.2",
    "@fastify/static": "10.1.3",
    "better-sqlite3": "13.0.3",
    "diff": "9.0.0",
    "fastify": "5.12.1",
    "lucide-react": "1.37.0",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "react-markdown": "10.1.0",
    "react-router-dom": "7.18.3",
    "remark-gfm": "4.0.1",
    "ulid": "3.0.2",
    "yaml": "2.9.0",
    "zod": "4.5.4"
  },
  "devDependencies": {
    "@axe-core/playwright": "4.13.0",
    "@playwright/test": "1.62.1",
    "@testing-library/jest-dom": "7.0.1",
    "@testing-library/react": "16.3.3",
    "@testing-library/user-event": "14.6.6",
    "@types/better-sqlite3": "9.6.0",
    "@types/node": "26.4.0",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.5",
    "@vitejs/plugin-react": "6.1.1",
    "@vitest/coverage-v8": "4.1.11",
    "concurrently": "10.0.5",
    "fast-check": "4.9.0",
    "jsdom": "30.0.1",
    "tsx": "4.23.13",
    "tsup": "8.5.1",
    "typescript": "6.0.2",
    "vite": "8.2.2",
    "vitest": "4.1.11"
  }
}
~~~

Write .nvmrc as 22.22.3. Write .gitignore with node_modules, dist, coverage, playwright-report, test-results, .env, .local, *.sqlite3*, and .DS_Store. Write .env.example with non-secret names:

~~~dotenv
APP_HOST=127.0.0.1
APP_PORT=4317
APP_DATA_DIR=~/Library/Application Support/best-partners
VAULT_REAL_ROOT=~/我的大脑
OBSIDIAN_API_URL=https://127.0.0.1:27124
OBSIDIAN_API_KEY=
MODEL_BASE_URL=https://api.deepseek.com
MODEL_NAME=
MODEL_API_KEY=
WRITE_ENABLED=false
~~~

Use tsconfig.json only for project references. Use strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, ES2022, and noEmit in both client and server configs. vite.config.ts must proxy /api to http://127.0.0.1:4317 and build the client to dist/client.

Use separate Vitest configurations:

- vitest.config.ts: Node unit tests only.
- vitest.client.config.ts: jsdom component tests with jest-dom setup.
- vitest.integration.config.ts: Node integration and security tests with serial database helpers where required.
- vitest.contract.config.ts: real-plugin contract tests, single worker, 60-second timeout, no retries, no ordinary test inclusion.

tests/helpers/setup-dom.ts contains:

~~~ts
import '@testing-library/jest-dom/vitest';
~~~

The client config uses environment jsdom and that setup file. The other three configs use environment node. Every config has an explicit include pattern so no real-plugin test can enter npm test, npm run test:unit, npm run test:component, or npm run test:integration.

- [ ] **Step 3: Install and lock dependencies**

Run:

~~~bash
npm install
~~~

Expected: package-lock.json is created, npm reports zero install errors, and node_modules remains outside the Obsidian vault.

- [ ] **Step 4: Write failing server and client smoke tests**

Create tests/integration/health-route.test.ts:

~~~ts
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server/app.js';

describe('GET /api/v1/health', () => {
  const servers: Array<ReturnType<typeof buildServer>> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('returns a versioned boot snapshot', async () => {
    const server = buildServer();
    servers.push(server);
    const response = await server.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        status: 'booting',
        apiVersion: 'v1',
        writeGate: 'closed'
      },
      version: 1
    });
  });
});
~~~

Create tests/component/app-smoke.test.tsx:

~~~tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from '../../src/client/App.js';

describe('App', () => {
  it('names the product and reports safe initialization', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: '小兆大脑' })).toBeInTheDocument();
    expect(screen.getByText('安全初始化中')).toBeInTheDocument();
  });
});
~~~

- [ ] **Step 5: Run the tests and verify red**

Run:

~~~bash
npm run test:integration
npm run test:component
~~~

Expected: both suites load and fail at the response/body assertions. A missing module or type error is not an accepted RED; add only the typed export shell needed to reach the behavioral assertion.

- [ ] **Step 6: Add the minimal server and client**

Create src/server/app.ts:

~~~ts
import Fastify from 'fastify';

export function buildServer() {
  const app = Fastify({ logger: false });
  app.get('/api/v1/health', async () => ({
    data: {
      status: 'booting' as const,
      apiVersion: 'v1' as const,
      writeGate: 'closed' as const
    },
    version: 1
  }));
  return app;
}
~~~

Create src/server/index.ts:

~~~ts
import { buildServer } from './app.js';

const host = process.env.APP_HOST ?? '127.0.0.1';
const port = Number(process.env.APP_PORT ?? '4317');
const app = buildServer();

await app.listen({ host, port });
~~~

Create src/client/App.tsx:

~~~tsx
export default function App() {
  return (
    <main>
      <h1>小兆大脑</h1>
      <p>安全初始化中</p>
    </main>
  );
}
~~~

Create src/client/main.tsx:

~~~tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');
createRoot(root).render(<StrictMode><App /></StrictMode>);
~~~

Create index.html with a root div, meta name=csp-nonce content=__CSP_NONCE__, and a module script for /src/client/main.tsx. Do not add inline scripts or inline styles.

Create scripts/copy-server-assets.ts to copy src/server/db/migrations into dist/server/db/migrations when the source directory exists. It must create the destination recursively and exit successfully before the first migration file is added.

- [ ] **Step 7: Verify green and build**

Run:

~~~bash
npm run test:integration
npm run test:component
npm run typecheck
npm run build
~~~

Expected: both tests pass; typecheck exits 0; dist/client and dist/server/index.js exist.

- [ ] **Step 8: Commit**

~~~bash
git add .
git commit -m "chore: initialize local brain console"
~~~

### Task 2: Validate environment and vault-relative paths

**Files:**
- Create: src/server/config.ts
- Create: src/server/security/vault-path.ts
- Create: src/shared/api/errors.ts
- Test: tests/unit/config.test.ts
- Test: tests/unit/vault-path.test.ts

- [ ] **Step 1: Write failing configuration and path tests**

Create tests/unit/vault-path.test.ts:

~~~ts
import { describe, expect, it } from 'vitest';
import { normalizeVaultPath } from '../../src/server/security/vault-path.js';

describe('normalizeVaultPath', () => {
  it.each([
    '/etc/passwd',
    '../02知识库/a.md',
    '01图书馆/../../x.md',
    '01图书馆\\x.md',
    '.obsidian/plugins/x',
    '02知识库/%252e%252e/x.md'
  ])('rejects %s', (value) => {
    expect(() => normalizeVaultPath(value, 'read')).toThrowError('PATH_NOT_ALLOWED');
  });

  it('normalizes Unicode and accepts an allowed markdown path', () => {
    expect(normalizeVaultPath('01图书馆/来自个人/资料.md', 'read'))
      .toBe('01图书馆/来自个人/资料.md');
  });

  it('prevents writes to the rules area', () => {
    expect(() => normalizeVaultPath('00大脑规则/00_大脑规范.md', 'write'))
      .toThrowError('PATH_NOT_ALLOWED');
  });
});
~~~

Create tests/unit/config.test.ts with a complete valid environment and assertions that WRITE_ENABLED defaults false, host must equal 127.0.0.1, secrets cannot be empty when their integration is enabled, and APP_DATA_DIR cannot resolve inside VAULT_REAL_ROOT.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:unit
~~~

Expected: the suite loads and fails at the first path/configuration behavior assertion. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Implement stable error codes and path policy**

Create src/shared/api/errors.ts:

~~~ts
export const ErrorCode = {
  PathNotAllowed: 'PATH_NOT_ALLOWED',
  VersionConflict: 'VERSION_CONFLICT',
  WriteGateClosed: 'WRITE_GATE_CLOSED',
  SchemaInvalid: 'SCHEMA_INVALID',
  RunAlreadyActive: 'RUN_ALREADY_ACTIVE',
  PlanStale: 'PLAN_STALE',
  RecoveryRequired: 'RECOVERY_REQUIRED',
  StreamReset: 'STREAM_RESET'
} as const;

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
  }
}
~~~

Create src/server/security/vault-path.ts:

~~~ts
import { AppError, ErrorCode } from '../../shared/api/errors.js';

const READ_ROOTS = ['00大脑规则/', '01图书馆/', '02知识库/'];
const WRITE_ROOTS = ['01图书馆/', '02知识库/'];

export function normalizeVaultPath(input: string, mode: 'read' | 'write'): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    throw new AppError(ErrorCode.PathNotAllowed, 'PATH_NOT_ALLOWED');
  }
  const value = decoded.normalize('NFC');
  if (
    value.length === 0
    || value.startsWith('/')
    || value.includes('\\')
    || value.includes('\0')
    || value.split('/').some((part) => part === '..' || part === '.' || part.startsWith('.'))
    || /%[0-9a-f]{2}/i.test(value)
  ) {
    throw new AppError(ErrorCode.PathNotAllowed, 'PATH_NOT_ALLOWED');
  }
  const roots = mode === 'read' ? READ_ROOTS : WRITE_ROOTS;
  if (!roots.some((root) => value.startsWith(root))) {
    throw new AppError(ErrorCode.PathNotAllowed, 'PATH_NOT_ALLOWED');
  }
  return value;
}
~~~

Implement src/server/config.ts with a Zod object that parses the exact environment variables from .env.example, resolves APP_DATA_DIR and VAULT_REAL_ROOT with realpath when present, rejects containment in either direction, and never includes secret values in thrown messages.

- [ ] **Step 4: Verify green**

Run:

~~~bash
npm run test:unit
npm run typecheck
~~~

Expected: all unit tests pass and typecheck exits 0.

- [ ] **Step 5: Commit**

~~~bash
git add src/server/config.ts src/server/security src/shared/api tests/unit .env.example
git commit -m "feat: add fail-closed configuration and path policy"
~~~

### Task 3: Add the VaultGateway and Local REST 5.1.0 read client

**Files:**
- Create: src/server/vault/VaultGateway.ts
- Create: src/server/vault/LocalRest51Gateway.ts
- Create: src/server/vault/raw-bytes.ts
- Create: src/server/vault/capability-profile.ts
- Test: tests/unit/local-rest-gateway.test.ts
- Test: tests/unit/capability-profile.test.ts

- [ ] **Step 1: Write failing tests for byte fidelity and capability classification**

The gateway test must inject a fake fetch implementation and assert:

~~~ts
const note = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]);
const result = await gateway.readRaw('01图书馆/a.md');
expect(result.bytes).toEqual(note);
expect(result.rawSha256).toBe('ea3948106c12d96eaf84d4bb8be214b194c3442acb99a3005251960b0ec2ba63');
expect(fakeFetch.lastAuthorization()).toBe('[redacted]');
~~~

The capability test must feed an OpenAPI document where PATCH has If-Match but PUT and DELETE do not. Assert safeReplace is true, safeCreate and safeDelete are false, and formalWriteGate is blocked.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:unit -- local-rest
~~~

Expected: the suite loads and fails at byte fidelity or capability classification. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Define the gateway boundary**

Create src/server/vault/VaultGateway.ts:

~~~ts
export type VersionedBytes = {
  path: string;
  bytes: Uint8Array;
  rawSha256: string;
  upstreamVersion?: string;
};

export type VaultCapabilityProfile = {
  pluginId: string;
  pluginVersion: string;
  obsidianVersion: string;
  safeRead: boolean;
  safeReplace: boolean;
  safeCreate: boolean;
  safeRestore: boolean;
  safeDelete: boolean;
  restartPersistence: 'unverified' | 'passed' | 'failed';
  formalWriteGate: 'passed' | 'blocked';
  evidence: ReadonlyArray<string>;
};

export interface VaultGateway {
  fingerprint(): Promise<Pick<VaultCapabilityProfile, 'pluginId' | 'pluginVersion' | 'obsidianVersion'>>;
  listDirectory(path: string): Promise<ReadonlyArray<string>>;
  readRaw(path: string): Promise<VersionedBytes>;
  readOpenApi(): Promise<string>;
}
~~~

Implement sha256Bytes in raw-bytes.ts with node:crypto and no string conversion.

Implement LocalRest51Gateway with:

- Authorization header created inside the server only.
- GET / for fingerprint.
- GET /vault/{each-segment-encoded} with Accept: text/markdown.
- GET of the same file with Accept: application/vnd.olrapi.document-map+json to obtain the version token.
- GET /vault/{directory-segments}/ for directory listing.
- GET /openapi.yaml.
- ArrayBuffer response handling and a 10 MiB response limit.
- Error mapping that records status and operationId but never the key or response body.

Because raw bytes and document-map version require separate requests, readRaw performs raw A -> document map -> raw B and returns only when SHA-256(A) equals SHA-256(B). Retry the triple at most twice; continued change returns VERSION_CONFLICT. Contract tests mutate between requests and prove the gateway never pairs bytes with a version from a different document state.

- [ ] **Step 4: Implement the read-only capability classifier**

Parse openapi.yaml with yaml. The classifier must inspect actual method parameters, not search raw strings. A capability can be passed only by executable contract evidence; the OpenAPI classifier may mark a feature declared or missing, never passed.

~~~ts
export function closeWriteGate(profile: Omit<VaultCapabilityProfile, 'formalWriteGate'>): VaultCapabilityProfile {
  const passed = profile.safeRead
    && profile.safeReplace
    && profile.safeCreate
    && profile.safeRestore
    && profile.safeDelete
    && profile.restartPersistence === 'passed';
  return { ...profile, formalWriteGate: passed ? 'passed' : 'blocked' };
}
~~~

- [ ] **Step 5: Verify green**

Run:

~~~bash
npm run test:unit
npm run typecheck
~~~

Expected: byte-fidelity and classification tests pass; no test logs an Authorization value.

- [ ] **Step 6: Commit**

~~~bash
git add src/server/vault tests/unit
git commit -m "feat: add versioned Local REST read gateway"
~~~

### Task 4: Build the guarded real-plugin contract harness

**Files:**
- Create: tests/helpers/test-vault-guard.ts
- Create: tests/contract/obsidian-local-rest-5.1.0/read.contract.test.ts
- Create: tests/contract/obsidian-local-rest-5.1.0/write-gate.contract.test.ts
- Create: tests/contract/obsidian-local-rest-5.1.0/restart-prepare.contract.test.ts
- Create: tests/contract/obsidian-local-rest-5.1.0/restart-verify.contract.test.ts
- Create: src/server/vault/contract-profile-store.ts
- Create: scripts/gate-write-capability.ts
- Create: docs/contracts/local-rest-5.1.0.md

- [ ] **Step 1: Write the isolation guard**

Create tests/helpers/test-vault-guard.ts with one exported function:

~~~ts
export async function assertContractTestVault(input: {
  gateway: import('../../src/server/vault/VaultGateway.js').VaultGateway;
  testVaultRoot: string;
  formalVaultRoot: string;
  sourceRoot: string;
  appDataRoot: string;
  allowWrite: string | undefined;
}): Promise<void> {
  if (input.allowWrite !== '1') throw new Error('CONTRACT_WRITE_NOT_ARMED');
  const fs = await import('node:fs/promises');
  const roots = await Promise.all([
    fs.realpath(input.testVaultRoot),
    fs.realpath(input.formalVaultRoot),
    fs.realpath(input.sourceRoot),
    fs.realpath(input.appDataRoot)
  ]);
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      const leftRoot = roots[left]!;
      const rightRoot = roots[right]!;
      if (leftRoot === rightRoot
        || leftRoot.startsWith(rightRoot + '/')
        || rightRoot.startsWith(leftRoot + '/')) {
        throw new Error('CONTRACT_ROOTS_NOT_ISOLATED');
      }
    }
  }
  const marker = await input.gateway.readRaw('__XIAOZHAO_TEST_VAULT__');
  const restMarker = new TextDecoder().decode(marker.bytes).trim();
  const diskMarker = (await fs.readFile(roots[0]! + '/__XIAOZHAO_TEST_VAULT__', 'utf8')).trim();
  if (restMarker !== 'xiaozhao-contract-v1' || restMarker !== diskMarker) {
    throw new Error('TEST_VAULT_SENTINEL_MISSING');
  }
}
~~~

Every destructive contract test must call this function before creating its random sandbox prefixes. Test files may exist only under 01图书馆/来自其他/__xiaozhao_contract__/{ULID}/ and 02知识库/99其他/__xiaozhao_contract__/{ULID}/. Cleanup may touch only the current ULID and must use non-permanent trash behavior.

- [ ] **Step 2: Write read and CAS probe tests**

The real tests must cover:

1. Fingerprint is exactly plugin id obsidian-local-rest-api and major version 5.
2. Raw bytes preserve BOM, CRLF, final newline, and Chinese filename segments.
3. A stale PATCH If-Match returns 412 and leaves bytes unchanged.
4. Two concurrent clients using the same version yield exactly one successful replacement.
5. A create primitive fails rather than overwrites when the final path already exists.
6. A restore primitive only changes afterHash back to beforeHash.
7. A delete primitive refuses when the current bytes no longer equal afterHash.
8. Every successful mutation is followed by raw-byte reread.
9. External create, modify, rename, and delete operations change the directory/metadata projection in a way the 15-second poller can observe.
10. A metadata signal never claims unchanged while raw bytes changed; otherwise the profile requires full raw reread polling.

Do not weaken assertions to match the plugin. Record each result in a VaultCapabilityProfile. The contract command itself may pass while formalWriteGate is blocked, because accurate negative capability evidence is a valid probe result.

- [ ] **Step 3: Add the two-phase restart check**

restart-prepare creates a sandbox note, records its path and hashes under APP_DATA_DIR/contract-profiles/restart-pending.json, and prints only:

~~~text
Restart Obsidian, then run npm run test:contract:obsidian:restart:verify
~~~

restart-verify rereads the same note after a human restart, verifies the bytes and version behavior, updates restartPersistence, and trashes only the sandbox note. Until verify passes, restartPersistence remains unverified and formalWriteGate remains blocked.

- [ ] **Step 4: Persist and document the profile**

contract-profile-store.ts must write a canonical JSON profile with mode 0600 and an atomic temp-file rename. The profile key is plugin id + plugin version + Obsidian version + OpenAPI SHA-256. A fingerprint mismatch closes the runtime write gate.

Generate docs/contracts/local-rest-5.1.0.md from the profile. It must list passed, failed, and unverified operations with timestamps and never include the API key, vault content, or absolute test-note contents.

- [ ] **Step 5: Run the read probe first**

Run without write arming:

~~~bash
npm run test:contract:obsidian:probe -- read
~~~

Expected: read-only fingerprint and OpenAPI tests can pass. Any mutation test fails with CONTRACT_WRITE_NOT_ARMED.

- [ ] **Step 6: Run against a sentinel-marked independent test vault**

After the user opens the independent vault, installs Local REST 5.1.0, creates the sentinel, and supplies secrets through the shell:

~~~bash
ALLOW_OBSIDIAN_CONTRACT_WRITE=1 npm run test:contract:obsidian:probe
~~~

Expected on the currently observed OpenAPI: the probe command exits 0 after accurately recording evidence; safeReplace may pass while safeCreate or safeDelete is blocked. The generated profile must then say formalWriteGate=blocked. Do not edit production code to force a pass.

- [ ] **Step 7: Enforce the write-capability gate separately**

Implement scripts/gate-write-capability.ts to load the exact current fingerprint profile and exit non-zero unless safeRead, safeCreate, safeReplace, safeRestore, safeDelete, reread verification, and restartPersistence all passed.

Run:

~~~bash
npm run gate:write-capability
~~~

Expected: exit 0 only for a complete passed profile. A blocked or unverified profile prints missing capability names and exits 1.

- [ ] **Step 8: Commit the harness and non-secret report**

~~~bash
git add tests/contract tests/helpers src/server/vault/contract-profile-store.ts docs/contracts
git commit -m "test: add guarded Local REST capability gate"
~~~

### Task 5: Add the same-origin security kernel

**Files:**
- Create: src/server/security/origin-host.ts
- Create: src/server/security/session.ts
- Create: src/server/security/csrf.ts
- Create: src/server/security/csp.ts
- Modify: src/server/app.ts
- Test: tests/integration/security/local-http-security.test.ts

- [ ] **Step 1: Write failing security tests**

Use Fastify inject to assert:

- Host other than 127.0.0.1:4317 is 421.
- Origin other than the exact production origin is 403.
- A mutation without session cookie is 401.
- A mutation without matching CSRF token is 403.
- JSON above 1 MiB is 413.
- CSP contains object-src none, frame-ancestors none, base-uri none, style-src-attr none, and one per-response style nonce.
- Error envelopes do not contain Authorization, apiKey, MODEL_API_KEY, or absolute vault content.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:security
~~~

Expected: the suite loads and fails at Host, Origin, session, CSRF, size, or CSP assertions. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Implement exact Host, Origin, session, and CSRF checks**

Use a random 32-byte server session secret generated at process start. Set a HttpOnly, SameSite=Strict, Path=/ cookie after serving the bootstrap endpoint. Bind a separate CSRF token to the session id and require it in X-CSRF-Token for POST, PATCH, PUT, and DELETE. Allow the exact Vite development origin only when NODE_ENV is development.

Do not store the Obsidian or model key in cookies, HTML, SQLite, or the browser.

- [ ] **Step 4: Implement CSP nonce delivery**

Generate one base64url nonce per HTML response. Replace __CSP_NONCE__ in the built index and set:

~~~text
default-src 'self';
script-src 'self';
connect-src 'self';
style-src-elem 'self' 'nonce-{nonce}';
style-src-attr 'none';
img-src 'self' data: blob:;
object-src 'none';
frame-ancestors 'none';
base-uri 'none';
form-action 'self'
~~~

Expose the same nonce only in meta name=csp-nonce for MaterialDeck dynamic style elements. Do not use unsafe-inline.

- [ ] **Step 5: Verify green**

Run:

~~~bash
npm run test:security
npm run typecheck
~~~

Expected: all security tests pass.

- [ ] **Step 6: Commit**

~~~bash
git add src/server/security src/server/app.ts tests/integration/security
git commit -m "feat: secure the loopback HTTP boundary"
~~~

### Task 6: Add the SQLite state kernel and external recovery roots

**Files:**
- Create: src/server/db/database.ts
- Create: src/server/db/migrate.ts
- Create: src/server/db/backup.ts
- Create: src/server/db/migrations/001_initial.sql
- Create: src/server/db/permissions.ts
- Test: tests/integration/database-kernel.test.ts

- [ ] **Step 1: Write failing database tests**

The test must create a temporary application-data root and assert:

- directory mode 0700 and database mode 0600;
- journal_mode is wal and foreign_keys is 1;
- migration is idempotent;
- duplicate active run for the same material path/source hash is rejected;
- duplicate idempotency key is rejected;
- integrity_check returns ok;
- backup rotation retains exactly three valid backups;
- recovery directory is outside both SQLite and the vault.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:integration -- database-kernel
~~~

Expected: the suite loads and fails at WAL, permissions, migration, constraint, or backup assertions. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Add the initial schema**

001_initial.sql must create:

~~~sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE extraction_runs (
  id TEXT PRIMARY KEY,
  material_path TEXT NOT NULL,
  source_raw_sha256 TEXT NOT NULL,
  reading_state TEXT NOT NULL CHECK (reading_state IN ('已看', '未看')),
  state TEXT NOT NULL,
  candidate_set_hash TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX one_active_run_per_material_version
ON extraction_runs(material_path, source_raw_sha256)
WHERE state NOT IN ('completed', 'invalidated');

CREATE TABLE idempotency_records (
  key TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE search_index (
  path TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  upstream_version TEXT,
  yaml_json TEXT NOT NULL,
  links_json TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);

CREATE TABLE schema_issues (
  path TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  detail TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
~~~

Later phase migrations add candidate and write tables. Do not pre-create unused columns.

- [ ] **Step 4: Implement startup and backup behavior**

database.ts opens the file after applying permissions, sets WAL, foreign_keys, busy_timeout, and runs integrity_check. migrate.ts wraps each migration in one transaction. backup.ts uses better-sqlite3 backup, verifies the copy with integrity_check, atomically renames it, and keeps the newest three.

If integrity_check fails, do not rename or delete the damaged database. Start recovery-only mode and scan the external recovery directory before offering any restore.

- [ ] **Step 5: Verify green**

Run:

~~~bash
npm run test:integration -- database-kernel
npm run typecheck
~~~

Expected: all database kernel tests pass.

- [ ] **Step 6: Commit**

~~~bash
git add src/server/db tests/integration/database-kernel.test.ts
git commit -m "feat: add durable local state kernel"
~~~

### Task 7: Close Phase 0 with an explicit architecture checkpoint

**Files:**
- Create: src/server/services/health-service.ts
- Modify: src/server/app.ts
- Create: docs/architecture/write-gate-decision.md
- Test: tests/integration/health-write-gate.test.ts

- [ ] **Step 1: Write the failing health-gate test**

Assert that a blocked profile returns:

~~~json
{
  "status": "ready",
  "writeGate": {
    "status": "blocked",
    "missing": ["safeCreate", "safeDelete", "restartPersistence"],
    "fingerprintMatches": true
  }
}
~~~

Also assert that WRITE_ENABLED=true cannot override a missing capability.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:integration -- health-write-gate
~~~

Expected: the suite loads and fails because the health projection does not yet report the blocked capability reasons. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Implement the health projection**

health-service.ts combines configuration, plugin fingerprint, capability profile, database health, and recovery scan. It returns reasons, never secrets. app.ts exposes it through GET /api/v1/health.

- [ ] **Step 4: Write the architecture checkpoint**

docs/architecture/write-gate-decision.md must contain the generated evidence table and one of two final states:

~~~text
G2 PASSED
Phase 3 may use LocalRest51Gateway.
~~~

or:

~~~text
G2 BLOCKED
Phase 1 and Phase 2 may continue.
Phase 3 real writes require a separately approved companion Obsidian plugin gateway or remain draft-only.
~~~

Do not recommend direct unguarded filesystem writes as an automatic fallback.

- [ ] **Step 5: Run complete Phase 0 verification**

Run:

~~~bash
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:component
npm run test:security
npm run build
~~~

Expected: all local tests pass and build exits 0. Separately report G0, G1, and G2 from the contract profile; do not summarize a blocked G2 as a passing write implementation.

- [ ] **Step 6: Commit**

~~~bash
git add src/server/services src/server/app.ts docs/architecture tests/integration
git commit -m "docs: record the formal write capability decision"
~~~
