import { basename, dirname } from 'node:path';
import { isIsoCalendarDate } from '../../shared/domain/iso-date.js';
import { currentKnowledgePath, currentNoteTimestamp } from '../ingestion/current-note-format.js';
import { assertKnowledgeTitle, patchFrontmatter, wikiLink } from '../ingestion/note-format.js';
import { PublicApiError } from '../../shared/api/errors.js';
import { FrontmatterError, parseFrontmatter } from '../rules/frontmatter.js';
import { normalizeWikiLinkList } from '../rules/wikilinks.js';
import { conflict, digest, DiscussionFiles, type Change } from './writer-files.js';

export type DiscussionStatus = '未探讨' | '部分探讨完成' | '全面探讨完成';
export interface ChatSave {
  sessionId: string; day: string; startedAt: string; endedAt?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  materialPaths: string[]; keywords: string[]; continuedPaths?: string[];
  confirmedStatuses?: { path: string; status: DiscussionStatus; expectedStatus: DiscussionStatus }[];
}
export interface DiaryKnowledge {
  title: string; directory: string; existingPath?: string; expectedHash?: string;
  coreContent: string; body: string; keywords: string[]; materialPaths: string[];
}
export interface DiarySave {
  operationId?: string; day: string; keywords: string[]; chatPaths: string[]; materialPaths: string[];
  body: string; expectedDiaryHash: string | null; knowledge: DiaryKnowledge[];
}

const material = /^01图书馆\/(?:01公域资料|02个人资料)\/.+\.md$/u;
const knowledge = /^03知识库\/(?!档案室(?:\/|$)).+\.md$/u;
const statuses = new Set<DiscussionStatus>(['未探讨', '部分探讨完成', '全面探讨完成']);
const unique = (values: string[]) => [...new Set(values)];
function dayDirectory(day: string) {
  if (!isIsoCalendarDate(day)) conflict('日记归属日期无效。');
  return ['02日记本', day.slice(0, 4), day.slice(0, 7), day].join('/');
}
function diaryName(day: string) { return dayDirectory(day) + '/小兆日记｜' + day + '.md'; }
function stamp(s: string) {
  const time = new Date(s);
  if (!Number.isFinite(time.getTime())) conflict('聊天时间无效。');
  return currentNoteTimestamp(time);
}
function chatName(day: string, start: string, end?: string) {
  const display = (s: string) => s.slice(0, 10) + '_' + s.slice(11).replace(':', '：');
  const suffix = end && end.startsWith(start.slice(0, 10)) ? display(end).slice(11) : end ? display(end) : '进行中';
  return dayDirectory(day) + '/聊天记录｜' + display(start) + '-' + suffix + '.md';
}
function note(data: Record<string, unknown>, body: string) {
  const header = Object.entries(data).map(([k, v]) => k + ': ' + (v === null ? '' : JSON.stringify(v))).join('\n');
  return Buffer.from('---\n' + header + '\n---\n' + body);
}
function strings(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some(i => typeof i !== 'string')) conflict('笔记关联或关键词字段需要先核对。');
  return v as string[];
}
function linkedPaths(v: unknown) {
  return normalizeWikiLinkList(strings(v)).map(s => s.endsWith('.md') ? s : s + '.md');
}
function addLinks(existing: unknown, paths: string[]) {
  const known = new Set(linkedPaths(existing));
  return [...strings(existing), ...unique(paths).filter(p => !known.has(p)).map(wikiLink)];
}
function withBody(before: Buffer, changes: Record<string, unknown>, body: string) {
  const patched = patchFrontmatter(before, changes);
  return Buffer.concat([patched.subarray(0, patched.length - parseFrontmatter(patched).bodyBytes.length), Buffer.from(body)]);
}
function readNote(files: DiscussionFiles, path: string, kind: string) {
  const bytes = files.read(path);
  if (!bytes) conflict('找不到本次依据的笔记：' + path);
  const { data, bodyBytes } = parseFrontmatter(bytes);
  if (data.类型 !== kind) conflict('文件类型与本次操作不符：' + path);
  return { bytes, data, body: Buffer.from(bodyBytes).toString('utf8') };
}
function assertMaterial(path: string) {
  if (!material.test(path)) conflict('请选择本库中已入馆的资料。');
}
function assertKnowledge(path: string) {
  if (!knowledge.test(path)) conflict('请选择本库现行知识笔记。');
}

export class DiscussionWriter {
  private files: DiscussionFiles;
  constructor(root: string, stateDirectory: string, private now: () => Date = () => new Date()) {
    this.files = new DiscussionFiles(root, stateDirectory);
  }

