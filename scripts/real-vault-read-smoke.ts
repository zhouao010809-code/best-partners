import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildServer } from '../src/server/app.js';
import { openStateKernel, type NormalStateKernel } from '../src/server/db/database.js';
import { SearchIndexer, type IndexRefreshResult } from '../src/server/index/SearchIndexer.js';
import {
  createIndexRepository,
  type IndexRepository
} from '../src/server/index/index-repository.js';
import { parseKnowledgeNote } from '../src/server/rules/knowledge-schema.js';
import { parseLibraryNote } from '../src/server/rules/library-schema.js';
import type { IndexSchedulerPort } from '../src/server/services/index-job-service.js';
import {
  LocalRest51Gateway,
  type FetchImplementation
} from '../src/server/vault/LocalRest51Gateway.js';
import { sha256Bytes } from '../src/server/vault/raw-bytes.js';
import {
  knowledgePageResponseSchema,
  liveKnowledgeDetailResponseSchema,
  materialPageResponseSchema
} from '../src/shared/api/schemas.js';

const MANIFEST_ROOTS = ['00大脑规则', '01图书馆', '02知识库'] as const;
const APP_DATA_PREFIX = 'xiaozhao-brain-read-smoke-';
const API_HOST = '127.0.0.1:4317';
const API_PAGE_LIMIT = 200;
const EXPECTED_ISSUE_COUNT = 3;

const SAFE_SMOKE_CODES = [
  'WRITE_ENABLED_REQUIRED',
  'VAULT_ROOT_REQUIRED',
  'CREDENTIALS_REQUIRED',
  'HTTPS_REQUIRED',
  'VAULT_ROOT_UNSAFE',
  'TEMP_OVERLAP',
  'TEMP_UNSAFE',
  'TEMP_CLEANUP_FAILED',
  'STATE_KERNEL_UNAVAILABLE',
  'MANIFEST_UNSAFE',
  'VAULT_CHANGED',
  'INDEX_STALLED',
  'INDEX_ISSUES_MISMATCH',
  'INDEX_PROJECTION_MISMATCH',
  'API_READ_FAILED',
  'API_CURSOR_INVALID',
  'API_CURSOR_REPEAT',
  'API_PATH_REPEAT',
  'DETAIL_UNAVAILABLE',
  'DETAIL_MISMATCH',
  'VAULT_MUTATION_OBSERVED',
  'VAULT_OPEN_OBSERVED',
  'SMOKE_FAILED'
] as const;

export type SafeSmokeCode = typeof SAFE_SMOKE_CODES[number];

type BlockedSmokeOutcome = {
  readonly status: 'blocked';
  readonly code: SafeSmokeCode;
};

type FailedSmokeOutcome = {
  readonly status: 'failed';
  readonly code: SafeSmokeCode;
};

type PassedSmokeOutcome = {
  readonly status: 'passed';
  readonly writeEnabled: false;
  readonly manifest: {
    readonly files: number;
    readonly beforeSha256: string;
    readonly afterSha256: string;
    readonly changedFiles: 0;
  };
  readonly index: {
    readonly version: number;
    readonly pendingMaterials: number;
    readonly activeKnowledge: number;
    readonly includeObsolete: number;
    readonly issueCount: 3;
  };
  readonly http: {
    readonly vaultGetCount: number;
    readonly vaultNonGetCount: 0;
  };
  readonly detail: {
    readonly rereadVerified: true;
  };
};

export type SmokeOutcome = BlockedSmokeOutcome | FailedSmokeOutcome | PassedSmokeOutcome;

type SmokeStatus = BlockedSmokeOutcome['status'] | FailedSmokeOutcome['status'];

class SafeSmokeError extends Error {
  readonly code: SafeSmokeCode;

  constructor(code: SafeSmokeCode) {
    super(code);
    this.name = 'SafeSmokeError';
    this.code = code;
  }
}

export type VaultManifestEntry = {
  readonly path: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly sha256: string;
};

export type VaultManifest = {
  readonly entries: ReadonlyArray<VaultManifestEntry>;
  readonly aggregateSha256: string;
  readonly rootDev: string;
  readonly rootIno: string;
};

type ValidatedSmokeEnvironment = {
  readonly ok: true;
  readonly vaultRealRoot: string;
  readonly apiUrl: string;
  readonly apiKey: string;
};

type BlockedSmokeEnvironment = {
  readonly ok: false;
  readonly code: Extract<
    SafeSmokeCode,
    | 'WRITE_ENABLED_REQUIRED'
    | 'VAULT_ROOT_REQUIRED'
    | 'CREDENTIALS_REQUIRED'
    | 'HTTPS_REQUIRED'
  >;
};

