import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ulid } from 'ulid';
import { describe, it } from 'vitest';
import { assertContractTestVault } from '../../helpers/test-vault-guard.js';
import {
  assertSandboxVaultPath,
  contractSandboxRoots,
  createContractGateway,
  diskPath,
  requireContractEnvironment
} from '../../helpers/contract-runtime.js';
import { writeRestartPending } from '../../helpers/restart-pending.js';
import {
  buildContractProfile,
  computeContractProfileKey,
  loadContractProfileByKey,
  writeContractProfile
} from '../../../src/server/vault/contract-profile-store.js';

describe('Local REST restart persistence prepare', () => {
  it('guards, creates one sandbox note, and records only sanitized restart facts', async () => {
    const currentEnvironment = requireContractEnvironment(process.env);
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
    if (fingerprint.pluginId !== 'obsidian-local-rest-api' || fingerprint.pluginVersion.split('.')[0] !== '5') {
      throw new Error('PLUGIN_CONTRACT_INCOMPATIBLE');
    }
    const openApiSha256 = createHash('sha256').update(await gateway.readOpenApi(), 'utf8').digest('hex');
    const expectedOpenApiSha256 = process.env.OBSIDIAN_EXPECTED_OPENAPI_SHA256;
    if (expectedOpenApiSha256 !== undefined && expectedOpenApiSha256 !== openApiSha256) {
      throw new Error('OPENAPI_FINGERPRINT_MISMATCH');
    }
    const profileKey = computeContractProfileKey({ ...fingerprint, openApiSha256 });
    const profileDirectory = join(currentEnvironment.appDataRoot, 'contract-profiles');
    const existing = await loadContractProfileByKey(profileDirectory, profileKey);
    if (existing === undefined) throw new Error('RESTART_PROFILE_UNAVAILABLE');
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
    if (
      observed.rawSha256 !== createHash('sha256').update(bytes).digest('hex')
      || observed.upstreamVersion === undefined
    ) {
      throw new Error('RESTART_PREPARE_READ_MISMATCH');
    }

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
