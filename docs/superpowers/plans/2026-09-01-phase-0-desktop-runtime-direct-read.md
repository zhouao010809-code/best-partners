# Phase 0 Desktop Runtime and Direct Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a locally launchable Electron runtime that starts Fastify and SQLite itself, binds an unpredictable loopback port, serves the existing React client from that same origin, and reads `/Users/ao/我的大脑` directly without Obsidian while every formal-write path remains blocked.

**Architecture:** Keep the existing React, Fastify, SQLite, Zod, and indexing layers, but split the read-only vault contract from the legacy Local REST contract and add a descriptor-anchored `FileSystemVaultGateway`. A small read-only C helper starts at `/`, walks every root and relative component with held `openat(...O_NOFOLLOW)` directory descriptors, and streams bounded bytes/list metadata back to Node; pathname prechecks remain defense in depth, not read authority. Move server side effects behind `startServer()`, inject a one-time-bound loopback authority policy, and let the Electron main process own startup and shutdown. This phase deliberately stops before native write primitives, write journals, final app packaging, DMG creation, signing, or notarization.

**Tech Stack:** C11/macOS `openat`, TypeScript 6, Node.js 22, Electron, React 19, Fastify 5, Vite 8, better-sqlite3, Zod 4, Vitest, Playwright Electron.

---

## Scope and non-negotiable gates

- The formal vault remains read-only throughout implementation and automated verification.
- The Electron app must work while Obsidian and Obsidian Local REST are both stopped.
- Fastify listens only on `127.0.0.1` and asks the OS for a free port with `port: 0`.
- The React application is loaded from the returned `http://127.0.0.1:<port>` origin, never from `file://`.
- The renderer has `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
- `writeGate.status` is always `blocked` in this phase, with explicit missing native-write capabilities.
- Do not add `electron-builder.yml`, DMG targets, Electron fuses, signing, notarization, or public-distribution work here. Those belong to the later packaging phase.
- The native helper in this phase is read-only: it has no create/write/append/rename/unlink command. Phase 1 extends the same source/binary with separately tested write primitives.
- Do not delete `LocalRest51Gateway`; retain it for legacy contract tests and optional development use.
- Do not implement intake, DeepSeek, editing, extraction, or formal vault mutation in this phase.

## File structure

### Create

- `src/server/vault/filesystem-path.ts` — lexical root/relative-path normalization and allowlists; it is never the vault-read authority.
- `native/macos/atomic-file-helper.c` — initially read-only descriptor-walking helper; Phase 1 extends this same binary with atomic mutations.
- `scripts/build-native-helper.ts` — deterministic arm64 compilation used by desktop runtime builds.
- `vitest.native.config.ts` — native-contract-only Vitest include boundary; it must never inherit the integration suite's include pattern.
- `src/server/vault/native-read-helper-protocol.ts` — bounded framed read/list/probe response schemas.
- `src/server/vault/NativeReadVaultPort.ts` — no-shell subprocess client and read-only descriptor-anchored port.
- `src/server/vault/FileSystemVaultGateway.ts` — direct, byte-preserving read gateway and optional Obsidian URL opener.
- `src/shared/domain/rule-approval.ts` — strict, renderer-safe rule-approval record and compatibility-status schemas.
- `src/server/rules/rule-compatibility-gate.ts` — the server-side compatibility port plus the only runtime implementation in this phase: deny all.
- `src/server/security/loopback-policy.ts` — fail-closed dynamic Host/Origin policy bound exactly once after `listen({ port: 0 })`.
- `src/server/client-assets.ts` — production asset registration and safe SPA fallback that never turns unknown API routes into HTML.
- `src/server/start-server.ts` — side-effect-free embedded server factory with idempotent shutdown.
- `src/electron/settings-store.ts` — vault-path selection and private app configuration under Electron `userData`.
- `src/electron/window-policy.ts` — pure navigation and external-protocol decisions.
- `src/electron/main.ts` — Electron lifecycle, single-instance lock, embedded server, BrowserWindow, shutdown.
- `src/electron/preload.ts` — minimal frozen bridge for app version and vault selection.
- `src/shared/desktop/bridge.ts` — preload and renderer bridge contract; this is the sole bridge type source.
- `src/client/pages/SettingsPage.tsx` — local vault, index, disabled model card, and blocked write-gate settings.
- `tsconfig.electron.json` — Electron main/preload typecheck boundary.
- `playwright.electron.config.ts` — serial Electron test configuration.
- `tests/unit/filesystem-path.test.ts` — path and symlink boundary tests.
- `tests/unit/native-read-helper-protocol.test.ts` — strict framing, bounds, abort, and safe-error tests.
- `tests/native/native-read-helper.contract.test.ts` — root/entry symlink and rename-race contracts against the real helper.
- `tests/unit/filesystem-vault-gateway.test.ts` — byte fidelity, size, stability, directory and opener tests.
- `tests/unit/loopback-policy.test.ts` — unbound/bound Host and Origin policy tests.
- `tests/unit/desktop-window-policy.test.ts` — navigation and external protocol policy tests.
- `tests/unit/rule-compatibility-gate.test.ts` — strict record, deny-default, and explicit sentinel-fixture approval tests.
- `tests/integration/embedded-server.test.ts` — dynamic port, same-origin client, direct-read API and cleanup tests.
- `tests/electron/desktop-launch.test.ts` — real Electron isolation, launch, navigation and shutdown smoke.
- `tests/helpers/filesystem-vault-fixture.ts` — sentinel-marked temporary read fixture; it must reject the formal vault.
- `tests/helpers/test-rule-compatibility-gate.ts` — test-only approved-gate implementation; it is never imported by production source or packaged.

### Modify

- `package.json`, `package-lock.json` — Electron dependency plus native read-helper build/test scripts only; no packager dependency.
- `vitest.config.ts` — disable `passWithNoTests` so focused unit commands cannot report a false green.
- `tsconfig.json` — reference `tsconfig.electron.json`.
- `src/server/vault/VaultGateway.ts` — separate read/open contracts from Local REST contract fingerprinting.
- `src/server/vault/LocalRest51Gateway.ts` and `src/server/vault/FakeVaultGateway.ts` — implement the new narrow interfaces without behavior changes.
- `src/server/index/SearchIndexer.ts` — depend only on `ReadVaultGateway`.
- `src/server/rules/rule-bundle.ts` — depend only on `ReadVaultGateway` for rule reads.
- `src/server/services/read-service.ts` and `src/server/app.ts` — use the narrow gateway and injected HTTP policy.
- `src/server/services/health-service.ts` — report the direct filesystem source without consulting a Local REST contract profile; keep the write gate blocked.
- `src/shared/api/schemas.ts` — replace the Obsidian-plugin-only health field with a local vault-source field.
- `src/client/api/client.ts`, `src/client/app/AppShell.tsx`, `src/client/app/router.tsx` — render filesystem health and route `/settings`.
- `src/client/vite-env.d.ts` — declare `window.xiaozhaoDesktop` from the shared bridge type.
- Delete `src/client/pages/ConnectionsPage.tsx` after `SettingsPage.tsx` covers its diagnostics.
- `src/server/config.ts` — make CLI Local REST settings separate from desktop server settings.
- `src/server/index.ts` — reduce to the legacy CLI wrapper around `startServer()`.
- `vite.config.ts` — keep development proxy fixed while production Electron uses same-origin assets.
- `src/client/styles/shell.css` — keep the navigation on the left below 800 px instead of moving it to the bottom.
- Existing unit, integration, component, and E2E tests whose health fixture changes from `plugin` to `vaultSource`.

## Public contracts fixed by this plan

```ts
export interface ReadVaultGateway {
  listDirectory(path: string, signal?: AbortSignal): Promise<ReadonlyArray<string>>;
  readRaw(path: string, signal?: AbortSignal): Promise<VersionedBytes>;
}

export interface OpenableVaultGateway extends ReadVaultGateway {
  openInObsidian(path: string, signal?: AbortSignal): Promise<void>;
}

export interface LocalRestContractGateway extends OpenableVaultGateway {
  fingerprint(): Promise<Pick<VaultCapabilityProfile, 'pluginId' | 'pluginVersion' | 'obsidianVersion'>>;
  readOpenApi(): Promise<string>;
}

