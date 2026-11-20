import { z } from 'zod';
import { knowledgeRecordSchema, materialRecordSchema } from '../../shared/api/schemas.js';
import type { KnowledgeRecord, MaterialRecord, ParsedNote } from '../../shared/domain/records.js';
import { isIsoCalendarDate } from '../../shared/domain/iso-date.js';
import { sha256Bytes } from '../vault/raw-bytes.js';
import { FrontmatterError, parseFrontmatter } from './frontmatter.js';
import { normalizeWikiLinkList } from './wikilinks.js';

const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}-(?:[01]\d|2[0-3]):[0-5]\d$/u)
  .refine(value => isIsoCalendarDate(value.slice(0, 10))).nullish();
const links = z.array(z.string());
const sourceSchema = z.object({
  类型: z.literal('原始资料'), 资料来源: z.string().nullish(), 标题: z.string().nullish(),
  入馆时间: timestamp, 探讨状态: z.enum(['未探讨', '部分探讨完成', '全面探讨完成']),
  关联日记: links
});
const noteSchema = z.object({
  类型: z.enum(['知识笔记', '知识历史记录']), 创建时间: timestamp, 更新时间: timestamp,
  关键词: links, 核心内容: z.string(), 关联资料: links, 时效说明: z.string().nullish()
});

function project<T>(
  bytes: Uint8Array, path: string, makeRecord: (data: Record<string, unknown>) => T
): ParsedNote<T> {
  let bodyBytes = bytes.subarray(bytes.length);
  try {
    const header = parseFrontmatter(bytes);
    bodyBytes = header.bodyBytes;
    return { record: makeRecord(header.data), issues: [], bodyBytes };
  } catch (error) {
    if (error instanceof FrontmatterError) return { record: undefined, bodyBytes,
      issues: [{ path, code: 'FRONTMATTER_INVALID', message: error.code }] };
    if (!(error instanceof z.ZodError)) throw error;
    const issue = error.issues[0];
    return { record: undefined, bodyBytes, issues: [{
      path, code: 'INVALID_FIELD', message: issue?.message ?? '笔记属性无效。',
      ...(issue?.path.length ? { field: issue.path.join('.') } : {})
    }] };
  }
}

export function parseCurrentMaterial(bytes: Uint8Array, path: string, upstreamVersion?: string): ParsedNote<MaterialRecord> {
  return project(bytes, path, fields => {
    const data = sourceSchema.parse(fields);
    return materialRecordSchema.parse({
      path, rawSha256: sha256Bytes(bytes), ...(upstreamVersion === undefined ? {} : { upstreamVersion }),
      title: data.标题?.trim() || path.split('/').at(-1)!.slice(0, -3),
      sourcePlatform: data.资料来源?.trim() || '未标注',
      processingStatus: path.startsWith('01图书馆/00信息入口/') ? '未归档' : '已归档',
      knowledgeStatus: data.探讨状态, ...(data.入馆时间 ? { collectedAt: data.入馆时间.slice(0, 10) } : {}),
      generatedKnowledge: []
    }) as MaterialRecord;
  });
}

export function parseCurrentKnowledge(bytes: Uint8Array, path: string, upstreamVersion?: string): ParsedNote<KnowledgeRecord> {
  return project(bytes, path, fields => {
    const data = noteSchema.parse(fields);
    return knowledgeRecordSchema.parse({
      path, rawSha256: sha256Bytes(bytes), ...(upstreamVersion === undefined ? {} : { upstreamVersion }),
      title: path.split('/').at(-1)!.slice(0, -3),
      ...(data.创建时间 ? { createdAt: data.创建时间.slice(0, 10) } : {}),
      ...(data.更新时间 ? { updatedAt: data.更新时间.slice(0, 10) } : {}),
      sourceType: '未标注', usageStatus: data.类型 === '知识历史记录' ? '历史记录' : '现行', knowledgeType: data.类型,
      recallFields: { topics: [], keywords: data.关键词, scenarios: [], conclusion: data.核心内容,
        keyPoints: [], boundary: data.时效说明 ?? '' }, sourceMaterials: normalizeWikiLinkList(data.关联资料)
    }) as KnowledgeRecord;
  });
}
