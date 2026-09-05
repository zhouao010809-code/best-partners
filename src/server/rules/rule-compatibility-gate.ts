export interface RuleCompatibilityStatus {
  readonly status: 'blocked';
  readonly reasonCode: 'RULE_BUNDLE_UNAPPROVED';
  readonly missing: readonly ['ruleApproval'];
}

export interface RuleCompatibilityGate {
  status(): RuleCompatibilityStatus;
  assertApproved(): void;
}

export class DenyRuleCompatibilityGate implements RuleCompatibilityGate {
  status(): RuleCompatibilityStatus {
    return { status: 'blocked', reasonCode: 'RULE_BUNDLE_UNAPPROVED', missing: ['ruleApproval'] };
  }

  assertApproved(): never {
    throw new Error('RULE_BUNDLE_UNAPPROVED');
  }
}
