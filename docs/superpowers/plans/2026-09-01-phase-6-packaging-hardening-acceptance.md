# Phase 6 Packaging, Hardening, and Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a current-Mac arm64 `.app` and `.dmg`, prove their packaged security and native runtime, run a real DeepSeek smoke without opening a vault, and verify one user-confirmed formal-vault write from a read-only baseline.

**Architecture:** Electron Builder packages the completed React client, embedded Fastify server, SQLite native module, migrations, and macOS atomic helper. Verification inspects the built artifact rather than trusting source configuration; every formal-vault observation is made through one hidden-inclusive, descriptor-anchored private extension of `NativeReadVaultPort`, diagnostic modes exclude the normal vault runtime, and formal acceptance is separated into a stable read-only baseline, App UI/native-dialog confirmation, and descriptor-anchored read-only post-write verification. The recovery manifest remains immutable after pre-mutation persistence; production authority and verified completion live only in its hash-chained journal.

**Tech Stack:** Electron, Electron Builder, `@electron/fuses`, `@electron/asar`, TypeScript 6, Node.js 22, Playwright Electron, better-sqlite3, arm64 C helper, Zod, Vitest, `codesign`, `lipo`, and `hdiutil`

---

## Entry gates and file map

Start only after Phases 0–5 pass `npm run verify`, the Phase 1-owned exact aggregate `npm run test:native` (`test:native-contract` followed by `test:write-crash`), sentinel test-vault write/recovery tests, and fixture E2E. An unresolved recovery manifest, unknown rule-bundle hash, or failed atomic capability profile blocks this phase. Task 1 verifies and preserves that existing alias; Phase 6 must not redefine it to a different graph.

Phase 0 must already use `src/electron/`, `src/shared/desktop/bridge.ts`, `tsconfig.electron.json`, and `dist/electron/`; stop if any executable path still uses `src/desktop`, `tsconfig.desktop.json`, or `dist/desktop`.

Phase 1 must expose `MutationTargetPolicy` as the only coordinator authorization port, with `targetRoot`, `appDataRoot`, complete immutable `plan`, strict intent-owned `projectionCapsule`, full `NativeCapabilityProfile`, target/appData/recovery realpath-dev-ino bindings, branded authorization hashes, and `authorize`/`assertCurrent`; it must implement only `SentinelTestMutationPolicy`. Stop if the port accepts only a root/hash tuple, if the coordinator can execute without an opaque authorization, or if any environment variable enables a formal-root mutation. Phase 6 extends that exact port only with operation/native-grant/recovery bindings and injects the sole production implementation from Electron main; it must not remove or weaken any Phase 1 identity, capsule, scope, profile, or private-storage revalidation.

Phase 1 must also expose one descriptor-anchored private app-data storage boundary for recovery preparation, active batches, journals, staging, retained files, and scanning. Stop if any recovery path closes a verified parent and later reopens an absolute appData child path, or if manifest/result state is stored by rewriting a committed manifest. Phase 6 reuses that boundary directly for capability profiles, rule approval, and database quarantine. Recovery bundle source reads remain exclusively behind Phase 4's `MainRecoveryExporterPort`; export bytes stream directly into a user-selected native exclusive destination and never create a second appData bundle copy.

Phase 0 must already expose the server-side `RuleCompatibilityGate` port, strict `RuleApprovalRecord` schema, read-only/default-deny implementation, sentinel-fixture test-approved implementation, and health projection under the single blocked code `RULE_BUNDLE_UNAPPROVED`. Phase 1's coordinator must call the canonical `assertApproved(currentBundleSha256)` before manifest preparation and before every helper mutation. Phases 2–5 depend only on that port. Stop Phase 6 if those phases import Electron approval code, if a default allow implementation exists, or if they use another approval error code. Phase 6 supplies only the production read-only validator, Electron-native approval UI, and private production record store.

```text
electron-builder.yml
build/entitlements.mac.plist
tsup.electron.config.ts
scripts/electron-builder-after-pack.cjs
scripts/release/artifact-layout.ts
scripts/release/dependency-closure.ts
scripts/release/production-dependency-tree.ts
scripts/release/verify-packaged-app.ts
scripts/release/verify-dmg.ts
scripts/release/run-native-smoke.ts
scripts/release/run-deepseek-smoke.ts
scripts/acceptance/run-automated-gates.ts
scripts/acceptance/formal-vault-baseline.ts
scripts/acceptance/verify-formal-write.ts
scripts/acceptance/render-report.ts
src/electron/diagnostics/native-smoke.ts
src/electron/diagnostics/deepseek-smoke.ts
src/electron/ipc-authority.ts
src/electron/test-seam.ts
src/electron/production-mutation-target-policy.ts
src/electron/write-confirmation.ts
src/electron/native-recovery-export-port.ts
src/server/vault/test-vault-sentinel.ts
src/server/vault/NativeReadVaultPort.ts
src/server/vault/ReadOnlyPrivateRecoveryStore.ts
src/server/security/supervised-confirmation.ts
src/shared/acceptance/evidence.ts
src/shared/acceptance/read-only-vault-snapshot.ts
tests/electron/
tests/unit/release/
tests/integration/acceptance/
docs/runbook/
docs/acceptance/
```

Release artifacts and detailed evidence stay in ignored `release/` and `.local/acceptance/`. Reports under `docs/` contain no vault child paths, source text, model output, keys, or recovery bytes.

### Task 1: Pin Electron Builder, ASAR, and production fuses

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `electron-builder.yml`
- Create: `build/entitlements.mac.plist`
- Create: `tsup.electron.config.ts`
- Create: `scripts/electron-builder-after-pack.cjs`
- Create: `tests/unit/release/release-config.test.ts`

- [ ] **Step 1: Write the failing release-policy test**

Create `tests/unit/release/release-config.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { expect, test } from 'vitest';

test('release is arm64, ASAR-bound, and fuse-hardened', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
    main?: string; scripts?: Record<string, string>; devDependencies?: Record<string, string>;
  };
  const build = parse(await readFile('electron-builder.yml', 'utf8')) as Record<string, unknown>;
  const entitlements = await readFile('build/entitlements.mac.plist', 'utf8');
  const hook = await readFile('scripts/electron-builder-after-pack.cjs', 'utf8');
  expect(pkg.main).toBe('dist/electron/main.js');
  expect(pkg.scripts).toMatchObject({
    'dist:mac': 'npm run build && npm run build:native && npm run build:electron && electron-builder --config electron-builder.yml --mac --arm64',
    'verify:package': 'tsx scripts/release/verify-packaged-app.ts && tsx scripts/release/verify-dmg.ts',
    'test:native': 'npm run test:native-contract && npm run test:write-crash',
    'verify:personal-v1': 'tsx scripts/acceptance/run-automated-gates.ts'
  });
  expect(pkg.devDependencies).toMatchObject({
    electron: '44.1.0',
    'electron-builder': '26.15.3',
    '@electron/fuses': '2.1.3',
    '@electron/asar': '4.3.0'
  });
  expect(build).toMatchObject({
    appId: 'com.xiaozhao.brain', productName: '小兆大脑', asar: true,
    afterPack: 'scripts/electron-builder-after-pack.cjs',
    mac: {
      identity: '-', hardenedRuntime: true,
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.plist'
    }
  });
  expect(build.files).toEqual([
    'dist/client/**/*', 'dist/server/**/*', 'dist/electron/**/*', 'package.json', '!**/*.map'
  ]);
  expect(build.asarUnpack).toEqual(['node_modules/better-sqlite3/**/*']);
  expect(build.allowMissingDependencies).toBe(false);
  expect(entitlements).toContain('<key>com.apple.security.cs.allow-jit</key>');
  expect(entitlements).toContain('<key>com.apple.security.cs.disable-library-validation</key>');
  for (const value of [
    'RunAsNode]: false', 'EnableCookieEncryption]: true',
    'EnableNodeOptionsEnvironmentVariable]: false',
    'EnableNodeCliInspectArguments]: false',
    'EnableEmbeddedAsarIntegrityValidation]: true',
    'OnlyLoadAppFromAsar]: true',
    'LoadBrowserProcessSpecificV8Snapshot]: false',
    'GrantFileProtocolExtraPrivileges]: false'
  ]) expect(hook).toContain(value);
});
```

- [ ] **Step 2: Verify RED, then install exact locked tools**

Run:

```bash
npm run test:unit -- tests/unit/release/release-config.test.ts
npm install --save-dev --save-exact electron@44.1.0 electron-builder@26.15.3 @electron/fuses@2.1.3 @electron/asar@4.3.0
```

Expected: the test first fails on missing release files; npm then records exact resolved versions in both package files. Do not add updater, telemetry, publishing, crash-reporting, or notarization packages.

- [ ] **Step 3: Add fixed release scripts and preserve the Phase 1 native aggregate**

Set `package.json.main` and merge these scripts. `test:native` must already equal the shown Phase 1 aggregate; assert and preserve it rather than replacing its graph:

```json
{
  "main": "dist/electron/main.js",
  "scripts": {
    "build:electron": "tsup --config tsup.electron.config.ts",
    "test:native": "npm run test:native-contract && npm run test:write-crash",
    "dist:mac": "npm run build && npm run build:native && npm run build:electron && electron-builder --config electron-builder.yml --mac --arm64",
    "test:electron": "playwright test --config playwright.electron.config.ts",
    "verify:package": "tsx scripts/release/verify-packaged-app.ts && tsx scripts/release/verify-dmg.ts",
    "smoke:native:packaged": "tsx scripts/release/run-native-smoke.ts",
    "bootstrap:capability:packaged": "tsx scripts/release/run-production-capability-bootstrap.ts",
    "smoke:deepseek:real": "tsx scripts/release/run-deepseek-smoke.ts",
    "acceptance:formal:baseline": "tsx scripts/acceptance/formal-vault-baseline.ts",
    "acceptance:formal:verify": "tsx scripts/acceptance/verify-formal-write.ts",
    "acceptance:report": "tsx scripts/acceptance/render-report.ts",
    "acceptance:scan-public": "tsx scripts/acceptance/scan-public-evidence.ts",
    "verify:personal-v1": "tsx scripts/acceptance/run-automated-gates.ts"
  }
}
```

Create `electron-builder.yml`:

```yaml
appId: com.xiaozhao.brain
productName: 小兆大脑
artifactName: xiaozhao-brain-${version}-mac-${arch}.${ext}
directories: { output: release }
files:
  - dist/client/**/*
  - dist/server/**/*
  - dist/electron/**/*
  - package.json
  - '!**/*.map'
asar: true
asarUnpack: [node_modules/better-sqlite3/**/*]
extraResources:
  - { from: dist/native/atomic-file-helper, to: native/atomic-file-helper }
afterPack: scripts/electron-builder-after-pack.cjs
npmRebuild: true
allowMissingDependencies: false
mac:
  identity: '-'
  hardenedRuntime: true
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  category: public.app-category.productivity
  target:
    - { target: dir, arch: [arm64] }
    - { target: dmg, arch: [arm64] }
dmg: { sign: false, writeUpdateInfo: false }
```

Create `build/entitlements.mac.plist` for the local ad-hoc signature:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
```

`identity: '-'` is an explicit ad-hoc signature for this Mac, not a Developer ID signature. The library-validation entitlement is required because Electron's prebuilt frameworks and the locally signed app do not share a Developer ID team; keep hardened runtime enabled and continue to state that cross-machine Gatekeeper distribution and notarization are outside this release.

- [ ] **Step 4: Build main as ESM and sandboxed preload as CJS**

Set `tsup.electron.config.ts`:

```ts
import { defineConfig } from 'tsup';
export default defineConfig([
  {
    entry: { main: 'src/electron/main.ts' }, outDir: 'dist/electron',
    format: ['esm'], platform: 'node', target: 'node22',
    external: ['electron', 'better-sqlite3'], clean: true, splitting: false
  },
  {
    entry: { preload: 'src/electron/preload.ts' }, outDir: 'dist/electron',
    format: ['cjs'], platform: 'node', target: 'node22', external: ['electron'],
    clean: false, splitting: false, outExtension: () => ({ js: '.cjs' })
  }
]);
```

- [ ] **Step 5: Flip fuses in the packaged executable**

Create `scripts/electron-builder-after-pack.cjs`:

```js
const path = require('node:path');
const { Arch } = require('electron-builder');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
module.exports = async (context) => {
  if (context.electronPlatformName !== 'darwin' || context.arch !== Arch.arm64) {
    throw new Error('PHASE6_REQUIRES_DARWIN_ARM64');
  }
  const product = context.packager.appInfo.productFilename;
  const executable = path.join(context.appOutDir, `${product}.app`, 'Contents', 'MacOS', product);
  await flipFuses(executable, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false
  });
};
```

Keep `LoadBrowserProcessSpecificV8Snapshot` disabled. This release does not build or ship `browser_v8_context_snapshot.bin`; enabling the fuse without that dedicated artifact creates an unproved runtime dependency. `RunAsNode`, Node option/inspect flags, and file-protocol privileges remain disabled, while cookie encryption and ASAR integrity remain enabled.

- [ ] **Step 6: Verify GREEN and commit**

```bash
npm run test:unit -- tests/unit/release/release-config.test.ts
npm run build
npm run build:native
npm run build:electron
git add package.json package-lock.json electron-builder.yml build/entitlements.mac.plist tsup.electron.config.ts scripts/electron-builder-after-pack.cjs tests/unit/release/release-config.test.ts
git commit -m "build: define hardened arm64 desktop package"
```

Expected: all build commands exit `0`; main, preload, native helper, client, server, and migrations exist under `dist/`.

### Task 2: Inspect the actual `.app` and `.dmg`

**Files:**
- Create: `scripts/release/artifact-layout.ts`
- Create: `scripts/release/artifact-digest.ts`
- Create: `scripts/release/production-dependency-tree.ts`
- Create: `scripts/release/verify-packaged-app.ts`
- Create: `scripts/release/verify-dmg.ts`
- Create: `tests/unit/release/artifact-layout.test.ts`
- Create: `tests/unit/release/artifact-digest.test.ts`
- Create: `tests/unit/release/production-dependency-tree.test.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Lock paths with a failing unit test**

```ts
import { expect, test } from 'vitest';
import { releaseLayout } from '../../../scripts/release/artifact-layout.js';
test('release paths are exact', () => expect(releaseLayout('0.1.0')).toEqual({
  app: 'release/mac-arm64/小兆大脑.app',
  executable: 'release/mac-arm64/小兆大脑.app/Contents/MacOS/小兆大脑',
  asar: 'release/mac-arm64/小兆大脑.app/Contents/Resources/app.asar',
  unpacked: 'release/mac-arm64/小兆大脑.app/Contents/Resources/app.asar.unpacked',
  helper: 'release/mac-arm64/小兆大脑.app/Contents/Resources/native/atomic-file-helper',
  dmg: 'release/xiaozhao-brain-0.1.0-mac-arm64.dmg'
}));
```

Run exactly:

```bash
npm run test:unit -- tests/unit/release/artifact-layout.test.ts
```

Expected: FAIL because the module is absent.

- [ ] **Step 2: Write the failing production-tree and signature-policy tests**

Create `tests/unit/release/production-dependency-tree.test.ts`:

```ts
import { expect, test } from 'vitest';
import {
  assertExactSet, packagedProductionPackageRoots
} from '../../../scripts/release/production-dependency-tree.js';

test('derives exact packaged production package roots', () => {
  const entries = [
    'node_modules/fastify/package.json',
    'node_modules/fastify/lib/reply.js',
    'node_modules/@fastify/cookie/package.json',
    'node_modules/vitest/package.json'
  ];
  expect(packagedProductionPackageRoots(entries)).toEqual([
    'node_modules/@fastify/cookie', 'node_modules/fastify', 'node_modules/vitest'
  ]);
  expect(() => assertExactSet(
    ['node_modules/@fastify/cookie', 'node_modules/fastify'],
    packagedProductionPackageRoots(entries)
  )).toThrow(/UNEXPECTED_PACKAGED_PRODUCTION_DEPENDENCY/u);
});
```

Extend `artifact-layout.test.ts` with fixtures for `Signature=adhoc`, `TeamIdentifier=not set`, the two allowed entitlements, an injected `com.apple.security.get-task-allow`, a missing migration, and a changed migration byte. Require the first two to pass and every injected difference to fail with a distinct code.

Create `artifact-digest.test.ts` with a temporary `.app` tree containing regular files, directories, and a relative symlink. Require deterministic UTF-8 path order and stable SHA-256; changing file bytes/mode or symlink target changes the digest, while a socket/FIFO fails `UNSUPPORTED_ARTIFACT_ENTRY` without being followed.

Run:

```bash
npm run test:unit -- tests/unit/release/artifact-layout.test.ts tests/unit/release/artifact-digest.test.ts tests/unit/release/production-dependency-tree.test.ts
```

Expected: FAIL because the verifier helpers do not exist.

- [ ] **Step 3: Implement exact path and production-dependency inventory helpers**

Create `artifact-layout.ts` using `path.join` and a strict `^\d+\.\d+\.\d+$` version check. Create `production-dependency-tree.ts` with these public functions:

```ts
export async function sourceProductionPackageRoots(repoRoot: string): Promise<readonly string[]> {
  const { stdout } = await execFileAsync(
    'npm', ['ls', '--omit=dev', '--all', '--parseable'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
  );
  return [...new Set(stdout.split('\n').filter(Boolean).slice(1).map((absolute) => {
    const value = relative(repoRoot, absolute).split(sep).join('/');
    if (!value.startsWith('node_modules/')) throw new Error('PRODUCTION_TREE_PATH_ESCAPE');
    return value;
  }))].sort();
}

export function packagedProductionPackageRoots(entries: readonly string[]): readonly string[] {
  return [...new Set(entries
    .filter((entry) => entry.startsWith('node_modules/') && entry.endsWith('/package.json'))
    .map((entry) => entry.slice(0, -'/package.json'.length)))].sort();
}

export function assertExactSet(expected: readonly string[], actual: readonly string[]): void {
  const missing = expected.filter((value) => !actual.includes(value));
  const unexpected = actual.filter((value) => !expected.includes(value));
  if (missing.length) throw new Error(`MISSING_PACKAGED_PRODUCTION_DEPENDENCY:${missing.join(',')}`);
  if (unexpected.length) throw new Error(
    `UNEXPECTED_PACKAGED_PRODUCTION_DEPENDENCY:${unexpected.join(',')}`
  );
}
```

Do not treat the three explicitly named native-module dependencies as a Builder whitelist. Electron Builder always collects the resolved production dependency tree; this helper makes the source tree and signed artifact agree exactly.

Create `artifact-digest.ts` with `hashAppTree(appPath)` and `hashFileBytes(filePath)`. It walks with `lstat`, never follows links, rejects special files, sorts canonical relative-path/type/mode/size/content-hash-or-link-target records, and hashes canonical JSON. Tasks 5 and 8 import this one implementation; neither reimplements an App tree hash.

- [ ] **Step 4: Inspect architecture, ASAR, migrations, fuses, signature, and entitlements**

In `verify-packaged-app.ts`, export `verifyAppBundle(appPath)` and execute these assertions in order:

```ts
await command('lipo', ['-archs', layout.executable], /^arm64\s*$/u);
await command('lipo', ['-archs', layout.helper], /^arm64\s*$/u);
await command('file', [layout.helper], /Mach-O 64-bit executable arm64/u);
await command('test', ['-x', layout.helper]);
await command('codesign', ['--verify', '--deep', '--strict', layout.app]);
const sqliteNode = await findExactlyOne(layout.unpacked, 'better_sqlite3.node');
await command('lipo', ['-archs', sqliteNode], /^arm64\s*$/u);
const entries = listPackage(layout.asar).map((entry) => entry.replace(/^\//u, ''));
for (const required of [
  'dist/client/index.html', 'dist/server/index.js',
  'dist/electron/main.js', 'dist/electron/preload.cjs'
]) assertEntry(entries, required);

const migrationNames = [
  '001_initial.sql', '002_read_api_jobs.sql', '003_write_kernel.sql',
  '004_intake_workflow.sql', '005_extraction_workflow.sql',
  '006_formal_ingestion.sql', '007_editor_workflow.sql'
] as const;
const packagedMigrations = entries
  .filter((entry) => entry.startsWith('dist/server/db/migrations/') && entry.endsWith('.sql'))
  .map((entry) => entry.slice('dist/server/db/migrations/'.length)).sort();
assertExactSet([...migrationNames], packagedMigrations);
for (const name of migrationNames) {
  assertSha256Equal(
    await readFile(join('dist/server/db/migrations', name)),
    extractFile(layout.asar, `dist/server/db/migrations/${name}`),
    `MIGRATION_BYTES_MISMATCH:${name}`
  );
}

assertExactSet(
  await sourceProductionPackageRoots(process.cwd()),
  packagedProductionPackageRoots(entries)
);
assertNoEntry(entries, (entry) =>
  entry.endsWith('.map') || /(^|\/)\.env(?:\.|$)/u.test(entry)
  || /(^|\/)(tests?|fixtures?|coverage)(\/|$)/u.test(entry)
);
await command('npx', ['--no-install', '@electron/fuses', 'read', '--app', layout.app],
  /RunAsNode.*Disabled[\s\S]*OnlyLoadAppFromAsar.*Enabled[\s\S]*LoadBrowserProcessSpecificV8Snapshot.*Disabled/u);
```

Inspect the signed result, not only `electron-builder.yml`:

```ts
const electronBundles = [
  layout.app,
  join(layout.app, 'Contents/Frameworks/小兆大脑 Helper.app'),
  join(layout.app, 'Contents/Frameworks/小兆大脑 Helper (GPU).app'),
  join(layout.app, 'Contents/Frameworks/小兆大脑 Helper (Plugin).app'),
  join(layout.app, 'Contents/Frameworks/小兆大脑 Helper (Renderer).app')
];
for (const target of [...electronBundles, layout.helper, sqliteNode]) {
  const details = await captureStderr('codesign', ['-dv', '--verbose=4', target]);
  if (!/^Signature=adhoc$/mu.test(details)) fail('SIGNATURE_IS_NOT_ADHOC');
  if (!/^TeamIdentifier=not set$/mu.test(details)) fail('UNEXPECTED_TEAM_IDENTIFIER');
  await command('codesign', ['--verify', '--strict', target]);
}

const allowedEntitlements = new Set([
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.disable-library-validation'
]);
for (const target of electronBundles) {
  const entitlements = await readEntitlementsWithCodesignAndPlutil(target);
  if (entitlements['com.apple.security.cs.allow-jit'] !== true) fail('ALLOW_JIT_MISSING');
  if (entitlements['com.apple.security.cs.disable-library-validation'] !== true) {
    fail('LIBRARY_VALIDATION_ENTITLEMENT_MISSING');
  }
  for (const key of Object.keys(entitlements)) {
    if (!allowedEntitlements.has(key)) fail(`UNEXPECTED_ENTITLEMENT:${key}`);
  }
}
for (const target of [layout.helper, sqliteNode]) {
  const entitlements = await readEntitlementsWithCodesignAndPlutil(target);
  for (const key of Object.keys(entitlements)) {
    if (!allowedEntitlements.has(key)) fail(`UNEXPECTED_NATIVE_ENTITLEMENT:${key}`);
  }
}
```

`readEntitlementsWithCodesignAndPlutil()` captures `codesign -d --entitlements :-`, pipes the plist bytes to `plutil -convert json -o - -- -`, parses one JSON object, and rejects `com.apple.security.get-task-allow`, `com.apple.security.app-sandbox`, false values, arrays, and non-boolean entitlement values. The script prints only `PASSED packaged-app version=0.1.0 arch=arm64 signature=adhoc migrations=7 productionTree=exact`.

- [ ] **Step 5: Mount and verify the DMG read-only**

Create `verify-dmg.ts` to run `hdiutil verify`, mount to `mkdtemp(join(tmpdir(), 'xiaozhao-dmg-'))` with `-readonly -nobrowse -mountpoint`, call the same exported `verifyAppBundle()` against the mounted `小兆大脑.app`, detach in `finally`, and remove only that exact temporary mount directory. Print `PASSED dmg version=0.1.0 mounted=readonly signature=adhoc`.

```ts
const mountRoot = await mkdtemp(join(tmpdir(), 'xiaozhao-dmg-'));
let attached = false;
try {
  await command('hdiutil', ['verify', layout.dmg]);
  await command('hdiutil', [
    'attach', layout.dmg, '-readonly', '-nobrowse', '-mountpoint', mountRoot
  ]);
  attached = true;
  await verifyAppBundle(join(mountRoot, '小兆大脑.app'));
} finally {
  if (attached) await command('hdiutil', ['detach', mountRoot]);
  await removeCapturedEmptyMountRoot(mountRoot, 'xiaozhao-dmg-');
}
```

- [ ] **Step 6: Ignore private outputs, build, verify, and commit**

Append `release/` and `.local/acceptance/` to `.gitignore`, then run:

```bash
npm run test:unit -- tests/unit/release/artifact-layout.test.ts tests/unit/release/artifact-digest.test.ts tests/unit/release/production-dependency-tree.test.ts
npm run dist:mac
npm run verify:package
codesign --verify --deep --strict "release/mac-arm64/小兆大脑.app"
hdiutil verify "release/xiaozhao-brain-0.1.0-mac-arm64.dmg"
git add .gitignore scripts/release/artifact-layout.ts scripts/release/artifact-digest.ts scripts/release/production-dependency-tree.ts scripts/release/verify-packaged-app.ts scripts/release/verify-dmg.ts tests/unit/release/artifact-layout.test.ts tests/unit/release/artifact-digest.test.ts tests/unit/release/production-dependency-tree.test.ts
git commit -m "test: verify packaged desktop artifacts"
```

Expected: every command exits `0`; both the directory artifact and the mounted DMG contain the same seven migration bytes and exact production dependency tree, and every executable is arm64 with an ad-hoc signature. This proves current-Mac local integrity, not Developer ID signing or notarization.

### Task 3: Prove packaged Electron and loopback security

**Files:**
- Modify: `playwright.electron.config.ts`
- Create: `tests/electron/packaged-fixture.ts`
- Create: `tests/electron/packaged-security.spec.ts`
- Create: `tests/electron/packaged-lifecycle.spec.ts`
- Create: `tests/electron/packaged-ui-regression.spec.ts`
- Create: `tests/electron/packaged-database-recovery.spec.ts`
- Create: `tests/unit/electron/runtime.test.ts`
- Create: `tests/unit/electron/test-seam.test.ts`
- Create: `tests/unit/electron/ipc-authority.test.ts`
- Create: `src/electron/database-recovery.ts`
- Create: `src/electron/test-seam.ts`
- Create: `src/electron/ipc-authority.ts`
- Modify: `src/electron/main.ts`
- Create: `src/electron/runtime.ts`
- Modify: `src/electron/window-policy.ts`
- Modify: `src/electron/preload.ts`
- Modify: `src/shared/desktop/bridge.ts`
- Modify: `src/server/db/database.ts`
- Modify: `src/server/start-server.ts`

- [ ] **Step 1: Configure single-worker packaged tests**

```ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/electron', fullyParallel: false, workers: 1,
  timeout: 60_000, expect: { timeout: 10_000 }, reporter: 'list',
  use: { trace: 'retain-on-failure' }
});
```

- [ ] **Step 2: Create a packaged fixture that cannot resolve the formal vault**

Create `tests/electron/packaged-fixture.ts`. Reuse Phase 0's `createFilesystemReadFixture()` so the vault contains `.xiaozhao-read-test-vault.json`, create user data with `mkdtemp(join(tmpdir(), 'xiaozhao-packaged-user-data-'))`, and launch with this exact environment:

```ts
export async function launchPackagedFixture(): Promise<PackagedFixture> {
  const vault = await createFilesystemReadFixture();
  const userData = await mkdtemp(join(tmpdir(), 'xiaozhao-packaged-user-data-'));
  const executable = resolve('release/mac-arm64/小兆大脑.app/Contents/MacOS/小兆大脑');
  const application = await electron.launch({
    executablePath: executable,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      XIAOZHAO_TEST_VAULT_ROOT: vault.root,
      XIAOZHAO_TEST_USER_DATA: userData
    }
  });
  return { application, vault, userData, async cleanup() {
    await application.close();
    await vault.cleanup();
    await rm(userData, { recursive: true, force: false });
  } };
}
```

Do not rely on `--user-data-dir` by itself. Before `app.setPath()` or `app.whenReady()`, `test-seam.ts` must validate both environment paths without creating either one. Each must already be a real, non-symlink directory owned by the current uid, mode `0700`, and a direct child of the component-walked canonical `tmpdir()` with its exact fixture prefix; test userData must be empty and the vault must carry the exact Phase 0 read sentinel. Resolve and bind both dev/ino identities, require the two roots to be disjoint in both ancestor directions, and reject the canonical/configured formal vault plus every realpath/symlink alias, ancestor, or descendant of it for either variable. Only the returned branded `{ vaultRoot, userDataRoot, vaultIdentity, userDataIdentity }` may be passed to `app.setPath('userData', ...)`; immediately reobserve the same identities after `setPath` and again before constructing settings, gateway, watcher, server, SQLite, native helper, or BrowserWindow. A mismatch exits with a stable safe code and never falls back to normal userData.

- [ ] **Step 3: Write failing security/lifecycle and formal-root-denial tests**

Launch every packaged test through `launchPackagedFixture()` and assert:

```ts
expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//u);
expect(await page.evaluate(() => typeof globalThis.process)).toBe('undefined');
expect(await page.evaluate(() => typeof globalThis.require)).toBe('undefined');
expect(await page.evaluate(() => Object.keys(window.xiaozhaoDesktop).sort())).toEqual([
  'chooseVaultDirectory',
  'clearModelApiKey',
  'getAppVersion',
  'getModelApiKeyStatus',
  'getModelEndpointSettings',
  'setModelApiKey',
  'setModelEndpointSettings'
]);
expect(await application.evaluate(({ BrowserWindow }) => {
  const p = BrowserWindow.getAllWindows()[0]!.webContents.getLastWebPreferences();
  return [p.contextIsolation, p.nodeIntegration, p.sandbox, p.webSecurity, p.allowRunningInsecureContent];
})).toEqual([true, false, true, true, false]);
```

Also assert `window.open('https://example.com') === null`, non-runtime navigation stays on the loopback origin, geolocation is denied, CSP contains `default-src 'self'`, session Cookie is HttpOnly/SameSite=Strict, mutation without session is `401`, hostile Origin is `403`, invalid Host is `421`, a second process exits `0` without a second window, and closing the first process makes the ephemeral port refuse connections.

In `packaged-ui-regression.spec.ts`, seed the fixture with exactly one `未提炼`, one `部分入库`, and one `已入库` material. At BrowserWindow content widths 720, 800, and 1280, assert `.sidebar` has `x === 0`, `y === 0`, height within 2 px of viewport height, and its right edge is left of the main content. At 720/800 its width is 68–76 px, `.sidebar-nav` has column direction, text/footer are hidden, and no navigation element is anchored as a viewport-width bottom bar; at 1280 it remains the expanded left sidebar. On Dashboard, `[data-material-deck] [data-material-card-trigger]` contains only the `未提炼` record; the `部分入库` and `已入库` names are absent. On Queue, the `部分入库` record remains visible and actionable while `已入库` is not a default task.

For Dashboard, Queue, confirmation, editor, and recovery containers, require computed styles to resolve through the existing `--surface-void`, `--surface-glass`, `--border-*`, `--accent-primary`, `--status-amber`, `--status-red`, and `--status-blue` variables, with no alternate theme stylesheet. Stub `prefers-reduced-motion: reduce`; assert nonessential transition duration is `0s`, animated transforms are `none`, long diff/detail surfaces have no backdrop blur, and focus/progress/status text remains visible. This is a structural/token regression test, not a pixel golden.

