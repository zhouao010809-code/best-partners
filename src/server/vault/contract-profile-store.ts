import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
const reasonCodeSchema = z.string().min(1).max(128).regex(/^[A-Z0-9_:-]+$/);

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
  checksumSha256: sha256Schema,
  profile: contractProfileSchema
}).strict();

const currentPointerSchema = z.object({
  schemaVersion: z.literal(CONTRACT_PROFILE_SCHEMA_VERSION),
  profileKey: sha256Schema
}).strict();

export type ContractCapabilityStatus = z.infer<typeof capabilityStatusSchema>;
export type ContractEvidence = z.infer<typeof contractEvidenceSchema>;
export type ContractProfileInput = z.infer<typeof profileInputSchema>;
export type StoredContractProfile = z.infer<typeof contractProfileSchema>;
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
  const passedEvidence = new Set(
    input.evidence
      .filter((record) => record.status === 'passed')
      .map((record) => record.operation)
  );
  const allExecutableEvidencePassed = [
    'safeRead',
    'safeCreate',
    'safeReplace',
    'safeRestore',
    'safeDelete',
    'rereadVerified',
    'externalMutationObservation',
    'restartPersistence'
  ].every((operation) => passedEvidence.has(operation as ContractEvidence['operation']));
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
    return [
      operation,
      current?.status ?? 'unverified',
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

async function atomicWrite(path: string, value: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${value}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch {
    try {
      await unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw new Error('CONTRACT_PROFILE_WRITE_FAILED');
  }
}

export async function writeContractProfile(
  directory: string,
  profile: StoredContractProfile
): Promise<void> {
  let parsed: StoredContractProfile;
  try {
    parsed = contractProfileSchema.parse(profile);
    if (
      parsed.profileKey !== computeContractProfileKey(parsed)
      || parsed.formalWriteGate !== computeFormalWriteGate(parsed)
    ) {
      throw new Error('invalid');
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  } catch {
    throw new Error('CONTRACT_PROFILE_INVALID');
  }

  const envelope = {
    schemaVersion: CONTRACT_PROFILE_SCHEMA_VERSION,
    checksumSha256: sha256(canonicalJson(parsed)),
    profile: parsed
  };
  await atomicWrite(join(directory, `${parsed.profileKey}.json`), canonicalJson(envelope));
  await atomicWrite(join(directory, 'report.md'), renderContractProfileMarkdown(parsed));
  await atomicWrite(join(directory, 'current.json'), canonicalJson({
    schemaVersion: CONTRACT_PROFILE_SCHEMA_VERSION,
    profileKey: parsed.profileKey
  }));
}

export async function loadCurrentContractProfile(
  directory: string,
  expected: ContractFingerprint
): Promise<StoredContractProfile | undefined> {
  return loadContractProfileByKey(directory, computeContractProfileKey(expected));
}

export async function loadContractProfileByKey(
  directory: string,
  expectedKey: string
): Promise<StoredContractProfile | undefined> {
  try {
    const parsedExpectedKey = sha256Schema.parse(expectedKey);
    const pointer = currentPointerSchema.parse(
      JSON.parse(await readFile(join(directory, 'current.json'), 'utf8')) as unknown
    );
    if (pointer.profileKey !== parsedExpectedKey) {
      return undefined;
    }
    const envelope = storedEnvelopeSchema.parse(
      JSON.parse(await readFile(join(directory, `${pointer.profileKey}.json`), 'utf8')) as unknown
    );
    if (
      envelope.profile.profileKey !== parsedExpectedKey
      || envelope.checksumSha256 !== sha256(canonicalJson(envelope.profile))
      || computeContractProfileKey(envelope.profile) !== parsedExpectedKey
      || envelope.profile.formalWriteGate !== computeFormalWriteGate(envelope.profile)
    ) {
      return undefined;
    }
    return envelope.profile;
  } catch {
    return undefined;
  }
}
