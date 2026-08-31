import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import type { StateKernel } from '../db/database.js';
import {
  contractEvidencePassed,
  loadCurrentContractProfileState,
  type ContractFingerprint,
  type StoredContractProfile
} from '../vault/contract-profile-store.js';
import type { VaultGateway } from '../vault/VaultGateway.js';
import type { IndexState } from '../index/index-state.js';

const REQUIRED_CAPABILITIES = [
  'safeRead',
  'safeCreate',
  'safeReplace',
  'safeRestore',
  'safeDelete',
  'rereadVerified',
  'externalMutationObservation',
  'restartPersistence'
] as const;

type RequiredCapability = typeof REQUIRED_CAPABILITIES[number];

export interface HealthSnapshot {
  readonly status: 'ready' | 'recovery-only';
  readonly plugin: HealthPluginSnapshot;
  readonly index: HealthIndexSnapshot;
  readonly model: HealthModelSnapshot;
  readonly writeGate: {
    readonly status: 'blocked' | 'enabled';
    readonly missing: readonly string[];
    readonly fingerprintMatches: boolean;
  };
  readonly schemaIssues: HealthSchemaIssuesSnapshot;
}

export type HealthPluginSnapshot =
  | {
    readonly status: 'connected';
    readonly pluginId: string;
    readonly pluginVersion: string;
    readonly obsidianVersion: string;
  }
  | { readonly status: 'unavailable'; readonly reason: 'PLUGIN_UNAVAILABLE' };

export type HealthModelSnapshot =
  | {
    readonly status: 'configured';
    readonly providerHost: string;
    readonly name: string;
  }
  | { readonly status: 'unconfigured'; readonly providerHost: string }
  | { readonly status: 'unavailable'; readonly reason: 'CONFIG_UNAVAILABLE' };

export type HealthSchemaIssuesSnapshot =
  | { readonly status: 'available'; readonly count: number }
  | {
    readonly status: 'unavailable';
    readonly count: 0;
    readonly reason: 'INDEX_UNAVAILABLE' | 'SCHEMA_ISSUES_UNAVAILABLE';
  };

export type HealthIndexSnapshot =
  | { readonly status: 'building'; readonly startedAt: string }
  | { readonly status: 'ready'; readonly version: number; readonly refreshedAt: string }
  | {
    readonly status: 'stale';
    readonly version: number;
    readonly lastSuccessAt: string;
    readonly reason: 'INDEX_STALE';
  }
  | {
    readonly status: 'failed';
    readonly lastSuccessAt?: string;
    readonly reason: 'INDEX_FAILED';
  }
  | {
    readonly status: 'unavailable';
    readonly reason: 'RECOVERY_ONLY' | 'READ_API_UNAVAILABLE';
  };

export interface HealthIndexStateSource {
  snapshot(): IndexState | Extract<HealthIndexSnapshot, { status: 'unavailable' }>;
}

export interface HealthService {
  getSnapshot(): Promise<HealthSnapshot>;
}

function publicIndexSnapshot(
  snapshot: ReturnType<HealthIndexStateSource['snapshot']>
): HealthIndexSnapshot {
  switch (snapshot.status) {
    case 'building':
      return { status: 'building', startedAt: snapshot.startedAt };
    case 'ready':
      return {
        status: 'ready',
        version: snapshot.version,
        refreshedAt: snapshot.refreshedAt
      };
    case 'stale':
      return {
        status: 'stale',
        version: snapshot.version,
        lastSuccessAt: snapshot.lastSuccessAt,
        reason: 'INDEX_STALE'
      };
    case 'failed':
      return {
        status: 'failed',
        ...(snapshot.lastSuccessAt === undefined ? {} : { lastSuccessAt: snapshot.lastSuccessAt }),
        reason: 'INDEX_FAILED'
      };
    case 'unavailable':
      return snapshot;
  }
}

function fieldPassed(profile: StoredContractProfile, capability: RequiredCapability): boolean {
  switch (capability) {
    case 'externalMutationObservation':
    case 'restartPersistence':
      return profile[capability] === 'passed';
    default:
      return profile[capability];
  }
}

function missingCapabilities(profile: StoredContractProfile): RequiredCapability[] {
  return REQUIRED_CAPABILITIES.filter((capability) => (
    !fieldPassed(profile, capability)
    || !contractEvidencePassed(profile.evidence, capability)
  ));
}

async function databaseBlocker(stateKernel: StateKernel): Promise<'database' | 'recovery' | undefined> {
  if (stateKernel.mode === 'recovery-only') return 'database';
  try {
    const before = await lstat(stateKernel.recoveryDir);
    if (before.isSymbolicLink() || !before.isDirectory()) return 'recovery';
    const entries = await readdir(stateKernel.recoveryDir);
    if (entries.length > 0) return 'recovery';
    const after = await lstat(stateKernel.recoveryDir);
    if (
      after.isSymbolicLink()
      || !after.isDirectory()
      || after.dev !== before.dev
      || after.ino !== before.ino
    ) {
      return 'recovery';
    }
    return undefined;
  } catch {
    return 'recovery';
  }
}

type PluginFingerprint = Awaited<ReturnType<VaultGateway['fingerprint']>>;