  private *chatDays() {
    const directories = (path: string, pattern: RegExp) => this.files.children(path)
      .filter(e => e.isDirectory() && pattern.test(e.name)).map(e => e.name).sort().reverse();
    for (const year of directories('02日记本', /^\d{4}$/u)) {
      for (const month of directories('02日记本/' + year, /^\d{4}-\d{2}$/u)) {
        for (const day of directories(['02日记本', year, month].join('/'), /^\d{4}-\d{2}-\d{2}$/u)) {
          if (day.startsWith(month) && month.startsWith(year) && isIsoCalendarDate(day)) yield day;
        }
      }
    }
  }

  readPriorChat(path: string) {
    const day = basename(dirname(path));
    if (!isIsoCalendarDate(day) || dirname(path) !== dayDirectory(day) || !/^聊天记录｜[^/]+\.md$/u.test(basename(path))) {
      conflict('请选择日记本日期目录中的聊天记录。');
    }
    const { bytes, body, data } = readNote(this.files, path, '聊天记录');
    const start = data.开始时间;
    if (typeof start !== 'string' || !/^\d{4}-\d{2}-\d{2}-(?:[01]\d|2[0-3]):[0-5]\d$/u.test(start)
      || !isIsoCalendarDate(start.slice(0, 10))) conflict('聊天记录缺少有效的开始时间。');
    const startedAt = new Date(start.slice(0, 10) + 'T' + start.slice(11) + ':00+08:00').toISOString();
    const firstRemark = /^## 小兆[ \t]*\r?\n(?:[ \t]*\r?\n)*([^\r\n]+)/mu.exec(body)?.[1]?.trim();
    const title = (strings(data.关键词).filter(Boolean).join('、') || firstRemark || basename(path, '.md')).slice(0, 150);
    return { path, day, title, startedAt, body, hash: digest(bytes), materialPaths: linkedPaths(data.关联资料) };
  }