Add a separate subprocess case with a fresh temporary user-data path and:

```ts
env: {
  ...process.env,
  NODE_ENV: 'test',
  XIAOZHAO_TEST_VAULT_ROOT: '/Users/ao/我的大脑',
  XIAOZHAO_TEST_USER_DATA: userData
}
```

Require non-zero exit, stderr ending in `FORMAL_VAULT_FORBIDDEN_IN_TEST`, no `XIAOZHAO_RUNTIME_READY` marker, no listener port, and no `state.sqlite3`, `recovery`, or `backups` under that temporary user data. In the pure `test-seam.test.ts`, inject path/identity adapters and test the formal root, a child, an ancestor, and a symlink alias independently in both environment slots; assert rejection occurs before the injected `setUserDataPath`, filesystem creator, or runtime factory. Also reject vault/userData overlap in either direction, a non-direct tmp child, wrong prefix, non-empty userData, wrong owner/mode, and replacement of either directory between validation, `app.setPath`, and runtime construction. Never launch a packaged subprocess whose test userData points at the real formal vault; the packaged suite uses safe temporary aliases and proves the same branded seam is the only route to `app.setPath`. Repeat the existing formal-vault-root subprocess with `WRITE_ENABLED=true` and `VAULT_REAL_ROOT=/Users/ao/我的大脑`, but keep `NODE_ENV=test`, the temporary sentinel root, and the temporary userData unchanged.

Do not launch a subprocess with `NODE_ENV=production` plus `XIAOZHAO_TEST_*`: Phase 0 intentionally ignores the test seam outside test mode, so that combination could resolve normal userData. Instead create `tests/unit/electron/runtime.test.ts` and prove purely in process that environment strings cannot turn a source build into production authority:

```ts
import { describe, expect, test } from 'vitest';
import { resolveLaunchMode } from '../../../src/electron/runtime.js';

describe('resolveLaunchMode', () => {
  test.each([undefined, 'development', 'production'])(
    'non-packaged nodeEnv=%s remains development-read-only',
    (nodeEnv) => expect(resolveLaunchMode({ isPackaged: false, argv: [], nodeEnv }))
      .toBe('development-read-only')
  );
  test('test mode remains the sentinel seam even for a packaged fixture', () => {
    expect(resolveLaunchMode({ isPackaged: true, argv: [], nodeEnv: 'test' }))
      .toBe('test-sentinel');
  });
  test.each([
    '--native-smoke', '--deepseek-smoke',
    '--bootstrap-capability-profile', '--capability-crash-worker'
  ])('source build ignores privileged mode %s', (mode) => {
    expect(resolveLaunchMode({ isPackaged: false, argv: [mode], nodeEnv: 'production' }))
      .toBe('development-read-only');
  });
});
```

Run exactly:

```bash
npm run test:unit -- tests/unit/electron/runtime.test.ts tests/unit/electron/test-seam.test.ts tests/unit/electron/ipc-authority.test.ts
npm run test:electron
```

Expected: FAIL until all packaged boundaries are enforced.

- [ ] **Step 4: Lock launch mode, window, and IPC policy**

In `runtime.ts`, derive launch mode without an enabling environment switch:

```ts
export type ElectronLaunchMode =
  | 'normal-packaged' | 'development-read-only' | 'test-sentinel'
  | 'native-smoke' | 'deepseek-smoke'
  | 'capability-bootstrap' | 'capability-crash-worker';

export function resolveLaunchMode(input: {
  readonly isPackaged: boolean;
  readonly argv: readonly string[];
  readonly nodeEnv?: string;
}): ElectronLaunchMode {
  if (!input.isPackaged) return 'development-read-only';
  if (input.argv.includes('--native-smoke')) return 'native-smoke';
  if (input.argv.includes('--deepseek-smoke')) return 'deepseek-smoke';
  if (input.argv.includes('--bootstrap-capability-profile')) return 'capability-bootstrap';
  if (input.argv.includes('--capability-crash-worker')) return 'capability-crash-worker';
  if (input.nodeEnv === 'test') return 'test-sentinel';
  return 'normal-packaged';
}
```

Only `normal-packaged` may later receive the production mutation policy. `development-read-only` receives a deny-all mutation policy and `test-sentinel` always receives `SentinelTestMutationPolicy`. Every diagnostic/bootstrap adapter independently asserts `app.isPackaged`; command-line mode flags on a source build stay `development-read-only` and cannot write a profile. Native/DeepSeek diagnostics branch before settings/server/vault imports. Capability bootstrap may read the configured formal-root identity and write only a separate sentinel probe plus private capability evidence; its crash worker accepts only that sentinel root. Both branch before production policy/server construction and before the single-instance lock. `NODE_ENV=production`, `WRITE_ENABLED`, `VAULT_REAL_ROOT`, HTTP body fields, and renderer data are not inputs that can produce `normal-packaged`.

Use this policy in `window-policy.ts` and main:

```ts
session.setPermissionCheckHandler(() => false);
session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
session.on('will-download', (event) => event.preventDefault());
window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
window.webContents.on('will-navigate', (event, url) => {
  if (new URL(url).origin !== runtimeOrigin) event.preventDefault();
});
window.webContents.on('will-attach-webview', (event) => event.preventDefault());
```

Every IPC handler begins with one shared `assertTrustedMainFrameIpc(event, window, runtimeOrigin)`. It requires `event.sender === window.webContents`, a non-null `event.senderFrame === window.webContents.mainFrame`, and the parsed `event.senderFrame.url` origin to equal the exact bound runtime origin at invocation time; checking only `event.sender.getURL()` is forbidden. The unit and packaged suites invoke each privileged channel from a fake/second `WebContents`, a same-origin child frame, a stale frame captured across navigation, and a foreign frame and require rejection before dialog, settings, grant, export, or filesystem access. Preload exposes named methods only; no generic channel invocation. BrowserWindow keeps `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`, `webSecurity:true`, `allowRunningInsecureContent:false`.

- [ ] **Step 5: Prove packaged SQLite-corruption startup without a vault write**

Reuse Phase 0's `StateKernel` recovery-only mode and Phase 1/4's SQLite-independent recovery scanner; do not create a second recovery format or coordinator. `database-recovery.ts` creates/opens the private appData recovery root before SQLite, asks the existing scanner for validated incomplete manifests, then handles only these states:

```text
SQLite healthy -> normal start
SQLite corrupt + one or more valid incomplete manifests -> recovery-only start
SQLite corrupt + no manifest -> native choice: cancel, or quarantine and read-only rebuild
SQLite corrupt + invalid/corrupt recovery evidence -> recovery-only/manual-only; never rebuild over it
```

Recovery-only startup serves the static App shell, health, and validated recovery summaries. At this point its continue/rollback/resolve/export controls are present but disabled with `DESKTOP_RECOVERY_ACTION_UNAVAILABLE_UNTIL_PHASE6`; Task 7 replaces that deny adapter with production authority/native confirmation/export. It disables ordinary workspace/queue/editor pages, index scheduler, watcher/reconciler, automatic intake, model runs, new plan creation, and ordinary write routes. UI states exactly `数据库不可用 · 仅恢复模式` and routes to `RecoveryDetailPage`; it never infers completion from the corrupt DB.

When no manifest exists, show a main-process `dialog.showMessageBox` with buttons `['取消', '隔离并只读重建']`, default/cancel `0`, and no renderer/HTTP override. Cancel leaves every DB byte untouched and starts a read-only blocked shell. Response `1` creates `<userData>/quarantine/<operationId>/` mode `0700`, hashes the present `state.sqlite3`, `-wal`, and `-shm`, and fsyncs a private quarantine intent before moving anything. Move each present file exclusively to its named `0600` quarantine target, fsync both parents, append/fsync a hash-chained result, and resume that same intent after a crash; an existing unexpected target is manual-only. Only after every planned source is preserved may it create a fresh database under userData, apply exact migrations 001–007, and rebuild projections/index by reading the validated vault gateway. Require SQLite integrity, schema version 007, and index-to-current-file hash equality before normal startup; failure preserves quarantine and returns recovery-only. No branch writes a database, manifest, staging file, lock, quarantine, or log in the vault.

`packaged-database-recovery.spec.ts` uses only the sentinel packaged fixture and captures the full vault aggregate/namespace before and after through the descriptor snapshot port. Cover: corrupt DB plus valid incomplete manifest opens only recovery UI and leaves watcher/new-write routes disabled; corrupt DB plus no manifest cancel is byte-for-byte no-op; confirm produces an exclusive appData quarantine and a valid rebuilt DB; existing quarantine target, rebuild failure, invalid manifest, WAL/SHM, and symlink DB/quarantine fail closed. Database/quarantine discovery and moves use Phase 1's held, identity-bound private app-data storage port; no absolute child pathname is reopened after validation. The test response seam is accepted only with `NODE_ENV=test`, validated test-vault sentinel, and temporary test userData; it is rejected before filesystem access in normal packaged mode. Every case requires unchanged vault hashes and zero vault runtime artifacts.

Run:

```bash
npm run dist:mac
npm run test:electron -- tests/electron/packaged-database-recovery.spec.ts
```

Expected: all corruption cases pass; valid manifests remain recoverable without SQLite, no-manifest rebuild needs native confirmation, and the formal vault is never opened by automation.

- [ ] **Step 6: Rebuild, verify GREEN, and commit**

```bash
npm run dist:mac
npm run verify:package
npm run test:unit -- tests/unit/electron/runtime.test.ts tests/unit/electron/test-seam.test.ts tests/unit/electron/ipc-authority.test.ts
npm run test:electron
npm run test:security
git add playwright.electron.config.ts tests/electron/packaged-fixture.ts tests/electron/packaged-security.spec.ts tests/electron/packaged-lifecycle.spec.ts tests/electron/packaged-ui-regression.spec.ts tests/electron/packaged-database-recovery.spec.ts tests/unit/electron/runtime.test.ts tests/unit/electron/test-seam.test.ts tests/unit/electron/ipc-authority.test.ts src/electron/database-recovery.ts src/electron/test-seam.ts src/electron/ipc-authority.ts src/electron/main.ts src/electron/runtime.ts src/electron/window-policy.ts src/electron/preload.ts src/shared/desktop/bridge.ts src/server/db/database.ts src/server/start-server.ts
git commit -m "test: harden packaged electron runtime"
```

Expected: all commands exit `0`; every packaged test uses a sentinel fixture, formal-root aliases fail before runtime construction, and shutdown closes watcher, indexer, Fastify, SQLite, and the port.

### Task 4: Prove packaged native execution and bootstrap the production capability profile

**Files:**
- Create: `src/server/vault/test-vault-sentinel.ts`
- Create: `src/electron/diagnostics/native-smoke.ts`
- Create: `src/electron/diagnostics/packaged-native-adapter.ts`
- Create: `src/electron/diagnostics/production-capability-bootstrap.ts`
- Create: `src/electron/diagnostics/packaged-crash-worker.ts`
- Create: `src/electron/capability-bootstrap-action.ts`
- Create: `src/electron/app-bootstrap-handshake.ts`
- Create: `scripts/release/run-native-smoke.ts`
- Create: `scripts/release/run-production-capability-bootstrap.ts`
- Create: `tests/unit/release/native-smoke.test.ts`
- Create: `tests/unit/release/production-capability-bootstrap.test.ts`
- Create: `tests/electron/packaged-capability-bootstrap.spec.ts`
- Create: `tests/electron/capability-bootstrap-action.spec.ts`
- Modify: `tests/electron/packaged-security.spec.ts`
- Create: `tests/component/settings-capability-bootstrap.test.tsx`
- Modify: `native/macos/atomic-file-helper.c`
- Modify: `src/server/vault/native-read-helper-protocol.ts`
- Modify: `src/server/vault/NativeReadVaultPort.ts`
- Modify: `src/server/vault/PrivateRecoveryStore.ts`
- Create: `src/server/vault/ReadOnlyPrivateRecoveryStore.ts`
- Modify: `tests/unit/native-read-helper-protocol.test.ts`
- Modify: `tests/unit/private-recovery-store.test.ts`
- Modify: `tests/native/native-read-helper.contract.test.ts`
- Modify: `src/server/vault/MutationTargetPolicy.ts`
- Modify: `src/server/vault/native-capability-profile.ts`
- Modify: `src/server/vault/native-capability-probe.ts`
- Create: `src/shared/acceptance/read-only-vault-snapshot.ts`
- Modify: `tests/helpers/atomic-test-vault.ts`
- Modify: `src/electron/main.ts`
- Modify: `src/electron/ipc-authority.ts`
- Modify: `src/electron/runtime.ts`
- Modify: `src/electron/preload.ts`
- Modify: `src/shared/desktop/bridge.ts`
- Modify: `src/client/pages/SettingsPage.tsx`
- Modify: `package.json`

- [ ] **Step 1: Write a failing dependency-boundary test**

```ts
const result = await runNativeSmoke({
  arch: 'arm64',
  sqlite: async () => ({ opened: true, integrity: 'ok' }),
  helper: async () => ({ exclusiveCreate: true, atomicSwap: true, parentFsync: true })
});
expect(result).toEqual({
  status: 'passed', arch: 'arm64', sqlite: 'ok', helper: 'passed',
  policy: 'sentinel-test-v1', tempRoot: 'system', formalVaultOpened: false
});
```

Also inject a working-directory path named `/Users/ao/我的大脑` and prove the diagnostic still calls `mkdtemp(join(tmpdir(), ...))`; inject a sentinel with a newline, wrong filename, wrong mode, symlink, or old Phase 6 value and require rejection before a helper call. Run exactly:

```bash
npm run test:unit -- tests/unit/release/native-smoke.test.ts
```

Expected: FAIL because the diagnostic and shared sentinel module are absent.

- [ ] **Step 2: Establish one exact test-vault sentinel truth**

Create `src/server/vault/test-vault-sentinel.ts`:

```ts
export const TEST_VAULT_SENTINEL_NAME = '.xiaozhao-atomic-test-vault.json' as const;
export const TEST_VAULT_SENTINEL_BYTES = Buffer.from(
  '{"purpose":"xiaozhao-atomic-write-contract","schemaVersion":1}',
  'utf8'
);
export const TEST_VAULT_SENTINEL_MODE = 0o600 as const;
```

Refactor `SentinelTestMutationPolicy` and `tests/helpers/atomic-test-vault.ts` to import those constants. The helper uses `open(..., O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)`, writes the exact bytes with no trailing newline, fsyncs, closes, rereads, checks regular-file/dev/ino/mode/bytes, and fsyncs the temporary vault parent. No second sentinel filename or content literal remains in the repository.

Task 4 deliberately keeps Phase 1's execute-only `MutationPolicyInput`, `MutationTargetAuthorization`, and `MutationTargetPolicy` contracts unchanged. The sentinel diagnostic uses those existing complete plan/capsule/root/profile bindings. Task 7 owns the additive operation, optional native-grant, recovery-snapshot, resolution-selection, and release-contract extension, because that task also updates every existing coordinator caller and crash/integration fixture in the same commit.

- [ ] **Step 3: Implement the diagnostic through the sentinel policy and packaged capability probe**

`native-smoke.ts` must create two non-overlapping roots with `mkdtemp(join(tmpdir(), ...))`:

```ts
const vaultRoot = await mkdtemp(join(tmpdir(), 'xiaozhao-native-vault-'));
const appDataRoot = await mkdtemp(join(tmpdir(), 'xiaozhao-native-app-data-'));
try {
  await createExactTestVaultSentinel(vaultRoot);
  const sqlitePath = join(appDataRoot, 'native-smoke.sqlite3');
  const sqlite = new Database(sqlitePath);
  const integrity = sqlite.pragma('integrity_check', { simple: true });
  sqlite.close();
  if (integrity !== 'ok') throw new Error('PACKAGED_SQLITE_INTEGRITY_FAILED');

  const profile = await probeNativeCapabilityProfile({ vaultRoot, appDataRoot, helperPath });
  const policy = new SentinelTestMutationPolicy({ formalRoot: '/Users/ao/我的大脑' });
  const plan = createNativeSmokePlan(vaultRoot, profile.profileKey);
  const projectionCapsule = createKernelTestProjectionCapsule(plan);
  const policyInput: MutationPolicyInput = {
    targetRoot: vaultRoot, appDataRoot, plan, projectionCapsule, profile
  };
  const authorization = await policy.authorize(policyInput);
  await policy.assertCurrent(authorization, policyInput);
  return {
    status: 'passed', arch: 'arm64', sqlite: 'ok', helper: 'passed',
    policy: 'sentinel-test-v1', tempRoot: 'system', formalVaultOpened: false
  } as const;
} finally {
  await removeOwnedTempRoot(vaultRoot, 'xiaozhao-native-vault-');
  await removeOwnedTempRoot(appDataRoot, 'xiaozhao-native-app-data-');
}
```

The capability probe performs the packaged helper's exclusive create, atomic swap, no-follow, file/parent fsync, and conflict-preservation cases. The diagnostic never loads settings, Fastify, watcher, indexer, production policy, or a configured vault. `removeOwnedTempRoot` requires a real path directly under `tmpdir()`, the exact generated prefix, and the captured dev/ino before recursive removal.

- [ ] **Step 4: Add the pre-runtime packaged branch**

In `main.ts`, branch before Fastify or vault settings are loaded:

```ts
if (process.argv.includes('--native-smoke')) {
  const { runPackagedNativeSmoke } = await import('./diagnostics/packaged-native-adapter.js');
  const result = await runPackagedNativeSmoke({ resourcesPath: process.resourcesPath, arch: process.arch });
  process.stdout.write(`XIAOZHAO_NATIVE_SMOKE ${JSON.stringify(result)}\n`);
  app.exit(result.status === 'passed' ? 0 : 1);
}
```

- [ ] **Step 5: Parse strict packaged output and prove GREEN**

`run-native-smoke.ts` spawns the fixed packaged executable with `cwd:tmpdir()`, a fresh temporary user-data directory, and no vault/configuration environment variables. It validates literals `status=passed`, `arch=arm64`, `sqlite=ok`, `helper=passed`, `policy=sentinel-test-v1`, `tempRoot=system`, and `formalVaultOpened=false`, rejects any extra key, and prints no paths.

```bash
npm run test:unit -- tests/unit/release/native-smoke.test.ts tests/unit/native-read-helper-protocol.test.ts tests/unit/private-recovery-store.test.ts
npm run test:native-contract
npm run dist:mac
npm run verify:package
npm run smoke:native:packaged
```

Expected final line: `PASSED native-smoke arch=arm64 sqlite=ok helper=passed policy=sentinel-test-v1 tempRoot=system formalVaultOpened=false`.

- [ ] **Step 6: Write failing production-bootstrap identity and isolation tests**

In `production-capability-bootstrap.test.ts`, inject filesystem, helper, crash-worker, clock, and profile-store adapters. Require a pass only when all of these are true:

```text
helper path = <built app>/Contents/Resources/native/atomic-file-helper
helper SHA-256 = bytes after Electron Builder signing
helper codesign verification = valid ad-hoc signature
architecture = arm64
macOS build = current sw_vers -buildVersion
probe root = independent sentinel root outside formal vault and userData
probe st_dev = formal target st_dev = <real userData>/recovery st_dev
filesystem type = formal target filesystem type
primitive capabilities = all passed
crashRecovery = passed with the exact Phase 1 crash-matrix SHA-256
content-aware full-namespace aggregate before = content-aware full-namespace aggregate after
formal net changed namespace records = 0
```

Reuse and, only where these acceptance fields require it, incrementally extend Phase 1's existing private, single-invocation `scan-tree-private` command on the same helper/protocol and `NativeReadVaultPort`. Reuse its descriptor-opening, framed-protocol, direct hidden-inclusive `list-dir-all`, and helper-executable capability instead of replacing them or creating a parallel client; the public `list-dir` remains unchanged and continues to omit hidden entries. The command starts at `/`, opens the expected absolute root component-by-component with `O_DIRECTORY|O_NOFOLLOW`, verifies the supplied root dev/ino, and recursively walks only with held `openat` directory descriptors. It includes every hidden and visible entry except `.`/`..`, rejects a different `st_dev`, and never constructs or opens an absolute child pathname. For each directory, capture and sort the complete `{ name bytes, type, dev, ino, mode }` set before descending, re-enumerate that same held descriptor after its subtree, and require the set plus directory identity/mtime/ctime to be unchanged. Regular files are opened with `O_RDONLY|O_NOFOLLOW`, must be regular, and bind dev/ino/mode/size plus the existing wire fields `modifiedAtNs`/`changedAtNs` and SHA-256 computed while that descriptor remains open and is fstat-stable. Symlinks are never opened or followed: use `fstatat(...AT_SYMLINK_NOFOLLOW)`, `readlinkat(parentFd, name, ...)`, and a second `fstatat` to bind dev/ino/mode/size plus `modifiedAtNs`/`changedAtNs` and the target-text SHA-256 for acceptance inventory, while Phase 1's package policy continues to reject package-tree symlinks. Socket, device, FIFO, hard traversal limit, invalid UTF-8/NFC, oversized path/target, or any before/after mismatch fails the whole scan with a stable safe code; nothing is skipped. Do not rename or duplicate Phase 1's strict `NativeTreeRecord` fields; unknown `mtimeNs`/`ctimeNs` on the helper wire remain rejected.

The helper emits a strict length-delimited record stream with lowercase-hex relative-path bytes and fixed cumulative entry/output bounds. It may include raw bytes only for a caller-supplied, normalized, duplicate-free allowlist of regular-file relative paths, with 10 MiB per selected file and 50 MiB total; this is used for the five rule files and planned Markdown verification, never for the whole vault. Selected bytes travel in separate bounded payload frames and never become optional/unknown fields on Phase 1's strict `NativeTreeRecord` union. `native-read-helper-protocol.ts` rejects unknown/duplicate/missing records or selected payloads, unsorted paths, type-specific extra fields, hash/length disagreement, or trailing bytes. Add native SHA-256 known-vector tests and compare every helper digest with Node's digest over fixture bytes. Race tests replace the root pathname, every ancestor, a directory entry, regular file, and symlink target at the native synchronization hooks; a scan must return one self-consistent descriptor-bound tree or fail, never outside names/bytes. Include hidden file/directory/symlink and socket/FIFO/device fixtures and prove hidden entries are recorded while special entries fail closed.

Preserve Phase 1's method name and exact path-only return type through an additive overload:

```ts
export type NativeSelectedFileBytes = {
  readonly relativePath: string;
  readonly rawSha256: string;
  readonly byteLength: number;
  readonly bytes: Uint8Array;
};
export type NativePrivateTreeScanWithBytes = {
  readonly records: readonly NativeTreeRecord[];
  readonly selectedBytes: readonly NativeSelectedFileBytes[];
};
export interface NativeReadVaultPort {
  scanTreePrivate(path: string): Promise<readonly NativeTreeRecord[]>;
  scanTreePrivate(
    path: string,
    options: { readonly includeBytesFor: readonly string[] }
  ): Promise<NativePrivateTreeScanWithBytes>;
}
```

The options overload requires a nonempty normalized duplicate-free allowlist, returns `selectedBytes` in the same UTF-8 path order as the selected file records, and requires a one-to-one path/hash/length match. The stable snapshot composer invokes the options overload twice and accepts it only when both complete `records` arrays and every selected path/hash/length/byte payload are equal; the legacy path-only overload unwraps and returns only the records array. `FileSystemVaultGateway`, HTTP, preload, and renderer receive no hidden-list or snapshot method, and the read port exposes no mutation method.

Create `src/shared/acceptance/read-only-vault-snapshot.ts` as the only canonical snapshot composer used by Tasks 4–7. It accepts an already constructed `NativeReadVaultPort`, calls `scanTreePrivate()` twice through the same held, SHA/code-signature-verified packaged helper executable, requires byte-for-byte canonical Phase 1 record equality, and returns `stability:'two-identical-descriptor-scans'`, root identity, records, selected bytes, aggregate SHA-256, and `netChangesObserved:0`. At this single boundary it maps `NativeTreeRecord.modifiedAtNs -> mtimeNs` and `changedAtNs -> ctimeNs` into the private acceptance schema; no other module aliases the names. Every regular file, including `.obsidian`, then binds path/type/dev/ino/mode/size/mtimeNs/ctimeNs/content SHA-256; directories bind path/type/dev/ino/mode/mtimeNs/ctimeNs; symlinks bind path/type/dev/ino/mode/size/mtimeNs/ctimeNs/target SHA-256. This proves two stable observations and exact net equality; it does not claim that no transient write occurred between observations.

Use one root identity type everywhere in Phase 6:

```ts
export type CanonicalRootIdentity = {
  readonly realPath: string;
  readonly dev: string;
  readonly ino: string;
};
export type CanonicalVolumeRootIdentity = CanonicalRootIdentity & {
  readonly filesystemType: string;
};
export const sha256RootIdentity = (root: CanonicalRootIdentity) =>
  sha256Canonical({ realPath: root.realPath, dev: root.dev, ino: root.ino });
```

`NativeReadVaultPort.probeRoot()` returns `CanonicalVolumeRootIdentity`; the full `PrivateRecoveryStore` and separate `ReadOnlyPrivateRecoveryStore` expose `appDataRootIdentity()`, `recoveryRootIdentity()` and an atomic `rootIdentities()` pair returning `CanonicalRootIdentity`. Phase 1's smaller `DirectoryIdentity { dev, ino }` remains only for already-bound internal directory handles and is never passed where a root hash is required. No alternate root type or `realRoot`/`device`/`inode` root-field alias exists; root evidence schemas use these exact three names even though non-root file records and the capability profile's established `volume.device` field retain their own established fields.

The bootstrap captures one stable descriptor snapshot before and another after every probe. `formalNetChangesObserved:0` and `formalSnapshotStability:'two-identical-descriptor-scans'` are derived only from exact canonical record equality, never path/type equality. Bootstrap, runner, and tests construct the read port from the already opened and verified packaged helper inode and execute it through the Phase 1 `/dev/fd/3` capability; they never verify one pathname and later spawn a replacement.

Inject and reject: unsigned or different helper bytes; x86_64 helper; OS build change; target filesystem/device change; recovery directory on another device; cache/probe path inside or above the formal vault; probe path inside appData; symlink cache/probe/sentinel; incomplete primitive evidence, including missing/failed `boundedRecoveryRetirement`; a retirement probe that can touch a raced foreign basename or exposes any delete opcode; one missing crash checkpoint; wrong crash-matrix hash; added/removed namespace path; changed symlink target; special file; regular-file byte change; and any attempt to persist a profile before all evidence passes. Include a same-path, same-size, restored-mtime fixture whose bytes differ and require `FORMAL_NAMESPACE_CHANGED_DURING_BOOTSTRAP`, proving metadata camouflage cannot pass. Assert failure leaves no active profile pointer and removes only the captured owned probe root. Also prove only a child holding a live, one-use `AppBootstrapHandshakeAuthority` from the normal packaged App may promote the active pointer; CLI arguments or environment values select diagnostic mode only and never construct that authority. The developer CLI can produce private acceptance evidence but cannot create or replace production authority.

In `packaged-capability-bootstrap.spec.ts`, use `NODE_ENV=test`, a temporary configured sentinel target, and temporary userData in every spawned test process; never launch it against `/Users/ao/我的大脑` or change the subprocess to production/development mode. Prove `--capability-crash-worker` rejects a missing/wrong sentinel, the formal root via an injected filesystem adapter, a formal-root symlink alias, and a root not created by its parent bootstrap. Renderer/HTTP fields named `NODE_ENV`, `WRITE_ENABLED`, or `VAULT_REAL_ROOT`, model output, and omitted/wrong CLI modes cannot start or promote the bootstrap; Task 3's pure runtime unit test proves environment strings alone never select this launch mode. Run exactly:

```bash
npm run test:unit -- tests/unit/release/production-capability-bootstrap.test.ts tests/unit/native-read-helper-protocol.test.ts tests/unit/private-recovery-store.test.ts
npm run test:native-contract
```

Expected: RED because the bootstrap and complete private-scan contract are not yet implemented.

- [ ] **Step 7: Bootstrap with the signed packaged helper and a separate same-volume sentinel root**

The Phase 6 extension also adds one identity/version-bound `replaceFileAtomic(...)` operation plus safe fixed-namespace read/enumeration. Replacement creates and fsyncs a private temporary inode beneath the held directory, rereads and hash-verifies it, swaps/renames only against the exact expected old identity without following links, fsyncs the held parent, and verifies the final identity/content before success. It accepts no absolute path. Configuration records, migration receipts and rule approvals use this replace operation for later updates. Capability-profile revisions and the active pointer are explicitly excluded from this generic operation and are writable only through the lock-authorized supervisor port below. Tests cover first create, exact replace, missing/wrong expected identity, crash before/after rename, parent/entry replacement, symlink target, forbidden capability-profile handle/replace, and final reread mismatch.

Incrementally extend Phase 1's one `src/server/vault/PrivateRecoveryStore.ts`; do not define `PrivateAppDataStoragePort`, `openBoundPrivateAppData`, `openPrivateAppDataStorage`, `openPrivateRecoveryStore`, or a second writable root/path implementation. Keep `PrivateRecoveryStore.open({ appDataRoot: validatedAppDataRoot, nativePort })` as the only full-store factory and keep all existing batch-handle methods. The same full-store interface adds `appDataRootIdentity()`, `recoveryRootIdentity()`, atomic `rootIdentities()`, an allowlisted writable `openFixedNamespace('config'|'quarantine')`, and a distinct `openCapabilityProfilesReadOnly()` whose branded handle is not assignable to any create/replace/move method. The root methods return only the exact `CanonicalRootIdentity { realPath, dev, ino }`; internal namespace methods return existing writable `BoundPrivateDirectory` handles or a read-only capability-profile handle and never return/reopen an absolute child pathname. Normal runtime constructs the one full store from Phase 1's existing held private-store `nativePort` backed by the same already verified helper inode; a read-only vault port is not substituted for it. Model migration receipts/endpoints, database quarantine, rule approval, and existing recovery batches use this full factory/port; capability profiles are read through the distinct read-only handle. Baseline, post-verifier, evidence-only profile export, and DeepSeek diagnostics never import this writable module. Extend `private-recovery-store.test.ts` with root replacement, namespace alias/symlink, wrong mode, duplicate creation, rejection of every capability-profile create/replace via the generic store, close, and pairwise-root-identity cases before any consumer task relies on the additions.

The generic store does not expose a promotion-port factory or writable capability-profile handle. `app-bootstrap-handshake.ts` alone creates `CapabilityProfilePromotionPort` in the normal main-process branch directly from the held appData root/native helper capability plus an opaque live `NormalAppSingleInstanceLockAuthority` minted only after that branch acquires the incumbent lock. The factory validates object identity against a module-private live-authority registry, opens the fixed capability-profile namespace internally, and returns only `recordBoundedStatus()`, `promoteValidatedCandidate()`, and `close()`. Diagnostic child, crash-worker, developer CLI, server, renderer, and preload dependency graphs cannot import this factory, receive the lock authority, obtain a writable capability-profile handle, or call a generic fixed-record write there. The bootstrap child receives only a descriptor-bound `BootstrapProbeWorkspacePort` limited to its one parent-created temporary recovery workspace and sends progress/candidate frames to the parent. A transitive dependency test plus direct signed-CLI test proves copied flags and child code cannot construct/import a promotion port, reach a capability-profile write opcode, or write the active pointer through the generic store.

