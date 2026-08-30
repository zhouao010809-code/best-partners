import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import { assertContractTestVault } from '../../helpers/test-vault-guard.js';
import { createContractDiskSandbox } from '../../helpers/contract-disk-sandbox.js';
import { pollForObservation, waitForRawObservation } from '../../helpers/contract-observation.js';
import { prepareConditionalRestore } from '../../helpers/contract-restore.js';
import {
  ContractRestClient,
  assertSandboxVaultPath,
  contractSandboxRoots,
  createContractGateway,
  requireContractEnvironment
} from '../../helpers/contract-runtime.js';
import {
  buildWriteProbeProfile,
  type CapabilityResult
} from '../../helpers/write-probe-profile.js';
import {
  computeContractProfileKey,
  loadContractProfileByKey,
  loadContractProfileStateByKey,
  writeContractProfile
} from '../../../src/server/vault/contract-profile-store.js';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
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
    const canonicalRoots = await assertContractTestVault({
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
    const profileDirectory = join(canonicalRoots.appDataRoot, 'contract-profiles');
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
    const disk = createContractDiskSandbox({
      canonicalTestVaultRoot: canonicalRoots.testVaultRoot,
      runId
    });
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
    const clientA = new ContractRestClient(environment.apiUrl, environment.apiKey);
    const clientB = new ContractRestClient(environment.apiUrl, environment.apiKey);
    const beforeBytes = new TextEncoder().encode('# Contract\nbefore\n');
    let initial: Awaited<ReturnType<typeof gateway.readRaw>> | undefined;
    let after: Awaited<ReturnType<typeof gateway.readRaw>> | undefined;
    let mutationOccurred = false;
    let mutationRereadsComplete = true;

    try {
      await disk.createFile(paths.note, beforeBytes);
      initial = await waitForRawObservation({
        gateway,
        path: paths.note,
        expectedRawSha256: sha256(beforeBytes),
        requireVersion: true
      });
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
        const staleSucceeded = stale >= 200 && stale < 300;
        const concurrentSucceeded = concurrent.some((status) => status >= 200 && status < 300);
        mutationRereadsComplete &&= (!staleSucceeded || (
          unchanged.rawSha256 === sha256(unchanged.bytes)
          && new TextDecoder().decode(unchanged.bytes).includes('stale')
        )) && (!concurrentSucceeded || (
          after.rawSha256 === sha256(after.bytes)
          && (text.includes('winner-a') || text.includes('winner-b'))
        ));
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
        const current = await gateway.readRaw(paths.note);
        const restore = prepareConditionalRestore({ beforeBytes, after, current });
        if (restore === undefined) throw new Error('restore precondition mismatch');
        const status = await clientA.patch(
          paths.note,
          restore.version,
          restore.content
        );
        mutationOccurred ||= status >= 200 && status < 300;
        const restored = await gateway.readRaw(paths.note);
        const passed = status >= 200 && status < 300
          && restored.rawSha256 === restore.beforeRawSha256
          && Buffer.from(restored.bytes).equals(Buffer.from(beforeBytes));
        if (status >= 200 && status < 300) mutationRereadsComplete &&= passed;
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
    const putAfter = new TextEncoder().encode('# Put\nsecond\n');
    try {
      const createStatus = await clientA.put(paths.putTarget, putBefore, true);
      mutationOccurred ||= createStatus >= 200 && createStatus < 300;
      const created = createStatus >= 200 && createStatus < 300 ? await gateway.readRaw(paths.putTarget) : undefined;
      const collisionStatus = await clientA.put(paths.putTarget, putAfter, true);
      mutationOccurred ||= collisionStatus >= 200 && collisionStatus < 300;
      const collided = created !== undefined || (collisionStatus >= 200 && collisionStatus < 300)
        ? await gateway.readRaw(paths.putTarget)
        : undefined;
      const passed = created?.rawSha256 === sha256(putBefore)
        && !(collisionStatus >= 200 && collisionStatus < 300)
        && collided?.rawSha256 === created.rawSha256;
      if (createStatus >= 200 && createStatus < 300) {
        mutationRereadsComplete &&= created?.rawSha256 === sha256(putBefore);
      }
      if (collisionStatus >= 200 && collisionStatus < 300) {
        mutationRereadsComplete &&= collided?.rawSha256 === sha256(putAfter);
      }
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
      await disk.createFile(paths.copySource, copyBefore);
      await waitForRawObservation({
        gateway,
        path: paths.copySource,
        expectedRawSha256: sha256(copyBefore),
        requireVersion: true
      });
      const createStatus = await clientA.copy(paths.copySource, paths.copyTarget);
      mutationOccurred ||= createStatus >= 200 && createStatus < 300;
      const created = createStatus >= 200 && createStatus < 300 ? await gateway.readRaw(paths.copyTarget) : undefined;
      const copyAfter = new TextEncoder().encode('# Copy\nsecond\n');
      await disk.overwriteFile(paths.copySource, copyAfter);
      await waitForRawObservation({
        gateway,
        path: paths.copySource,
        expectedRawSha256: sha256(copyAfter),
        requireVersion: true
      });
      const collisionStatus = await clientA.copy(paths.copySource, paths.copyTarget);
      mutationOccurred ||= collisionStatus >= 200 && collisionStatus < 300;
      const collided = created !== undefined || (collisionStatus >= 200 && collisionStatus < 300)
        ? await gateway.readRaw(paths.copyTarget)
        : undefined;
      const passed = created?.rawSha256 === sha256(copyBefore)
        && !(collisionStatus >= 200 && collisionStatus < 300)
        && collided?.rawSha256 === created.rawSha256;
      if (createStatus >= 200 && createStatus < 300) {
        mutationRereadsComplete &&= created?.rawSha256 === sha256(copyBefore);
      }
      if (collisionStatus >= 200 && collisionStatus < 300) {
        mutationRereadsComplete &&= collided?.rawSha256 === sha256(copyAfter);
      }
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
      await disk.createFile(paths.deleteCandidate, expectedBytes);
      const expected = await waitForRawObservation({
        gateway,
        path: paths.deleteCandidate,
        expectedRawSha256: sha256(expectedBytes),
        requireVersion: true
      });
      const changedBytes = new TextEncoder().encode('# Delete\nchanged\n');
      await disk.overwriteFile(paths.deleteCandidate, changedBytes);
      const current = await waitForRawObservation({
        gateway,
        path: paths.deleteCandidate,
        expectedRawSha256: sha256(changedBytes),
        requireVersion: true
      });
      results.push(result(
        'safeDelete', undefined, 'failed',
        current.rawSha256 !== expected.rawSha256 ? 'SAFE_DELETE_CAS_UNPROVEN' : 'DELETE_CHANGE_NOT_OBSERVED',
        checkedAt
      ));
    } catch {
      results.push(result('safeDelete', undefined, 'failed', 'SAFE_DELETE_CAS_UNPROVEN', checkedAt));
    }

    try {
      const observationBefore = new TextEncoder().encode('one\n');
      await disk.createFile(paths.observation, observationBefore);
      await waitForRawObservation({
        gateway,
        path: paths.observation,
        expectedRawSha256: sha256(observationBefore),
        requireVersion: true
      });
      const created = await pollForObservation({
        check: async () => (await gateway.listDirectory(roots.library)).includes('external-observation.md')
      });
      const before = await gateway.readRaw(paths.observation);
      const observationAfter = new TextEncoder().encode('two\n');
      await disk.overwriteFile(paths.observation, observationAfter);
      await waitForRawObservation({
        gateway,
        path: paths.observation,
        expectedRawSha256: sha256(observationAfter),
        requireVersion: true
      });
      let current = before;
      const modified = await pollForObservation({
        check: async () => {
          current = await gateway.readRaw(paths.observation);
          return current.rawSha256 !== before.rawSha256;
        }
      });
      await disk.renameFile(paths.observation, paths.renamedObservation);
      const renamed = await pollForObservation({
        check: async () => {
          const entries = await gateway.listDirectory(roots.library);
          return entries.includes('external-observation-renamed.md') && !entries.includes('external-observation.md');
        }
      });
      await disk.deleteFile(paths.renamedObservation);
      const deleted = await pollForObservation({
        check: async () => !(await gateway.listDirectory(roots.library)).includes('external-observation-renamed.md')
      });
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
    results.push(result(
      'cleanup', 'DELETE_NON_PERMANENT', 'unverified',
      'MANUAL_CLEANUP_REQUIRED', checkedAt
    ));

    const profile = await buildWriteProbeProfile({
      fingerprint,
      openApiSha256,
      checkedAt,
      ...(priorReadProfile === undefined ? {} : { priorReadProfile }),
      results,
      persist: (value) => writeContractProfile(profileDirectory, value)
    });
    const state = await loadContractProfileStateByKey(profileDirectory, profile.profileKey);
    expect(state).toBeDefined();
    const serialized = await Promise.all([
      readFile(join(profileDirectory, state!.pointer.profileFile), 'utf8'),
      readFile(join(profileDirectory, 'current.json'), 'utf8'),
      readFile(join(profileDirectory, state!.pointer.reportFile), 'utf8')
    ]);
    expect(serialized.join('\n')).not.toContain(environment.apiKey);
  });
});
