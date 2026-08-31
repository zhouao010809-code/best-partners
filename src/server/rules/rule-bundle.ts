import { createHash } from 'node:crypto';
import type { VaultGateway } from '../vault/VaultGateway.js';
import { sha256Bytes } from '../vault/raw-bytes.js';

export const RULE_BUNDLE_SOURCE_PATHS = [
  '00大脑规则/00_大脑规范.md',
  '00大脑规则/01_总路由规则.md',
  '00大脑规则/03_知识库提炼与入库规则.md',
  '00大脑规则/05_链接命名与治理规则.md'
] as const;

export type RuleBundle = {
  fingerprint: string;
  sources: ReadonlyArray<{ path: string; text: string; rawSha256: string }>;
};

export async function loadRuleBundle(gateway: VaultGateway): Promise<RuleBundle> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const sources: Array<{ path: string; text: string; rawSha256: string }> = [];

  for (const path of RULE_BUNDLE_SOURCE_PATHS) {
    const source = await gateway.readRaw(path);
    const rawSha256 = sha256Bytes(source.bytes);
    sources.push({ path, text: decoder.decode(source.bytes), rawSha256 });
  }

  const hash = createHash('sha256');
  for (const source of sources) {
    hash.update(source.path, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(source.rawSha256, 'ascii');
    hash.update('\0', 'utf8');
  }

  return { fingerprint: hash.digest('hex'), sources };
}

export class RuleBundleGuard {
  private constructor(private readonly startupFingerprint: string) {}

  static async start(gateway: VaultGateway): Promise<RuleBundleGuard> {
    const bundle = await loadRuleBundle(gateway);
    return new RuleBundleGuard(bundle.fingerprint);
  }

  async check(gateway: VaultGateway): Promise<{
    status: 'current' | 'stale';
    startupFingerprint: string;
    currentFingerprint: string;
    readOnlyAvailable: true;
    candidateGenerationAvailable: boolean;
    writePlanningAvailable: boolean;
  }> {
    const current = await loadRuleBundle(gateway);
    const isCurrent = current.fingerprint === this.startupFingerprint;
    return {
      status: isCurrent ? 'current' : 'stale',
      startupFingerprint: this.startupFingerprint,
      currentFingerprint: current.fingerprint,
      readOnlyAvailable: true,
      candidateGenerationAvailable: isCurrent,
      writePlanningAvailable: isCurrent
    };
  }
}
