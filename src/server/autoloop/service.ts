import { withAutoloopLock as locked, atomicJson as atomic } from './file-store.js';
import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath, stat, lstat, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute, delimiter } from 'node:path';
import { z } from 'zod';
import { PublicApiError } from '../../shared/api/errors.js';
import { autoloopAnswerInputSchema, autoloopCreateInputSchema, type AutoloopService, type AutoloopTask, type AutoloopTaskDetail, type AutoloopCard, type AutoloopCreateInput, type AutoloopChoices } from '../../shared/api/autoloop.js';

type Row = Record<string, any>;
type HubState = { lines: Row[]; cards: Row[]; runs: Row[]; nextBefore?: number | null };
const UUID = z.uuid();
const recordSchema = autoloopCreateInputSchema.extend({ createdAt: z.string(), dispatched: z.boolean(), stopRequested: z.boolean().optional(), execution: z.object({ agent: z.record(z.string(), z.unknown()), workspacePath: z.string().optional(), skillPath: z.string().optional() }).optional() });
type RecordFile = z.infer<typeof recordSchema>;
const connectionError = () => new PublicApiError('AUTOLOOP_UNAVAILABLE', '未连接自动任务服务，请确认 Agent Autoloop 已启动。', 503);
const conflict = () => new PublicApiError('AUTOLOOP_CONFLICT', '任务配置已变化，请检查自动任务设置后重试。', 409);
const missing = () => new PublicApiError('AUTOLOOP_NOT_FOUND', '任务或问题不存在，请刷新后重试。', 404);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const MAX_BYTES = 2 * 1024 * 1024;

export interface AutoloopOptions {
  stateRoot: string;
  vaultIdentity: string;
  home?: string | null;
  loadTimeoutMs?: number;
  pollMs?: number;
  getWorkspaces?: () => Promise<Array<{ id: string; name: string; kind: 'vault' | 'project'; path: string; available?: boolean }>>;
  skills?: {
    list(): Promise<{ items: Array<{ id: string; name: string; description: string }> }>;
    resolveSource(id: string): Promise<string>;
  };
}

export function resolveAutoloopHome(): string | null {
  if (process.env.NODE_ENV === 'test') return process.env.XIAOZHAO_TEST_AUTOLOOP_HOME || null;
  return process.env.AGENT_AUTOLOOP_HOME || join(homedir(), '.agent-autoloop');
}

async function boundedRead(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Invalid output');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let count = 0;
    while (count <= MAX_BYTES) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > MAX_BYTES) throw new Error('Output too large');
    return buffer.subarray(0, count).toString('utf8');
  } finally { await handle.close(); }
}