type FileIdentity = {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
};

type EndpointCounters = {
  root: number;
  openapi: number;
  vaultDirectory: number;
  vaultRaw: number;
  vaultDocumentMap: number;
  open: number;
  other: number;
};

export type ObservedHttpSnapshot = {
  readonly vaultGetCount: number;
  readonly vaultNonGetCount: number;
  readonly openCount: number;
  readonly categories: Readonly<EndpointCounters>;
};

type CursorPage<T> = {
  readonly items: ReadonlyArray<T>;
  readonly nextCursor?: string | undefined;
};

type DirectProjection = {
  readonly pendingMaterialPaths: ReadonlySet<string>;
  readonly activeKnowledgePaths: ReadonlySet<string>;
  readonly allKnowledgePaths: ReadonlySet<string>;
  readonly issuePaths: ReadonlySet<string>;
};

type SmokeCoreResult = {
  readonly indexVersion: number;
  readonly pendingMaterials: number;
  readonly activeKnowledge: number;
  readonly includeObsolete: number;
  readonly vaultGetCountBeforeDetail: number;
};

type RunDependencies = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly createManifest?: (vaultRoot: string) => Promise<VaultManifest>;
  readonly fetchImplementation?: FetchImplementation;
};

function fail(code: SafeSmokeCode): never {
  throw new SafeSmokeError(code);
}

function isSafeSmokeCode(value: unknown): value is SafeSmokeCode {
  return typeof value === 'string' && (SAFE_SMOKE_CODES as readonly string[]).includes(value);
}

export function toSafeSmokeOutcome(error: unknown, status: SmokeStatus): FailedSmokeOutcome | BlockedSmokeOutcome {
  const code = error instanceof SafeSmokeError && isSafeSmokeCode(error.code)
    ? error.code
    : 'SMOKE_FAILED';
  return { status, code };
}

export function formatSmokeOutcome(outcome: SmokeOutcome): string {
  if (outcome.status !== 'passed') {
    return `${JSON.stringify({
      status: outcome.status,
      code: isSafeSmokeCode(outcome.code) ? outcome.code : 'SMOKE_FAILED'
    })}\n`;
  }
  return `${JSON.stringify({
    status: 'passed',
    writeEnabled: false,
    manifest: {
      files: outcome.manifest.files,
      beforeSha256: outcome.manifest.beforeSha256,
      afterSha256: outcome.manifest.afterSha256,
      changedFiles: 0
    },
    index: {
      version: outcome.index.version,
      pendingMaterials: outcome.index.pendingMaterials,
      activeKnowledge: outcome.index.activeKnowledge,
      includeObsolete: outcome.index.includeObsolete,
      issueCount: EXPECTED_ISSUE_COUNT
    },
    http: {
      vaultGetCount: outcome.http.vaultGetCount,
      vaultNonGetCount: 0
    },
    detail: { rereadVerified: true }
  })}\n`;
}

export function validateSmokeEnvironment(
  env: Readonly<Record<string, string | undefined>>
): ValidatedSmokeEnvironment | BlockedSmokeEnvironment {
  if (env.WRITE_ENABLED !== 'false') {
    return { ok: false, code: 'WRITE_ENABLED_REQUIRED' };
  }
  if (
    typeof env.VAULT_REAL_ROOT !== 'string'
    || env.VAULT_REAL_ROOT.length === 0
    || !isAbsolute(env.VAULT_REAL_ROOT)
  ) {
    return { ok: false, code: 'VAULT_ROOT_REQUIRED' };
  }
  if (
    typeof env.OBSIDIAN_API_URL !== 'string'
    || env.OBSIDIAN_API_URL.length === 0
    || typeof env.OBSIDIAN_API_KEY !== 'string'
    || !/^[\u0021-\u007e]+$/u.test(env.OBSIDIAN_API_KEY)
  ) {
    return { ok: false, code: 'CREDENTIALS_REQUIRED' };
  }

  let apiUrl: URL;
  try {
    apiUrl = new URL(env.OBSIDIAN_API_URL);
  } catch {
    return { ok: false, code: 'HTTPS_REQUIRED' };
  }
  if (
    apiUrl.protocol !== 'https:'
    || apiUrl.username.length > 0
    || apiUrl.password.length > 0
  ) {
    return { ok: false, code: 'HTTPS_REQUIRED' };
  }
  return {
    ok: true,
    vaultRealRoot: env.VAULT_REAL_ROOT,
    apiUrl: apiUrl.origin,
    apiKey: env.OBSIDIAN_API_KEY
  };
}

