import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

export const CONTRACT_PROFILE_SCHEMA_VERSION = 1 as const;

const capabilityStatusSchema = z.enum(['unverified', 'passed', 'failed']);
const evidenceOperationSchema = z.enum([
  'safeRead',
  'safeCreate',
  'safeReplace',
  'safeRestore',
  'safeDelete',
  'rereadVerified',
  'externalMutationObservation',
  'restartPersistence',
  'cleanup'
]);
const primitiveSchema = z.enum([
  'RAW_REREAD',
  'PATCH_IF_MATCH',
  'PUT_REJECT_IF_CONTENT_PREEXISTS',
  'COPY_ALLOW_OVERWRITE_FALSE',
  'DELETE_NON_PERMANENT',
  'DIRECT_FILESYSTEM',
  'DIRECTORY_POLL'
]);
const safeIdentifierSchema = z.string().min(1).max(128).regex(/^[a-z0-9._-]+$/i);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const revisionSchema = sha256Schema;
const reasonCodeSchema = z.string().min(1).max(128).regex(/^[A-Z0-9_:-]+$/);
const ACTIVATION_MARKER_FILE = 'activation-pending.json';

const contractEvidenceSchema = z.object({
  operation: evidenceOperationSchema,
  status: capabilityStatusSchema,
  httpStatuses: z.array(z.number().int().min(100).max(599)).max(16).optional(),
  timestamp: z.string().datetime({ offset: true }),
  reasonCode: reasonCodeSchema,
  primitive: primitiveSchema.optional()
}).strict();

const contractProfileSchema = z.object({
  schemaVersion: z.literal(CONTRACT_PROFILE_SCHEMA_VERSION),
  profileKey: sha256Schema,
  pluginId: safeIdentifierSchema,
  pluginVersion: safeIdentifierSchema,
  obsidianVersion: safeIdentifierSchema,
  openApiSha256: sha256Schema,
  checkedAt: z.string().datetime({ offset: true }),
  restartCheckedAt: z.string().datetime({ offset: true }).optional(),
  safeRead: z.boolean(),
  safeReplace: z.boolean(),
  safeCreate: z.boolean(),
  safeRestore: z.boolean(),
  safeDelete: z.boolean(),
  rereadVerified: z.boolean(),
  externalMutationObservation: capabilityStatusSchema,
  restartPersistence: capabilityStatusSchema,
  formalWriteGate: z.enum(['passed', 'blocked']),
  evidence: z.array(contractEvidenceSchema).max(128)
}).strict();

const profileInputSchema = contractProfileSchema.omit({
  schemaVersion: true,
  profileKey: true,
  formalWriteGate: true
});

const storedEnvelopeSchema = z.object({
  schemaVersion: z.literal(CONTRACT_PROFILE_SCHEMA_VERSION),
  profileKey: sha256Schema,
  revision: revisionSchema,
  checksumSha256: sha256Schema,
  profile: contractProfileSchema
}).strict();

const currentPointerSchema = z.object({
  schemaVersion: z.literal(CONTRACT_PROFILE_SCHEMA_VERSION),
  profileKey: sha256Schema,
  revision: revisionSchema,
  checksumSha256: sha256Schema,
  profileFile: z.string().min(1).max(160),
  reportFile: z.string().min(1).max(160)
}).strict();

const activationMarkerSchema = z.object({
  schemaVersion: z.literal(CONTRACT_PROFILE_SCHEMA_VERSION),
  profileKey: sha256Schema,
  revision: revisionSchema,
  checksumSha256: sha256Schema
}).strict();

export type ContractCapabilityStatus = z.infer<typeof capabilityStatusSchema>;
export type ContractEvidence = z.infer<typeof contractEvidenceSchema>;
export type ContractProfileInput = z.infer<typeof profileInputSchema>;
export type StoredContractProfile = z.infer<typeof contractProfileSchema>;
export type ContractProfilePointer = z.infer<typeof currentPointerSchema>;
export type ContractProfileState = {
  readonly profile: StoredContractProfile;
  readonly revision: string;
  readonly pointer: ContractProfilePointer;
};
export type ContractFingerprint = Pick<
  ContractProfileInput,
  'pluginId' | 'pluginVersion' | 'obsidianVersion' | 'openApiSha256'
