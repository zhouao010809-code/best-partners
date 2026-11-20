import type Database from 'better-sqlite3';
import {
  discussionActionSchema,
  type DiscussionAction,
  type DiscussionSession,
  type DiscussionStatus
} from '../../shared/api/discussion.js';
import { PublicApiError } from '../../shared/api/errors.js';
import type { AssistantAdapter } from '../assistant/types.js';
import { createIndexRepository } from '../index/index-repository.js';
import type { ReadVaultGateway } from '../vault/VaultGateway.js';
import { createDiaryService } from './diary.js';
import { createDiscussionModel, parseReport, progressReport } from './model.js';
import { newSession, readMaterials, sessionStore, type StoredSession } from './session.js';
import { DiscussionWriter } from './writer.js';

function conflict(message: string): never {
  throw new PublicApiError('DISCUSSION_CONFLICT', message, 409);
}
type StartAction = Extract<DiscussionAction, { type: 'start' | 'continueChat' }>;
type SessionAction = Exclude<DiscussionAction, StartAction>;

type Progress = { path: string; status: DiscussionStatus; expectedStatus: DiscussionStatus };

export function createDiscussionService(input: {
  database: Database.Database;
  gateway: ReadVaultGateway;
  vaultRoot: string;
  stateRoot: string;
  adapter?: AssistantAdapter | undefined;
  refreshIndex: () => Promise<unknown>;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  const store = sessionStore(input.database, now);
  const stop = new AbortController();
  const jobs = new Set<Promise<unknown>>();
  const locks = new Set<string>();
  const model = createDiscussionModel(input.adapter, input.gateway, stop.signal);
  const writer = new DiscussionWriter(input.vaultRoot, input.stateRoot);

  async function saveTranscript(s: StoredSession, confirmedStatuses?: Progress[]) {
    if (!s.value.messages.some((message) => message.role === 'user')) return;
    const { chatPath } = await writer.saveChat({
      sessionId: s.value.id,
      day: s.day,
      startedAt: s.startedAt,
      ...(s.endedAt ? { endedAt: s.endedAt } : {}),
      messages: s.value.messages.map(({ role, text }) => ({ role, content: text })),
      materialPaths: s.value.materialPaths,
      keywords: s.keywords,
      ...(s.continuedPaths?.length ? { continuedPaths: s.continuedPaths } : {}),
      ...(confirmedStatuses ? { confirmedStatuses } : {})
    });
    s.value.chatPath = chatPath;
  }

  const diary = createDiaryService({
    database: input.database,
    writer,
    model,
    gateway: input.gateway,
    repository: createIndexRepository(input.database),
    async saveTranscript(s) {
      await saveTranscript(s);
      // Only attach the saved path; another window may have continued this session meanwhile.
      const latest = store.get(s.value.id);
      if (!latest.value.chatPath && s.value.chatPath) {
        latest.value.chatPath = s.value.chatPath;
        store.save(latest);
      }
    }
  });

  async function start(action: StartAction) {
    if (action.requestId) {
      const previous = store.byRequest(action.requestId);
      if (previous) return previous.value;
    }
    if (action.type === 'continueChat') {
      const prior = writer.readPriorChat(action.chatPath);
      const materials = [];
      const unavailable = [];
      for (const path of prior.materialPaths.slice(0, 32)) {
        try {
          materials.push(...(await readMaterials(input.gateway, [path])));
        } catch {
          unavailable.push(path);
        }
      }
      const session = newSession(now());
      session.continuedPaths = [prior.path];
      session.value.title = prior.title;
      session.value.materialPaths = materials.map((material) => material.path);
      if (unavailable.length || prior.materialPaths.length > 32) {
        session.value.notice = '此次接续已读取原聊天及可用的关联资料，部分关联资料未载入。';
      }
      const reply = await model.run(
        'discuss',
        '小兆已明确要接着一段历史聊天继续。依据旧记录，简短指出当时聊到哪里，从尚待讨论的事情自然接着聊。previousChats 是以前的原话，不要将其作为本轮新发言、假设小兆刚刚表达或替他发言。',
        { previousChats: [prior], materials }
      );
      session.value.messages.push({ role: 'assistant', text: reply });
      store.create(session, action.requestId);
      return session.value;
    }
    if (!action.materialPaths.length && !action.text?.trim())
      throw new PublicApiError('DISCUSSION_INPUT_REQUIRED', '请选择资料，或说说你想聊的事情。', 400);
    const materials = await readMaterials(input.gateway, action.materialPaths);
    const s = newSession(now());
    s.value.materialPaths = materials.map((m) => m.path);
    s.value.title = (materials.map((m) => m.title).join('、') || action.text!.trim()).slice(0, 90);
    s.value.phase = materials.length ? 'prepared' : 'active';
    if (action.text?.trim()) s.value.messages.push({ role: 'user', text: action.text.trim() });
    const previousChats = materials.length ? await writer.findRelatedChats(s.value.materialPaths) : [];
    s.continuedPaths = previousChats.map((chat) => chat.path);
    if (previousChats.length) s.value.phase = 'active';
    const reply = await model.run(
      'discuss',
      previousChats.length
        ? '已找到这些资料此前的真实聊天。先接回小兆实际已谈的认识和未解问题，按照现在的目的继续交流，避免重复首次探讨准备或已经回答的问题。'
        : materials.length
          ? '首次探讨的准备阶段。客观梳理指定资料的内容、观点及真实关联，最后明确已准备好并请小兆确认是否开始探讨；此时不进入探讨提问。'
          : '小兆直接讲述自己的事情，直接围绕其表达开始交流。遵循小兆探讨规则，根据需要回应。',
      { materials, previousChats },
      s.value.messages
    );
    s.value.messages.push({ role: 'assistant', text: reply });
    store.create(s, action.requestId);
    return s.value;
  }

  function priorChats(s: StoredSession) {
    return (s.continuedPaths ?? []).map((path) => writer.readPriorChat(path));
  }

  async function change(s: StoredSession, action: SessionAction) {
    const v = s.value;
    if (action.type === 'open') {
      if (v.diaryPath) v.diaryMarkdown = (await writer.readDiary(s.day)).body;
      return v;
    }
    if (action.expectedUpdatedAt && action.expectedUpdatedAt !== v.updatedAt)
      conflict('这次探讨已更新，请重新打开后继续。');
    delete v.notice;
    if (action.type === 'diary') {
      if (locks.has('diary:' + s.day)) conflict('正在整理当天的日记。');
      locks.add('diary:' + s.day);
      try {
        const result = await diary(s, store.day(s.day));
        // The diary can save this chat and other chats from the same day.
        const saved = store.get(v.id);
        if (saved.value.chatPath) v.chatPath = saved.value.chatPath;
        Object.assign(v, result);
        store.save(s);
        await input.refreshIndex();
        return v;
      } finally {
        locks.delete('diary:' + s.day);
      }
    }
    if (action.type === 'confirm') {
      if (v.phase !== 'paused' && v.phase !== 'ended') conflict('请先暂停或结束这次探讨，再确认资料进度。');
      const selected = new Set<string>();
      const statuses = action.progress.map(({ path, status }) => {
        if (!v.proposals.some((p) => p.path === path) || !s.observed[path] || selected.has(path))
          conflict('确认的资料须来自本次待核对的进度。');
        selected.add(path);
        return { path, status, expectedStatus: s.observed[path]! };
      });
      await saveTranscript(s, statuses);
      // A submitted selection closes this review, including materials the user left unchecked.
      v.proposals = [];
      s.observed = {};
      store.save(s);
      if (statuses.length) await input.refreshIndex();
      return v;
    }

    if (action.type === 'resume') {
      if (v.phase !== 'paused') conflict('只有已暂停的探讨可以续聊。');
      v.phase = 'active';
      v.proposals = [];
      s.observed = {};
      store.save(s);
      return v;
    }
    if (v.phase === 'ended') conflict('这次探讨已结束。');
    if (action.type === 'pause' || action.type === 'end') {
      if (v.phase === 'paused' && action.type === 'end') {
        v.phase = 'ended';
        s.endedAt = now().toISOString();
        await saveTranscript(s);
        store.save(s);
        return v;
      }
      if (v.phase !== 'active' && !(v.phase === 'prepared' && action.type === 'end')) conflict('请先开始或继续探讨。');
      const materials = await readMaterials(input.gateway, v.materialPaths);
      // Save actual dialogue even if the optional model progress report fails.
      await saveTranscript(s);
      if (v.messages.some((message) => message.role === 'user')) {
        const observed = Object.fromEntries(materials.map((m) => [m.path, m.status]));
        s.observed = observed;
        try {
          const report = parseReport(
            progressReport,
            await model.run(
              'pause',
              '根据实际对话、资料原文和已确认进度，逐份判断哪些资料的探讨进度本次有变化。AI初步梳理、读取、仅表示同意不算完成。返回严格 JSON {"keywords":["实际主题"],"proposals":[{"path":"实际路径","status":"未探讨/部分探讨完成/全面探讨完成 三选一","covered":"已经实际聊过的内容","remaining":"还可以继续的部分"}]}。进度未变化可不提议。',
              { materials, previousChats: priorChats(s), conversation: v.messages }
            )
          );
          if (
            report.proposals.some((p) => !Object.hasOwn(observed, p.path)) ||
            new Set(report.proposals.map((p) => p.path)).size !== report.proposals.length
          )
            throw new PublicApiError('DISCUSSION_INVALID_RESULT', '模型列出的进度与本次资料不一致，请重试。', 502);
          v.proposals = report.proposals.filter((p) => p.status !== observed[p.path]);
          s.keywords = report.keywords;
        } catch (error) {
          stop.signal.throwIfAborted();
          v.proposals = materials.map((m) => ({
            path: m.path,
            status: m.status,
            covered: '进度建议生成失败，保留原状态，请按实际交流情况核对。',
            remaining: ''
          }));
          v.notice = '聊天已保存。模型本次未能生成进度建议，资料保留原状态。';
        }
      }
      v.phase = action.type === 'pause' ? 'paused' : 'ended';
      if (v.phase === 'ended') s.endedAt = now().toISOString();
      await saveTranscript(s);
      store.save(s);
      return v;
    }
    let instruction: string;
    if (action.type === 'begin') {
      if (v.phase !== 'prepared') conflict('资料准备阶段已经结束。');
      v.phase = 'active';
      instruction = '小兆已经明确同意开始。承接准备结果与他的目标，选择一个具体切入点开始探讨。';
    } else if (action.type === 'addMaterials') {
      if (v.phase !== 'active' && v.phase !== 'prepared') conflict('请先继续本次探讨，再补充资料。');
      const added = action.materialPaths.filter((p) => !v.materialPaths.includes(p));
      if (!added.length) return v;
      v.materialPaths = [...new Set([...v.materialPaths, ...added])];
      if (v.materialPaths.length > 32)
        throw new PublicApiError('DISCUSSION_INPUT_TOO_LARGE', '一次探讨最多关联 32 份资料。', 400);
      instruction =
        v.phase === 'prepared'
          ? '在首次探讨开始前补充了资料。结合新增资料更新准备梳理，等待用户确认开始。'
          : '已在同一次探讨中补充资料。说明新资料与当前话题的关系，顺着已有交流接着聊，无需重新确认开始。';
      instruction += ' 本次新增路径：' + JSON.stringify(added);
    } else if (action.type === 'message') {
      if (v.phase !== 'active') conflict('请先开始或继续本次探讨。');
      if (!action.text.trim()) throw new PublicApiError('DISCUSSION_INPUT_REQUIRED', '请输入想说的内容。', 400);
      v.messages.push({ role: 'user', text: action.text.trim() });
      instruction = '接着小兆在这段对话中的最新表达回应。分清资料观点、AI建议与小兆自己的认识。';
    } else {
      conflict('不支持的探讨操作。');
    }
    const materials = await readMaterials(input.gateway, v.materialPaths);
    v.messages.push({
      role: 'assistant',
      text: await model.run('discuss', instruction, { materials, previousChats: priorChats(s) }, v.messages)
    });
    store.save(s);
    return v;
  }

  return {
    list: store.list,
    history() {
      const owned = store.chatPaths();
      return writer.listChatHistory().filter((chat) => !owned.has(chat.path));
    },
    readHistory(path: string) {
      const { title, startedAt, materialPaths, body } = writer.readPriorChat(path);
      return { path, title, startedAt, materialPaths, body };
    },
    async act(raw: DiscussionAction): Promise<DiscussionSession> {
      if (stop.signal.aborted) conflict('应用正在关闭，请重新打开。');
      if (input.gateway.layout?.id !== 'current') conflict('当前大脑格式不支持探讨。');
      const action = discussionActionSchema.parse(raw);
      if (action.type === 'open') return change(store.get(action.id), action);
      const createsSession = action.type === 'start' || action.type === 'continueChat';
      const key = createsSession ? action.requestId : action.id;
      if (key && locks.has(key)) conflict('这次探讨正在处理上一项操作，请稍候。');
      if (key) locks.add(key);
      const job = createsSession ? start(action) : Promise.resolve().then(() => change(store.get(action.id), action));
      jobs.add(job);
      try {
        return await job;
      } finally {
        jobs.delete(job);
        if (key) locks.delete(key);
      }
    },
    async close() {
      stop.abort();
      await Promise.allSettled([...jobs]);
    }
  };
}