function sameOrContainedBy(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return fromParent === '' || (
    fromParent !== '..'
    && !fromParent.startsWith(`..${sep}`)
    && !isAbsolute(fromParent)
  );
}

function pathsOverlap(left: string, right: string): boolean {
  return sameOrContainedBy(left, right) || sameOrContainedBy(right, left);
}

function identityOf(status: {
  readonly dev: bigint | number;
  readonly ino: bigint | number;
  readonly size: bigint | number;
  readonly mtimeNs: bigint | number;
}): FileIdentity {
  return {
    dev: String(status.dev),
    ino: String(status.ino),
    size: String(status.size),
    mtimeNs: String(status.mtimeNs)
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

function sameNodeIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertCanonicalVaultRoot(vaultRoot: string): Promise<{
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
}> {
  try {
    const before = await lstat(vaultRoot, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) fail('VAULT_ROOT_UNSAFE');
    const canonical = await realpath(vaultRoot);
    const canonicalStatus = await lstat(canonical, { bigint: true });
    const after = await lstat(vaultRoot, { bigint: true });
    const afterCanonical = await realpath(vaultRoot);
    const beforeIdentity = identityOf(before);
    if (
      canonicalStatus.isSymbolicLink()
      || !canonicalStatus.isDirectory()
      || after.isSymbolicLink()
      || !after.isDirectory()
      || canonical !== afterCanonical
      || !sameNodeIdentity(beforeIdentity, identityOf(canonicalStatus))
      || !sameNodeIdentity(beforeIdentity, identityOf(after))
    ) {
      fail('VAULT_ROOT_UNSAFE');
    }
    return { path: canonical, dev: beforeIdentity.dev, ino: beforeIdentity.ino };
  } catch (error) {
    if (error instanceof SafeSmokeError) throw error;
    return fail('VAULT_ROOT_UNSAFE');
  }
}

async function readStableRegularFile(
  filePath: string,
  canonicalVaultRoot: string
): Promise<{ readonly bytes: Uint8Array; readonly identity: FileIdentity; readonly sha256: string }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const beforePath = await lstat(filePath, { bigint: true });
    if (beforePath.isSymbolicLink() || !beforePath.isFile()) fail('MANIFEST_UNSAFE');
    const beforeRealPath = await realpath(filePath);
    if (!sameOrContainedBy(canonicalVaultRoot, beforeRealPath)) fail('MANIFEST_UNSAFE');

    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    handle = await open(filePath, constants.O_RDONLY | noFollow);
    const beforeOpen = await handle.stat({ bigint: true });
    const beforeIdentity = identityOf(beforePath);
    if (!beforeOpen.isFile() || !sameIdentity(beforeIdentity, identityOf(beforeOpen))) {
      fail('MANIFEST_UNSAFE');
    }

    const bytes = new Uint8Array(await handle.readFile());
    const afterOpen = await handle.stat({ bigint: true });
    const afterPath = await lstat(filePath, { bigint: true });
    const afterRealPath = await realpath(filePath);
    if (
      afterPath.isSymbolicLink()
      || !afterPath.isFile()
      || beforeRealPath !== afterRealPath
      || !sameIdentity(beforeIdentity, identityOf(afterOpen))
      || !sameIdentity(beforeIdentity, identityOf(afterPath))
      || BigInt(bytes.byteLength) !== beforeOpen.size
    ) {
      fail('MANIFEST_UNSAFE');
    }
    return {
      bytes,
      identity: beforeIdentity,
      sha256: sha256Bytes(bytes)
    };
  } catch (error) {
    if (error instanceof SafeSmokeError) throw error;
    return fail('MANIFEST_UNSAFE');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function walkManifestDirectory(input: {
  readonly directoryPath: string;
  readonly vaultRoot: string;
  readonly entries: VaultManifestEntry[];
}): Promise<void> {
  try {
    const before = await lstat(input.directoryPath, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) fail('MANIFEST_UNSAFE');
    const beforeIdentity = identityOf(before);
    const beforeRealPath = await realpath(input.directoryPath);
    if (!sameOrContainedBy(input.vaultRoot, beforeRealPath)) fail('MANIFEST_UNSAFE');
    const names = (await readdir(input.directoryPath)).sort();

    for (const name of names) {
      if (name.length === 0 || name.includes('/') || name.includes('\\') || name.includes('\0')) {
        fail('MANIFEST_UNSAFE');
      }
      const childPath = join(input.directoryPath, name);
      const status = await lstat(childPath, { bigint: true });
      if (status.isSymbolicLink()) fail('MANIFEST_UNSAFE');
      if (status.isDirectory()) {
        await walkManifestDirectory({ ...input, directoryPath: childPath });
        continue;
      }
      if (!status.isFile()) fail('MANIFEST_UNSAFE');
      const stable = await readStableRegularFile(childPath, input.vaultRoot);
      const path = relative(input.vaultRoot, childPath).split(sep).join('/');
      if (path.length === 0 || path.startsWith('../') || path === '..') fail('MANIFEST_UNSAFE');
      input.entries.push({
        path,
        size: stable.identity.size,
        mtimeNs: stable.identity.mtimeNs,
        sha256: stable.sha256
      });
    }

    const afterNames = (await readdir(input.directoryPath)).sort();
    const after = await lstat(input.directoryPath, { bigint: true });
    const afterRealPath = await realpath(input.directoryPath);
    if (
      after.isSymbolicLink()
      || !after.isDirectory()
      || beforeRealPath !== afterRealPath
      || !sameIdentity(beforeIdentity, identityOf(after))
      || names.length !== afterNames.length
      || names.some((name, index) => name !== afterNames[index])
    ) {
      fail('MANIFEST_UNSAFE');
    }
  } catch (error) {
    if (error instanceof SafeSmokeError) throw error;
    fail('MANIFEST_UNSAFE');
  }
}

export async function buildVaultManifest(vaultRoot: string): Promise<VaultManifest> {
  const rootBefore = await assertCanonicalVaultRoot(vaultRoot);
  const canonicalVaultRoot = rootBefore.path;
  const entries: VaultManifestEntry[] = [];
  for (const root of MANIFEST_ROOTS) {
    await walkManifestDirectory({
      directoryPath: join(canonicalVaultRoot, root),
      vaultRoot: canonicalVaultRoot,
      entries
    });
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const rootAfter = await assertCanonicalVaultRoot(vaultRoot);
  if (
    rootAfter.path !== rootBefore.path
    || rootAfter.dev !== rootBefore.dev
    || rootAfter.ino !== rootBefore.ino
  ) {
    fail('MANIFEST_UNSAFE');
  }
  const aggregateSha256 = createHash('sha256')
    .update(JSON.stringify({
      rootDev: rootBefore.dev,
      rootIno: rootBefore.ino,
      entries
    }), 'utf8')
    .digest('hex');
  return {
    entries,
    aggregateSha256,
    rootDev: rootBefore.dev,
    rootIno: rootBefore.ino
  };
}

export function compareVaultManifests(before: VaultManifest, after: VaultManifest): number {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry] as const));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry] as const));
  const paths = new Set([...beforeByPath.keys(), ...afterByPath.keys()]);
  let changed = 0;
  for (const path of paths) {
    const left = beforeByPath.get(path);
    const right = afterByPath.get(path);
    if (
      left === undefined
      || right === undefined
      || left.size !== right.size
      || left.mtimeNs !== right.mtimeNs
      || left.sha256 !== right.sha256
    ) {
      changed += 1;
    }
  }
  return before.rootDev === after.rootDev && before.rootIno === after.rootIno
    ? changed
    : Math.max(changed, 1);
}

