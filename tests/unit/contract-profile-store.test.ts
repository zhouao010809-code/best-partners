import { afterEach, describe, expect, it } from 'vitest';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildContractProfile,
  canonicalJson,
  computeContractProfileKey,
  computeContractProfileRevision,
  computeFormalWriteGate,
  loadCurrentContractProfile,
  loadCurrentContractProfileState,
  renderContractProfileMarkdown,
  writeContractProfile,
  type ContractProfileInput
} from '../../src/server/vault/contract-profile-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function profileInput(overrides: Partial<ContractProfileInput> = {}): ContractProfileInput {
  const primitiveByOperation = {
    safeRead: 'RAW_REREAD',
    safeCreate: 'PUT_REJECT_IF_CONTENT_PREEXISTS',
    safeReplace: 'PATCH_IF_MATCH',
    safeRestore: 'PATCH_IF_MATCH',
    safeDelete: 'DELETE_NON_PERMANENT',
    rereadVerified: 'RAW_REREAD',
    externalMutationObservation: 'DIRECTORY_POLL',
    restartPersistence: 'RAW_REREAD'
  } as const;
  const reasonByOperation = {
    safeDelete: 'CONDITIONAL_NONPERMANENT_DELETE_VERIFIED'
  } as const;
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
      reasonCode: operation in reasonByOperation
        ? reasonByOperation[operation as keyof typeof reasonByOperation]
        : 'EXECUTABLE_PROBE_PASSED',
      primitive: primitiveByOperation[operation as keyof typeof primitiveByOperation]
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

  it('uses only the latest evidence and requires the operation-specific primitive', () => {
    const base = profileInput();
    expect(computeFormalWriteGate({
      ...base,
      evidence: [
        ...base.evidence,
        {
          operation: 'safeReplace',
          status: 'failed',
          timestamp: '2026-08-31T01:00:00.000Z',
          reasonCode: 'LATEST_REPLACE_FAILED',
          primitive: 'PATCH_IF_MATCH'
        }
      ]
    })).toBe('blocked');
    expect(computeFormalWriteGate({
      ...base,
      evidence: [
        ...base.evidence.filter((record) => record.operation !== 'safeRestore'),
        {
          operation: 'safeRestore',
          status: 'passed',
          timestamp: '2026-08-31T01:00:00.000Z',
          reasonCode: 'WRONG_PRIMITIVE',
          primitive: 'RAW_REREAD'
        }
      ]
    })).toBe('blocked');
    expect(computeFormalWriteGate({
      ...base,
      evidence: [
        ...base.evidence.filter((record) => record.operation !== 'safeDelete'),
        {
          operation: 'safeDelete',
          status: 'passed',
          timestamp: '2026-08-31T01:00:00.000Z',
          reasonCode: 'UNCONDITIONAL_DELETE_ACCEPTED',
          primitive: 'DELETE_NON_PERMANENT'
        }
      ]
    })).toBe('blocked');
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

  it('renders a deterministic sanitized capability report', () => {
    const profile = buildContractProfile(profileInput());
    const report = renderContractProfileMarkdown(profile);
    expect(report).toContain(`# Contract capability profile ${profile.profileKey}`);
    expect(report).toContain('| safeCreate | PASSED |');
    expect(report).toContain('| restartPersistence | PASSED |');
    expect(report).toContain('| cleanup | UNVERIFIED |');
    expect(report).toContain('EXECUTABLE_PROBE_PASSED');
    expect(report).not.toContain('/private/');
  });

  it('reports unprobed capabilities as UNVERIFIED and explicit failures as FAILED', () => {
    const unprobed = buildContractProfile(profileInput({
      safeCreate: false,
      evidence: []
    }));
    expect(renderContractProfileMarkdown(unprobed)).toContain('| safeCreate | UNVERIFIED |');
    const failed = buildContractProfile(profileInput({
      safeCreate: false,
      evidence: [{
        operation: 'safeCreate',
        status: 'failed',
        timestamp: '2026-08-31T00:00:00.000Z',
        reasonCode: 'SAFE_CREATE_UNPROVEN'
      }]
    }));
    expect(renderContractProfileMarkdown(failed)).toContain('| safeCreate | FAILED |');
  });

  it('does not report passed evidence with the wrong primitive as PASSED', () => {
    const base = profileInput();
    const wrongPrimitive = buildContractProfile(profileInput({
      evidence: [
        ...base.evidence.filter((record) => record.operation !== 'safeRestore'),
        {
          operation: 'safeRestore',
          status: 'passed',
          timestamp: '2026-08-31T01:00:00.000Z',
          reasonCode: 'WRONG_PRIMITIVE',
          primitive: 'RAW_REREAD'
        }
      ]
    }));
    expect(renderContractProfileMarkdown(wrongPrimitive)).toContain('| safeRestore | FAILED |');
  });

  it('uses restartCheckedAt for the formal gate report timestamp when present', () => {
    const report = renderContractProfileMarkdown(buildContractProfile(profileInput({
      restartCheckedAt: '2026-08-31T02:00:00.000Z'
    })));
    expect(report).toContain(
      '| formalWriteGate | PASSED | 2026-08-31T02:00:00.000Z | FORMAL_GATE_PASSED |'
    );
  });
});