function safePluginFingerprint(value: unknown): PluginFingerprint | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.pluginId !== 'string'
    || typeof candidate.pluginVersion !== 'string'
    || typeof candidate.obsidianVersion !== 'string'
    || !/^[a-z0-9._-]{1,128}$/iu.test(candidate.pluginId)
    || !/^[a-z0-9.+_-]{1,64}$/iu.test(candidate.pluginVersion)
    || !/^[a-z0-9.+_-]{1,64}$/iu.test(candidate.obsidianVersion)
  ) {
    return undefined;
  }
  return {
    pluginId: candidate.pluginId,
    pluginVersion: candidate.pluginVersion,
    obsidianVersion: candidate.obsidianVersion
  };
}

async function loadPluginAndProfile(input: {
  readonly gateway: Pick<VaultGateway, 'fingerprint' | 'readOpenApi'>;
  readonly profileDirectory: string;
}): Promise<{
  readonly plugin: HealthPluginSnapshot;
  readonly profile?: StoredContractProfile;
}> {
  const [pluginResult, openApiResult] = await Promise.allSettled([
    input.gateway.fingerprint(),
    input.gateway.readOpenApi()
  ]);
  const plugin = pluginResult.status === 'fulfilled'
    ? safePluginFingerprint(pluginResult.value)
    : undefined;
  if (plugin === undefined) {
    return { plugin: { status: 'unavailable', reason: 'PLUGIN_UNAVAILABLE' } };
  }
  const publicPlugin: HealthPluginSnapshot = {
    status: 'connected',
    pluginId: plugin.pluginId,
    pluginVersion: plugin.pluginVersion,
    obsidianVersion: plugin.obsidianVersion
  };
  if (openApiResult.status === 'rejected') return { plugin: publicPlugin };
  try {
    const fingerprint: ContractFingerprint = {
      pluginId: plugin.pluginId,
      pluginVersion: plugin.pluginVersion,
      obsidianVersion: plugin.obsidianVersion,
      openApiSha256: createHash('sha256').update(openApiResult.value, 'utf8').digest('hex')
    };
    const profile = (await loadCurrentContractProfileState(
      input.profileDirectory,
      fingerprint
    ))?.profile;
    return { plugin: publicPlugin, ...(profile === undefined ? {} : { profile }) };
  } catch {
    return { plugin: publicPlugin };
  }
}

function modelSnapshot(
  model: { readonly baseUrl: string; readonly name?: string } | undefined
): HealthModelSnapshot {
  if (model === undefined) return { status: 'unavailable', reason: 'CONFIG_UNAVAILABLE' };
  let providerHost: string;
  try {
    const url = new URL(model.baseUrl);
    if (url.protocol !== 'https:' || url.host.length === 0 || url.host.length > 253) {
      return { status: 'unavailable', reason: 'CONFIG_UNAVAILABLE' };
    }
    providerHost = url.host;
  } catch {
    return { status: 'unavailable', reason: 'CONFIG_UNAVAILABLE' };
  }
  if (model.name === undefined) return { status: 'unconfigured', providerHost };
  if (
    model.name.length === 0
    || model.name.length > 256
    || /[\u0000-\u001f\u007f]/u.test(model.name)
  ) {
    return { status: 'unavailable', reason: 'CONFIG_UNAVAILABLE' };
  }
  return { status: 'configured', providerHost, name: model.name };
}

function schemaIssuesSnapshot(input: {
  readonly unavailable: boolean;
  readonly source?: { count(): number };
}): HealthSchemaIssuesSnapshot {
  if (input.unavailable || input.source === undefined) {
    return { status: 'unavailable', count: 0, reason: 'INDEX_UNAVAILABLE' };
  }
  try {
    const count = input.source.count();
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('SCHEMA_ISSUES_INVALID');
    return { status: 'available', count };
  } catch {
    return { status: 'unavailable', count: 0, reason: 'SCHEMA_ISSUES_UNAVAILABLE' };
  }
}

export function createHealthService(input: {
  readonly writeEnabled: boolean;
  readonly gateway: Pick<VaultGateway, 'fingerprint' | 'readOpenApi'>;
  readonly profileDirectory: string;
  readonly stateKernel: StateKernel;
  readonly indexState: HealthIndexStateSource;
  readonly model?: {
    readonly baseUrl: string;
    readonly name?: string;
  };
  readonly schemaIssues?: { count(): number };
}): HealthService {
  return {
    getSnapshot: async () => {
      const [connection, blocker] = await Promise.all([
        loadPluginAndProfile(input),
        databaseBlocker(input.stateKernel)
      ]);
      const profile = connection.profile;
      const fingerprintMatches = profile !== undefined;
      const missing: string[] = profile === undefined
        ? ['profile']
        : missingCapabilities(profile);
      if (!input.writeEnabled) missing.push('writeEnabled');
      if (blocker !== undefined) missing.push(blocker);
      return {
        status: blocker === undefined ? 'ready' : 'recovery-only',
        plugin: connection.plugin,
        index: blocker === undefined
          ? publicIndexSnapshot(input.indexState.snapshot())
          : { status: 'unavailable', reason: 'RECOVERY_ONLY' },
        model: modelSnapshot(input.model),
        writeGate: {
          status: missing.length === 0 ? 'enabled' : 'blocked',
          missing,
          fingerprintMatches
        },
        schemaIssues: schemaIssuesSnapshot({
          unavailable: blocker !== undefined,
          ...(input.schemaIssues === undefined ? {} : { source: input.schemaIssues })
        })
      };
    }
  };
}