function fixedCategory(input: RequestInfo | URL, init?: RequestInit): keyof EndpointCounters {
  let url: URL;
  try {
    const raw = input instanceof Request ? input.url : String(input);
    url = new URL(raw);
  } catch {
    return 'other';
  }
  if (url.pathname === '/') return 'root';
  if (url.pathname === '/openapi.yaml') return 'openapi';
  if (url.pathname.startsWith('/open/')) return 'open';
  if (!url.pathname.startsWith('/vault/')) return 'other';
  if (url.pathname.endsWith('/')) return 'vaultDirectory';

  let accept = '';
  try {
    accept = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      .get('accept') ?? '';
  } catch {
    return 'other';
  }
  return accept === 'application/vnd.olrapi.document-map+json'
    ? 'vaultDocumentMap'
    : 'vaultRaw';
}

export function createObservedFetch(delegate: FetchImplementation): {
  readonly fetch: FetchImplementation;
  readonly snapshot: () => ObservedHttpSnapshot;
} {
  let vaultGetCount = 0;
  let vaultNonGetCount = 0;
  let openCount = 0;
  const categories: EndpointCounters = {
    root: 0,
    openapi: 0,
    vaultDirectory: 0,
    vaultRaw: 0,
    vaultDocumentMap: 0,
    open: 0,
    other: 0
  };
  const observedFetch: FetchImplementation = async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const category = fixedCategory(input, init);
    categories[category] += 1;
    if (category === 'open') openCount += 1;
    if (category.startsWith('vault')) {
      if (method === 'GET') vaultGetCount += 1;
      else vaultNonGetCount += 1;
    }
    if (method !== 'GET') fail('VAULT_MUTATION_OBSERVED');
    if (category === 'open') fail('VAULT_OPEN_OBSERVED');
    return delegate(input, init);
  };
  return {
    fetch: observedFetch,
    snapshot: () => ({
      vaultGetCount,
      vaultNonGetCount,
      openCount,
      categories: { ...categories }
    })
  };
}

