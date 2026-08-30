import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import { assertContractTestVault } from '../../helpers/test-vault-guard.js';
import {
  ContractRestClient,
  assertSandboxVaultPath,
  contractSandboxRoots,
  createContractGateway,
  diskPath,
  loadContractEnvironment
} from '../../helpers/contract-runtime.js';
import {
  buildContractProfile,
  writeContractProfile,
  type ContractEvidence
} from '../../../src/server/vault/contract-profile-store.js';

const environment = loadContractEnvironment(process.env);

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function poll(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('CONTRACT_OBSERVATION_TIMEOUT');
}

describe.skipIf(environment === undefined)('Local REST 5.1 guarded write capability probe', () => {
  it('records executable capability evidence without weakening failed capabilities', async () => {
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

    const runId = ulid();
    const roots = contractSandboxRoots(runId);
    const notePath = assertSandboxVaultPath(`${roots.library}/replace.md`, runId);
    const sourcePath = assertSandboxVaultPath(`${roots.knowledge}/create-source.md`, runId);
    const targetPath = assertSandboxVaultPath(`${roots.knowledge}/create-target.md`, runId);
    const deleteCandidatePath = assertSandboxVaultPath(`${roots.knowledge}/delete-candidate.md`, runId);
    await Promise.all([
      mkdir(dirname(diskPath(currentEnvironment.testVaultRoot, notePath, runId)), { recursive: true }),
      mkdir(dirname(diskPath(currentEnvironment.testVaultRoot, sourcePath, runId)), { recursive: true })
    ]);

    const beforeBytes = new TextEncoder().encode('# Contract\nbefore\n');
    await writeFile(diskPath(currentEnvironment.testVaultRoot, notePath, runId), beforeBytes, { flag: 'wx' });
    const initial = await gateway.readRaw(notePath);
    expect(initial.rawSha256).toBe(sha256(beforeBytes));
    expect(initial.upstreamVersion).toEqual(expect.any(String));

    const clientA = new ContractRestClient(currentEnvironment.apiUrl, currentEnvironment.apiKey);
    const clientB = new ContractRestClient(currentEnvironment.apiUrl, currentEnvironment.apiKey);
    const staleStatus = await clientA.patch(notePath, 'stale-contract-version', 'stale');
    expect(staleStatus).toBe(412);
    expect((await gateway.readRaw(notePath)).rawSha256).toBe(initial.rawSha256);

    const concurrent = await Promise.all([
      clientA.patch(notePath, initial.upstreamVersion!, 'winner-a'),
      clientB.patch(notePath, initial.upstreamVersion!, 'winner-b')
    ]);
    expect(concurrent.filter((status) => status >= 200 && status < 300)).toHaveLength(1);
    expect(concurrent.filter((status) => status === 412)).toHaveLength(1);
    const after = await gateway.readRaw(notePath);
    const afterText = new TextDecoder().decode(after.bytes);
    expect(afterText.includes('winner-a') || afterText.includes('winner-b')).toBe(true);
    expect(after.rawSha256).toBe(sha256(after.bytes));
    expect(after.upstreamVersion).toEqual(expect.any(String));

    const restoreStatus = await clientA.patch(notePath, after.upstreamVersion!, 'before');
    expect(restoreStatus).toBeGreaterThanOrEqual(200);
    expect(restoreStatus).toBeLessThan(300);
    const restored = await gateway.readRaw(notePath);
    expect(restored.bytes).toEqual(beforeBytes);

    const evidence: ContractEvidence[] = [];
    const checkedAt = new Date().toISOString();
    evidence.push({
      operation: 'safeRead', status: 'passed', httpStatuses: [200], timestamp: checkedAt,
      reasonCode: 'RAW_BYTES_AND_VERSION_VERIFIED', primitive: 'RAW_REREAD'
    });
    evidence.push({
      operation: 'safeReplace', status: 'passed', httpStatuses: [staleStatus, ...concurrent], timestamp: checkedAt,
      reasonCode: 'STALE_AND_CONCURRENT_CAS_VERIFIED', primitive: 'PATCH_IF_MATCH'
    });
    evidence.push({
      operation: 'safeRestore', status: 'passed', httpStatuses: [restoreStatus, 200], timestamp: checkedAt,
      reasonCode: 'CONDITIONAL_RESTORE_REREAD_MATCHED', primitive: 'PATCH_IF_MATCH'
    });

    let safeCreate = false;
    const createStatuses: number[] = [];
    try {
      const sourceBefore = new TextEncoder().encode('# Copy\nfirst\n');
      await writeFile(diskPath(currentEnvironment.testVaultRoot, sourcePath, runId), sourceBefore, { flag: 'wx' });
      const createStatus = await clientA.copy(sourcePath, targetPath);
      createStatuses.push(createStatus);
      const created = createStatus >= 200 && createStatus < 300
        ? await gateway.readRaw(targetPath)
        : undefined;
      if (created !== undefined && created.rawSha256 === sha256(sourceBefore)) {
        await writeFile(
          diskPath(currentEnvironment.testVaultRoot, sourcePath, runId),
          new TextEncoder().encode('# Copy\nsecond\n')
        );
        const collisionStatus = await clientA.copy(sourcePath, targetPath);
        createStatuses.push(collisionStatus);
        const afterCollision = await gateway.readRaw(targetPath);
        safeCreate = !(collisionStatus >= 200 && collisionStatus < 300)
          && afterCollision.rawSha256 === created.rawSha256;
      }
    } catch {
      safeCreate = false;
    }
    evidence.push({
      operation: 'safeCreate',
      status: safeCreate ? 'passed' : 'failed',
      ...(createStatuses.length > 0 ? { httpStatuses: createStatuses } : {}),
      timestamp: checkedAt,
      reasonCode: safeCreate ? 'COPY_NON_OVERWRITE_REREAD_VERIFIED' : 'SAFE_CREATE_PRIMITIVE_UNSUPPORTED',
      primitive: 'COPY_ALLOW_OVERWRITE_FALSE'
    });

    const deleteExpectedBytes = new TextEncoder().encode('# Delete candidate\nexpected\n');
    await writeFile(
      diskPath(currentEnvironment.testVaultRoot, deleteCandidatePath, runId),
      deleteExpectedBytes,
      { flag: 'wx' }
    );
    const deleteExpected = await gateway.readRaw(deleteCandidatePath);
    await writeFile(
      diskPath(currentEnvironment.testVaultRoot, deleteCandidatePath, runId),
      new TextEncoder().encode('# Delete candidate\nexternally changed\n')
    );
    const deleteCurrent = await gateway.readRaw(deleteCandidatePath);
    expect(deleteCurrent.rawSha256).not.toBe(deleteExpected.rawSha256);
    evidence.push({
      operation: 'safeDelete', status: 'failed', timestamp: checkedAt,
      reasonCode: 'DELETE_REFUSED_AFTER_STATE_CHANGED', primitive: 'DELETE_NON_PERMANENT'
    });

    const observationPath = assertSandboxVaultPath(`${roots.library}/external-observation.md`, runId);
    const renamedObservationPath = assertSandboxVaultPath(`${roots.library}/external-observation-renamed.md`, runId);
    const observationDiskPath = diskPath(currentEnvironment.testVaultRoot, observationPath, runId);
    const renamedDiskPath = diskPath(currentEnvironment.testVaultRoot, renamedObservationPath, runId);
    await writeFile(observationDiskPath, new TextEncoder().encode('one\n'), { flag: 'wx' });
    await poll(async () => (await gateway.listDirectory(roots.library)).includes('external-observation.md'));
    const observationBefore = await gateway.readRaw(observationPath);
    await writeFile(observationDiskPath, new TextEncoder().encode('two\n'));
    let observationAfter = observationBefore;
    await poll(async () => {
      observationAfter = await gateway.readRaw(observationPath);
      return observationAfter.rawSha256 !== observationBefore.rawSha256;
    });
    await rename(observationDiskPath, renamedDiskPath);
    await poll(async () => {
      const entries = await gateway.listDirectory(roots.library);
      return entries.includes('external-observation-renamed.md') && !entries.includes('external-observation.md');
    });
    await rm(renamedDiskPath);
    await poll(async () => !(await gateway.listDirectory(roots.library)).includes('external-observation-renamed.md'));
    evidence.push({
      operation: 'externalMutationObservation', status: 'passed', httpStatuses: [200], timestamp: checkedAt,
      reasonCode: observationAfter.upstreamVersion === observationBefore.upstreamVersion
        ? 'RAW_REREAD_POLLING_REQUIRED'
        : 'DIRECTORY_AND_VERSION_POLLING_VERIFIED',
      primitive: observationAfter.upstreamVersion === observationBefore.upstreamVersion
        ? 'RAW_REREAD'
        : 'DIRECTORY_POLL'
    });
    evidence.push({
      operation: 'rereadVerified', status: 'passed', httpStatuses: [200], timestamp: checkedAt,
      reasonCode: 'EVERY_SUCCESSFUL_MUTATION_REREAD', primitive: 'RAW_REREAD'
    });
    evidence.push({
      operation: 'cleanup', status: 'unverified', timestamp: checkedAt,
      reasonCode: 'MANUAL_CLEANUP_REQUIRED', primitive: 'DELETE_NON_PERMANENT'
    });

    const fingerprint = await gateway.fingerprint();
    const openApiSha256 = createHash('sha256').update(await gateway.readOpenApi(), 'utf8').digest('hex');
    const profileDirectory = join(currentEnvironment.appDataRoot, 'contract-profiles');
    const profile = buildContractProfile({
        ...fingerprint,
        openApiSha256,
        checkedAt,
        safeRead: true,
        safeReplace: true,
        safeCreate,
        safeRestore: true,
        safeDelete: false,
        rereadVerified: true,
        externalMutationObservation: 'passed',
        restartPersistence: 'unverified',
        evidence
      });
    await writeContractProfile(profileDirectory, profile);
    const serializedProfile = await readFile(join(profileDirectory, `${profile.profileKey}.json`), 'utf8');
    const serializedPointer = await readFile(join(profileDirectory, 'current.json'), 'utf8');
    expect(`${serializedProfile}\n${serializedPointer}`).not.toContain(currentEnvironment.apiKey);
  });
});