describe('contract profile store', () => {
  it('commits immutable 0600 profile/report revisions before atomically switching current', async () => {
    const directory = await storeDirectory();
    const first = buildContractProfile(profileInput({ safeDelete: false }));
    const firstState = await writeContractProfile(directory, first);
    const second = buildContractProfile(profileInput({
      safeDelete: true,
      checkedAt: '2026-08-31T01:00:00.000Z'
    }));
    const secondState = await writeContractProfile(directory, second);

    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const files = await readdir(directory);
    expect(files.some((name) => name.includes('.tmp'))).toBe(false);
    expect(files).not.toContain('activation-pending.json');
    expect(files).toEqual(expect.arrayContaining([
      firstState.pointer.profileFile,
      firstState.pointer.reportFile,
      secondState.pointer.profileFile,
      secondState.pointer.reportFile,
      'current.json'
    ]));
    for (const name of files) {
      expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
    }
    await expect(loadCurrentContractProfile(directory, second)).resolves.toEqual(second);
    await expect(loadCurrentContractProfileState(directory, second)).resolves.toEqual(secondState);
    expect(await readFile(join(directory, secondState.pointer.reportFile), 'utf8')).toBe(
      `${renderContractProfileMarkdown(second)}\n`
    );
    expect(JSON.parse(await readFile(join(directory, 'current.json'), 'utf8'))).toEqual(
      secondState.pointer
    );
  });

  it('fails closed for checksum corruption, invalid schema, and fingerprint mismatch', async () => {
    const directory = await storeDirectory();
    const profile = buildContractProfile(profileInput());
    const state = await writeContractProfile(directory, profile);
    await expect(loadCurrentContractProfile(directory, {
      ...profile,
      pluginVersion: '5.2.0'
    })).resolves.toBeUndefined();
    const profilePath = join(directory, state.pointer.profileFile);
    const serialized = await readFile(profilePath, 'utf8');
    await writeFile(profilePath, serialized.replace('EXECUTABLE_PROBE_PASSED', 'EXECUTABLE_PROBE_CHANGED'));
    await chmod(profilePath, 0o600);
    await expect(loadCurrentContractProfile(directory, profile)).resolves.toBeUndefined();

    await writeFile(join(directory, 'current.json'), '{"schemaVersion":2,"profileKey":"bad"}\n', { mode: 0o600 });
    await expect(loadCurrentContractProfile(directory, profile)).resolves.toBeUndefined();
  });

  it('does not activate a partially written revision when a pre-pointer write fails', async () => {
    const directory = await storeDirectory();
    const first = buildContractProfile(profileInput({ checkedAt: '2026-08-31T00:00:00.000Z' }));
    const firstState = await writeContractProfile(directory, first);
    const second = buildContractProfile(profileInput({ checkedAt: '2026-08-31T01:00:00.000Z' }));
    const secondRevision = computeContractProfileRevision(second);
    await mkdir(join(directory, `${second.profileKey}.${secondRevision}.md`));

    await expect(writeContractProfile(directory, second))
      .rejects.toThrowError('CONTRACT_PROFILE_WRITE_FAILED');
    await expect(loadCurrentContractProfileState(directory, first)).resolves.toEqual(firstState);
  });

  it.each(['profile', 'report'] as const)(
    'rejects a pre-existing immutable %s symlink without touching its external target',
    async (kind) => {
      const directory = await storeDirectory();
      await mkdir(directory, { mode: 0o700 });
      const profile = buildContractProfile(profileInput());
      const revision = computeContractProfileRevision(profile);
      const fileName = kind === 'profile'
        ? `${profile.profileKey}.${revision}.json`
        : `${profile.profileKey}.${revision}.md`;
      const serialized = kind === 'profile'
        ? `${canonicalJson({
            schemaVersion: 1,
            profileKey: profile.profileKey,
            revision,
            checksumSha256: revision,
            profile
          })}\n`
        : `${renderContractProfileMarkdown(profile)}\n`;
      const outside = join(directory, '..', `external-${kind}`);
      await writeFile(outside, serialized, { mode: 0o644 });
      await symlink(outside, join(directory, fileName));

      await expect(writeContractProfile(directory, profile))
        .rejects.toThrowError('CONTRACT_PROFILE_WRITE_FAILED');
      expect((await stat(outside)).mode & 0o777).toBe(0o644);
      await expect(readFile(outside, 'utf8')).resolves.toBe(serialized);
    }
  );

  it('rejects a pre-existing immutable hard link even when its bytes match', async () => {
    const directory = await storeDirectory();
    await mkdir(directory, { mode: 0o700 });
    const profile = buildContractProfile(profileInput());
    const revision = computeContractProfileRevision(profile);
    const serialized = `${canonicalJson({
      schemaVersion: 1,
      profileKey: profile.profileKey,
      revision,
      checksumSha256: revision,
      profile
    })}\n`;
    const outside = join(directory, '..', 'external-hardlink');
    await writeFile(outside, serialized, { mode: 0o644 });
    await link(outside, join(directory, `${profile.profileKey}.${revision}.json`));

    await expect(writeContractProfile(directory, profile))
      .rejects.toThrowError('CONTRACT_PROFILE_WRITE_FAILED');
    expect((await stat(outside)).mode & 0o777).toBe(0o644);
  });

  it.each(['pointer', 'profile', 'report'] as const)(
    'does not load a current state through a %s symlink',
    async (kind) => {
      const directory = await storeDirectory();
      const profile = buildContractProfile(profileInput());
      const state = await writeContractProfile(directory, profile);
      const fileName = kind === 'pointer'
        ? 'current.json'
        : kind === 'profile' ? state.pointer.profileFile : state.pointer.reportFile;
      const target = join(directory, fileName);
      const outside = join(directory, '..', `loader-${kind}`);
      await rename(target, outside);
      await symlink(outside, target);

      await expect(loadCurrentContractProfileState(directory, profile)).resolves.toBeUndefined();
    }
  );

  it('keeps the gate fail-closed when pointer directory sync fails after rename', async () => {
    const directory = await storeDirectory();
    const previous = buildContractProfile(profileInput({
      checkedAt: '2026-08-31T00:00:00.000Z'
    }));
    await writeContractProfile(directory, previous);
    const profile = buildContractProfile(profileInput({
      safeDelete: false,
      checkedAt: '2026-08-31T01:00:00.000Z'
    }));
    let syncAttempted = false;
    await expect(writeContractProfile(directory, profile, {
      testOnlySyncAfterPointerCommit: async () => {
        syncAttempted = true;
        throw new Error('injected post-commit sync failure');
      }
    })).rejects.toThrowError('CONTRACT_PROFILE_WRITE_FAILED');

    expect(syncAttempted).toBe(true);
    expect(await readdir(directory)).toContain('activation-pending.json');
    await expect(loadCurrentContractProfileState(directory, profile)).resolves.toBeUndefined();
    await expect(loadCurrentContractProfileState(directory, previous)).resolves.toBeUndefined();
  });

  it('does not report failure after commit when store-lock cleanup fails', async () => {
    const directory = await storeDirectory();
    const profile = buildContractProfile(profileInput());
    let cleanupAttempted = false;
    const committed = await writeContractProfile(directory, profile, {
      testOnlyStoreLockCleanupAfterCommit: async () => {
        cleanupAttempted = true;
        throw new Error('injected lock cleanup failure');
      }
    });

    expect(cleanupAttempted).toBe(true);
    expect(await readdir(directory)).toContain('store.lock');
    await expect(loadCurrentContractProfileState(directory, profile)).resolves.toEqual(committed);
  });

  it('serializes read-modify-write and rejects a stale expected revision', async () => {
    const directory = await storeDirectory();
    const initial = buildContractProfile(profileInput({ checkedAt: '2026-08-31T00:00:00.000Z' }));
    const initialState = await writeContractProfile(directory, initial);
    const left = buildContractProfile(profileInput({ checkedAt: '2026-08-31T01:00:00.000Z' }));
    const right = buildContractProfile(profileInput({ checkedAt: '2026-08-31T02:00:00.000Z' }));

    const settled = await Promise.allSettled([
      writeContractProfile(directory, left, { expectedRevision: initialState.revision }),
      writeContractProfile(directory, right, { expectedRevision: initialState.revision })
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected').map((result) => (
      String((result as PromiseRejectedResult).reason)
    ))).toEqual(['Error: CONTRACT_PROFILE_CONFLICT']);
    const current = await loadCurrentContractProfileState(directory, left)
      ?? await loadCurrentContractProfileState(directory, right);
    expect([left.checkedAt, right.checkedAt]).toContain(current?.profile.checkedAt);
    expect((await readdir(directory)).some((name) => name.endsWith('.lock'))).toBe(false);
  });

  it('distinguishes invalid profiles from filesystem write failures', async () => {
    const directory = await storeDirectory();
    const valid = buildContractProfile(profileInput());
    await expect(writeContractProfile(directory, { ...valid, pluginId: 'invalid secret value' }))
      .rejects.toThrowError('CONTRACT_PROFILE_INVALID');

    const blockedDirectory = await storeDirectory();
    await mkdir(join(blockedDirectory, '..'), { recursive: true });
    await writeFile(blockedDirectory, 'not a directory');
    await expect(writeContractProfile(blockedDirectory, valid))
      .rejects.toThrowError('CONTRACT_PROFILE_WRITE_FAILED');
  });

  it('rejects a symlinked profile directory for both writes and current loads', async () => {
    const base = await mkdtemp(join(tmpdir(), 'contract-profile-symlink-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    const outside = join(base, 'outside');
    await mkdir(outside);
    await symlink(outside, directory);
    const profile = buildContractProfile(profileInput());

    await expect(writeContractProfile(directory, profile))
      .rejects.toThrowError('CONTRACT_PROFILE_WRITE_FAILED');
    expect(await readdir(outside)).toEqual([]);

    await rm(directory);
    await writeContractProfile(outside, profile);
    await symlink(outside, directory);
    await expect(loadCurrentContractProfile(directory, profile)).resolves.toBeUndefined();
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
