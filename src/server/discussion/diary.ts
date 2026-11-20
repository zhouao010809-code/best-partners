import { randomUUID, createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { PublicApiError } from '../../shared/api/errors.js';
import type { IndexRepository } from '../index/index-repository.js';
import type { ReadVaultGateway } from '../vault/VaultGateway.js';
import { diaryReport, knowledgeReport, parseReport, type createDiscussionModel } from './model.js';
import type { StoredSession } from './session.js';
import type { DiscussionWriter } from './writer.js';

type DiaryInput = Parameters<DiscussionWriter['saveDiary']>[0];
type Cursors = Record<string, number | string>;
type Pending = { input: DiaryInput; cursors: Cursors };
type Model = ReturnType<typeof createDiscussionModel>;
function allowed(paths: string[], available: Set<string>) {
  if (paths.some((path) => !available.has(path)))
    throw new PublicApiError('DISCUSSION_INVALID_RESULT', '整理结果引用了本次未使用的资料，请重试。', 502);
  return [...new Set(paths)];
}
async function categoryDirectories(gateway: ReadVaultGateway) {
  const paths: string[] = [];
  async function collect(dir: string, depth: number) {
    const dirs = (await gateway.listDirectory(dir)).filter(
      (entry) => entry.endsWith('/') && !/^(档案室|\d{4}|\d{4}-\d{2})\/$/u.test(entry)
    );
    if (dir !== '03知识库' && !dirs.length) paths.push(dir);
    if (depth < 6) for (const entry of dirs) await collect(dir + '/' + entry.slice(0, -1), depth + 1);
  }
  await collect('03知识库', 0);
  return paths;
}

export function createDiaryService(input: {
  database: Database.Database;
  writer: DiscussionWriter;
  gateway: ReadVaultGateway;
  repository: IndexRepository;
  model: Model;
  saveTranscript: (session: StoredSession) => Promise<void>;
}) {
  const { database, writer, model } = input;
  const getDay = database.prepare('SELECT cursors,pending_plan FROM personal_discussion_diaries WHERE day=?');
  const init = database.prepare("INSERT OR IGNORE INTO personal_discussion_diaries(day,cursors) VALUES (?,'{}')");
  const stage = database.prepare('UPDATE personal_discussion_diaries SET pending_plan=? WHERE day=?');
  const finish = database.prepare('UPDATE personal_discussion_diaries SET cursors=?,pending_plan=NULL WHERE day=?');

  async function prepare(
    day: string,
    sessions: StoredSession[],
    cursors: Cursors,
    existing: Awaited<ReturnType<DiscussionWriter['readDiary']>>
  ) {
    const offset = (id: string) => (typeof cursors[id] === 'number' ? cursors[id] : 0);
    const changed = sessions.filter(
      (s) =>
        s.value.messages.length > offset(s.value.id) &&
        s.value.phase !== 'prepared' &&
        s.value.messages.slice(offset(s.value.id)).some((m) => m.role === 'user')
    );
    for (const s of changed) await input.saveTranscript(s);
    const appPaths = new Set(sessions.map((s) => s.value.chatPath));
    const external = (await writer.listDailyChats(day))
      .filter((chat) => !appPaths.has(chat.path))
      .map((chat) => ({ ...chat, bodyHash: createHash('sha256').update(chat.body).digest('hex') }));
    const extChanged = external.filter((chat) => cursors['chat:' + chat.path] !== chat.bodyHash);
    if (!changed.length && !extChanged.length) return;
    const chatPaths = [...changed.map((s) => s.value.chatPath!), ...extChanged.map((chat) => chat.path)];
    const materialPaths = new Set([
      ...existing.materialPaths,
      ...changed.flatMap((s) => s.value.materialPaths),
      ...extChanged.flatMap((chat) => chat.materialPaths)
    ]);
    const transcripts = changed.map((s) => ({
      title: s.value.title,
      chatPath: s.value.chatPath,
      materialPaths: s.value.materialPaths,
      messages: s.value.messages.slice(offset(s.value.id))
    }));
    const draft = parseReport(
      diaryReport,
      await model.run(
        'diary',
        '现在整理这一天的小兆日记。保留已有正文的内容，根据实际新增对话用第一人称增量整合，不把资料或AI意见当成用户认识。返回单个 JSON 对象：body(含日记标题的完整Markdown正文)、keywords(短关键词数组)、materialPaths(本篇实际用到的资料路径数组)、topics(这次新表达或改变且值得复用的问题，每项 {topic,keywords}，没有填 [])。',
        { day, existingDiary: existing.body, transcripts, existingChats: extChanged }
      )
    );
    const newSources = allowed(draft.materialPaths, materialPaths);
    const knowledge: DiaryInput['knowledge'] = [];
    if (draft.topics.length) {
      const related = new Set<string>();
      for (const { topic, keywords } of draft.topics) {
        for (const search of [topic, ...keywords]) {
          const hits = input.repository.listKnowledge({ search, pageSize: 4 }).items;
          for (const hit of hits) if (!hit.path.startsWith('03知识库/档案室/')) related.add(hit.path);
        }
      }
      const existingNotes = await Promise.all([...related].map((path) => writer.readKnowledge(path)));
      const matches = new Map(existingNotes.map((note) => [note.path, note]));
      const directories = await categoryDirectories(input.gateway);
      const result = parseReport(
        knowledgeReport,
        await model.run(
          'knowledge',
          '依据本次日记、实际新增主题与已有知识原文查重。每条只有真正新增或实质补充才写，重复、没有可复用知识返回空数组。输出 JSON {"knowledge":[{"title":"知识标题","directory":"候选分类完整路径","existingPath":null,"coreContent":"要点","body":"正文Markdown","keywords":[],"materialPaths":[]}]}。新建知识请选择给定分类。相同问题的已有知识若确有新内容，existingPath 选实际读过的文件，body 只填需追加的内容且保留原意。materialPaths 只选该知识实际使用的资料，允许为空。禁止编造路径与观点。',
          {
            diary: draft.body,
            topics: draft.topics,
            materialPaths: newSources,
            directories,
            existingNotes: existingNotes.map(({ path, body }) => ({ path, body }))
          }
        )
      );
      const seen = new Set<string>();
      for (const entry of result.knowledge) {
        const note = entry.existingPath ? matches.get(entry.existingPath) : undefined;
        if ((entry.existingPath && !note) || (!note && !directories.includes(entry.directory))) {
          throw new PublicApiError('DISCUSSION_INVALID_RESULT', '知识分类或更新目标无法核实，请重试整理。', 502);
        }
        const key = note?.path ?? entry.directory + '/' + entry.title;
        if (seen.has(key))
          throw new PublicApiError('DISCUSSION_INVALID_RESULT', '模型为同一项知识给出了重复结果，请重试。', 502);
        seen.add(key);
        knowledge.push({
          title: entry.title,
          directory: entry.directory,
          coreContent: entry.coreContent,
          body: entry.body,
          keywords: entry.keywords,
          materialPaths: allowed(entry.materialPaths, new Set(newSources)),
          ...(note ? { existingPath: note.path, expectedHash: note.hash } : {})
        });
      }
    }
    const next = { ...cursors };
    for (const s of changed) next[s.value.id] = s.value.messages.length;
    for (const chat of extChanged) next['chat:' + chat.path] = chat.bodyHash;
    return {
      input: {
        day,
        operationId: randomUUID(),
        chatPaths,
        materialPaths: newSources,
        keywords: draft.keywords,
        body: draft.body,
        expectedDiaryHash: existing.hash,
        knowledge
      },
      cursors: next
    };
  }
  return async (s: StoredSession, sessions: StoredSession[]) => {
    init.run(s.day);
    const row = getDay.get(s.day) as { cursors: string; pending_plan: string | null };
    let plan: Pending | undefined = row.pending_plan ? JSON.parse(row.pending_plan) : undefined;
    if (!plan) {
      const existing = await writer.readDiary(s.day);
      plan = await prepare(s.day, sessions, JSON.parse(row.cursors), existing);
      if (!plan) {
        if (!existing.hash)
          throw new PublicApiError('DISCUSSION_DIARY_EMPTY', '还没有小兆本人的交流内容可以整理。', 409);
        return { diaryPath: existing.path, diaryMarkdown: existing.body, knowledgePaths: s.value.knowledgePaths };
      }
      stage.run(JSON.stringify(plan), s.day);
    }
    try {
      const result = await writer.saveDiary(plan.input);
      const current = await writer.readDiary(s.day);
      finish.run(JSON.stringify(plan.cursors), s.day);
      return { ...result, diaryMarkdown: current.body };
    } catch (error) {
      if (error instanceof PublicApiError && error.code === 'DISCUSSION_WRITE_CONFLICT') stage.run(null, s.day);
      throw error;
    }
  };
}