Create `src/server/vault/ReadOnlyPrivateRecoveryStore.ts` as a capability-thin facade with the sole factory `openReadOnlyPrivateRecoveryStore({ appDataRoot, nativePort: PrivateRecoveryReadPort })`. It must not import `PrivateRecoveryStore.ts`, `BoundPrivateDirectory`, `AtomicFileHelper`, `atomic-helper-protocol`, or any writable namespace/dispatcher. Its returned `ReadOnlyPrivateRecoveryStore` exposes only `appDataRootIdentity()`, `recoveryRootIdentity()`, atomic `rootIdentities()`, `openFixedNamespaceReadOnly('config'|'quarantine')`, `openCapabilityProfilesReadOnly()`, `openRecoveryReadOnly()`, `openStateDatabaseReadOnly()` for the fixed `state.sqlite3`/WAL/SHM inspection contract, identity/hash-bound enumeration and reads through branded read-only handles, and `close()`. `ReadOnlyFixedPrivateNamespace`, `ReadOnlyCapabilityProfiles`, `ReadOnlyPrivateRecoveryNamespace`, and `ReadOnlyStateDatabase` are structurally incompatible with every writable namespace/operation; none accepts a caller-selected child path. The facade contains no general child-path resolver: fixed namespace selection and component walking stay inside the descriptor-held native read port, so this is not a second filesystem authority or writable-store implementation. `PrivateRecoveryReadPort` contains no create/append/move/swap/export-sink/retire command. `NativeReadVaultPort.ts` exports `createPrivateRecoveryReadPort({ executable, appDataRoot })`, accepting only the same held `VerifiedNativeHelperExecutable` capability used by the vault reader; its returned type exposes read/list/root-identity commands only and the module does not import or wrap `AtomicFileHelper` or any write dispatcher. The original Phase 1 `PrivateRecoveryStore.open({ appDataRoot, nativePort })` call and full port remain unchanged for normal runtime. Baseline, post-verifier, evidence-only profile export, and the later DeepSeek private-config reader composition create their read ports from one already verified held executable, then use this separate factory. Extend the unit and transitive-dependency tests to prove the facade surface and its complete source/built closure contain neither the writable store, `BoundPrivateDirectory`, `AtomicFileHelper`, nor private write opcodes, while normal runtime alone receives the full port.

`NativeReadVaultPort.ts` also owns `createVerifiedNativeHelperExecutable(path)`: it component-opens the exact packaged helper without following links, holds that executable identity, verifies regular mode, SHA-256, arm64 and current ad-hoc signature, and returns the branded capability consumed by both read-port constructors. No caller may verify a pathname and later reopen it for execution.

`production-capability-bootstrap.ts` runs only in packaged `capability-bootstrap` mode and never constructs Fastify, watcher, indexer, coordinator, production policy, a full `PrivateRecoveryStore`, or a BrowserWindow. It reads only the vault-root string from validated Electron settings, constructs the verified packaged `NativeReadVaultPort`, obtains formal realpath/dev/ino/filesystem type through `probeRoot()`, and calls the shared content-aware full-namespace scanner before any probe; Node never `realpath`/`stat`s the formal root or later reopens it by pathname. The App-owned child receives at reserved fd 4 only a parent-created, descriptor-bound `BootstrapProbeWorkspacePort` limited to one empty unpredictable `0700` recovery workspace plus the already observed recovery-root identity; it cannot traverse upward, open another namespace, or write status/profile/config records. The developer CLI instead uses one captured temporary workspace with the same narrow interface and no userData write handle. The child creates an owned `0700` probe root with `mkdtemp()` beneath `app.getPath('cache')`. The cache base must be a real directory, outside both formal vault and userData, and on the same `st_dev` as the descriptor-observed formal root, recovery root, and narrow workspace. If no such independent same-volume root exists, fail `NO_INDEPENDENT_SAME_VOLUME_PROBE_ROOT`; never fall back to a directory inside the vault.

Create the exact shared sentinel in the probe root, hash and verify the already packaged/signed helper at `process.resourcesPath/native/atomic-file-helper`, and run every Phase 1 primitive against the probe root. Then spawn the same packaged executable in `capability-crash-worker` mode for the exact Phase 1 checkpoint × step-kind matrix, including recovery plans with new contiguous ordinals/`recoveryOfOrdinal`, `retire-created-file`, and keep-current/known-version resolve finalization. Each worker is given only the parent-created sentinel root, a private bootstrap recovery subdirectory, a checkpoint, and an unpredictable run nonce through inherited file descriptors; it rejects path arguments/env authority, revalidates the sentinel and formal-root non-overlap, prints `READY_TO_KILL`, and is killed/recovered by a fresh packaged worker. It proves `retire-created-file` uses hash/dev/ino-bound exclusive move to private retained storage and never unlink. The deterministic matrix digest must equal Phase 1's exported `WRITE_CRASH_MATRIX_SHA256`.

Extend the packaged helper's private protocol with `attest-bootstrap-parent`. It accepts no PID, executable path, nonce, or authority value from argv/stdin. From the helper process it derives the bootstrap child's PID, the child's live parent PID, both process executable identities, and current uid through macOS process APIs; it requires the parent and bootstrap child to be distinct live processes running the exact same regular executable inode/hash as the already verified current packaged executable and returns only a bounded attestation digest. A shell, test runner, reparented/orphan child, different executable, dead parent, symlink/path replacement, or unsigned/different App fails. This private command is callable only by `app-bootstrap-handshake.ts`; it is absent from `NativeReadVaultPort`, HTTP, preload, renderer, and the general mutation helper interface. Native contract tests cover the real process chain and every rejection without using the formal vault.

Only after a second content-aware formal namespace scan has exactly the same canonical records and aggregate as the first may the still-live, lock-holding App supervisor accept the child's bounded canonical candidate and call its own `promoteCrashRecoveryEvidence()` port. The supervisor independently validates the candidate hash and transcript, then atomically writes an immutable revision and fsynced active pointer under the real `<userData>/capability-profiles` with directory `0700` and files `0600` before acknowledging promotion to the child. The child never receives a profile-store or promotion port. A developer child has no inherited handshake channel and can return the same validated candidate evidence only to developer tooling; copying App flags cannot change that.

This task adds the following strict subtype. It preserves every Phase 1 field and name, including `schemaVersion`, `helperSha256`, `volume`, `checkedAt`, the complete per-capability `evidence`, and `profileKey`; Phase 5's `boundedRecoveryRetirement` remains the one additive capability key. Production-only evidence is added beside those fields, never mapped through renamed or digest-only replacements:

```ts
export const productionNativeCapabilityProfileSchema = nativeCapabilityProfileSchema.extend({
  evidenceSource: z.literal('packaged-production-bootstrap-v1'),
  bootstrapInitiator: z.literal('app-settings'),
  bootstrapHandshakeSha256: sha256Schema,
  packagedHelperSignature: z.literal('adhoc-valid'),
  recoveryDevice: z.string().min(1),
  primitiveEvidenceSha256: sha256Schema,
  crashMatrixSha256: sha256Schema,
  formalNamespaceBeforeSha256: sha256Schema,
  formalNamespaceAfterSha256: sha256Schema,
  formalNetChangesObserved: z.literal(0),
  formalSnapshotStability: z.literal('two-identical-descriptor-scans')
}).strict();
export type ProductionNativeCapabilityProfile =
  z.infer<typeof productionNativeCapabilityProfileSchema>;
```

The Phase 1 schema/hash remains valid for sentinel profiles. The production schema owns a separate full-profile hash computation stored in the same `profileKey` field and checks all base plus production security fields, excluding only observation timestamps and `profileKey` itself. Every production loader returns `ProductionNativeCapabilityProfile`, which is structurally assignable to `NativeCapabilityProfile`; a Phase 1-only/legacy revision lacks required production fields and is stale rather than silently projected. The active revision binds:

```ts
{
  schemaVersion: 1,
  helperSha256,
  helperProtocolVersion: 1,
  macosBuild,
  arch: 'arm64',
  volume: { device: formal.dev, filesystemType: formal.filesystemType },
  checkedAt,
  capabilities: {
    renameSwap: 'passed',
    renameExclusive: 'passed',
    mkdirExclusive: 'passed',
    rmdirCreatedEmpty: 'passed',
    hiddenInspection: 'passed',
    privateRecoveryIO: 'passed',
    noFollow: 'passed',
    fileFsync: 'passed',
    directoryFsync: 'passed',
    conflictPreservation: 'passed',
    crashRecovery: 'passed',
    boundedRecoveryRetirement: 'passed'
  },
  evidence: completeCapabilityEvidence,
  profileKey,
  evidenceSource: 'packaged-production-bootstrap-v1',
  bootstrapInitiator: 'app-settings',
  bootstrapHandshakeSha256,
  packagedHelperSignature: 'adhoc-valid',
  recoveryDevice: recovery.dev,
  primitiveEvidenceSha256,
  crashMatrixSha256: WRITE_CRASH_MATRIX_SHA256,
  formalNamespaceBeforeSha256,
  formalNamespaceAfterSha256,
  formalNetChangesObserved: 0,
  formalSnapshotStability: 'two-identical-descriptor-scans'
}
```

`completeCapabilityEvidence` contains exactly one strict evidence item for every capability key, including crash recovery and bounded retirement; `primitiveEvidenceSha256` hashes the canonical ordered evidence entries for every key except `crashRecovery`; the exact crash-recovery entry is separately bound to `crashMatrixSha256`, and the production schema rejects any status/evidence/digest disagreement. The production `profileKey` hashes all base and production security fields except `checkedAt`, per-item observation times, and `profileKey` itself. In `finally`, remove only the nonce/dev/ino-bound bootstrap recovery subtree and cache probe root; do not remove the real recovery root or previous immutable profiles. At no point create a sentinel, temporary file, probe directory, journal, manifest, database, or app-data directory inside `/Users/ao/我的大脑`.

- [ ] **Step 8: Add the packaged branch, App-owned launch action, strict runner, and reload gate**

In `main.ts`, dispatch `--bootstrap-capability-profile` and `--capability-crash-worker` before the single-instance lock and normal runtime import. `run-production-capability-bootstrap.ts` requires the normal App to be quit, spawns only `release/mac-arm64/小兆大脑.app/Contents/MacOS/小兆大脑 --bootstrap-capability-profile`, explicitly leaves the reserved handshake descriptor closed, passes no vault/test/write/key environment variables, validates strict redacted output, and writes `.local/acceptance/production-capability.json` mode `0600`. This CLI runner is developer acceptance tooling only: its child runs the complete probe but cannot write/promote the active profile pointer. Its evidence contains only profile key, helper SHA, OS build, arch, volume-device hash, filesystem type, recovery-device-match, crash-matrix hash, capability count, `bootstrapInitiator:'developer-cli'`, `formalNetChangesObserved:0`, `formalSnapshotStability:'two-identical-descriptor-scans'`, and completion time—never the vault path, probe path, child paths, or raw crash records.

The product path is App-owned. Add the exact zero-argument bridge method `runProductionCapabilityBootstrap(): Promise<{ status:'cancelled'|'restarting' }>` and a Settings action labelled `验证写入能力`. Its IPC handler first calls `assertTrustedMainFrameIpc(event, window, runtimeOrigin)`, requires `normal-packaged`, and rejects any payload before reading settings, showing a dialog, spawning, or shutting down. It derives the current configured vault and standard userData only in main; renderer/HTTP cannot provide a root, path, environment, helper, mode, token, policy, handshake, or authority. One process-wide `AppBootstrapActionController` owns an atomic synchronous state machine `idle -> confirming -> stopping -> running -> terminal`; only a native-dialog cancellation or pre-shutdown failure may return `confirming -> idle`. The initial compare-and-set happens before the first `await`, so a second trusted frame call during any non-idle state fails `CAPABILITY_BOOTSTRAP_ALREADY_RUNNING` before a second dialog, port, shutdown, spawn, or child exists. After native confirmation the controller disables mutation/intake, publishes the bounded UI state `正在安全退出并验证写入能力`, flushes and closes server/SQLite/watchers and ordinary runtime descriptors but deliberately retains the incumbent single-instance lock. `NormalAppSingleInstanceLockAuthority.consumeForBootstrap()` is a process-private one-shot operation; it can create exactly one narrowly scoped held capability-profile promotion port, remains live until process exit, and rejects every second consumption even if the first supervisor later fails. The controller then spawns the same currently signed packaged executable with fixed mode arguments `--bootstrap-capability-profile --relaunch-normal`, `shell:false`, no cwd override, the same scrubbed environment as the CLI runner, and one anonymous duplex pipe at reserved fd 3. Arguments select the child mode only. The child can start because diagnostic-mode dispatch occurs before lock acquisition; every second normal launch remains rejected by the still-live incumbent and must not construct runtime/server/SQLite/watcher/policy. The original App remains alive as a headless supervisor and owns the lock through candidate validation, durable supervisor-owned promotion, terminal acknowledgement, or failure; it never releases the lock or exits immediately after spawn.

```ts
ipcMain.handle('desktop:run-production-capability-bootstrap', async (event, ...args) => {
  assertTrustedMainFrameIpc(event, window, runtimeOrigin);
  if (args.length !== 0) throw new Error('CAPABILITY_BOOTSTRAP_PAYLOAD_FORBIDDEN');
  if (launchMode !== 'normal-packaged') throw new Error('CAPABILITY_BOOTSTRAP_APP_ONLY');
  return bootstrapActionController.request({ window });
});
```

`AppBootstrapActionController.request()` owns resource acquisition, safe shutdown, spawn/bind, terminal supervision, cleanup, failure relaunch and process exit; the IPC handler owns none of those individual steps. Before ordinary runtime shutdown, a port/workspace construction failure closes anything already opened with `Promise.allSettled`, records only a stable error, restores `idle`, and leaves the still-valid ordinary runtime running. From the first successful shutdown transition onward it never restores services in process: one outer `try/finally` owns nullable promotion/workspace/supervisor/child handles; every synchronous throw, awaited rejection, spawn failure, bind failure, EOF, timeout, or terminal result reaches a non-throwing finalizer. That finalizer first aborts and awaits an unacknowledged child, then uses independent `Promise.allSettled` groups to close child pipes, handshake, probe workspace, and promotion port exactly once, records cleanup errors without skipping later resources, sets `terminal`, and only then exits. A promoted child owns the subsequent normal relaunch; every post-shutdown non-promoted result schedules one ordinary relaunch which will start read-only/blocked, then calls `app.exit(0)`. Process exit—not a cleanup callback—releases the still-held single-instance lock. No individual `close()` rejection can skip another close, the failure relaunch, or exit.

`app-bootstrap-handshake.ts` owns a strict, length-bounded, versioned fd-3 protocol. The normal App generates a 32-byte nonce in memory, binds the actual `child.pid`, and sends it only through the anonymous pipe. The child requires fd 3 to be that live pipe, calls the private native parent attestation, proves `process.ppid` is the still-running same-signed-executable supervisor, and returns a nonce-bound child acknowledgement. Only after all bootstrap evidence passes does the child repeat parent attestation and send one bounded canonical candidate containing `{ candidateProfile, candidateProfileKey, candidateEvidenceSha256, childAttestationSha256 }`. The still-live supervisor revalidates the child/process binding and exact candidate/hash, derives `bootstrapHandshakeSha256` from the redacted transcript, and—while it still owns the single-instance lock—calls its private promotion port to create/reread the immutable revision and fsync/reread the active pointer. Only after durable reread does it send one terminal `{ status:'promoted', profileKey, activePointerSha256 }` acknowledgement. The child has no promotion capability and cannot turn a pre-promotion reply into a later write. If the supervisor dies before pointer durability, the child sees EOF and no pointer can appear; if it dies after pointer durability but before acknowledgement, the valid profile may remain but the child does not relaunch. Nonces, PIDs, descriptors, and raw messages are never persisted or logged. EOF, timeout, wrong/replayed nonce, wrong child PID, a regular file/socket supplied by a terminal, different/dead/reparented parent, candidate-hash mismatch, duplicate candidate, duplicate terminal acknowledgement, or second promotion fails closed. Mode flags, environment, renderer data, HTTP, files, or a caller-created fd cannot synthesize `AppBootstrapHandshakeAuthority`.

The dedicated child derives settings/userData internally for read-only identity checks, uses only fd 4's narrow probe workspace for private crash evidence, sends bounded status frames to the supervisor, and never constructs the full private store, normal server, or a renderer. The supervisor alone persists bounded status through its narrow port. The child uses native dialogs for the final `验证通过` or stable blocked reason. After receiving the supervisor's durable-promotion acknowledgement it closes workers/descriptors, waits for supervisor handshake EOF plus confirmed parent-process exit, and only then performs the exactly-once sequence `app.relaunch({ args: [] }); app.exit(0)`. Electron's relaunch call only schedules the next launch and does not itself terminate the child, so `app.exit(0)` is mandatory. A synchronous exception while scheduling is caught before exit and shows `请手动重新打开小兆大脑`; a later OS launch failure is not observable by this process and must not be reported as detected. The incumbent lock is released by supervisor process termination, never by an earlier manual call. This prevents overlap with the original App or any intervening normal instance. If acknowledgement is missing, the child never schedules relaunch even if a later manual launch can validate an already durable profile. On normal relaunch, Settings reads the active profile/last bounded status through health and shows current, stale, passed, or blocked state. The component test covers idle → confirm/cancel → restarting and the relaunched passed/blocked states. The Electron test rejects zero-value-but-present and nonempty payloads plus wrong/child/stale frames before effects; fires two trusted calls in the same tick and proves exactly one dialog/one-shot lock consumption/port pair/spawn; asserts the exact executable/mode argv/scrubbed environment, anonymous handshake fd 3, narrow workspace fd 4, safe-shutdown-before-spawn while retaining the single-instance lock, supervisor-owned promotion, durable-pointer-before-terminal-acknowledgement, and strict supervisor exit → child relaunch schedule → child exit order. It rejects a missing/replaced/writable-upward fd 4 and proves the child dependency closure has no generic private-store or capability-profile writer. At barriers before child acknowledgement, during probes, after candidate receipt, after immutable-revision durability but before active-pointer write, after active-pointer durability but before acknowledgement, and after acknowledgement but before supervisor exit, launch a second normal App and require the incumbent to reject it before runtime/server/SQLite/watcher/policy construction. Kill the supervisor at each of those barriers and prove the child can neither promote nor relaunch; only the after-pointer case may leave a fully valid rereadable profile for a later manual launch. Inject synchronous and async failure at promotion-port creation, workspace creation, safe shutdown, spawn, bind, every handshake stage, child abort/wait, each individual `close()`, and the synchronous relaunch scheduling call; before shutdown it returns to one usable idle runtime, while after shutdown it closes every acquired resource exactly once, schedules at most one read-only relaunch, and exits with the lock held until process death even when another close rejects. It proves no configured root, nonce, PID, descriptor, candidate evidence, or authority crosses IPC/argv/env/stdout. It also launches the signed executable directly from a terminal fixture with the exact same mode flags, with no fd 3, with a crafted pipe transcript, and under a different executable parent; every case may produce only `developer-cli` candidate evidence and must reject promotion/relaunch. If spawn or handshake fails after safe shutdown, main records only a stable native error through the narrow status port, schedules the normal App read-only relaunch, then exits after the supervisor closes; it does not reconstruct closed services in place or promote a profile.

For development acceptance only, `run-production-capability-bootstrap.ts --evidence-only` does not launch a bootstrap or promote anything: with the App quit, it loads the already App-created active profile through the held private appData reader, requires `bootstrapInitiator:'app-settings'` plus a valid `bootstrapHandshakeSha256`, revalidates it against the current signed helper/root/recovery identities, and emits the same strict `.local/acceptance/production-capability.json`. Missing/stale/App-uninitiated or handshake-unbound evidence fails. This lets the final report bind the App-owned bootstrap without making a second terminal-triggered bootstrap the product path.

On every `normal-packaged` launch, before enabling intake or a mutation route, load the active immutable production profile read-only, require `bootstrapInitiator:'app-settings'` and a schema-valid `bootstrapHandshakeSha256`, and re-evaluate the packaged helper SHA/signature, helper protocol, OS build, arm64, formal target dev/filesystem type, real recovery dev, every primitive status including `boundedRecoveryRetirement:'passed'`, crash matrix, and profile-key hash. The bootstrap probe must exercise Phase 5's held-inode truncation, foreign-basename preservation and absence of delete opcodes in its private sentinel appData; a pre-Phase-5 profile is stale. A CLI-created or handshake-unbound profile, rebuilt/re-signed helper, OS update, volume move, recovery relocation, malformed pointer, or incomplete evidence sets health to `writeBlocked:'PRODUCTION_CAPABILITY_PROFILE_STALE'`; there is no automatic fallback to a Phase 1 development/test profile. The user reruns the packaged bootstrap from Settings after inspecting the reason.

Before these gates, modify `packaged-security.spec.ts` so its exact preload-surface assertion contains the original seven methods plus only `runProductionCapabilityBootstrap`. This Task 4 surface has exactly eight sorted keys; Task 7 will expand the same assertion again when confirmation, approval, and export IPCs exist.

Run:

```bash
npm run test:unit -- tests/unit/release/production-capability-bootstrap.test.ts tests/unit/native-read-helper-protocol.test.ts tests/unit/private-recovery-store.test.ts
npm run test:component -- tests/component/settings-capability-bootstrap.test.tsx
npm run test:native-contract
npm run dist:mac
npm run verify:package
npm run test:electron -- tests/electron/packaged-security.spec.ts tests/electron/packaged-capability-bootstrap.spec.ts tests/electron/capability-bootstrap-action.spec.ts
npm run bootstrap:capability:packaged
```

Expected final line: `PASSED production-capability profileKey=<64 hex> helperSha256=<64 hex> arch=arm64 recoveryDeviceMatch=true crashRecovery=passed bootstrapInitiator=developer-cli formalNetChangesObserved=0 formalSnapshotStability=two-identical-descriptor-scans`. Confirm `.local/acceptance/production-capability.json` is `0600`, the developer run did not create/replace the active profile pointer, and evidence contains no vault child path. The later App action is the only path that promotes `bootstrapInitiator=app-settings`.

- [ ] **Step 9: Commit packaged-native and bootstrap code, never local evidence**

```bash
git add package.json native/macos/atomic-file-helper.c src/server/vault/native-read-helper-protocol.ts src/server/vault/NativeReadVaultPort.ts src/server/vault/PrivateRecoveryStore.ts src/server/vault/ReadOnlyPrivateRecoveryStore.ts src/server/vault/test-vault-sentinel.ts src/server/vault/MutationTargetPolicy.ts src/server/vault/native-capability-profile.ts src/server/vault/native-capability-probe.ts src/shared/acceptance/read-only-vault-snapshot.ts tests/helpers/atomic-test-vault.ts tests/unit/native-read-helper-protocol.test.ts tests/unit/private-recovery-store.test.ts tests/native/native-read-helper.contract.test.ts src/electron/diagnostics/native-smoke.ts src/electron/diagnostics/packaged-native-adapter.ts src/electron/diagnostics/production-capability-bootstrap.ts src/electron/diagnostics/packaged-crash-worker.ts src/electron/capability-bootstrap-action.ts src/electron/app-bootstrap-handshake.ts src/electron/main.ts src/electron/ipc-authority.ts src/electron/runtime.ts src/electron/preload.ts src/shared/desktop/bridge.ts src/client/pages/SettingsPage.tsx scripts/release/run-native-smoke.ts scripts/release/run-production-capability-bootstrap.ts tests/unit/release/native-smoke.test.ts tests/unit/release/production-capability-bootstrap.test.ts tests/electron/packaged-security.spec.ts tests/electron/packaged-capability-bootstrap.spec.ts tests/electron/capability-bootstrap-action.spec.ts tests/component/settings-capability-bootstrap.test.tsx
git commit -m "test: prove packaged native runtime and production profile"
```

### Task 5: Run a real DeepSeek smoke with no vault runtime

**Files:**
- Create: `src/electron/diagnostics/deepseek-smoke.ts`
- Create: `src/electron/diagnostics/packaged-deepseek-adapter.ts`
- Create: `src/electron/model-key-store.ts`
- Create: `src/electron/model-endpoint-store.ts`
- Create: `src/electron/model-settings-migration.ts`
- Modify: `src/shared/acceptance/read-only-vault-snapshot.ts`
- Create: `scripts/release/dependency-closure.ts`
- Create: `scripts/release/run-deepseek-smoke.ts`
- Modify: `scripts/release/verify-packaged-app.ts`
- Create: `tests/unit/release/deepseek-smoke.test.ts`
- Create: `tests/unit/release/deepseek-dependency-boundary.test.ts`
- Create: `tests/unit/release/model-settings-migration.test.ts`
- Modify: `src/electron/main.ts`
- Modify: `src/electron/settings-store.ts`

- [ ] **Step 1: Write the failing synthetic-only test**

```ts
const complete = vi.fn(async () => ({
  overview: '合成概述', candidates: [{ title: '合成候选', conclusion: '结构有效' }]
}));
const result = await runDeepSeekSmoke({
  endpoint: 'https://compatible.example/v1', model: 'configured-model', key: 'secret-not-printed',
  complete, elapsed: () => 321
});
expect(complete).toHaveBeenCalledWith(expect.objectContaining({
  source: expect.stringContaining('这是合成测试材料'), maxTokens: 400, temperature: 0
}));
expect(result).toMatchObject({ schemaValid: true, latencyMs: 321 });
expect(JSON.stringify(result)).not.toContain('secret-not-printed');
expect(JSON.stringify(result)).not.toContain('合成概述');
expect(result).toMatchObject({ endpointOrigin: 'https://compatible.example', model: 'configured-model' });
```

In the same `deepseek-smoke.test.ts`, exercise the packaged adapter's narrow composition function with in-memory `ModelKeyReader`/`ModelEndpointReader` fakes and the fake compatible client. Require it to use the configured endpoint/model and decrypted test key exactly once, return only the redacted smoke result, and never import or start the desktop vault runtime. The production wrapper may add only the Task 4 `ReadOnlyPrivateRecoveryStore` private-config composition, rooted at `userDataDir` and an already held `VerifiedNativeHelperExecutable`, around that same function.

Create `deepseek-dependency-boundary.test.ts` with these assertions:

```ts
const boundary = await analyzeDeepSeekBoundary({
  repoRoot: process.cwd(),
  mainEntry: 'src/electron/main.ts',
  adapterEntry: 'src/electron/diagnostics/packaged-deepseek-adapter.ts',
  builtMain: 'dist/electron/main.js'
});
expect(boundary.forbiddenImports).toEqual([]);
expect(boundary.mainHasStaticDesktopRuntimeImport).toBe(false);
expect(boundary.normalRuntimeDynamicImportAfterDiagnosticBranch).toBe(true);
expect(boundary.boundarySha256).toMatch(/^[a-f0-9]{64}$/u);
```

The positive fixture traverses the real source chain and its built metafile/sourcemap closure and accepts only the three exact read-only private-store files named below. Inject one transitive exact-path edge to `src/server/vault/PrivateRecoveryStore.ts` or `AtomicFileHelper`, a write opcode string, write-capable namespace type/value, non-allowlisted `vault` import, static `start-server` import in main, formal-path literal, and normal-runtime dynamic import before the diagnostic branch; each must fail with a distinct code in both source and built-closure assertions. Matching the text `PrivateRecoveryStore` as a substring is forbidden because it would falsely reject the allowed `ReadOnlyPrivateRecoveryStore.ts`. The exact RED command below runs both narrow boundary tests plus the migration test; it must fail because the diagnostic, analyzer, and dedicated key store are absent.

Also write `model-settings-migration.test.ts`. Use the completed Phase 3 `SettingsStore` public methods to create a real legacy `config/app-config.json` with a non-default HTTPS endpoint/model and encrypted key, then run the migration. Require the new endpoint store to return the same endpoint/model and the new key store to decrypt the same key while `app-config.json` retains the identical vault setting and no model secret/config field. Fault after exclusive prepare-receipt creation, each new-store atomic write/rename, each reread comparison, the compare-and-swap app-config rewrite, and terminal-marker persistence; delete the process between each fault and prove strict replay converges from the receipt even when the legacy fields are already gone. A missing/tampered receipt, legacy ciphertext mismatch, decrypt failure, symlink, wrong mode, malformed legacy record, stripped-config drift, or endpoint mismatch preserves the last provable state and blocks model use. After a valid terminal, mutate the key through `SettingsStore.set()`, clear it, set a replacement, change the endpoint/model, restart after every operation, and require `migrateLegacyModelSettings()` to return `already-current` while each independently validated current store value remains usable. The prepare receipt and terminal marker contain hashes/timestamps/identities only. No test logs plaintext or ciphertext.

Run:

```bash
npm run test:unit -- tests/unit/release/deepseek-smoke.test.ts tests/unit/release/deepseek-dependency-boundary.test.ts tests/unit/release/model-settings-migration.test.ts
```

Expected: FAIL because the diagnostics, narrow stores, migration, and analyzer are absent.

- [ ] **Step 2: Implement fixed request and redacted evidence**

Use this constant and response schema:

```ts
const SOURCE = `这是合成测试材料，不来自任何真实资料或知识库。
它只用于验证 OpenAI 兼容接口返回一条结构化知识候选。`;
const responseSchema = z.object({
  overview: z.string().min(1).max(200),
  candidates: z.array(z.object({
    title: z.string().min(1).max(80), conclusion: z.string().min(1).max(300)
  }).strict()).length(1)
}).strict();
```

`runDeepSeekSmoke` requires HTTPS with no URL credentials, passes `maxTokens:400` and `temperature:0`, validates the response, and returns only endpoint origin, model, latency, request SHA-256, response-shape SHA-256, and `schemaValid:true`. It cannot claim that a vault was unopened; the outer analyzer and before/after observer establish that independently.

- [ ] **Step 3: Split secret and non-secret model stores with an idempotent Phase 3 migration**

Create `model-key-store.ts` with only `electron.safeStorage`, Zod, and injected fixed-namespace interfaces; it must not import `node:fs`, `node:fs/promises`, `node:path`, `PrivateRecoveryStore` as a runtime value, or any helper dispatcher. `createModelKeyReader(readOnlyConfig)` accepts only Task 4's branded `ReadOnlyFixedPrivateNamespace`, reads the exact identity-bound `model-key.bin`, rejects symlinks and modes other than `0600`, and decrypts only in memory. `createModelKeyStore(writableConfig)` extends that reader with verified create/replace/clear for normal Settings startup. Neither form opens a pathname or imports vault settings, server startup, SQLite, watcher, index, intake, workflow, recovery orchestration, or mutation modules.

```ts
export interface ModelKeyStore {
  status(): Promise<{ readonly configured: boolean }>;
  readForModelCall(): Promise<string | null>;
  set(plaintext: string): Promise<void>;
  clear(): Promise<void>;
}
export interface ModelKeyReader {
  status(): Promise<{ readonly configured: boolean }>;
  readForModelCall(): Promise<string | null>;
}
export interface ModelEndpointStore {
  get(): Promise<ModelEndpointSettings>;
  set(value: ModelEndpointSettings): Promise<void>;
}
export interface ModelEndpointReader {
  get(): Promise<ModelEndpointSettings>;
}
export async function migrateLegacyModelSettings(input: {
  readonly legacy: LegacySettingsReader;
  readonly keys: ModelKeyStore;
  readonly endpoints: ModelEndpointStore;
  readonly privateStorage: PrivateRecoveryStore;
}): Promise<'already-current' | 'migrated'>;
```

Create `model-endpoint-store.ts` over the same injected read-only/writable fixed `config` handle split, with no `safeStorage` or direct Node filesystem import. It owns `model-endpoint.json`, validates the Phase 3 `ModelEndpointSettings` schema, and returns the Phase 3 current official default `{ baseUrl:'https://api.deepseek.com', model:'deepseek-v4-flash' }` only when no saved endpoint exists. It never silently overrides a persisted value. Refactor the normal `SettingsStore` to delegate key status/set/clear and endpoint get/set to the writable forms while its vault configuration and the migration marker also use that same held `config` namespace; no consumer reopens `<userData>/config/...` by pathname.

