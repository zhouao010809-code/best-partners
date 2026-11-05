import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { PublicApiError } from '../../shared/api/errors.js';
import { autoloopConfigurationInputSchema, autoloopDocumentSchema, autoloopEventInputSchema, autoloopEventResultSchema, autoloopRuleSchema, type AutoloopConfigurationInput, type AutoloopDocument, type AutoloopManagementService, type AutoloopRule, type AutoloopGlobalState } from '../../shared/api/autoloop-management.js';
import { resolveAutoloopHome } from './service.js';
import { atomicJson, withAutoloopLock } from './file-store.js';

type Row = Record<string, any>;
const MAX_BYTES = 2 * 1024 * 1024;
const MASK = '[已隐藏凭据]';
const MANUAL_PREFIX = 'bestpartner-manual-';
const unavailable = () => new PublicApiError('AUTOLOOP_UNAVAILABLE', '未连接自动任务服务，请检查本机 Agent Autoloop。', 503);
const invalid = (message: string) => new PublicApiError('AUTOLOOP_CONFIGURATION_INVALID', message, 400);
const conflict = () => new PublicApiError('AUTOLOOP_CONFIGURATION_CHANGED', '配置已被其他窗口或任务更新，请刷新后再保存。', 409);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
async function copyRecipeFile(source: string, target: string) {
  // Native recipe files are text. Preserve owner execute permissions on new helper scripts.
  const contents = await boundedRead(source);
  const mode = (await lstat(source)).mode & 0o100 ? 0o700 : 0o600;
  let handle;
  try { handle = await open(target, 'wx', mode); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw invalid('已有场景文件类型不正确。');
    return;
  }
  try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
}
async function boundedRead(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat(); if (!info.isFile() || info.size > MAX_BYTES) throw invalid('配置文件过大或类型不正确。');
    const buffer = Buffer.alloc(MAX_BYTES + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) throw invalid('配置文件过大。'); return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}
export interface AutoloopManagementOptions { home?: string | null; appRoot?: string; nodePath?: string; loadTimeoutMs?: number; pollMs?: number; validateRules?: (document: AutoloopDocument) => Promise<void> }

/** Run the installed protocol validator with fixed argv. Candidate rules are data on stdin, never a shell command. */
export async function validateNativeAutoloopRules(home: string, document: AutoloopDocument, options: Pick<AutoloopManagementOptions, 'appRoot' | 'nodePath'> = {}) {
  const modulePath = join(options.appRoot ?? join(home, 'app'), 'protocol', 'rules.ts');
  await access(modulePath);
  let node = options.nodePath;
  if (!node) {
    const runtimes = await readdir(join(home, 'runtime')).catch(() => []);
    for (const runtime of runtimes.filter(name => /^node-v2[4-9][.\w-]+$/.test(name)).sort().reverse()) {
      const candidate = join(home, 'runtime', runtime, 'bin', 'node');
      if (await access(candidate, constants.X_OK).then(() => true).catch(() => false)) { node = candidate; break; }
    }
  }
  if (!node) throw invalid('未找到 Autoloop 的 Node 24 运行时，无法校验配置。');
  const code = 'const {parseRules}=await import(process.argv[1]);let input="";for await(const chunk of process.stdin)input+=chunk;try{parseRules(input,Date.now(),Intl.DateTimeFormat().resolvedOptions().timeZone);process.stdout.write("ok")}catch(e){process.stderr.write(String(e.message).slice(0,6000));process.exitCode=1}';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(node!, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code, pathToFileURL(modulePath).href], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } });
    let stderr = ''; const timer = setTimeout(() => { child.kill(); reject(invalid('原生规则校验超时，原配置已保留。')); }, 10000);
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(0, 6000); });
    child.on('error', () => { clearTimeout(timer); reject(invalid('无法启动原生规则校验器。')); });
    child.on('close', status => { clearTimeout(timer); status === 0 ? resolve() : reject(invalid(stderr || '原生规则校验失败，原配置已保留。')); });
    child.stdin.on('error', () => undefined); child.stdin.end(JSON.stringify(document));
  });
}
const templateItems = [
  ['delivery', 'GitHub 交付流水线', '按仓库 main 的审查、检查与交付设置执行；导入为暂停规则'], ['morning-brief', '晨间简报', '定时汇总每天需要关注的信息'], ['github-issues', 'GitHub 问题处理', '将仓库问题交给 Agent 处理'], ['ops-alerts', '运维告警', '告警、提问和处理结果闭环'], ['feedback', '反馈整理', '分类整理反馈并持续跟进'], ['website-watch', '网站变化监测', '检测网页变化后触发处理'], ['feishu-brief', '飞书简报', '整理简报并通过已配置通道送达'], ['browser-handoff', '浏览器交接', '浏览器任务与人工确认的交接']
].map(([id, name, description]) => ({ id: id!, name: name!, description: description! }));

