import { z } from 'zod';
import type { ParsedNote, MaterialRecord } from '../../shared/domain/records.js';
import { sha256Bytes } from '../vault/raw-bytes.js';
import { FrontmatterError, parseFrontmatter } from './frontmatter.js';
import { normalizeWikiLinkList } from './wikilinks.js';
import { isIsoCalendarDate } from '../../shared/domain/iso-date.js';
import { materialRecordSchema } from '../../shared/api/schemas.js';

export const SOURCE_PLATFORMS = [
  'B站', 'YouTube', '抖音', '小红书', '公众号', '飞书', 'X推特',
  'Reddit', '小宇宙', '独立站', '个人', '其他'
] as const;
export const KNOWLEDGE_STATUSES = ['未提炼', '部分入库', '已入库'] as const;

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

const librarySchema = z.object({
  类型: z.literal('原始资料'),
  处理状态: z.enum(['未归档', '已归档']),
  来源平台: z.enum(SOURCE_PLATFORMS),
  原始标题: optionalScalar,
  作者: optionalScalar,
  原始链接: optionalScalar,
  采集日期: optionalIsoDate,
  所属主题: stringList,
  关键词: stringList,
  知识入库状态: z.enum(KNOWLEDGE_STATUSES),
  生成知识: stringList,
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
): ParsedNote<MaterialRecord> {
  return {
    record: undefined,
    issues: [{ path, code, message, ...(field === undefined ? {} : { field }) }],
    bodyBytes
  };
}

export function parseLibraryNote(
  bytes: Uint8Array,
  path = 'unknown.md',
  upstreamVersion?: string
): ParsedNote<MaterialRecord> {
  let parsed;
  try {
    parsed = parseFrontmatter(bytes);
  } catch (error) {
    const message = error instanceof FrontmatterError ? error.code : 'FRONTMATTER_INVALID';
    return invalidResult(bytes, path, 'FRONTMATTER_INVALID', message);
  }

  if (parsed.data.类型 !== '原始资料') {
    return invalidResult(
      bytes,
      path,
      'UNEXPECTED_TYPE',
      'Expected 类型: 原始资料',
      '类型',
      parsed.bodyBytes
    );
  }

  const validated = librarySchema.safeParse(parsed.data);
  if (!validated.success) {
    const first = validated.error.issues[0];
    return invalidResult(
      bytes,
      path,
      'INVALID_FIELD',
      first?.message ?? 'Invalid library frontmatter',
      first?.path.map(String).join('.') || undefined,
      parsed.bodyBytes
    );
  }

  const title = validated.data.原始标题?.trim() || filenameTitle(path);
  const record: MaterialRecord = {
    path,
    rawSha256: sha256Bytes(bytes),
    ...(upstreamVersion === undefined ? {} : { upstreamVersion }),
    title,
    sourcePlatform: validated.data.来源平台,
    processingStatus: validated.data.处理状态,
    knowledgeStatus: validated.data.知识入库状态,
    ...(validated.data.采集日期 === undefined ? {} : { collectedAt: validated.data.采集日期 }),
    generatedKnowledge: normalizeWikiLinkList(validated.data.生成知识)
  };

  const projection = materialRecordSchema.safeParse(record);
  if (!projection.success) {
    const field = projection.error.issues[0]?.path.join('.');
    return invalidResult(bytes, path, 'INVALID_FIELD', '资料字段超出可展示范围，请检查该资料的元数据。', field, parsed.bodyBytes);
  }
  return { record, issues: [], bodyBytes: parsed.bodyBytes };
}
