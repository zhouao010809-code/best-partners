import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import { assertContractTestVault } from '../../helpers/test-vault-guard.js';
import {
  assertSandboxVaultPath,
  contractSandboxRoots,
  createContractGateway,
  diskPath,
  loadContractEnvironment
} from '../../helpers/contract-runtime.js';
import { writeRestartPending } from '../../helpers/restart-pending.js';
import {
  buildContractProfile,
  computeContractProfileKey,
  loadContractProfileByKey,
  writeContractProfile
} from '../../../src/server/vault/contract-profile-store.js';

const environment = loadContractEnvironment(process.env);

describe.skipIf(environment === undefined)('Local REST restart persistence prepare', () => {
  it('guards, creates one sandbox note, and records only sanitized restart facts', async () => {
    const currentEnvironment = environment!;
    const gateway = createContractGateway(currentEnvironment);
    await assertContractTestVault({
      gateway,
      testVaultRoot: currentEnvironment.testVaultRoot,
      formalVaultRoot: currentEnvironment.formalVaultRoot,
      sourceRoot: currentEnvironment.sourceRoot,
      appDataRoot: currentEnvironment.appDataRoot,
      allowWrite: process.env.ALLOW_OBSIDIAN_CONTRACT_WRITE
    });

    const fingerprint = await gateway.fingerprint();
    const openApiSha256 = createHash('sha256').update(await gateway.readOpenApi(), 'utf8').digest('hex');
    const profileKey = computeContractProfileKey({ ...fingerprint, openApiSha256 });
    const profileDirectory = join(currentEnvironment.appDataRoot, 'contract-profiles');
    const existing = await loadContractProfileByKey(profileDirectory, profileKey);
    expect(existing).toBeDefined();
    const profile = existing!;
    const {
      schemaVersion: _schemaVersion,
      profileKey: _profileKey,
      formalWriteGate: _formalWriteGate,
      restartCheckedAt: _restartCheckedAt,
      ...profileInput
    } = profile;
    await writeContractProfile(profileDirectory, buildContractProfile({
      ...profileInput,
      restartPersistence: 'unverified',
      evidence: [
        ...profile.evidence.filter((record) => record.operation !== 'restartPersistence'),
        {
          operation: 'restartPersistence',
          status: 'unverified',
          timestamp: new Date().toISOString(),
          reasonCode: 'PREPARED_AWAITING_RESTART',
          primitive: 'RAW_REREAD'
        }
      ]
    }));

    const runId = ulid();
    const noteId = 'restart.md';
    const notePath = assertSandboxVaultPath(`${contractSandboxRoots(runId).library}/${noteId}`, runId);
    const noteDiskPath = diskPath(currentEnvironment.testVaultRoot, notePath, runId);
    await mkdir(dirname(noteDiskPath), { recursive: true });
    const bytes = new TextEncoder().encode('# Restart contract\npersist\n');
    await writeFile(noteDiskPath, bytes, { flag: 'wx' });
    const observed = await gateway.readRaw(notePath);
    expect(observed.rawSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(observed.upstreamVersion).toEqual(expect.any(String));

    await writeRestartPending(profileDirectory, {
      schemaVersion: 1,
      runId,
      root: 'library',
      noteId,
      rawSha256: observed.rawSha256,
      upstreamVersion: observed.upstreamVersion!,
      profileKey
    });
    process.stdout.write('Restart Obsidian, then run npm run test:contract:obsidian:restart:verify\n');
  });
});
