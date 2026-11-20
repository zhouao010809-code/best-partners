import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DiscussionWriter, type ChatSave } from '../../src/server/discussion/writer.js';
import { DiscussionFiles, type Change } from '../../src/server/discussion/writer-files.js';
import { parseFrontmatter } from '../../src/server/rules/frontmatter.js';

let base: string, root: string, state: string, writer: DiscussionWriter;
const day = '2026-11-20', source = '01图书馆/01公域资料/一份资料.md', category = '03知识库/教学/学习方法';
const chat: ChatSave = { sessionId: '第一场', startedAt: '2026-11-20T14:01:25Z', day,
  materialPaths: [source], keywords: ['回忆'], messages: [
    { role: 'user', content: '我想先合上书。\n\n再自己讲一遍。' },
    { role: 'assistant', content: '你会用什么判断自己理解了？' }
  ] };
function set(path: string, value: string) {
  mkdirSync(join(root, dirname(path)), { recursive: true });
  writeFileSync(join(root, path), value);
}
function read(path: string) { return parseFrontmatter(readFileSync(join(root, path))); }
const makeWriter = () => new DiscussionWriter(root, state, () => new Date('2026-11-20T15:55:00Z'));
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'discussion-writer-')); root = join(base, 'vault'); state = join(base, 'app');
  set(source, '---\n类型: 原始资料\n探讨状态: 未探讨\n关联日记: []\n---\n\n原文逐字保留。\n');
  set('00大脑规则/06知识库分类规则.md', '| AI技巧〔年月〕 | 使用技巧 |\n');
  mkdirSync(join(root, category), { recursive: true }); writer = makeWriter();
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

it('暂停、整理、恢复和跨日结束均保持原文并更新链接，重复提交不会多写知识', () => {
  const before = read(source).bodyBytes;
  const first = writer.saveChat(chat).chatPath;
  expect(first.endsWith('2026-11-20_22：01-进行中.md')).toBe(true);
  expect(read(source).data.探讨状态).toBe('未探讨');
  expect(Buffer.from(read(first).bodyBytes).toString()).toContain('## 小兆\n\n我想先合上书。\n\n再自己讲一遍。');
  const proposal = { day, expectedDiaryHash: null, body: '# 小兆日记｜2026-11-20\n\n我想先合上书，再自己讲一遍。',
    keywords: ['回忆'], chatPaths: [first], materialPaths: [source],
    knowledge: [{ title: '复述帮助理解', directory: category, keywords: ['复述'],
      coreContent: '合上书复述。', body: '先合上书，再自己讲一遍。', materialPaths: [source] }] };
  const saved = writer.saveDiary(proposal), note = saved.knowledgePaths[0]!;
  writer = makeWriter();
  expect(writer.saveDiary(proposal)).toEqual(saved);
  const link = (p: string) => '[[' + p.slice(0, -3) + ']]';
  expect(read(note).data.关联日记).toEqual([link(saved.diaryPath)]);
  expect(read(saved.diaryPath).data.关联知识点).toEqual([link(note)]);
  expect(read(source).data.关联日记).toEqual([link(saved.diaryPath)]);
  const finished = writer.saveChat({ ...chat, endedAt: '2026-11-20T16:12:25Z',
    messages: [...chat.messages, { role: 'user', content: '我能举出自己的例子。' }],
    confirmedStatuses: [{ path: source, status: '部分探讨完成', expectedStatus: '未探讨' }] }).chatPath;
  expect(finished.endsWith('2026-11-20_22：01-2026-11-21_00：12.md')).toBe(true);
  expect(existsSync(join(root, first))).toBe(false);
  expect(read(saved.diaryPath).data.关联聊天记录).toEqual([link(finished)]);
  expect(read(source).data.探讨状态).toBe('部分探讨完成');
  expect(read(source).bodyBytes).toEqual(before);
  const latest = writer.readDiary(day), old = writer.readKnowledge(note);
  const updated = { ...proposal, expectedDiaryHash: latest.hash, chatPaths: [finished], body: latest.body + '\n我能举出自己的例子。',
    knowledge: [{ ...proposal.knowledge[0]!, existingPath: note, expectedHash: old.hash, coreContent: '再举自己的例子。', body: '最后举出自己的例子。' }] };
  writer.saveDiary(updated);
  expect(Buffer.from(read(note).bodyBytes).toString()).toContain('先合上书，再自己讲一遍。\n\n最后举出自己的例子。');
  expect(read(note).data.关联日记).toEqual([link(saved.diaryPath)]);
  expect(() => writer.saveDiary({ ...updated, body: '外部修改不能被覆盖' })).toThrow(/日记已更新/);
});

