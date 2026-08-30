import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { assertContractReadVault } from '../../helpers/test-vault-guard.js';
import {
  assertSandboxVaultPath,
  contractSandboxRoots,
  createContractGateway,
  requireContractEnvironment
} from '../../helpers/contract-runtime.js';
import {
  buildContractProfile,
  writeContractProfile
} from '../../../src/server/vault/contract-profile-store.js';

describe('Local REST 5.1 read contract', () => {
  it('persists a failed safeRead result rather than turning unsupported fidelity into a harness failure', async () => {
    const environment = requireContractEnvironment(process.env);
    const runId = process.env.OBSIDIAN_CONTRACT_FIXTURE_RUN_ID;
    if (runId === undefined) throw new Error('CONTRACT_READ_FIXTURE_MISSING');
    const gateway = createContractGateway(environment);
    const canonicalRoots = await assertContractReadVault({
      gateway,
      testVaultRoot: environment.testVaultRoot,
      formalVaultRoot: environment.formalVaultRoot,
      sourceRoot: environment.sourceRoot,
      appDataRoot: environment.appDataRoot
    });

    const fingerprint = await gateway.fingerprint();
    const openApi = await gateway.readOpenApi();
    const openApiSha256 = createHash('sha256').update(openApi, 'utf8').digest('hex');
    const expectedOpenApiSha256 = process.env.OBSIDIAN_EXPECTED_OPENAPI_SHA256;
    const compatible = fingerprint.pluginId === 'obsidian-local-rest-api'
      && fingerprint.pluginVersion.split('.')[0] === '5'
      && (expectedOpenApiSha256 === undefined || expectedOpenApiSha256 === openApiSha256);
    const checkedAt = new Date().toISOString();
    let safeRead = false;
    let reasonCode = compatible ? 'READ_FIDELITY_MISMATCH' : 'PLUGIN_CONTRACT_INCOMPATIBLE';
    let httpStatuses: number[] | undefined;

    if (compatible) {
      try {
        const roots = contractSandboxRoots(runId);
        const fixtureName = '只读 中文 #100%.md';
        const fixturePath = assertSandboxVaultPath(`${roots.library}/${fixtureName}`, runId);
        const directory = await gateway.listDirectory(roots.library);
        const raw = await gateway.readRaw(fixturePath);
        const expected = new TextEncoder().encode('\uFEFF# 合约\r\n内容\r\n');
        const serializedFacts = JSON.stringify({
          fingerprint,
          directory,
          rawSha256: raw.rawSha256,
          version: raw.upstreamVersion
        });
        if (serializedFacts.includes(environment.apiKey)) {
          throw new Error('CONTRACT_SECRET_LEAK');
        }
        safeRead = directory.includes(fixtureName)
          && raw.bytes.length === expected.length
          && raw.bytes.every((value, index) => value === expected[index])
          && typeof raw.upstreamVersion === 'string'
          && raw.upstreamVersion.length > 0;
        reasonCode = safeRead ? 'READ_FIDELITY_VERIFIED' : 'READ_FIDELITY_MISMATCH';
        httpStatuses = [200];
      } catch (error) {
        if (error instanceof Error && error.message === 'CONTRACT_SECRET_LEAK') throw error;
        safeRead = false;
        reasonCode = 'READ_CAPABILITY_PROBE_FAILED';
      }
    }

    await writeContractProfile(
      join(canonicalRoots.appDataRoot, 'contract-profiles'),
      buildContractProfile({
        ...fingerprint,
        openApiSha256,
        checkedAt,
        safeRead,
        safeReplace: false,
        safeCreate: false,
        safeRestore: false,
        safeDelete: false,
        rereadVerified: false,
        externalMutationObservation: 'unverified',
        restartPersistence: 'unverified',
        evidence: [
          {
            operation: 'safeRead',
            status: safeRead ? 'passed' : 'failed',
            ...(httpStatuses === undefined ? {} : { httpStatuses }),
            timestamp: checkedAt,
            reasonCode,
            primitive: 'RAW_REREAD'
          },
          {
            operation: 'rereadVerified',
            status: 'unverified',
            timestamp: checkedAt,
            reasonCode: 'NO_MUTATION_REREAD_EVIDENCE',
            primitive: 'RAW_REREAD'
          }
        ]
      })
    );
  });
});