Before removing the Phase 3 model fields, add an internal `readLegacyModelRecordForMigration(): Promise<{ appConfigIdentity: FileIdentity; appConfigSha256: string; ciphertext: Uint8Array | null; endpoint: ModelEndpointSettings; strippedConfigSha256: string }>` implemented by the existing Phase 3 app-config parser. `model-settings-migration.ts` runs only in normal Electron startup, never in a diagnostic closure. Before writing a new store or removing a legacy field, it exclusively creates/fsyncs/rereads `config/model-settings-migration-v1.prepare.json` mode `0600`. That immutable strict receipt contains schema/operation ID, original app-config identity/hash, SHA-256 of the legacy ciphertext and endpoint canonical JSON, expected `model-key.bin`/`model-endpoint.json` byte hashes, expected stripped app-config hash, and `preparedAt`; it contains neither ciphertext nor plaintext. A pre-existing receipt must match every observable legacy/new state exactly and is never replaced.

With that receipt durable, migration writes or idempotently verifies the exact ciphertext bytes in `model-key.bin` and exact effective endpoint/model in `model-endpoint.json`, rereads/decrypts/compares through the narrow stores, then compare-and-swap rewrites `app-config.json` only if its current identity/hash still equal the receipt's original values. If the app-config is already stripped after a crash, replay accepts it only when its exact byte hash equals `strippedConfigSha256` and both new stores match their receipt hashes; it never needs to recover the removed ciphertext from app-config or silently bless an unrelated new store. Finally it exclusively writes/fsyncs/rereads `config/model-settings-migration-v1.json` mode `0600` as the terminal marker containing the prepare-receipt hash, all legacy/new/stripped hashes and completion time, never ciphertext or plaintext. Before that terminal exists, every replay comparison is receipt-bound and requires the exact migration-time target hashes. Once the terminal, its immutable prepare receipt, and the stripped app-config chain validate, migration is permanently complete: later `ModelKeyStore.set/clear` and `ModelEndpointStore.set` revisions are validated only by those stores' own strict atomic formats and are deliberately not compared with migration-time target hashes. Thus a valid terminal plus stripped legacy config returns `already-current` after ordinary Settings changes; a terminal never freezes live model settings. Every migration stage is idempotent and fsynced; until this terminal chain validates, model callers return `MODEL_SETTINGS_MIGRATION_REQUIRED`. Normal App startup completes or safely blocks this state machine before exposing Settings/model actions.

The packaged adapter imports the two reader constructors, Phase 3's OpenAI-compatible DeepSeek client/config types, `deepseek-smoke.ts`, Zod, and exactly Task 4's read-only private-store chain: `ReadOnlyPrivateRecoveryStore.ts`, `NativeReadVaultPort.ts`, and `native-read-helper-protocol.ts`. Given `{ userDataDir, helperExecutable }`, it creates `createPrivateRecoveryReadPort({ executable: helperExecutable, appDataRoot: userDataDir })`, calls `openReadOnlyPrivateRecoveryStore({ appDataRoot:userDataDir, nativePort })`, opens only `openFixedNamespaceReadOnly('config')`, and injects that branded handle into the two readers. It closes the store/port in `finally`. The adapter has no fallback literal and returns neither plaintext key nor model output. It does not import `PrivateRecoveryStore.ts`, `settings-store.ts`, `model-settings-migration.ts`, `AtomicFileHelper`, the private write protocol, or any normal vault runtime. A user upgrading from Phase 3 must open the normal App once to complete migration before the real smoke; the diagnostic returns `SKIP MODEL_SETTINGS_MIGRATION_REQUIRED` rather than reading legacy vault config.

- [ ] **Step 4: Implement a transitive source and built-artifact boundary analyzer**

In `dependency-closure.ts`, use the TypeScript compiler API to parse static imports, export-from declarations, and dynamic imports. Resolve every relative `.ts/.tsx/.js` edge and walk the complete adapter closure. Permit the exact canonical file set below only when reached from the packaged adapter's read-only config composition, continue traversing every edge inside it, and reject every other resolved path containing a forbidden segment:

```ts
const FORBIDDEN_SEGMENTS = [
  '/vault/', '/intake/', '/workflow/', '/index/', '/recovery/', '/db/',
  '/runtime/start-server', '/server/index', '/electron/settings-store',
  '/electron/model-settings-migration'
] as const;
const ALLOWED_READ_ONLY_PRIVATE_STORE_FILES = [
  'src/server/vault/ReadOnlyPrivateRecoveryStore.ts',
  'src/server/vault/NativeReadVaultPort.ts',
  'src/server/vault/native-read-helper-protocol.ts'
] as const;
```

The exception is file-exact, not directory-exact: each allowed file must itself have a transitive closure free of the exact full-store path `src/server/vault/PrivateRecoveryStore.ts`, `AtomicFileHelper`, `atomic-helper-protocol`, private create/append/move/swap/export/retire opcodes, write-capable `BoundPrivateDirectory`, coordinator, recovery mutation, database, settings, or normal runtime modules. `ReadOnlyPrivateRecoveryStore.ts` may depend only on the two other allowlisted read modules plus pure shared identity/record/hash schemas; it cannot import or re-export a full-store type or value. Reject the literal `/Users/ao/我的大脑`, `VAULT_REAL_ROOT`, `XIAOZHAO_TEST_VAULT_ROOT`, or `startServer` anywhere in the adapter closure. In `main.ts`, reject every static import that reaches a forbidden segment. Locate the `--deepseek-smoke` branch and require its dynamic adapter import to occur before the normal `start-server`/desktop-runtime dynamic import. Hash canonical sorted `{path,sha256,staticEdges,dynamicEdges}` records plus the built `dist/electron/main.js` SHA-256 and return:

```ts
export type DeepSeekDependencyBoundary = {
  readonly forbiddenImports: readonly string[];
  readonly mainHasStaticDesktopRuntimeImport: false;
  readonly normalRuntimeDynamicImportAfterDiagnosticBranch: true;
  readonly boundarySha256: string;
};
```

`verify-packaged-app.ts` must also extract `dist/electron/main.js` from `app.asar`, prove its SHA-256 equals the local built file used by the analyzer, and include `deepseekBoundary=<64 hex>` in its internal structured result.

- [ ] **Step 5: Add the packaged real-model branch before desktop runtime import**

After `await app.whenReady()` makes `safeStorage` available, but before any normal desktop runtime dynamic import in `main.ts`:

```ts
if (process.argv.includes('--deepseek-smoke')) {
  const helperExecutable = await verifyCurrentPackagedHelper({
    resourcesPath: process.resourcesPath
  });
  const { runPackagedDeepSeekSmoke } = await import('./diagnostics/packaged-deepseek-adapter.js');
  const result = await runPackagedDeepSeekSmoke({
    userDataDir: app.getPath('userData'),
    helperExecutable
  });
  const exitCode = { passed: 0, skipped: 2, failed: 1 }[result.status];
  const line = result.status === 'passed'
    ? `XIAOZHAO_DEEPSEEK_SMOKE ${JSON.stringify(result)}`
    : result.status === 'skipped'
      ? `SKIP ${result.code}`
      : `FAILED ${result.code}`;
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${line}\n`,
      (error) => error ? reject(error) : resolve());
  });
  app.exit(exitCode);
  return;
}
```

`runPackagedDeepSeekSmoke` returns a strict discriminated union: `passed` carries only the redacted smoke fields, `skipped` carries only `code:'DEEPSEEK_KEY_NOT_CONFIGURED'|'MODEL_SETTINGS_MIGRATION_REQUIRED'`, and `failed` carries one allowlisted stable safe code. `deepseek-smoke.test.ts` asserts all three stdout prefixes and exact exit mapping `passed -> 0`, `skipped -> 2`, `failed -> 1`, including both skip reasons. `verifyCurrentPackagedHelper` is the Task 4 packaged-helper verifier and returns an opaque held `VerifiedNativeHelperExecutable`; it neither constructs a vault runtime nor exposes a path string to the adapter. The normal packaged runtime is dynamically imported only after every diagnostic/bootstrap branch returns. A missing key prints `SKIP DEEPSEEK_KEY_NOT_CONFIGURED`, an incomplete legacy migration prints `SKIP MODEL_SETTINGS_MIGRATION_REQUIRED`, both exit `2`, and neither creates pass evidence.

- [ ] **Step 6: Capture an external read-only vault digest before and after the child**

Reuse Task 4's `read-only-vault-snapshot.ts` and its injected `NativeReadVaultPort`; do not add a Node pathname walker. `captureStableContentAwareVaultNamespace(port)` invokes only the private `scan-tree-private` read command twice and requires the exact descriptor-bound, hidden-inclusive canonical records to match. Its transitive production imports may include the read-only protocol/client and packaged-helper verifier, but must reject `AtomicFileHelper`, write protocol/commands, coordinator, recovery mutation, database, settings, or Electron runtime imports. Also export the allowed-root projection needed by Task 6 from the same returned record set; do not reopen allowed files by pathname and do not make the DeepSeek observer weaker than the full namespace.

`run-deepseek-smoke.ts` performs this exact order:

```ts
const startedAt = new Date().toISOString();
const boundary = await analyzeDeepSeekBoundary(boundaryInput);
assertBoundaryPassed(boundary);
const layout = releaseLayout(appVersion);
const nativeReadPort = await createVerifiedPackagedNativeReadPort(layout.helper, formalVaultArg);
const appTreeBeforeSha256 = await hashAppTree(layout.app);
const before = await captureStableContentAwareVaultNamespace(nativeReadPort);
const childResult = await spawnPackagedDeepSeekDiagnostic();
const after = await captureStableContentAwareVaultNamespace(nativeReadPort);
const appTreeAfterSha256 = await hashAppTree(layout.app);
const changedNamespaceRecords = countChangedNamespaceRecords(before.records, after.records);
if (before.aggregateSha256 !== after.aggregateSha256 || changedNamespaceRecords !== 0) {
  throw new Error('DEEPSEEK_SMOKE_VAULT_CHANGED');
}
if (appTreeBeforeSha256 !== appTreeAfterSha256) throw new Error('DEEPSEEK_SMOKE_APP_CHANGED');
const vaultNetChangesObserved = 0 as const;
const evidence = {
  ...childResult,
  startedAt,
  completedAt: new Date().toISOString(),
  appTreeSha256: appTreeAfterSha256,
  dependencyBoundarySha256: boundary.boundarySha256,
  appVaultRuntimeLoaded: false as const,
  vaultNetChangesObserved,
  vaultSnapshotStability: 'two-identical-descriptor-scans' as const
};
```

`countChangedNamespaceRecords()` compares canonical path/type/identity/mode/content records and returns a net-change count only; no path enters evidence. The observer reads the vault only to prove two stable descriptor snapshots before and after the child have zero net difference; those reads occur in the release script, never in the packaged DeepSeek child. It does not claim no transient write occurred between observations. If any scan is internally unstable, or the stable before/after snapshots differ in a file, directory, identity, mode, symlink target, or regular-file bytes, fail and rerun from the beginning.

- [ ] **Step 7: Parse, persist, and run the real smoke**

The runner requires `--formal-vault /Users/ao/我的大脑`, spawns the fixed packaged executable with no vault/test/write environment variables, parses only the strict redacted pass/skip/fail stdout union and matching exit code, and requires a passing child endpoint origin/model to equal the values read from the two narrow stores. It adds only timestamps, packaged App digest, independently derived boundary, and zero-change fields, then writes `.local/acceptance/deepseek-smoke.json` atomically with directory `0700` and file `0600`. Skip/fail output never creates pass evidence. Require the normal App to be quit first so the single-instance lock cannot substitute a different process. A configured non-default compatible endpoint/model must appear exactly in evidence and the final report; never relabel it as DeepSeek defaults.

Run:

```bash
npm run test:unit -- tests/unit/release/deepseek-smoke.test.ts tests/unit/release/deepseek-dependency-boundary.test.ts tests/unit/release/model-settings-migration.test.ts
npm run dist:mac
npm run smoke:deepseek:real -- --formal-vault /Users/ao/我的大脑
```

Expected after the Key is configured in the App: output is `PASSED deepseek-smoke endpointOrigin=<actual configured HTTPS origin> model=<actual configured model> schemaValid=true appVaultRuntimeLoaded=false vaultNetChangesObserved=0 vaultSnapshotStability=two-identical-descriptor-scans dependencyBoundarySha256=<64 hex> latencyMs=<integer>`. The strict parser compares endpoint/model to the narrow stores; it does not require the defaults. No prompt, response, vault path, dependency path, or key appears in stdout, stderr, logs, or evidence.

- [ ] **Step 8: Scan and commit**

```bash
if rg -n '/Users/ao/我的大脑|sk-[A-Za-z0-9]|这是合成测试材料|overview|candidates|src/server|node_modules' .local/acceptance/deepseek-smoke.json "$HOME/Library/Logs/小兆大脑"; then exit 1; fi
git add src/electron/diagnostics/deepseek-smoke.ts src/electron/diagnostics/packaged-deepseek-adapter.ts src/electron/main.ts src/electron/settings-store.ts src/electron/model-key-store.ts src/electron/model-endpoint-store.ts src/electron/model-settings-migration.ts src/shared/acceptance/read-only-vault-snapshot.ts scripts/release/dependency-closure.ts scripts/release/run-deepseek-smoke.ts scripts/release/verify-packaged-app.ts tests/unit/release/deepseek-smoke.test.ts tests/unit/release/deepseek-dependency-boundary.test.ts tests/unit/release/model-settings-migration.test.ts
git commit -m "test: add vault-free DeepSeek smoke"
```

Expected scan: no matches. A skip, dependency-boundary failure, vault digest change, or redaction match blocks formal-vault acceptance.

### Task 6: Capture a stable read-only formal-vault baseline

**Files:**
- Create: `src/shared/acceptance/evidence.ts`
- Create: `scripts/acceptance/formal-vault-baseline.ts`
- Create: `tests/integration/acceptance/formal-vault-baseline.test.ts`
- Modify: `src/shared/acceptance/read-only-vault-snapshot.ts`
- Modify: `scripts/real-vault-read-smoke.ts`
- Modify: `tests/unit/real-vault-read-smoke.test.ts`

- [ ] **Step 1: Define strict baseline evidence**

```ts
export const formalBaselineSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('formal-vault-read-only-baseline'),
  capturedAt: z.string().datetime(),
  reader: z.object({
    snapshotProtocolVersion: z.literal('native-private-tree-v1'),
    helperSha256: z.string().regex(/^[a-f0-9]{64}$/u)
  }).strict(),
  vault: z.object({
    realPath: z.string().min(1), dev: z.string(), ino: z.string()
  }).strict(),
  ruleBundleHash: z.string().regex(/^[a-f0-9]{64}$/u),
  ruleCompatibilityApproval: z.object({
    recordSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    validatorVersion: z.literal('phase6-rule-compat-v1'),
    approvedAt: z.string().datetime()
  }).strict(),
  aggregateSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  namespaceAggregateSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  entries: z.array(z.object({
    path: z.string().min(1), type: z.literal('file'),
    device: z.string(), inode: z.string(), mode: z.string(), size: z.string(),
    mtimeNs: z.string(), ctimeNs: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u)
  }).strict()),
  namespaceEntries: z.array(z.discriminatedUnion('type', [
    z.object({
      path: z.string().min(1), type: z.literal('file'),
      device: z.string(), inode: z.string(), mode: z.string(), size: z.string(),
      mtimeNs: z.string(), ctimeNs: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u)
    }).strict(),
    z.object({
      path: z.string().min(1), type: z.literal('directory'),
      device: z.string(), inode: z.string(), mode: z.string(),
      mtimeNs: z.string(), ctimeNs: z.string()
    }).strict(),
    z.object({
      path: z.string().min(1), type: z.literal('symlink'),
      device: z.string(), inode: z.string(), mode: z.string(), size: z.string(),
      mtimeNs: z.string(), ctimeNs: z.string(),
      targetSha256: z.string().regex(/^[a-f0-9]{64}$/u)
    }).strict()
  ])),
  forbiddenArtifacts: z.array(z.string()).length(0),
  stability: z.object({
    scanCount: z.literal(2),
    canonicalRecordsEqual: z.literal(true),
    kind: z.literal('two-identical-descriptor-scans'),
    netChangesObserved: z.literal(0)
  }).strict()
}).strict();
```

`entries` is the file projection of the Phase 0 App-readable roots used for plan before-version checks: `00大脑规则`, `01图书馆`, and `02知识库`. `03大讲堂` is not a V1 App read/write root; it is covered only by the second full-vault namespace inventory. Both projections come from the same two descriptor scans—never a second path walk. `namespaceEntries` also includes root files, `.obsidian`, hidden directories, and every other top-level entry. Identity, mode, timestamps, and content/link-target hashes make an unrelated inode or permission-only replacement visible; special files fail closed. This detects net content and metadata differences outside the three App-readable roots as well as path additions/deletions. Neither list is copied into public reports; this private baseline remains mode `0600`. `netChangesObserved:0` means only that the two completed descriptor snapshots were identical, not that no transient write occurred between them.

- [ ] **Step 2: Write failing isolation/stability tests**

Using `createTempWriteVault` plus a private sentinel approval record under temporary appData, prove the two native scans have identical sorted identity/mode/path/size/time/hash records and namespace aggregates; output/appData inside or above the vault is rejected; `WRITE_ENABLED` unset/true is rejected; an allowed-root symlink/special file or file changing during read fails closed. Add native synchronization cases for root/ancestor replacement, hidden file/directory addition, symlink-target replacement, permission-only change, and same-path/same-size/restored-mtime different bytes; each must fail rather than yield a mixed snapshot. Add these exact negative cases:

```text
NODE_ENV=test + /Users/ao/我的大脑 -> FORMAL_VAULT_FORBIDDEN_IN_TEST
root dev/ino changes between scans -> VAULT_ROOT_IDENTITY_CHANGED
root .local/ -> RUNTIME_ARTIFACT_IN_VAULT
root state.sqlite3 -> RUNTIME_ARTIFACT_IN_VAULT
root recovery/manifest.json -> RUNTIME_ARTIFACT_IN_VAULT
new namespace path or changed .obsidian file bytes between passes -> VAULT_NAMESPACE_CHANGED_DURING_CAPTURE
rule file changes between passes -> RULE_BUNDLE_CHANGED_DURING_CAPTURE
missing/stale/wrong-validator approval -> RULE_BUNDLE_UNAPPROVED
```

Use injected filesystem/stat adapters for the formal-path and root-identity cases so the automated test never opens the real formal vault. Run exactly:

```bash
npm run test:integration -- tests/integration/acceptance/formal-vault-baseline.test.ts
```

Expected: RED because the strict native baseline and bound output writer do not exist.

- [ ] **Step 3: Implement the read-only scanner**

`formal-vault-baseline.ts` must:

```ts
const ALLOWED_ROOTS = ['00大脑规则', '01图书馆', '02知识库'] as const;
if (process.env.WRITE_ENABLED !== 'false') throw new Error('BASELINE_REQUIRES_WRITE_DISABLED');
assertExactPackagedHelperArgument(
  helperPath,
  releaseLayout(appVersion).helper,
  'BASELINE_HELPER_PATH_MISMATCH'
);
const verifiedHelperExecutable = await createVerifiedNativeHelperExecutable(helperPath);
const nativeReadPort = await createNativeReadVaultPort({
  executable: verifiedHelperExecutable,
  vaultRoot
});
const root = await nativeReadPort.probeRoot();
const privateReadPort = await createPrivateRecoveryReadPort({
  executable: verifiedHelperExecutable,
  appDataRoot
});
const privateStore = await openReadOnlyPrivateRecoveryStore({
  appDataRoot,
  nativePort: privateReadPort
});
const outputParent = await openBoundAcceptanceOutputParent(outputPath);
if (process.env.NODE_ENV === 'test' && root.realPath === '/Users/ao/我的大脑') {
  throw new Error('FORMAL_VAULT_FORBIDDEN_IN_TEST');
}
if (root.realPath !== '/Users/ao/我的大脑' && process.env.NODE_ENV !== 'test') {
  throw new Error('FORMAL_BASELINE_ROOT_MISMATCH');
}
if (boundRootsOverlap(root, outputParent.identity)) {
  throw new Error('BASELINE_OUTPUT_OVERLAPS_VAULT');
}
if (boundRootsOverlap(root, await privateStore.appDataRootIdentity())) {
  throw new Error('BASELINE_APP_DATA_OVERLAPS_VAULT');
}
```

The `--helper` argument is accepted only when its component-walked canonical path and held executable dev/ino equal Task 2's exact packaged helper; unit tests inject an equivalent verifier rather than choosing another binary. Call Task 4's `captureStableContentAwareVaultNamespace(nativeReadPort, { includeBytesFor: RULE_BUNDLE_SOURCE_PATHS })` exactly once; that composer performs the required two private native scans. Derive both `entries` and `namespaceEntries` from its one hidden-inclusive record set and derive current rule hashes only from the selected rule bytes returned in those same scans. No code in the baseline may call Node `lstat`, `readdir`, `readlink`, or `open` on a vault pathname. Use its UTF-8-sorted canonical records and `namespaceAggregateSha256`. Reject these vault-root runtime locations before accepting either pass:

```ts
const FORBIDDEN_ROOT_ARTIFACTS = new Set([
  '.local', 'release', 'config', 'state', 'drafts', 'recovery', 'backups', 'logs',
  'state.sqlite3', 'state.sqlite3-wal', 'state.sqlite3-shm'
]);
```

Also reject root files matching `*.sqlite`, `*.sqlite3`, `*.sqlite-wal`, `*.sqlite-shm`, `app-config.json`, `deepseek-smoke.json`, `formal-vault-before.json`, or `formal-vault-after.json`. Existing `.obsidian` content remains outside App mutation scope but is still identity/mode/content-hashed in the full namespace, so any change invalidates the baseline. Compute the current rule bundle from the selected bytes carried by the stable native snapshot; do not accept a caller-supplied rule hash or reopen a rule path.

Read the private approved-rule record before and after the vault snapshot through Phase 1's held, identity-bound appData storage port; validate `0600`/regular-file/no-symlink/hash and require both reads and its validator/current bundle/file hashes to match. Require the snapshot's two native passes to have identical root realpath/dev/ino, allowed aggregate, namespace aggregate, and rule bytes. The output parent must already be the canonical non-symlink `.local/acceptance` directory outside both vault and appData; bind its dev/ino, write the evidence through a held-parent exclusive temp inode with mode `0600`, fsync/reread/validate, rename exclusively to the fixed output basename, and fsync the parent. No caller-selected output outside that directory is accepted. `formal-vault-baseline.ts` and its transitive imports may contain the read-only native protocol/client and private appData reader, but no `AtomicFileHelper`, mutation command, writer, coordinator, intake, recovery mutation, or database import.

Modify `real-vault-read-smoke.ts` to use the same packaged `NativeReadVaultPort` stable snapshot with `WRITE_ENABLED=false`, no Obsidian credentials or mutation client import, and fields:

```ts
source: 'native-descriptor-read-only',
writeMethodsImported: false,
netChangesObserved: 0,
snapshotStability: 'two-identical-descriptor-scans'
```

- [ ] **Step 4: Test and commit the scanner; defer the real capture**

```bash
npm run test:integration -- tests/integration/acceptance/formal-vault-baseline.test.ts
npm run test:unit -- tests/unit/real-vault-read-smoke.test.ts
git add src/shared/acceptance/evidence.ts src/shared/acceptance/read-only-vault-snapshot.ts scripts/acceptance/formal-vault-baseline.ts scripts/real-vault-read-smoke.ts tests/integration/acceptance/formal-vault-baseline.test.ts tests/unit/real-vault-read-smoke.test.ts
git commit -m "test: capture read-only formal vault baseline"
```

Expected: tests pass and the script is ready for Task 8's supervised capture after the packaged App has saved a current native rule-compatibility approval. The real capture output must match `^PASSED formal-baseline netChangesObserved=0 snapshotStability=two-identical-descriptor-scans files=[1-9]\d* aggregateSha256=[a-f0-9]{64} namespaceSha256=[a-f0-9]{64} approvedRules=true forbiddenArtifacts=0$`.

### Task 7: Inject Electron-owned production authority and verify one formal write

**Files:**
- Create: `src/electron/production-mutation-target-policy.ts`
- Create: `src/server/security/supervised-confirmation.ts`
- Create: `src/electron/write-confirmation.ts`
- Create: `src/electron/rule-compatibility-approval.ts`
- Create: `src/electron/recovery-export.ts`
- Create: `src/electron/native-recovery-export-port.ts`
- Create: `src/server/rules/rule-compatibility-validator.ts`
- Create: `src/server/rules/compatibility-fixtures.ts`
- Create: `scripts/acceptance/verify-formal-write.ts`
- Create: `tests/unit/production-mutation-target-policy.test.ts`
- Create: `tests/unit/supervised-confirmation.test.ts`
- Create: `tests/unit/write-confirmation.test.ts`
- Create: `tests/unit/rule-compatibility-approval.test.ts`
- Create: `tests/unit/rule-compatibility-validator.test.ts`
- Create: `tests/unit/native-recovery-export-port.test.ts`
- Create: `tests/integration/production-mutation-authority.test.ts`
- Create: `tests/integration/rule-compatibility-gate.test.ts`
- Modify: `tests/integration/intake-api.test.ts`
- Modify: `tests/integration/recovery-retention-service.test.ts`
- Modify: `tests/integration/native-capability-gate.test.ts`
- Create: `tests/electron/native-write-confirmation.spec.ts`
- Create: `tests/electron/rule-compatibility-approval.spec.ts`
- Create: `tests/electron/recovery-export.spec.ts`
- Modify: `tests/electron/packaged-security.spec.ts`
- Create: `tests/native/recovery-export-helper.contract.test.ts`
- Create: `tests/integration/acceptance/verify-formal-write.test.ts`
- Modify: `src/server/vault/MutationTargetPolicy.ts`
- Modify: `src/server/workflow/write-coordinator.ts`
- Modify: `src/server/workflow/recovery-service.ts`
- Modify: `src/server/workflow/write-repository.ts`
- Modify: `src/server/recovery/recovery-scanner.ts`
- Modify: `src/server/recovery/recovery-journal.ts`
- Modify: `src/server/recovery/recovery-export-service.ts`
- Modify: `src/server/recovery/recovery-retention-service.ts`
- Modify: `src/server/recovery/recovery-only-runtime.ts`
- Modify: `src/server/recovery/manual-resolution-service.ts`
- Modify: `src/server/db/repositories/recovery-retention-repository.ts`
- Modify: `src/server/db/repositories/intake-repository.ts`
- Modify: `src/server/intake/intake-service.ts`
- Modify: `src/server/intake/intake-reconciler.ts`
- Modify: `src/server/workflow/extraction-service.ts`
- Modify: `src/server/ai/orchestrator.ts`
- Modify: `src/server/workflow/formal-ingestion-planner.ts`
- Modify: `src/server/workflow/knowledge-edit-planner.ts`
- Modify: `src/server/start-server.ts`
- Modify: `src/electron/main.ts`
- Modify: `src/electron/database-recovery.ts`
- Modify: `src/electron/ipc-authority.ts`
- Modify: `src/electron/runtime.ts`
- Modify: `src/electron/preload.ts`
- Modify: `src/shared/desktop/bridge.ts`
- Modify: `src/shared/api/schemas.ts`
- Modify: `src/shared/domain/write.ts`
- Modify: `src/shared/domain/intake.ts`
- Modify: `src/client/api/client.ts`
- Modify: `src/client/components/intake/IntakeConfirmation.tsx`
- Modify: `src/client/pages/QueuePage.tsx`
- Modify: `src/client/pages/WriteConfirmationPage.tsx`
- Modify: `src/client/pages/RecoveryDetailPage.tsx`
- Modify: `src/client/pages/SettingsPage.tsx`
- Modify: `src/client/pages/KnowledgeEditorPage.tsx`
- Modify: `src/client/pages/OperationsPage.tsx`
- Modify: `src/client/components/editor/EditDiffConfirmation.tsx`
- Modify: `src/server/api/routes/intake-jobs.ts`
- Modify: `src/server/api/routes/write-plans.ts`
- Modify: `src/server/api/routes/write-batches.ts`
- Modify: `src/server/api/routes/recovery.ts`
- Modify: `src/server/recovery/recovery-manifest.ts`
- Modify: `native/macos/atomic-file-helper.c`
- Modify: `src/server/vault/atomic-helper-protocol.ts`
- Modify: `src/server/vault/NativeReadVaultPort.ts`
- Modify: `tests/component/api-client.test.tsx`
- Modify: `tests/component/intake-queue.test.tsx`
- Modify: `tests/component/write-confirmation.test.tsx`
- Modify: `tests/component/recovery-ui.test.tsx`
- Modify: `tests/component/knowledge-editor.test.tsx`
- Modify: `tests/component/knowledge-editor-conflict.test.tsx`
- Modify: `tests/integration/formal-ingestion-api.test.ts`
- Modify: `tests/helpers/write-crash-worker.ts`
- Modify: `tests/integration/write-kernel.test.ts`
- Modify: `tests/integration/write-recovery-crash.test.ts`
- Modify: `tests/integration/intake-service.test.ts`
- Modify: `tests/integration/formal-ingestion-coordinator.test.ts`
- Modify: `tests/integration/formal-ingestion-crash.test.ts`
- Modify: `tests/integration/formal-ingestion-recovery.test.ts`
- Modify: `tests/integration/knowledge-edit-coordinator.test.ts`
- Modify: `tests/integration/knowledge-edit-recovery.test.ts`
- Modify: `tests/integration/recovery-only-runtime.test.ts`
- Modify: `tests/integration/manual-recovery-resolution.test.ts`
- Modify: `tests/electron/packaged-database-recovery.spec.ts`

- [ ] **Step 1: Add App-native approval for the exact five-file rule compatibility fingerprint**

Create the production read-only `rule-compatibility-validator.ts` and bounded compatibility fixtures around the exact ordered paths; reuse Phase 0's `RuleCompatibilityGate` port, record schema, authoritative path tuple, and fixture-approved test gate without redefining any of them:

```ts
import { RULE_BUNDLE_SOURCE_PATHS } from './rule-bundle.js';
import {
  buildRuleApprovalFiles,
  ruleApprovalRecordSchema,
  type RuleApprovalRecord
} from '../../shared/domain/rule-approval.js';