export interface StartedServer {
  readonly origin: string;
  readonly port: number;
  close(): Promise<void>;
}
```

The filesystem gateway never exposes an absolute vault path through HTTP. API records continue to use normalized vault-relative paths.

### Task 1: Freeze the Phase 0 safety contract and split gateway interfaces

**Files:**
- Create: `src/shared/domain/rule-approval.ts`
- Create: `src/server/rules/rule-compatibility-gate.ts`
- Create: `tests/helpers/test-rule-compatibility-gate.ts`
- Create: `tests/unit/rule-compatibility-gate.test.ts`
- Modify: `src/server/vault/VaultGateway.ts`
- Modify: `src/server/vault/LocalRest51Gateway.ts`
- Modify: `src/server/vault/FakeVaultGateway.ts`
- Modify: `src/server/index/SearchIndexer.ts`
- Modify: `src/server/rules/rule-bundle.ts`
- Modify: `src/server/services/read-service.ts`
- Test: `tests/unit/local-rest-gateway.test.ts`
- Test: `tests/unit/frontmatter-rules.test.ts`
- Test: `tests/integration/search-indexer.test.ts`
- Test: `tests/integration/read-api.test.ts`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Write compile-time and runtime tests for the narrow read interface**

First change the existing unit configuration from `passWithNoTests:true` to `passWithNoTests:false`. This is test-harness hardening, not product implementation: every following explicit unit filter must select at least one file or exit non-zero, so a typo cannot satisfy RED or GREEN.

Add a gateway fixture to `tests/integration/search-indexer.test.ts` that implements only `listDirectory()` and `readRaw()`; instantiate `SearchIndexer` with it. Add a separate fixture in `tests/integration/read-api.test.ts` whose open behavior is provided by an `OpenableVaultGateway`.

```ts
const readOnlyGateway: ReadVaultGateway = {
  async listDirectory(path) {
    return path === '01图书馆' ? ['fixture.md'] : [];
  },
  async readRaw(path) {
    const bytes = new TextEncoder().encode(validLibraryMarkdown);
    return { path, bytes, rawSha256: sha256Bytes(bytes) };
  }
};

const openableGateway: OpenableVaultGateway = {
  ...readOnlyGateway,
  async openInObsidian() {}
};
```

In `tests/unit/frontmatter-rules.test.ts`, require the exact global source order and prove the newly bound admission rule participates in the fingerprint:

```ts
expect(RULE_BUNDLE_SOURCE_PATHS).toEqual([
  '00大脑规则/00_大脑规范.md',
  '00大脑规则/01_总路由规则.md',
  '00大脑规则/02_图书馆入馆规则.md',
  '00大脑规则/03_知识库提炼与入库规则.md',
  '00大脑规则/05_链接命名与治理规则.md'
]);
const before = await loadRuleBundle(gateway);
gateway.set('00大脑规则/02_图书馆入馆规则.md', 'changed admission rule');
const after = await loadRuleBundle(gateway);
expect(after.fingerprint).not.toBe(before.fingerprint);
```

In `tests/unit/rule-compatibility-gate.test.ts`, prove that production source exposes no allow-by-default implementation, malformed/reordered/duplicate approval file entries fail strict parsing, and the runtime deny gate always throws only `RULE_BUNDLE_UNAPPROVED`. The test helper may approve one explicit sentinel fixture fingerprint only after validating a canonical non-formal root carrying either the exact Phase 0 read sentinel or the exact Phase 1 atomic sentinel and an exact record; it must reject the formal vault, a symlink alias, another bundle hash, another validator version, and approval reuse after any rule byte changes. Add a packaging-boundary assertion that no file under `tests/helpers/` is reachable from a production entrypoint.

- [ ] **Step 2: Run the focused tests and verify the interface is still missing**

Run:

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/frontmatter-rules.test.ts
npm exec -- vitest run --config vitest.config.ts tests/unit/rule-compatibility-gate.test.ts
npm exec -- vitest run --config vitest.integration.config.ts tests/integration/search-indexer.test.ts tests/integration/read-api.test.ts
```

Expected: the unit tests fail because rule 02, the compatibility schemas/port, and the deny/test implementations are absent, while TypeScript/Vitest also fails because `ReadVaultGateway` and `LocalRestContractGateway` are not exported and `SearchIndexer` still requires the legacy fingerprint methods.

- [ ] **Step 3: Split the contracts without changing Local REST behavior**

Replace the interface section of `src/server/vault/VaultGateway.ts` with:

```ts
export interface ReadVaultGateway {
  listDirectory(path: string, signal?: AbortSignal): Promise<ReadonlyArray<string>>;
  readRaw(path: string, signal?: AbortSignal): Promise<VersionedBytes>;
}

export interface OpenableVaultGateway extends ReadVaultGateway {
  openInObsidian(path: string, signal?: AbortSignal): Promise<void>;
}

export interface LocalRestContractGateway extends OpenableVaultGateway {
  fingerprint(): Promise<Pick<
    VaultCapabilityProfile,
    'pluginId' | 'pluginVersion' | 'obsidianVersion'
  >>;
  readOpenApi(): Promise<string>;
}

export type VaultGateway = LocalRestContractGateway;
```

Keep the temporary `VaultGateway` alias so the Local REST contract harness does not require a broad rename in this phase. Change `SearchIndexer`, `loadRuleBundle()`, `RuleBundleGuard.start()`, and `RuleBundleGuard.check()` to `ReadVaultGateway`; keep `ReadService` on `OpenableVaultGateway`, and declare `LocalRest51Gateway implements LocalRestContractGateway`. Replace `RULE_BUNDLE_SOURCE_PATHS` with the exact five-path order asserted above, adding `00大脑规则/02_图书馆入馆规则.md` between the routing and knowledge-extraction rules so every plan binds the library admission contract.

Create `src/shared/domain/rule-approval.ts` as the single approval-record source. Its strict Zod schema and inferred type are:

```ts
export const ruleApprovalRecordSchema = z.object({
  schemaVersion: z.literal(1),
  bundleSha256: sha256Schema,
  validatorVersion: z.string().min(1).max(128),
  approvedAt: z.string().datetime(),
  files: z.tuple([
    approvedRuleFileSchema('00大脑规则/00_大脑规范.md'),
    approvedRuleFileSchema('00大脑规则/01_总路由规则.md'),
    approvedRuleFileSchema('00大脑规则/02_图书馆入馆规则.md'),
    approvedRuleFileSchema('00大脑规则/03_知识库提炼与入库规则.md'),
    approvedRuleFileSchema('00大脑规则/05_链接命名与治理规则.md')
  ])
}).strict();
export type RuleApprovalRecord = z.infer<typeof ruleApprovalRecordSchema>;

export function buildRuleApprovalFiles(
  fileHashes: ReadonlyMap<string, string>,
): RuleApprovalRecord['files'] {
  if (fileHashes.size !== 5) throw new AppError('RULE_BUNDLE_UNAPPROVED');
  const hash = (path: string): string => {
    const value = fileHashes.get(path);
    if (!value) throw new AppError('RULE_BUNDLE_UNAPPROVED');
    return value;
  };
  return [
    { path: '00大脑规则/00_大脑规范.md', sha256: hash('00大脑规则/00_大脑规范.md') },
    { path: '00大脑规则/01_总路由规则.md', sha256: hash('00大脑规则/01_总路由规则.md') },
    { path: '00大脑规则/02_图书馆入馆规则.md', sha256: hash('00大脑规则/02_图书馆入馆规则.md') },
    { path: '00大脑规则/03_知识库提炼与入库规则.md', sha256: hash('00大脑规则/03_知识库提炼与入库规则.md') },
    { path: '00大脑规则/05_链接命名与治理规则.md', sha256: hash('00大脑规则/05_链接命名与治理规则.md') },
  ];
}

export type RuleCompatibilityStatus =
  | { readonly status: 'approved'; readonly currentBundleSha256: string;
      readonly approvedBundleSha256: string; readonly validatorVersion: string }
  | { readonly status: 'unapproved'; readonly currentBundleSha256: string;
      readonly approvedBundleSha256: string | null; readonly validatorVersion: string | null;
      readonly reason: 'MISSING_APPROVAL' | 'BUNDLE_CHANGED' | 'VALIDATOR_CHANGED' | 'INVALID_APPROVAL' };
```

`approvedRuleFileSchema(path)` is a strict `{ path: z.literal(path), sha256: sha256Schema }` object, so all five records are present exactly once and in authoritative order. Create `src/server/rules/rule-compatibility-gate.ts` with the only port later phases may depend on:

```ts
export interface RuleCompatibilityGate {
  status(currentBundleSha256: string): Promise<RuleCompatibilityStatus>;
  assertApproved(currentBundleSha256: string): Promise<RuleApprovalRecord>;
}

export class DenyRuleCompatibilityGate implements RuleCompatibilityGate {
  async status(currentBundleSha256: string): Promise<RuleCompatibilityStatus> {
    return {
      status: 'unapproved', currentBundleSha256,
      approvedBundleSha256: null, validatorVersion: null,
      reason: 'MISSING_APPROVAL'
    };
  }
  async assertApproved(_currentBundleSha256: string): Promise<never> {
    throw new AppError('RULE_BUNDLE_UNAPPROVED');
  }
}
```

`buildRuleApprovalFiles()` is the only constructor for the exact tuple; test a missing hash, an extra map entry, reordering attempts, and all five successful entries. Production Phase 0 constructs `DenyRuleCompatibilityGate`; it does not read an approval environment variable, serialized HTTP payload, CLI flag, or test sentinel. `tests/helpers/test-rule-compatibility-gate.ts` is the sole fixture-approved implementation and accepts only `.xiaozhao-read-test-vault.json` with its exact read-test payload or `.xiaozhao-atomic-test-vault.json` with its exact atomic-contract payload under a canonical non-formal root. It requires the strict record, expected validator version, current five-file hashes, and bundle fingerprint at construction and at every assertion. Phase 6 will add the persistent Electron-owned implementation without changing this port or record schema.

- [ ] **Step 4: Run gateway, index, and read API tests**

