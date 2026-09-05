import { z } from 'zod';
import type { KnowledgeRecord, ParsedNote } from '../../shared/domain/records.js';
import { sha256Bytes } from '../vault/raw-bytes.js';
import { FrontmatterError, parseFrontmatter } from './frontmatter.js';
import { normalizeWikiLinkList } from './wikilinks.js';
import { isIsoCalendarDate } from '../../shared/domain/iso-date.js';
import { knowledgeRecordSchema } from '../../shared/api/schemas.js';

export const USAGE_STATUSES = ['AI总结', '已优化', '定论', '过时'] as const;
export const KNOWLEDGE_TYPES = [
  '概念', '原理', '模型', '方法', 'SOP', '标准', '案例', '数据', '观点', '素材'
] as const;

const optionalScalar = z.preprocess(
  (value) => value === null || (typeof value === 'string' && value.trim().length === 0)
    ? undefined
    : value,
  z.string().optional()
);
const optionalIsoDate = z.preprocess(
  (value) => value === null || (typeof value === 'string' && value.trim().length === 0)
    ? undefined
    : value,
  z.string().refine(isIsoCalendarDate, 'Expected a valid YYYY-MM-DD calendar date').optional()
);
const stringList = z.array(z.string().trim().min(1));
const requiredScalar = z.string().trim().min(1);

const knowledgeSchema = z.object({
  类型: z.literal('知识笔记'),
  来源类型: z.enum(['AI提炼', '人工输入']),
  使用状态: z.enum(USAGE_STATUSES),
  知识类型: z.enum(KNOWLEDGE_TYPES),
  所属主题: stringList,
  关键词: stringList,
  来源资料: stringList,
  适用场景: stringList,
  核心结论: requiredScalar,
  关键要点: stringList,
  使用边界: requiredScalar,
  创建日期: optionalIsoDate,
  更新日期: optionalIsoDate,
  备注: optionalScalar
});

function filenameTitle(path: string): string {
  const filename = path.split('/').at(-1) ?? path;
  return filename.endsWith('.md') ? filename.slice(0, -3) : filename;
}

function invalidResult(
  bytes: Uint8Array,
  path: string,
  code: 'FRONTMATTER_INVALID' | 'UNEXPECTED_TYPE' | 'INVALID_FIELD',
  message: string,
  field?: string,
  bodyBytes = bytes.subarray(bytes.byteLength)
): ParsedNote<KnowledgeRecord> {
  return {
    record: undefined,
    issues: [{ path, code, message, ...(field === undefined ? {} : { field }) }],
    bodyBytes
  };
}

export function parseKnowledgeNote(
  bytes: Uint8Array,
  path = 'unknown.md',
  upstreamVersion?: string
): ParsedNote<KnowledgeRecord> {
  let parsed;
  try {
    parsed = parseFrontmatter(bytes);
  } catch (error) {
    const message = error instanceof FrontmatterError ? error.code : 'FRONTMATTER_INVALID';
    return invalidResult(bytes, path, 'FRONTMATTER_INVALID', message);
  }

  if (parsed.data.类型 !== '知识笔记') {
    return invalidResult(
      bytes,
      path,
      'UNEXPECTED_TYPE',
      'Expected 类型: 知识笔记',
      '类型',
      parsed.bodyBytes
    );
  }

  const validated = knowledgeSchema.safeParse(parsed.data);
  if (!validated.success) {
    const first = validated.error.issues[0];
    return invalidResult(
      bytes,
      path,
      'INVALID_FIELD',
      first?.message ?? 'Invalid knowledge frontmatter',
      first?.path.map(String).join('.') || undefined,
      parsed.bodyBytes
    );
  }

  const record: KnowledgeRecord = {
    path,
    rawSha256: sha256Bytes(bytes),
    ...(upstreamVersion === undefined ? {} : { upstreamVersion }),
    title: filenameTitle(path),
    ...(validated.data.创建日期 === undefined ? {} : { createdAt: validated.data.创建日期 }),
    ...(validated.data.更新日期 === undefined ? {} : { updatedAt: validated.data.更新日期 }),
    sourceType: validated.data.来源类型,
    usageStatus: validated.data.使用状态,
    knowledgeType: validated.data.知识类型,
    recallFields: {
      topics: normalizeWikiLinkList(validated.data.所属主题),
      keywords: [...validated.data.关键词],
      scenarios: [...validated.data.适用场景],
      conclusion: validated.data.核心结论,
      keyPoints: [...validated.data.关键要点],
      boundary: validated.data.使用边界
    },
    sourceMaterials: normalizeWikiLinkList(validated.data.来源资料)
  };

  const projection = knowledgeRecordSchema.safeParse(record);
  if (!projection.success) {
    const field = projection.error.issues[0]?.path.join('.');
    return invalidResult(bytes, path, 'INVALID_FIELD', '知识字段超出可展示范围，请检查该笔记的元数据。', field, parsed.bodyBytes);
  }
  return { record, issues: [], bodyBytes: parsed.bodyBytes };
}
