export type KnowledgeStatus = '未提炼' | '部分入库' | '已入库' | '未探讨' | '部分探讨完成' | '全面探讨完成';
export type UsageStatus = 'AI总结' | '已优化' | '定论' | '过时' | '现行' | '历史记录';

export type MaterialRecord = {
  path: string;
  rawSha256: string;
  upstreamVersion?: string;
  title: string;
  sourcePlatform: string;
  processingStatus: '未归档' | '已归档';
  knowledgeStatus: KnowledgeStatus;
  collectedAt?: string;
  topics?: string[];
  generatedKnowledge: string[];
};

export type KnowledgeRecord = {
  path: string;
  rawSha256: string;
  upstreamVersion?: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  sourceType: 'AI提炼' | '人工输入' | '未标注';
  usageStatus: UsageStatus;
  knowledgeType: string;
  recallFields: {
    topics: string[];
    keywords: string[];
    scenarios: string[];
    conclusion: string;
    keyPoints: string[];
    boundary: string;
  };
  sourceMaterials: string[];
};

export type SchemaIssueCode =
  | 'FRONTMATTER_INVALID'
  | 'UNEXPECTED_TYPE'
  | 'INVALID_FIELD';

export type SchemaIssue = {
  path: string;
  code: SchemaIssueCode;
  message: string;
  field?: string;
};

export type ParsedNote<T> = {
  record: T | undefined;
  issues: SchemaIssue[];
  bodyBytes: Uint8Array;
};