Run:

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/local-rest-gateway.test.ts tests/unit/frontmatter-rules.test.ts
npm exec -- vitest run --config vitest.config.ts tests/unit/rule-compatibility-gate.test.ts
npm exec -- vitest run --config vitest.integration.config.ts tests/integration/search-indexer.test.ts tests/integration/read-api.test.ts
```

Expected: all focused tests pass with no behavior change in Local REST request or response handling; changing only rule 02 changes the bundle fingerprint; runtime approval remains denied and only the explicit sentinel fixture gate can approve its exact test fingerprint.

- [ ] **Step 5: Commit the interface split**

```bash
git add vitest.config.ts src/shared/domain/rule-approval.ts src/server/rules/rule-compatibility-gate.ts tests/helpers/test-rule-compatibility-gate.ts tests/unit/rule-compatibility-gate.test.ts src/server/vault/VaultGateway.ts src/server/vault/LocalRest51Gateway.ts src/server/vault/FakeVaultGateway.ts src/server/index/SearchIndexer.ts src/server/rules/rule-bundle.ts src/server/services/read-service.ts tests/unit/local-rest-gateway.test.ts tests/unit/frontmatter-rules.test.ts tests/integration/search-indexer.test.ts tests/integration/read-api.test.ts
git commit -m "refactor: split read vault gateway contract"
```

### Task 2: Implement lexical validation and descriptor-anchored native reads

**Files:**
- Create: `native/macos/atomic-file-helper.c`
- Create: `scripts/build-native-helper.ts`
- Create: `vitest.native.config.ts`
- Create: `src/server/vault/filesystem-path.ts`
- Create: `src/server/vault/native-read-helper-protocol.ts`
- Create: `src/server/vault/NativeReadVaultPort.ts`
- Create: `tests/unit/filesystem-path.test.ts`
- Create: `tests/unit/native-read-helper-protocol.test.ts`
- Create: `tests/native/native-read-helper.contract.test.ts`
- Create: `tests/helpers/filesystem-vault-fixture.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Add a temporary fixture that cannot target the formal vault**

Create `tests/helpers/filesystem-vault-fixture.ts` with this exact API:

```ts
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const SENTINEL = '.xiaozhao-read-test-vault.json';

export async function createFilesystemReadFixture(): Promise<{
  readonly root: string;
  write(relativePath: string, bytes: string | Uint8Array): Promise<void>;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'xiaozhao-read-vault-'));
  const formal = resolve('/Users/ao/我的大脑');
  if (resolve(root) === formal) throw new Error('FORMAL_VAULT_FORBIDDEN');
  await Promise.all([
    mkdir(join(root, '00大脑规则'), { recursive: true }),
    mkdir(join(root, '01图书馆'), { recursive: true }),
    mkdir(join(root, '02知识库'), { recursive: true }),
    mkdir(join(root, '03大讲堂'), { recursive: true })
  ]);
  await writeFile(join(root, SENTINEL), '{"purpose":"read-test"}\n', { mode: 0o600, flag: 'wx' });
  return {
    root,
    async write(relativePath, bytes) {
      const destination = join(root, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { mode: 0o600 });
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    }
  };
}
```

The helper must not stat, resolve, or otherwise open the formal vault. Because it creates the root itself directly under `tmpdir()`, the literal comparison above is only a defense-in-depth invariant. The test must assert the sentinel and all four roots exist before returning the fixture.

- [ ] **Step 2: Write lexical, protocol, and real native race tests before implementation**

Cover these cases in `tests/unit/filesystem-path.test.ts`:

```ts
it.each([
  '', '/01图书馆/a.md', '../a.md', '01图书馆/../a.md',
  '01图书馆/.hidden/a.md', '03大讲堂/a.md', '01图书馆/a%2f.md'
])('rejects a forbidden relative path: %s', (path) => {
  expect(() => normalizeFilesystemVaultPath(path)).toThrow('PATH_NOT_ALLOWED');
});

it('the native port rejects an intermediate symlink and a final symlink', async () => {
  await symlink(outside, join(root, '01图书馆', 'linked'));
  await symlink(outsideFile, join(root, '02知识库', 'linked.md'));
  const port = await NativeReadVaultPort.create({ root, helperPath });
  await expect(port.readFile('01图书馆/linked/a.md'))
    .rejects.toThrow('VAULT_SYMLINK_NOT_ALLOWED');
  await expect(port.readFile('02知识库/linked.md'))
    .rejects.toThrow('VAULT_SYMLINK_NOT_ALLOWED');
});
```

Also test a symlink passed as the vault root, Unicode NFC normalization, a directory supplied when a file is required, a file supplied when a directory is required, and a non-existing target.

In `tests/native/native-read-helper.contract.test.ts`, use a sentinel fixture plus an outside directory whose bytes are unmistakably different. Require `probe-root`, `list-dir`, and `read-file` to reject a root symlink, every intermediate/final symlink, `..`, empty/repeated segments, cross-device descendants, special files, and a root dev/ino mismatch. Add a synchronization hook available only in the test build: after the helper opens the canonical root and each parent descriptor it prints `READY_FOR_RACE` to a dedicated test pipe and waits. Rename/replace the pathname with a symlink to the outside tree, release the helper, and prove the result is either the originally descriptor-bound in-vault inode or `VAULT_IDENTITY_CHANGED`, never outside names/bytes. Run the same race while listing a directory and reading a file.

The strict protocol tests require a four-byte big-endian JSON-header length, a header no larger than 64 KiB, read payload no larger than 10 MiB, exact payload length/EOF, hex-encoded entry names, a maximum 20,000 direct entries, no unknown JSON keys, timeout/abort cleanup, and public errors containing no absolute path. Truncated, extra, malformed, duplicate-entry, invalid UTF-8/NFC, invalid type, or nonzero-exit frames fail closed.

- [ ] **Step 3: Run the path tests and verify RED**

Run:

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/filesystem-path.test.ts
npm exec -- vitest run --config vitest.config.ts tests/unit/native-read-helper-protocol.test.ts
npm run test:native-read
```

Expected: FAIL because the lexical boundary, read-only helper, protocol/client, and native test script do not exist.

- [ ] **Step 4: Implement lexical normalization plus the read-only descriptor authority**

`filesystem-path.ts` performs only lexical normalization and display-path checks. It never returns an absolute entry path for `readFile`, `readdir`, or `open`:

```ts
const READ_ROOTS = new Set(['00大脑规则', '01图书馆', '02知识库']);

export function normalizeFilesystemVaultPath(input: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(input); }
  catch { throw new AppError('PATH_NOT_ALLOWED'); }
  const normalized = decoded.normalize('NFC').replace(/\/$/u, '');
  const parts = normalized.split('/');
  if (
    normalized.length === 0 || normalized.startsWith('/')
    || normalized.includes('\\') || normalized.includes('\0')
    || /%[0-9a-f]{2}/iu.test(normalized)
    || !READ_ROOTS.has(parts[0] ?? '')
    || parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))
  ) throw new AppError('PATH_NOT_ALLOWED');
  return parts.join('/');
}
```

Build `native/macos/atomic-file-helper.c` as an arm64 C11 binary whose Phase 0 command table contains exactly:

```text
probe-root <absolute-root>
list-dir  <absolute-root> <expected-root-dev> <expected-root-ino> <normalized-relative-directory>
read-file <absolute-root> <expected-root-dev> <expected-root-ino> <normalized-relative-file>
stat-file <absolute-root> <expected-root-dev> <expected-root-ino> <normalized-relative-file>
```

The helper starts with `open("/", O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)`, walks every absolute-root component through `openat` with the same directory/no-follow flags, rejects empty/dot components, and `fstat`s every held descriptor. `probe-root` returns the terminal root dev/ino only if it is a real directory. Every other command repeats the walk, requires the expected root identity, then walks normalized relative parents with held descriptors. It rejects symlinks through `O_NOFOLLOW`/`AT_SYMLINK_NOFOLLOW`, rejects any child with a different `st_dev`, and never reconstructs or opens an absolute entry pathname.

`read-file` opens the final component with `openat(parent, basename, O_RDONLY|O_NOFOLLOW|O_CLOEXEC)`, requires a regular file at most 10 MiB, records dev/ino/size/mtime-ns before and after reading the held descriptor, and returns `VERSION_CONFLICT` if any value changes. `stat-file` returns only bound metadata. `list-dir` uses `fdopendir(dup(directoryFd))`, `fstatat(...AT_SYMLINK_NOFOLLOW)` for every direct entry, omits hidden entries, rejects visible symlink/special/cross-device entries, caps count/output, and returns entry names as UTF-8 bytes encoded to lowercase hex plus `file|directory`; TypeScript decodes, requires valid NFC and no separator, adds `/` to directories, and sorts by UTF-8 bytes. No helper error includes a path.

`native-read-helper-protocol.ts` owns strict framed headers. `NativeReadVaultPort.create()` invokes `probe-root` once and stores `{ absoluteRoot, dev, ino }`; every list/read/stat call passes that identity and rechecks the returned identity. Use `spawn(helperPath, args, { shell:false, stdio:['ignore','pipe','pipe'] })`, a five-second timeout, 64 KiB stderr cap, exact frame/payload bounds, and abort termination. Only `NativeReadVaultPort` may invoke these four commands. The Phase 0 source contains no command that can open for write, create, append, rename, or unlink.

`scripts/build-native-helper.ts` invokes `xcrun clang` via `execFile`, not a shell, with `-std=c11 -Wall -Wextra -Werror -O2 -arch arm64 -mmacosx-version-min=13.0`, writes `dist/native/atomic-file-helper`, sets `0755`, and prints only its SHA-256 plus output path. Create `vitest.native.config.ts` so a native contract can never silently run under the integration include boundary:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/native/**/*.test.ts'],
    fileParallelism: false,
    passWithNoTests: false
  }
});
```