>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object).sort().map((key) => [key, canonicalize(object[key])])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function computeContractProfileKey(fingerprint: ContractFingerprint): string {
  const parsed = z.object({
    pluginId: safeIdentifierSchema,
    pluginVersion: safeIdentifierSchema,
    obsidianVersion: safeIdentifierSchema,
    openApiSha256: sha256Schema
  }).strict().parse({
    pluginId: fingerprint.pluginId,
    pluginVersion: fingerprint.pluginVersion,
    obsidianVersion: fingerprint.obsidianVersion,
    openApiSha256: fingerprint.openApiSha256
  });
  return sha256(canonicalJson(parsed));
}

type ExecutableEvidenceOperation = Exclude<ContractEvidence['operation'], 'cleanup'>;

export function contractEvidencePassed(
  evidence: ReadonlyArray<ContractEvidence>,
  operation: ExecutableEvidenceOperation
): boolean {
  const record = evidence.filter((item) => item.operation === operation).at(-1);
  if (record?.status !== 'passed') return false;
  switch (operation) {
    case 'safeRead':
    case 'rereadVerified':
    case 'restartPersistence':
      return record.primitive === 'RAW_REREAD';
    case 'safeCreate':
      return record.primitive === 'PUT_REJECT_IF_CONTENT_PREEXISTS'
        || record.primitive === 'COPY_ALLOW_OVERWRITE_FALSE';
    case 'safeReplace':
    case 'safeRestore':
      return record.primitive === 'PATCH_IF_MATCH';
    case 'safeDelete':
      return record.primitive === 'DELETE_NON_PERMANENT'
        && record.reasonCode === 'CONDITIONAL_NONPERMANENT_DELETE_VERIFIED';
    case 'externalMutationObservation':
      return record.primitive === 'RAW_REREAD' || record.primitive === 'DIRECTORY_POLL';
  }
}

export function computeFormalWriteGate(input: Pick<
  ContractProfileInput,
  | 'safeRead'
  | 'safeCreate'
  | 'safeReplace'
  | 'safeRestore'
  | 'safeDelete'
  | 'rereadVerified'
  | 'externalMutationObservation'
  | 'restartPersistence'
  | 'evidence'
>): 'passed' | 'blocked' {
  const allExecutableEvidencePassed = ([
    'safeRead',
    'safeCreate',
    'safeReplace',
    'safeRestore',
    'safeDelete',
    'rereadVerified',
    'externalMutationObservation',
    'restartPersistence'
  ] as const).every((operation) => contractEvidencePassed(input.evidence, operation));
  return input.safeRead
    && input.safeCreate
    && input.safeReplace
    && input.safeRestore
    && input.safeDelete
    && input.rereadVerified
    && input.externalMutationObservation === 'passed'
    && input.restartPersistence === 'passed'
    && allExecutableEvidencePassed
    ? 'passed'
    : 'blocked';
}

export function computeContractProfileRevision(profile: StoredContractProfile): string {
  return sha256(canonicalJson(profile));
}

export function buildContractProfile(input: ContractProfileInput): StoredContractProfile {
  try {
    const parsed = profileInputSchema.parse(input);
    return contractProfileSchema.parse({
      schemaVersion: CONTRACT_PROFILE_SCHEMA_VERSION,
      profileKey: computeContractProfileKey(parsed),
      ...parsed,
      formalWriteGate: computeFormalWriteGate(parsed)
    });
  } catch {
    throw new Error('CONTRACT_PROFILE_INVALID');
  }
}

function reportStatus(value: ContractCapabilityStatus | 'passed' | 'blocked'): string {
  if (value === 'passed') return 'PASSED';
  if (value === 'failed') return 'FAILED';
  if (value === 'blocked') return 'BLOCKED';
  return 'UNVERIFIED';
}

