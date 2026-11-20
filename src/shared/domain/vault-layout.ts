import { RULE_APPROVAL_SOURCE_PATHS } from './rule-approval.js';

export const LEGACY_VAULT_LAYOUT = {
  id: 'legacy',
  knowledgeRoot: '02知识库',
  outputRoot: '03大讲堂',
  inboxRoot: '01图书馆/小兆clipper',
  rulePaths: RULE_APPROVAL_SOURCE_PATHS
} as const;

export const CURRENT_VAULT_LAYOUT = {
  id: 'current',
  knowledgeRoot: '03知识库',
  outputRoot: '04大讲堂',
  inboxRoot: '01图书馆/00信息入口',
  rulePaths: [
    '00大脑规则/01图书馆规则.md', '00大脑规则/02日记本规则.md',
    '00大脑规则/03知识库规则.md', '00大脑规则/04小兆大脑检索调用规则.md',
    '00大脑规则/05大讲堂规则.md', '00大脑规则/06知识库分类规则.md',
    '00大脑规则/07维护与校验规则.md', '00大脑规则/文档规范/图书馆资料.md',
    '00大脑规则/文档规范/知识笔记.md'
  ]
} as const;

export type VaultLayout = typeof LEGACY_VAULT_LAYOUT | typeof CURRENT_VAULT_LAYOUT;

export function isKnowledgePath(path: string): boolean {
  return path.startsWith('02知识库/') || path.startsWith('03知识库/');
}

export function vaultLayoutForRuleFiles(names: readonly string[]): VaultLayout {
  return names.includes('03知识库规则.md') ? CURRENT_VAULT_LAYOUT : LEGACY_VAULT_LAYOUT;
}