Add:

```json
{
  "scripts": {
    "build:native": "tsx scripts/build-native-helper.ts",
    "test:native-read": "npm run build:native && vitest run --config vitest.native.config.ts tests/native/native-read-helper.contract.test.ts --no-file-parallelism"
  }
}
```

Catch process/filesystem errors inside the helper client and map them immediately to stable `AppError` codes, so raw errno text and absolute paths never enter logs or HTTP.

- [ ] **Step 5: Run the path suite and the existing vault path suite**

Run:

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/filesystem-path.test.ts tests/unit/vault-path.test.ts tests/unit/test-vault-guard.test.ts
npm exec -- vitest run --config vitest.config.ts tests/unit/native-read-helper-protocol.test.ts
npm run test:native-read
```

Expected: all tests pass; race tests never return outside bytes/names; the formal vault guard remains unchanged; the binary exposes no mutation command.

- [ ] **Step 6: Commit the filesystem path boundary**

```bash
git add native/macos/atomic-file-helper.c scripts/build-native-helper.ts vitest.native.config.ts src/server/vault/filesystem-path.ts src/server/vault/native-read-helper-protocol.ts src/server/vault/NativeReadVaultPort.ts tests/unit/filesystem-path.test.ts tests/unit/native-read-helper-protocol.test.ts tests/native/native-read-helper.contract.test.ts tests/helpers/filesystem-vault-fixture.ts package.json package-lock.json
git commit -m "feat: anchor direct reads to native descriptors"
```

### Task 3: Implement byte-preserving direct reads

**Files:**
- Create: `src/server/vault/FileSystemVaultGateway.ts`
- Create: `tests/unit/filesystem-vault-gateway.test.ts`
- Modify: `tests/native/native-read-helper.contract.test.ts`

- [ ] **Step 1: Write gateway behavior tests**

Test the following exact observable behaviors:

```ts
it('returns direct sorted entries and marks directories with a slash', async () => {
  await fixture.write('01图书馆/z.md', '# z');
  await fixture.write('01图书馆/a/一.md', '# 一');
  const gateway = await FileSystemVaultGateway.create({ vaultRoot: fixture.root });
  await expect(gateway.listDirectory('01图书馆')).resolves.toEqual(['a/', 'z.md']);
});

it('preserves BOM, CRLF, Chinese bytes, and reports the exact sha256', async () => {
  const bytes = Buffer.from('\ufeff---\r\n标题: 中文\r\n---\r\n正文\r\n', 'utf8');
  await fixture.write('02知识库/原字节.md', bytes);
  const gateway = await FileSystemVaultGateway.create({ vaultRoot: fixture.root });
  const result = await gateway.readRaw('02知识库/原字节.md');
  expect(Buffer.from(result.bytes)).toEqual(bytes);
  expect(result.rawSha256).toBe(sha256Bytes(bytes));
  expect(result.upstreamVersion).toBeUndefined();
});
```

Also assert: hidden entries are omitted; symlinks fail; files over 10 MiB fail before allocation; a file whose `dev`, `ino`, size, or mtime-ns changes on its held descriptor fails `VERSION_CONFLICT`; an aborted signal fails before helper launch; root identity drift fails; and `openInObsidian` invokes the injected opener with only an `obsidian:` URL. Repeat the Task 2 directory/file pathname-swap race through the gateway and prove outside bytes/names never reach the gateway result.

- [ ] **Step 2: Run the gateway test and verify RED**

Run:

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/filesystem-vault-gateway.test.ts
```

Expected: FAIL because `FileSystemVaultGateway` does not exist.

- [ ] **Step 3: Implement the gateway only over the descriptor-anchored port**

Create `src/server/vault/FileSystemVaultGateway.ts` around this API:

```ts
export interface FileSystemVaultGatewayOptions {
  readonly vaultRoot: string;
  readonly nativeReader: NativeReadVaultPortFactory;
  readonly openExternal?: (url: string) => Promise<void>;
}

export class FileSystemVaultGateway implements OpenableVaultGateway {
  private constructor(
    private readonly reader: NativeReadVaultPort,
    private readonly vaultDisplayName: string,
    private readonly openExternal?: (url: string) => Promise<void>
  ) {}

  static async create(options: FileSystemVaultGatewayOptions): Promise<FileSystemVaultGateway> {
    const lexicalRoot = normalizeConfiguredVaultRoot(options.vaultRoot);
    const reader = await options.nativeReader.create(lexicalRoot);
    return new FileSystemVaultGateway(reader, basename(lexicalRoot), options.openExternal);
  }

  async listDirectory(path: string, signal?: AbortSignal): Promise<ReadonlyArray<string>> {
    const normalized = normalizeFilesystemVaultPath(path);
    const entries = await this.reader.listDirectory(normalized, signal);
    return Object.freeze(entries.map((entry) =>
      entry.kind === 'directory' ? `${entry.name}/` : entry.name
    ).sort(compareUtf8));
  }

  async readRaw(path: string, signal?: AbortSignal): Promise<VersionedBytes> {
    const normalized = normalizeFilesystemVaultPath(path);
    const result = await this.reader.readFile(normalized, signal);
    return { path: normalized, bytes: result.bytes, rawSha256: sha256Bytes(result.bytes) };
  }

  async openInObsidian(path: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new AppError('VAULT_REQUEST_ABORTED');
    if (this.openExternal === undefined) throw new AppError('OPEN_EXTERNAL_UNAVAILABLE');
    const normalized = normalizeFilesystemVaultPath(path);
    await this.reader.assertFile(normalized, signal);
    const url = new URL('obsidian://open');
    url.searchParams.set('vault', this.vaultDisplayName);
    url.searchParams.set('file', normalized);
    await this.openExternal(url.href);
  }
}
```

No gateway method imports `node:fs`, calls `realpath`, or opens/readdir's a vault entry pathname. The injected fake port is allowed only in unit tests; desktop/server composition always constructs the real `NativeReadVaultPort` using the verified helper path. Map every low-level/helper failure to existing safe `AppError` codes.

- [ ] **Step 4: Run gateway, indexer and schema parsing tests**

