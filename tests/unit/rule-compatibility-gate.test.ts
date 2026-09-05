import { describe, expect, it } from 'vitest';
import { buildRuleApprovalFiles, ruleApprovalRecordSchema } from '../../src/shared/domain/rule-approval.js';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';
import { DenyRuleCompatibilityGate } from '../../src/server/rules/rule-compatibility-gate.js';

const sources = () => RULE_BUNDLE_SOURCE_PATHS.map((path) => ({ path, rawSha256: 'a'.repeat(64) }));
const record = () => ({ schemaVersion: 1, bundleSHA256: 'b'.repeat(64), validatorVersion: 'desktop-v1', approvedAt: '2026-09-05T00:00:00Z', files: buildRuleApprovalFiles(sources()) });

describe('explicit rule approval contract', () => {
  it('requires all five exact ordered files and a strict approval record', () => {
    expect(RULE_BUNDLE_SOURCE_PATHS).toHaveLength(5);
    expect(ruleApprovalRecordSchema.parse(record()).files.map((file) => file.path)).toEqual(RULE_BUNDLE_SOURCE_PATHS);
    expect(() => buildRuleApprovalFiles(sources().slice(1))).toThrow();
    expect(() => buildRuleApprovalFiles([...sources(), sources()[0]!])).toThrow();
    expect(() => buildRuleApprovalFiles(sources().reverse())).toThrow();
  });

  it.each([
    { schemaVersion: 2 }, { bundleSHA256: 'invalid' }, { approvedAt: 'yesterday' },
    { validatorVersion: '' }, { validatorVersion: 'v'.repeat(129) }, { extra: true },
    { files: [] }, { files: RULE_BUNDLE_SOURCE_PATHS.map((path) => ({ path, sha256: 'bad' })) }
  ])('rejects malformed approval %j', (override) => {
    expect(ruleApprovalRecordSchema.safeParse({ ...record(), ...override }).success).toBe(false);
  });

  it('denies production approval with a stable reason', () => {
    const gate = new DenyRuleCompatibilityGate();
    expect(gate.status()).toEqual({ status: 'blocked', reasonCode: 'RULE_BUNDLE_UNAPPROVED', missing: ['ruleApproval'] });
    expect(() => gate.assertApproved()).toThrow('RULE_BUNDLE_UNAPPROVED');
  });
});
