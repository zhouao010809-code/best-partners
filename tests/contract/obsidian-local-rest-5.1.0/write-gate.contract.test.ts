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
  requireContractEnvironment
} from '../../helpers/contract-runtime.js';
import {
  buildWriteProbeProfile,
  type CapabilityResult
} from '../../helpers/write-probe-profile.js';
import {
  computeContractProfileKey,
  loadContractProfileByKey,
  writeContractProfile
} from '../../../src/server/vault/contract-profile-store.js';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function poll(check: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if (await check()) return true;
    } catch {
      // The external watcher may not have observed the change yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function result(
  operation: CapabilityResult['operation'],
  primitive: CapabilityResult['primitive'],
  status: CapabilityResult['status'],
  reasonCode: string,
  timestamp: string,
  httpStatuses?: number[]
): CapabilityResult {
  return { operation, primitive, status, reasonCode, timestamp, ...(httpStatuses ? { httpStatuses } : {}) };
}

describe('Local REST 5.1 guarded write capability probe', () => {
  it('persists negative capability evidence rather than failing the probe', async () => {
    const environment = requireContractEnvironment(process.env);
    const gateway = createContractGateway(environment);
    await assertContractTestVault({
      gateway,
      testVaultRoot: environment.testVaultRoot,
      formalVaultRoot: environment.formalVaultRoot,
      sourceRoot: environment.sourceRoot,
      appDataRoot: environment.appDataRoot,
      allowWrite: process.env.ALLOW_OBSIDIAN_CONTRACT_WRITE
    });

    const fingerprint = await gateway.fingerprint();
    const openApiSha256 = createHash('sha256').update(await gateway.readOpenApi(), 'utf8').digest('hex');
    const expectedOpenApiSha256 = process.env.OBSIDIAN_EXPECTED_OPENAPI_SHA256;
    const compatible = fingerprint.pluginId === 'obsidian-local-rest-api'
      && fingerprint.pluginVersion.split('.')[0] === '5'
      && /^[a-f0-9]{64}$/.test(openApiSha256)
      && (expectedOpenApiSha256 === undefined || expectedOpenApiSha256 === openApiSha256);
    const incompatibilityReason = fingerprint.pluginId !== 'obsidian-local-rest-api'
      || fingerprint.pluginVersion.split('.')[0] !== '5'
      ? 'PLUGIN_CONTRACT_INCOMPATIBLE'
      : 'OPENAPI_FINGERPRINT_MISMATCH';
    const checkedAt = new Date().toISOString();
    const profileDirectory = join(environment.appDataRoot, 'contract-profiles');
    const profileKey = computeContractProfileKey({ ...fingerprint, openApiSha256 });
    const priorReadProfile = compatible
      ? await loadContractProfileByKey(profileDirectory, profileKey)
      : undefined;
    const results: CapabilityResult[] = [];

    if (!compatible) {
      for (const [operation, primitive] of [
        ['safeCreate', 'PUT_REJECT_IF_CONTENT_PREEXISTS'],
        ['safeCreate', 'COPY_ALLOW_OVERWRITE_FALSE'],
        ['safeReplace', 'PATCH_IF_MATCH'],
        ['safeRestore', 'PATCH_IF_MATCH'],
        ['safeDelete', undefined],
        ['rereadVerified', 'RAW_REREAD'],
        ['externalMutationObservation', 'DIRECTORY_POLL']
      ] as const) {
        results.push(result(operation, primitive, 'failed', incompatibilityReason, checkedAt));
      }
      results.push(result('cleanup', undefined, 'passed', 'NO_SANDBOX_CREATED', checkedAt));
      await buildWriteProbeProfile({
        fingerprint,
        openApiSha256,
        checkedAt,
        results,
        persist: (profile) => writeContractProfile(profileDirectory, profile)
      });
      return;
    }

    const runId = ulid();
    const roots = contractSandboxRoots(runId);
    const paths = {
      note: assertSandboxVaultPath(`${roots.library}/replace.md`, runId),
      copySource: assertSandboxVaultPath(`${roots.knowledge}/copy-source.md`, runId),
      copyTarget: assertSandboxVaultPath(`${roots.knowledge}/copy-target.md`, runId),
      putTarget: assertSandboxVaultPath(`${roots.knowledge}/put-target.md`, runId),
      deleteCandidate: assertSandboxVaultPath(`${roots.knowledge}/delete-candidate.md`, runId),
      observation: assertSandboxVaultPath(`${roots.library}/external-observation.md`, runId),
      renamedObservation: assertSandboxVaultPath(`${roots.library}/external-observation-renamed.md`, runId)
    };
    await Promise.all([
      mkdir(dirname(diskPath(environment.testVaultRoot, paths.note, runId)), { recursive: true }),
      mkdir(dirname(diskPath(environment.testVaultRoot, paths.copySource, runId)), { recursive: true })
    ]);
    const clientA = new ContractRestClient(environment.apiUrl, environment.apiKey);
    const clientB = new ContractRestClient(environment.apiUrl, environment.apiKey);
    const beforeBytes = new TextEncoder().encode('# Contract\nbefore\n');
    let initial: Awaited<ReturnType<typeof gateway.readRaw>> | undefined;
    let after: Awaited<ReturnType<typeof gateway.readRaw>> | undefined;
    let mutationOccurred = false;
    let mutationRereadsComplete = true;

    try {
      await writeFile(diskPath(environment.testVaultRoot, paths.note, runId), beforeBytes, { flag: 'wx' });
      if (await poll(async () => (await gateway.readRaw(paths.note)).rawSha256 === sha256(beforeBytes))) {
        initial = await gateway.readRaw(paths.note);
      }
    } catch {
      initial = undefined;
    }

    if (initial?.upstreamVersion !== undefined) {
      try {
        const stale = await clientA.patch(paths.note, 'stale-contract-version', 'stale');
        mutationOccurred ||= stale >= 200 && stale < 300;
        const unchanged = await gateway.readRaw(paths.note);
        const concurrent = await Promise.all([
          clientA.patch(paths.note, initial.upstreamVersion, 'winner-a'),
          clientB.patch(paths.note, initial.upstreamVersion, 'winner-b')
        ]);
        mutationOccurred ||= concurrent.some((status) => status >= 200 && status < 300);
        after = await gateway.readRaw(paths.note);
        const text = new TextDecoder().decode(after.bytes);
        const passed = stale === 412
          && unchanged.rawSha256 === initial.rawSha256
          && concurrent.filter((status) => status >= 200 && status < 300).length === 1
          && concurrent.filter((status) => status === 412).length === 1
          && (text.includes('winner-a') || text.includes('winner-b'))
          && after.rawSha256 === sha256(after.bytes);
        results.push(result(
          'safeReplace', 'PATCH_IF_MATCH', passed ? 'passed' : 'failed',
          passed ? 'STALE_AND_CONCURRENT_CAS_VERIFIED' : 'PATCH_CAS_BEHAVIOR_MISMATCH',
          checkedAt, [stale, ...concurrent]
        ));
      } catch {
        mutationRereadsComplete = false;
        results.push(result('safeReplace', 'PATCH_IF_MATCH', 'failed', 'PATCH_CAS_PROBE_FAILED', checkedAt));
      }
    } else {
      results.push(result('safeReplace', 'PATCH_IF_MATCH', 'unverified', 'PATCH_SETUP_NOTE_UNAVAILABLE', checkedAt));
    }

    if (after?.upstreamVersion !== undefined) {
      try {
        const status = await clientA.patch(paths.note, after.upstreamVersion, 'before');
        mutationOccurred ||= status >= 200 && status < 300;
        const restored = await gateway.readRaw(paths.note);
        const passed = status >= 200 && status < 300 && restored.rawSha256 === sha256(beforeBytes);
        results.push(result(
          'safeRestore', 'PATCH_IF_MATCH', passed ? 'passed' : 'failed',
          passed ? 'CONDITIONAL_RESTORE_REREAD_MATCHED' : 'CONDITIONAL_RESTORE_MISMATCH',
          checkedAt, [status, 200]
        ));
      } catch {
        mutationRereadsComplete = false;
        results.push(result('safeRestore', 'PATCH_IF_MATCH', 'failed', 'CONDITIONAL_RESTORE_PROBE_FAILED', checkedAt));
      }
    } else {
      results.push(result('safeRestore', 'PATCH_IF_MATCH', 'unverified', 'SAFE_REPLACE_REQUIRED', checkedAt));
    }

    const putBefore = new TextEncoder().encode('# Put\nfirst\n');
    try {
      const createStatus = await clientA.put(paths.putTarget, putBefore, true);
      mutationOccurred ||= createStatus >= 200 && createStatus < 300;
      const created = createStatus >= 200 && createStatus < 300 ? await gateway.readRaw(paths.putTarget) : undefined;
      const collisionStatus = await clientA.put(paths.putTarget, new TextEncoder().encode('# Put\nsecond\n'), true);
      mutationOccurred ||= collisionStatus >= 200 && collisionStatus < 300;
      const collided = created !== undefined || (collisionStatus >= 200 && collisionStatus < 300)
        ? await gateway.readRaw(paths.putTarget)
        : undefined;
      const passed = created?.rawSha256 === sha256(putBefore)
        && !(collisionStatus >= 200 && collisionStatus < 300)
        && collided?.rawSha256 === created.rawSha256;
      results.push(result(
        'safeCreate', 'PUT_REJECT_IF_CONTENT_PREEXISTS', passed ? 'passed' : 'failed',
        passed ? 'PUT_NON_OVERWRITE_REREAD_VERIFIED' : 'PUT_SAFE_CREATE_UNPROVEN',
        checkedAt, [createStatus, collisionStatus]
      ));
    } catch {
      mutationRereadsComplete = false;
      results.push(result('safeCreate', 'PUT_REJECT_IF_CONTENT_PREEXISTS', 'failed', 'PUT_SAFE_CREATE_PROBE_FAILED', checkedAt));
    }

    const copyBefore = new TextEncoder().encode('# Copy\nfirst\n');
    try {
      await writeFile(diskPath(environment.testVaultRoot, paths.copySource, runId), copyBefore, { flag: 'wx' });
      const createStatus = await clientA.copy(paths.copySource, paths.copyTarget);
      mutationOccurred ||= createStatus >= 200 && createStatus < 300;
      const created = createStatus >= 200 && createStatus < 300 ? await gateway.readRaw(paths.copyTarget) : undefined;
      await writeFile(diskPath(environment.testVaultRoot, paths.copySource, runId), new TextEncoder().encode('# Copy\nsecond\n'));
      const collisionStatus = await clientA.copy(paths.copySource, paths.copyTarget);
      mutationOccurred ||= collisionStatus >= 200 && collisionStatus < 300;
      const collided = created !== undefined || (collisionStatus >= 200 && collisionStatus < 300)
        ? await gateway.readRaw(paths.copyTarget)
        : undefined;
      const passed = created?.rawSha256 === sha256(copyBefore)
        && !(collisionStatus >= 200 && collisionStatus < 300)
        && collided?.rawSha256 === created.rawSha256;
      results.push(result(
        'safeCreate', 'COPY_ALLOW_OVERWRITE_FALSE', passed ? 'passed' : 'failed',
        passed ? 'COPY_NON_OVERWRITE_REREAD_VERIFIED' : 'COPY_SAFE_CREATE_UNPROVEN',
        checkedAt, [createStatus, collisionStatus]
      ));
    } catch {
      mutationRereadsComplete = false;
      results.push(result('safeCreate', 'COPY_ALLOW_OVERWRITE_FALSE', 'failed', 'COPY_SAFE_CREATE_PROBE_FAILED', checkedAt));
    }

    try {
      const expectedBytes = new TextEncoder().encode('# Delete\nexpected\n');
      await writeFile(diskPath(environment.testVaultRoot, paths.deleteCandidate, runId), expectedBytes, { flag: 'wx' });
      const expected = await gateway.readRaw(paths.deleteCandidate);
      await writeFile(diskPath(environment.testVaultRoot, paths.deleteCandidate, runId), new TextEncoder().encode('# Delete\nchanged\n'));
      const current = await gateway.readRaw(paths.deleteCandidate);
      results.push(result(
        'safeDelete', undefined, 'failed',
        current.rawSha256 !== expected.rawSha256 ? 'SAFE_DELETE_CAS_UNPROVEN' : 'DELETE_CHANGE_NOT_OBSERVED',
        checkedAt
      ));
    } catch {
      results.push(result('safeDelete', undefined, 'failed', 'SAFE_DELETE_CAS_UNPROVEN', checkedAt));
    }

    try {
      const observationDisk = diskPath(environment.testVaultRoot, paths.observation, runId);
      const renamedDisk = diskPath(environment.testVaultRoot, paths.renamedObservation, runId);
      await writeFile(observationDisk, new TextEncoder().encode('one\n'), { flag: 'wx' });
      const created = await poll(async () => (await gateway.listDirectory(roots.library)).includes('external-observation.md'));
      const before = await gateway.readRaw(paths.observation);
      await writeFile(observationDisk, new TextEncoder().encode('two\n'));
      let current = before;
      const modified = await poll(async () => {
        current = await gateway.readRaw(paths.observation);
        return current.rawSha256 !== before.rawSha256;
      });
      await rename(observationDisk, renamedDisk);
      const renamed = await poll(async () => {
        const entries = await gateway.listDirectory(roots.library);
        return entries.includes('external-observation-renamed.md') && !entries.includes('external-observation.md');
      });
      await rm(renamedDisk);
      const deleted = await poll(async () => !(await gateway.listDirectory(roots.library)).includes('external-observation-renamed.md'));
      const passed = created && modified && renamed && deleted;
      const rawPolling = current.upstreamVersion === before.upstreamVersion;
      results.push(result(
        'externalMutationObservation', rawPolling ? 'RAW_REREAD' : 'DIRECTORY_POLL',
        passed ? 'passed' : 'failed',
        passed ? (rawPolling ? 'RAW_REREAD_POLLING_REQUIRED' : 'DIRECTORY_AND_VERSION_POLLING_VERIFIED')
          : 'EXTERNAL_MUTATION_NOT_FULLY_OBSERVED',
        checkedAt, [200]
      ));
    } catch {
      results.push(result('externalMutationObservation', 'DIRECTORY_POLL', 'failed', 'EXTERNAL_MUTATION_PROBE_FAILED', checkedAt));
    }

    const rereadPassed = mutationOccurred && mutationRereadsComplete;
    results.push(result(
      'rereadVerified', 'RAW_REREAD', rereadPassed ? 'passed' : 'failed',
      rereadPassed ? 'EVERY_SUCCESSFUL_MUTATION_REREAD'
        : (mutationOccurred ? 'SUCCESSFUL_MUTATION_REREAD_INCOMPLETE' : 'NO_SUCCESSFUL_MUTATION_TO_REREAD'),
      checkedAt, rereadPassed ? [200] : undefined
    ));

    const profile = await buildWriteProbeProfile({
      fingerprint,
      openApiSha256,
      checkedAt,
      ...(priorReadProfile === undefined ? {} : { priorReadProfile }),
      results,
      persist: (value) => writeContractProfile(profileDirectory, value)
    });
    const serialized = await Promise.all([
      readFile(join(profileDirectory, `${profile.profileKey}.json`), 'utf8'),
      readFile(join(profileDirectory, 'current.json'), 'utf8'),
      readFile(join(profileDirectory, 'report.md'), 'utf8')
    ]);
    expect(serialized.join('\n')).not.toContain(environment.apiKey);
  });
});