export async function collectCursorPages<T extends { readonly path: string }>(
  getPage: (cursor: string | undefined) => Promise<CursorPage<T>>
): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  const seenPaths = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const page = await getPage(cursor);
    for (const item of page.items) {
      if (item.path.length === 0 || seenPaths.has(item.path)) fail('API_PATH_REPEAT');
      seenPaths.add(item.path);
      items.push(item);
    }
    if (page.nextCursor === undefined) return items;
    if (page.items.length === 0 || page.nextCursor.length === 0) fail('API_CURSOR_INVALID');
    if (seenCursors.has(page.nextCursor)) fail('API_CURSOR_REPEAT');
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

function isIndexerVisibleMarkdown(path: string): boolean {
  return path.endsWith('.md') && !path.split('/').some((segment) => segment.startsWith('.'));
}

function entryMatchesStableFile(
  entry: VaultManifestEntry,
  stable: { readonly identity: FileIdentity; readonly sha256: string }
): boolean {
  return entry.size === stable.identity.size
    && entry.mtimeNs === stable.identity.mtimeNs
    && entry.sha256 === stable.sha256;
}

async function buildDirectProjection(
  vaultRoot: string,
  manifest: VaultManifest
): Promise<DirectProjection> {
  const pendingMaterialPaths = new Set<string>();
  const activeKnowledgePaths = new Set<string>();
  const allKnowledgePaths = new Set<string>();
  const issuePaths = new Set<string>();
  for (const entry of manifest.entries) {
    if (!isIndexerVisibleMarkdown(entry.path)) continue;
    const library = entry.path.startsWith('01图书馆/');
    const knowledge = entry.path.startsWith('02知识库/');
    if (!library && !knowledge) continue;
    const filePath = resolve(vaultRoot, ...entry.path.split('/'));
    if (!sameOrContainedBy(vaultRoot, filePath)) fail('MANIFEST_UNSAFE');
    const stable = await readStableRegularFile(filePath, vaultRoot);
    if (!entryMatchesStableFile(entry, stable)) fail('VAULT_CHANGED');
    if (library) {
      const parsed = parseLibraryNote(stable.bytes, entry.path);
      if (parsed.record !== undefined && parsed.record.knowledgeStatus !== '已入库') {
        pendingMaterialPaths.add(entry.path);
      }
      for (const issue of parsed.issues) issuePaths.add(issue.path);
      continue;
    }
    const parsed = parseKnowledgeNote(stable.bytes, entry.path);
    if (parsed.record !== undefined) {
      allKnowledgePaths.add(entry.path);
      if (parsed.record.usageStatus !== '过时') activeKnowledgePaths.add(entry.path);
    }
    for (const issue of parsed.issues) issuePaths.add(issue.path);
  }
  return {
    pendingMaterialPaths,
    activeKnowledgePaths,
    allKnowledgePaths,
    issuePaths
  };
}

async function driveIndexer(indexer: SearchIndexer): Promise<IndexRefreshResult & { status: 'ready' }> {
  const seen = new Set<string>();
  let previous: IndexRefreshResult | undefined;
  while (true) {
    const refresh = await indexer.refresh();
    if (refresh.status === 'ready') return { ...refresh, status: 'ready' };
    if (
      !Number.isSafeInteger(refresh.checked)
      || !Number.isSafeInteger(refresh.total)
      || refresh.checked < 0
      || refresh.total < refresh.checked
    ) {
      fail('INDEX_STALLED');
    }
    const state = `${refresh.checked}:${refresh.total}:${refresh.version}`;
    if (seen.has(state)) fail('INDEX_STALLED');
    seen.add(state);
    if (
      previous !== undefined
      && refresh.total === previous.total
      && refresh.checked <= previous.checked
    ) {
      fail('INDEX_STALLED');
    }
    previous = refresh;
  }
}