export const RULE_COMPATIBILITY_VALIDATOR_VERSION = 'phase6-rule-compat-v1' as const;
```

Require the imported tuple to match Phase 0's strict approval-record tuple at compile/test time; do not copy the five path literals into a second runtime constant. Inject the already root-bound `NativeReadVaultPort` and call the Task 4 stable snapshot composer with `includeBytesFor: RULE_BUNDLE_SOURCE_PATHS` before and after running fixtures. Parse only the selected bytes returned by those descriptor scans, require the two complete rule record/byte sets to match exactly, and never call Node `lstat`, `readlink`, `open`, or `readFile` on a vault pathname. Reuse the authoritative rule parser, strict source/knowledge schemas, path allowlists, frontmatter patchers, candidate validator, formal renderer/parser, knowledge-edit policy, and canonical `buildRuleApprovalFiles(fileHashes)` helper; the helper rejects any missing/extra map entry and returns the exact five-element `RuleApprovalRecord['files']` tuple without widening. `compatibility-fixtures.ts` contains bounded synthetic source, automatic and `user_confirmed` intake-package, extraction candidate, create/merge knowledge, draft edit, restore, and recovery-plan inputs in production source—not under `tests/`—with exact expected parse/policy/path results. The validator runs every fixture without model/network/database/mutation-helper/coordinator imports and returns the canonical bundle fingerprint only when both stable descriptor snapshots and every expected result match. A natural-language rule reclassification is not compatibility approval.

`rule-compatibility-approval.ts` persists the Phase 0-owned `RuleApprovalRecord` contract at `<userData>/config/approved-rule-bundle.json` mode `0600` through Phase 1's held, identity-bound private appData storage port; it imports the shared schema/type and must not declare a second schema or reopen an absolute child path:

```ts
const record: RuleApprovalRecord = {
  schemaVersion: 1,
  bundleSha256,
  validatorVersion: 'phase6-rule-compat-v1',
  approvedAt,
  files: buildRuleApprovalFiles(fileHashes)
};
ruleApprovalRecordSchema.parse(record);
```

The Settings page reads public status/change summaries through health: current hash, approved hash, validator version, and changed rule filenames/hash prefixes only. The canonical bridge signature is `approveRuleCompatibility({ expectedBundleSha256 }): Promise<{ status:'approved'; bundleSha256:string } | { status:'cancelled' }>`; validation failures reject with stable safe codes rather than returning a third success-like variant. `window.xiaozhaoDesktop.approveRuleCompatibility(...)` first calls `assertTrustedMainFrameIpc`, reloads the current five-file summary through the descriptor snapshot port in main, rejects stale expected hash, and opens a native warning dialog listing all changed files and both hash prefixes. Only response `1` runs the complete read-only validator; only a passing, still-current descriptor result is atomically/fsynced into the private approval record. Cancel and validator failure write nothing. No rule bytes pass through renderer/HTTP.

Inject the existing `RuleCompatibilityGate` port into intake reconciliation/application, `AIOrchestrator`, extraction start, formal-ingestion plan creation, knowledge-edit/restore plan creation, `WriteCoordinator`, and `ProductionMutationTargetPolicy`. Missing approval, validator-version mismatch, or current hash mismatch returns only `RULE_BUNDLE_UNAPPROVED`: browsing remains available, but automatic intake execution, model runs, every new/reused write plan, and formal mutation are blocked. Coordinator/policy recheck the approved hash under the write mutex; a plan's `ruleBundleSha256` must equal both current and approved hash. Environment, CLI, HTTP, model output, background reclassification, and a serialized record cannot approve.

Unit tests cover missing/changed/reverted rule, changed one of each five files, validator-version bump, root/ancestor/entry replacement at native scan hooks, hidden rule-path collision, synthetic fixture failure, symlink/special file, cancel, stale renderer hash, wrong/child/stale `WebContents`/frame, record mode/symlink, and atomic crash boundaries. Integration tests prove every listed service is blocked before model/planner/manifest/helper effects and becomes enabled only through an injected valid gate. `rule-compatibility-approval.spec.ts` uses only the packaged sentinel fixture and temporary userData; its fake native response can approve that fixture hash but must reject `/Users/ao/我的大脑` and aliases before reading. No automated test creates a formal approval record.

Run:

```bash
npm run test:unit -- tests/unit/rule-compatibility-validator.test.ts tests/unit/rule-compatibility-approval.test.ts
npm run test:integration -- tests/integration/rule-compatibility-gate.test.ts
npm run dist:mac
npm run test:electron -- tests/electron/rule-compatibility-approval.spec.ts
```

Expected: all synthetic/sentinel checks pass; all non-native approval attempts fail. Before Task 6's formal baseline, the user must open the packaged App, review Settings' current five-file diff/hash, approve once in the native dialog, observe `规则兼容性：已批准`, then quit the App. A later rule-byte or validator-version change requires a new App-native approval and a new formal baseline.

- [ ] **Step 2: Write failing native-grant scope and consumption tests**

Use the complete scope; no test may reduce it to only plan ID/hash:

```ts
const scope: NativeGrantScope = {
  electronSessionId: 'session-1',
  rootIdentitySha256: 'a'.repeat(64),
  appDataIdentitySha256: 'd'.repeat(64),
  recoveryRootIdentitySha256: 'e'.repeat(64),
  canonicalScopeSha256: '1'.repeat(64),
  planId: 'plan-1',
  planSha256: 'b'.repeat(64),
  projectionCapsuleSha256: 'f'.repeat(64),
  profileKey: '2'.repeat(64),
  ruleBundleSha256: '3'.repeat(64),
  intentKind: 'extraction_batch',
  originalIntentKind: null,
  operation: 'execute',
  recoverySnapshotSha256: null,
  resolutionSha256: null
};
const service = createSupervisedConfirmationService({
  monotonicNowMs: () => monotonicNow,
  wallNow: () => wallNow,
  randomToken: () => 'c'.repeat(64), ttlMs: 60_000
});
const token = service.issuer.issue(scope);
expect(service.consumer.consume({ token, scope })).toMatchObject({
  confirmationKind: 'electron-native-dialog',
  nativeGrantScopeSha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
});
expect(service.consumer.consume({ token, scope })).toBeUndefined();
```

For every field, mutate it independently and prove consumption fails and destroys the token. Prove 59,999 monotonic ms passes, 60,000 monotonic ms fails, wall-clock rollback/forward has no effect on expiry, wrong-length/non-hex tokens fail, a failed comparison cannot be retried, shutdown clears all grants, and neither logs nor returned evidence contain the token. `confirmedAt` comes only from `wallNow`; expiry and age comparisons use only `monotonicNowMs`. Run:

Add a `user_confirmed` intake case whose projection-capsule hash covers the authoritative mode and post-confirmation expected job version and whose persisted binding fixes that capsule to the plan. If confirmation resolves `needs_confirmation` version `N`, the immutable plan, capsule, binding row, returned preview and later apply expectation must all use the atomically committed `ready` version `N + 1`; a preview carrying `N` is invalid. Ordinary grant issue reloads the unique `active` binding and requires exact job ID/version, binding ID/version, plan ID/hash, capsule hash and `user_confirmed` mode. On ordinary apply, `authorize()` strictly derives and consumes the one-use scope first, then repeats that exact active-binding query before returning authority; therefore a transition to `cancelled` (including stale/superseded reasons) or `consumed` consumes/rejects the old token rather than leaving reusable authority. A replacement is a new server-generated immutable binding with the next binding version, never a mutation/reactivation of the old row. Do not add a parallel renderer-controlled `authorizationMode` or job-version field to `NativeGrantScope`; those values remain covered by the bound plan/capsule hashes and are corroborated by the server-only binding reader. Add recovery cases whose current plan is a `kernel_recovery` plan and whose scope contains that recovery plan's ID/hash, `intentKind:'kernel_recovery'`, the original manifest's `originalIntentKind`, `operation:'continue'`, `'rollback'`, or `'resolve'`, and the fresh recovery snapshot hash. For an original user-confirmed intake, recovery grant issue and application require the exact manifest-backed binding to be historical `consumed`, never active; test live no-restart recovery entry as well as startup reconstruction. Resolve also binds the canonical resolution-selection hash. Changing the recovery plan while keeping the original plan hash, the original intent, snapshot/current hashes, resolution selection or consumed binding tuple while retaining another field must consume and reject the grant.

```bash
npm run test:unit -- tests/unit/supervised-confirmation.test.ts
```

Expected: FAIL because the split issuer/consumer service does not exist.

- [ ] **Step 3: Implement split issuer/consumer capability ownership**

`supervised-confirmation.ts` defines:

```ts
export type NativeGrantScope = {
  readonly electronSessionId: string;
  readonly rootIdentitySha256: string;
  readonly appDataIdentitySha256: string;
  readonly recoveryRootIdentitySha256: string;
  readonly canonicalScopeSha256: string;
  readonly planId: string;
  readonly planSha256: string;
  readonly projectionCapsuleSha256: string;
  readonly profileKey: string;
  readonly ruleBundleSha256: string;
  readonly intentKind: WriteIntent['kind'];
  readonly originalIntentKind: RecoverableOriginalIntentKind | null;
  readonly operation: MutationOperation;
  readonly recoverySnapshotSha256: string | null;
  readonly resolutionSha256: string | null;
};
export type ConsumedNativeGrant = {
  readonly confirmationKind: 'electron-native-dialog';
  readonly confirmedAt: string;
  readonly nativeGrantScopeSha256: string;
};
export interface NativeGrantIssuer { issue(scope: NativeGrantScope): string; clear(): void; }
export interface NativeGrantConsumer {
  consume(input: { readonly token: string; readonly scope: NativeGrantScope }): ConsumedNativeGrant | undefined;
}
```

The factory returns separate frozen `issuer` and `consumer` objects. Electron main retains `issuer`; only `ProductionMutationTargetPolicy` receives `consumer`. Tokens are random 32-byte hex, remain only in a private in-memory map, store a canonical hash of the complete `NativeGrantScope` rather than scope JSON, compare token and scope hashes with `timingSafeEqual`, delete before every comparison result, expire at 60 seconds using the injected monotonic clock only, and clear on shutdown. The complete grant scope includes the Electron session; target/appData/recovery-root identity hashes (each identity includes realpath/dev/ino); server-derived canonical step-scope hash; current plan ID/hash; strict projection-capsule hash; current capability `profileKey`; current approved `ruleBundleSha256`; intent/original intent; operation; recovery snapshot; and resolution selection. Electron main derives all three added hashes from the same freshly loaded server-owned plan/profile/rule evidence used for the native summary; renderer input cannot supply them. A separate wall clock supplies the redacted confirmation timestamp but never authorization age. Fastify, routes, model code, fixtures, CLI adapters, and the renderer cannot import or receive `NativeGrantIssuer`.

- [ ] **Step 4: Write the complete production-policy scope matrix**

Create `production-mutation-target-policy.test.ts` against a temporary fake formal root and injected realpath/stat/profile/grant adapters. Do not open `/Users/ao/我的大脑`. Cover this matrix:

| Plan/operation | Required authority | Allowed paths and steps |
|---|---|---|
| `intake` whose bound strict capsule classification has `authorizationMode:'automatic'` / `execute` | automatic, token absent | exactly one Phase 2 high-confidence classified package under `01图书馆/小兆clipper`, using one of the four locked shape sequences below; no platform-root creation and no extra step |
| `intake` whose bound strict capsule classification has `authorizationMode:'user_confirmed'` / `execute` | matching native grant | the exact atomically bound immutable Phase 2 user-confirmed plan/capsule for one resolvable package, using the same four locked shape sequences; no platform-root creation and no extra step |
| `extraction_batch` / `execute` | matching native grant | only knowledge create/replace followed by exactly one `source-status` replace |
| `knowledge_edit` mode `draft` / `execute` | matching native grant | one allowed knowledge replace |
| `knowledge_edit` mode restore / `execute` | matching native grant | one allowed knowledge restore replace |
| `kernel_recovery` recovery plan / `continue` | matching native grant bound to recovery-plan ID/hash + original intent + current recovery snapshot hash | only the pending original manifest's unchanged remaining suffix in ascending order |
| `kernel_recovery` recovery plan / `rollback` | matching native grant bound to recovery-plan ID/hash + original intent + current recovery snapshot hash | only the original manifest's durably landed steps reversed in descending order |
| `kernel_recovery` resolution plan / `resolve` | matching native grant bound to resolution-plan ID/hash + original intent + fresh current snapshot + resolution-selection hash | keep the verified current version or select only a manifest-verified before/after/retained version; no caller bytes or force |
| `kernel_test`, arbitrary intent, `automatic` intake with any token, `user_confirmed` intake without its matching token, or another human intent without token | forbidden | no manifest/helper call |

Both intake authorization modes use only these four Phase 2 sequences and exact entry kinds; authority mode never changes path/step scope:

```text
directory + missing month: replace metadata; move-exclusive file rename; mkdir-exclusive month; move-exclusive directory package
directory + existing month: replace metadata; move-exclusive file rename; move-exclusive directory package
single_file + missing month: replace metadata; mkdir-exclusive month; mkdir-exclusive target package; move-exclusive file
single_file + existing month: replace metadata; mkdir-exclusive target package; move-exclusive file
```

Every replace and file rename stays inside the one classified clipper package; the month is exactly one `YYYY-MM` beneath an existing allowlisted `01图书馆/来自<平台>` root; the target package is exactly the classifier's absent normalized package; the final move is exclusive and collision-free. For intake, test source outside clipper, nested escape, disallowed platform, wrong month syntax, creation of a platform/core directory, extra month/package mkdir beyond the chosen shape, missing/extra/reordered step, wrong file-versus-directory move, destination collision, a second package, extra knowledge/source step, and symlink alias. Also independently test a persisted plan-to-capsule binding mismatch, a changed capsule authorization mode, a caller/renderer/body `authorizationMode` override, an automatic plan with a token, a user-confirmed plan without a token, a token for another plan/capsule/mode, and replay. For ordinary confirmed-intake execution, exercise `needs_confirmation N -> ready N+1`, reject a preview/apply expectation that still carries `N`, require the one unique active binding at grant issue, `authorize()` and every forward `assertCurrent()`, and pause after token issue before independently cancelling, stale-invalidating, superseding or consuming the binding; each old scope must fail before manifest/helper effects. For an intake recovery plan, require the manifest-backed original binding to be consumed by live recovery entry or startup reconstruction before grant issue, authorization and every recovery `assertCurrent()`; active or mismatched history fails before effects. A native-dialog cancel is not a binding cancellation and exact replay keeps the same active preview. The next explicit confirm/retry must append a server-derived binding at `max(binding_version)+1`; no route may choose, decrement, reuse or reactivate a version. The mode is authored by Phase 2 from the authoritative classification transition, lives inside the strict intake capsule payload/hash, and is atomically bound to the immutable plan; production policy never trusts a route argument for it. For human/recovery cases, test wrong target dev/ino, app-data dev/ino, recovery-root realpath/dev/ino, Electron session, intent, original intent, operation, plan hash, projection-capsule hash, complete profile, snapshot/current hashes, resolution selection, stale rule hash, and grant replay. Every recovery plan has new contiguous ordinals and every step binds the original ordinal through `recoveryOfOrdinal`; never reuse original ordinals as the new plan's ordinal. Continue allows the exact pending suffix, rollback the exact durably landed reverse, and resolve only the user-selected manifest-known version. A recovery-only `retire-created-file` is valid only when it binds an original landed create's path/hash/dev/ino and moves it exclusively into that batch's appData `retained/`; no recovery path calls unlink. Also reject a profile produced by the unsigned/development helper, a packaged-helper SHA/signature change, OS build/arch change, formal volume dev/filesystem change, recovery-device mismatch, incomplete primitive evidence, or nonmatching crash-matrix digest. Prove `NODE_ENV=production`, `WRITE_ENABLED=true`, `VAULT_REAL_ROOT`, a fake 64-hex HTTP token, CLI flags, fixture/model callbacks, caller-supplied new resolution bytes, a force flag, and a serialized `MutationTargetAuthorization` cannot authorize anything.

Run:

```bash
npm run test:unit -- tests/unit/production-mutation-target-policy.test.ts
```

Expected: FAIL because the production policy does not exist.

- [ ] **Step 5: Implement the Electron-only production policy**

First extend the Phase 1 policy port additively in this task, alongside every existing caller and fixture listed above. Preserve every Phase 1 field and add only the operation/grant/recovery lifecycle required by Phase 4 and production authority:

```ts
export type MutationOperation = 'execute' | 'continue' | 'rollback' | 'resolve';
export type MutationPolicyInput = {
  readonly targetRoot: string;
  readonly appDataRoot: string;
  readonly plan: WritePlan;
  readonly projectionCapsule: DomainProjectionCapsule;
  readonly profile: NativeCapabilityProfile;
  readonly operation: MutationOperation;
  readonly nativeGrantToken?: string;
  readonly recoverySnapshotSha256?: string;
  readonly resolutionSha256?: string;
};
type MutationTargetAuthorizationCommon = {
  readonly policyId: string;
  readonly targetRootRealPath: string;
  readonly targetDevice: string;
  readonly targetInode: string;
  readonly appDataRootRealPath: string;
  readonly appDataDevice: string;
  readonly appDataInode: string;
  readonly recoveryRootRealPath: string;
  readonly recoveryDevice: string;
  readonly recoveryInode: string;
  readonly intentKind: WriteIntentKind;
  readonly originalIntentKind: RecoverableOriginalIntentKind | null;
  readonly targetRootIdentitySha256: string;
  readonly appDataRootIdentitySha256: string;
  readonly recoveryRootIdentitySha256: string;
  readonly canonicalScopeSha256: string;
  readonly planId: string;
  readonly planSha256: string;
  readonly projectionCapsuleSha256: string;
  readonly profileKey: string;
  readonly ruleBundleSha256: string;
  readonly authorizationSha256: string;
  readonly operation: MutationOperation;
  readonly recoverySnapshotSha256: string | null;
  readonly resolutionSha256: string | null;
  readonly [mutationAuthorizationBrand]: true;
};
type MutationAuthorizationProvenance =
  | {
      readonly authorizationKind: 'sentinel-test';
      readonly productionEvidenceSha256: null;
      readonly nativeGrantScopeSha256: null;
      readonly confirmedAt: null;
    }
  | {
      readonly authorizationKind: 'automatic-intake';
      readonly productionEvidenceSha256: string;
      readonly nativeGrantScopeSha256: null;
      readonly confirmedAt: null;
    }
  | {
      readonly authorizationKind: 'native-grant';
      readonly productionEvidenceSha256: string;
      readonly nativeGrantScopeSha256: string;
      readonly confirmedAt: string;
    };
export type MutationTargetAuthorization =
  MutationTargetAuthorizationCommon & MutationAuthorizationProvenance;
export interface MutationTargetPolicy {
  authorize(input: MutationPolicyInput): Promise<MutationTargetAuthorization>;
  assertCurrent(
    authorization: MutationTargetAuthorization,
    input: MutationPolicyInput
  ): Promise<void>;
  release(authorization: MutationTargetAuthorization): void;
}
```

Update `SentinelTestMutationPolicy`, `WriteCoordinator`, `RecoveryService`, and every listed coordinator/crash fixture in the same task so no intermediate commit has the old call signature. The shared authorization schema defines the common fields once, uses `authorizationKind` as a three-branch strict discriminant for the exact provenance nullability above, and exports this type with `z.infer`; a producer cannot construct sentinel+production evidence, automatic+confirmation time, or native+null scope. The sentinel supplies explicit operations, accepts the optional token only as an opaque ignored transport seam, revalidates the complete input, and implements idempotent `release()`; production consumption remains exclusive to the Electron-owned policy.

`production-mutation-target-policy.ts` exports one Electron-owned evidence authority factory and no default instance. The returned object owns one frozen set of held root/profile/rule observers, exposes a main-private confirmation-scope provider, and creates the policy only after the selected server branch supplies its binding/recovery readers:

```ts
export const PRODUCTION_MUTATION_POLICY_ID = 'electron-production-v1' as const;
export interface NativeConfirmationScopeProvider {
  deriveCurrent(input: {
    readonly material: ServerMutationSummaryMaterial;
    readonly operation: MutationOperation;
  }): Promise<NativeGrantScope>;
}
export type MutationTargetPolicyFactoryInput = {
  readonly confirmedIntakeBindings: ConfirmedIntakeBindingAuthority;
  readonly resolveRecoverySource: (plan: WritePlan) => Promise<RecoveryAuthorizationSource>;
};
export type MutationTargetPolicyFactory = (
  input: MutationTargetPolicyFactoryInput
) => MutationTargetPolicy;
export interface ElectronProductionMutationEvidenceAuthority {
  readonly confirmationScopes: NativeConfirmationScopeProvider;
  createPolicy(input: MutationTargetPolicyFactoryInput): MutationTargetPolicy;
}
export function createElectronProductionMutationEvidenceAuthority(input: {
  readonly launchMode: ElectronLaunchMode;
  readonly appIsPackaged: boolean;
  readonly electronSessionId: string;
  readonly formalRoot: CanonicalRootIdentity;
  readonly appDataRoot: CanonicalRootIdentity;
  readonly recoveryRoot: CanonicalRootIdentity;
  readonly profile: ProductionNativeCapabilityProfile;
  readonly ruleCompatibilityGate: RuleCompatibilityGate;
  readonly grants: NativeGrantConsumer;
  readonly observeFormalRoot: () => Promise<CanonicalRootIdentity>;
  readonly observePrivateRoots: () => Promise<{
    readonly appDataRoot: CanonicalRootIdentity;
    readonly recoveryRoot: CanonicalRootIdentity;
  }>;
  readonly revalidateProfile: () => Promise<ProductionNativeCapabilityProfile>;
}): ElectronProductionMutationEvidenceAuthority {
  if (!input.appIsPackaged || input.launchMode !== 'normal-packaged') {
    throw new Error('PRODUCTION_MUTATION_AUTHORITY_FORBIDDEN');
  }
  return createFrozenEvidenceAuthority({
    ...input, policyId: PRODUCTION_MUTATION_POLICY_ID
  });
}
```

The evidence authority's `confirmationScopes.deriveCurrent()` accepts only `ServerMutationSummaryMaterial` returned in process by Phase 4's reader, never the renderer request. It strictly reparses the plan/capsule, checks operation/original-intent/snapshot/resolution nullability, reobserves all three roots, calls `revalidateProfile()`, re-reads the current approved rule bundle, and recomputes canonical step scope before returning the complete `NativeGrantScope`. Any stale/missing profile, rule drift, root drift, or material mismatch fails before a native dialog and again after a positive response before token issue. Its internal root/profile/rule observer bundle is the exact same frozen object used by every policy created through `createPolicy()`; tests compare object identity and prove no second provider or caller-supplied evidence can be substituted.

The policy strictly parses the intent-owned projection capsule, recomputes the canonical plan, capsule, and complete step-scope hashes, reobserves target, app-data, and exact private recovery-root realpath/dev/ino, checks pairwise non-overlap and same-device recovery storage, refines `MutationPolicyInput.profile` through the full immutable `productionNativeCapabilityProfileSchema`, and requires current rule hash = approved compatibility hash = plan rule hash. `ConfirmedIntakeBindingAuthority` is a server-internal read-only port over the authoritative repository; it accepts the capsule-derived job/binding/plan/capsule tuple plus a server-owned check phase. Grant issue and ordinary apply-entry require exactly one matching `active` row whose `expectedJobVersion` equals the current `ready` job version; an ordinary in-coordinator `assertCurrent` also permits only the deterministic `applying` successor for that same forward operation while the same binding remains active. Recovery grant issue, `authorize()` and `assertCurrent()` instead resolve the original immutable manifest/capsule and require its user-confirmed binding to be the exact historical `consumed` row plus the job's recovery projection; a recovery plan can never pass an active-binding query. The port never accepts a different job lineage, operation or binding and is not exposed through HTTP, preload, renderer or model code. `authorize()` applies the table above. An intake whose atomically plan-bound strict capsule has `authorizationMode:'automatic'` calls `assertAutomaticIntakeScope(plan, projectionCapsule)` and rejects any present token. An ordinary intake whose bound capsule has `authorizationMode:'user_confirmed'` is a human mutation: after all immutable plan/capsule/root/profile/rule/scope validation, it constructs and consumes the matching `NativeGrantScope`, then calls `confirmedIntakeBindings.assertExactActive(...)` with every capsule-derived identity/version/hash before returning authority. The consumer deletes the token before either the scope or binding result is known, so mismatch cannot leave a retryable token. Missing, divergent, non-active ordinary authority or caller-supplied mode fails before manifest/helper effects; `authorize()` never infers automatic authority merely from `intent.kind === 'intake'`. Every other allowed human case constructs `NativeGrantScope` from the current plan and capsule plus the three current root identities; for recovery this is the current `kernel_recovery` plan ID/hash plus the original manifest's capsule hash, intent kind, and current snapshot, not the original plan hash substituted for the recovery plan. Because the canonical scope includes both plan and projection-capsule hashes and the capsule hash covers intake mode/job/binding versions, a grant minted for one active `user_confirmed` binding cannot authorize a replacement, recovery operation or same-shaped automatic binding. Resolve additionally hashes the exact selected known version/current observations. It consumes exactly one grant and rejects on any mismatch. A human/recovery result sets `authorizationKind:'native-grant'`, copies `ConsumedNativeGrant.nativeGrantScopeSha256` and `confirmedAt`, and keeps the independently recomputed `canonicalScopeSha256`; automatic intake sets `authorizationKind:'automatic-intake'`, `nativeGrantScopeSha256:null`, and `confirmedAt:null`. The three fields are mutually strict and `authorizationSha256` covers both distinct scope hashes plus every remaining authorization field. `assertCurrent()` receives the complete `MutationPolicyInput` and repeats plan/capsule hashes, complete steps and `recoveryOfOrdinal` bindings, all three root identities, profile evidence, rule approval/current bytes, recovery source, snapshot/current hashes, resolution selection, intake authorization mode, path-scope validation and the operation-appropriate binding query immediately before manifest preparation and every mutation; it never consumes a second token. Thus an ordinary token issued before cancellation, stale invalidation, supersession, consumption or replacement cannot pass its active check, while a recovery token cannot pass until the original binding is durably consumed. Confirmed-binding transitions and coordinator execution use the same Phase 1 `WorkflowMutationMutex`; the successful original execution keeps the binding active while its ordinary checks run, then the verified intake finalizer atomically marks that exact binding `consumed` before releasing the mutex. If a live post-manifest failure occurs, after the ordinary coordinator has stopped all current/helper checks it invokes Phase 2's idempotent recovery-entry hook under that same mutex; RecoveryService repeats the hook before exposing actions, and production recovery authority requires the resulting historical consumed row. A crash at the same window is reconstructed identically before routes open. Neither path resumes with the old grant. The branded authorization preserves all Phase 1 identity/scope/hash fields and adds only operation/recovery evidence. `release()` makes later production reuse fail `MUTATION_AUTHORIZATION_RELEASED`, including conflict and recovery-required outcomes.

The Phase 1 interface and `SentinelTestMutationPolicy` are updated by this Task 7 contract block with the same `release()` method. Sentinel release is idempotent; production release makes later reuse fail `MUTATION_AUTHORIZATION_RELEASED`.

Every production `NativeGrantScope` is reconstructed from fresh server-owned evidence and must carry `canonicalScopeSha256`, `profileKey`, and `ruleBundleSha256` equal to the policy's independently recomputed complete step scope, currently active capability profile, and current approved rule bytes. Its full canonical object hash is a separate `nativeGrantScopeSha256`; it is never substituted for `canonicalScopeSha256`. Any field drift destroys the one-use token before rejection; matching only plan/capsule IDs is insufficient.

Production authority additionally creates a reconstructible redacted evidence hash which deliberately excludes the ephemeral Electron session and raw token. `productionEvidenceSha256` is SHA-256 over canonical JSON of exactly `{ schemaVersion:1, policyId, authorizationKind, operation, targetRootIdentitySha256, appDataRootIdentitySha256, recoveryRootIdentitySha256, intentKind, originalIntentKind, planId, planSha256, projectionCapsuleSha256, canonicalScopeSha256, profileKey, ruleBundleSha256, recoverySnapshotSha256, resolutionSha256 }`. Every identity hash is independently derived from the live realpath/dev/ino tuple. It is required for both production `native-grant` and `automatic-intake`, and is `null` only for `sentinel-test`. `authorizationSha256` is then SHA-256 over canonical JSON of those same persistent fields plus `productionEvidenceSha256`, `nativeGrantScopeSha256`, and `confirmedAt`, excluding only `authorizationSha256` itself, the TypeScript brand, and journal-chain metadata. The coordinator copies the complete redacted projection plus both hashes into the strict authorization journal. The opaque full `nativeGrantScopeSha256` cannot be independently reconstructed after the session is gone and the journal must not pretend otherwise; durable verification checks its strict native/null rule and inclusion in `authorizationSha256`, while live production-policy tests prove it came from the consumed one-use scope.

- [ ] **Step 6: Make Electron main the sole constructor and inject the port in process**

In `main.ts`, after settings/root validation and before `startServer()`, load only the active profile created by Task 4's packaged production bootstrap and re-evaluate it against the currently signed helper and both current devices. A missing/stale profile constructs only the read-only policy and keeps intake/mutation routes blocked; it never silently probes or promotes during a normal launch:

```ts
const verifiedHelperExecutable = await createVerifiedNativeHelperExecutable(
  join(process.resourcesPath, 'native/atomic-file-helper')
);
const nativeReadPort = await createNativeReadVaultPort({
  executable: verifiedHelperExecutable,
  vaultRoot: config.vaultRoot
});
const privateNativePort = createAtomicFileHelper({
  executable: verifiedHelperExecutable,
  spawn
});
const privateStore = await PrivateRecoveryStore.open({
  appDataRoot: app.getPath('userData'),
  nativePort: privateNativePort
});
const formalRootIdentity = await nativeReadPort.probeRoot();
const appDataIdentity = await privateStore.appDataRootIdentity();
const recoveryRootIdentity = await privateStore.recoveryRootIdentity();
const capabilityProfileResult = await loadActiveProductionCapabilityProfile({
  privateStorage: privateStore,
  executable: verifiedHelperExecutable,
  formalRoot: formalRootIdentity,
  recoveryRoot: recoveryRootIdentity,
  requiredEvidenceSource: 'packaged-production-bootstrap-v1',
  requiredCrashMatrixSha256: WRITE_CRASH_MATRIX_SHA256
});
const electronSessionId = randomBytes(32).toString('hex');
const grants = createSupervisedConfirmationService({
  ttlMs: 60_000,
  monotonicNowMs: () => Number(process.hrtime.bigint() / 1_000_000n),
  wallNow: () => new Date().toISOString()
});
const ruleCompatibilityGate = await createRuleCompatibilityGate({
  vaultRoot: config.vaultRoot,
  privateStorage: privateStore,
  validatorVersion: RULE_COMPATIBILITY_VALIDATOR_VERSION
});
const productionEvidenceAuthority =
  launchMode === 'normal-packaged' && capabilityProfileResult.status === 'ready'
    ? createElectronProductionMutationEvidenceAuthority({
        launchMode, appIsPackaged: app.isPackaged, electronSessionId,
        formalRoot: formalRootIdentity,
        appDataRoot: appDataIdentity, recoveryRoot: recoveryRootIdentity,
        profile: capabilityProfileResult.profile,
        ruleCompatibilityGate,
        grants: grants.consumer,
        observeFormalRoot: () => nativeReadPort.probeRoot(),
        observePrivateRoots: () => privateStore.rootIdentities(),
        revalidateProfile: async () => {
          const current = await loadActiveProductionCapabilityProfile({
            privateStorage: privateStore,
            executable: verifiedHelperExecutable,
            formalRoot: await nativeReadPort.probeRoot(),
            recoveryRoot: (await privateStore.rootIdentities()).recoveryRoot,
            requiredEvidenceSource: 'packaged-production-bootstrap-v1',
            requiredCrashMatrixSha256: WRITE_CRASH_MATRIX_SHA256
          });
          if (current.status !== 'ready') {
            throw new Error('PRODUCTION_CAPABILITY_PROFILE_STALE');
          }
          return current.profile;
        }
      })
    : undefined;
const mutationTargetPolicyFactory: MutationTargetPolicyFactory = (ports) =>
  productionEvidenceAuthority
    ? productionEvidenceAuthority.createPolicy(ports)
    : launchMode === 'test-sentinel'
      ? new SentinelTestMutationPolicy(testPolicyConfig)
      : new ReadOnlyMutationTargetPolicy(
          launchMode === 'normal-packaged'
            ? 'PRODUCTION_CAPABILITY_PROFILE_STALE'
            : 'FORMAL_MUTATION_REQUIRES_NORMAL_PACKAGED_APP'
        );