Run:

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/filesystem-vault-gateway.test.ts tests/unit/frontmatter-rules.test.ts
npm run test:native-read
npm exec -- vitest run --config vitest.integration.config.ts tests/integration/search-indexer.test.ts tests/integration/read-api.test.ts
```

Expected: all tests pass and the byte-fidelity assertion compares exact Buffers.

- [ ] **Step 5: Commit the direct read gateway**

```bash
git add src/server/vault/FileSystemVaultGateway.ts tests/unit/filesystem-vault-gateway.test.ts tests/native/native-read-helper.contract.test.ts
git commit -m "feat: read vault files directly"
```

### Task 4: Replace plugin-only health with truthful vault-source health

**Files:**
- Modify: `src/shared/api/schemas.ts`
- Modify: `src/server/services/health-service.ts`
- Modify: `src/client/api/client.ts`
- Modify: `src/client/app/AppShell.tsx`
- Modify: `src/client/app/router.tsx`
- Create: `src/client/pages/SettingsPage.tsx`
- Delete: `src/client/pages/ConnectionsPage.tsx`
- Modify: `tests/integration/health-connections.test.ts`
- Modify: `tests/integration/health-route.test.ts`
- Modify: `tests/integration/health-write-gate.test.ts`
- Modify: `tests/component/app-shell.test.tsx`
- Modify: `tests/component/read-pages.test.tsx`

- [ ] **Step 1: Change health fixtures to the new source contract and require a blocked gate**

Use this shape in server and client tests:

```ts
const directReadHealth = {
  status: 'ready',
  vaultSource: {
    status: 'ready',
    adapter: 'filesystem',
    displayName: '我的大脑'
  },
  index: { status: 'ready', version: 4, refreshedAt: '2026-09-01T00:00:00.000Z' },
  model: { status: 'unconfigured', providerHost: 'api.deepseek.com' },
  writeGate: {
    status: 'blocked',
    reasonCode: 'RULE_BUNDLE_UNAPPROVED',
    missing: ['ruleApproval', 'nativeWritePrimitives', 'capabilityProfile', 'recoveryKernel'],
    fingerprintMatches: false
  },
  schemaIssues: { status: 'available', count: 0 }
} as const;
```

Add assertions that the UI says `本地文件 · 我的大脑` without showing a Local REST plugin version, and that no health response can say `enabled` when the Electron direct-read factory is used.

- [ ] **Step 2: Run the health and component tests and verify RED**

Run:

```bash
npm exec -- vitest run --config vitest.integration.config.ts tests/integration/health-connections.test.ts tests/integration/health-route.test.ts tests/integration/health-write-gate.test.ts
npm exec -- vitest run --config vitest.client.config.ts tests/component/app-shell.test.tsx tests/component/read-pages.test.tsx
```

Expected: FAIL because `healthSnapshotSchema` still requires `plugin`.

- [ ] **Step 3: Define the vault-source schema and direct-read health factory**

Replace `plugin` in `healthSnapshotSchema` with:

```ts
vaultSource: z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    adapter: z.enum(['filesystem', 'local-rest']),
    displayName: z.string().min(1).max(256)
  }).strict(),
  z.object({
    status: z.literal('unavailable'),
    reason: z.enum(['VAULT_UNAVAILABLE', 'VAULT_RULES_MISSING'])
  }).strict()
]),
```

In `health-service.ts`, keep legacy contract-profile calculation behind a Local REST-specific factory, and add:

```ts
export function createDirectReadHealthService(input: {
  readonly displayName: string;
  readonly stateKernel: StateKernel;
  readonly indexState: HealthIndexStateSource;
  readonly model?: { readonly baseUrl: string; readonly name?: string };
  readonly schemaIssues?: { count(): number };
}): HealthService {
  return {
    async getSnapshot() {
      return {
        status: input.stateKernel.mode === 'normal' ? 'ready' : 'recovery-only',
        vaultSource: { status: 'ready', adapter: 'filesystem', displayName: input.displayName },
        index: publicIndexSnapshot(input.indexState.snapshot()),
        model: modelSnapshot(input.model),
        writeGate: {
          status: 'blocked',
          reasonCode: 'RULE_BUNDLE_UNAPPROVED',
          missing: ['ruleApproval', 'nativeWritePrimitives', 'capabilityProfile', 'recoveryKernel'],
          fingerprintMatches: false
        },
        schemaIssues: schemaIssueSnapshot(input.stateKernel, input.schemaIssues)
      };
    }
  };
}
```

Define `writeGate.reasonCode` as the single stable `RULE_BUNDLE_UNAPPROVED` value whenever the current five-file bundle lacks an exact approved record, even though Phase 0 also lists later missing capabilities. Export the currently private snapshot helpers needed by both factories rather than duplicating them.

- [ ] **Step 4: Update presentation copy without expanding Phase 0 scope**

Change AppShell connection presentation to:

```ts
if (snapshot?.vaultSource.status === 'ready') {
  return {
    className: 'connection-badge--connected',
    title: '本地大脑已连接',
    detail: `${snapshot.vaultSource.adapter === 'filesystem' ? '本地文件' : 'Local REST'} · ${snapshot.vaultSource.displayName}`
  };
}
```

Create `SettingsPage.tsx` from the useful diagnostics in the old connection page, rename `pluginDiagnostic()` to `vaultDiagnostic()`, and title the vault row `我的大脑`. Change the AppShell fifth navigation item from `{ to: '/connections', label: '系统连接' }` to `{ to: '/settings', label: '设置' }`; change `pageIdentity()` accordingly. In `router.tsx`, import `SettingsPage`, register `<Route path="settings" element={<SettingsPage />} />`, remove the `/connections` route, and delete `ConnectionsPage.tsx`. Render the model card disabled with the exact text `DeepSeek 设置将在后续阶段启用`; Phase 3 extends this settings page instead of creating another route. The write-gate card must say `当前阶段严格只读`.

- [ ] **Step 5: Run health, component and API schema tests**

Run:

```bash
npm exec -- vitest run --config vitest.integration.config.ts tests/integration/health-connections.test.ts tests/integration/health-route.test.ts tests/integration/health-write-gate.test.ts
npm exec -- vitest run --config vitest.client.config.ts tests/component/app-shell.test.tsx tests/component/read-pages.test.tsx tests/component/api-client.test.tsx
```

Expected: all focused suites pass; serialized health responses contain `vaultSource` and no `plugin` field.

- [ ] **Step 6: Commit truthful direct-read health**

```bash
git add src/shared/api/schemas.ts src/server/services/health-service.ts src/client/api/client.ts src/client/app/AppShell.tsx src/client/app/router.tsx src/client/pages/SettingsPage.tsx src/client/pages/ConnectionsPage.tsx tests/integration/health-connections.test.ts tests/integration/health-route.test.ts tests/integration/health-write-gate.test.ts tests/component/app-shell.test.tsx tests/component/read-pages.test.tsx
git commit -m "feat: report direct filesystem health"
```

### Task 5: Make Host and Origin security work with one dynamic port

**Files:**
- Create: `src/server/security/loopback-policy.ts`
- Create: `tests/unit/loopback-policy.test.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/security/origin-host.ts`
- Modify: `tests/integration/security/local-http-security.test.ts`
- Modify: `tests/integration/security/server-startup.test.ts`

- [ ] **Step 1: Write an unbound, one-time-bind authority policy test**

```ts
it('fails closed until one exact loopback origin is bound', () => {
  const policy = createLoopbackPolicy();
  expect(policy.isAllowedHost('127.0.0.1:4317')).toBe(false);
  expect(policy.isAllowedOrigin(undefined, false)).toBe(true);
  expect(policy.isAllowedOrigin('http://127.0.0.1:4317', false)).toBe(false);
  policy.bind('http://127.0.0.1:49231');
  expect(policy.isAllowedHost('127.0.0.1:49231')).toBe(true);
  expect(policy.isAllowedHost('localhost:49231')).toBe(false);
  expect(policy.isAllowedOrigin('http://127.0.0.1:49231', true)).toBe(true);
  expect(() => policy.bind('http://127.0.0.1:49232')).toThrow('HTTP_POLICY_ALREADY_BOUND');
});
```

Also reject HTTPS, username/password, path/query/hash, hostname `localhost`, non-loopback hosts, and ports outside 1–65535. Missing Origin is permitted only for non-mutating requests.

- [ ] **Step 2: Run the policy test and verify RED**

Run:

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/loopback-policy.test.ts
```

Expected: FAIL because `createLoopbackPolicy()` does not exist.

- [ ] **Step 3: Implement the dynamic policy**

Create `src/server/security/loopback-policy.ts`:

```ts
export interface LoopbackPolicy {
  bind(origin: string): void;
  boundOrigin(): string | undefined;
  isAllowedHost(host: string | undefined): boolean;
  isAllowedOrigin(origin: string | undefined, required: boolean): boolean;
}

export function createLoopbackPolicy(input: {
  readonly developmentOrigins?: readonly string[];
} = {}): LoopbackPolicy {
  let expected: URL | undefined;
  const development = new Set(input.developmentOrigins ?? []);
  return {
    bind(origin) {
      if (expected !== undefined) throw new Error('HTTP_POLICY_ALREADY_BOUND');
      const parsed = new URL(origin);
      if (
        parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1'
        || parsed.port.length === 0 || parsed.username !== '' || parsed.password !== ''
        || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== ''
      ) throw new Error('HTTP_POLICY_ORIGIN_INVALID');
      expected = parsed;
    },
    boundOrigin: () => expected?.origin,
    isAllowedHost: (host) => expected !== undefined && host === expected.host,
    isAllowedOrigin(origin, required) {
      if (origin === undefined) return !required;
      return expected !== undefined && (origin === expected.origin || development.has(origin));
    }
  };
}
```

- [ ] **Step 4: Inject the policy into Fastify**

Add `readonly httpPolicy?: LoopbackPolicy` to `BuildServerOptions`. Preserve a fixed-policy default for existing tests, then change the request hook to:

```ts
const httpPolicy = options.httpPolicy ?? createFixedLoopbackPolicy();
if (!httpPolicy.isAllowedHost(request.headers.host)) {
  return reply.code(421).send(safeError('MISDIRECTED_REQUEST', 'Request authority rejected', operationId()));
}
const isMutation = MUTATION_METHODS.has(request.method);
if (!httpPolicy.isAllowedOrigin(request.headers.origin, isMutation)) {
  return reply.code(403).send(safeError('ORIGIN_FORBIDDEN', 'Origin rejected', operationId()));
}
```

Initialize `httpPolicy` once beside the existing hook registration, then place both guards at the beginning of that existing request hook before its current authentication and route logic. Keep `origin-host.ts` only as the fixed CLI/dev compatibility adapter. Do not permit a wildcard port, `localhost`, missing mutation Origin, or a policy derived from request headers.

- [ ] **Step 5: Run all local HTTP security tests**

Run:

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/loopback-policy.test.ts
npm exec -- vitest run --config vitest.integration.config.ts tests/integration/security/local-http-security.test.ts tests/integration/security/server-startup.test.ts
```

Expected: all tests pass for both fixed CLI authority and injected dynamic authority.

- [ ] **Step 6: Commit dynamic loopback security**

```bash
git add src/server/security/loopback-policy.ts src/server/security/origin-host.ts src/server/app.ts tests/unit/loopback-policy.test.ts tests/integration/security/local-http-security.test.ts tests/integration/security/server-startup.test.ts
git commit -m "feat: bind loopback security to runtime port"
```

### Task 6: Extract an embedded server and serve the React client from the same origin

**Files:**
- Create: `src/server/client-assets.ts`
- Create: `src/server/start-server.ts`
- Create: `tests/integration/embedded-server.test.ts`
- Modify: `src/server/config.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/app.ts`
- Modify: `tests/unit/config.test.ts`
- Modify: `tests/unit/server-assets.test.ts`
- Modify: `tests/integration/security/server-startup.test.ts`

- [ ] **Step 1: Write an embedded runtime test using a real filesystem fixture**

The test must build a tiny client root with `index.html` and `assets/app.js`, open a normal state kernel outside the fixture vault, and call:

```ts
const started = await startServer({
  host: '127.0.0.1',
  port: 0,
  appDataDir,
  vaultRealRoot: fixture.root,
  clientRoot,
  modelBaseUrl: 'https://api.deepseek.com',
  gateway: await FileSystemVaultGateway.create({ vaultRoot: fixture.root })
});

