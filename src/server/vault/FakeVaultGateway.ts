import type { OpenableVaultGateway, VaultCapabilityProfile, VersionedBytes } from './VaultGateway.js';
import { sha256Bytes } from './raw-bytes.js';

export type FakeVaultFixture = string | Uint8Array | {
  readonly bytes: Uint8Array;
  readonly upstreamVersion?: string;
};

type StoredFixture = {
  bytes: Uint8Array;
  upstreamVersion?: string;
};

const encoder = new TextEncoder();

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('VAULT_REQUEST_ABORTED');
}

function fixtureBytes(fixture: string | Uint8Array): Uint8Array {
  return typeof fixture === 'string' ? encoder.encode(fixture) : new Uint8Array(fixture);
}

function normalizeFixture(fixture: FakeVaultFixture): StoredFixture {
  if (typeof fixture === 'string' || fixture instanceof Uint8Array) {
    return { bytes: fixtureBytes(fixture) };
  }
  return {
    bytes: new Uint8Array(fixture.bytes),
    ...(fixture.upstreamVersion === undefined ? {} : { upstreamVersion: fixture.upstreamVersion })
  };
}

export class FakeVaultGateway implements OpenableVaultGateway {
  readonly rawReadPaths: string[] = [];
  readonly openedPaths: string[] = [];
  private readonly fixtures = new Map<string, StoredFixture>();
  private readonly readFailures = new Map<string, Error>();
  private readonly malformedDirectoryEntries = new Map<string, string[]>();

  constructor(fixtures: Readonly<Record<string, FakeVaultFixture>> = {}) {
    for (const [path, fixture] of Object.entries(fixtures)) {
      this.fixtures.set(path, normalizeFixture(fixture));
    }
  }

  async fingerprint(): Promise<Pick<VaultCapabilityProfile, 'pluginId' | 'pluginVersion' | 'obsidianVersion'>> {
    return { pluginId: 'fake-local-rest-api', pluginVersion: '5.1.0', obsidianVersion: '1.8.10' };
  }

  async listDirectory(path: string, signal?: AbortSignal): Promise<ReadonlyArray<string>> {
    assertNotAborted(signal);
    const prefix = `${path.replace(/\/+$/, '')}/`;
    const entries = new Set<string>();
    for (const fixturePath of this.fixtures.keys()) {
      if (!fixturePath.startsWith(prefix)) continue;
      const remainder = fixturePath.slice(prefix.length);
      if (remainder.length === 0) continue;
      const separator = remainder.indexOf('/');
      entries.add(separator === -1 ? remainder : `${remainder.slice(0, separator)}/`);
    }
    return [
      ...entries,
      ...(this.malformedDirectoryEntries.get(path) ?? [])
    ].sort();
  }

  async readRaw(path: string, signal?: AbortSignal): Promise<VersionedBytes> {
    assertNotAborted(signal);
    this.rawReadPaths.push(path);
    const failure = this.readFailures.get(path);
    if (failure !== undefined) {
      this.readFailures.delete(path);
      throw failure;
    }
    const fixture = this.fixtures.get(path);
    if (fixture === undefined) throw new Error(`FIXTURE_NOT_FOUND: ${path}`);
    const bytes = new Uint8Array(fixture.bytes);
    return {
      path,
      bytes,
      rawSha256: sha256Bytes(bytes),
      ...(fixture.upstreamVersion === undefined ? {} : { upstreamVersion: fixture.upstreamVersion })
    };
  }

  async readOpenApi(): Promise<string> {
    return 'openapi: 3.0.0\n';
  }

  async openInObsidian(path: string, signal?: AbortSignal): Promise<void> {
    assertNotAborted(signal);
    if (!this.fixtures.has(path)) throw new Error(`FIXTURE_NOT_FOUND: ${path}`);
    this.openedPaths.push(path);
  }

  mutateFixture(
    path: string,
    markdown: string | Uint8Array,
    upstreamVersion?: string
  ): void {
    this.fixtures.set(path, {
      bytes: fixtureBytes(markdown),
      ...(upstreamVersion === undefined ? {} : { upstreamVersion })
    });
  }

  renameFixture(from: string, to: string, upstreamVersion?: string): void {
    const fixture = this.fixtures.get(from);
    if (fixture === undefined) throw new Error(`FIXTURE_NOT_FOUND: ${from}`);
    this.fixtures.delete(from);
    this.fixtures.set(to, {
      bytes: new Uint8Array(fixture.bytes),
      ...(upstreamVersion === undefined
        ? (fixture.upstreamVersion === undefined ? {} : { upstreamVersion: fixture.upstreamVersion })
        : { upstreamVersion })
    });
  }

  deleteFixture(path: string): void {
    this.fixtures.delete(path);
  }

  failNextRead(path: string, error: Error): void {
    this.readFailures.set(path, error);
  }

  addMalformedDirectoryEntry(directory: string, entry: string): void {
    const entries = this.malformedDirectoryEntries.get(directory) ?? [];
    entries.push(entry);
    this.malformedDirectoryEntries.set(directory, entries);
  }
}