  listChatHistory() {
    const history: {path: string; title: string; startedAt: string; materialPaths: string[]}[] = [];
    for (const day of this.chatDays()) {
      const directory = dayDirectory(day);
      for (const file of this.files.children(directory)) {
        if (!file.isFile() || !/^聊天记录｜.+\.md$/u.test(file.name)) continue;
        try {
          const { path, title, startedAt, materialPaths } = this.readPriorChat(directory + '/' + file.name);
          history.push({ path, title, startedAt, materialPaths });
        } catch (error) {
          // A malformed note is not a selectable transcript. Storage failures
          // still surface so an inaccessible history is not reported as empty.
          if (!(error instanceof PublicApiError || error instanceof FrontmatterError)) throw error;
        }
      }
    }
    return history.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.path.localeCompare(a.path));
  }

  listDailyChats(day: string) {
    const directory = dayDirectory(day);
    return this.files.children(directory)
      .filter(e => e.isFile() && /^聊天记录｜.+\.md$/u.test(e.name))
      .sort((a, b) => b.name.localeCompare(a.name)).map(e => {
        const path = directory + '/' + e.name;
        const { bytes, data, body } = readNote(this.files, path, '聊天记录');
        return { path, day, body, hash: digest(bytes), materialPaths: linkedPaths(data.关联资料) };
      });
  }

  findRelatedChats(materialPaths: string[]) {
    const wanted = new Set(materialPaths);
    const matches: ReturnType<DiscussionWriter['listDailyChats']> = [];
    if (!wanted.size) return matches;
    for (const day of this.chatDays()) {
      for (const chat of this.listDailyChats(day)) {
        if (chat.materialPaths.some(p => wanted.has(p))) matches.push(chat);
        if (matches.length === 6) return matches;
      }
    }
    return matches;
  }

  readDiary(day: string) {
    const path = diaryName(day);
    if (!this.files.read(path)) return { path, body: '', hash: null, chatPaths: [] as string[], materialPaths: [] as string[] };
    const { bytes, data, body } = readNote(this.files, path, '小兆日记');
    if (data.日期 !== day) conflict('日记日期和文件位置不一致。');
    return { path, body, hash: digest(bytes), chatPaths: linkedPaths(data.关联聊天记录), materialPaths: linkedPaths(data.关联资料) };
  }

  readKnowledge(path: string) {
    assertKnowledge(path);
    const { bytes, body, data } = readNote(this.files, path, '知识笔记');
    return { path, body, hash: digest(bytes), coreContent: String(data.核心内容 ?? '') };
  }

  saveChat(input: ChatSave) {
    const id = digest(JSON.stringify(input));
    const receipt = this.files.run('chat:' + id, id, lookup => {
      const { day, sessionId, startedAt, endedAt, materialPaths, messages, keywords } = input;
      const start = stamp(startedAt), end = endedAt ? stamp(endedAt) : undefined;
      if (!messages.length || !messages.some(m => m.role === 'user') || (end && end < start)) conflict('请先进行有效的交流，再保存聊天记录。');
      const known = lookup(sessionId);
      if (known && (known.startedAt !== startedAt || known.day !== day)) conflict('请重新读取本次聊天的保存状态。');
      const existing = known ? readNote(this.files, known.path, '聊天记录') : null;
      if (known && existing && digest(existing.body) !== known.bodyHash) conflict('聊天正文已在其他位置修改，原记录已保留。');
      const body = '\n' + messages.map(m => (m.role === 'user' ? '## 小兆\n\n' : '## AI\n\n') + m.content).join('\n\n') + '\n';
      if (known?.ended && existing && (body !== existing.body || (end && end !== existing.data.结束时间))) conflict('已结束的聊天不能追加或修改原发言。');
      if (existing && !body.startsWith(existing.body)) conflict('不能覆盖原聊天记录中已有的发言。');
      let path = known && (!end || known.ended) ? known.path : chatName(day, start, end);
      if (path !== known?.path) {
        const base = path.slice(0, -3);
        for (let n = 2; this.files.read(path) || this.files.latestChatPath(path) !== path; n++) {
          path = base + '｜' + String(n).padStart(2, '0') + '.md';
        }
      }
      const changes: Change[] = [];
      const sources = new Map(unique(materialPaths).map(p => {
        assertMaterial(p);
        return [p, readNote(this.files, p, '原始资料')];
      }));
      for (const s of input.confirmedStatuses ?? []) {
        const src = sources.get(s.path);
        if (!src || !statuses.has(s.status)) conflict('所确认的资料状态无效。');
        if (src.data.探讨状态 !== s.expectedStatus && src.data.探讨状态 !== s.status) conflict('资料探讨状态已改变，请重新确认：' + s.path);
        if (src.data.探讨状态 !== s.status) this.files.stage(changes, s.path, src.bytes, patchFrontmatter(src.bytes, { 探讨状态: s.status }));
      }
      const continued = (input.continuedPaths ?? []).map(p => {
        if (!p.startsWith('02日记本/') || !p.endsWith('.md')) conflict('接续记录路径无效。');
        return this.files.latestChatPath(p);
      });
      for (const p of continued) {
        if (!p.startsWith('02日记本/') || !basename(p).startsWith('聊天记录｜') || !p.endsWith('.md') || p === path) conflict('接续记录路径无效。');
        readNote(this.files, p, '聊天记录');
      }
      const fields = {
        接续记录: addLinks(existing?.data.接续记录, continued),
        结束时间: end ?? existing?.data.结束时间 ?? null, 关联资料: addLinks(existing?.data.关联资料, materialPaths),
        关键词: unique([...strings(existing?.data.关键词), ...keywords])
      };
      const after = existing ? withBody(existing.bytes, fields, body) : note({
        类型: '聊天记录', 开始时间: start, ...fields, 关联日记: []
      }, body);
      this.files.stage(changes, path, path === known?.path && existing ? existing.bytes : null, after);
      if (known && existing && path !== known.path) {
        for (const diaryPath of linkedPaths(existing.data.关联日记)) {
          if (diaryPath !== diaryName(day)) conflict('聊天还关联了其他日期的日记，请先核对关联。');
          const diary = readNote(this.files, diaryPath, '小兆日记');
          const links = strings(diary.data.关联聊天记录).map(link => linkedPaths([link])[0] === known.path ? wikiLink(path) : link);
          const bodyWithUpdatedLinks = diary.body.replaceAll(wikiLink(known.path), wikiLink(path));
          this.files.stage(changes, diaryPath, diary.bytes, withBody(diary.bytes, { 关联聊天记录: links }, bodyWithUpdatedLinks));
        }
        // A second conversation may already refer back to the unfinished transcript.
        for (const linkedDay of this.chatDays()) {
          for (const chat of this.listDailyChats(linkedDay)) {
            if (chat.path === known.path) continue;
            const linked = readNote(this.files, chat.path, '聊天记录');
            if (!linkedPaths(linked.data.接续记录).includes(known.path)) continue;
            const updated = strings(linked.data.接续记录).map(link => linkedPaths([link])[0] === known.path ? wikiLink(path) : link);
            this.files.stage(changes, chat.path, linked.bytes, patchFrontmatter(linked.bytes, { 接续记录: updated }));
          }
        }
        this.files.stage(changes, known.path, existing.bytes, null);
      }
      return { changes, ...(known && path !== known.path ? { moved: { from: known.path, to: path } } : {}), session: { id: sessionId, value: { path, day, startedAt, bodyHash: digest(body), ended: Boolean(end || known?.ended) } }, result: { chatPath: path } };
    });
    return { chatPath: this.files.latestChatPath(receipt.chatPath) };
  }

  saveDiary(input: DiarySave) {
    const fingerprint = digest(JSON.stringify(input));
    return this.files.run('diary:' + (input.operationId ?? fingerprint), fingerprint, () => {
      const { day, keywords, body, chatPaths, materialPaths } = input;
      const diaryPath = diaryName(day), changes: Change[] = [];
      const before = this.files.read(diaryPath);
      if ((before ? digest(before) : null) !== input.expectedDiaryHash) conflict('日记已更新，请结合最新原文重新整理。');
      if (!body.trim() || !chatPaths.length) conflict('日记需要有实际聊天记录和正文。');
      const diary = before ? readNote(this.files, diaryPath, '小兆日记') : null;
      if (diary && diary.data.日期 !== day) conflict('日记日期和文件位置不一致。');
      const sourceSet = new Set(materialPaths);
      const available = new Set(linkedPaths(diary?.data.关联资料));
      for (const path of unique(chatPaths)) {
        if (dirname(path) !== dayDirectory(day) || !basename(path).startsWith('聊天记录｜') || !path.endsWith('.md')) conflict('聊天记录不属于这篇日记。');
        const chat = readNote(this.files, path, '聊天记录');
        linkedPaths(chat.data.关联资料).forEach(p => available.add(p));
        const links = addLinks(chat.data.关联日记, [diaryPath]);
        if (links.length !== strings(chat.data.关联日记).length) this.files.stage(changes, path, chat.bytes, patchFrontmatter(chat.bytes, { 关联日记: links }));
      }
      for (const path of sourceSet) {
        assertMaterial(path);
        if (!available.has(path)) conflict('日记出现了本次聊天未使用的资料。');
        const src = readNote(this.files, path, '原始资料');
        const links = addLinks(src.data.关联日记, [diaryPath]);
        if (links.length !== strings(src.data.关联日记).length) this.files.stage(changes, path, src.bytes, patchFrontmatter(src.bytes, { 关联日记: links }));
      }
      const now = currentNoteTimestamp(this.now()), knowledgePaths: string[] = [];
      const classification = input.knowledge.length ? this.files.read('00大脑规则/06知识库分类规则.md')?.toString('utf8') : '';
      if (classification === undefined) conflict('找不到当前知识库分类规则。');
      for (const item of input.knowledge) {
        assertKnowledgeTitle(item.title);
        if (!item.coreContent.trim() || !item.body.trim() || !item.materialPaths.every(p => sourceSet.has(p))) conflict('知识正文或关联资料无效。');
        const dir = item.directory.replace(/\/\d{4}(?:\/\d{4}-\d{2})?$/u, '');
        if (!item.existingPath) {
          assertKnowledge(dir + '/分类.md');
          this.files.directory(dir);
        }
        const path = item.existingPath ?? currentKnowledgePath(dir, item.title, now, classification);
        assertKnowledge(path);
        if (knowledgePaths.includes(path)) conflict('同一篇知识得到了多项更新，请合并后保存。');
        const prior = this.files.read(path);
        if (item.existingPath ? !prior || !item.expectedHash || digest(prior) !== item.expectedHash : !!prior) conflict('同名知识已存在或发生变化，请重新查重：' + path);
        const previous = prior ? readNote(this.files, path, '知识笔记') : null;
        const fields = { 更新时间: now, 关键词: unique([...strings(previous?.data.关键词), ...item.keywords]),
          核心内容: previous ? unique([String(previous.data.核心内容 ?? ''), item.coreContent]).filter(Boolean).join(' ') : item.coreContent,
          关联日记: addLinks(previous?.data.关联日记, [diaryPath]), 关联资料: addLinks(previous?.data.关联资料, item.materialPaths) };
        const addition = item.body.trim();
        if (previous && previous.body.includes(addition)) continue;
        const after = previous ? withBody(previous.bytes, fields, previous.body.trimEnd() + '\n\n' + addition + '\n') :
          note({ 类型: '知识笔记', 创建时间: now, ...fields, 历史记录: [] }, '\n# ' + item.title + '\n\n' + addition + '\n');
        this.files.stage(changes, path, prior, after);
        knowledgePaths.push(path);
      }
      const fields = { 关键词: unique([...strings(diary?.data.关键词), ...keywords]),
        关联聊天记录: addLinks(diary?.data.关联聊天记录, chatPaths), 关联资料: addLinks(diary?.data.关联资料, materialPaths),
        关联知识点: addLinks(diary?.data.关联知识点, knowledgePaths) };
      const text = '\n' + body.trim() + '\n';
      const after = diary ? withBody(diary.bytes, fields, text) : note({ 类型: '小兆日记', 日期: day, ...fields }, text);
      this.files.stage(changes, diaryPath, before, after);
      return { changes, result: { diaryPath, knowledgePaths } };
    });
  }
}