export function createAutoloopManagementService(options: AutoloopManagementOptions = {}): AutoloopManagementService {
  const home = options.home === undefined ? resolveAutoloopHome() : options.home;
  const requireHome = () => { if (!home) throw unavailable(); return home; };
  const rulesFile = () => join(requireHome(), 'rules.json');
  const pausedFile = () => join(requireHome(), 'bestpartner-disabled-rules.json');
  const lock = <T>(action: () => Promise<T>) => withAutoloopLock(join(requireHome(), 'bestpartner-rules.lock'), action);
  async function config() {
    try {
      const parsed = JSON.parse(await boundedRead(join(requireHome(), 'config.json'))); const url = new URL(parsed.url);
      if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !parsed.owner || !parsed.source?.key || !parsed.source?.name) throw new Error();
      const secrets: string[] = [];
      function collect(value: unknown, name = '') { if (typeof value === 'string' && /key|token|secret|password|owner/i.test(name) && value) secrets.push(value); else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) collect(child, key); }
      collect(parsed);
      const env = await boundedRead(join(requireHome(), 'secrets.env')).catch(error => { if (missing(error)) return ''; throw error; });
      for (const line of env.split('\n')) { const match = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+?)\s*$/.exec(line); if (match) secrets.push(match[1]!.replace(/^(['"])(.*)\1$/, '$2')); }
      return { url: url.origin, owner: String(parsed.owner), source: { name: String(parsed.source.name), key: String(parsed.source.key) }, worker: typeof parsed.worker?.name === 'string' ? parsed.worker.name : null, secrets };
    } catch { throw unavailable(); }
  }
  function clean(value: unknown, secrets: string[], depth = 0, stripFields = true): any {
    if (depth > 15) return null;
    if (typeof value === 'string') { let result = value; for (const secret of secrets.filter(s => s.length >= 4).sort((a, b) => b.length - a.length)) result = result.split(secret).join(MASK); return result.replace(/Bearer\s+[^\s"<>]+/gi, `Bearer ${MASK}`).replace(/([?&](?:token|key|secret|password|access_token)=)[^\s&#]*/gi, `$1${MASK}`); }
    if (Array.isArray(value)) return value.map(item => clean(item, secrets, depth + 1, stripFields));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key, item]) => !stripFields || (typeof item === 'number' && /^(?:tokens|inputTokens|outputTokens|missingTokens|totalTokens)$/iu.test(key)) || !/(?:token|secret|password|authorization|credential)|^(?:key|owner|link|session|config|history)$/i.test(key)).map(([key, item]) => [key, clean(item, secrets, depth + 1, stripFields)]));
    return value;
  }
  async function call(endpoint: string, method = 'GET', body?: unknown, source = false) {
    const cfg = await config();
    try {
      const response = await fetch(cfg.url + endpoint, { method, redirect: 'error', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${source ? cfg.source.key : cfg.owner}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) { if ([400, 404, 409].includes(response.status)) throw new PublicApiError('AUTOLOOP_ACTION_CONFLICT', '对象不存在或状态已经变化，请刷新后重试。', response.status); throw unavailable(); }
      const bodyText = await response.text(); if (bodyText.length > 12 * MAX_BYTES) throw unavailable(); return JSON.parse(bodyText);
    } catch (error) { if (error instanceof PublicApiError) throw error; throw unavailable(); }
  }
  async function rawConfiguration() {
    const raw = await boundedRead(rulesFile()); const paused = await boundedRead(pausedFile()).catch(error => { if (missing(error)) return ''; throw error; });
    const document = autoloopDocumentSchema.parse(JSON.parse(raw));
    const disabledRules = autoloopRuleSchema.array().parse(paused ? JSON.parse(paused) : []).filter(rule => !document.rules.some(active => active.name === rule.name));
    return { raw, paused, document, disabledRules, revision: digest(raw + '\0' + paused) };
  }
  function visible(document: AutoloopDocument) { return { ...document, rules: document.rules.filter(rule => !rule.name.startsWith(MANUAL_PREFIX)) }; }
  async function configuration() {
    const [current, cfg] = await Promise.all([rawConfiguration(), config()]);
    return { revision: current.revision, document: clean(visible(current.document), cfg.secrets, 0, false), disabledRules: clean(current.disabledRules, cfg.secrets, 0, false), localWorker: cfg.worker };
  }
  async function validate(document: AutoloopDocument) { await (options.validateRules ? options.validateRules(document) : validateNativeAutoloopRules(requireHome(), document, options)); }
  function restoreMasked(submitted: any, old: any, secrets: string[]): any {
    if (typeof submitted === 'string' && submitted.includes(MASK)) { if (typeof old === 'string' && clean(old, secrets) === submitted) return old; throw invalid('含隐藏凭据的字段不能直接修改，请在本机原配置中调整。'); }
    if (Array.isArray(submitted)) return submitted.map((value, index) => restoreMasked(value, Array.isArray(old) ? old[index] : undefined, secrets));
    if (submitted && typeof submitted === 'object') return Object.fromEntries(Object.entries(submitted).map(([key, value]) => [key, restoreMasked(value, old?.[key], secrets)]));
    return submitted;
  }
  async function loaded(document: AutoloopDocument) {
    const until = Date.now() + (options.loadTimeoutMs ?? 2500);
    do {
      try {
        const state = await call('/v1/state'); const lines = state.lines as Row[];
        if (Array.isArray(lines) && lines.length === document.rules.length && document.rules.every(rule => lines.some(line => line.name === rule.name && line.agent === rule.to && line.source === ('source' in rule.when ? rule.when.source : 'schedule') && (!('source' in rule.when) || JSON.stringify(line.types) === JSON.stringify(rule.when.types))))) return true;
      } catch { return false; }
      if (Date.now() >= until) break; await delay(options.pollMs ?? 100);
    } while (Date.now() < until);
    return false;
  }
  async function save(input: AutoloopConfigurationInput) {
    return lock(async () => {
      const parsed = autoloopConfigurationInputSchema.parse(input); const current = await rawConfiguration(); if (parsed.revision !== current.revision) throw conflict();
      const cfg = await config(); const document = restoreMasked(parsed.document, visible(current.document), cfg.secrets) as AutoloopDocument;
      const disabledRules = restoreMasked(parsed.disabledRules, current.disabledRules, cfg.secrets) as AutoloopRule[];
      if (document.rules.some(rule => rule.name.startsWith(MANUAL_PREFIX)) || disabledRules.some(rule => rule.name.startsWith(MANUAL_PREFIX))) throw invalid('该规则名前缀由手动运行保留。');
      // Any explicit configuration edit retires manual companions; a later trigger creates one for that exact configuration.
      await validate(document); await validate({ ...document, rules: [...document.rules, ...disabledRules] });
      if ((await rawConfiguration()).revision !== current.revision) throw conflict();
      const union = [...new Map([...current.disabledRules, ...disabledRules].map(rule => [rule.name, rule])).values()];
      await atomicJson(pausedFile(), union);
      try { await atomicJson(rulesFile(), document); } catch (error) { if (current.paused) await atomicJson(pausedFile(), JSON.parse(current.paused)); else await unlink(pausedFile()).catch(() => undefined); throw error; }
      await atomicJson(pausedFile(), disabledRules);
      const observed = await loaded(document); const final = await rawConfiguration();
      return { revision: final.revision, loaded: observed, message: observed ? '配置已保存，服务已加载规则列表。' : '配置已保存；暂未确认服务加载，请刷新状态或检查服务。' };
    });
  }
  async function state(before?: number): Promise<AutoloopGlobalState> {
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw invalid('分页编号不正确。');
    const cfg = await config(); const raw = clean(await call('/v1/state' + (before ? `?before=${before}` : '')), cfg.secrets);
    const arrays = ['cards', 'recentCards', 'agents', 'channels', 'sources', 'lines', 'elsewhere', 'runs', 'unrouted'] as const;
    if (arrays.some(key => !Array.isArray(raw[key]))) throw unavailable();
    return { connection: { connected: true }, now: String(raw.now), timezone: String(raw.timezone), totals: raw.totals ?? {}, spending: raw.spending ?? {}, ...Object.fromEntries(arrays.map(key => [key, raw[key]])), nextBefore: raw.nextBefore ?? null } as AutoloopGlobalState;
  }
  async function trace(runId: number) {
    const [facts, cfg] = await Promise.all([call(`/v1/runs/${runId}/why`), config()]); if (!Array.isArray(facts)) throw unavailable();
    const eventIds = new Set(facts.flatMap((fact: Row) => (fact.changes ?? []).filter((change: Row) => change.table === 'run_events' && change.row?.run_id === runId).map((change: Row) => change.row.event_id)));
    const timeline: Array<{ seq: number; at: string; type: string; text: string }> = [];
    for (const fact of facts) for (const change of fact.changes ?? []) {
      const row = change.row as Row | null; if (!row) continue; let text = '';
      if (change.table === 'runs' && row.id === runId) text = `运行 ${row.state ?? ''}：${row.summary || row.error || '状态更新'}`;
      if (change.table === 'cards' && row.run_id === runId) text = `${row.kind === 'ask' ? '提问' : '通知'}：${row.title ?? ''}${row.text ? `\n${row.text}` : ''}${row.answer ? `\n回答：${row.answer}` : ''}${row.result ? `\n结案：${row.result}` : ''}`;
      if (change.table === 'events' && eventIds.has(row.id)) text = `触发事件：${row.source ?? ''} / ${row.type ?? ''}${row.summary ? `\n${row.summary}` : ''}`;
      if (text) timeline.push({ seq: Number(fact.seq), at: typeof fact.at === 'number' ? new Date(fact.at).toISOString() : String(fact.at), type: String(fact.type), text: clean(text, cfg.secrets).slice(0, 20000) });
    }
    const grouped = new Map<number, typeof timeline[number]>();
    for (const entry of timeline) { const prior = grouped.get(entry.seq); if (prior) prior.text += '\n\n' + entry.text; else grouped.set(entry.seq, entry); }
    return { runId, timeline: [...grouped.values()] };
  }
  async function event(input: Parameters<AutoloopManagementService['event']>[0]) { return autoloopEventResultSchema.parse(await call('/v1/events', 'POST', autoloopEventInputSchema.parse(input), true)); }
  async function trigger(name: string, id: string) {
    return lock(async () => {
      const current = await rawConfiguration(); const original = current.document.rules.find(rule => rule.name === name && !name.startsWith(MANUAL_PREFIX));
      if (!original) throw new PublicApiError('AUTOLOOP_RULE_NOT_FOUND', '规则不存在或已暂停。', 404);
      const cfg = await config(); const hash = digest(name + '\0' + JSON.stringify(visible(current.document))).slice(0, 20); const companionName = MANUAL_PREFIX + hash; const type = `bestpartner.manual.${hash}`;
      // Prevent an existing wildcard route from receiving an event intended for only this rule.
      const other = current.document.rules.find(rule => rule.name !== companionName && 'source' in rule.when && rule.when.source === cfg.source.name && rule.when.types.some(pattern => pattern === '*' || pattern === type || pattern.endsWith('.*') && type.startsWith(pattern.slice(0, -1))));
      if (other) throw invalid('本地来源有通配规则，会同时接收手动事件；请先调整该事件过滤条件。');
      const document = { ...current.document, rules: [...current.document.rules.filter(rule => rule.name !== companionName), { ...original, name: companionName, group: original.group ?? original.name, when: { source: cfg.source.name, types: [type] } }] };
      await validate(document); if ((await rawConfiguration()).revision !== current.revision) throw conflict();
      await atomicJson(rulesFile(), document); if (!await loaded(document)) throw new PublicApiError('AUTOLOOP_NOT_LOADED', '手动规则已保存，服务尚未加载；请稍后用同一请求重试。', 503);
      return event({ id: `bestpartner-manual:${hash}:${id}`, type, summary: `手动运行：${name}` });
    });
  }
  const action = async (path: string, body: unknown = {}) => { await call(path, 'POST', body); return { ok: true as const }; };
  async function templates() { const root = options.appRoot ?? join(requireHome(), 'app'); const found = await Promise.all(templateItems.map(async item => await access(item.id === 'delivery' ? join(root, 'skills', 'agent-autoloop', 'SKILL.md') : join(root, 'examples', 'recipes', item.id, 'README.md')).then(() => item).catch(() => null))); return { templates: found.filter(item => item !== null) }; }
  async function template(id: string) {
    const item = templateItems.find(item => item.id === id); if (!item) throw new PublicApiError('AUTOLOOP_TEMPLATE_NOT_FOUND', '模板不存在。', 404);
    const appRoot = options.appRoot ?? join(requireHome(), 'app');
    if (id === 'delivery') {
      const skill = await boundedRead(join(appRoot, 'skills', 'agent-autoloop', 'SKILL.md'));
      const heading = '## 交付流水线'; const start = skill.indexOf(heading); const next = skill.indexOf('\n## ', start + heading.length);
      if (start < 0) throw new PublicApiError('AUTOLOOP_TEMPLATE_NOT_FOUND', '当前安装没有交付场景指南。', 404);
      const cfg = await config(); const worker = cfg.worker ?? 'replace-worker';
      return { ...item, readme: '模板只提供配置入口；导入后为暂停状态。请替换 REPLACE_OWNER/REPLACE_REPOSITORY 和工作目录，准备仓库 main 上的 ops/delivery.json、审查程序和 gh 登录后再启用。\n\n' + skill.slice(start, next < 0 ? undefined : next), rules: {
        sources: { github: { name: 'GitHub' } },
        agents: { 'delivery-poll': { name: '查看交付标签', worker, use: 'command', command: ['node', join(appRoot, 'plugins', 'delivery', 'poll.ts'), 'REPLACE_OWNER/REPLACE_REPOSITORY'] }, delivery: { name: 'GitHub 交付', worker, use: 'delivery', command: ['REPLACE_OWNER/REPLACE_REPOSITORY'], timeout: 35 } },
        channels: {}, rules: [
          { name: '查看待交付', when: { cron: '*/2 * * * *' }, to: 'delivery-poll', cwd: '/替换为已有项目目录', prompt: '查看项目交付标签', emits: { source: 'github', types: ['pull_request.labeled', 'issues.labeled'] } },
          { name: 'GitHub 交付', when: { source: 'github', types: ['pull_request.*', 'issues.labeled'] }, to: 'delivery', cwd: '/替换为已有项目目录', parallel: 2, prompt: '按 main 的项目设置完成交付' }
        ]
      } };
    }
    const base = join(appRoot, 'examples', 'recipes', id);
    try { return { ...item, readme: await boundedRead(join(base, 'README.md')), rules: JSON.parse(await boundedRead(join(base, 'rules.json'))) }; } catch { throw new PublicApiError('AUTOLOOP_TEMPLATE_NOT_FOUND', '本机尚未安装此模板。', 404); }
  }
  async function prepareTemplate(id: string) {
    const draft = await template(id); const cfg = await config();
    if (!cfg.worker) throw invalid('本机未配置 worker，请先连接执行器。');
    const root = requireHome(); let destination = root;
    // Each segment is fixed, and a symlink never changes the write destination.
    for (const segment of ['work', 'bestpartner-recipes', id]) {
      destination = join(destination, segment);
      await mkdir(destination).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      const info = await lstat(destination); if (!info.isDirectory() || info.isSymbolicLink()) throw invalid('场景目录不是普通文件夹，请检查本机工作目录。');
    }
    if (id !== 'delivery') {
      const source = join(options.appRoot ?? join(root, 'app'), 'examples', 'recipes', id);
      let count = 0;
      async function copyFiles(from: string, to: string, depth = 0): Promise<void> {
        if (depth > 4) throw invalid('场景文件层级过深。');
        for (const entry of await readdir(from, { withFileTypes: true })) {
          if (++count > 100) throw invalid('场景文件数量超出限制。');
          const sourceFile = join(from, entry.name); const target = join(to, entry.name);
          if (entry.isSymbolicLink()) throw invalid('场景文件不能包含符号链接。');
          if (entry.isDirectory()) { await mkdir(target).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }); const info = await lstat(target); if (!info.isDirectory() || info.isSymbolicLink()) throw invalid('场景子目录类型不正确。'); await copyFiles(sourceFile, target, depth + 1); }
          else if (entry.isFile()) await copyRecipeFile(sourceFile, target);
        }
      }
      await copyFiles(source, destination);
      if (id === 'github-issues') {
        const appRoot = options.appRoot ?? join(root, 'app');
        await copyRecipeFile(join(appRoot, 'examples', 'watch-github-issues.sh'), join(destination, 'watch-github-issues.sh'));
      }
    }
    const incoming = autoloopDocumentSchema.parse(draft.rules); const current = await rawConfiguration();
    for (const id of Object.keys(incoming.sources)) if (current.document.sources[id]) delete incoming.sources[id];
    for (const id of Object.keys(incoming.channels ?? {})) if (current.document.channels?.[id]) delete incoming.channels![id];
    const skill = join(destination, 'SKILL.md'); const hasSkill = await access(skill).then(() => true).catch(() => false);
    for (const [agentId, agent] of Object.entries(incoming.agents)) {
      agent.worker = cfg.worker;
      // These two shipped helpers are POSIX sh scripts. Older prepared files may be readable only.
      if (id === 'github-issues' && agent.command?.[0] === '{cwd}/examples/watch-github-issues.sh') {
        agent.command = ['/bin/sh', '{cwd}/watch-github-issues.sh', ...agent.command.slice(1)];
      }
      if (id === 'ops-alerts' && agent.command?.[0] === '{cwd}/restart.sh') agent.command.unshift('/bin/sh');
      const existing = current.document.agents[agentId];
      if (!existing || JSON.stringify(existing) === JSON.stringify(agent)) continue;
      // Several native templates use the same generic ID "agent" with different access policies.
      const base = `recipe-${id}-${agentId}`;
      let replacement = base;
      for (let suffix = 2; incoming.agents[replacement] || (current.document.agents[replacement] && JSON.stringify(current.document.agents[replacement]) !== JSON.stringify(agent)); suffix++) replacement = `${base}-${suffix}`;
      incoming.agents[replacement] = agent;
      delete incoming.agents[agentId];
      for (const rule of incoming.rules) if (rule.to === agentId) rule.to = replacement;
      for (const schedule of incoming.elsewhere ?? []) if (schedule.to === agentId) schedule.to = replacement;
    }
    for (const rule of incoming.rules) { rule.cwd = destination; if (rule.skill && hasSkill) rule.skill = skill; }
    return { ...draft, readme: `场景文件已准备在：${destination}。已有文件保持原样。规则仍为草稿，导入后暂停；请按下方说明补齐业务资料与连接。\n\n${draft.readme}`, rules: incoming };
  }
  return { state, configuration, save, trace, event, trigger, templates, template, prepareTemplate, answer: (id, input) => action(`/v1/cards/${id}/answer`, input), resolve: (id, reason) => action(`/v1/cards/${id}/resolve`, { reason }), cancel: id => action(`/v1/runs/${id}/cancel`) };
}