const started: StartedMutationRuntime = await selectAndStartMutationRuntime({
  privateStore,
  startHealthy: (database) => startServer({
    ...desktopConfig,
    database,
    privateRecoveryStorage: privateStore,
    mutationTargetPolicyFactory
  }),
  startRecoveryOnly: (databaseFailure) => startRecoveryOnlyRuntime({
    ...desktopConfig,
    databaseFailure,
    privateRecoveryStorage: privateStore,
    mutationTargetPolicyFactory
  })
});
registerWriteConfirmationIpc({
  window, runtimeOrigin: started.origin, electronSessionId,
  grantIssuer: grants.issuer,
  summaries: started.mutationSummaryReader,
  scopeProvider: productionEvidenceAuthority?.confirmationScopes
    ?? new DenyNativeConfirmationScopeProvider('PRODUCTION_AUTHORITY_UNAVAILABLE')
});
const privilegedActions: ElectronPrivilegedActions =
  app.isPackaged && launchMode === 'normal-packaged'
    ? createNormalPackagedPrivilegedActions({
        launchMode, appIsPackaged: app.isPackaged,
        ruleApprovalGate: ruleCompatibilityGate,
        ruleValidator: createRuleCompatibilityValidator(nativeReadPort),
        recoveryExporter: started.mainRecoveryExporterPort,
        recoveryDestinationPort: createNativeRecoveryExportPort(verifiedHelperExecutable),
        formalRoot: config.vaultRoot,
        appDataRoot: app.getPath('userData')
      })
    : launchMode === 'test-sentinel'
      ? createBrandedSentinelPrivilegedActions(testPolicyConfig)
      : createDeniedElectronPrivilegedActions('PRIVILEGED_APP_ACTION_DISABLED');
registerRuleCompatibilityApprovalIpc({
  window, runtimeOrigin: started.origin,
  authority: privilegedActions.ruleApproval
});
registerRecoveryExportIpc({
  window, runtimeOrigin: started.origin,
  authority: privilegedActions.recoveryExport
});
```

`database-recovery.ts` implements the single `selectAndStartMutationRuntime()` selector above only after the common held helper, private store, root identities, active production profile, rule gate, Electron session and grant service exist. It imports and returns Phase 4's one `StartedMutationRuntime` interface; neither Electron branch declares a lookalike lifecycle shape. Its healthy and failed branches are lazy callbacks: a healthy, integrity-checked database invokes `startHealthy` exactly once and never touches `startRecoveryOnly`; corrupt, deleted, or unopenable SQLite invokes `startRecoveryOnly` exactly once and the `startHealthy`/`startServer` factory call count remains zero. The selector closes or transfers every database handle on all branches before returning. On the corrupt/deleted-SQLite branch, `main.ts` therefore starts `startRecoveryOnlyRuntime()` with that same private store and `mutationTargetPolicyFactory`; it never calls `startServer()`, opens `IntakeRepository`, or constructs an ordinary workflow service. The minimal runtime builds `ManifestConfirmedIntakeBindingAuthority` solely from each scanner-validated original manifest, strict intake projection capsule, promoted-batch identity and current recovery graph. For a `user_confirmed` intake it requires the capsule's exact job/binding ID/version, plan/capsule hashes and post-confirmation ready version and treats the durably promoted manifest as the only allowed historical-`consumed` proof defined by Phase 4; it accepts only recovery check phases and rejects every ordinary active-binding query. Automatic intake and non-intake originals require no fabricated binding. Missing, duplicate, divergent or non-promoted evidence yields no action. This port has no repository/SQLite import and is not serialized.

The recovery-only factory receives that manifest authority plus its existing scanner-backed `resolveRecoverySource`, then calls the same `productionEvidenceAuthority.createPolicy(...)` used by the healthy branch; the one evidence authority and its `confirmationScopes` provider therefore share object-identical held roots/profile/rule observers and `grants.consumer`. That composition constructs exactly one FIFO `WorkflowMutationMutex` of its own and injects the same instance into `RecoveryService`, `WriteCoordinator`, resolve-plan/current-action derivation, manifest-binding recovery entry, and every continue/rollback/resolve lifecycle transition. It preserves Phase 1's non-reentrant handoff: the service/planner may hold one bounded segment for hook/scan/snapshot/action/plan derivation, must release it before delegating, and the coordinator reacquires it and repeats every current check before effects. No nested acquisition or second mutex is allowed. The minimal runtime exposes Phase 4's scanner-derived `mutationSummaryReader` for App-native confirmation and returns the same `mainRecoveryExporterPort` through `StartedMutationRuntime`. Continue, rollback and resolve therefore require a fresh one-use grant and may append only the existing manifest/journal/recovery-plan/projection-pending evidence; export requires no grant but keeps the same private evidence lease. Ordinary intake apply, automatic intake, commit/restore, new plan creation, model, watcher, index and every normal route remain absent. A completed recovery leaves projection pending for Phase 4's later rebuild instead of constructing domain repositories. Omitted/stale production authority retains the Phase 3 deny adapter and changes nothing.

Register write-confirmation and recovery-export IPC against either runtime's returned origin/readers/ports. `ElectronPrivilegedActions` is a strict pair of main-private authority interfaces, not raw gates/exporters. Its normal factory independently rejects unless both supplied `appIsPackaged` and `launchMode:'normal-packaged'` are valid, and the caller evaluates it only under that same condition; its sentinel factory requires the already validated temporary sentinel/userData fixture and never receives the formal roots; every other mode receives deny authorities whose approval/export methods throw the stable code before a store write, `createPrivateLease()`, native destination construction, or dialog. The registration functions accept only those authority interfaces, so a development-read-only branch cannot accidentally receive `ruleCompatibilityGate`, `started.mainRecoveryExporterPort`, or `createNativeRecoveryExportPort()` directly. Unit tests require `registerWriteConfirmationIpc` to receive an explicit provider, prove the handler provider and policy factory share the exact evidence-authority instance, and independently drift each root, profile and rule before the dialog and while the dialog is open; every case must stop before a token, with the pre-dialog cases also proving `showMessageBox` call count zero. Development-read-only and every diagnostic mode invoke rule approval and export IPC once and prove approval persistence, exporter lease, native port and dialog call counts remain zero. The positive normal-packaged case proves exactly two provider derivations, one summary/material equality check after response `1`, and one issuer call with the post-dialog scope. Add integration and packaged tests that assign both startup results to the exact imported `StartedMutationRuntime`, corrupt and separately delete SQLite after a manifest-backed user-confirmed intake, extraction and knowledge-edit incident; for each available continue, rollback and resolve path, assert the native grant's plan/snapshot/original-intent/capsule/binding scope, one-use replay rejection, helper execution, projection-pending result and later rebuild. Race two recovery requests, mutate the snapshot between the service segment and coordinator acquisition, and hold a barrier across that handoff; require one legal result, a fresh repeated check, no nested-lock deadlock and no second mutex. Also export one intact `manual-only` and one complete retained batch, while `partial-journal`/`missing-blob` stays non-exportable. Prove `ManifestConfirmedIntakeBindingAuthority` rejects active/mismatched history, both lifecycle ports reject after `close()`, corrupt/deleted SQLite keeps the healthy/startServer callback count at zero, and no ordinary repository/route/runtime constructor runs. The five App-facing human mutation entry points still exist overall, but recovery-only exposes only continue/rollback/resolve; confirmed intake and commit/restore stay unavailable until a healthy database returns.

`createAtomicFileHelper()` is invoked exactly once per App process before choosing healthy normal versus recovery-only server composition and receives the same held `VerifiedNativeHelperExecutable` capability as `createNativeReadVaultPort()`; it is Phase 1's full private/mutation port, not the read-only port and not a pathname re-open. Every registration above receives the same `BrowserWindow` and calls Task 3's exact main-frame IPC assertion before reading request data. Write confirmation is enabled only for the trusted `normal-packaged` App, including its recovery-only server branch; rule approval is enabled for `normal-packaged` and the branded sentinel fixture; recovery export is enabled for normal packaged recovery and the branded sentinel fixture. Other launch modes register explicit deny handlers and can never issue a grant, persist an approval, or open a save dialog.

`startServer()` opens the repository first, creates one `ConfirmedIntakeBindingAuthority` over that same `IntakeRepository` instance plus the existing recovery-source reader, and invokes the Electron-owned `mutationTargetPolicyFactory` exactly once before registering mutation routes or starting intake. This narrow late-construction seam is the only reason the factory exists: it gives production `authorize()`/`assertCurrent()` a live, server-owned active-binding check without exposing the repository or moving the production constructor into the server. An omitted factory yields read-only routes and no watcher execution; there is no permissive default. It passes the resulting policy to the one coordinator. The server never imports `production-mutation-target-policy.ts`, Electron, the grant consumer or the grant issuer, and no server path can replace the factory after startup. On shutdown, main first disables intake, then clears issuer grants, closes server/coordinator, closes every held native/private-storage descriptor, and clears the session ID.

- [ ] **Step 7: Put authorize/assertCurrent around every coordinator mutation**

Replace caller-created authorization input with coordinator-owned authorization while preserving Phase 1's separate ordinary and recovery entries:

```ts
execute(input: {
  readonly plan: WritePlan;
  readonly projectionCapsule: DomainProjectionCapsule;
  readonly bytesBySha256: ReadonlyMap<string, Uint8Array>;
  readonly nativeGrantToken?: string;
}): Promise<void>;
executeRecovery(input: {
  readonly batchId: string;
  readonly snapshotSha256: string;
  readonly intent: Extract<WriteIntent, { readonly kind: 'kernel_recovery' }>;
  readonly recoveryPlan: WritePlan;
  readonly bytesBySha256: ReadonlyMap<string, Uint8Array>;
  readonly nativeGrantToken?: string;
  readonly resolutionSha256?: string;
}): Promise<void>;
```

Under the existing single mutex, `WriteCoordinator` builds the complete `MutationPolicyInput` from its injected target/appData/profile plus the immutable plan and strictly validated intent-owned projection capsule. Ordinary `execute()` derives `operation:'execute'`; `executeRecovery()` requires `recoveryPlan.intent === input.intent`, reloads the original projection capsule from the original manifest rather than accepting one from the caller, derives `continue`/`rollback`/`resolve` from `intent.direction`, and binds `snapshotSha256` plus the server-derived resolution-selection hash when applicable. Both call `policy.authorize()` before manifest preparation, `policy.assertCurrent()` with the same full input before manifest preparation and immediately before each helper mutation, and `policy.release()` in `finally`. Recovery authorization reloads the original immutable manifest, validates new contiguous recovery ordinals and every `recoveryOfOrdinal`, confirms the exact suffix/reverse/known-version resolution, and binds the original intent kind and capsule hash. The route/body cannot supply root, appData, recovery root, profile, policy ID, original intent, projection capsule, steps, selection bytes, or an opaque authorization.

`IntakeService.applyAutomatic()` calls ordinary execute with no token only for an authoritative persisted plan/capsule whose matching mode is `automatic`. Phase 2's classification confirmation persists the user's choices, sets and hash-binds `authorizationMode:'user_confirmed'` in the intake classification/capsule, and in one immediate transaction moves `needs_confirmation` version `N` to `ready` version `N + 1` while inserting one immutable plan/capsule and unique `active` binding. The plan intent, capsule job, binding `expectedJobVersion`, returned preview and apply expectation all carry `N + 1`; the pre-transition `N` is never an executable preview. It does not execute the plan. Use the single strict `POST /api/v1/intake-jobs/:id/apply-confirmed`; its body is exactly `{ bindingId, planId, expectedPlanSha256, expectedJobVersion, expectedBindingVersion, nativeGrantToken }`, with idempotency/session/CSRF outside that object and `nativeGrantToken` required. `POST /api/v1/write-batches` resolves the immutable plan before token handling and rejects both automatic and user-confirmed `intent.kind === 'intake'` with `INTAKE_EXECUTION_ROUTE_REQUIRED` before coordinator/manifest/helper effects; automatic intake has no public execute route. The generic `POST /api/v1/write-plans/:id/cancel` and `/supersede` routes likewise resolve the plan then reject intake with `INTAKE_PLAN_LIFECYCLE_ROUTE_REQUIRED` before idempotency consumption or any plan/binding/job/recovery effect; only `/api/v1/intake-jobs/:id/confirmed-plan/cancel` and `/supersede` own intake lifecycle CAS. `IntakeService.applyConfirmed()` may do an early rejection read, but it does not hold or nest the mutation mutex around `WriteCoordinator.execute()`. It passes the exact binding expectation and token once to ordinary execute; the coordinator acquires the one process-wide `WorkflowMutationMutex`, then its intake handler and production policy reload the job, immutable plan, binding and capsule from the same repository. Apply-entry, `authorize()` and the pre-manifest `assertCurrent()` require exactly one matching `active` binding plus the `ready` job at its bound `N + 1` version and matching `user_confirmed` mode/ID/version/hash. After the manifest hook advances that same job to its deterministic `applying` successor, every later `assertCurrent()` requires the same active binding, plan/capsule tuple and operation and accepts only that applying successor; it never accepts another job version or binding state. The final verified `active -> consumed` CAS, cancellation, stale invalidation and supersession use that same mutex, so no binding transition can race the authoritative coordinator checks. A linked batch that is only `planned` and has no manifest/journal/staging/helper evidence may still be cancelled or atomically superseded under that mutex; state `prepared` or later, or any such durable/native evidence, forbids it. The request cannot supply or change authorization mode, classification, capsule, steps, paths or bytes. A missing token, an automatic plan, a mismatched/stale/non-active preview or binding, or a token for another plan fails before coordinator/manifest/helper effects. There is no parallel `/apply` production route, generic write-batch bypass or generic intake lifecycle bypass.

The five human client mutations—apply confirmed intake, commit (including draft/restore), continue, rollback, and resolve—require a non-optional `nativeGrantToken`; `intake-jobs.ts`, `write-batches.ts`, and `recovery.ts` reject its absence before effects and pass it once. `RecoveryService` calls only `executeRecovery()` and requires the exact fresh `snapshotSha256`. Before resolve confirmation, `createRecoveryResolutionPlan()` requires Phase 4's exhaustive, duplicate-free `RecoveryResolutionRequest.selections`, with exactly one opaque discriminated choice for every server-advertised affected entry. The server resolves `affectedEntryId`/`choiceId` against the same fresh catalogue, derives paths, versions, ordinals, canonical selection hash, and the immutable resolution plan itself, and rejects missing/extra/duplicate/stale entries. The selection request accepts no path, content hash, version object, step ordinal, bytes, free text, or `force`. Reverse history restore plans use `knowledge_edit.mode:'restore'` and ordinary execute. Delete the old recovery `confirmation:boolean`; a boolean is not authority. Explicit cancel and projection-stale invalidation append history by changing only the exact active row to `cancelled` with a reason; supersession performs that CAS plus insertion of a server-derived replacement binding/plan/capsule at `previous bindingVersion + 1` in one transaction. Neither operation may reactivate or overwrite history. Native-dialog cancel changes no binding and exact confirm replay returns the same active preview. Intake rollback and SQLite-loss reconstruction copy `authorizationMode` only from the original validated capsule: `user_confirmed` remains `user_confirmed` in the restored `ready` job, the original manifest-backed binding remains historical `consumed`, and a later explicit retry asks the service to append a new server-derived binding at one greater than the maximum durable history version before obtaining a new grant. Recovery never downgrades it to automatic. An active preview with no manifest is intentionally invalidated by SQLite-loss rebuild rather than fabricated; after relaunch all old grants are gone, and only a fresh server preview may become executable.

```ts
applyConfirmedIntake(
  id: string,
  body: Omit<ConfirmedIntakeApplyInput, 'nativeGrantToken'> & {
    readonly nativeGrantToken: string;
  },
  idempotencyKey: string
): Promise<ApiClientResult<IntakeJobDetail>>;
commitWritePlan(
  id: string, expectedPlanSha256: string, expectedBindingVersion: number,
  idempotencyKey: string, nativeGrantToken: string
): Promise<ApiClientResult<WriteBatchSnapshot>>;
continueRecovery(
  id: string, expectedVersion: number, snapshotSha256: string,
  idempotencyKey: string, nativeGrantToken: string
): Promise<ApiClientResult<WriteBatchSnapshot>>;
rollbackRecovery(
  id: string, expectedVersion: number, snapshotSha256: string,
  idempotencyKey: string, nativeGrantToken: string
): Promise<ApiClientResult<WriteBatchSnapshot>>;
createRecoveryResolutionPlan(
  id: string, input: RecoveryResolutionRequest, idempotencyKey: string
): Promise<ApiClientResult<WritePlanPreview>>;
resolveRecovery(
  id: string, planId: string, expectedPlanSha256: string, expectedVersion: number,
  snapshotSha256: string, idempotencyKey: string, nativeGrantToken: string
): Promise<ApiClientResult<WriteBatchSnapshot>>;
```

The manifest is persisted once before the first mutation and is never rewritten. Its Phase 6 pre-mutation fields are limited to the operation ID, full immutable plan/plan hash, strict projection capsule/capsule hash, rule hash, root identity hash, ordered steps, expected before/after blob metadata, and deterministic staging/retained reservations. The existing hash-chained `authorization` journal record—not the manifest—stores the Phase 1 fields exactly: `authorizationKind:'native-grant'|'automatic-intake'`, required `policyId` (`electron-production-v1` for production human/recovery authority), operation, required current `intentKind`, plan ID/hash, `canonicalScopeSha256`, distinct `nativeGrantScopeSha256`, three root-identity hashes, profile key, rule hash, `productionEvidenceSha256`, `authorizationSha256`, manifest/projection-capsule hashes, original intent kind, recovery snapshot hash, resolution hash, and `confirmedAt`. The current intent is copied from the branded authorization and must equal `manifest.plan.intent.kind`; missing or drifted values fail before evidence-hash recomputation. A native grant requires a 64-hex native scope hash plus ISO confirmation time; automatic intake requires both fields to be `null`; both production kinds require a reconstructible production evidence hash. The coordinator copies the branded policy authorization's redacted projection verbatim, adds only the just-persisted manifest hash, and never treats the manifest hash as part of the precomputed authorization hash. Only intake with hash-bound `authorizationMode:'automatic'` may record `automatic-intake`, while `user_confirmed` intake must record `native-grant` with the production policy ID. It never adds a parallel authority field or stores a token, Electron session ID, root path, raw selection, or caller-supplied mode. Verified disk/finalizer/core outcomes live only in the existing typed `terminal` journal record after final verification, including its required projection-capsule hash. Any changed manifest bytes, result-like manifest field, duplicate/divergent authorization, missing/drifted intent kind, invalid kind/nullability combination, evidence/hash recomputation mismatch, manifest/capsule cross-binding mismatch, terminal-before-result, or SQLite state without a matching terminal is corrupt/recovery-required.

All `recovery_continue`, `recovery_rollback`, and `manual_resolve` incident evidence remains through the 30-day boundary and, after that boundary, until the user gives Phase 5's explicit cleanup approval. Export is optional; an active export lease holds cleanup, but cleanup approval does not require a prior export. After a verified resolve, set the original batch state to `manually-resolved`, not `committed` or `rolled-back`; dispatch the Phase 1 intent-specific conflict projection from the original capsule: intake → `needs_confirmation`, extraction → existing `reviewing`, knowledge edit → draft `conflict`, each with `MANUAL_RECOVERY_CONFLICT`. Preserve the original manifest, journal, before/after/retained evidence, resolution plan, and resolution journal under that same rule. A keep-current resolution may have no helper step but still needs a hashed resolution plan/journal and one-use native grant. A selected create reversal uses only `retire-created-file` to an exclusive appData retained target and never unlink.

- [ ] **Step 8: Implement the native dialog for confirmed intake, commit, restore, continue, rollback, and resolve**

The single canonical bridge method is `confirmWriteOperation(request): Promise<{ status:'confirmed'; nativeGrantToken:string } | { status:'cancelled' }>` where `request` is strictly `{ planId, expectedPlanSha256, operation, recoverySnapshotSha256? }`; it accepts no renderer-supplied authorization mode, resolution-selection hash, path, version object, ordinal, bytes, label, count, root/profile/rule evidence, or summary. For user-confirmed intake, `planId` identifies only Phase 2's persisted immutable plan whose atomically bound strict capsule has `authorizationMode:'user_confirmed'`; an automatic, unbound, or divergent capsule is rejected before summary/dialog/grant access. For resolve, `planId` identifies only the server-created immutable resolution plan returned after exhaustive `RecoveryResolutionRequest.selections`. `write-confirmation.ts` first calls `assertTrustedMainFrameIpc`, reloads that plan/capsule or recovery catalogue through the in-process read interface, revalidates the job/plan/capsule version or persisted exhaustive recovery selections against fresh state, rejects stale values, derives any selection hash itself, then calls the injected `NativeConfirmationScopeProvider.deriveCurrent({ material, operation })`. That pre-dialog call independently binds and verifies the three live root identities, current profile, approved rule and canonical scope while the summary reader remains responsible only for plan-domain state. A failure returns before `showMessageBox` and before token issuance.

Set one shared `MAX_NATIVE_CONFIRMATION_ACTIONS = 32`, `MAX_NATIVE_CONFIRMATION_PATH_UTF8 = 768`, and `MAX_NATIVE_CONFIRMATION_DETAIL_UTF8 = 24_000`. Plan creation rejects a supervised plan above 32 actions with `SUPERVISED_PLAN_TOO_LARGE`; the user must split it into smaller batches. Every target path must be canonical NFC vault-relative text with no control/newline/bidi-override character and fit the byte limit. The native summary is an ordered array with exactly one item per step, plus one item per zero-step keep-current selection. It renders the complete relative path for create/replace/mkdir/rmdir/retire, both complete `from → to` paths for file/package moves, and the complete affected path for keep-current. If any item, count, path, or final UTF-8 detail bound disagrees with the immutable plan/recovery selection, fail before showing a dialog.

```ts
if (summary.intentKind === 'intake' && summary.authorizationMode !== 'user_confirmed') {
  throw new Error('AUTOMATIC_INTAKE_CONFIRMATION_FORBIDDEN');
}
const label = {
  execute: summary.intentKind === 'intake'
    ? '入馆'
    : summary.intentKind === 'knowledge_edit' && summary.mode === 'restore'
      ? '恢复历史版本'
      : '写入正式大脑',
  continue: '继续未完成写入',
  rollback: '回滚未完成写入',
  resolve: '人工裁决当前版本'
}[request.operation];
const result = await dialog.showMessageBox(window, {
  type: 'warning', buttons: ['取消', `确认${label}`], defaultId: 0, cancelId: 0, noLink: true,
  title: `确认${label}`,
  message: `即将执行 ${summary.actions.length} 项正式大脑操作`,
  detail: formatNativeMutationSummary(summary)
});
```

The server-derived summary exhaustively switches over every current `WriteStep.kind` and move `entryKind`, rejects unknown kinds, and returns the ordered `actions` plus `creates`, `replaces`, `movesFiles`, `movesPackages`, `mkdirs`, `rmdirCreatedEmpty`, `retireCreatedFiles`, `keepCurrent`, and `totalSteps`. Require the sum of step-backed counts to equal `totalSteps`, action order to equal immutable step order, and `actions.length === totalSteps + keepCurrent`; a keep-current resolve has `totalSteps:0, keepCurrent:1`. `formatNativeMutationSummary()` prints the full plan hash, every numbered action label, and every complete relative target; it never truncates with an ellipsis or hides paths behind counts. `rmdir-created-empty` uses `移除已创建空目录：<path>` and `retire-created-file` uses `将已创建文件移出正式大脑并保留到私有恢复区：<path>`. Unit-test ordinary create/replace, file/package moves, mkdir, rmdir, retire, keep-current, mixed recovery, unknown kind, count/order/path mismatch, control-character path, bound overflow, and two same-count plans with different targets; unknown/mismatched/oversized summaries must fail before showing the dialog or issuing a grant.

Update every existing renderer owner of a human write. `IntakeConfirmation`, `WriteConfirmationPage`, `KnowledgeEditorPage` through `EditDiffConfirmation`, the restore action owned by `OperationsPage`, and `RecoveryDetailPage` must first render the immutable server preview, then call `confirmWriteOperation`, and only for `{ status:'confirmed' }` call the matching HTTP mutation exactly once with that returned token. Draft save and restore both use `commitWritePlan`; neither can call it from navigation, keyboard shortcuts or a preview click. Each owner keeps the token only in the local async stack, never React/global state, URL, storage or telemetry, and clears its reference in `finally` on success, native cancel, API rejection, transport failure, stale-plan rejection and unmount/abort. Native cancel performs no HTTP mutation and preserves the same still-current preview where its lifecycle permits retry.

Only response `1` can issue a token. After that response and before `grantIssuer.issue`, the handler reloads `ServerMutationSummaryMaterial` a second time, requires its canonical material hash and displayed action summary to equal the pre-dialog values, and calls the same injected `scopeProvider.deriveCurrent(...)` again. It requires the returned complete scope hash to equal the pre-dialog scope; any plan/binding/snapshot/selection/root/profile/rule/canonical-scope drift fails without issuing. It then calls `grantIssuer.issue(postDialogScope)` exactly once and returns `{ status:'confirmed', nativeGrantToken }`; cancel returns only `{ status:'cancelled' }` and never performs the second derivation. For user-confirmed intake, the second summary reload requires the unique `active` binding's exact binding ID/version, plan ID/hash, capsule hash, `user_confirmed` mode and current `ready` job version. The derived scope uses that server-reloaded intake plan ID/hash, strict capsule hash whose payload already binds `authorizationMode:'user_confirmed'` and the post-transition `expectedJobVersion`, current rule hash, and three root identities; it adds no parallel mode/version field. If the binding is cancelled, stale-invalidated, superseded, consumed or replaced while the dialog is open, fail without issuing a token. A transition after issuance is caught by apply/`authorize()`/`assertCurrent()` and the old token cannot authorize the replacement. For continue/rollback/resolve, it uses the server-reloaded recovery/resolution plan ID/hash, original intent kind/capsule, three root identities, and snapshot hash; resolve also binds the exact server-derived selection hash/current versions. Preload exposes one typed `confirmWriteOperation()` method and no intake-specific or second recovery-confirm channel. UI requests it only after immutable intake/diff/recovery details and the exhaustive action summary are viewed and current. `src/client/api/client.ts` makes the token required for `applyConfirmedIntake()` and every human commit/restore/continue/rollback/resolve call.

For every operation, `derivedScope` also includes the server-recomputed canonical step-scope hash, active production `profileKey`, and current approved `ruleBundleSha256`. The native summary reader and policy derive these independently from the same held root/profile/rule capabilities; none can be supplied by the renderer request.

`QueuePage` and `IntakeConfirmation` never apply a user-confirmed classification immediately. After the server persists the choices, they render the returned immutable plan preview—including the complete ordered paths/actions, binding ID/version, plan hash and authoritative post-transition `expectedJobVersion = N + 1`—then call the same `confirmWriteOperation({ planId, expectedPlanSha256, operation:'execute' })`. On confirmation they call Phase 2's existing `applyConfirmedIntake()` exactly once with that binding ID, plan ID/hash, expected job/binding versions, the returned token, and a separate idempotency key; token state is cleared in `finally` on success, cancellation, transport error, server error, or stale response. They never send `authorizationMode`, classification, capsule, steps, paths, or bytes, never retry/reuse/log/persist/copy a token, and never request a dialog or call `applyConfirmedIntake()` for automatic intake. Native-dialog cancel leaves the binding active and exact preview replayable; a stale/cancelled/superseded/consumed binding forces a fresh server preview and a new native confirmation.

For `manual-only`, `RecoveryDetailPage` shows every server-advertised affected entry and its validated current/before/after/retained choices with display-only hash prefixes, explains that resolve never marks the original batch successful, and blocks plan creation until exactly one option is chosen for every entry. The renderer posts one exhaustive Phase 4 `RecoveryResolutionChoiceInput[]`: each element has opaque `affectedEntryId` plus `action:'keep_current'|'keep_current_topology'`, or opaque `affectedEntryId` plus `action:'select_version'|'select_absent_before_create'` and opaque `choiceId`. The request also carries only the batch ID, fresh snapshot, and acknowledgement; it contains no path/hash/version/ordinal. The server returns the immutable resolution-plan preview; only then may the UI request native confirmation for that plan and make the token-required `resolveRecovery()` call. There is no textarea, file upload, raw bytes, force-overwrite, or “mark committed” control.

Implement `recovery-export.ts` as a separate single-purpose IPC with the canonical bridge signature `window.xiaozhaoDesktop.exportRecoveryBundle({ batchId, snapshotSha256 }): Promise<{ status:'saved'; bundleSha256:string } | { status:'cancelled' }>`. Main first calls `assertTrustedMainFrameIpc`, then calls only Phase 4's injected `started.mainRecoveryExporterPort.createPrivateLease(batchId, snapshotSha256)`; it never reads a recovery batch through `PrivateRecoveryStore` and never materializes bundle bytes under appData. `createPrivateLease()` atomically acquires Phase 4's shared server-internal `RecoveryEvidenceLeaseCoordinator` export lease before its first manifest/journal/blob validation, rescans the exact batch through Phase 4's authoritative service, requires the fresh snapshot hash, and returns only the opaque main-process-private handle defined by Phase 4—not a filesystem path, descriptor, stream, or lease object. Main never accepts an operation ID, manifest hash, path, filename, or bytes from the renderer. While that private lease remains held, it opens `dialog.showSaveDialog` with a bounded default name derived only from the strictly parsed batch ID. Cancel returns `{ status:'cancelled' }`, performs no filesystem write, and reaches the same `finally` release path.

```ts
const privateLeaseHandle = await exporter.createPrivateLease(
  request.batchId,
  request.snapshotSha256
);
let destination: HeldExclusiveRecoveryDestination | undefined;
try {
  const selected = await showRecoverySaveDialog(
    window,
    recoveryExportDefaultName(request.batchId)
  );
  if (selected === undefined) return { status: 'cancelled' } as const;
  destination = await destinationPort.openExclusive({ selected, mode: 0o600 });
  const verified = await exporter.streamVerifiedBundle(
    privateLeaseHandle,
    destination.writable
  );
  const saved = await destination.seal({ expectedSha256: verified.bundleSha256 });
  if (saved.bundleSha256 !== verified.bundleSha256) {
    throw new Error('RECOVERY_EXPORT_DESTINATION_HASH_MISMATCH');
  }
  return { status: 'saved', bundleSha256: saved.bundleSha256 } as const;
} finally {
  try {
    await destination?.close();
  } finally {
    await exporter.releasePrivateLease(privateLeaseHandle);
  }
}
```

`HeldExclusiveRecoveryDestination` is a main-private native-helper session. Its `writable` streams only into the already-open user-selected exclusive `0600` destination descriptor; after Phase 4 has ended and awaited that writable exactly once, `seal()` requires EOF and only fsyncs, rereads and hash-verifies the same held descriptor and fsyncs the held parent before returning identity/length/hash. It never ends input a second time. `close()` is idempotent and never unlinks or overwrites by pathname. It is never a pathname or shared/renderer value. `streamVerifiedBundle()` is Phase 4's exact method: it repeats authoritative batch validation, writes deterministic bounded gzip bytes into and ends/awaits that caller-owned `NodeJS.WritableStream`, and returns the computed bundle hash without releasing the export lease. The following `destination.seal({ expectedSha256 })` is the only destination durability/hash boundary. A stream failure may leave only the newly created user-selected partial file, never an appData copy; source evidence remains intact and the App reports the incomplete destination without deleting it. The mandatory `releasePrivateLease()` call remains in `finally`, is idempotent for an already-invalidated handle, and releases the underlying coordinator guard exactly once. Timeout or shutdown first aborts and awaits the active dialog/stream/native destination operation, closes the destination session, and only then reaches that release; no background expiry may free the coordinator guard while the destination is active. The native seal hash must equal `verified.bundleSha256` before returning success.

Phase 4 export and Phase 5 user-facing cleanup/payload retirement share the one server-internal per-batch `RecoveryEvidenceLeaseCoordinator`. Export holds its exclusive `export` lease continuously from before the first batch validation through the dialog, direct destination streaming, native destination verification, and every success/failure/cancel `finally`. Retirement must acquire the coordinator's exclusive `cleanup` lease before its first eligibility rescan and hold it through the identity-bound held-inode truncations plus durable completion. If retirement cannot acquire because export is active, it returns a hold without promoting a control ledger, projecting `retiring`, or moving evidence; if export cannot acquire because retirement is active, `createPrivateLease()` fails before batch validation or dialog. Before the first move, retirement promotes its immutable header/inventory plus initial append-only chain under the disjoint private `recovery-retirement-control` root; that ledger, not SQLite, drives every resume. Retirement never unlinks a file or directory and leaves both the Phase 5 zero-byte audit tree and control ledger. Neither side performs a check-then-act lease query, and no lease ID, private handle, descriptor, state, or retry primitive crosses renderer, HTTP, logs, or public evidence.

On confirmation, `native-recovery-export-port.ts` splits the selected absolute path into an existing parent plus final basename, rejects an invalid/control/hidden basename, and uses the same already verified helper executable to open the parent from `/` component-by-component with `O_DIRECTORY|O_NOFOLLOW`. It captures parent dev/ino, proves the normalized no-symlink parent/final path is outside the current formal vault and appData in both ancestor directions, then encodes that exact parent identity; a save inside/above either protected root is forbidden. Node never opens the selected destination pathname. Extend the native helper with a long-lived private command `export-stream-excl <bound-parent> <basename> <maximum-length>`. Before accepting stdin it reopens and matches the bound destination parent, holds that parent fd, and creates only the final basename with `openat(O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW, 0600)`. It consumes one bounded framed stream directly from stdin, computes SHA-256 while writing, fsyncs and rereads the held destination descriptor, requires regular-file mode `0600`, size and SHA-256, fsyncs the held parent, and returns only the hash/identity after EOF. Parent replacement before helper open fails identity validation; replacement after open cannot redirect the held parent. An existing file, symlink, directory, or special final entry fails `EEXIST` without modification. A write/crash after exclusive creation may leave only that newly created, never-successfully-reported destination; source evidence remains intact, no appData bundle copy exists, and the App never deletes or overwrites the destination by pathname. `AtomicFileHelper`'s server mutation interface exposes no export method; only the Electron-owned `NativeRecoveryExportPort` can encode/dispatch this command, and its unit dependency test rejects any server route/coordinator/preload import of the private dispatcher.

The canonical deterministic gzip stream (`mtime:0`) travels once from the authoritative exporter into the held exclusive destination; it is never buffered as a complete appData file. Never send before/after/retained bytes or the selected path/filename through renderer/HTTP; never overwrite, append, follow a link, or delete source evidence. Logs record only the bundle hash and one allowlisted stable result code; they contain no operation ID or other source-correlating identifier. The bundle is a user-chosen private `0600` export, not claimed to be encrypted.

- [ ] **Step 9: Prove HTTP, environment, test, CLI, and model paths cannot mint or bypass**

In `production-mutation-authority.test.ts`, construct the embedded server over temporary sentinel-marked roots but inject `ProductionMutationTargetPolicy` with test-only root/profile and one-use grant issuer/consumer adapters; do not substitute `SentinelTestMutationPolicy` for this production-authority contract. Assert fake or missing tokens return `403/SUPERVISED_CONFIRMATION_REQUIRED` for apply-confirmed-intake/commit/restore/continue/rollback/resolve before manifest/helper calls. An automatic intake request carrying any token fails before effects; one exact `user_confirmed` intake grant succeeds once, records `authorizationKind:'native-grant'`, and replay fails. In `api-client.test.tsx`, prove all five human client methods covering confirmed intake, commit/restore, continue, rollback, and resolve require `nativeGrantToken`, each sends it once, and caller `finally` cleanup runs after success and failure. Under that injected production policy, assert only `authorizationMode:'automatic'` intake succeeds with its exact persisted plan/capsule and no token; it cannot reuse a production human scope, and a confirmed plan cannot inherit automatic authority. Direct coordinator invocation without a token for any human intent fails identically. Cover a substituted/malformed capsule, appData or recovery-root inode replacement, changed intake authorization mode/job version, pre-transition `N` used where the ready `N+1` is required, wrong binding ID/version, a non-unique or non-active binding, and a barrier after token issue followed independently by cancellation, stale invalidation, atomic supersession, consumption and replacement; every old token must fail at the authoritative apply/`assertCurrent()` boundary before manifest/helper effects. Also cover new contiguous recovery ordinals, wrong/missing/duplicate `recoveryOfOrdinal`, resolve selection/current hash drift, missing/extra/duplicate/stale opaque per-entry selections, any path/hash/version/ordinal/bytes/force field, and `retire-created-file` path/hash/dev/ino/appData-retained mismatch before helper invocation. A valid intake rollback and SQLite replay preserve `authorizationMode:'user_confirmed'`, reconstruct the old binding as consumed history, and cannot apply again until an explicit retry creates the next server-owned binding/preview and obtains a fresh native grant. A valid resolve ends `manually-resolved`, dispatches intake → `needs_confirmation`, extraction → `reviewing`, or knowledge edit → draft `conflict` with `MANUAL_RECOVERY_CONFLICT`, and preserves all incident evidence.

In the existing `formal-ingestion-api.test.ts`, prove commit and restore plus recovery continue/rollback/resolve reject a missing, fake, mismatched, or replayed native grant before coordinator/manifest/helper effects, while the exact one-use grant reaches the existing Phase 4 route once. Use real persisted automatic and user-confirmed intake plans against `POST /api/v1/write-batches`, including a valid current intake grant, and require `INTAKE_EXECUTION_ROUTE_REQUIRED`, an unconsumed grant, and zero coordinator/manifest/helper effects for both. Send both intake modes with otherwise valid expected hash/version and idempotency to the generic write-plan cancel and supersede routes; require `INTAKE_PLAN_LIFECYCLE_ROUTE_REQUIRED`, unchanged job/plan/binding state and zero idempotency/recovery effects, while the two job-bound confirmed-plan routes remain the sole lifecycle paths. Keep the Phase 4 plan/batch/recovery response schemas unchanged apart from their required grant input; do not create a second generic write API test file.

Update every prior coordinator fixture affected by the Phase 6 entry-signature change: `write-kernel`, crash worker/recovery, intake service, formal-ingestion coordinator/crash/recovery, and knowledge-edit coordinator/recovery. Delete caller-created or serialized `authorization` inputs such as `testAuthorization`; construct the coordinator with the existing `SentinelTestMutationPolicy` composition seam and let `execute()`/`executeRecovery()` call `policy.authorize()` internally. Keep the internal ordinary and recovery coordinator token fields optional transport seams so sentinel composition can typecheck; the production policy, HTTP schemas and five human client methods—not the coordinator TypeScript property—enforce the required grant. Prove the same no-token recovery command succeeds only with `SentinelTestMutationPolicy` inside its guarded temporary vault and fails under `ProductionMutationTargetPolicy` before manifest/helper effects. The crash worker receives only the policy fixture inputs, never a branded authorization object.

In `native-write-confirmation.spec.ts`, launch only through the packaged sentinel fixture with its unchanged `NODE_ENV=test`, temporary sentinel root, and temporary userData. Assert the confirm IPC returns `FORMAL_CONFIRMATION_DISABLED_IN_TEST` when Playwright invokes the exposed method or supplies renderer/HTTP fields named `NODE_ENV`, `WRITE_ENABLED`, `VAULT_REAL_ROOT`, `authorizationMode`, or formal-root authority; renderer values are data, never process authority. Unit tests invoke the handler from a second/fake WebContents, same-origin child frame, stale main frame, and foreign frame and require rejection before summary/dialog/grant access. With injected main-only fixtures, assert a persisted plan with its exact bound `user_confirmed` intake capsule produces label `确认入馆` and every complete ordered action, while an `automatic`, unbound, or changed-mode capsule is rejected before the dialog/grant. Do not relaunch this fixture with production/development mode and do not automate a positive native confirmation click. The Task 3 runtime unit test owns the proof that neither `NODE_ENV=production` nor a diagnostic CLI flag can promote a source build. Unit tests may inject a fake dialog and temporary root to test response `1`; no automated process ever receives a production formal-root policy.

In `intake-api.test.ts`, prove `/apply-confirmed` is the sole confirmed-execution route and strictly rejects a missing/fake/replayed token, unknown `authorizationMode`, missing/wrong `bindingId`, stale job or binding version, wrong plan ID/hash, pre-transition job version `N`, non-active binding, and automatic plan before any coordinator, manifest or helper effect; `/apply` returns 404. POST both an automatic plan and the exact active user-confirmed plan plus valid grant to `/api/v1/write-batches`; both return `INTAKE_EXECUTION_ROUTE_REQUIRED` with zero token consumption/coordinator/manifest/helper effects. POST both modes to the generic write-plan cancel/supersede routes and require `INTAKE_PLAN_LIFECYCLE_ROUTE_REQUIRED` plus zero lifecycle/idempotency effects; only the job-bound confirmed-plan routes can change an intake binding. The one exact `/apply-confirmed` body `{ bindingId, planId, expectedPlanSha256, expectedJobVersion:N+1, expectedBindingVersion, nativeGrantToken }` succeeds once. Barrier tests mutate the binding after grant issue to cancelled/stale/superseded/consumed and require rejection, then prove only the next server-generated active binding/version plus a new grant succeeds. Rollback/restart retains `user_confirmed` and historical consumed binding metadata. In `intake-queue.test.tsx`, require the immutable preview to render before `confirmWriteOperation`, verify its binding ID and `N+1` job version plus the native result are placed once into the existing `ConfirmedIntakeApplyInput` and sent once to `applyConfirmedIntake`, and prove token state is cleared in `finally` for success, cancellation, API rejection, and transport failure. Assert the renderer cannot set/downgrade mode, automatic intake opens no dialog, native-dialog cancel reuses the same active preview, and a stale/non-active binding cannot reuse a prior token. In `write-confirmation.test.tsx` and `recovery-ui.test.tsx`, prove ordinary commit and each continue/rollback/resolve owner renders its immutable preview, calls native confirmation first, performs the matching HTTP mutation exactly once only after confirmation, never places a token in state/storage/logs, and clears the local reference on success, cancel, API/transport/stale failure and unmount/abort. In `knowledge-editor.test.tsx` and `knowledge-editor-conflict.test.tsx`, prove both the editor save and Operations restore flows render the immutable diff, call the native confirmation first, pass its token exactly once to `commitWritePlan`, never commit through navigation/keyboard/preview, and clear the local token reference on success, cancel, API/transport/stale failure and abort.

In `recovery-export.spec.ts` and `recovery-export-helper.contract.test.ts`, use a validated temporary Phase 4 exporter and temporary save target; create no appData staging root. Call only `exportRecoveryBundle({ batchId, snapshotSha256 })`; prove a stale/wrong snapshot is rejected by `createPrivateLease()` before the save dialog, cancel writes nothing and returns `{ status:'cancelled' }`, and a valid export is `0600`, gzip-decodes to the exact canonical immutable manifest plus journal/blob hashes, and returns only `{ status:'saved', bundleSha256 }`. Reject a destination inside/above the vault or appData, either protected-root alias, an existing file/symlink/directory/special entry, wrong source identity, bad manifest/journal/blob, source change during `streamVerifiedBundle()`, wrong/child/stale IPC frame, and destination-parent replacement immediately before and after helper descriptor acquisition. Every failure preserves source evidence and never overwrites; a helper result cannot be redirected to the replacement parent, and appData contains no complete or partial bundle copy. In `recovery-retention-service.test.ts`, pause export after `createPrivateLease()` and before streaming, during the direct held-destination gzip stream, and during native seal/reread and prove cleanup cannot acquire its `cleanup` lease, promote a control ledger, project `retiring`, or move evidence; pause cleanup after its lease acquisition and prove export fails in `createPrivateLease()` before batch reads, dialog, or destination creation. At every Phase 5 control-promotion/move/intent/truncate/result/terminal/projection checkpoint, separately delete and corrupt SQLite, launch a fresh recovery-only runtime, and prove it finds the ledger even after the batch moved to `recovery-trash`, resumes only that authorized cursor, and rebuilds the independent no-FK `retiring`/`retired` projection. The terminal case starts with every original manifest/journal byte already zeroed and must not fabricate `write_plans` or `write_batches`. A DB-only projection, invalid/missing/duplicate ledger, or moved batch without a ledger is a non-mutating hold. Success, lease validation error, dialog cancel, stream error, destination seal error, destination error, timeout, and shutdown each release the coordinator guard exactly once through the Phase 4 private-handle lifecycle, after which the other operation must start again from a fresh snapshot/eligibility check. Timeout/shutdown tests hold `destination.seal()` at a barrier and prove cleanup remains blocked until the destination call is aborted and settled, the held destination closes, and `releasePrivateLease()` completes. Assert main calls only `createPrivateLease()`/`streamVerifiedBundle()`/`releasePrivateLease()`, the stream target is only `HeldExclusiveRecoveryDestination`, no complete bundle is written under appData, and no operation ID, manifest hash, before/after bytes, destination path, filename, lease ID, private handle, descriptor, or sink may enter through the renderer request or appear in renderer results, HTTP, logs, or public evidence. Production formal evidence is never used by this test.

After Task 7 wiring, update the packaged preload exact-surface assertion to:

```ts
expect(await page.evaluate(() => Object.keys(window.xiaozhaoDesktop).sort())).toEqual([
  'approveRuleCompatibility',
  'chooseVaultDirectory',
  'clearModelApiKey',
  'confirmWriteOperation',
  'exportRecoveryBundle',
  'getAppVersion',
  'getModelApiKeyStatus',
  'getModelEndpointSettings',
  'runProductionCapabilityBootstrap',
  'setModelApiKey',
  'setModelEndpointSettings'
]);
```

No generic IPC, plaintext-key getter, raw recovery reader, second recovery-confirm method, filesystem/process/environment method, or omitted Phase 0/3 method is allowed.

Run:

```bash
npm run test:native-contract
npm run test:unit -- tests/unit/supervised-confirmation.test.ts tests/unit/production-mutation-target-policy.test.ts tests/unit/write-confirmation.test.ts tests/unit/native-recovery-export-port.test.ts tests/unit/electron/ipc-authority.test.ts
npm run test:component -- tests/component/api-client.test.tsx tests/component/intake-queue.test.tsx tests/component/write-confirmation.test.tsx tests/component/recovery-ui.test.tsx tests/component/knowledge-editor.test.tsx tests/component/knowledge-editor-conflict.test.tsx
npm run test:integration -- tests/integration/production-mutation-authority.test.ts tests/integration/native-capability-gate.test.ts tests/integration/intake-api.test.ts tests/integration/formal-ingestion-api.test.ts tests/integration/recovery-retention-service.test.ts tests/integration/recovery-only-runtime.test.ts tests/integration/manual-recovery-resolution.test.ts
npm run test:integration -- tests/integration/write-kernel.test.ts tests/integration/write-recovery-crash.test.ts tests/integration/intake-service.test.ts tests/integration/formal-ingestion-coordinator.test.ts tests/integration/formal-ingestion-crash.test.ts tests/integration/formal-ingestion-recovery.test.ts tests/integration/knowledge-edit-coordinator.test.ts tests/integration/knowledge-edit-recovery.test.ts
npm run dist:mac
npm run test:electron -- tests/electron/packaged-security.spec.ts tests/electron/packaged-database-recovery.spec.ts tests/electron/native-write-confirmation.spec.ts tests/electron/rule-compatibility-approval.spec.ts tests/electron/recovery-export.spec.ts
```

Expected: PASS; only exact plan/capsule-bound `authorizationMode:'automatic'` intake can run without a dialog and it rejects any token; confirmed intake and all other human/recovery mutations require a matching one-use grant, manual export stays main-process/private, and automation cannot construct the production formal authority.

- [ ] **Step 10: Bind the post-write verifier to baseline, root, plan, journal, and rules**

Extend the recovery manifest schema only at pre-mutation construction with operation ID, `persistedAt`, full immutable plan/plan hash, strict intent-owned projection capsule and `projectionCapsuleSha256`, rule hash, root identity hash, ordered steps, before/after blob metadata, and deterministic staging/retained reservations. Once its exclusive write/fsync/reread succeeds, its bytes and hash are immutable forever. Do not add authorization, confirmation, result, terminal, core-state, or mutable timestamp fields to the manifest. Authorization/confirmation belongs to one strict hash-chained `authorization` journal entry containing the required `manifestSha256` and `projectionCapsuleSha256`; verified completion belongs to one strict hash-chained `terminal` entry after every step result, disk verification, and finalizer receipt and must echo the same capsule hash. Keep private bytes only under the held appData recovery boundary with files mode `0600`.

`verify-formal-write.ts` imports the read-only recovery parser/hash-chain validator, Task 4's `ReadOnlyPrivateRecoveryStore` facade, stable snapshot composer, and read-only `NativeReadVaultPort`; it imports no full `PrivateRecoveryStore`, mutation client/command, policy, writer, coordinator, route, Electron, or model module. It performs these checks in order:

```ts
if (process.env.WRITE_ENABLED !== 'false') fail('VERIFY_REQUIRES_WRITE_DISABLED');
const baseline = formalBaselineSchema.parse(await readBoundEvidenceFile(baselinePath));
assertExactPackagedHelperArgument(
  helperPath,
  releaseLayout(appVersion).helper,
  'VERIFY_HELPER_PATH_MISMATCH'
);
const verifiedHelperExecutable = await createVerifiedNativeHelperExecutable(helperPath);
const privateReadPort = await createPrivateRecoveryReadPort({
  executable: verifiedHelperExecutable,
  appDataRoot
});
const privateStore = await openReadOnlyPrivateRecoveryStore({
  appDataRoot,
  nativePort: privateReadPort
});
const batchGraph = await loadExactlyOneTerminalBatchGraphAfter(
  privateStore, baseline.capturedAt
);
const { manifest, manifestSha256, journal, authorization, terminal } =
  validateImmutableBatchGraph(batchGraph);