it('不依据未发生的交流修改进度，阻断路径越界，遇到外部改动保留双方记录', () => {
  const first = writer.saveChat(chat).chatPath;
  const second = writer.saveChat({ ...chat, sessionId: '同一分钟的另一场' }).chatPath;
  expect(second).not.toBe(first);
  const raw = readFileSync(join(root, first), 'utf8');
  set(first, raw + '\n用户手工改动。');
  expect(() => writer.saveChat({ ...chat, endedAt: '2026-11-20T15:00:00Z' })).toThrow(/其他位置修改/);
  const unsafe = { day, body: '日记', chatPaths: [second], materialPaths: [source], expectedDiaryHash: null, keywords: [],
    knowledge: [{ title: '标题', coreContent: '一', body: '一', keywords: [], materialPaths: [], directory: '03知识库/../01图书馆' }] };
  expect(() => writer.saveDiary(unsafe)).toThrow(/路径无效/);
  symlinkSync(base, join(root, '03知识库', '越界目录'));
  expect(() => writer.saveDiary({ ...unsafe, knowledge: [{ ...unsafe.knowledge[0]!, directory: '03知识库/越界目录' }] })).toThrow(/链接/);
  expect(writer.readDiary(day).hash).toBe(null);
  expect(read(source).data.关联日记).toEqual([]);
});

it('已经结束的记录可确认状态，随后保存同日的其他对话可以沿用旧来源', () => {
  const ended = { ...chat, endedAt: '2026-11-20T14:30:00Z' };
  const first = writer.saveChat(ended).chatPath;
  expect(writer.saveChat({ ...ended, confirmedStatuses: [{path: source, status: '全面探讨完成', expectedStatus: '未探讨'}] }).chatPath).toBe(first);
  const saved = writer.saveDiary({ day, keywords: [], chatPaths: [first], materialPaths: [source], expectedDiaryHash: null,
    body: '我学到了复述。', knowledge: [] });
  expect(writer.listDailyChats(day).map(c => c.path)).toEqual([first]);
  expect(writer.findRelatedChats([source]).map(c => c.path)).toEqual([first]);
  const next = writer.saveChat({ ...chat, sessionId: '新的交流', materialPaths: [], continuedPaths: [first], messages: [{role: 'user', content: '在会议上也能用。'}] }).chatPath;
  const prior = writer.readDiary(day);
  writer.saveDiary({ day, keywords: [], chatPaths: [next], materialPaths: [source], expectedDiaryHash: prior.hash,
    body: prior.body + '\n在会议上也能用。', knowledge: [] });
  expect(read(saved.diaryPath).data.关联聊天记录).toHaveLength(2);
  expect(read(saved.diaryPath).data.关联资料).toHaveLength(1);
  expect(read(next).data.接续记录).toEqual(['[[' + first.slice(0, -3) + ']]']);
});

it('部分写入中断可恢复，外部修改出现后允许按最新正文另行整理', () => {
  const first = writer.saveChat(chat).chatPath;
  const input = {day, keywords: [], chatPaths: [first], materialPaths: [source], expectedDiaryHash: null,
    body: '我学到了复述。', knowledge: []};
  const target = DiscussionFiles.prototype as unknown as {apply(c: Change): void};
  const apply = target.apply;
  let count = 0;
  const fail = vi.spyOn(target, 'apply').mockImplementation(function(this: DiscussionFiles, c: Change) {
    if (++count === 2) throw Error('模拟中断');
    return apply.call(this, c);
  });
  try { expect(() => writer.saveDiary(input)).toThrow('模拟中断'); } finally { fail.mockRestore(); }
  expect(read(first).data.关联日记).toHaveLength(1);
  set(source, readFileSync(join(root, source), 'utf8') + '\n其他程序新增的正文。');
  writer = makeWriter();
  expect(() => writer.saveDiary(input)).toThrow(/重新读取/);
  expect(read(first).data.关联日记).toEqual([]);
  expect(readFileSync(join(root, source), 'utf8')).toContain('其他程序新增的正文。');
  const after = writer.saveDiary({...input, operationId: '重新整理'});
  expect(read(first).data.关联日记).toEqual(['[[' + after.diaryPath.slice(0, -3) + ']]']);
});

it('历史列表覆盖已有、无资料的聊天，读取正文不更改原件，也不能打开日记或越界文件', () => {
  const path = '02日记本/2026/2026-10/2026-10-19/聊天记录｜2026-10-19_14：20-进行中.md';
  const bytes = '---\n类型: 聊天记录\n开始时间: "2026-10-19-14:20"\n关键词: []\n关联资料: []\n---\n\n## 小兆\n\n想聊一下今天第一次上课。\n';
  set(path, bytes);
  set(path.replace('聊天记录｜2026-10-19_14：20-进行中', '小兆日记｜2026-10-19'), '---\n类型: 小兆日记\n---\n私人日记。');
  set(path.replace('14：20', '10：00'), '---\n类型: 小兆日记\n---\n不是聊天。');
  expect(writer.listChatHistory()).toEqual([{path, title: '想聊一下今天第一次上课。', startedAt:'2026-10-19T06:20:00.000Z', materialPaths: []}]);
  expect(writer.readPriorChat(path).body).toContain('今天第一次上课');
  expect(readFileSync(join(root,path),'utf8')).toBe(bytes);
  expect(() => writer.readPriorChat(path.replace('14：20','10：00'))).toThrow(/文件类型/);
  expect(() => writer.readPriorChat(path.replace('2026-10/', '2026-09/'))).toThrow(/日期目录/);
  expect(() => writer.readPriorChat(source)).toThrow(/日期目录/);
});
