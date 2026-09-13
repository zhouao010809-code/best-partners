import type { CandidateDraft } from '../../shared/api/ingestion.js';
import { isMap, parseDocument, stringify } from 'yaml';
import { isDeepStrictEqual } from 'node:util';
import { knowledgeContentSchema } from '../../shared/api/knowledge-content.js';
import { PublicApiError } from '../../shared/api/errors.js';
import { parseFrontmatter } from '../rules/frontmatter.js';
import { parseKnowledgeNote } from '../rules/knowledge-schema.js';
import { normalizeWikiLinkList } from '../rules/wikilinks.js';
import { canonicalJson } from '../index/index-repository.js';
import { sha256Bytes } from '../vault/raw-bytes.js';

export const linkTarget = (path: string) => path.replace(/\.md$/u, '');
export const wikiLink = (path: string) => `[[${linkTarget(path)}]]`;
const unique = (items: string[]) => [...new Set(items)];
function invalid(message: string): never { throw new PublicApiError('KNOWLEDGE_INVALID', message, 409); }
export function assertKnowledgeTitle(title: string): void {
  if (!title.trim() || title !== title.trim() || /[\\/:*?"<>|\[\]#\u0000-\u001f\u007f]/u.test(title)
    || title === '.' || title === '..' || /[. ]$/u.test(title) || Buffer.byteLength(`${title}.md`) > 255) {
    invalid('请使用简短的知识标题，不包含斜杠、双链或文件名特殊字符。');
  }
}
export function validateDraft(draft: CandidateDraft): void {
  assertKnowledgeTitle(draft.title);
  if (!draft.coreContent.trim()) invalid('请补充知识正文。');
  const parsed = knowledgeContentSchema.safeParse(draft.draft);
  if (!parsed.success) {
    const labels: Record<string, string> = { keywords: '关键词（3–6 个）', scenarios: '适用场景（2–3 个）', conclusion: '核心结论', keyPoints: '关键要点（2–4 个）', boundary: '使用边界', quotes: '原文引用', summaries: '个人总结（1–3 条）' };
    invalid(`请补齐或调整${labels[String(parsed.error.issues[0]?.path[0])] ?? '知识字段'}后再预览。`);
  }
}

/** Patch selected YAML values, without serializing other fields or the body. */
export function patchFrontmatter(before: Buffer, changes: Record<string, unknown>): Buffer {
  const parsed = parseFrontmatter(before);
  const bodyStart = before.length - parsed.bodyBytes.length;
  const header = before.subarray(0, bodyStart).toString('utf8');
  const opening = /^(?:\ufeff)?---\r?\n/u.exec(header)!;
  const closing = /---(?:\r?\n)?$/u.exec(header)!;
  if (!opening || !closing || closing.index < opening[0].length) invalid('资料 YAML 边界无法识别。');
  const yaml = header.slice(opening[0].length, closing.index);
  const newline = opening[0].endsWith('\r\n') ? '\r\n' : '\n';
  const document = parseDocument(yaml, { uniqueKeys: true });
  if (!isMap(document.contents) || document.errors.length) invalid('资料 YAML 无法安全更新。');
  const edits: { start: number; end: number; text: string }[] = [];
  const missing = new Set(Object.keys(changes));
  for (const pair of document.contents.items) {
    const key = String(pair.key);
    if (!missing.has(key)) continue;
    missing.delete(key);
    const keyNode = pair.key as { range?: [number, number, number] };
    const valueNode = pair.value as { range?: [number, number, number] } | null;
    const start = keyNode.range?.[0];
    if (start === undefined) invalid('资料字段无法定位，未写入文件。');
    let end = valueNode?.range?.[2] ?? yaml.indexOf('\n', start) + 1;
    if (end <= start) end = yaml.length;
    // A scalar without a terminating newline still needs one before the delimiter.
    const text = `${JSON.stringify(key)}: ${JSON.stringify(changes[key])}${newline}`;
    edits.push({ start, end, text });
  }
  let patched = yaml;
  for (const edit of edits.sort((a, b) => b.start - a.start)) patched = patched.slice(0, edit.start) + edit.text + patched.slice(edit.end);
  for (const key of missing) patched += `${JSON.stringify(key)}: ${JSON.stringify(changes[key])}${newline}`;
  const after = Buffer.concat([Buffer.from(opening[0] + patched + closing[0]), Buffer.from(parsed.bodyBytes)]);
  const check = parseFrontmatter(after);
  const expected = { ...parsed.data, ...changes };
  if (!isDeepStrictEqual(check.data, expected) || !Buffer.from(check.bodyBytes).equals(Buffer.from(parsed.bodyBytes))) invalid('资料更新校验未通过，未写入。');
  return after;
}

export function sourceEvidenceSha(before: Buffer): string {
  const { data, bodyBytes } = parseFrontmatter(before);
  const { 知识入库状态: _status, 生成知识: _links, ...evidence } = data;
  return sha256Bytes(Buffer.concat([Buffer.from(canonicalJson(evidence)), Buffer.from([0]), bodyBytes]));
}
export function patchSource(before: Buffer, paths: string[], status: '未提炼' | '部分入库' | '已入库'): Buffer {
  const { data } = parseFrontmatter(before);
  if (data.类型 !== '原始资料' || data.处理状态 !== '已归档') invalid('请选择已经归档的原始资料。');
  const previous = data.生成知识 ?? [];
  if (!Array.isArray(previous) || previous.some((item) => typeof item !== 'string')) invalid('原资料生成知识字段需要先检查。');
  const all = unique([...normalizeWikiLinkList(previous as string[]).map(linkTarget), ...paths.map(linkTarget)]).map(wikiLink);
  const after = patchFrontmatter(before, { 生成知识: all, 知识入库状态: status });
  if (sourceEvidenceSha(after) !== sourceEvidenceSha(before)) invalid('原资料正文或其他属性发生了变化。');
  return after;
}
function contentBody(draft: CandidateDraft): string {
  const quotes = draft.draft.quotes.length ? draft.draft.quotes.map((quote) => `原文引用：\n\n> ${quote.replace(/\n/gu, '\n> ')}`).join('\n\n') : '暂无可直接引用的原文表达';
  const summaries = draft.draft.summaries.map((summary) => `- ${summary.startsWith('个人总结') ? summary : `个人总结：${summary}`}`).join('\n');
  return `## 知识正文\n\n${draft.coreContent.trim()}\n\n## 可复用表达\n\n### 原文引用\n\n${quotes}\n\n### 个人总结\n\n${summaries}\n`;
}
function verified(bytes: Buffer): Buffer {
  if (!parseKnowledgeNote(bytes).record) invalid('生成的知识笔记没有通过格式校验。');
  if (bytes.length > 450_000) invalid('合并后的知识笔记过长，请减少本批候选。');
  return bytes;
}

type Heading = { start: number; end: number; level: number; title: string };
function markdownLines(body: string): { start: number; end: number; text: string; code: boolean; heading?: Heading }[] {
  const lines: ReturnType<typeof markdownLines> = [];
  let offset = 0; let fence: { character: string; length: number } | undefined;
  for (const line of body.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const text = line.replace(/\r?\n$/u, '');
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(text);
    const code = fence !== undefined || delimiter !== null;
    if (fence) {
      if (delimiter && delimiter[1]![0] === fence.character && delimiter[1]!.length >= fence.length && !delimiter[2]!.trim()) fence = undefined;
    } else if (delimiter) fence = { character: delimiter[1]![0]!, length: delimiter[1]!.length };
    const match = code ? null : /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/u.exec(text);
    const heading = match ? { start: offset, end: offset + line.length, level: match[1]!.length, title: match[2]! } : undefined;
    lines.push({ start: offset, end: offset + line.length, text, code, ...(heading ? { heading } : {}) });
    offset += line.length;
  }
  if (fence) invalid('已有知识存在未闭合的代码块，无法安全定位正文结构。');
  return lines;
}
function headings(body: string): Heading[] { return markdownLines(body).flatMap((line) => line.heading ? [line.heading] : []); }
function section(body: string, name: string, level: number): Heading | undefined {
  if (name === '来源映射' && headings(body).some((heading) => heading.level === level && heading.title.startsWith(name) && heading.title !== name)) {
    invalid('已有来源映射标题形式无法核对，请先整理来源映射。');
  }
  const found = headings(body).filter((heading) => heading.level === level && (heading.title === name || heading.title.startsWith(`${name} `)));
  if (found.length > 1) invalid('已有知识包含重复的固定章节或来源映射，请先检查正文结构。');
  return found[0];
}
function insert(body: string, at: number, text: string): string { return body.slice(0, at) + text + body.slice(at); }
function fixedSections(body: string): { body: string; knowledge: Heading; reusable: Heading; quotes: Heading; summaries: Heading; reusableEnd: number } {
  if (!section(body, '知识正文', 2)) body = `\n## 知识正文\n\n${body}`;
  if (!section(body, '可复用表达', 2)) body += '\n\n## 可复用表达\n\n';
  let reusable = section(body, '可复用表达', 2)!;
  let end = headings(body).find((heading) => heading.start > reusable.start && heading.level <= 2)?.start ?? body.length;
  if (!section(body, '原文引用', 3)) body = insert(body, section(body, '个人总结', 3)?.start ?? end, '\n### 原文引用\n\n暂无可直接引用的原文表达\n\n');
  reusable = section(body, '可复用表达', 2)!;
  end = headings(body).find((heading) => heading.start > reusable.start && heading.level <= 2)?.start ?? body.length;
  if (!section(body, '个人总结', 3)) body = insert(body, end, '\n### 个人总结\n\n');
  const knowledge = section(body, '知识正文', 2)!;
  reusable = section(body, '可复用表达', 2)!;
  const quotes = section(body, '原文引用', 3)!; const summaries = section(body, '个人总结', 3)!;
  end = headings(body).find((heading) => heading.start > reusable.start && heading.level <= 2)?.start ?? body.length;
  if (!(knowledge.start < reusable.start && reusable.start < quotes.start && quotes.start < summaries.start && summaries.start < end)) {
    invalid('已有知识的固定章节顺序或层级无法安全合并，请先检查正文结构。');
  }
  return { body, knowledge, reusable, quotes, summaries, reusableEnd: end };
}
function parseSourceMap(mapText: string, sources: string[]): Map<string, number> {
  const mapping = new Map<string, number>(); const numbers = new Set<number>();
  for (const line of mapText.split(/\r?\n/u).slice(1)) {
    if (!line.trim()) continue;
    const match = /^[-*][ \t]+S([1-9]\d*)[：:][ \t]*\[\[([^\[\]\r\n]+)\]\][ \t]*[；;：:—-][ \t]*(.+)$/u.exec(line);
    if (!match || match[3]!.includes('[[')) invalid('已有来源映射形式无法核对，请先整理来源编号、链接和贡献说明。');
    const number = Number(match[1]);
    const target = linkTarget(normalizeWikiLinkList([`[[${match[2]}]]`])[0]!);
    if (!Number.isSafeInteger(number) || number >= Number.MAX_SAFE_INTEGER || numbers.has(number) || mapping.has(target) || !sources.includes(target)) {
      invalid('已有来源映射与来源资料不一致或存在重复，请先核对来源归属。');
    }
    mapping.set(target, number); numbers.add(number);
  }
  if (mapping.size !== sources.length || sources.some((source) => !mapping.has(source))) invalid('已有来源映射缺少登记来源，请先核对来源归属。');
  return mapping;
}
function assertMappedBody(body: string, mapping: Map<string, number>): void {
  const numbers = new Set(mapping.values()); const scope = new Map<number, boolean>();
  for (const line of markdownLines(body)) {
    // Provenance belongs to section headings. Quoted evidence, code and prose
    // may contain the same notation as literal source material.
    const markers = line.heading ? [...line.heading.title.matchAll(/〔((?:S|人工|综合)[^〕]*)〕/gu)] : [];
    for (const marker of markers) {
      const value = marker[1]!;
      if (value !== '人工' && !/^(?:综合 )?(?:人工\+)?S[1-9]\d*(?:\+S[1-9]\d*)*$/u.test(value)) invalid('正文来源标记形式无法核对，请先检查来源归属。');
      for (const number of value.matchAll(/S(\d+)/gu)) if (!numbers.has(Number(number[1]))) invalid('正文来源标记引用了未登记的编号，请先核对来源映射。');
    }
    if (line.heading) {
      for (const level of scope.keys()) if (level >= line.heading.level) scope.delete(level);
      scope.set(line.heading.level, markers.length > 0 || [...scope.values()].some(Boolean));
    } else if (line.text.trim() && line.text.trim() !== '暂无可直接引用的原文表达' && ![...scope.values()].some(Boolean)) {
      invalid('旧正文有尚未标明来源归属的内容，请先按小节核对来源映射。');
    }
  }
}
function markExistingSections(body: string, marker: string): string {
  const locations = headings(body).filter((heading) => (heading.level <= 2 && !heading.title.startsWith('可复用表达'))
    || heading.level === 3 && (heading.title.startsWith('原文引用') || heading.title.startsWith('个人总结')));
  for (const heading of locations.reverse()) {
    const line = body.slice(heading.start, heading.end);
    const suffix = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '';
    const contentEnd = heading.end - suffix.length;
    body = insert(body, contentEnd, ` ${marker}`);
  }
  return body;
}
export function createKnowledgeNote(draft: CandidateDraft, source: string, date: string): Buffer {
  validateDraft(draft);
  return verified(Buffer.from(`---\n${stringify({ 类型: '知识笔记', 来源类型: 'AI提炼', 使用状态: 'AI总结', 知识类型: draft.knowledgeType,
    所属主题: draft.topics.map(wikiLink), 关键词: draft.draft.keywords, 来源资料: [wikiLink(source)],
    适用场景: draft.draft.scenarios, 核心结论: draft.draft.conclusion, 关键要点: draft.draft.keyPoints,
    使用边界: draft.draft.boundary, 创建日期: date, 更新日期: date, 备注: '' }, { lineWidth: 0 })}---\n\n${contentBody(draft)}`));
}
export function mergeKnowledgeNote(before: Buffer, drafts: CandidateDraft[], source: string, date: string, mode: 'merge' | 'reference', confirmLegacySources = false): Buffer {
  const record = parseKnowledgeNote(before).record;
  if (!record) invalid('已有知识格式需要先检查，不能直接合并。');
  if (record.usageStatus === '过时') invalid('过时知识不再累积活跃内容，请新建替代笔记。');
  if (record.usageStatus === '定论' && mode !== 'reference') invalid('这篇知识已设为定论，只能补充出处；新判断请保留为独立候选。');
  const parsed = parseFrontmatter(before);
  const oldSources = record.sourceMaterials.map(linkTarget);
  const sources = unique([...oldSources, linkTarget(source)]);
  const changes: Record<string, unknown> = { 来源资料: sources.map(wikiLink), 更新日期: date };
  if (mode === 'reference') return verified(patchFrontmatter(before, changes));
  for (const draft of drafts) validateDraft(draft);
  const pending = record.usageStatus === '已优化';
  if (pending) changes.备注 = [parsed.data.备注, `AI待认: ${date}`].filter(Boolean).join('\n');
  // Recall judgments and original content remain intact; new material is local to
  // its fixed section and carries its own source and recognition status.
  let body = Buffer.from(parsed.bodyBytes).toString('utf8');
  const mapHeading = section(body, '来源映射', 2);
  const oldMap = mapHeading ? body.slice(mapHeading.start) : '';
  if (mapHeading) body = body.slice(0, mapHeading.start);
  body = fixedSections(body).body;
  if (unique(oldSources).length !== oldSources.length) invalid('已有来源资料包含重复项，请先核对来源归属。');
  const mapped = oldMap !== '' || sources.length > 1 || oldSources.length === 0;
  let mapping = new Map<string, number>();
  if (oldMap) {
    mapping = parseSourceMap(oldMap, oldSources);
    assertMappedBody(body, mapping);
  } else if (mapped) {
    if (headings(body).some((heading) => /〔(?:综合 |人工|S)/u.test(heading.title))) invalid('正文已有来源标记但缺少来源映射，请先核对编号归属。');
    if (oldSources.length > 1 && !confirmLegacySources) invalid('旧笔记有多个来源但没有来源映射，请先核对并确认旧内容共同来自这些来源。');
    if (!oldSources.length && record.sourceType !== '人工输入') invalid('旧知识缺少来源资料，无法确认旧正文的来源归属。');
    mapping = new Map(oldSources.map((path, index) => [path, index + 1]));
    const marker = oldSources.length ? `〔${oldSources.length > 1 ? '综合 ' : ''}${[...mapping.values()].map((number) => `S${number}`).join('+')}〕` : '〔人工〕';
    body = markExistingSections(body, marker);
    assertMappedBody(body, mapping);
  }
  const isNewSource = !mapping.has(linkTarget(source));
  if (mapped && isNewSource) mapping.set(linkTarget(source), Math.max(0, ...mapping.values()) + 1);
  const marker = mapped ? ` 〔S${mapping.get(linkTarget(source))}〕` : '';
  const title = (draft: CandidateDraft, level: string) => `${level} ${draft.title}（${date}补充）${pending ? ' ==AI待认==' : ''}${marker}\n\n`;
  const knowledge = drafts.map((draft) => `${title(draft, '###')}${draft.coreContent.trim()}\n\n`).join('');
  const quotes = drafts.filter((draft) => draft.draft.quotes.length).map((draft) => `${title(draft, '####')}${draft.draft.quotes.map((quote) => `原文引用：\n\n> ${quote.replace(/\n/gu, '\n> ')}`).join('\n\n')}\n\n`).join('');
  const summaries = drafts.map((draft) => `${title(draft, '####')}${draft.draft.summaries.map((summary) => `- ${summary.startsWith('个人总结') ? summary : `个人总结：${summary}`}`).join('\n')}\n\n`).join('');
  let sections = fixedSections(body);
  if (quotes && body.slice(sections.quotes.end, sections.summaries.start).trim() === '暂无可直接引用的原文表达') {
    body = body.slice(0, sections.quotes.end) + '\n' + body.slice(sections.summaries.start);
    sections = fixedSections(body);
  }
  // Offset insertion treats user content literally, including dollar replacements.
  const additions = [{ at: sections.reusable.start, text: knowledge }, { at: sections.summaries.start, text: quotes }, { at: sections.reusableEnd, text: summaries }];
  for (const addition of additions.sort((a, b) => b.at - a.at)) if (addition.text) body = insert(body, addition.at, `\n${addition.text}`);
  if (mapped) {
    assertMappedBody(body, mapping);
    body += oldMap || `\n## 来源映射\n\n${[...mapping].map(([path, number]) => `- S${number}：${wikiLink(path)}；${oldSources.includes(path) ? '沿用旧笔记已核对的来源' : '本次补充内容来源'}。`).join('\n')}\n`;
    if (oldMap && isNewSource) body += `\n- S${mapping.get(linkTarget(source))}：${wikiLink(source)}；本次补充内容来源。\n`;
  }
  const patched = patchFrontmatter(before, changes);
  const oldBody = parseFrontmatter(patched).bodyBytes;
  return verified(Buffer.concat([patched.subarray(0, patched.length - oldBody.length), Buffer.from(body)]));
}