validateRecoveryPlanOrdinalsBindingsAndRetainedEvidence(batchGraph);
assertCanonicalPlanSha256(manifest.plan);
assertProjectionCapsule(manifest.plan.intent, manifest.domainProjectionCapsule);
assertEqual(
  manifest.domainProjectionCapsule.payloadSha256, manifest.projectionCapsuleSha256,
  'PROJECTION_CAPSULE_MISMATCH'
);
assertEqual(authorization.authorizationKind, 'native-grant', 'PRODUCTION_AUTHORITY_MISSING');
assertEqual(authorization.policyId, 'electron-production-v1', 'PRODUCTION_AUTHORITY_MISSING');
assertEqual(authorization.intentKind, manifest.plan.intent.kind, 'AUTHORIZATION_INTENT_MISMATCH');
assertOrdinaryExecuteAuthorization(authorization, manifest.plan);
assertEqual(authorization.manifestSha256, manifestSha256, 'AUTHORIZATION_MANIFEST_MISMATCH');
assertEqual(
  authorization.projectionCapsuleSha256, manifest.projectionCapsuleSha256,
  'AUTHORIZATION_CAPSULE_MISMATCH'
);
assertEqual(
  authorization.canonicalScopeSha256,
  canonicalMutationScopeSha256(manifest.plan, manifest.domainProjectionCapsule),
  'AUTHORIZATION_CANONICAL_SCOPE_MISMATCH'
);
assertEqual(authorization.planId, manifest.plan.id, 'AUTHORIZATION_PLAN_ID_MISMATCH');
const privateRoots = await privateStore.rootIdentities();
const currentProfile = await loadCurrentProductionProfileForVerification({
  privateStore, executable: verifiedHelperExecutable,
  formalRoot: baseline.vault, privateRoots
});
assertEqual(
  authorization.targetRootIdentitySha256,
  sha256RootIdentity(baseline.vault), 'AUTHORIZATION_TARGET_ROOT_MISMATCH'
);
assertEqual(
  authorization.appDataRootIdentitySha256,
  sha256RootIdentity(privateRoots.appDataRoot), 'AUTHORIZATION_APPDATA_ROOT_MISMATCH'
);
assertEqual(
  authorization.recoveryRootIdentitySha256,
  sha256RootIdentity(privateRoots.recoveryRoot), 'AUTHORIZATION_RECOVERY_ROOT_MISMATCH'
);
assertEqual(authorization.profileKey, currentProfile.profileKey, 'AUTHORIZATION_PROFILE_MISMATCH');
assertEqual(authorization.ruleBundleSha256, baseline.ruleBundleHash, 'AUTHORIZATION_RULE_MISMATCH');
assertEqual(
  authorization.productionEvidenceSha256,
  sha256Canonical(toProductionEvidenceInput(authorization)),
  'PRODUCTION_EVIDENCE_HASH_MISMATCH'
);
assertEqual(
  authorization.authorizationSha256,
  sha256Canonical(toAuthorizationHashInput(authorization)),
  'AUTHORIZATION_HASH_MISMATCH'
);
assertSha256(authorization.nativeGrantScopeSha256, 'NATIVE_GRANT_SCOPE_MISSING');
assertIsoTimestamp(authorization.confirmedAt, 'CONFIRMATION_EVIDENCE_MISSING');
assertCommittedTerminalGraph(terminal, batchGraph);
assertEqual(
  terminal.projectionCapsuleSha256, manifest.projectionCapsuleSha256,
  'TERMINAL_CAPSULE_MISMATCH'
);
assertTimeOrder(
  baseline.capturedAt, authorization.confirmedAt,
  manifest.persistedAt, authorization.recordedAt, terminal.completedAt
);
assertEqual(manifest.rootIdentitySha256, sha256RootIdentity(baseline.vault), 'MANIFEST_ROOT_MISMATCH');
assertEqual(manifest.ruleBundleSha256, baseline.ruleBundleHash, 'BASELINE_RULE_MISMATCH');
const nativeReadPort = await createNativeReadVaultPort({
  executable: verifiedHelperExecutable,
  vaultRoot
});
assertEqual(nativeReadPort.helperSha256, baseline.reader.helperSha256, 'BASELINE_READER_MISMATCH');
const current = await captureStableContentAwareVaultNamespace(nativeReadPort, {
  includeBytesFor: [...RULE_BUNDLE_SOURCE_PATHS, ...plannedMarkdownPaths(manifest.plan)]
});
assertRootIdentityEqual(baseline.vault, current.vault, 'VAULT_ROOT_IDENTITY_CHANGED');
const approvedRules = await readApprovedRuleRecord(privateStore);
const currentRuleBundleHash = hashSelectedRuleBytes(current.selectedBytes);
assertEqual(currentRuleBundleHash, baseline.ruleBundleHash, 'CURRENT_RULE_MISMATCH');
assertEqual(
  sha256Canonical(approvedRules), baseline.ruleCompatibilityApproval.recordSha256,
  'RULE_APPROVAL_RECORD_CHANGED'
);
assertEqual(approvedRules.bundleSha256, currentRuleBundleHash, 'RULE_BUNDLE_UNAPPROVED');
assertPlanBeforeVersionsEqualBaseline(
  manifest.plan.steps,
  baseline.entries,
  batchGraph.resultByOrdinal
);
assertPlannedPathAndNamespaceDelta(
  manifest.plan.steps,
  baseline,
  current,
  batchGraph.resultByOrdinal
);
assertExactlyOneFinalRole(manifest.plan.steps, 'source-status');
for (const step of manifest.plan.steps) {
  await verifyAfterHashSchemaLinksAndProtectedBytes(
    step, current.selectedBytes, batchGraph.privateBlobHandles
  );
}
assertNoRuntimeArtifacts(findForbiddenArtifacts(current.records));
await verifyReadOnlyIndexCopy(manifest.plan.steps, current.entries, privateStore);
```

`validateImmutableBatchGraph()` validates the manifest's original exclusive inode/hash, rejects every result-like or unknown manifest field, strictly validates its intent-owned projection capsule, validates the complete journal chain, and requires exactly one compatible authorization and terminal. `assertCommittedTerminalGraph()` accepts only `clean_commit` on the one original supervised batch. A `recovery_continue`, rollback, or `manual_resolve` graph is valid product recovery evidence but cannot satisfy this formal first-write attempt: recovery requires another plan, native grant/dialog, and batch, so the user must preserve the incident evidence, restart from a fresh baseline, and perform one new clean batch. SQLite state is corroborating projection only and cannot substitute for the terminal. The authorization `policyId`, manifest hash, plan/scope/capsule hashes, operation, original intent, recovery identity/snapshot, resolution hash, and terminal capsule/disk/finalizer hashes must cross-bind exactly; duplicate, divergent, out-of-order, or post-terminal records fail.

`assertPlanBeforeVersionsEqualBaseline()` requires create `expectedBefore.exists:false` to be absent from baseline. For replace, Task 7 extends the strict result/retained-before journal evidence with the commit-instant exchanged-old descriptor record `{ rawSha256, byteLength, dev, ino, mode, mtimeNs, ctimeNs }`; it must equal the complete baseline file record, not only `expectedBefore.rawSha256`. This proves a byte-identical replacement, chmod, touch, or other metadata change between baseline and swap invalidates the attempt even when the App later cleanly writes the intended bytes. Supervised ingestion rejects move/mkdir/rmdir steps. Task 7 also extends each strict create/replace result with the descriptor-observed final `{ rawSha256, byteLength, dev, ino, mode, mtimeNs, ctimeNs }`, requires `mode === FINAL_VAULT_FILE_MODE === 0o600`, and cross-binds every field into `observedResultSha256` and the terminal disk digest. `assertPlannedPathAndNamespaceDelta()` compares the full-vault namespace records against those validated result records. It permits only each step's exact planned file create or byte transition whose current SHA/length/dev/ino/mode/mtimeNs/ctimeNs exactly equal its result record, plus `mtimeNs`/`ctimeNs` changes on that touched file's direct parent directory. Every such parent must preserve dev/ino/mode/type and its exact child-name/type set must equal the baseline set plus only the plan's creates; a replace cannot change that set. No grandparent, unrelated directory, `.obsidian` directory, or other directory field may change. A post-result or post-terminal byte-identical rewrite/touch, inode replacement, or chmod of a touched target therefore also fails, as does every unrelated content, identity, permission, path/type, symlink-target, timestamp, or `.obsidian` change.

`verifyReadOnlyIndexCopy()` runs only after the App quits. Through the held appData parent descriptor, require exact absence of `state.sqlite3-wal` and `state.sqlite3-shm`, open `state.sqlite3` read-only/no-follow, fstat/hash it, copy from that held descriptor to a captured `mkdtemp(join(tmpdir(), 'xiaozhao-index-verify-'))` file mode `0600`, then fstat/hash the same source descriptor again. Open only the copy, and for every knowledge/source step require a `search_index` row whose `path`, `kind`, `raw_sha256`, `yaml_json`, and `links_json` match the current descriptor-snapshot bytes/backlinks/status. Remove only the captured temporary copy/root in `finally`. Return `indexValid:true` without reopening or writing the live DB or vault.

`validateRecoveryPlanOrdinalsBindingsAndRetainedEvidence()` validates recovery evidence for rejection/reporting only: recovery-plan ordinals must be newly contiguous and every step's `recoveryOfOrdinal` must point to exactly one original step. A `retire-created-file` must bind the original create path/hash/dev/ino and an exclusive appData retained object with identical bytes; it is never interpreted as a vault delete or a successful source-status step. The authorization validator recomputes `productionEvidenceSha256` from the persistent redacted fields and freshly observed roots/profile/rules, recomputes `authorizationSha256` from its exact defined projection, recomputes the canonical mutation scope from the immutable plan/capsule, and enforces the distinct native-grant hash/confirmation-time versus automatic-null rules. It validates—but explicitly does not claim to reconstruct—the ephemeral-session `nativeGrantScopeSha256`; live production-authority tests are the evidence for issuance/consumption. A missing, swapped, random-without-matching-authorization-hash, or duplicated scope meaning fails. Continue, rollback, and `manually-resolved` outcomes remain valid product records, but all three invalidate this one-dialog/one-batch first-write attempt. Normal verified before snapshots follow the ordinary 30-day policy; `recovery_continue`, `recovery_rollback`, and `manual_resolve` incident payloads cannot be retired automatically at the boundary and require explicit cleanup approval, with any active export lease holding retirement.

The private `formal-vault-after.json` additionally records `verifiedAt`, SHA-256 of the exact baseline evidence file, approved-rule record SHA-256, immutable manifest hash, terminal journal entry/hash-chain head, plan hash, descriptor-reader helper hash/protocol, current snapshot stability, `netChangesObserved`, and live-before/live-after index SHA-256 values. These are hashes/timestamps/counts/booleans only; the report uses them to bind causality without copying paths or bytes. Write it through the same bound `.local/acceptance` output-parent protocol as the baseline, never a caller-selected/path-reopened destination.

- [ ] **Step 11: Test every post-verification false-positive boundary**

Add positive fixtures proving one planned create and one atomic replace pass while the replace's exchanged-old descriptor record exactly matches baseline, their current file hash/length/identity/mode/mtime/ctime exactly match the validated journal results, only their direct parents' `mtimeNs`/`ctimeNs` change, and the derived child sets remain exact. Add one distinct failure assertion for: current root realpath/dev/ino change; helper/protocol mismatch; root/ancestor/entry swap during native scan; hidden entry; permission-only or inode-only unrelated change; pre-commit byte-identical replacement, chmod, or timestamp change of a planned replace; after-result and after-terminal `touch`; after-result and after-terminal same-inode byte-identical rewrite; post-commit byte-identical inode replacement or chmod of a touched target; missing/wrong exchanged-old descriptor evidence; missing/wrong final hash/length/identity/time or non-`0600` mode in its result; changed direct-parent dev/ino/mode or unexpected child set; unrelated-directory or grandparent timestamp change; corrupt or rewritten manifest hash; a manifest carrying authorization/result/terminal fields; broken journal link; missing/duplicate/divergent/out-of-order authorization or terminal; SQLite committed without terminal; recomputed plan hash mismatch; missing or manifest-divergent authorization intent kind; non-`execute` or non-null original-intent/recovery/resolution field on the ordinary batch; confirmation before baseline; wrong authority/scope/operation cross-binding; any authorization root-identity hash that disagrees with the freshly observed canonical root; missing/stale profile; changed/missing approved-rule record; baseline/current/manifest/authorization rule mismatch; malformed or recomputed-mismatching production-evidence hash; malformed or recomputed-mismatching authorization hash; invalid native-grant provenance nullability; baseline before-hash mismatch on a planned replace; create already present at baseline; unrelated allowed-root file change; changed `.obsidian` file bytes; symlink-target change; special file; root-level runtime artifact; missing/extra namespace path; zero/two source-status steps; source not last; source body byte change; after hash mismatch; missing backlink; invalid YAML; stale/missing index row; live DB identity/hash change during copy; WAL/SHM present; zero/two qualifying supervised batch graphs; reused/gapped/duplicate recovery ordinal; bad `recoveryOfOrdinal`; unbound `retire-created-file`; missing/changed retained bytes; `recovery_continue`, rollback, and `manually-resolved` outcomes. Every test uses a sentinel temporary vault and temporary appData.

Run:

```bash
npm run test:integration -- tests/integration/acceptance/verify-formal-write.test.ts
```

Expected: every injected case fails with its named code; the one valid fixture returns all booleans true.

- [ ] **Step 12: Run all authority/UI gates before any formal-vault action**

```bash
npm run test:native-contract
npm run test:unit -- tests/unit/supervised-confirmation.test.ts tests/unit/production-mutation-target-policy.test.ts tests/unit/write-confirmation.test.ts tests/unit/native-recovery-export-port.test.ts tests/unit/electron/ipc-authority.test.ts tests/unit/rule-compatibility-validator.test.ts tests/unit/rule-compatibility-approval.test.ts tests/unit/native-read-helper-protocol.test.ts
npm run test:component -- tests/component/api-client.test.tsx tests/component/intake-queue.test.tsx tests/component/write-confirmation.test.tsx tests/component/recovery-ui.test.tsx tests/component/knowledge-editor.test.tsx tests/component/knowledge-editor-conflict.test.tsx
npm run test:integration -- tests/integration/rule-compatibility-gate.test.ts tests/integration/production-mutation-authority.test.ts tests/integration/native-capability-gate.test.ts tests/integration/intake-api.test.ts tests/integration/acceptance/verify-formal-write.test.ts tests/integration/formal-ingestion-api.test.ts tests/integration/recovery-retention-service.test.ts tests/integration/recovery-only-runtime.test.ts tests/integration/manual-recovery-resolution.test.ts
npm run test:integration -- tests/integration/write-kernel.test.ts tests/integration/write-recovery-crash.test.ts tests/integration/intake-service.test.ts tests/integration/formal-ingestion-coordinator.test.ts tests/integration/formal-ingestion-crash.test.ts tests/integration/formal-ingestion-recovery.test.ts tests/integration/knowledge-edit-coordinator.test.ts tests/integration/knowledge-edit-recovery.test.ts
npm run dist:mac
npm run verify:package
npm run test:electron -- tests/electron/packaged-security.spec.ts tests/electron/packaged-database-recovery.spec.ts tests/electron/native-write-confirmation.spec.ts tests/electron/rule-compatibility-approval.spec.ts tests/electron/recovery-export.spec.ts
```

Expected: PASS. Do not touch the formal vault in this step. Task 8 owns the only valid order: native rule approval, capability/model evidence, baseline, one human batch, App quit, then read-only verification.

- [ ] **Step 13: Lock the private post-verifier output contract on sentinel fixtures**

```bash
npm run test:integration -- tests/integration/acceptance/verify-formal-write.test.ts
```

Expected valid sentinel fixture: `rootIdentityValid=true`, `descriptorSnapshotStable=true`, `approvedRuleCompatibilityValid=true`, `immutableManifestValid=true`, `authorizationJournalValid=true`, `terminalJournalValid=true`, `planBeforeMatchesBaseline=true`, `unexpectedNetChanges=0`, `unexpectedNamespaceChanges=0`, `sourceBodyPreserved=true`, `sourceWasLast=true`, `schemaValid=true`, `backlinksValid=true`, `afterHashesValid=true`, `indexValid=true`, and `vaultArtifactsFound=0`. Task 8 runs this exact verifier once against the formal baseline only after the App quits.

- [ ] **Step 14: Commit code, never private evidence**

```bash
git add native/macos/atomic-file-helper.c src/electron/ipc-authority.ts src/electron/native-recovery-export-port.ts src/electron/production-mutation-target-policy.ts src/electron/rule-compatibility-approval.ts src/electron/recovery-export.ts src/electron/write-confirmation.ts src/server/security/supervised-confirmation.ts src/server/rules/rule-compatibility-validator.ts src/server/rules/compatibility-fixtures.ts src/server/vault/atomic-helper-protocol.ts src/server/vault/NativeReadVaultPort.ts src/server/vault/MutationTargetPolicy.ts src/server/workflow/write-coordinator.ts src/server/workflow/recovery-service.ts src/server/workflow/write-repository.ts src/server/recovery/recovery-manifest.ts src/server/recovery/recovery-journal.ts src/server/recovery/recovery-scanner.ts src/server/recovery/recovery-export-service.ts src/server/recovery/recovery-retention-service.ts src/server/recovery/recovery-only-runtime.ts src/server/recovery/manual-resolution-service.ts src/server/db/repositories/recovery-retention-repository.ts src/server/db/repositories/intake-repository.ts src/server/intake/intake-service.ts src/server/intake/intake-reconciler.ts src/server/workflow/extraction-service.ts src/server/ai/orchestrator.ts src/server/workflow/formal-ingestion-planner.ts src/server/workflow/knowledge-edit-planner.ts src/server/start-server.ts src/electron/main.ts src/electron/database-recovery.ts src/electron/runtime.ts src/electron/preload.ts src/shared/desktop/bridge.ts src/shared/api/schemas.ts src/shared/domain/write.ts src/shared/domain/intake.ts src/client/api/client.ts src/client/components/intake/IntakeConfirmation.tsx src/client/components/editor/EditDiffConfirmation.tsx src/client/pages/QueuePage.tsx src/client/pages/SettingsPage.tsx src/client/pages/WriteConfirmationPage.tsx src/client/pages/RecoveryDetailPage.tsx src/client/pages/KnowledgeEditorPage.tsx src/client/pages/OperationsPage.tsx src/server/api/routes/intake-jobs.ts src/server/api/routes/write-plans.ts src/server/api/routes/write-batches.ts src/server/api/routes/recovery.ts scripts/acceptance/verify-formal-write.ts tests/unit/production-mutation-target-policy.test.ts tests/unit/supervised-confirmation.test.ts tests/unit/write-confirmation.test.ts tests/unit/native-recovery-export-port.test.ts tests/unit/rule-compatibility-validator.test.ts tests/unit/rule-compatibility-approval.test.ts tests/native/recovery-export-helper.contract.test.ts tests/helpers/write-crash-worker.ts tests/integration/rule-compatibility-gate.test.ts tests/integration/production-mutation-authority.test.ts tests/integration/native-capability-gate.test.ts tests/integration/intake-api.test.ts tests/integration/formal-ingestion-api.test.ts tests/integration/recovery-retention-service.test.ts tests/integration/write-kernel.test.ts tests/integration/write-recovery-crash.test.ts tests/integration/intake-service.test.ts tests/integration/formal-ingestion-coordinator.test.ts tests/integration/formal-ingestion-crash.test.ts tests/integration/formal-ingestion-recovery.test.ts tests/integration/knowledge-edit-coordinator.test.ts tests/integration/knowledge-edit-recovery.test.ts tests/integration/recovery-only-runtime.test.ts tests/integration/manual-recovery-resolution.test.ts tests/electron/packaged-security.spec.ts tests/electron/packaged-database-recovery.spec.ts tests/electron/native-write-confirmation.spec.ts tests/electron/rule-compatibility-approval.spec.ts tests/electron/recovery-export.spec.ts tests/integration/acceptance/verify-formal-write.test.ts tests/component/api-client.test.tsx tests/component/intake-queue.test.tsx tests/component/write-confirmation.test.tsx tests/component/recovery-ui.test.tsx tests/component/knowledge-editor.test.tsx tests/component/knowledge-editor-conflict.test.tsx
git commit -m "feat: authorize and verify supervised formal writes"
```

### Task 8: Generate redacted reports and final runbooks

**Files:**
- Modify: `scripts/release/artifact-digest.ts`
- Create: `scripts/acceptance/run-automated-gates.ts`
- Create: `scripts/acceptance/render-report.ts`
- Create: `scripts/acceptance/scan-public-evidence.ts`
- Create: `tests/unit/release/run-automated-gates.test.ts`
- Create: `tests/unit/release/render-report.test.ts`
- Create: `tests/unit/release/public-evidence-scan.test.ts`
- Create: `docs/runbook/personal-desktop.md`
- Create: `docs/runbook/recovery.md`
- Create: `docs/runbook/formal-acceptance.md`
- Create: `docs/acceptance/test-vault-report.md`
- Create: `docs/acceptance/personal-v1-evidence.md`
- Modify: `src/shared/acceptance/evidence.ts`
- Modify: `package.json`
- Create: `README.md`

- [ ] **Step 1: Define strict automated evidence and write failing runner tests**

Extend `evidence.ts` with a strict private run-state schema and a passed-evidence assertion:

```ts
export const AUTOMATED_GATE_NAMES = [
  'verify', 'test:native', 'dist:mac',
  'verify:package', 'test:electron', 'smoke:native:packaged'
] as const;