export function createAutoloopService(options: AutoloopOptions): AutoloopService {
  const home = options.home === undefined ? resolveAutoloopHome() : options.home;
  const scope = digest(options.vaultIdentity);
  const root = resolve(options.stateRoot, 'autoloop-v1', scope);
  const records = join(root, 'records');
  const works = join(root, 'work');
  const ruleName = (id: string) => `bestpartner-${scope.slice(0, 16)}-${id}`;
  const agentName = `bestpartner-codex-${scope.slice(0, 16)}`;
  const eventType = (id: string) => `bestpartner.${scope.slice(0, 8)}.${id}`;
  const workDir = (id: string) => join(works, id);
  const recordPath = (id: string) => join(records, `${id}.json`);
  async function config() {
    if (!home) throw connectionError();
    try {
      const parsed = JSON.parse(await boundedRead(join(home, 'config.json')));
      const url = new URL(parsed.url);
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
      if (typeof parsed.owner !== 'string' || !parsed.owner || typeof parsed.source?.key !== 'string' || !parsed.source.key || typeof parsed.source?.name !== 'string') throw new Error();
      return { url: url.origin, owner: parsed.owner as string, worker: typeof parsed.worker?.name === 'string' ? parsed.worker.name as string : null, source: { name: parsed.source.name as string, key: parsed.source.key as string } };
    } catch { throw connectionError(); }
  }
  async function call(endpoint: string, method = 'GET', body?: unknown, source = false): Promise<any> {
    const cfg = await config();
    try {
      const response = await fetch(cfg.url + endpoint, { method, redirect: 'error', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${source ? cfg.source.key : cfg.owner}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) {
        if ([404, 409, 400].includes(response.status)) throw new PublicApiError('AUTOLOOP_ACTION_CONFLICT', '任务状态已变化，请刷新后重试。', 409);
        throw connectionError();
      }
      const text = await response.text();
      if (text.length > 12 * MAX_BYTES) throw connectionError();
      return JSON.parse(text);
    } catch (error) { if (error instanceof PublicApiError) throw error; throw connectionError(); }
  }
  async function snapshot(): Promise<HubState> {
    const state = await call('/v1/state') as HubState;
    if (!Array.isArray(state.runs) || !Array.isArray(state.cards) || !Array.isArray(state.lines)) throw connectionError();
    const all = new Map(state.runs.map(row => [row.id, row]));
    const seen = new Set<number>(); let before = state.nextBefore;
    while (before !== null && before !== undefined) {
      if (!Number.isSafeInteger(before) || before <= 0 || seen.has(before) || seen.size > 1000) throw connectionError();
      seen.add(before);
      const page = await call(`/v1/state?before=${before}`) as HubState;
      if (!Array.isArray(page.runs)) throw connectionError();
      for (const run of page.runs) all.set(run.id, run);
      before = page.nextBefore;
    }
    return { ...state, runs: [...all.values()].sort((a, b) => b.id - a.id) };
  }
  async function workspaceEntries() {
    const entries = await options.getWorkspaces?.() ?? [];
    return Promise.all(entries.map(async entry => ({ ...entry, available: entry.available !== false && await lstat(entry.path).then(async info => info.isDirectory() && !info.isSymbolicLink() && await realpath(entry.path) === entry.path).catch(() => false) })));
  }
  async function agentAvailable(agent: Row) {
    if (['codex', 'claude'].includes(agent.use)) return true;
    if (!['acp', 'command'].includes(agent.use) || !Array.isArray(agent.command) || typeof agent.command[0] !== 'string' || !agent.command[0]) return false;
    const command = agent.command[0];
    const candidates = isAbsolute(command) ? [command] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, command));
    return (await Promise.all(candidates.map(candidate => access(candidate, constants.X_OK).then(() => true).catch(() => false)))).some(Boolean);
  }
  async function choices(): Promise<AutoloopChoices> {
    let agents: AutoloopChoices['agents'] = []; let notificationsAvailable = false;
    try {
      const cfg = await config(); const rules = JSON.parse(await boundedRead(join(home!, 'rules.json')));
      agents = await Promise.all(Object.entries(rules.agents ?? {}).filter(([id, value]) => !id.startsWith('bestpartner-') && (value as Row).worker === cfg.worker).map(async ([id, value]) => {
        const a = value as Row;
        return { id, name: String(a.name || id), use: String(a.use), ...(typeof a.model === 'string' ? { model: a.model } : {}), ...(typeof a.effort === 'string' ? { effort: a.effort } : {}), available: await agentAvailable(a) };
      }));
      notificationsAvailable = Object.keys(rules.channels ?? {}).length > 0;
    } catch { /* Disconnected settings remain useful for selecting local sources. */ }
    const items = await options.skills?.list().then(page => page.items).catch(() => []) ?? [];
    return { workspaces: [{ id: 'isolated', name: '独立任务', kind: 'isolated', available: true }, ...(await workspaceEntries()).map(({ id, name, kind, available }) => ({ id, name, kind, available }))], agents,
      skills: items.map(({ id, name, description }) => ({ id, name, description })), notificationsAvailable };
  }
  async function execution(input: AutoloopCreateInput): Promise<NonNullable<RecordFile['execution']>> {
    const cfg = await config(); const rules = JSON.parse(await boundedRead(join(home!, 'rules.json')));
    const base = input.agentId ? rules.agents?.[input.agentId] : Object.entries(rules.agents ?? {}).find(([id, value]) => !id.startsWith('bestpartner-') && (value as Row).use === 'codex' && (value as Row).worker === cfg.worker)?.[1] as Row | undefined;
    if (!base || base.worker !== cfg.worker || !await agentAvailable(base)) throw new PublicApiError('AUTOLOOP_AGENT_REQUIRED', '请选择已配置的本机 Agent。', 409);
    const agent: Row = { ...base, name: '最佳拍档自动任务', access: 'edit', ...(input.model ? { model: input.model } : {}) };
    let workspacePath: string | undefined; let skillPath: string | undefined;
    if (input.workspaceId && input.workspaceId !== 'isolated') {
      const workspace = (await workspaceEntries()).find(entry => entry.id === input.workspaceId && entry.available);
      if (!workspace) throw new PublicApiError('AUTOLOOP_WORKSPACE_REQUIRED', '所选资料目录不可用，请重新连接大脑或项目。', 409);
      workspacePath = await realpath(workspace.path);
    }
    if (input.skillId) {
      try {
        if (!(await options.skills?.list())?.items.some(item => item.id === input.skillId)) throw new Error();
        skillPath = await realpath(await options.skills!.resolveSource(input.skillId));
        if (!(await stat(skillPath)).isFile()) throw new Error();
      } catch { throw new PublicApiError('AUTOLOOP_SKILL_REQUIRED', '所选 Skill 不可用，请刷新后重新选择。', 409); }
    }
    return { agent, ...(workspacePath ? { workspacePath } : {}), ...(skillPath ? { skillPath } : {}) };
  }
  async function readRecord(id: string): Promise<RecordFile> {
    if (!UUID.safeParse(id).success) throw missing();
    try {
      const record = recordSchema.parse(JSON.parse(await boundedRead(recordPath(id))));
      if (record.requestId !== id) throw conflict();
      return record;
    } catch (error) { if (isMissing(error)) throw missing(); if (error instanceof PublicApiError) throw error; throw connectionError(); }
  }
  async function allRecords(): Promise<RecordFile[]> {
    if (!home) return [];
    let names: string[];
    try { names = await readdir(records); } catch (error) { if (isMissing(error)) return []; throw connectionError(); }
    return Promise.all(names.filter(name => UUID.safeParse(name.replace(/\.json$/, '')).success && name.endsWith('.json')).map(name => readRecord(name.slice(0, -5))));
  }
  function task(record: RecordFile, state?: HubState): AutoloopTask {
    const name = ruleName(record.requestId);
    const run = state?.runs.find(row => row.rule === name);
    const cards: AutoloopCard[] = (state?.cards ?? []).filter(card => card.rule === name).map(card => ({ id: card.id, kind: String(card.kind), title: String(card.title ?? ''), text: String(card.text ?? ''), options: Array.isArray(card.options) ? card.options.map(String) : [], state: String(card.state) }));
    let status: AutoloopTask['status'] = !state ? 'unknown' : record.dispatched ? 'queued' : 'dispatching';
    if (run) {
      status = ({ claimed: 'running', running: 'running', queued: 'queued', done: 'done', nothing: 'done', failed: 'failed', cancelled: 'cancelled', unknown: 'unknown' } as Record<string, AutoloopTask['status']>)[run.state as string] ?? 'unknown';
    }
    if (cards.some(card => card.kind === 'ask' && card.state === 'open')) status = 'waiting';
    const unsettled = state?.runs.find(row => row.rule === name && ['claimed', 'unknown'].includes(row.state));
    const stopPending = state && (state.lines.some(line => line.name === name) || cards.some(card => card.state === 'open') || state.runs.some(row => row.rule === name && row.state === 'queued'));
    if (record.stopRequested && state) status = unsettled ? (unsettled.state === 'unknown' ? 'unknown' : 'running') : stopPending ? 'unknown' : 'cancelled';
    return { ...Object.fromEntries(['workspaceId', 'agentId', 'model', 'skillId', 'notify'].filter(key => record[key as keyof RecordFile] !== undefined).map(key => [key, record[key as keyof RecordFile]])), id: record.requestId, title: record.title, instructions: record.instructions, createdAt: record.createdAt, status, summary: record.stopRequested && unsettled ? (unsettled.state === 'unknown' ? '停止已请求，当前执行结果仍无法确认。' : '正在停止，请等待接单程序确认。') : record.stopRequested && stopPending ? '停止尚未完成，请重试停止。' : String(run?.summary ?? ''), runId: Number.isSafeInteger(run?.id) ? run!.id : null, cards };
  }
  async function connectedSnapshot() {
    try { return { connection: { connected: true }, state: await snapshot() }; }
    catch { return { connection: { connected: false, message: '未连接自动任务服务，请确认 Agent Autoloop 已启动。' }, state: undefined }; }
  }
  async function register(record: RecordFile) {
    const cfg = await config(); const rulesFile = join(home!, 'rules.json');
    const before = await boundedRead(rulesFile);
    const rules: Row = JSON.parse(before);
    if (!Array.isArray(rules.rules) || !rules.sources?.[cfg.source.name]) throw conflict();
    const base: Row | undefined = record.execution?.agent ?? Object.values(rules.agents ?? {}).find((entry: any) => entry?.use === 'codex' && entry.worker === cfg.worker) as Row | undefined;
    if (!base || typeof base.worker !== 'string') throw new PublicApiError('AUTOLOOP_CODEX_REQUIRED', '请先在 Agent Autoloop 配置本机 Codex 接单程序。', 409);
    const selectedAgentName = record.execution ? `${agentName}-${record.requestId}` : agentName;
    const name = ruleName(record.requestId); const type = eventType(record.requestId);
    const matches = (pattern: string) => pattern === '*' || pattern === type || (pattern.endsWith('.*') && type.startsWith(pattern.slice(0, -1)));
    if (rules.rules.some((rule: Row) => rule.name !== name && rule.when?.source === cfg.source.name && Array.isArray(rule.when.types) && rule.when.types.some((pattern: unknown) => typeof pattern === 'string' && matches(pattern)))) throw new PublicApiError('AUTOLOOP_ROUTE_OVERLAP', '已有自动规则也会接收这项任务，请先调整重叠规则。', 409);
    const agent: Row = record.execution ? { ...record.execution.agent } : { name: '最佳拍档自动任务', worker: base.worker, use: 'codex', access: 'edit' };
    for (const field of ['model', 'effort']) if (typeof base[field] === 'string') agent[field] = base[field];
    const prompt = [
      record.execution?.workspacePath ? `这是最佳拍档本人提交的自动任务。允许只读使用所选资料目录：${JSON.stringify(record.execution.workspacePath)}。先读取该目录及父级适用的 AGENTS.md，按路由读取具体正文和项目方法，再处理用户任务；来源事实必须可追溯。结果仅写到当前任务目录，不改动原资料，不读取账号凭据，不对外发消息或发布。` : '这是最佳拍档本人提交的独立自动任务。仅在当前任务目录执行并写入结果，不读取或修改用户真实知识库、其他项目或账号凭据，不对外发送消息、不发布、不删除其他文件。',
      ...(record.execution?.skillPath ? [`本任务指定 Skill：${JSON.stringify(record.execution.skillPath)}。先读取该 SKILL.md 并遵守适用指引，必要时读取其引用资料；它不扩大任务的写入或外发权限。`] : []),
      '遵守适用的 AGENTS.md。需要补充资料或决定时交 ask 并结束本轮；用户回答在 context.answers 中，收到回答后继续。',
      '完成后将完整结果写到当前目录的 result.md（普通 UTF-8 文件），最后回复一句摘要。等待用户时不要写成已完成。',
      `任务标题：${record.title}`, '本人任务要求：', record.instructions
    ].join('\n');
    const rule = { name, when: { source: cfg.source.name, types: [type] }, to: selectedAgentName, cwd: workDir(record.requestId), prompt, group: name, tell: record.execution && record.notify !== false ? 'always' : 'never' };
    const existing = rules.rules.find((entry: Row) => entry.name === name);
    if (existing && JSON.stringify(existing) !== JSON.stringify(rule)) throw conflict();
    if (rules.agents[selectedAgentName] && JSON.stringify(rules.agents[selectedAgentName]) !== JSON.stringify(agent)) throw conflict();
    if (!existing) {
      rules.agents[selectedAgentName] = agent; rules.rules.push(rule);
      if (await readFile(rulesFile, 'utf8') !== before) throw conflict();
      await atomic(rulesFile, rules);
    }
    const until = Date.now() + (options.loadTimeoutMs ?? 15_000);
    do {
      const state = await call('/v1/state') as HubState;
      const line = state.lines?.find(row => row.name === name && row.source === cfg.source.name && row.agent === selectedAgentName && Array.isArray(row.types) && row.types.length === 1 && row.types[0] === type);
      if (line) {
        if (state.lines.some(row => row.name !== name && row.source === cfg.source.name && Array.isArray(row.types) && row.types.some((pattern: unknown) => typeof pattern === 'string' && matches(pattern)))) throw conflict();
        const routed = await call('/v1/events', 'POST', { id: name, type, subject: record.requestId }, true);
        if (!Array.isArray(routed.routed) || routed.routed.length !== 1 || routed.routed[0] !== name) throw conflict();
        return;
      }
      await pause(options.pollMs ?? 200);
    } while (Date.now() < until);
    throw new PublicApiError('AUTOLOOP_RULE_PENDING', '任务已保存，正在等待服务加载规则，请重试本次提交。', 503);
  }
  async function result(record: RecordFile) {
    try {
      const directory = workDir(record.requestId);
      if (await realpath(directory) !== join(await realpath(works), record.requestId)) return '';
      return await boundedRead(join(directory, 'result.md'));
    } catch { return ''; }
  }
  return {
    choices,
    async list() {
      const items = await allRecords(); const { connection, state } = await connectedSnapshot();
      return { connection, tasks: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(record => task(record, state)) };
    },
    async create(raw) {
      const input = autoloopCreateInputSchema.parse(raw); await config();
      await mkdir(records, { recursive: true, mode: 0o700 });
      await mkdir(works, { recursive: true, mode: 0o700 });
      await locked(join(home!, 'bestpartner-rules.lock'), async () => {
        let record: RecordFile;
        try { record = await readRecord(input.requestId); }
        catch (error) {
          if (!(error instanceof PublicApiError) || error.statusCode !== 404) throw error;
          record = { ...input, createdAt: new Date().toISOString(), dispatched: false, execution: await execution(input) };
          await atomic(recordPath(input.requestId), record);
        }
        if (record.title !== input.title || record.instructions !== input.instructions || ['workspaceId', 'agentId', 'model', 'skillId', 'notify'].some(key => record[key as keyof RecordFile] !== input[key as keyof AutoloopCreateInput])) throw new PublicApiError('AUTOLOOP_REQUEST_CONFLICT', '这次提交已经保存了不同的内容，请重新创建任务。', 409);
        if (record.dispatched || record.stopRequested) return;
        await mkdir(workDir(input.requestId), { recursive: true, mode: 0o700 });
        if (await realpath(workDir(input.requestId)) !== join(await realpath(works), input.requestId)) throw conflict();
        await register(record);
        await atomic(recordPath(input.requestId), { ...record, dispatched: true });
      });
      return { task: (await this.detail(input.requestId)).task };
    },
    async detail(id) {
      const record = await readRecord(id); const { connection, state } = await connectedSnapshot();
      // Do not proxy /why: its facts include whole rule snapshots and other projects.
      const timeline = (state?.runs ?? []).filter(run => run.rule === ruleName(id)).map(run => ({ id: Number(run.id), at: String(run.finishedAt || run.claimedAt || run.createdAt || record.createdAt), text: String(run.summary || ({ claimed: '正在执行', queued: '等待执行', cancelled: '已停止' } as Record<string, string>)[run.state] || '任务状态已更新') })).sort((a, b) => a.id - b.id);
      return { connection, task: task(record, state), result: await result(record), timeline } satisfies AutoloopTaskDetail;
    },
    async answer(id, raw) {
      const record = await readRecord(id); if (record.stopRequested) throw conflict(); const input = autoloopAnswerInputSchema.parse(raw); const state = await snapshot();
      const card = state.cards.find(row => row.rule === ruleName(id) && row.id === input.cardId && row.state === 'open' && row.kind === 'ask');
      if (!card) throw missing();
      if (input.choice !== undefined && (!Array.isArray(card.options) || input.choice >= card.options.length)) throw new PublicApiError('AUTOLOOP_ANSWER_INVALID', '请选择有效选项。', 422);
      await call(`/v1/cards/${input.cardId}/answer`, 'POST', { ...(input.choice === undefined ? {} : { choice: input.choice }), ...(input.text === undefined ? {} : { text: input.text }) });
      return { ok: true };
    },
    async cancel(id) {
      await readRecord(id); await config();
      await locked(join(home!, 'bestpartner-rules.lock'), async () => {
        const record = await readRecord(id); const name = ruleName(id);
        await atomic(recordPath(id), { ...record, stopRequested: true });
        const rulesFile = join(home!, 'rules.json'); const before = await boundedRead(rulesFile);
        const rules: Row = JSON.parse(before);
        if (!Array.isArray(rules.rules)) throw conflict();
        if (rules.rules.some((rule: Row) => rule.name === name)) {
          rules.rules = rules.rules.filter((rule: Row) => rule.name !== name);
          if (await readFile(rulesFile, 'utf8') !== before) throw conflict();
          await atomic(rulesFile, rules);
        }
        const until = Date.now() + (options.loadTimeoutMs ?? 15_000);
        while (true) {
          const state = await call('/v1/state') as HubState;
          if (!Array.isArray(state.lines)) throw connectionError();
          if (!state.lines.some(line => line.name === name)) break;
          if (Date.now() >= until) throw connectionError();
          await pause(options.pollMs ?? 200);
        }
        const state = await snapshot();
        for (const card of state.cards.filter(card => card.rule === name && card.state === 'open')) {
          await call(`/v1/cards/${card.id}/resolve`, 'POST', { reason: '本人已停止此任务。' });
        }
        for (const run of state.runs.filter(run => run.rule === name && ['claimed', 'queued'].includes(run.state))) {
          await call(`/v1/runs/${run.id}/cancel`, 'POST', {});
        }
      });
      return { ok: true };
    }
  };
}
