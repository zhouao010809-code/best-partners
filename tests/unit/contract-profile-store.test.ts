import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildContractProfile,
  canonicalJson,
  computeContractProfileKey,
  computeFormalWriteGate,
  loadCurrentContractProfile,
  writeContractProfile,
  type ContractProfileInput
} from '../../src/server/vault/contract-profile-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function profileInput(overrides: Partial<ContractProfileInput> = {}): ContractProfileInput {
  return {
    pluginId: 'obsidian-local-rest-api',
    pluginVersion: '5.1.0',
    obsidianVersion: '1.13.7',
    openApiSha256: 'a'.repeat(64),
    checkedAt: '2026-08-31T00:00:00.000Z',
    safeRead: true,
    safeReplace: true,
    safeCreate: true,
    safeRestore: true,
    safeDelete: true,
    rereadVerified: true,
    externalMutationObservation: 'passed',
    restartPersistence: 'passed',
    evidence: [
      'safeRead',
      'safeCreate',
      'safeReplace',
      'safeRestore',
      'safeDelete',
      'rereadVerified',
      'externalMutationObservation',
      'restartPersistence'
    ].map((operation) => ({
      operation: operation as ContractProfileInput['evidence'][number]['operation'],
      status: 'passed' as const,
      httpStatuses: [200],
      timestamp: '2026-08-31T00:00:00.000Z',
      reasonCode: 'EXECUTABLE_PROBE_PASSED',
      primitive: 'RAW_REREAD' as const
    })),
    ...overrides
  };
}

async function storeDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'contract-profile-store-'));
  roots.push(root);
  return join(root, 'contract-profiles');
}

describe('contract profile model', () => {
  it('canonicalizes nested objects independent of key insertion order', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: [3, { d: 4, c: 5 }] } }))
      .toBe('{"a":{"b":[3,{"c":5,"d":4}],"y":2},"z":1}');
  });

  it('derives a stable SHA-256 key over the exact fingerprint and OpenAPI hash', () => {
    const fingerprint = profileInput();
    const first = computeContractProfileKey(fingerprint);
    const second = computeContractProfileKey({
      openApiSha256: fingerprint.openApiSha256,
      obsidianVersion: fingerprint.obsidianVersion,
      pluginVersion: fingerprint.pluginVersion,
      pluginId: fingerprint.pluginId
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(computeContractProfileKey({ ...fingerprint, openApiSha256: 'b'.repeat(64) }))
      .not.toBe(first);
  });

  it('passes the formal gate only when every executable capability passed', () => {
    expect(computeFormalWriteGate(profileInput())).toBe('passed');
    for (const blocked of [
      { safeRead: false },
      { safeCreate: false },
      { safeReplace: false },
      { safeRestore: false },
      { safeDelete: false },
      { rereadVerified: false },
      { externalMutationObservation: 'unverified' as const },
      { restartPersistence: 'failed' as const }
    ]) {
      expect(computeFormalWriteGate(profileInput(blocked))).toBe('blocked');
    }
  });

  it('blocks true capability flags that have no corresponding passed executable evidence', () => {
    expect(computeFormalWriteGate(profileInput({ evidence: [] }))).toBe('blocked');
    expect(buildContractProfile(profileInput({ evidence: [] })).formalWriteGate).toBe('blocked');
  });

  it('builds schema-versioned profiles and rejects unsanitized evidence', () => {
    const built = buildContractProfile(profileInput());
    expect(built.schemaVersion).toBe(1);
    expect(built.profileKey).toBe(computeContractProfileKey(built));
    expect(built.formalWriteGate).toBe('passed');
    expect(() => buildContractProfile(profileInput({
      evidence: [{
        operation: 'safeRead',
        status: 'failed',
        timestamp: '2026-08-31T00:00:00.000Z',
        reasonCode: 'contains secret-api-key'
      }]
    }))).toThrowError('CONTRACT_PROFILE_INVALID');
  });
});

describe('contract profile store', () => {
  it('writes directory 0700 and atomically replaces 0600 keyed/current files', async () => {
    const directory = await storeDirectory();
    const first = buildContractProfile(profileInput({ safeDelete: false }));
    await writeContractProfile(directory, first);
    const second = buildContractProfile(profileInput({
      safeDelete: true,
      checkedAt: '2026-08-31T01:00:00.000Z'
    }));
    await writeContractProfile(directory, second);

    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const files = await readdir(directory);
    expect(files.some((name) => name.includes('.tmp'))).toBe(false);
    for (const name of files) {
      expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
    }
    await expect(loadCurrentContractProfile(directory, second)).resolves.toEqual(second);
  });

  it('fails closed for checksum corruption, invalid schema, and fingerprint mismatch', async () => {
    const directory = await storeDirectory();
    const profile = buildContractProfile(profileInput());
    await writeContractProfile(directory, profile);
    const profilePath = join(directory, `${profile.profileKey}.json`);
    const serialized = await readFile(profilePath, 'utf8');
    await writeFile(profilePath, serialized.replace('EXECUTABLE_PROBE_PASSED', 'EXECUTABLE_PROBE_CHANGED'));
    await chmod(profilePath, 0o600);
    await expect(loadCurrentContractProfile(directory, profile)).resolves.toBeUndefined();

    await writeContractProfile(directory, profile);
    await writeFile(join(directory, 'current.json'), '{"schemaVersion":2,"profileKey":"bad"}\n', { mode: 0o600 });
    await expect(loadCurrentContractProfile(directory, profile)).resolves.toBeUndefined();

    await writeContractProfile(directory, profile);
    await expect(loadCurrentContractProfile(directory, {
      ...profile,
      pluginVersion: '5.2.0'
    })).resolves.toBeUndefined();
  });

  it('does not serialize a supplied secret marker, content, or path', async () => {
    const directory = await storeDirectory();
    const secret = 'unique-contract-api-key-marker';
    const note = '/private/test-vault/secret-note.md';
    const body = 'unique private note bytes';
    const profile = buildContractProfile(profileInput());
    await writeContractProfile(directory, profile);
    const serializedFiles = await Promise.all(
      (await readdir(directory)).map((name) => readFile(join(directory, name), 'utf8'))
    );
    const serialized = serializedFiles.join('\n');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(note);
    expect(serialized).not.toContain(body);
  });

  it('returns undefined rather than leaking parse errors or missing paths', async () => {
    const directory = await storeDirectory();
    const profile = buildContractProfile(profileInput());
    await expect(loadCurrentContractProfile(directory, profile)).resolves.toBeUndefined();
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'current.json'), 'secret-api-key malformed json');
    let thrown: unknown;
    try {
      await loadCurrentContractProfile(directory, profile);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUndefined();
  });
});