function collectRepositoryPaths(
  repository: IndexRepository,
  kind: 'material' | 'knowledge'
): Set<string> {
  const paths = new Set<string>();
  let page = 1;
  while (true) {
    const result = kind === 'material'
      ? repository.listMaterials({ page, pageSize: API_PAGE_LIMIT })
      : repository.listKnowledge({ page, pageSize: API_PAGE_LIMIT, includeObsolete: true });
    for (const item of result.items) {
      if (paths.has(item.path)) fail('INDEX_PROJECTION_MISMATCH');
      paths.add(item.path);
    }
    if (paths.size >= result.total) return paths;
    if (result.items.length === 0) fail('INDEX_PROJECTION_MISMATCH');
    page += 1;
  }
}

function samePathSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((path) => right.has(path));
}

function createUnusedScheduler(indexer: SearchIndexer): IndexSchedulerPort {
  let generation = 0;
  return {
    requestFocusRefresh: async () => ({
      generation: ++generation,
      outcome: 'failed',
      reason: 'INDEX_REFRESH_FAILED'
    }),
    snapshot: () => ({
      state: {
        status: 'building',
        version: indexer.version,
        startedAt: '2026-09-01T00:00:00.000Z'
      }
    })
  };
}

async function readMaterialApi(server: ReturnType<typeof buildServer>) {
  return collectCursorPages(async (cursor) => {
    const query = new URLSearchParams({ limit: String(API_PAGE_LIMIT) });
    if (cursor !== undefined) query.set('cursor', cursor);
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/materials?${query.toString()}`,
      headers: { host: API_HOST }
    });
    if (response.statusCode !== 200) fail('API_READ_FAILED');
    const parsed = materialPageResponseSchema.safeParse(response.json());
    if (!parsed.success) fail('API_READ_FAILED');
    return parsed.data.data;
  });
}

async function readKnowledgeApi(
  server: ReturnType<typeof buildServer>,
  includeObsolete: boolean
) {
  return collectCursorPages(async (cursor) => {
    const query = new URLSearchParams({ limit: String(API_PAGE_LIMIT) });
    if (includeObsolete) query.set('includeObsolete', 'true');
    if (cursor !== undefined) query.set('cursor', cursor);
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/knowledge?${query.toString()}`,
      headers: { host: API_HOST }
    });
    if (response.statusCode !== 200) fail('API_READ_FAILED');
    const parsed = knowledgePageResponseSchema.safeParse(response.json());
    if (!parsed.success) fail('API_READ_FAILED');
    return parsed.data.data;
  });
}

