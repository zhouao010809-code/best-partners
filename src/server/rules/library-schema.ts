import { z } from 'zod';
import type { ParsedNote, MaterialRecord } from '../../shared/domain/records.js';
import { sha256Bytes } from '../vault/raw-bytes.js';
import { FrontmatterError, parseFrontmatter } from './frontmatter.js';
import { normalizeWikiLinkList } from './wikilinks.js';

export const SOURCE_PLATFORMS = [
  'B站', 'YouTube', '抖音', '小红书', '公众号', '飞书', 'X推特',
  'Reddit', '小宇宙', '独立站', '个人', '其他'
] as const;
export const KNOWLEDGE_STATUSES = ['未提炼', '部分入库', '已入库'] as const;

const librarySchema = z.object({
  类型: z.literal('原始资料'),
  处理状态: z.enum(['未归档', '已归档']),
  来源平台: z.enum(SOURCE_PLATFORMS),
  原始标题: z.string().optional(),
  采集日期: z.string().optional(),
  知识入库状态: z.enum(KNOWLEDGE_STATUSES),
  生成知识: z.array(z.string()).default([])
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

  return { record, issues: [], bodyBytes: parsed.bodyBytes };
}
