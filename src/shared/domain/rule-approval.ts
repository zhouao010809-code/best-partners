import { z } from 'zod';

export const RULE_APPROVAL_SOURCE_PATHS = [
  '00大脑规则/00_大脑规范.md',
  '00大脑规则/01_总路由规则.md',
  '00大脑规则/02_图书馆入馆规则.md',
  '00大脑规则/03_知识库提炼与入库规则.md',
  '00大脑规则/05_链接命名与治理规则.md'
] as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const fileSchema = <T extends string>(path: T) => z.object({ path: z.literal(path), sha256 }).strict();
const ruleApprovalFilesSchema = z.tuple([
  fileSchema(RULE_APPROVAL_SOURCE_PATHS[0]),
  fileSchema(RULE_APPROVAL_SOURCE_PATHS[1]),
  fileSchema(RULE_APPROVAL_SOURCE_PATHS[2]),
  fileSchema(RULE_APPROVAL_SOURCE_PATHS[3]),
  fileSchema(RULE_APPROVAL_SOURCE_PATHS[4])
]);

export const ruleApprovalRecordSchema = z.object({
  schemaVersion: z.literal(1),
  bundleSHA256: sha256,
  validatorVersion: z.string().min(1).max(128),
  approvedAt: z.string().datetime(),
  files: ruleApprovalFilesSchema
}).strict();

export type RuleApprovalRecord = z.infer<typeof ruleApprovalRecordSchema>;

export function buildRuleApprovalFiles(
  sources: ReadonlyArray<{ readonly path: string; readonly rawSha256: string }>
): RuleApprovalRecord['files'] {
  return ruleApprovalFilesSchema.parse(sources.map((source) => ({
    path: source.path,
    sha256: source.rawSha256
  })));
}