async function executeReadSmoke(input: {
  readonly gateway: LocalRest51Gateway;
  readonly kernel: NormalStateKernel;
  readonly direct: DirectProjection;
  readonly beforeManifest: VaultManifest;
  readonly observed: ReturnType<typeof createObservedFetch>;
  readonly setServer: (server: ReturnType<typeof buildServer>) => void;
}): Promise<SmokeCoreResult> {
  const repository = createIndexRepository(input.kernel.db);
  const indexer = new SearchIndexer({
    gateway: input.gateway,
    repository,
    maxRawReadsPerPoll: API_PAGE_LIMIT
  });
  const indexScheduler = createUnusedScheduler(indexer);
  const server = buildServer({
    readApi: {
      repository,
      gateway: input.gateway,
      database: input.kernel.db,
      indexScheduler,
      currentIndexVersion: () => indexer.version,
      cursorSecret: Buffer.from('real-vault-read-smoke-cursor-secret')
    }
  });
  input.setServer(server);

  const ready = await driveIndexer(indexer);
  const issues = repository.listIssues();
  if (issues.length !== EXPECTED_ISSUE_COUNT) fail('INDEX_ISSUES_MISMATCH');
  const repositoryMaterialPaths = collectRepositoryPaths(repository, 'material');
  const repositoryKnowledgePaths = collectRepositoryPaths(repository, 'knowledge');
  if (issues.some((issue) => (
    repositoryMaterialPaths.has(issue.path) || repositoryKnowledgePaths.has(issue.path)
  ))) {
    fail('INDEX_ISSUES_MISMATCH');
  }
  const repositoryIssuePaths = new Set(issues.map((issue) => issue.path));
  if (!samePathSet(repositoryIssuePaths, input.direct.issuePaths)) {
    fail('INDEX_ISSUES_MISMATCH');
  }

  const [materials, activeKnowledge, allKnowledge] = await Promise.all([
    readMaterialApi(server),
    readKnowledgeApi(server, false),
    readKnowledgeApi(server, true)
  ]);
  const materialPaths = new Set(materials.map((item) => item.path));
  const activeKnowledgePaths = new Set(activeKnowledge.map((item) => item.path));
  const allKnowledgePaths = new Set(allKnowledge.map((item) => item.path));
  if (
    !samePathSet(materialPaths, input.direct.pendingMaterialPaths)
    || !samePathSet(activeKnowledgePaths, input.direct.activeKnowledgePaths)
    || !samePathSet(allKnowledgePaths, input.direct.allKnowledgePaths)
  ) {
    fail('INDEX_PROJECTION_MISMATCH');
  }

  const selected = activeKnowledge[0] ?? allKnowledge[0];
  if (selected === undefined) fail('DETAIL_UNAVAILABLE');
  const projected = repository.getKnowledge(selected.path);
  const manifestEntry = input.beforeManifest.entries.find((entry) => entry.path === selected.path);
  if (
    projected === undefined
    || manifestEntry === undefined
    || selected.rawSha256 !== projected.rawSha256
    || selected.upstreamVersion !== projected.upstreamVersion
    || projected.rawSha256 !== manifestEntry.sha256
  ) {
    fail('DETAIL_MISMATCH');
  }

  const httpBeforeDetail = input.observed.snapshot();
  const vaultGetCountBeforeDetail = httpBeforeDetail.vaultGetCount;
  const query = new URLSearchParams({ path: selected.path });
  const response = await server.inject({
    method: 'GET',
    url: `/api/v1/knowledge/file?${query.toString()}`,
    headers: { host: API_HOST }
  });
  if (response.statusCode !== 200) fail('DETAIL_MISMATCH');
  const detail = liveKnowledgeDetailResponseSchema.safeParse(response.json());
  if (!detail.success) fail('DETAIL_MISMATCH');
  const marker = detail.data.data.versionMarker;
  const httpAfterDetail = input.observed.snapshot();
  if (
    httpAfterDetail.vaultGetCount <= vaultGetCountBeforeDetail
    || httpAfterDetail.categories.vaultRaw < httpBeforeDetail.categories.vaultRaw + 2
    || httpAfterDetail.categories.vaultDocumentMap
      < httpBeforeDetail.categories.vaultDocumentMap + 1
    || detail.data.data.path !== selected.path
    || marker.rawSha256 !== projected.rawSha256
    || marker.rawSha256 !== manifestEntry.sha256
    || marker.upstreamVersion !== projected.upstreamVersion
  ) {
    fail('DETAIL_MISMATCH');
  }

  return {
    indexVersion: ready.version,
    pendingMaterials: materials.length,
    activeKnowledge: activeKnowledge.length,
    includeObsolete: allKnowledge.length,
    vaultGetCountBeforeDetail
  };
}

async function createSafeTemporaryRoot(canonicalVaultRoot: string): Promise<{
  readonly path: string;
  readonly canonicalPath: string;
  readonly dev: string;
  readonly ino: string;
}> {
  try {
    const canonicalTemporaryBase = await realpath(tmpdir());
    if (
      sameOrContainedBy(canonicalVaultRoot, canonicalTemporaryBase)
      || sameOrContainedBy(canonicalVaultRoot, join(canonicalTemporaryBase, APP_DATA_PREFIX))
    ) {
      fail('TEMP_OVERLAP');
    }
    const path = await mkdtemp(join(tmpdir(), APP_DATA_PREFIX));
    const status = await lstat(path, { bigint: true });
    const canonicalPath = await realpath(path);
    const overlaps = pathsOverlap(canonicalVaultRoot, canonicalPath);
    if (
      status.isSymbolicLink()
      || !status.isDirectory()
      || overlaps
    ) {
      fail(overlaps ? 'TEMP_OVERLAP' : 'TEMP_UNSAFE');
    }
    return {
      path,
      canonicalPath,
      dev: String(status.dev),
      ino: String(status.ino)
    };
  } catch (error) {
    if (error instanceof SafeSmokeError) throw error;
    return fail('TEMP_UNSAFE');
  }
}

async function removeSafeTemporaryRoot(temporary: {
  readonly path: string;
  readonly canonicalPath: string;
  readonly dev: string;
  readonly ino: string;
}): Promise<void> {
  try {
    const status = await lstat(temporary.path, { bigint: true });
    if (
      status.isSymbolicLink()
      || !status.isDirectory()
      || String(status.dev) !== temporary.dev
      || String(status.ino) !== temporary.ino
      || await realpath(temporary.path) !== temporary.canonicalPath
      || !dirname(temporary.path).startsWith(tmpdir())
      || !temporary.path.startsWith(join(tmpdir(), APP_DATA_PREFIX))
    ) {
      fail('TEMP_CLEANUP_FAILED');
    }
    await rm(temporary.path, { recursive: true, force: false });
  } catch (error) {
    if (error instanceof SafeSmokeError) throw error;
    fail('TEMP_CLEANUP_FAILED');
  }
}

