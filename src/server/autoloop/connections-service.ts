import { constants } from 'node:fs';
import { access, open, readdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PublicApiError } from '../../shared/api/errors.js';
import { connectionIdSchema, autoloopConnectionSaveInputSchema, type AutoloopConnectionId, type AutoloopConnectionItem, type AutoloopConnectionsService, type AutoloopConnectionProbe } from '../../shared/api/autoloop-connections.js';
import { resolveAutoloopHome } from './service.js';
import { withAutoloopLock, atomicJson } from './file-store.js';

type Row = Record<string, any>;
type CommandResult = { stdout: string; stderr: string };
type Runner = (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<CommandResult>;
export interface AutoloopConnectionsOptions { home?: string | null; run?: Runner; nodeExecutable?: string }
const execute = promisify(execFile);
const names = { desktop: '桌面通知', feishu: '飞书', dingtalk: '钉钉', wecom: '企业微信', slack: 'Slack', discord: 'Discord', github: 'GitHub Webhook', gitlab: 'GitLab Webhook', hub: '中台访问地址' };
const webhookIds = new Set(['dingtalk', 'wecom', 'slack', 'discord']);
const unavailable = () => new PublicApiError('AUTOLOOP_UNAVAILABLE', '无法读取自动任务配置，请确认 Agent Autoloop 已安装。', 503);
const invalid = (message: string) => new PublicApiError('AUTOLOOP_CONNECTION_INVALID', message, 422);
const conflict = (message: string) => new PublicApiError('AUTOLOOP_CONNECTION_CONFLICT', message, 409);
const secretName = (id: string) => `AGENT_AUTOLOOP_SECRET_${id.toUpperCase()}`;

async function textFile(file: string, optional = false): Promise<string> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw unavailable(); }
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw unavailable();
    const text = await handle.readFile('utf8'); if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw unavailable(); return text;
  } finally { await handle.close(); }
}
async function atomicText(file: string, value: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { const handle = await open(temporary, 'wx', 0o600); try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); } await rename(temporary, file); }
  finally { await unlink(temporary).catch(() => undefined); }
}
function secureUrl(value: string, publicAddress = false): string {
  let url: URL; try { url = new URL(value); } catch { throw invalid('请输入完整的 HTTPS 地址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (publicAddress && url.search)) throw invalid('请输入不含账号、密码和片段的 HTTPS 地址。');
  return publicAddress ? url.toString().replace(/\/$/u, '') : value;
}
function localHub(config: Row) {
  try {
    const url = new URL(config.url);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || typeof config.owner !== 'string' || !config.owner) throw new Error();
    return url.origin;
  } catch { throw unavailable(); }
}

export function createAutoloopConnectionsService(options: AutoloopConnectionsOptions = {}): AutoloopConnectionsService {
  const home = options.home === undefined ? resolveAutoloopHome() : options.home;
  const run: Runner = options.run ?? (async (command, args, env) => execute(command, args, { env, timeout: 25_000, maxBuffer: 1024 * 1024, encoding: 'utf8' }));
  const requiredHome = () => { if (!home) throw unavailable(); return home; };
  const env = () => ({ ...process.env, AGENT_AUTOLOOP_HOME: requiredHome(), PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` });
  async function data() {
    const root = requiredHome();
    try {
      const configText = await textFile(join(root, 'config.json'));
      const rulesText = await textFile(join(root, 'rules.json'));
      const config = JSON.parse(configText) as Row;
      const rules = JSON.parse(rulesText) as Row;
      if (!config || !rules || typeof rules.sources !== 'object' || !Array.isArray(rules.rules)) throw unavailable();
      localHub(config);
      const secrets = await textFile(join(root, 'secrets.env'), true);
      const revision = createHash('sha256').update(JSON.stringify([configText, rulesText, secrets])).digest('hex');
      return { config, rules, secrets, revision };
    } catch { throw unavailable(); }
  }
  async function executable() {
    if (options.nodeExecutable) return options.nodeExecutable;
    const root = requiredHome();
    const releases = await readdir(join(root, 'runtime')).catch(() => []);
    for (const release of releases.filter(name => /^node-v(?:2[4-9]|[3-9]\d)\./u.test(name)).sort().reverse()) {
      const candidate = join(root, 'runtime', release, 'bin', 'node');
      try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try next installed runtime. */ }
    }
    if (!process.versions.electron && Number(process.versions.node.split('.')[0]) >= 24) return process.execPath;
    throw new PublicApiError('AUTOLOOP_RUNTIME_MISSING', '自动任务需要已安装的 Node 24 或更新运行环境。', 503);
  }
  async function cli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
    return run(await executable(), ['--disable-warning=ExperimentalWarning', join(requiredHome(), 'app', 'bin', 'agent-autoloop.ts'), ...args], { ...env(), ...extraEnv });
  }
  const fingerprint = (config: Row, secrets: string) => createHash('sha256').update(JSON.stringify(config)).update(secrets).digest('hex');
  async function pending(config: Row, secrets: string) {
    const marker = await textFile(join(requiredHome(), 'bestpartner-connections-state.json'), true);
    if (!marker) return false;
    try { return JSON.parse(marker).applied !== fingerprint(config, secrets); } catch { return true; }
  }
  async function health(config: Row) {
    try {
      const response = await fetch(`${localHub(config)}/v1/state`, { redirect: 'error', signal: AbortSignal.timeout(2500), headers: { authorization: `Bearer ${config.owner}` } });
      if (!response.ok) return false;
      const state = await response.json() as Row; return Array.isArray(state.lines) && Array.isArray(state.runs);
    } catch { return false; }
  }
  function secretPresent(secrets: string, id: string) { return new RegExp(`^\\s*(?:export\\s+)?${secretName(id)}\\s*=\\s*.+$`, 'mu').test(secrets); }
  function item(id: AutoloopConnectionId, config: Row, rules: Row, secrets: string): AutoloopConnectionItem {
    const channel = config.channels?.[id]; const rule = rules.channels?.[id];
    const source = id === 'github' || id === 'gitlab';
    const enabled = id === 'hub' ? !!config.hub : source ? rules.sources?.[id]?.adapter === id : !!channel && !!rule;
    const hasSecret = source ? secretPresent(secrets, id) : id === 'hub' ? !!config.owner : !!channel?.key && (!webhookIds.has(id) || !!channel?.url);
    const configured = enabled && hasSecret && (id !== 'feishu' || !!channel?.user && Array.isArray(rule?.answerers) && rule.answerers.includes(channel.user));
    const settings: AutoloopConnectionItem['settings'] = {};
    if (id === 'feishu') { if (typeof channel?.user === 'string') settings.user = channel.user; if (Array.isArray(rule?.answerers)) settings.answerers = rule.answerers.filter((s: unknown) => typeof s === 'string'); }
    if (id === 'hub' && typeof config.hub?.publicUrl === 'string') { try { settings.publicUrl = secureUrl(config.hub.publicUrl, true); } catch { /* Do not expose malformed URLs containing credentials. */ } }
    return { id, name: names[id], kind: id === 'hub' ? 'hub' : source ? 'source' : 'channel', enabled, configured, status: configured ? 'configured' : 'needs-setup', secretConfigured: hasSecret, settings,
      message: configured ? source ? '验签配置已保存；还需在仓库登记可达的事件地址。' : id === 'feishu' ? '已保存；机器人权限和卡片回调订阅需在飞书应用确认。' : id === 'hub' ? '本机服务已配置；外部访问地址单独设置。' : '配置已保存，可进行只读检查。' : source ? '填写 Webhook 验签密钥，并在目标仓库配置事件地址。' : id === 'feishu' ? '需要本人 open_id、本机飞书登录与机器人卡片回调订阅。' : webhookIds.has(id) ? '填写已有机器人的 Webhook 地址。' : '尚未启用。' };
  }
  async function listenerConflict() {
    let result: CommandResult;
    try { result = await run('/bin/ps', ['-axo', 'pid=,ppid=,command='], env()); } catch { throw conflict('无法核对飞书监听进程，暂不启动；请稍后重试。'); }
    const processes = result.stdout.split('\n').flatMap(line => { const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u); return m ? [{ pid: Number(m[1]), parent: Number(m[2]), command: m[3]! }] : []; });
    const ownPid = Number((await textFile(join(requiredHome(), 'up.pid'), true)).trim());
    const own = processes.find(p => p.pid === ownPid && /agent-autoloop(?:\.ts)?\s+up\b/u.test(p.command));
    for (const process of processes.filter(p => /(?:lark-cli|larksuite).*\bevent\s+(?:consume|listen)\b/u.test(p.command))) {
      let current = process; const seen = new Set<number>(); let belongs = false;
      while (current && !seen.has(current.pid)) { if (own && current.pid === own.pid) { belongs = true; break; } seen.add(current.pid); const parent = processes.find(p => p.pid === current.parent); if (!parent) break; current = parent; }
      if (!belongs) throw conflict('已发现其他飞书事件监听。请先停用原监听，再启动这里的飞书通道。');
    }
  }
  return {
    async list() {
      try { const { config, rules, secrets } = await data(); return { connections: connectionIdSchema.options.map(id => item(id, config, rules, secrets)), restartRequired: await pending(config, secrets) }; }
      catch { return { connections: connectionIdSchema.options.map(id => ({ id, name: names[id], kind: id === 'hub' ? 'hub' as const : ['github', 'gitlab'].includes(id) ? 'source' as const : 'channel' as const, enabled: false, configured: false, status: 'unavailable' as const, message: '未找到可用的本机 Agent Autoloop 配置。', secretConfigured: false, settings: {} })), restartRequired: false }; }
    },
    async save(id, raw) {
      connectionIdSchema.parse(id); const input = autoloopConnectionSaveInputSchema.parse(raw);
      if (input.url !== undefined) secureUrl(input.url);
      if (input.publicUrl) secureUrl(input.publicUrl, true);
      return withAutoloopLock(join(requiredHome(), 'bestpartner-rules.lock'), async () => {
        const before = await data(); const config = structuredClone(before.config); const rules = structuredClone(before.rules); let secrets = before.secrets;
        const assertUnchanged = async () => {
          let revision: string;
          try { revision = (await data()).revision; }
          catch { throw conflict('连接配置已被其他程序更新或暂时无法读取，请刷新后重试。'); }
          if (revision !== before.revision) throw conflict('连接配置已被其他程序更新，请刷新后重试。');
        };
        config.channels ??= {}; rules.channels ??= {};
        if (id === 'hub') {
          if (!input.enabled) throw invalid('中台停启请使用服务控制。');
          if (!config.hub) throw invalid('本机没有中台配置。');
          if (input.publicUrl === '') delete config.hub.publicUrl;
          else if (input.publicUrl !== undefined) config.hub.publicUrl = secureUrl(input.publicUrl, true);
        } else if (id === 'github' || id === 'gitlab') {
          if (rules.sources[id] && rules.sources[id].adapter !== id) throw conflict('该来源名称已被其他配置使用，请先在规则管理中调整。');
          if (input.enabled) {
            if (!input.secret && !secretPresent(secrets, id)) throw invalid('首次启用需要填写 Webhook 验签密钥。');
            rules.sources[id] = { ...rules.sources[id], name: names[id], adapter: id };
          } else {
            if (rules.rules.some((r: Row) => r.when?.source === id || r.emits?.source === id)) throw conflict('仍有规则使用这个来源，请先停用相关规则。');
            delete rules.sources[id];
          }
          if (input.secret || !input.enabled) {
            secrets = secrets.split('\n').filter(line => !new RegExp(`^\\s*(?:export\\s+)?${secretName(id)}\\s*=`, 'u').test(line)).join('\n').replace(/\n+$/u, '');
            if (input.enabled && input.secret) secrets += `\n${secretName(id)}='${input.secret}'`;
            secrets += '\n';
          }
        } else if (!input.enabled) { delete config.channels[id]; delete rules.channels[id]; }
        else {
          const previous = config.channels[id] ?? {};
          if (previous.use && previous.use !== (webhookIds.has(id) ? 'webhook' : id)) throw conflict('该通道名称已被其他适配器使用。');
          const channel = { ...previous, use: webhookIds.has(id) ? 'webhook' : id };
          const rule = { ...rules.channels[id], name: names[id] };
          if (webhookIds.has(id)) { if (!input.url && !channel.url) throw invalid('首次启用需要填写机器人 Webhook 地址。'); if (input.url) channel.url = input.url; channel.platform = id; rule.links = true; }
          if (id === 'feishu') {
            const user = input.user ?? channel.user; if (typeof user !== 'string' || !/^ou_[A-Za-z0-9_-]+$/u.test(user)) throw invalid('请填写接收飞书卡片的本人 open_id。');
            channel.user = user; rule.answerers = input.answerers ?? rule.answerers ?? [user];
            if (!rule.answerers.includes(user)) throw invalid('允许回答的人必须包含卡片接收人。');
          }
          config.channels[id] = channel; rules.channels[id] = rule;
        }
        // Validate against the installed engine before touching the active rules or minting a key.
        const candidate = join(requiredHome(), `bestpartner-check-${randomUUID()}.json`);
        try { await atomicJson(candidate, rules); await cli(['check'], { AGENT_AUTOLOOP_RULES: candidate }); }
        catch { throw invalid('连接配置未通过 Agent Autoloop 原生规则检查，原配置已保留。'); }
        finally { await unlink(candidate).catch(() => undefined); }
        if (input.enabled && !['hub', 'github', 'gitlab'].includes(id) && !config.channels[id].key) {
          await assertUnchanged();
          try { const created = await cli(['key', 'new', 'channel', id]); const key = created.stdout.trim(); if (!key || /\s/u.test(key)) throw new Error(); config.channels[id].key = key; }
          catch { throw new PublicApiError('AUTOLOOP_KEY_FAILED', '无法创建本机通道凭据，原配置已保留。', 503); }
        }
        // The app lock does not cover external editors or CLI commands. Recheck
        // after slow validation/key creation before committing any active file.
        await assertUnchanged();
        const markerFile = join(requiredHome(), 'bestpartner-connections-state.json');
        if (!await textFile(markerFile, true)) await atomicJson(markerFile, { applied: fingerprint(before.config, before.secrets) });
        try {
          await atomicJson(join(requiredHome(), 'rules.json'), rules);
          await atomicJson(join(requiredHome(), 'config.json'), config);
          if (secrets !== before.secrets) await atomicText(join(requiredHome(), 'secrets.env'), secrets);
        } catch {
          await atomicJson(join(requiredHome(), 'rules.json'), before.rules); await atomicJson(join(requiredHome(), 'config.json'), before.config); await atomicText(join(requiredHome(), 'secrets.env'), before.secrets);
          throw new PublicApiError('AUTOLOOP_SAVE_FAILED', '保存未完成，已恢复原配置。', 503);
        }
        return { ok: true as const, restartRequired: await pending(config, secrets) };
      });
    },
    async probe(id) {
      connectionIdSchema.parse(id); const checks: AutoloopConnectionProbe['checks'] = [];
      const check = (name: string, ok: boolean, message: string) => checks.push({ name, ok, message });
      try {
        const { config, rules, secrets } = await data(); const current = item(id, config, rules, secrets);
        check('configuration', current.configured, current.message);
        const online = await health(config); check('hub', online, online ? '本机中台可以访问。' : '本机中台未响应。');
        if (await pending(config, secrets)) check('restart', false, '新配置尚未通过这里的重启应用。');
        if (id === 'feishu') {
          try {
            const result = await run('lark-cli', ['auth', 'status'], env()); const auth = JSON.parse(result.stdout);
            const bot = auth.identities?.bot?.status === 'ready'; const user = auth.identities?.user?.status === 'ready';
            check('bot', bot, bot ? '飞书机器人身份可用。' : '飞书机器人身份未就绪。');
            check('user', user, user ? '飞书本人身份可用。' : '飞书本人登录需要刷新；请在终端运行 lark-cli auth login。');
          } catch { check('lark-cli', false, '无法读取 lark-cli 登录状态。'); }
          try {
            const preflight = await run('lark-cli', ['event', 'consume', 'card.action.trigger', '--as', 'bot', '--dry-run'], env());
            const decision = JSON.parse(preflight.stdout).data?.decision;
            const ready = decision?.status === 'ready' || decision?.status === 'allowed';
            const subscribed = decision?.preconditions?.find((condition: Row) => condition.name === 'console_event_published')?.status === 'ok';
            check('callback', ready || subscribed, ready || subscribed ? '卡片回调订阅检查通过；此检查未建立新监听，也未验证真实点击。' : '现有飞书应用尚未订阅卡片回传交互 card.action.trigger，请在开发者后台添加回调并使用长连接。');
          } catch { check('callback', false, '无法检查卡片回调订阅，请确认 lark-cli 已升级并配置了卡片回传交互。'); }
          try { await listenerConflict(); check('listener', true, '未发现其他应用占用飞书事件监听。'); } catch { check('listener', false, '其他飞书事件监听正在运行，不能再开一个。'); }
        } else if (id === 'github') {
          try { await run('gh', ['auth', 'status'], env()); check('github-cli', true, 'GitHub CLI 已登录，可供轮询和交付任务使用。'); }
          catch { check('github-cli', false, 'GitHub CLI 未登录或不可用。'); }
        }
        if (id === 'github' || id === 'gitlab') {
          check('public-url', !!config.hub?.publicUrl, config.hub?.publicUrl ? '已配置外部入口地址；需在目标仓库登记 /v1/in/' + id + '。' : '尚无外部入口地址，仓库 Webhook 无法直接访问本机。');
          check('delivery', false, '尚未验证远端仓库的真实事件投递；此检查不修改仓库。');
        }
        if (webhookIds.has(id)) { check('public-url', !!config.hub?.publicUrl, config.hub?.publicUrl ? '卡片链接使用已配置外部入口。' : '需要外部可打开的中台地址，才能在消息中回答卡片。'); check('delivery', false, 'Webhook 地址已检查格式；此检查不会向群组发送消息。'); }
      } catch { check('configuration', false, '无法读取本机 Agent Autoloop 配置。'); }
      const ok = checks.length > 0 && checks.every(c => c.ok);
      return { id, ok, message: ok ? '只读检查通过。' : '检查完成，仍有待处理或待实际验证的项目。', checks };
    },
    async lifecycle(action) {
      if (!['start', 'restart', 'stop'].includes(action)) throw invalid('无效的服务操作。');
      return withAutoloopLock(join(requiredHome(), 'bestpartner-rules.lock'), async () => {
        const { config, secrets } = await data();
        if (action !== 'stop' && config.channels?.feishu) await listenerConflict();
        try {
          // Stop the managed service and any manually launched process owned by this installation.
          await cli(['service', 'remove']);
          const serviceModule = pathToFileURL(join(requiredHome(), 'app', 'host', 'service.ts')).href;
          await run(await executable(), ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `const {stopUp}=await import(${JSON.stringify(serviceModule)});stopUp();`], env());
          if (action === 'stop') {
            if (await health(config)) throw new Error('Service still responds');
            return { ok: true as const, message: '中台服务已停止；已领取的 Agent 任务会按原流程结束。' };
          }
          await cli(['service', 'install']);
        } catch { throw new PublicApiError('AUTOLOOP_SERVICE_FAILED', '服务操作未完成，请查看本机 Agent Autoloop 日志后重试。', 503); }
        for (let attempt = 0; attempt < 20; attempt++) { if (await health(config)) { await atomicJson(join(requiredHome(), 'bestpartner-connections-state.json'), { applied: fingerprint(config, secrets) }); return { ok: true as const, message: '服务已启动，新连接配置已加载。' }; } await new Promise(resolve => setTimeout(resolve, 250)); }
        throw new PublicApiError('AUTOLOOP_SERVICE_PENDING', '已提交启动操作，中台尚未响应；请稍后重新检查。', 503);
      });
    }
  };
}
