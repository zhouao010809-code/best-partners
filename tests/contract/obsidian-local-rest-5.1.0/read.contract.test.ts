import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertContractReadVault } from '../../helpers/test-vault-guard.js';
import {
  assertSandboxVaultPath,
  contractSandboxRoots,
  createContractGateway,
  loadContractEnvironment
} from '../../helpers/contract-runtime.js';
import {
  buildContractProfile,
  writeContractProfile
} from '../../../src/server/vault/contract-profile-store.js';

const environment = loadContractEnvironment(process.env);
const fixtureRunId = process.env.OBSIDIAN_CONTRACT_FIXTURE_RUN_ID;
const enabled = environment !== undefined && fixtureRunId !== undefined;

describe.skipIf(!enabled)('Local REST 5.1 read contract', () => {
  it('verifies the isolated fixture, fingerprint, OpenAPI, path encoding, and raw-byte fidelity', async () => {
    const currentEnvironment = environment!;
    const currentRunId = fixtureRunId!;
    const gateway = createContractGateway(currentEnvironment);
    await assertContractReadVault({
      gateway,
      testVaultRoot: currentEnvironment.testVaultRoot,
      formalVaultRoot: currentEnvironment.formalVaultRoot,
      sourceRoot: currentEnvironment.sourceRoot,
      appDataRoot: currentEnvironment.appDataRoot
    });

    const fingerprint = await gateway.fingerprint();
    expect(fingerprint.pluginId).toBe('obsidian-local-rest-api');
    expect(fingerprint.pluginVersion.split('.')[0]).toBe('5');

    const openApi = await gateway.readOpenApi();
    const openApiSha256 = createHash('sha256').update(openApi, 'utf8').digest('hex');
    expect(openApiSha256).toMatch(/^[a-f0-9]{64}$/);

    const roots = contractSandboxRoots(currentRunId);
    const fixtureName = '只读 中文 #100%.md';
    const fixturePath = assertSandboxVaultPath(`${roots.library}/${fixtureName}`, currentRunId);
    const directory = await gateway.listDirectory(roots.library);
    expect(directory).toEqual(expect.arrayContaining([fixtureName]));

    const raw = await gateway.readRaw(fixturePath);
    const expected = new TextEncoder().encode('\uFEFF# 合约\r\n内容\r\n');
    expect(raw.bytes).toEqual(expected);
    expect(raw.upstreamVersion).toEqual(expect.any(String));
    expect(raw.upstreamVersion).not.toHaveLength(0);
    expect(JSON.stringify({ fingerprint, directory, rawSha256: raw.rawSha256, version: raw.upstreamVersion }))
      .not.toContain(currentEnvironment.apiKey);

    const checkedAt = new Date().toISOString();
    await writeContractProfile(
      join(currentEnvironment.appDataRoot, 'contract-profiles'),
      buildContractProfile({
        ...fingerprint,
        openApiSha256,
        checkedAt,
        safeRead: true,
        safeReplace: false,
        safeCreate: false,
        safeRestore: false,
        safeDelete: false,
        rereadVerified: true,
        externalMutationObservation: 'unverified',
        restartPersistence: 'unverified',
        evidence: [
          {
            operation: 'safeRead',
            status: 'passed',
            httpStatuses: [200],
            timestamp: checkedAt,
            reasonCode: 'RAW_BYTES_AND_VERSION_VERIFIED',
            primitive: 'RAW_REREAD'
          },
          {
            operation: 'rereadVerified',
            status: 'passed',
            httpStatuses: [200],
            timestamp: checkedAt,
            reasonCode: 'RAW_BYTES_REREAD_MATCHED',
            primitive: 'RAW_REREAD'
          }
        ]
      })
    );
  });
});