export const automatedRunEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('phase6-automated-gates'),
  status: z.enum(['running', 'failed', 'passed']),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  gitHead: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u),
  gitTreeClean: z.literal(true),
  packageLockSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  appVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
  appTreeSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  dmgSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  failureGate: z.enum(AUTOMATED_GATE_NAMES).nullable(),
  gates: z.array(z.object({
    name: z.enum(AUTOMATED_GATE_NAMES),
    status: z.enum(['passed', 'failed']),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    durationMs: z.number().int().nonnegative(),
    exitCode: z.number().int()
  }).strict()).max(AUTOMATED_GATE_NAMES.length)
}).strict();
```

`assertPassedAutomatedEvidence()` additionally requires `status:'passed'`, exact gate order with no duplicate/missing gate, every exit code `0`, timestamps monotonic, non-null completion/artifact hashes, and `failureGate:null`. Running/failed/missing/partial/skipped evidence can be retained privately for diagnosis but can never satisfy the passed type.

In `run-automated-gates.test.ts`, inject a process runner, clock, git/hash adapters, and a temporary output root. Assert exact sequential commands, `shell:false`, and a scrubbed environment. The runner must reject any tracked/untracked worktree entry before writing `running`, so evidence always begins from a clean committed HEAD; ignored `release/` and `.local/acceptance/` do not appear in the status result. Assert the runner atomically replaces a stale pass with `status:'running'` before the first gate; on gate 3 exit `1`, it stops, writes `status:'failed'`, records only gates 1–3, leaves artifact hashes null, and exits non-zero. A full pass must recheck clean HEAD/tree and write exact hashes, directory mode `0700`, file mode `0600`, and no command output, absolute source path, environment value, or key. Reordered/duplicate/missing gates, dirty tree, negative duration, non-zero passed exit, stale Git/lock/artifact hashes, and JSON with an unknown key must fail.

Run:

```bash
npm run test:unit -- tests/unit/release/run-automated-gates.test.ts
```

Expected: FAIL because the runner and artifact digester are absent.

- [ ] **Step 2: Implement deterministic artifact digests and the non-recursive gate runner**

`artifact-digest.ts` walks the `.app` with `lstat` and never follows symlinks. Sort UTF-8 relative paths and hash canonical records containing path, type, mode, size/file SHA-256 for regular files, and link target for symlinks; reject sockets/devices/FIFOs. Hash the DMG as bytes. This digest is evidence identity, not a replacement for Task 2's codesign/ASAR/fuse checks.

`run-automated-gates.ts` owns this exact non-recursive graph:

```ts
const GATES = [
  ['verify', ['run', 'verify']],
  ['test:native', ['run', 'test:native']],
  ['dist:mac', ['run', 'dist:mac']],
  ['verify:package', ['run', 'verify:package']],
  ['test:electron', ['run', 'test:electron']],
  ['smoke:native:packaged', ['run', 'smoke:native:packaged']]
] as const;
```

For each gate call `spawn('npm', args, { shell:false, cwd:repoRoot, stdio:'inherit', env:scrubbedEnv })`, await its exact exit code, and atomically rewrite `.local/acceptance/automated.json` after each transition. `scrubbedEnv` deletes `WRITE_ENABLED`, `VAULT_REAL_ROOT`, `XIAOZHAO_TEST_VAULT_ROOT`, `XIAOZHAO_TEST_USER_DATA`, `MODEL_API_KEY`, `DEEPSEEK_API_KEY`, `OBSIDIAN_API_KEY`, and `NODE_OPTIONS`; individual test fixtures create their own validated sentinel environment in the child. Do not accept a CLI gate list or output path.

Before gate 1, require `git status --porcelain=v1 --untracked-files=all` to be empty, capture `git rev-parse HEAD`, SHA-256 of `package-lock.json`, and package version, then write `running`. On failure, write `failed` before returning the same non-zero status. Only after all six gates pass, resolve the exact Task 2 App/DMG paths, require them to exist, compute both artifact hashes, reread Git HEAD, clean status, and `package-lock.json`, require no drift, then atomically write `passed` with `gitTreeClean:true`. Never persist stdout/stderr, commands, environment, source/vault paths, or gate skips.

Keep the package script non-recursive:

```json
{ "verify:personal-v1": "tsx scripts/acceptance/run-automated-gates.ts" }
```

Run:

```bash
npm run test:unit -- tests/unit/release/run-automated-gates.test.ts
```

Expected: the injected full-pass and failure cases pass. Do not create candidate `automated.json` here; the real six-gate run occurs only from the clean committed HEAD in Step 7.

- [ ] **Step 3: Test report freshness, redaction, and status logic**

Given passing automated, packaged production-capability, DeepSeek, and formal summaries, assert the report contains `最终状态：当前 Mac 个人版验收通过`, App/DMG/helper SHA-256, arm64, the actual configured endpoint origin and model from the real smoke, safe operation ID, zero net vault/runtime differences with two-identical-descriptor-scan stability, and the local-only distribution boundary. The DeepSeek assertion is exactly:

```ts
expect(deepseek).toMatchObject({
  status: 'passed', schemaValid: true,
  appVaultRuntimeLoaded: false, vaultNetChangesObserved: 0,
  vaultSnapshotStability: 'two-identical-descriptor-scans',
  dependencyBoundarySha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
});
```

Require automated Git/lock/App/DMG hashes to equal current values; production capability to carry `bootstrapInitiator:'app-settings'` plus a schema-valid `bootstrapHandshakeSha256`; production capability, DeepSeek snapshots, baseline, and formal verifier helper SHA/protocol to equal the currently signed packaged helper; DeepSeek App hash to equal automated/current App; dependency-boundary hash to equal a fresh analyzer result; baseline's approved-rule record to equal the current descriptor-read appData approval; formal evidence to reference the exact baseline evidence hash plus immutable manifest and journal-terminal hashes; and timestamps to satisfy `automated.completedAt <= rules.approvedAt <= capability.completedAt <= deepseek.completedAt <= baseline.capturedAt < authorization.confirmedAt <= terminal.completedAt <= formal.verifiedAt`. A time equality is allowed only where shown.

Assert the public report contains neither `/Users/ao/我的大脑`, `Library/Application Support`, `sk-`, source text, model output, before/after bytes, vault-relative child paths, private index paths, tokens, Electron session IDs, nor raw manifest/journal content. Missing, running, failed, skipped, stale, hash-mismatched, out-of-order, or extra-key evidence must render only `最终状态：尚未达到最终可用标准` and list stable reason codes.

- [ ] **Step 4: Implement deterministic report rendering and revalidation**

`render-report.ts` validates every private input with the strict schemas, reruns current Git/lock/App/DMG/helper/dependency-boundary digests, applies the freshness/order rules above, and writes only counts, hashes, booleans, model name, safe operation ID, and stable failure codes. It requires:

```text
automated: exact 6-gate pass, current Git/lock/App/DMG
capability: bootstrapInitiator=app-settings, bootstrap handshake hash valid, packaged signed helper match, arm64, recovery device match, all primitives/crash passed, formalNetChangesObserved=0, descriptor snapshot stable
deepseek: real request passed, schemaValid, appVaultRuntimeLoaded=false, vaultNetChangesObserved=0, descriptor snapshot stable, current boundary/App match
formal: baseline reader/hash/root/approved-rule/immutable-manifest/authorization-journal/terminal-journal/plan/before/namespace/source/schema/backlink/after/index/runtime checks all true
```

Write reports atomically. Detailed evidence remains `.local/acceptance/*.json` mode `0600`; public reports never embed a private object. `--kind test-vault` accepts only current automated evidence and can say only that automated/test-vault gates passed. `--kind personal-v1` requires `--app-data`, `--automated`, `--capability`, `--deepseek`, `--baseline`, and `--formal`; it reads the approval record only to rehash/compare it and never prints the appData path. Omitting one is a non-pass, not an inferred success.

Run:

```bash
npm run test:unit -- tests/unit/release/run-automated-gates.test.ts tests/unit/release/render-report.test.ts tests/unit/release/public-evidence-scan.test.ts
```

Expected: valid fresh fixtures pass; every stale/redaction fixture produces a blocked report with no private value. `public-evidence-scan.test.ts` injects an API key value, formal child path, appData path, serialized native token/session, and before/after bytes into each fixed public target and requires rejection; plain prose saying `nativeGrantToken is never disclosed` and operational root-level boundary text must not be a false positive.

- [ ] **Step 5: Write exact operational runbooks**

`personal-desktop.md` contains exact artifact paths and DMG installation, first-run vault/Key setup and Phase 3 model-setting migration, App-native rule-compatibility approval, and Settings → `验证写入能力` as the only user-facing production-capability bootstrap/revalidation path. It explains safe App exit, dedicated child progress/result, automatic relaunch or manual reopen, and the blocked rule/profile-stale remediation entirely in App. It also documents that `待确认入馆` first shows the immutable plan preview, then the native `确认入馆` dialog, while high-confidence `automatic` intake needs no dialog and cannot accept a token. Put `npm ci`, `npm run verify:personal-v1`, and `npm run bootstrap:capability:packaged -- --evidence-only` only in a clearly separated “开发验收” section; users do not need Terminal for setup, daily use, recovery, or capability remediation. Include `Command-Q` and the explicit statement that the ad-hoc build is for this current Mac only; Developer ID, notarization, auto-update, and cross-machine download were not verified.

`recovery.md` maps disk hash states: before→continue, after→mark step complete, unknown with intact evidence→preserve/export/manual choice; reverse/resolve actions require a new bound recovery WritePlan; resolve accepts only current or validated before/after/retained versions, ends the batch `manually-resolved`, and dispatches the original-intent conflict state (intake `needs_confirmation`, extraction `reviewing`, knowledge-edit draft `conflict`, all with `MANUAL_RECOVERY_CONFLICT`) without clearing evidence automatically; created-file rollback uses exclusive `retire-created-file`, never unlink. It documents that `导出恢复包` is driven only by the fresh server snapshot's `allowedActions`, so it covers `complete` batches with retained evidence and `manual-only` snapshots whose manifest/journal/blobs/retained identities are all valid, but never `partial-journal`, `missing-blob`, broken-chain, or another evidence-integrity invalid state. It also documents the single-purpose direct-stream native save export, canonical `{ batchId, snapshotSha256 }` request, cancel/no-overwrite rules, SQLite recovery-only versus no-manifest quarantine/rebuild, and the two retention paths: normally verified before snapshots follow Phase 5's ordinary 30-day policy, while recovery continue/rollback/manual-resolve evidence survives through the 30-day boundary and then still requires explicit cleanup approval. “清理” means only identity-bound payload retirement: original bytes become unavailable but a minimal zero-byte audit tree and separate immutable retirement-control ledger remain, with no unlink/rmdir or later broad cleanup. The ledger is the recovery truth after SQLite loss; SQLite stores only a no-FK projection and recovery-only can resume an existing ledger but cannot select a new cleanup. Export is optional and no prior export is required for cleanup approval; an active export holds retirement without moving evidence, an active retirement rejects export before batch reads/dialog/destination creation, and either retry starts from a fresh snapshot/eligibility check.

`formal-acceptance.md` contains the exact Step 6 order below. Stop on any automated/capability/model/baseline failure; quit Obsidian/plugin writers before baseline; any external edit after baseline requires a new baseline and new plan; only App UI followed by the native dialog may approve a human/recovery plan; quit the App before read-only post-verification; failed verification preserves recovery/private evidence and blocks the pass report. It states that bootstrap probes only a separately owned sentinel root and must never create anything in the formal vault.

Create these exact committed, non-pass templates before any final run:

```text
docs/runbook/personal-desktop.md     -> install, first-run, migration, approval, bootstrap
docs/runbook/recovery.md             -> disk-state matrix, resolve projections, export/retention
docs/runbook/formal-acceptance.md     -> exact clean-HEAD Step 7 command order
docs/acceptance/test-vault-report.md  -> 最终状态：尚未达到最终可用标准
docs/acceptance/personal-v1-evidence.md -> 最终状态：尚未达到最终可用标准
README.md                             -> links to the three runbooks and two reports
```

- [ ] **Step 6: Commit implementation and non-pass templates, then establish a clean HEAD**

Run implementation/template tests, stage exactly the Task 8 file list, and commit before producing any candidate evidence:

```bash
npm run typecheck
npm run test:unit -- tests/unit/release/run-automated-gates.test.ts tests/unit/release/render-report.test.ts tests/unit/release/public-evidence-scan.test.ts
git add scripts/release/artifact-digest.ts scripts/acceptance/run-automated-gates.ts scripts/acceptance/render-report.ts scripts/acceptance/scan-public-evidence.ts tests/unit/release/run-automated-gates.test.ts tests/unit/release/render-report.test.ts tests/unit/release/public-evidence-scan.test.ts docs/runbook/personal-desktop.md docs/runbook/recovery.md docs/runbook/formal-acceptance.md docs/acceptance/test-vault-report.md docs/acceptance/personal-v1-evidence.md src/shared/acceptance/evidence.ts package.json README.md
git diff --cached --name-only
git commit -m "docs: add personal desktop acceptance workflow"
git status --porcelain=v1 --untracked-files=all
```

Expected: the staged-name output is exactly the 15 Task 8 files, both committed report templates still say `最终状态：尚未达到最终可用标准`, and the final status command prints nothing. Stop if HEAD or the worktree is not clean. This commit is the immutable candidate source revision; no implementation, template, lockfile, or commit may change after Step 7 begins.

- [ ] **Step 7: Run the complete final graph from clean HEAD; do not commit afterward**

First prove the clean installable candidate and preserve its identity:

```bash
git status --porcelain=v1 --untracked-files=all
npm ci
git status --porcelain=v1 --untracked-files=all
npm run verify:personal-v1
stat -f '%Sp' .local/acceptance/automated.json
```

Expected: both status commands print nothing, `automated.json` is `-rw-------`, and it is a fresh six-gate pass with `gitTreeClean=true` for the current committed Git/lock/App/DMG.

Open exactly the packaged App. Complete any Phase 3 model-settings migration, configure/select the formal vault and actual model endpoint/model/Key, inspect and approve the five-file rule fingerprint in the native dialog, then click Settings → `验证写入能力`. Confirm the native prompt, let the App safely close, wait for the dedicated child result, and verify the relaunched Settings page says the capability profile is current/passed. This App flow is the required first-run and daily remediation path; no terminal command, HTTP, renderer payload, environment, model, or reclassification action substitutes for it. Quit with `Command-Q`.

With the App quit, export developer acceptance evidence for that already App-created profile and run the real-model proof:

```bash
npm run bootstrap:capability:packaged -- --evidence-only
npm run smoke:deepseek:real -- --formal-vault /Users/ao/我的大脑
```

Expected: evidence-only mode performs no bootstrap or promotion and binds the App-created current signed-helper/crash-matrix profile with `formalNetChangesObserved=0` and `formalSnapshotStability=two-identical-descriptor-scans`; DeepSeek reports `appVaultRuntimeLoaded=false`, `vaultNetChangesObserved=0`, `vaultSnapshotStability=two-identical-descriptor-scans`, and a dependency-boundary hash.

Quit Obsidian and every plugin/process that can edit the vault. Capture the baseline:

```bash
WRITE_ENABLED=false npm run acceptance:formal:baseline -- --vault /Users/ao/我的大脑 --app-data "$HOME/Library/Application Support/小兆大脑" --helper release/mac-arm64/小兆大脑.app/Contents/Resources/native/atomic-file-helper --output .local/acceptance/formal-vault-before.json
```

Expected: the signed packaged helper produces two identical descriptor-anchored hidden-inclusive root/rule/allowed-file/whole-namespace snapshots, `netChangesObserved=0`, and `snapshotStability=two-identical-descriptor-scans`. This is an exact net-stability statement, not proof that no transient write occurred between observations. Do not run the baseline again after the App write; a fresh baseline restarts the supervised acceptance attempt.

Open exactly `release/mac-arm64/小兆大脑.app`, select one existing `未提炼` item, review the full immutable diff and final source-status step, approve in App, then approve exactly one native dialog whose ordered list shows every complete vault-relative path/action and full plan hash. Do not proceed if any target is missing, truncated, or different from the App diff. Do not use a positive HTTP, CLI, Playwright, fixture, model, or environment-variable path. Quit the App with `Command-Q`.

After the one App-native confirmed batch, generate and scan both reports:

```bash
WRITE_ENABLED=false npm run acceptance:formal:verify -- --vault /Users/ao/我的大脑 --app-data "$HOME/Library/Application Support/小兆大脑" --helper release/mac-arm64/小兆大脑.app/Contents/Resources/native/atomic-file-helper --baseline .local/acceptance/formal-vault-before.json --latest-supervised --output .local/acceptance/formal-vault-after.json
WRITE_ENABLED=false VAULT_REAL_ROOT=/Users/ao/我的大脑 npm run smoke:real-vault
npm run acceptance:report -- --kind personal-v1 --app-data "$HOME/Library/Application Support/小兆大脑" --automated .local/acceptance/automated.json --capability .local/acceptance/production-capability.json --deepseek .local/acceptance/deepseek-smoke.json --baseline .local/acceptance/formal-vault-before.json --formal .local/acceptance/formal-vault-after.json --output docs/acceptance/personal-v1-evidence.md
npm run acceptance:report -- --kind test-vault --automated .local/acceptance/automated.json --output docs/acceptance/test-vault-report.md
npm run test:unit -- tests/unit/release/public-evidence-scan.test.ts
npm run acceptance:scan-public
git status --porcelain=v1 --untracked-files=all
```

Expected: post-verification reports all Task 7 booleans true, immutable manifest/authorization/terminal/capsule hashes are cross-bound, the read smoke reports two identical descriptor snapshots and zero net changes, and the personal report says current-Mac personal V1 passed with the ad-hoc/current-Mac-only boundary. `acceptance:scan-public` prints `PASSED public-evidence-redaction files=3`; it scans only the two fixed reports and `README.md`. Final Git status may show only the two generated report files changed from their committed non-pass templates. Do not commit, amend, tag, rebuild, or change the lockfile after this run: a later commit changes HEAD and invalidates the evidence. `.local/acceptance/*.json`, release artifacts, userData profiles, and crash evidence remain ignored/untracked private outputs.

## Phase 6 completion audit

- [ ] `.app` and read-only-mounted `.dmg` contain exact migrations 001–007, exact production dependency tree, ASAR-only app code, only the required native unpack, and no maps/env/tests/fixtures.
- [ ] Actual App/framework/helper/sqlite signatures are valid ad-hoc with only allowed entitlements; all native binaries are arm64; all hardened fuses match policy, including `LoadBrowserProcessSpecificV8Snapshot=Disabled`.
- [ ] The signed packaged helper passes the temporary native smoke and a separate same-volume production bootstrap; Settings → `验证写入能力` starts that bootstrap with zero renderer payload, safe shutdown, fixed signed-child mode args, scrubbed environment, a one-use inherited-fd handshake that attests the still-live same-executable App supervisor, bounded progress/result, and supervisor-process-exit-before-relaunch. The supervisor retains the single-instance lock through child terminal/promotion so every concurrent normal launch is rejected before runtime construction; the active profile binds the handshake hash, helper signature/SHA, OS, arm64, target filesystem/device, recovery device, primitives, and the full crash matrix without placing a probe in the formal vault. Direct CLI execution with copied flags cannot promote.
- [ ] Packaged Electron passes CSP/session/CSRF/Host/Origin/preload/navigation/permission/single-instance/shutdown tests; every privileged IPC binds the exact main-window WebContents/main frame/current origin; 720/800/1280 retain a full-height left sidebar, Dashboard deck is `未提炼` only, Queue retains `部分入库`, and confirmed tokens/reduced-motion remain intact.
- [ ] Every automated filesystem/Electron test uses the one exact sentinel fixture and branded empty `0700` direct-tmp userData; either variable overlapping the formal root, an ancestor/descendant, the other root, or any alias is rejected before `app.setPath`, runtime/helper/database construction, or filesystem creation.
- [ ] Corrupt SQLite with a valid manifest starts minimal recovery-only UI; no-manifest rebuild needs a native choice and preserves an exclusive appData quarantine; neither path creates a runtime file in the vault.
- [ ] The current five-file rule fingerprint has a Phase 0-schema-valid private App-native approval; rule drift blocks intake, model start, plan creation, coordinator, and production policy under `RULE_BUNDLE_UNAPPROVED` until read-only compatibility validation passes again.
- [ ] Real DeepSeek reads the migrated narrow encrypted-key and non-secret endpoint stores, uses fixed synthetic input, reports the actual endpoint origin/model, validates structure, binds the transitive/built dependency hash and current App hash, and reports `appVaultRuntimeLoaded=false`, `vaultNetChangesObserved=0`, and two-identical-descriptor-scan stability.
- [ ] `.local/acceptance/automated.json` is atomically generated `0600` by the non-recursive six-gate runner and binds fresh Git, lockfile, App, DMG, exit codes, and monotonic timestamps; no missing/failed/skipped/stale gate can pass.
- [ ] Formal baseline binds the signed read-helper hash/protocol, root realpath/dev/ino, approved rule record, descriptor-returned rule bytes, every allowed-file identity/mode/hash, the hidden-inclusive full-vault namespace (including `.obsidian`), zero forbidden artifacts, and exactly two identical descriptor snapshots with zero net changes; it makes no unobservable “zero writes” claim.
- [ ] Production policy is constructed only by normal packaged Electron main: only exact Phase 2 intake shapes whose atomically plan-bound strict capsule has `authorizationMode:'automatic'` run tokenless and reject any token; a bound `user_confirmed` intake capsule, extraction, draft/restore, continue/rollback/resolve require a 60-second single-use native grant bound to session, target/appData/recovery identities, full plan, strict projection capsule, intake mode where applicable, non-recovery original intent, operation, profile, rules, current snapshot, and selection.
- [ ] Queue shows a persisted immutable `user_confirmed` intake preview whose binding/plan/capsule/apply expectation all use the atomic `needs_confirmation N -> ready N+1` result before the shared native dialog labelled `确认入馆`, then calls token-required `applyConfirmedIntake()` once with the exact binding ID/version and clears the token in `finally`; grant issue, apply and `assertCurrent()` require the same unique active binding, renderer/API cannot set authorization mode, automatic intake opens no dialog, and cancel/stale/supersede/consume/rollback cannot reuse an old grant or reactivate history.
- [ ] Recovery supports new ordinals plus `recoveryOfOrdinal`, exclusive `retire-created-file`, `manually-resolved` plus the exact original-intent conflict projection (`needs_confirmation`/`reviewing`/draft `conflict`), exhaustive bounded native summaries, and private no-overwrite export whose source and destination parent remain descriptor-bound and which rejects formal-vault/appData overlap; continue/rollback/manual-resolve incident evidence survives the 30-day boundary until explicit cleanup approval, export remains optional, and the one server-internal `RecoveryEvidenceLeaseCoordinator` makes export and non-deleting held-inode payload retirement mutually exclusive from each operation's first authoritative recheck through durable/native completion, with every exit releasing exactly once, no check-then-race or renderer/HTTP handle. A disjoint immutable retirement-control ledger survives SQLite loss and drives exact resume/rebuild into a no-FK projection while the minimal zero-byte audit tree remains.
- [ ] The user reviews one existing `未提炼` material, complete immutable diff, and final source-status step, then confirms exactly one formal batch through App UI and one native dialog showing every complete ordered relative path/action; no positive CLI/HTTP/env/model/Playwright path exists.
- [ ] After App quit, the read-only verifier binds baseline→approval→immutable manifest→authorization journal→terminal journal→plan, proves root/rules/before versions/planned full-namespace identity/mode/content delta/source protected bytes/source-last/schema/backlinks/after hashes, validates a descriptor-copied read-only index, and finds no WAL/SHM or vault runtime artifact.
- [ ] Public reports contain only revalidated hashes/counts/booleans/safe IDs, pass the fixed-target redaction scanner, and state ad-hoc/current-Mac/no-Developer-ID/no-notarization boundaries. Only this complete fresh evidence authorizes “最终可用版”.
