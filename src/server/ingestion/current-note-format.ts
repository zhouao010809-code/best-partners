import type { CandidateDraft } from '../../shared/api/ingestion.js';
import { PublicApiError } from '../../shared/api/errors.js';
import { parseFrontmatter } from '../rules/frontmatter.js';
import { parseCurrentKnowledge } from '../rules/current-vault-notes.js';
import { patchFrontmatter, validateDraft, wikiLink, linkTarget } from './note-format.js';

export function currentNoteTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const value = (key: string) => parts.find(part => part.type === key)!.value;
  return `${value('year')}-${value('month')}-${value('day')}-${value('hour')}:${value('minute')}`;
}

export function currentKnowledgePath(directory: string, title: string, timestamp: string, classification: string): string {
  const category = directory.replace(/\/\d{4}(?:\/\d{4}-\d{2})?$/u, '');
  const dated = [...classification.matchAll(/^\|\s*([^|\n]+?)〔年月〕\s*\|/gmu)]
    .some(match => category.endsWith('/' + match[1]!.trim().replaceAll('／', '/')));
  if (!dated) return directory + '/' + title + '.md';
  const day = timestamp.slice(0, 10);
  const name = title.replace(/｜\d{8}$/u, '') + '｜' + day.replaceAll('-', '');
  return [category, day.slice(0, 4), day.slice(0, 7), name + '.md'].join('/');
}

function currentBody(draft: CandidateDraft): string {
  const paragraphs = [draft.coreContent.trim()];
  if (draft.draft.scenarios.length) paragraphs.push('适用场景：' + draft.draft.scenarios.join('、'));
  if (draft.draft.keyPoints.length) paragraphs.push(draft.draft.keyPoints.map(text => '- ' + text).join('\n'));
  if (draft.draft.boundary) paragraphs.push('使用边界：' + draft.draft.boundary);
  if (draft.draft.quotes.length) paragraphs.push('原文引用\n\n' + draft.draft.quotes.map(text => '> ' + text.replaceAll('\n', '\n> ')).join('\n\n'));
  if (draft.draft.summaries.length) paragraphs.push('提炼总结\n\n' + draft.draft.summaries.map(text => '- ' + text).join('\n'));
  if (draft.topics.length) paragraphs.push('相关知识\n\n' + draft.topics.map(topic => '- ' + wikiLink(topic)).join('\n'));
  return paragraphs.join('\n\n');
}

function verified(bytes: Buffer): Buffer {
  if (bytes.length > 450_000 || !parseCurrentKnowledge(bytes, '03知识库/笔记.md').record) {
    throw new PublicApiError('KNOWLEDGE_INVALID', '知识笔记的内容或属性未通过新版格式校验。', 409);
  }
  return bytes;
}

export function createCurrentNote(draft: CandidateDraft, source: string, timestamp: string): Buffer {
  validateDraft(draft);
  const data = { 类型: '知识笔记', 创建时间: timestamp, 更新时间: timestamp,
    关键词: draft.draft.keywords, 核心内容: draft.draft.conclusion, 关联日记: [],
    关联资料: [wikiLink(source)], 历史记录: [] };
  const header = Object.entries(data).map(([key, value]) => key + ': ' + JSON.stringify(value)).join('\n');
  return verified(Buffer.from(`---\n${header}\n---\n\n# ${draft.title}\n\n${currentBody(draft)}\n`));
}

export function mergeCurrentNote(before: Buffer, drafts: CandidateDraft[], source: string, timestamp: string,
  mode: 'merge' | 'reference'): Buffer {
  const record = parseCurrentKnowledge(before, '03知识库/笔记.md').record;
  if (!record || record.usageStatus === '历史记录') throw new PublicApiError('KNOWLEDGE_INVALID', '请选择现行的新版知识笔记。', 409);
  const data = parseFrontmatter(before).data;
  const previousLinks = data.关联资料 as string[];
  const linked = record.sourceMaterials.map(linkTarget).includes(linkTarget(source));
  if (mode === 'reference' && linked) return before;
  const changes: Record<string, unknown> = {};
  if (!linked) changes.关联资料 = [...previousLinks, wikiLink(source)];
  if (mode === 'reference') return verified(patchFrontmatter(before, changes));
  drafts.forEach(validateDraft);
  changes.更新时间 = timestamp;
  changes.关键词 = [...new Set([...record.recallFields.keywords, ...drafts.flatMap(draft => draft.draft.keywords)])];
  changes.核心内容 = [...new Set([record.recallFields.conclusion, ...drafts.map(draft => draft.draft.conclusion)])].join(' ');
  const additions = drafts.map(draft => `## ${draft.title}\n\n${currentBody(draft)}\n\n资料依据：${wikiLink(source)}`);
  const newline = before.includes('\r\n') ? '\r\n' : '\n';
  return verified(Buffer.concat([patchFrontmatter(before, changes),
    Buffer.from(('\n\n' + additions.join('\n\n') + '\n').replaceAll('\n', newline))]));
}