export async function runRealVaultReadSmoke(
  dependencies: RunDependencies = {}
): Promise<SmokeOutcome> {
  const environment = validateSmokeEnvironment(dependencies.env ?? process.env);
  if (!environment.ok) return { status: 'blocked', code: environment.code };

  const manifestBuilder = dependencies.createManifest ?? buildVaultManifest;
  const delegateFetch = dependencies.fetchImplementation ?? fetch;
  let temporary: Awaited<ReturnType<typeof createSafeTemporaryRoot>> | undefined;
  let kernel: NormalStateKernel | undefined;
  let server: ReturnType<typeof buildServer> | undefined;
  let observed: ReturnType<typeof createObservedFetch> | undefined;
  let beforeManifest: VaultManifest | undefined;
  let afterManifest: VaultManifest | undefined;
  let core: SmokeCoreResult | undefined;
  let failure: unknown;

  try {
    const vaultRoot = await assertCanonicalVaultRoot(environment.vaultRealRoot);
    const canonicalVaultRoot = vaultRoot.path;
    temporary = await createSafeTemporaryRoot(canonicalVaultRoot);
    beforeManifest = await manifestBuilder(canonicalVaultRoot);
    const direct = await buildDirectProjection(canonicalVaultRoot, beforeManifest);
    const state = openStateKernel({
      appDataDir: temporary.canonicalPath,
      vaultRealRoot: canonicalVaultRoot
    });
    if (state.mode !== 'normal') fail('STATE_KERNEL_UNAVAILABLE');
    kernel = state;
    observed = createObservedFetch(delegateFetch);
    const gateway = new LocalRest51Gateway(
      environment.apiUrl,
      environment.apiKey,
      observed.fetch
    );
    core = await executeReadSmoke({
      gateway,
      kernel,
      direct,
      beforeManifest,
      observed,
      setServer: (value) => {
        server = value;
      }
    });
  } catch (error) {
    failure = error;
  } finally {
    if (server !== undefined) {
      try {
        await server.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (kernel !== undefined) {
      try {
        kernel.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (observed !== undefined) {
      const snapshot = observed.snapshot();
      if (snapshot.vaultNonGetCount !== 0) failure = new SafeSmokeError('VAULT_MUTATION_OBSERVED');
      if (snapshot.openCount !== 0) failure = new SafeSmokeError('VAULT_OPEN_OBSERVED');
    }
    if (beforeManifest !== undefined) {
      try {
        afterManifest = await manifestBuilder(environment.vaultRealRoot);
        if (compareVaultManifests(beforeManifest, afterManifest) !== 0) {
          failure = new SafeSmokeError('VAULT_CHANGED');
        }
      } catch (error) {
        failure = error;
      }
    }
    if (temporary !== undefined) {
      try {
        await removeSafeTemporaryRoot(temporary);
      } catch (error) {
        failure = error;
      }
    }
  }

  if (failure !== undefined) return toSafeSmokeOutcome(failure, 'failed');
  if (
    beforeManifest === undefined
    || afterManifest === undefined
    || core === undefined
    || observed === undefined
  ) {
    return { status: 'failed', code: 'SMOKE_FAILED' };
  }
  const http = observed.snapshot();
  if (http.vaultGetCount <= core.vaultGetCountBeforeDetail) {
    return { status: 'failed', code: 'DETAIL_MISMATCH' };
  }
  return {
    status: 'passed',
    writeEnabled: false,
    manifest: {
      files: beforeManifest.entries.length,
      beforeSha256: beforeManifest.aggregateSha256,
      afterSha256: afterManifest.aggregateSha256,
      changedFiles: 0
    },
    index: {
      version: core.indexVersion,
      pendingMaterials: core.pendingMaterials,
      activeKnowledge: core.activeKnowledge,
      includeObsolete: core.includeObsolete,
      issueCount: EXPECTED_ISSUE_COUNT
    },
    http: {
      vaultGetCount: http.vaultGetCount,
      vaultNonGetCount: 0
    },
    detail: { rereadVerified: true }
  };
}

async function main(): Promise<void> {
  let outcome: SmokeOutcome;
  try {
    outcome = await runRealVaultReadSmoke();
  } catch (error) {
    outcome = toSafeSmokeOutcome(error, 'failed');
  }
  process.stdout.write(formatSmokeOutcome(outcome));
  process.exitCode = outcome.status === 'passed' ? 0 : 1;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(invokedPath).href === import.meta.url) {
  void main();
}