export function renderContractProfileMarkdown(profile: StoredContractProfile): string {
  const parsed = contractProfileSchema.parse(profile);
  const latestEvidence = (operation: ContractEvidence['operation']): ContractEvidence | undefined => (
    parsed.evidence.filter((record) => record.operation === operation).at(-1)
  );
  const evidenceRow = (
    operation: ContractEvidence['operation']
  ): [string, ContractCapabilityStatus, string, string] => {
    const current = latestEvidence(operation);
    const status = current?.status === 'passed'
      && operation !== 'cleanup'
      && !contractEvidencePassed(parsed.evidence, operation)
      ? 'failed'
      : current?.status ?? 'unverified';
    return [
      operation,
      status,
      current?.timestamp ?? parsed.checkedAt,
      current?.reasonCode ?? 'NO_EVIDENCE'
    ];
  };
  const rows: Array<[string, ContractCapabilityStatus | 'passed' | 'blocked', string, string]> = [
    evidenceRow('safeRead'),
    evidenceRow('safeCreate'),
    evidenceRow('safeReplace'),
    evidenceRow('safeRestore'),
    evidenceRow('safeDelete'),
    evidenceRow('rereadVerified'),
    evidenceRow('externalMutationObservation'),
    evidenceRow('restartPersistence'),
    evidenceRow('cleanup'),
    [
      'formalWriteGate',
      parsed.formalWriteGate,
      parsed.restartCheckedAt ?? parsed.checkedAt,
      parsed.formalWriteGate === 'passed' ? 'FORMAL_GATE_PASSED' : 'FORMAL_GATE_BLOCKED'
    ]
  ];
  return [
    `# Contract capability profile ${parsed.profileKey}`,
    '',
    `Plugin: ${parsed.pluginId} ${parsed.pluginVersion}`,
    `Obsidian: ${parsed.obsidianVersion}`,
    `OpenAPI SHA-256: ${parsed.openApiSha256}`,
    '',
    '| Capability | Status | Checked at | Reason code |',
    '|---|---|---|---|',
    ...rows.map(([capability, status, checkedAt, reasonCode]) => (
      `| ${capability} | ${reportStatus(status)} | ${checkedAt} | ${reasonCode} |`
    ))
  ].join('\n');
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function profileFileName(profileKey: string, revision: string): string {
  return `${profileKey}.${revision}.json`;
}

function reportFileName(profileKey: string, revision: string): string {
  return `${profileKey}.${revision}.md`;
}

async function resolveStoreDirectory(directory: string, create: boolean): Promise<string> {
  const name = basename(directory);
  if (!/^[a-z0-9._-]+$/i.test(name) || name === '.' || name === '..') throw new Error('unsafe');
  const parent = await realpath(dirname(directory));
  const candidate = join(parent, name);
  try {
    const status = await lstat(candidate);
    if (status.isSymbolicLink() || !status.isDirectory()) throw new Error('unsafe');
  } catch (error) {
    if (!hasCode(error, 'ENOENT') || !create) throw error;
    await mkdir(candidate, { mode: 0o700 });
    const created = await lstat(candidate);
    if (created.isSymbolicLink() || !created.isDirectory()) throw new Error('unsafe');
  }
  if (await realpath(candidate) !== candidate) throw new Error('unsafe');
  if (create) await chmod(candidate, 0o700);
  return candidate;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readRegularFileNoFollow(path: string, chmodMode?: number): Promise<string> {
  if (typeof constants.O_NOFOLLOW !== 'number' || constants.O_NOFOLLOW === 0) {
    throw new Error('nofollow unavailable');
  }
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error('unsafe file');
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      throw new Error('unsafe file');
    }
    const value = await handle.readFile('utf8');
    if (chmodMode !== undefined) await handle.chmod(chmodMode);
    return value;
  } finally {
    await handle.close();
  }
}

async function writeImmutable(path: string, value: string): Promise<void> {
  const serialized = `${value}\n`;
  try {
    if (await readRegularFileNoFollow(path, 0o600) !== serialized) {
      throw new Error('immutable mismatch');
    }
    return;
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  let linked = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, path);
      linked = true;
    } catch (error) {
      if (
        !hasCode(error, 'EEXIST')
        || await readRegularFileNoFollow(path, 0o600) !== serialized
      ) {
        throw error;
      }
    }
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // Best-effort close before removing an uncommitted immutable revision.
    }
    throw error;
  } finally {
    try {
      await unlink(temporary);
    } catch {
      // The temporary file may not have been created or may already be gone.
    }
  }
  if (linked && await readRegularFileNoFollow(path, 0o600) !== serialized) {
    throw new Error('immutable mismatch');
  }
}