expect(started.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
expect(started.port).not.toBe(4317);
expect(await fetch(`${started.origin}/`).then((r) => r.text())).toContain('desktop-fixture');
expect((await fetch(`${started.origin}/api/v1/health`)).status).toBe(200);
expect((await fetch(`${started.origin}/api/v1/does-not-exist`)).headers.get('content-type'))
  .toContain('application/json');
await started.close();
await expect(fetch(`${started.origin}/api/v1/health`)).rejects.toThrow();
```

Also test `/knowledge` returns the SPA shell, `/assets/app.js` returns JavaScript, a foreign Host gets 421, a foreign Origin gets 403, and calling `close()` twice is safe.

- [ ] **Step 2: Run the embedded runtime test and verify RED**

Run:

```bash
npm exec -- vitest run --config vitest.integration.config.ts tests/integration/embedded-server.test.ts
```

Expected: FAIL because `startServer` and production client asset registration do not exist.

- [ ] **Step 3: Add safe static assets and SPA fallback**

Create `src/server/client-assets.ts` with:

```ts
import fastifyStatic from '@fastify/static';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

export async function registerClientAssets(app: FastifyInstance, clientRoot: string): Promise<void> {
  const indexHtml = await readFile(join(clientRoot, 'index.html'));
  await app.register(fastifyStatic, {
    root: join(clientRoot, 'assets'),
    prefix: '/assets/',
    wildcard: false
  });
  app.setNotFoundHandler((request, reply) => {
    const acceptsHtml = request.headers.accept?.split(',').some((value) => value.trim().startsWith('text/html')) ?? false;
    if (
      (request.method === 'GET' || request.method === 'HEAD')
      && !request.url.startsWith('/api/')
      && acceptsHtml
    ) return reply.type('text/html; charset=utf-8').send(Buffer.from(indexHtml));
    return reply.code(404).type('application/json; charset=utf-8').send({
      error: { code: 'NOT_FOUND', message: 'Resource not found', operationId: 'route-not-found' }
    });
  });
}
```

In the implementation, reuse `safeError()` through a callback exported by `app.ts` so the fallback operation ID remains random and schema-valid; do not hard-code `route-not-found`.

- [ ] **Step 4: Implement `startServer()` and make cleanup idempotent**

Create `src/server/start-server.ts` with these public types:

```ts
export interface EmbeddedServerConfig {
  readonly host: '127.0.0.1';
  readonly port: 0 | number;
  readonly appDataDir: string;
  readonly vaultRealRoot: string;
  readonly clientRoot: string;
  readonly modelBaseUrl: string;
  readonly modelName?: string;
  readonly gateway: OpenableVaultGateway;
}

export interface StartedServer {
  readonly origin: string;
  readonly port: number;
  close(): Promise<void>;
}
```

Its execution order must be:

```ts
const policy = createLoopbackPolicy();
const stateKernel = openStateKernel({ appDataDir, vaultRealRoot });
const app = buildServer({ httpPolicy: policy, healthService, readApi, onClose: stopDependencies });
await registerClientAssets(app, clientRoot);
const address = await app.listen({ host: '127.0.0.1', port });
const origin = new URL(address).origin;
policy.bind(origin);
scheduler.start();
void scheduler.requestFocusRefresh();
return { origin, port: Number(new URL(origin).port), close: closeOnce };
```

If any construction, asset registration, or listen step fails, stop the scheduler if created and close SQLite exactly once. No signal handlers belong in `startServer()`.

- [ ] **Step 5: Reduce the old entrypoint to a CLI adapter**

`src/server/index.ts` may read environment variables and install `SIGINT`/`SIGTERM`, but it must delegate construction to `startServer()`. `loadConfig()` continues validating legacy Local REST settings for this CLI route. Add a separate `DesktopServerConfig` type that never contains Obsidian URL or key.

Use this exact adapter shape; `DesktopServerConfig` is the input type consumed by `startServer()` after the gateway has been constructed, so it cannot carry legacy Local REST credentials:

```ts
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { startServer, type EmbeddedServerConfig } from './start-server.js';
import { LocalRest51Gateway } from './vault/LocalRest51Gateway.js';

export type DesktopServerConfig = Pick<
  EmbeddedServerConfig,
  'host' | 'port' | 'appDataDir' | 'vaultRealRoot' | 'clientRoot' | 'modelBaseUrl' | 'modelName'
>;

const config = loadConfig(process.env);
const started = await startServer({
  host: '127.0.0.1',
  port: config.appPort,
  appDataDir: config.appDataDir,
  vaultRealRoot: config.vaultRealRoot,
  clientRoot: join(import.meta.dirname, '../../client'),
  modelBaseUrl: config.modelBaseUrl,
  ...(config.modelName === undefined ? {} : { modelName: config.modelName }),
  gateway: new LocalRest51Gateway(config.obsidianApiUrl, config.obsidianApiKey, fetch)
});

let shutdownPromise: Promise<void> | undefined;
const shutdown = (): Promise<void> => shutdownPromise ??= started.close();
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
```

- [ ] **Step 6: Run embedded, startup, asset and database tests**

Run:

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/config.test.ts tests/unit/server-assets.test.ts
npm exec -- vitest run --config vitest.integration.config.ts tests/integration/embedded-server.test.ts tests/integration/security/server-startup.test.ts tests/integration/database-kernel.test.ts
```

Expected: all tests pass; the embedded test receives a non-4317 port and closes it cleanly.

- [ ] **Step 7: Commit the embedded server runtime**

```bash
git add src/server/client-assets.ts src/server/start-server.ts src/server/config.ts src/server/index.ts src/server/app.ts tests/integration/embedded-server.test.ts tests/unit/config.test.ts tests/unit/server-assets.test.ts tests/integration/security/server-startup.test.ts
git commit -m "feat: start embedded same-origin server"
```

### Task 7: Add the isolated Electron lifecycle and minimal preload bridge

**Files:**
- Create: `src/electron/settings-store.ts`
- Create: `src/electron/window-policy.ts`
- Create: `src/electron/main.ts`
- Create: `src/electron/preload.ts`
- Create: `src/shared/desktop/bridge.ts`
- Modify: `src/client/vite-env.d.ts`
- Create: `tsconfig.electron.json`
- Create: `tests/unit/desktop-window-policy.test.ts`
- Create: `tests/unit/electron-settings-store.test.ts`
- Modify: `tsconfig.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/client/pages/SettingsPage.tsx`

- [ ] **Step 1: Install Electron without adding a packager**

Run:

```bash
npm install --save-dev --save-exact electron@44.1.0
```

Expected: `package.json` and `package-lock.json` add Electron; neither `electron-builder` nor another packaging dependency appears.

- [ ] **Step 2: Write pure window-policy tests**

```ts
it('allows only the exact embedded origin in the main window', () => {
  const policy = createDesktopWindowPolicy('http://127.0.0.1:49231');
  expect(policy.allowNavigation('http://127.0.0.1:49231/knowledge')).toBe(true);
  expect(policy.allowNavigation('http://127.0.0.1:49232/')).toBe(false);
  expect(policy.allowNavigation('http://localhost:49231/')).toBe(false);
  expect(policy.allowNavigation('file:///tmp/index.html')).toBe(false);
});

it('permits only obsidian and https as explicit external protocols', () => {
  const policy = createDesktopWindowPolicy('http://127.0.0.1:49231');
  expect(policy.allowExternal('obsidian://open?vault=x&file=y')).toBe(true);
  expect(policy.allowExternal('https://help.example.test/')).toBe(true);
  expect(policy.allowExternal('javascript:alert(1)')).toBe(false);
  expect(policy.allowExternal('file:///Users/ao/secret')).toBe(false);
});
```

- [ ] **Step 3: Run the policy test and verify RED**

Run:

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/desktop-window-policy.test.ts
```

Expected: FAIL because `window-policy.ts` does not exist.

- [ ] **Step 4: Implement the pure policy and private config store**

`src/electron/window-policy.ts` must parse URLs and compare `.origin` exactly. `allowExternal()` accepts `obsidian:` and `https:` only; `mailto:`, `http:`, `file:`, `data:`, and `javascript:` are denied.

`src/electron/settings-store.ts` must expose:

```ts
export interface DesktopSettings { readonly vaultRoot: string; }

export async function loadDesktopSettings(input: {
  readonly userDataDir: string;
}): Promise<DesktopSettings | undefined>;

export async function saveDesktopSettings(input: {
  readonly userDataDir: string;
  readonly config: DesktopSettings;
}): Promise<void>;

export async function validateDesktopVault(input: {
  readonly vaultRoot: string;
  readonly userDataDir: string;
  readonly nativeReaderFactory: NativeReadVaultPortFactory;
}): Promise<DesktopSettings>;
```

Store `config/app-config.json` under `userData`, set directory mode `0700` and file mode `0600`, and return `undefined` when no saved setting exists. `validateDesktopVault()` lexically normalizes the configured absolute root and rejects root/userData containment, then calls `nativeReaderFactory.create()` so the helper—not Node pathname checks—rejects a root symlink and binds root dev/ino. Through that descriptor-anchored port, require real directories `00大脑规则`, `01图书馆`, `02知识库`, `03大讲堂` and regular files for every current rule-bundle source path; any identity drift fails validation. The config file is app metadata outside the vault; this phase still performs no formal vault write.

- [ ] **Step 5: Implement the preload bridge**

Define the shared truth in `src/shared/desktop/bridge.ts`:

```ts
export interface XiaozhaoDesktopApi {
  getAppVersion(): Promise<string>;
  chooseVaultDirectory(): Promise<{ readonly selected: boolean; readonly displayName?: string }>;
}
```

Import that truth into `src/client/vite-env.d.ts` instead of redefining it:

```ts
import type { XiaozhaoDesktopApi } from '../shared/desktop/bridge';

declare global {
  interface Window { readonly xiaozhaoDesktop: XiaozhaoDesktopApi; }
}

export {};
```

Finally, import only the type into `src/electron/preload.ts` and expose the fixed bridge:

```ts
import { contextBridge, ipcRenderer } from 'electron';
import type { XiaozhaoDesktopApi } from '../shared/desktop/bridge.js';

contextBridge.exposeInMainWorld('xiaozhaoDesktop', Object.freeze({
  getAppVersion: () => ipcRenderer.invoke('desktop:get-app-version'),
  chooseVaultDirectory: () => ipcRenderer.invoke('desktop:choose-vault-directory')
} satisfies XiaozhaoDesktopApi));
```

The IPC handler validates the selected directory, saves it through `settings-store.ts`, returns only the display name, and asks Electron to relaunch after the response is delivered; it never returns the absolute path. `SettingsPage` calls this method from its `更换大脑文件夹` button and renders the returned display name. The renderer receives no generic IPC send method, filesystem API, environment, process, shell, or secrets.

- [ ] **Step 6: Implement Electron startup and ordered shutdown**

`src/electron/main.ts` dynamically imports `new URL('../server/start-server.js', import.meta.url).href` so the Electron build does not rebundle the server or break migration-relative paths. Before importing or starting Fastify/SQLite, it resolves the vault in this order: validate saved setting; validate `join(app.getPath('home'), '我的大脑')`; otherwise open `dialog.showOpenDialog({ properties: ['openDirectory'] })`. Invalid selections show a clear Chinese error and return to the picker; cancel shows `未选择大脑文件夹，应用尚未启动` and exits safely. Only a validated root is saved and passed to the server.

Its startup boundary is:

```ts
if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(async () => {
  const settings = await resolveInitialVaultSettings({
    saved: await loadDesktopSettings({ userDataDir: app.getPath('userData') }),
    defaultRoot: join(app.getPath('home'), '我的大脑'),
    userDataDir: app.getPath('userData'),
    chooseDirectory: () => dialog.showOpenDialog({ properties: ['openDirectory'] })
  });
  if (settings === undefined) return app.quit();
  const gateway = await FileSystemVaultGateway.create({
    vaultRoot: settings.vaultRoot,
    nativeReader: createNativeReadVaultPortFactory(resolveNativeHelperPath()),
    openExternal: async (url) => {
      if (new URL(url).protocol !== 'obsidian:') throw new Error('EXTERNAL_URL_FORBIDDEN');
      await shell.openExternal(url);
    }
  });
  started = await startServer({
    host: '127.0.0.1',
    port: 0,
    appDataDir: app.getPath('userData'),
    vaultRealRoot: settings.vaultRoot,
    clientRoot: resolveClientRoot(),
    modelBaseUrl: 'https://api.deepseek.com',
    gateway
  });
  window = createMainWindow(started.origin);
  await window.loadURL(started.origin);
});
```

Configure BrowserWindow with `minWidth: 720`, `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and the built `.cjs` preload path. Deny all `window.open`; prevent `will-navigate` unless `allowNavigation()` passes. On `before-quit`, prevent the first quit, await `started.close()`, remove the handler, then call `app.quit()`. Handle `second-instance` by restoring/focusing the existing window. Electron tests must assert attempts to resize below 720 settle at a width of at least 720.

`electron-settings-store.test.ts` and the Electron launch suite must cover: saved valid root; valid default root; missing default followed by valid selection; invalid selection followed by retry; invalid selection followed by cancel; direct cancel. In every cancel/invalid terminal case, assert `startServer`, `openStateKernel`, and BrowserWindow construction were never called and no listener/database file remains.

- [ ] **Step 7: Add desktop typecheck and build scripts**

Create `tsconfig.electron.json`:

```json
{
  "extends": "./tsconfig.server.json",
  "compilerOptions": {
    "noEmit": true,
    "types": ["node", "electron"]
  },
  "include": ["src/electron/**/*.ts", "src/shared/desktop/bridge.ts"]
}
```

Add the reference to root `tsconfig.json` and these scripts to `package.json`:

```json
{
  "main": "dist/electron/main.js",
  "scripts": {
    "typecheck": "tsc -p tsconfig.client.json && tsc -p tsconfig.server.json && tsc -p tsconfig.electron.json",
    "build:server": "tsup src/server/index.ts src/server/start-server.ts --format esm --platform node --out-dir dist/server --clean && tsx scripts/copy-server-assets.ts",
    "build:electron": "tsup src/electron/main.ts --format esm --platform node --out-dir dist/electron --clean --external electron && tsup src/electron/preload.ts --format cjs --platform node --out-dir dist/electron --out-extension .js=.cjs --external electron",
    "build:desktop-runtime": "npm run build:native && npm run build && npm run build:electron",
    "electron": "npm run build:desktop-runtime && electron ."
  }
}
```

- [ ] **Step 8: Run typecheck and the pure desktop tests**

Run:

```bash
npm run typecheck
npm exec -- vitest run --config vitest.config.ts tests/unit/desktop-window-policy.test.ts tests/unit/electron-settings-store.test.ts tests/unit/filesystem-path.test.ts tests/unit/filesystem-vault-gateway.test.ts
npm run build:desktop-runtime
```

Expected: all commands exit 0 and `dist/native/atomic-file-helper`, `dist/electron/main.js`, `dist/electron/preload.cjs`, `dist/client/index.html`, and `dist/server/db/migrations/001_initial.sql` exist; the helper's command table remains read-only.

- [ ] **Step 9: Commit the Electron runtime**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.electron.json src/electron/settings-store.ts src/electron/window-policy.ts src/electron/main.ts src/electron/preload.ts src/shared/desktop/bridge.ts src/client/vite-env.d.ts src/client/pages/SettingsPage.tsx tests/unit/desktop-window-policy.test.ts tests/unit/electron-settings-store.test.ts
git commit -m "feat: launch direct-read desktop runtime"
```

### Task 8: Keep the sidebar on the left at every desktop acceptance width

**Files:**
- Modify: `src/client/styles/shell.css`
- Modify: `tests/unit/client-style-contract.test.ts`
- Modify: `tests/component/app-shell.test.tsx`
- Modify: `tests/e2e/read-only-console.spec.ts`

- [ ] **Step 1: Add a style contract that forbids a horizontal bottom-navigation geometry**

Extend `tests/unit/client-style-contract.test.ts` to parse the `.sidebar` rule inside `@media (max-width: 800px)`. Require `left: 0`, `top: 0`, `bottom: 0`, and width `72px`; forbid `right: 0`, `width: 100%`, and a horizontal five-column navigation grid. `bottom: 0` is required for the full-height left rail and is not itself evidence of bottom navigation.

```ts
expect(narrowSidebarBlock).toMatch(/left:\s*0/u);
expect(narrowSidebarBlock).toMatch(/top:\s*0/u);
expect(narrowSidebarBlock).toMatch(/bottom:\s*0/u);
expect(narrowSidebarBlock).not.toMatch(/right:\s*0/u);
expect(narrowSidebarBlock).toMatch(/width:\s*72px/u);
```

Also parse `.sidebar-nav`: require a column direction and reject `grid-template-columns: repeat(5, 1fr)`. Do not scan the entire media query, because unrelated panels legitimately use full width or bottom anchoring.

- [ ] **Step 2: Run the style and component tests and verify RED**

Run:

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/client-style-contract.test.ts
npm exec -- vitest run --config vitest.client.config.ts tests/component/app-shell.test.tsx
```

Expected: the style test fails because the current 800 px breakpoint makes the sidebar a bottom bar.

- [ ] **Step 3: Convert the narrow layout to a compact left rail**

At `@media (max-width: 800px)`, use:

```css
.app-shell { grid-template-columns: 72px minmax(0, 1fr); }
.sidebar {
  position: fixed;
  inset: 0 auto 0 0;
  width: 72px;
  height: 100dvh;
  padding: 14px 8px;
}
.sidebar-nav { display: flex; flex-direction: column; }
.sidebar-nav a { grid-template-columns: 1fr; justify-items: center; min-height: 48px; }
.sidebar-nav a span:not(.sidebar-nav__icon),
.sidebar-section-label,
.sidebar-footer { display: none; }
.app-main { grid-column: 2; padding-bottom: 24px; }
```

Preserve accessible names in the DOM; hide visual text with an existing visually-hidden utility or `aria-label`, not by removing labels from React.

- [ ] **Step 4: Update responsive E2E assertions**

At 800 px, 720 px, and the existing 390 px web snapshot width, assert the sidebar bounding box has `x === 0`, `y === 0`, height within 2 px of viewport height, width between 68 and 76 px, and its bottom edge is not a horizontal navigation bar. Keep and update the 390, 1280, and 1440 snapshots. The Electron window is constrained to 720, but the browser/CSS contract must remain a left icon rail even at 390 so a later breakpoint cannot reintroduce bottom navigation.

```ts
for (const width of [800, 720, 390]) {
  await page.setViewportSize({ width, height: 900 });
  const box = await page.getByRole('navigation', { name: '主导航' }).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBe(0);
  expect(box!.y).toBe(0);
  expect(Math.abs(box!.height - 900)).toBeLessThanOrEqual(2);
  expect(box!.width).toBeGreaterThanOrEqual(68);
  expect(box!.width).toBeLessThanOrEqual(76);
}
```

- [ ] **Step 5: Run style, component, and browser tests**

Run:

```bash
npm exec -- vitest run --config vitest.config.ts tests/unit/client-style-contract.test.ts
npm exec -- vitest run --config vitest.client.config.ts tests/component/app-shell.test.tsx
npm run test:e2e
```

Expected: all tests pass and the navigation remains on the left in every tested viewport.

- [ ] **Step 6: Commit the left-rail behavior**

```bash
git add src/client/styles/shell.css tests/unit/client-style-contract.test.ts tests/component/app-shell.test.tsx tests/e2e/read-only-console.spec.ts
git commit -m "fix: keep desktop navigation on the left"
```

### Task 9: Verify the real Electron process without touching the formal vault

**Files:**
- Create: `playwright.electron.config.ts`
- Create: `tests/electron/desktop-launch.test.ts`
- Modify: `src/electron/main.ts`
- Modify: `package.json`

- [ ] **Step 1: Add an Electron test-mode config seam**

Allow `src/electron/main.ts` to read only these test-only variables when `NODE_ENV === 'test'`:

```text
XIAOZHAO_TEST_VAULT_ROOT
XIAOZHAO_TEST_USER_DATA
```

Before calling `app.setPath('userData', ...)`, canonicalize and `lstat` both supplied directories without creating anything. Require both to be already-created, real, non-symlink directories with mode `0700`, owned by the current uid, and direct children of the canonical `tmpdir()` whose basenames match the fixture prefixes `xiaozhao-vault-` and `xiaozhao-user-data-`. Require distinct dev/ino identities and bidirectional non-overlap after realpath. Then require the vault sentinel `.xiaozhao-read-test-vault.json` with exact bytes. Reject `/Users/ao/我的大脑`, the configured formal root, every ancestor/descendant of either, and every symlink/realpath alias before constructing settings, cache/session storage, server, SQLite, watcher, helper, or BrowserWindow. Production and development ignore both variables.

Add cases where `XIAOZHAO_TEST_USER_DATA` is the formal root, its child, its parent, the test vault, a symlink alias to any of them, wrong mode, wrong owner fixture (where supported), a non-direct tmp descendant, and an unexpected basename. Snapshot the formal namespace before process launch and after rejection and require exact equality. This seam prevents Playwright/Electron itself from writing cache or configuration into the formal vault before application guards run.

- [ ] **Step 2: Write the Electron launch test**

Use Playwright `_electron.launch` and a temporary fixture:

```ts
const electronApp = await electron.launch({
  args: ['.'],
  env: {
    ...process.env,
    NODE_ENV: 'test',
    XIAOZHAO_TEST_VAULT_ROOT: fixture.root,
    XIAOZHAO_TEST_USER_DATA: userData
  }
});
const window = await electronApp.firstWindow();
await expect(window).toHaveTitle(/小兆大脑/u);
expect(await window.evaluate(() => location.origin)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
expect(await window.evaluate(() => ({
  process: typeof globalThis.process,
  require: typeof (globalThis as Record<string, unknown>).require,
  desktop: Object.keys(window.xiaozhaoDesktop).sort()
}))).toEqual({
  process: 'undefined',
  require: 'undefined',
  desktop: ['chooseVaultDirectory', 'getAppVersion']
});
await electronApp.close();
```

Also assert the health card reports `filesystem`, data from the fixture appears after index refresh, `window.open('https://example.com')` does not create another BrowserWindow, and navigating the main frame to `file://` is blocked.

- [ ] **Step 3: Add the Electron test script**

Create `playwright.electron.config.ts` with `testDir: './tests/electron'`, `workers: 1`, and `fullyParallel: false`. Add:

```json
{
  "scripts": {
    "test:electron": "npm run build:desktop-runtime && playwright test --config playwright.electron.config.ts"
  }
}
```

- [ ] **Step 4: Run Electron isolation and lifecycle tests**

Run:

```bash
npm run test:electron
```

Expected: one Electron window loads a dynamic loopback origin, fixture knowledge is visible, renderer Node globals are absent, forbidden navigation is blocked, and the process exits without a surviving listener.

- [ ] **Step 5: Run the app manually against the formal vault in read-only mode**

First record a read-only inventory without writing it inside the vault:

```bash
XIAOZHAO_PHASE0_AUDIT_DIR="$(mktemp -d "${TMPDIR%/}/xiaozhao-phase0-audit.XXXXXX")"
find /Users/ao/我的大脑/00大脑规则 /Users/ao/我的大脑/01图书馆 /Users/ao/我的大脑/02知识库 -type f -exec stat -f '%N|%m|%z' {} \; | sort > "$XIAOZHAO_PHASE0_AUDIT_DIR/before-stat.txt"
find /Users/ao/我的大脑/00大脑规则 /Users/ao/我的大脑/01图书馆 /Users/ao/我的大脑/02知识库 -type f -exec shasum -a 256 {} \; | sort > "$XIAOZHAO_PHASE0_AUDIT_DIR/before-sha256.txt"
npm run electron
find /Users/ao/我的大脑/00大脑规则 /Users/ao/我的大脑/01图书馆 /Users/ao/我的大脑/02知识库 -type f -exec stat -f '%N|%m|%z' {} \; | sort > "$XIAOZHAO_PHASE0_AUDIT_DIR/after-stat.txt"
find /Users/ao/我的大脑/00大脑规则 /Users/ao/我的大脑/01图书馆 /Users/ao/我的大脑/02知识库 -type f -exec shasum -a 256 {} \; | sort > "$XIAOZHAO_PHASE0_AUDIT_DIR/after-sha256.txt"
diff -u "$XIAOZHAO_PHASE0_AUDIT_DIR/before-stat.txt" "$XIAOZHAO_PHASE0_AUDIT_DIR/after-stat.txt"
diff -u "$XIAOZHAO_PHASE0_AUDIT_DIR/before-sha256.txt" "$XIAOZHAO_PHASE0_AUDIT_DIR/after-sha256.txt"
```

Expected: Electron opens without Obsidian running; dashboard, queue, and knowledge pages populate from local files; both `diff` commands print no changes. The temporary audit directory may be removed after inspection. Do not trigger any external write probe.

- [ ] **Step 6: Commit Electron verification**

```bash
git add playwright.electron.config.ts tests/electron/desktop-launch.test.ts package.json src/electron/main.ts
git commit -m "test: verify isolated desktop launch"
```

### Task 10: Run the Phase 0 completion gate

**Files:**
- Modify only if a verification failure is directly caused by Phase 0 files.

- [ ] **Step 1: Run all static checks and automated tests**

Run:

```bash
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:security
npm run test:component
npm run test:e2e
npm run test:native-read
npm run test:electron
npm run build:desktop-runtime
```

Expected: every command exits 0. Existing Local REST contract tests remain compilable but are not required to contact Obsidian.

- [ ] **Step 2: Prove Phase 0 has no formal-write implementation**

Run:

```bash
rg -n "renameatx_np|RENAME_SWAP|RENAME_EXCL|WriteCoordinator|RecoveryManifest" src native 2>/dev/null && exit 1 || true
rg -n "writeGate: \{[[:space:]]*status: 'blocked'|nativeWritePrimitives|capabilityProfile|recoveryKernel" src/server tests
```

Expected: the first command finds no native or workflow write implementation; the second finds the explicit blocked-gate construction and assertions.

- [ ] **Step 3: Inspect the final diff for scope containment**

Run:

```bash
git status --short
git diff --stat HEAD~10..HEAD
git diff --check
```

Expected: only the files listed in this plan changed, no formal vault path appears as a write target, no Electron packager configuration exists, and `git diff --check` prints nothing.

- [ ] **Step 4: Record Phase 0 evidence in the implementation handoff**

The handoff must include the exact commit IDs, test counts, the dynamic origin observed by the Electron test, the no-change formal-vault inventory result, and this explicit statement:

```text
Phase 0 is a descriptor-anchored direct-read desktop runtime. Its native helper exposes read commands only; formal vault writes remain blocked because native write primitives, a filesystem capability profile, and the recovery kernel do not exist yet.
```