async function atomicWritePointer(
  directory: string,
  pointer: ContractProfilePointer,
  syncAfterCommit: (directory: string) => Promise<void>
): Promise<void> {
  const target = join(directory, 'current.json');
  const temporary = join(directory, `current.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${canonicalJson(pointer)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    // Readers remain fail-closed behind activation-pending.json until this
    // directory sync makes the pointer rename crash-durable.
    await syncAfterCommit(directory);
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // Best-effort close before removing an uncommitted pointer.
    }
    try {
      await unlink(temporary);
    } catch {
      // The pointer may already have been renamed or never created.
    }
    throw error;
  }
}

async function writeActivationMarker(
  directory: string,
  pointer: ContractProfilePointer
): Promise<void> {
  const target = join(directory, ACTIVATION_MARKER_FILE);
  const temporary = join(directory, `${ACTIVATION_MARKER_FILE}.${randomUUID()}.tmp`);
  const marker = activationMarkerSchema.parse({
    schemaVersion: CONTRACT_PROFILE_SCHEMA_VERSION,
    profileKey: pointer.profileKey,
    revision: pointer.revision,
    checksumSha256: pointer.checksumSha256
  });
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${canonicalJson(marker)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    await syncDirectory(directory);
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // Best-effort close before removing an uncommitted marker temporary.
    }
    try {
      await unlink(temporary);
    } catch {
      // The marker may already be visible or may never have been created.
    }
    throw error;
  }
}

async function removeActivationMarker(directory: string): Promise<void> {
  await unlink(join(directory, ACTIVATION_MARKER_FILE));
  // The pointer rename was already synced. If this cleanup sync fails, a crash
  // can only resurrect the marker and block the gate; it cannot resurrect an
  // older passing pointer.
  await syncDirectory(directory).catch(() => {});
}

async function activationMarkerExists(directory: string): Promise<boolean> {
  try {
    await lstat(join(directory, ACTIVATION_MARKER_FILE));
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    return true;
  }
}

async function withStoreLock<T>(
  directory: string,
  operation: () => Promise<T>,
  testOnlyCleanupAfterCommit?: () => Promise<void>
): Promise<T> {
  const lockPath = join(directory, 'store.lock');
  const deadline = Date.now() + 5_000;
  let lock;
  while (lock === undefined) {
    try {
      const candidate = await open(lockPath, 'wx', 0o600);
      try {
        await candidate.sync();
        lock = candidate;
      } catch (error) {
        await candidate.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (!hasCode(error, 'EEXIST') || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  let completed = false;
  let value: T | undefined;
  let operationFailure: unknown;
  try {
    value = await operation();
    completed = true;
  } catch (error) {
    operationFailure = error;
  }
  let cleanupFailed = false;
  if (completed && testOnlyCleanupAfterCommit !== undefined) {
    try {
      await testOnlyCleanupAfterCommit();
    } catch {
      cleanupFailed = true;
    }
  }
  try {
    await lock.close();
  } catch {
    // A committed pointer remains the result even if lock cleanup fails.
  }
  if (!cleanupFailed) {
    try {
      await unlink(lockPath);
      await syncDirectory(directory);
    } catch {
      // Leaving the lock makes later writers fail closed; it cannot undo this commit.
    }
  }
  if (!completed) throw operationFailure;
  return value as T;
}

function parseStoredProfile(profile: StoredContractProfile): StoredContractProfile {
  try {
    const parsed = contractProfileSchema.parse(profile);
    if (
      parsed.profileKey !== computeContractProfileKey(parsed)
      || parsed.formalWriteGate !== computeFormalWriteGate(parsed)
    ) {
      throw new Error('invalid');
    }
    return parsed;
  } catch {
    throw new Error('CONTRACT_PROFILE_INVALID');
  }
}

async function currentRevisionForCas(directory: string): Promise<string | null> {
  try {
    if (await activationMarkerExists(directory)) throw new Error('indeterminate activation');
    const pointer = currentPointerSchema.parse(
      JSON.parse(await readRegularFileNoFollow(join(directory, 'current.json'))) as unknown
    );
    return pointer.revision;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw new Error('CONTRACT_PROFILE_CONFLICT');
  }
}

export async function writeContractProfile(
  directory: string,
  profile: StoredContractProfile,
  options: {
    readonly expectedRevision?: string | null;
    /** @internal deterministic fault injection for commit-point tests. */
    readonly testOnlySyncAfterPointerCommit?: (directory: string) => Promise<void>;
    /** @internal deterministic fault injection for post-commit lock cleanup tests. */
    readonly testOnlyStoreLockCleanupAfterCommit?: () => Promise<void>;
  } = {}
): Promise<ContractProfileState> {
  const parsed = parseStoredProfile(profile);
  let canonicalDirectory: string;
  try {
    canonicalDirectory = await resolveStoreDirectory(directory, true);
  } catch {
    throw new Error('CONTRACT_PROFILE_WRITE_FAILED');
  }

  try {
    return await withStoreLock(canonicalDirectory, async () => {
      if (Object.prototype.hasOwnProperty.call(options, 'expectedRevision')) {
        const currentRevision = await currentRevisionForCas(canonicalDirectory);
        if (currentRevision !== options.expectedRevision) {
          throw new Error('CONTRACT_PROFILE_CONFLICT');
        }
      }

      const revision = computeContractProfileRevision(parsed);
      const profileFile = profileFileName(parsed.profileKey, revision);
      const reportFile = reportFileName(parsed.profileKey, revision);
      const envelope = {
        schemaVersion: CONTRACT_PROFILE_SCHEMA_VERSION,
        profileKey: parsed.profileKey,
        revision,
        checksumSha256: revision,
        profile: parsed
      };
      const pointer = currentPointerSchema.parse({
        schemaVersion: CONTRACT_PROFILE_SCHEMA_VERSION,
        profileKey: parsed.profileKey,
        revision,
        checksumSha256: revision,
        profileFile,
        reportFile
      });

      await writeImmutable(join(canonicalDirectory, profileFile), canonicalJson(envelope));
      await writeImmutable(join(canonicalDirectory, reportFile), renderContractProfileMarkdown(parsed));
      await syncDirectory(canonicalDirectory);
      await writeActivationMarker(canonicalDirectory, pointer);
      await atomicWritePointer(
        canonicalDirectory,
        pointer,
        options.testOnlySyncAfterPointerCommit ?? syncDirectory
      );
      await removeActivationMarker(canonicalDirectory);
      return { profile: parsed, revision, pointer };
    }, options.testOnlyStoreLockCleanupAfterCommit);
  } catch (error) {
    if (error instanceof Error && error.message === 'CONTRACT_PROFILE_CONFLICT') throw error;
    throw new Error('CONTRACT_PROFILE_WRITE_FAILED');
  }
}

async function loadStateByKey(
  directory: string,
  expectedKey: string
): Promise<ContractProfileState | undefined> {
  try {
    const canonicalDirectory = await resolveStoreDirectory(directory, false);
    if (await activationMarkerExists(canonicalDirectory)) return undefined;
    const parsedExpectedKey = sha256Schema.parse(expectedKey);
    const pointer = currentPointerSchema.parse(
      JSON.parse(await readRegularFileNoFollow(join(canonicalDirectory, 'current.json'))) as unknown
    );
    const expectedProfileFile = profileFileName(pointer.profileKey, pointer.revision);
    const expectedReportFile = reportFileName(pointer.profileKey, pointer.revision);
    if (
      pointer.profileKey !== parsedExpectedKey
      || pointer.profileFile !== expectedProfileFile
      || pointer.reportFile !== expectedReportFile
      || pointer.checksumSha256 !== pointer.revision
    ) {
      return undefined;
    }
    const envelope = storedEnvelopeSchema.parse(
      JSON.parse(await readRegularFileNoFollow(
        join(canonicalDirectory, pointer.profileFile)
      )) as unknown
    );
    if (
      envelope.profileKey !== parsedExpectedKey
      || envelope.revision !== pointer.revision
      || envelope.checksumSha256 !== pointer.checksumSha256
      || envelope.profile.profileKey !== parsedExpectedKey
      || computeContractProfileRevision(envelope.profile) !== pointer.revision
      || computeContractProfileKey(envelope.profile) !== parsedExpectedKey
      || envelope.profile.formalWriteGate !== computeFormalWriteGate(envelope.profile)
    ) {
      return undefined;
    }
    const report = await readRegularFileNoFollow(join(canonicalDirectory, pointer.reportFile));
    if (report !== `${renderContractProfileMarkdown(envelope.profile)}\n`) return undefined;
    return { profile: envelope.profile, revision: pointer.revision, pointer };
  } catch {
    return undefined;
  }
}

export async function loadCurrentContractProfileState(
  directory: string,
  expected: ContractFingerprint
): Promise<ContractProfileState | undefined> {
  return loadContractProfileStateByKey(directory, computeContractProfileKey(expected));
}

export async function loadContractProfileStateByKey(
  directory: string,
  expectedKey: string
): Promise<ContractProfileState | undefined> {
  return loadStateByKey(directory, expectedKey);
}

export async function loadCurrentContractProfile(
  directory: string,
  expected: ContractFingerprint
): Promise<StoredContractProfile | undefined> {
  return (await loadCurrentContractProfileState(directory, expected))?.profile;
}

export async function loadContractProfileByKey(
  directory: string,
  expectedKey: string
): Promise<StoredContractProfile | undefined> {
  return (await loadContractProfileStateByKey(directory, expectedKey))?.profile;
}
