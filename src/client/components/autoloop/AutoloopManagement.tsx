import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { autoloopDocumentSchema, type AutoloopConfiguration, type AutoloopDocument, type AutoloopRule, type AutoloopAgent, type AutoloopGlobalState, type AutoloopTrace, type AutoloopTemplate } from '../../../shared/api/autoloop-management.js';
import type { ApiClientResult, ReadConsoleApi } from '../../api/client.js';
import { useConsoleRuntime } from '../../app/ConsoleRuntime.js';
import { AutoloopConnections } from './AutoloopConnections.js';
export type ManagementSection = 'rules' | 'connections' | 'overview' | 'templates';
type Client = NonNullable<ReadConsoleApi['autoloopManagement']>;
type Row = Record<string, unknown>;
export function message<T>(result: ApiClientResult<T>) { return !result.ok && 'state' in result ? result.state.message ?? '操作未完成，请重试。' : '操作未完成，请重试。'; }
const words = (value: string) => value.split(/[\n,，]/u).map(s => s.trim()).filter(Boolean);
const str = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) { return <label className={`autoloop-field${wide ? ' autoloop-field--wide' : ''}`}><span>{label}</span>{children}</label>; }
function Buttons({ children }: { children: ReactNode }) { return <div className="autoloop-actions">{children}</div>; }
function Button({ children, onClick, disabled, primary = false, type = 'button', label }: { children: ReactNode; onClick?: (event: MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; primary?: boolean; type?: 'button' | 'submit'; label?: string }) { return <button type={type} className={`autoloop-button${primary ? ' autoloop-button--primary' : ''}`} disabled={disabled} onClick={onClick} aria-label={label}>{children}</button>; }

function PanelHeading({ children, request }: { children: ReactNode; request: unknown }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView?.({ block: 'start' });
  }, [request]);
  return <h3 className="autoloop-panel-heading" ref={heading} tabIndex={-1}>{children}</h3>;
}

export function AutoloopManagement({ section, active = true }: { section: ManagementSection; active?: boolean }) {
  const { api, runtimeMode } = useConsoleRuntime();
  const client = runtimeMode === 'company' ? undefined : api.autoloopManagement;
  if (!client) return <div className="autoloop-empty"><h2>管理服务尚未连接</h2><p>请在个人模式中启动自动任务服务。</p></div>;
  if (section === 'overview') return <Overview client={client} active={active} />;
  return <Configuration client={client} section={section} active={active} />;
}

function Configuration({ client, section, active }: { client: Client; section: Exclude<ManagementSection, 'overview'>; active: boolean }) {
  const [config, setConfig] = useState<AutoloopConfiguration | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [revision, setRevision] = useState(0);
  const readEpoch = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); const epoch = ++readEpoch.current;
    setLoading(true);
    void client.configuration(controller.signal).then(result => {
      if (controller.signal.aborted || epoch !== readEpoch.current) return;
      setLoading(false);
      if (result.ok) { setConfig(result.value); setError(''); } else if (!('cancelled' in result)) setError(message(result));
    });
    return () => controller.abort();
  }, [client, revision, active]);
  async function save(document: AutoloopDocument, disabledRules = config?.disabledRules ?? [], onError: (message: string) => void = setError) {
    if (!config || loading || lock.current) return false;
    lock.current = true; ++readEpoch.current; setBusy(true); setError(''); setNotice('');
    try {
      const result = await client.saveConfiguration({ revision: config.revision, document, disabledRules });
      if (!alive.current) return false;
      if (!result.ok) { onError(message(result)); return false; }
      setConfig({ ...config, revision: result.value.revision, document, disabledRules });
      setNotice(result.value.message || (result.value.loaded ? '配置已保存并载入。' : '配置已保存，等待服务载入。'));
      return true;
    } finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  return <div className="autoloop-management">
    <header className="autoloop-section-title"><div><h2>{section === 'rules' ? '自动规则' : section === 'connections' ? '连接与执行' : '场景模板'}</h2><p className="autoloop-muted">{section === 'rules' ? '定时运行，或让来源事件触发指定 Agent。' : section === 'connections' ? '配置执行器、来源与通知通道，分别检查实际连接。' : '先调整模板中的目录和执行器，再保存到自动规则。'}</p></div><Button disabled={busy || loading} onClick={() => setRevision(n => n + 1)}>重新读取配置</Button></header>
    {error && <p role="alert" className="autoloop-error">{error}</p>}{notice && <p role="status" className="autoloop-notice">{notice}</p>}
    {!config ? <p className="autoloop-muted">{loading ? '正在读取配置…' : '配置暂不可用，可重新读取。'}</p> : <>
      {section === 'rules' && <Rules client={client} config={config} busy={busy || loading} save={save} onConfigurationChanged={() => setRevision(n => n + 1)} />}
      {section === 'connections' && <><AutoloopConnections active={active} onSaved={() => setRevision(n => n + 1)} /><Agents config={config} busy={busy || loading} save={save} /><Sources config={config} busy={busy || loading} save={save} /><Advanced config={config} busy={busy || loading} save={save} /></>}
      {section === 'templates' && <Templates client={client} config={config} busy={busy || loading} save={save} />}
    </>}
  </div>;
}
type ConfigProps = { config: AutoloopConfiguration; busy: boolean; save: (document: AutoloopDocument, disabledRules?: AutoloopRule[], onError?: (message: string) => void) => Promise<boolean> };
function Rules({ client, config, busy, save, onConfigurationChanged }: ConfigProps & { client: Client; onConfigurationChanged: () => void }) {
  const [edit, setEdit] = useState<{ original: string | null; rule?: AutoloopRule } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [triggerMessage, setTriggerMessage] = useState('');
  const requestIds = useRef(new Map<string, string>());
  const triggerLock = useRef(false);
  async function trigger(rule: AutoloopRule) {
    if (triggerLock.current) return;
    triggerLock.current = true; setTriggering(rule.name); setTriggerMessage('');
    let id = requestIds.current.get(rule.name); if (!id) { id = crypto.randomUUID(); requestIds.current.set(rule.name, id); }
    try { const result = await client.trigger(rule.name, id); setTriggerMessage(result.ok ? `已触发「${rule.name}」，事件 #${result.value.event}。在运行总览查看进度。` : message(result)); if (result.ok) requestIds.current.delete(rule.name); }
    finally { triggerLock.current = false; setTriggering(null); onConfigurationChanged(); }
  }
  async function toggle(rule: AutoloopRule, disabled: boolean) {
    await save({ ...config.document, rules: disabled ? [...config.document.rules, rule] : config.document.rules.filter(item => item.name !== rule.name) }, disabled ? config.disabledRules.filter(item => item.name !== rule.name) : [...config.disabledRules, rule]);
  }
  const rows = [...config.document.rules.map(rule => ({ rule, disabled: false })), ...config.disabledRules.map(rule => ({ rule, disabled: true }))];
  return <>
    <div className="autoloop-toolbar"><span className="autoloop-muted">{config.document.rules.length} 条已启用 · {config.disabledRules.length} 条已暂停 · {config.document.timezone || '系统时区'}</span><Button primary disabled={busy} onClick={() => setEdit({ original: null })}>新建规则</Button></div>
    {triggerMessage && <p role="status" className="autoloop-notice">{triggerMessage}</p>}
    {edit && <RuleEditor focusRequest={edit} key={edit.original ?? 'new'} config={config} existing={edit.rule} busy={busy} onClose={() => setEdit(null)} onSave={async rule => {
      const allNames = rows.map(item => item.rule.name);
      if (rule.name !== edit.original && allNames.includes(rule.name)) return '规则名称已存在。';
      const wasDisabled = config.disabledRules.some(item => item.name === edit.original);
      const rules = config.document.rules.filter(item => item.name !== edit.original);
      const disabled = config.disabledRules.filter(item => item.name !== edit.original);
      (wasDisabled ? disabled : rules).push(rule);
      let error = '';
      if (await save({ ...config.document, rules }, disabled, text => { error = text; })) setEdit(null);
      return error;
    }} />}
    <div className="autoloop-rows">{rows.length === 0 && <p className="autoloop-muted">还没有自动规则。创建第一条定时或事件规则。</p>}{rows.map(({ rule, disabled }) => <article className="autoloop-row" key={rule.name}>
      <div className="autoloop-row-heading"><h3>{rule.name}</h3><span className={`autoloop-status ${disabled ? '' : 'autoloop-status--done'}`}>{disabled ? '已暂停' : '已启用'}</span></div>
      <p className="autoloop-muted">{'cron' in rule.when ? `定时 · ${rule.when.cron}` : `事件 · ${rule.when.source} / ${rule.when.types.join(', ')}`} → {config.document.agents[rule.to]?.name || rule.to}</p>
      <p className="autoloop-plain">{rule.prompt || rule.skill || '按事件详情执行'}</p><p className="autoloop-muted">目录：{rule.cwd}{rule.skill ? ` · Skill：${rule.skill}` : ''}</p>
      <Buttons><Button label={`编辑 ${rule.name}`} disabled={busy} onClick={() => setEdit({ original: rule.name, rule })}>编辑</Button><Button label={`${disabled ? '启用' : '暂停'} ${rule.name}`} disabled={busy} onClick={() => { void toggle(rule, disabled); }}>{disabled ? '启用' : '暂停'}</Button><Button label={`立即触发 ${rule.name}`} disabled={busy || disabled || triggering !== null} onClick={() => { void trigger(rule); }}>{triggering === rule.name ? '正在触发…' : '立即触发'}</Button><Button label={`删除 ${rule.name}`} disabled={busy} onClick={() => setConfirmDelete(rule.name)}>删除</Button></Buttons>
      {confirmDelete === rule.name && <div className="autoloop-stop"><p>删除「{rule.name}」的规则？已有运行记录会保留。</p><Buttons><Button disabled={busy} onClick={() => { void save({ ...config.document, rules: config.document.rules.filter(item => item.name !== rule.name) }, config.disabledRules.filter(item => item.name !== rule.name)).then(ok => { if (ok) setConfirmDelete(null); }); }}>确认删除规则</Button><Button onClick={() => setConfirmDelete(null)}>保留规则</Button></Buttons></div>}
    </article>)}</div>
    <EventForm client={client} config={config} />
  </>;
}
function RuleEditor({ config, existing, busy, onClose, onSave, focusRequest }: { focusRequest: object; config: AutoloopConfiguration; existing?: AutoloopRule | undefined; busy: boolean; onClose: () => void; onSave: (rule: AutoloopRule) => Promise<string> }) {
  const [name, setName] = useState(existing?.name || '');
  const [kind, setKind] = useState(existing && 'source' in existing.when ? 'event' : 'cron');
  const [cron, setCron] = useState(existing && 'cron' in existing.when ? existing.when.cron : '0 9 * * *');
  const [source, setSource] = useState(existing && 'source' in existing.when ? existing.when.source : Object.keys(config.document.sources)[0] || '');
  const [types, setTypes] = useState(existing && 'types' in existing.when ? existing.when.types.join(', ') : 'manual');
  const [to, setTo] = useState(existing?.to || Object.keys(config.document.agents)[0] || '');
  const [cwd, setCwd] = useState(existing?.cwd || ''); const [prompt, setPrompt] = useState(existing?.prompt || ''); const [skill, setSkill] = useState(existing?.skill || '');
  const [tell, setTell] = useState<NonNullable<AutoloopRule['tell']>>(existing?.tell || 'needed');
  const [group, setGroup] = useState(existing?.group || ''); const [parallel, setParallel] = useState(existing?.parallel?.toString() || '');
  const [emitSource, setEmitSource] = useState(existing?.emits?.source || ''); const [emitTypes, setEmitTypes] = useState(existing?.emits?.types.join(', ') || '');
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!name.trim() || !cwd.trim() || !to || (kind === 'cron' ? !cron.trim() : !source || !words(types).length)) { setError('请填写名称、触发条件、Agent 和工作目录。'); return; }
    if (emitSource && !words(emitTypes).length) { setError('请填写下游事件类型。'); return; }
    const rule: AutoloopRule = { name: name.trim(), when: kind === 'cron' ? { cron: cron.trim() } : { source, types: words(types) }, to, cwd: cwd.trim(), tell,
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}), ...(skill.trim() ? { skill: skill.trim() } : {}), ...(group.trim() ? { group: group.trim() } : {}), ...(parallel ? { parallel: Number(parallel) } : {}), ...(emitSource ? { emits: { source: emitSource, types: words(emitTypes) } } : {}) };
    setError(await onSave(rule));
  }
  return <form className="autoloop-editor" onSubmit={event => { void submit(event); }}><PanelHeading request={focusRequest}>{existing ? '编辑规则' : '新规则'}</PanelHeading><fieldset disabled={busy} className="autoloop-form-grid">
    <Field label="规则名称"><input value={name} onChange={e => setName(e.target.value)} required /></Field><Field label="触发方式"><select value={kind} onChange={e => setKind(e.target.value)}><option value="cron">定时</option><option value="event">来源事件</option></select></Field>
    {kind === 'cron' ? <Field label="Cron 表达式"><input value={cron} onChange={e => setCron(e.target.value)} required placeholder="0 9 * * *" /></Field> : <><Field label="事件来源"><select value={source} onChange={e => setSource(e.target.value)}>{Object.entries(config.document.sources).map(([id, value]) => <option key={id} value={id}>{value.name} ({id})</option>)}</select></Field><Field label="事件类型"><input value={types} onChange={e => setTypes(e.target.value)} placeholder="逗号分隔，支持 *" /></Field></>}
    <Field label="规则执行 Agent"><select value={to} onChange={e => setTo(e.target.value)}>{Object.entries(config.document.agents).map(([id, value]) => <option key={id} value={id}>{value.name}</option>)}</select></Field><Field label="工作目录"><input value={cwd} onChange={e => setCwd(e.target.value)} required placeholder="/完整/目录/路径" /></Field><Field label="规则 Skill"><input value={skill} onChange={e => setSkill(e.target.value)} placeholder="Skill 名称或绝对路径，可选" /></Field>
    <Field label="规则任务要求" wide><textarea rows={5} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="清楚描述要做什么、要读哪些资料、如何验收。" /></Field>
    <Field label="通知方式"><select value={tell} onChange={e => setTell(e.target.value as typeof tell)}><option value="needed">需要回答时通知</option><option value="always">每次都通知</option><option value="never">不发送通知</option></select></Field><Field label="并发上限"><input type="number" min={1} value={parallel} onChange={e => setParallel(e.target.value)} placeholder="默认" /></Field><Field label="分组模板"><input value={group} onChange={e => setGroup(e.target.value)} placeholder="可选，如 ${subject}" /></Field>
    <Field label="下游事件来源"><select value={emitSource} onChange={e => setEmitSource(e.target.value)}><option value="">不派发下游事件</option>{Object.entries(config.document.sources).map(([id, value]) => <option key={id} value={id}>{value.name}</option>)}</select></Field><Field label="下游事件类型"><input value={emitTypes} onChange={e => setEmitTypes(e.target.value)} placeholder="逗号分隔" /></Field>
  </fieldset><p className="autoloop-muted">Cron 格式为“分 时 日 月 周”，使用规则时区；0 9 * * * 表示每天 09:00。通知按“连接与执行”中已配置的通道发送。</p>{error && <p className="autoloop-error" role="alert">{error}</p>}<Buttons><Button primary type="submit" disabled={busy}>{busy ? '保存中…' : '保存规则'}</Button><Button disabled={busy} onClick={onClose}>关闭编辑</Button></Buttons></form>;
}
function EventForm({ client, config }: { client: Client; config: AutoloopConfiguration }) {
  const [type, setType] = useState('manual'); const [subject, setSubject] = useState(''); const [summary, setSummary] = useState(''); const [detail, setDetail] = useState(''); const [result, setResult] = useState(''); const [busy, setBusy] = useState(false); const id = useRef<string | null>(null); const lock = useRef(false);
  const change = (set: (value: string) => void, value: string) => { set(value); id.current = null; };
  return <details className="autoloop-advanced"><summary>发送本机事件</summary><p className="autoloop-muted">事件从本机已配置来源进入，匹配规则后会实际执行。{config.localWorker ? `本机：${config.localWorker}` : '请先配置本机 worker。'}</p><form onSubmit={event => { event.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); id.current ??= crypto.randomUUID(); void client.emit({ id: id.current, type, ...(subject ? { subject } : {}), ...(summary ? { summary } : {}), ...(detail ? { detail } : {}) }).then(response => { setResult(response.ok ? `事件 #${response.value.event} 已接收，匹配 ${response.value.routed.length} 条规则。` : message(response)); if (response.ok) id.current = null; }).finally(() => { lock.current = false; setBusy(false); }); }}><fieldset disabled={busy} className="autoloop-form-grid"><Field label="本机事件类型"><input required value={type} onChange={e => change(setType, e.target.value)} /></Field><Field label="事件主题标识"><input value={subject} onChange={e => change(setSubject, e.target.value)} placeholder="可选，字母数字或路径" /></Field><Field label="事件摘要" wide><input value={summary} onChange={e => change(setSummary, e.target.value)} /></Field><Field label="事件详情" wide><textarea value={detail} onChange={e => change(setDetail, e.target.value)} rows={4} /></Field></fieldset><Button type="submit" disabled={busy || !config.localWorker}>提交事件</Button>{result && <p role="status" className="autoloop-notice">{result}</p>}</form></details>;
}
function Agents({ config, busy, save }: ConfigProps) {
  const [edit, setEdit] = useState<{ id: string; agent?: AutoloopAgent } | null>(null);
  const [remove, setRemove] = useState<string | null>(null);
  return <section className="autoloop-block"><div className="autoloop-section-title"><div><h3>执行 Agent</h3><p className="autoloop-muted">执行器由指定 worker 运行；模型可在任务提交时单独覆盖。</p></div><Button disabled={busy} onClick={() => setEdit({ id: '' })}>新增 Agent</Button></div>
    {edit && <AgentEditor focusRequest={edit} key={edit.id || 'new'} config={config} id={edit.id} existing={edit.agent} busy={busy} close={() => setEdit(null)} save={async (id, agent, onError) => { if (await save({ ...config.document, agents: { ...config.document.agents, [id]: agent } }, undefined, onError)) setEdit(null); }} />}
    {Object.entries(config.document.agents).map(([id, agent]) => <article key={id} className="autoloop-row"><div className="autoloop-row-heading"><h3>{agent.name}</h3><span className="autoloop-muted">{id}</span></div><p className="autoloop-muted">{agent.use} · {agent.worker} · {agent.model || '执行器默认模型'} · {agent.access || '默认权限'}</p><Buttons><Button disabled={busy} label={`编辑 Agent ${id}`} onClick={() => setEdit({ id, agent })}>编辑</Button><Button disabled={busy} label={`删除 Agent ${id}`} onClick={() => setRemove(id)}>删除</Button></Buttons>{remove === id && <div className="autoloop-stop"><p>确认删除执行器？引用它的规则需要先改用其他 Agent。</p><Buttons><Button disabled={busy} onClick={() => { const agents = { ...config.document.agents }; delete agents[id]; void save({ ...config.document, agents }).then(ok => { if (ok) setRemove(null); }); }}>确认删除 Agent</Button><Button onClick={() => setRemove(null)}>保留</Button></Buttons></div>}</article>)}
  </section>;
}
function AgentEditor({ config, id: initialId, existing, busy, close, save, focusRequest }: { focusRequest: object; config: AutoloopConfiguration; id: string; existing?: AutoloopAgent | undefined; busy: boolean; close: () => void; save: (id: string, agent: AutoloopAgent, onError: (message: string) => void) => Promise<void> }) {
  const [id, setId] = useState(initialId); const [name, setName] = useState(existing?.name || ''); const [worker, setWorker] = useState(existing?.worker || config.localWorker || ''); const [use, setUse] = useState(existing?.use || 'codex'); const [model, setModel] = useState(existing?.model || ''); const [effort, setEffort] = useState(existing?.effort || ''); const [access, setAccess] = useState(existing?.access || 'read'); const [command, setCommand] = useState(existing?.command?.join('\n') || ''); const [timeout, setTimeoutValue] = useState(existing?.timeout?.toString() || ''); const [error, setError] = useState('');
  return <form className="autoloop-editor" onSubmit={event => { event.preventDefault(); setError(''); if (!initialId && config.document.agents[id]) { setError('Agent 标识已存在。'); return; } const agent: AutoloopAgent = { name: name.trim(), worker: worker.trim(), use, access, ...(model.trim() ? { model: model.trim() } : {}), ...(effort.trim() ? { effort: effort.trim() } : {}), ...(command.trim() ? { command: command.split('\n').filter(Boolean) } : {}), ...(timeout ? { timeout: Number(timeout) } : {}) }; void save(id.trim(), agent, setError); }}>
    <PanelHeading request={focusRequest}>{initialId ? '编辑 Agent' : '新增 Agent'}</PanelHeading>
    <fieldset disabled={busy} className="autoloop-form-grid"><Field label="Agent 标识"><input required pattern="[a-zA-Z0-9_.-]+" disabled={Boolean(initialId)} value={id} onChange={e => setId(e.target.value)} /></Field><Field label="Agent 名称"><input required value={name} onChange={e => setName(e.target.value)} /></Field><Field label="执行 Worker"><input required value={worker} onChange={e => setWorker(e.target.value)} /></Field><Field label="执行器类型"><select value={use} onChange={e => setUse(e.target.value)}><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="acp">ACP</option><option value="command">自定义命令</option><option value="delivery">GitHub 交付</option>{!['codex', 'claude', 'acp', 'command', 'delivery'].includes(use) && <option value={use}>{use}</option>}</select></Field><Field label="Agent 模型"><input value={model} onChange={e => setModel(e.target.value)} placeholder="执行器默认" /></Field><Field label="推理强度"><input value={effort} onChange={e => setEffort(e.target.value)} placeholder="例如 high，取决于执行器" /></Field><Field label="执行权限"><select value={access} onChange={e => setAccess(e.target.value as typeof access)}><option value="read">只读</option><option value="edit">允许编辑</option><option value="full">完整执行权限</option></select></Field><Field label="超时（分钟）"><input type="number" min={1} value={timeout} onChange={e => setTimeoutValue(e.target.value)} /></Field><Field label="命令参数（每行一个参数）" wide><textarea rows={4} value={command} onChange={e => setCommand(e.target.value)} placeholder={'ACP / 自定义执行器填命令；GitHub 交付填 owner/repo。每行一个参数，例如：\n/path/to/program\n--argument'} /></Field></fieldset>{error && <p role="alert" className="autoloop-error">{error}</p>}<Buttons><Button type="submit" primary disabled={busy}>{busy ? '保存中…' : '保存 Agent'}</Button><Button disabled={busy} onClick={close}>关闭编辑</Button></Buttons>
  </form>;
}
function Sources({ config, busy, save }: ConfigProps) {
  const [openRequest, setOpenRequest] = useState(0);
  const [edit, setEdit] = useState<string | null>(null); const [id, setId] = useState(''); const [name, setName] = useState(''); const [adapter, setAdapter] = useState(''); const [error, setError] = useState(''); const [remove, setRemove] = useState<string | null>(null);
  return <section className="autoloop-block"><div className="autoloop-section-title"><div><h3>事件来源</h3><p className="autoloop-muted">登记来源后，在上方配置它的连接；事件是否进入可在运行总览检查。</p></div><Button disabled={busy} onClick={() => { setOpenRequest(n => n + 1); setError(''); setEdit(''); setId(''); setName(''); setAdapter(''); }}>新增来源</Button></div>
    {edit !== null && <form className="autoloop-editor" onSubmit={event => { event.preventDefault(); setError(''); const sourceId = id.trim(); if (!sourceId) { setError('请填写来源标识。'); return; } if (edit === '' && Object.hasOwn(config.document.sources, sourceId)) { setError('来源标识已存在。'); return; } void save({ ...config.document, sources: { ...config.document.sources, [sourceId]: { name: name.trim(), ...(adapter.trim() ? { adapter: adapter.trim() } : {}) } } }, undefined, setError).then(ok => { if (ok) setEdit(null); }); }}><PanelHeading request={openRequest}>{edit ? '编辑来源' : '新增来源'}</PanelHeading><fieldset disabled={busy} className="autoloop-form-grid"><Field label="来源标识"><input required disabled={Boolean(edit)} value={id} onChange={e => setId(e.target.value)} /></Field><Field label="来源名称"><input required value={name} onChange={e => setName(e.target.value)} /></Field><Field label="来源适配器"><input value={adapter} onChange={e => setAdapter(e.target.value)} placeholder="可选，如 github" /></Field></fieldset>{error && <p role="alert" className="autoloop-error">{error}</p>}<Buttons><Button type="submit" primary disabled={busy}>{busy ? '保存中…' : '保存来源'}</Button><Button onClick={() => setEdit(null)}>关闭编辑</Button></Buttons></form>}
    {Object.entries(config.document.sources).map(([key, source]) => <article className="autoloop-row" key={key}><div className="autoloop-row-heading"><h3>{source.name}</h3><span className="autoloop-muted">{key} · {source.adapter || '通用事件'}</span></div><Buttons><Button disabled={busy} label={`编辑来源 ${key}`} onClick={() => { setOpenRequest(n => n + 1); setError(''); setEdit(key); setId(key); setName(source.name); setAdapter(source.adapter || ''); }}>编辑</Button><Button disabled={busy} label={`删除来源 ${key}`} onClick={() => setRemove(key)}>删除</Button></Buttons>{remove === key && <div className="autoloop-stop"><p>确认删除来源？引用此来源的规则需要先调整。</p><Buttons><Button disabled={busy} onClick={() => { const sources = { ...config.document.sources }; delete sources[key]; void save({ ...config.document, sources }).then(ok => { if (ok) setRemove(null); }); }}>确认删除来源</Button><Button onClick={() => setRemove(null)}>保留</Button></Buttons></div>}</article>)}
  </section>;
}
function Advanced({ config, busy, save }: ConfigProps) {
  const [draft, setDraft] = useState(''); const [error, setError] = useState('');
  return <details className="autoloop-advanced"><summary>完整配置与高级路由</summary><p className="autoloop-muted">包含时区、askFirst、通道显示设置、规则和外部定时任务登记。保存前校验原生配置；凭据在上方连接表单单独保存。</p><Button disabled={busy} onClick={() => setDraft(JSON.stringify(config.document, null, 2))}>载入当前配置到编辑器</Button><form onSubmit={event => { event.preventDefault(); try { const parsed = autoloopDocumentSchema.safeParse(JSON.parse(draft)); if (!parsed.success) { setError(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('\n')); return; } setError(''); void save(parsed.data); } catch { setError('请输入有效的 JSON。'); } }}><Field label="完整规则配置" wide><textarea className="autoloop-code" rows={18} value={draft} onChange={e => setDraft(e.target.value)} /></Field>{error && <p className="autoloop-error" role="alert">{error}</p>}<Button type="submit" disabled={busy || !draft.trim()}>校验并保存完整配置</Button></form></details>;
}
type TemplateSummary = Pick<AutoloopTemplate, 'id' | 'name' | 'description'>;

function Templates({ client, config, busy, save }: ConfigProps & { client: Client }) {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [opened, setOpened] = useState<TemplateSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [revision, setRevision] = useState(0);
  const returnPoint = useRef<{
    button: HTMLButtonElement;
    positions: { element: HTMLElement; top: number }[];
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setListError('');
    void client.templates(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setLoading(false);
      if (result.ok) setTemplates(result.value.templates);
      else setListError(message(result));
    });
    return () => controller.abort();
  }, [client, revision]);

  function open(template: TemplateSummary, button: HTMLButtonElement) {
    const positions: { element: HTMLElement; top: number }[] = [];
    for (let element = button.parentElement; element; element = element.parentElement) {
      positions.push({ element, top: element.scrollTop });
    }
    returnPoint.current = { button, positions };
    setOpened(template);
  }

  useLayoutEffect(() => {
    const point = returnPoint.current;
    if (opened || !point) return;
    point.button.focus({ preventScroll: true });
    for (const { element, top } of point.positions) element.scrollTop = top;
    returnPoint.current = null;
  }, [opened]);

  return <>
    <div hidden={opened !== null}>
      {loading && <p role="status" className="autoloop-muted">正在读取本机模板…</p>}
      {listError && <><p role="alert" className="autoloop-error">{listError}</p>
        <Button onClick={() => setRevision(value => value + 1)}>重试模板列表</Button></>}
      {!loading && !listError && templates.length === 0 && <p className="autoloop-muted">当前安装没有提供可用模板。</p>}
      <div className="autoloop-template-grid">
        {templates.map(template => <button key={template.id} type="button" className="autoloop-template-card"
          aria-label={`查看 ${template.name}`} onClick={event => open(template, event.currentTarget)}>
          <span className="autoloop-template-card__name">{template.name}</span>
          <span className="autoloop-muted">{template.description}</span>
          <span className="autoloop-template-card__action">查看与配置 →</span>
        </button>)}
      </div>
    </div>
    {opened && <TemplateDetail key={opened.id} template={opened} client={client} config={config}
      busy={busy} save={save} onBack={() => setOpened(null)} />}
  </>;
}

function TemplateDetail({ template, client, config, busy, save, onBack }: ConfigProps & {
  template: TemplateSummary;
  client: Client;
  onBack: () => void;
}) {
  const [selected, setSelected] = useState<AutoloopTemplate | null>(null);
  const [readError, setReadError] = useState('');
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [prepared, setPrepared] = useState(false);
  const [deliveryRepo, setDeliveryRepo] = useState('');
  const [preparing, setPreparing] = useState(false);
  const prepareLock = useRef(false);
  const readSession = useRef<AbortSignal | null>(null);
  const title = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    title.current?.focus({ preventScroll: true });
    title.current?.closest('section')?.scrollIntoView?.({ block: 'start' });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    readSession.current = controller.signal;
    setReadError('');
    void client.template(template.id, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (!result.ok) { setReadError(message(result)); return; }
      setSelected(result.value);
      setDraft(result.value.rules ? JSON.stringify(result.value.rules, null, 2) : '');
    });
    return () => controller.abort();
  }, [client, template.id, revision]);

  async function prepare() {
    if (!selected || prepareLock.current) return;
    const session = readSession.current;
    prepareLock.current = true;
    setPreparing(true);
    setError('');
    try {
      const result = await client.prepareTemplate(selected.id);
      if (session?.aborted) return;
      if (!result.ok) { setError(message(result)); return; }
      setSelected(result.value);
      setDraft(result.value.rules ? JSON.stringify(result.value.rules, null, 2) : '');
      setPrepared(true);
      setNotice('场景文件已准备，目录和执行 worker 已填入。请核对任务与连接后导入。');
    } finally {
      prepareLock.current = false;
      if (!session?.aborted) setPreparing(false);
    }
  }
  function setRepository(value: string) {
    setDeliveryRepo(value);
    try { const document = autoloopDocumentSchema.parse(JSON.parse(draft)); for (const agent of Object.values(document.agents)) { if (agent.use === 'delivery') agent.command = [value.trim()]; else if (agent.command) agent.command = agent.command.map(arg => arg.includes('REPLACE_OWNER/REPLACE_REPOSITORY') || (deliveryRepo && arg === deliveryRepo.trim()) ? value.trim() : arg); } setDraft(JSON.stringify(document, null, 2)); } catch { setError('请先修复模板配置中的 JSON 格式，再填写目标仓库。'); }
  }
  async function importTemplate(event: FormEvent) {
    event.preventDefault(); setError(''); if (!prepared) { setError('请先准备场景文件。'); return; }
    try {
      const parsed = autoloopDocumentSchema.safeParse(JSON.parse(draft)); if (!parsed.success) { setError(`模板配置不完整：${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；')}`); return; }
      const incoming = parsed.data;
      const deliveries = Object.values(incoming.agents).filter(agent => agent.use === 'delivery');
      if (Object.values(incoming.agents).some(agent => agent.command?.some(arg => arg.includes('REPLACE_OWNER/REPLACE_REPOSITORY'))) || deliveries.some(agent => !agent.command?.[0] || agent.command[0].includes('REPLACE_') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(agent.command[0]))) { setError('请填写实际的 GitHub 目标仓库（owner/repo），再导入交付场景。'); return; }
      const collisions = incoming.rules.filter(rule => [...config.document.rules, ...config.disabledRules].some(old => old.name === rule.name));
      const changedIds = (['agents', 'sources'] as const).flatMap(kind => Object.entries(incoming[kind] ?? {}).filter(([id, value]) => config.document[kind]?.[id] && JSON.stringify(config.document[kind]?.[id]) !== JSON.stringify(value)).map(([id]) => `${kind}.${id}`));
      if (incoming.timezone && config.document.timezone && incoming.timezone !== config.document.timezone) { setError('模板时区与现有配置不同，请在模板中改为当前时区后导入。'); return; }
      const elsewhereConflicts = (incoming.elsewhere ?? []).filter(item => config.document.elsewhere?.some(old => old.name === item.name && JSON.stringify(old) !== JSON.stringify(item)));
      changedIds.push(...elsewhereConflicts.map(item => `elsewhere.${item.name}`));
      if (collisions.length || changedIds.length) { setError(`请先重命名模板中的重复项：${[...collisions.map(rule => rule.name), ...changedIds].join('、')}`); return; }
      if (await save({ ...config.document, sources: { ...config.document.sources, ...incoming.sources }, agents: { ...config.document.agents, ...incoming.agents }, channels: { ...incoming.channels, ...config.document.channels }, ...(incoming.timezone && !config.document.timezone ? { timezone: incoming.timezone } : {}), ...((incoming.askFirst || config.document.askFirst) ? { askFirst: [...new Set([...(config.document.askFirst ?? []), ...(incoming.askFirst ?? [])])] } : {}), ...((incoming.elsewhere || config.document.elsewhere) ? { elsewhere: Array.from(new Map([...(config.document.elsewhere ?? []), ...(incoming.elsewhere ?? [])].map(item => [item.name, item])).values()) } : {}) }, [...config.disabledRules, ...incoming.rules])) setNotice('模板已导入为暂停规则。到“自动规则”核对后启用。');
    } catch { setError('模板配置需要有效的 JSON。'); }
  }
  return <section className="autoloop-template-detail" aria-labelledby="autoloop-open-template-title">
    <header className="autoloop-template-detail__header">
      <Button onClick={onBack} disabled={busy}>返回模板列表</Button>
      <h3 id="autoloop-open-template-title" ref={title} tabIndex={-1}>{template.name}</h3>
      {template.description && <p className="autoloop-muted">{template.description}</p>}
    </header>
    {readError && <div className="autoloop-template-detail__feedback">
      <p role="alert" className="autoloop-error">{readError}</p>
      <Button onClick={() => setRevision(value => value + 1)}>重试读取详情</Button>
    </div>}
    {!selected && !readError && <p role="status" className="autoloop-muted">正在读取场景详情…</p>}
    {selected && <>
      {selected.readme && <pre className="autoloop-readme autoloop-template-readme">{selected.readme}</pre>}
      {selected.rules !== null ? <form onSubmit={event => { void importTemplate(event); }}>
        <p className="autoloop-muted">先准备本机场景文件，再核对 worker、Agent、目录和事件来源。已有文件会保留，导入后处于暂停状态。</p>
        <Button disabled={busy || preparing} onClick={() => { void prepare(); }}>{preparing ? '正在准备…' : '准备场景文件'}</Button>
        {selected.id === 'delivery' && <Field label="GitHub 仓库（owner/repo）">
          <input value={deliveryRepo} disabled={!prepared || preparing} onChange={e => setRepository(e.target.value)} placeholder="my-team/my-project" />
        </Field>}
        {notice && <p role="status" className="autoloop-notice">{notice}</p>}
        {error && <p role="alert" className="autoloop-error">{error}</p>}
        <Field label="模板配置" wide>
          <textarea className="autoloop-code" aria-label="模板配置" rows={18} value={draft} onChange={e => setDraft(e.target.value)} />
        </Field>
        <Button primary type="submit" disabled={busy || preparing || !prepared}>导入为暂停规则</Button>
      </form> : <p className="autoloop-muted">该场景提供操作指南，没有可直接导入的规则配置。</p>}
    </>}
  </section>;
}

function Overview({ client, active }: { client: Client; active: boolean }) {
  const [state, setState] = useState<AutoloopGlobalState | null>(null); const [olderRuns, setOlderRuns] = useState<Row[]>([]); const [nextBefore, setNextBefore] = useState<number | null>(null); const paged = useRef(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false); const [revision, setRevision] = useState(0); const [trace, setTrace] = useState<AutoloopTrace | null>(null); const [traceError, setTraceError] = useState(''); const [selectedRun, setSelectedRun] = useState<number | null>(null); const [confirmCancel, setConfirmCancel] = useState<number | null>(null); const lock = useRef(false); const epoch = useRef(0); const traceEpoch = useRef(0);
  const traceTrigger = useRef<HTMLButtonElement | null>(null);
  const [traceRequest, setTraceRequest] = useState(0);
  useLayoutEffect(() => {
    if (selectedRun === null && traceTrigger.current) {
      traceTrigger.current.focus();
      traceTrigger.current = null;
    }
  }, [selectedRun]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      const current = epoch.current;
      if (!lock.current) {
        const result = await client.state(undefined, controller.signal);
        if (controller.signal.aborted) return;
        if (current === epoch.current) {
          if (result.ok) { setState(result.value); if (!paged.current) setNextBefore(result.value.nextBefore); setError(''); }
          else if (!('cancelled' in result)) setError(message(result));
        }
      }
      // A mutation invalidates the response, not the next scheduled read.
      if (!controller.signal.aborted) timer = setTimeout(() => { void read(); }, 5000);
    }
    void read(); return () => { controller.abort(); clearTimeout(timer); };
  }, [client, revision, active]);
  async function action(operation: () => Promise<ApiClientResult<{ ok: true }>>) { if (lock.current) return false; lock.current = true; ++epoch.current; setBusy(true); setError(''); try { const result = await operation(); if (!result.ok) { setError(message(result)); return false; } setNotice('操作已提交。'); setRevision(n => n + 1); return true; } finally { lock.current = false; setBusy(false); } }
  async function more() { if (!nextBefore || lock.current) return; lock.current = true; setBusy(true); try { const result = await client.state(nextBefore); if (result.ok) { paged.current = true; setOlderRuns(old => [...(state?.runs ?? []), ...old, ...result.value.runs]); setNextBefore(result.value.nextBefore); } else setError(message(result)); } finally { lock.current = false; setBusy(false); } }
  async function showTrace(id: number, trigger?: HTMLButtonElement) { const current = ++traceEpoch.current; if (trigger) traceTrigger.current = trigger; setTraceRequest(current); setSelectedRun(id); setTrace(null); setTraceError(''); const result = await client.trace(id); if (current !== traceEpoch.current) return; if (result.ok) setTrace(result.value); else setTraceError(message(result)); }
  const runs = Array.from(new Map([...olderRuns, ...(state?.runs ?? [])].map(row => [row.id, row])).values()).sort((a, b) => Number(b.id) - Number(a.id));
  return <div className="autoloop-management"><header className="autoloop-section-title"><div><h2>运行总览</h2><p className="autoloop-muted">所有规则、任务和来源的运行记录，每 5 秒更新。</p></div><Button disabled={busy} onClick={() => setRevision(n => n + 1)}>刷新总览</Button></header>{error && <p role="alert" className="autoloop-error">{error}</p>}{notice && <p role="status" className="autoloop-notice">{notice}</p>}
    {!state ? <p className="autoloop-muted">{error ? '暂时无法读取运行状态。' : '正在读取运行状态…'}</p> : <>
      <p className="autoloop-muted">{state.connection.connected ? '自动任务服务已连接' : state.connection.message || '服务未连接'} · {state.timezone}</p>
      <div className="autoloop-metrics">{[['running', '执行中'], ['queued', '排队中'], ['retrying', '重试中'], ['doneToday', '今日完成'], ['attention', '需要处理']].map(([key, label]) => <div key={key}><span>{label}</span><strong>{str(state.totals[key!]) || '0'}</strong></div>)}</div>
      <div className="autoloop-spending">{(['today', 'week'] as const).map(period => { const value = (state.spending[period] ?? {}) as Row; return <div key={period}><h3>{period === 'today' ? '今日用量' : '本周用量'}</h3><p>{str(value.rounds) || '0'} 轮 · {Number(value.rounds) > 0 && Number(value.missingTokens) >= Number(value.rounds) ? 'tokens 未上报' : `${str(value.tokens) || '0'} tokens${Number(value.missingTokens) > 0 ? '（已上报合计）' : ''}`} · {typeof value.cost !== 'number' || (Number(value.rounds) > 0 && Number(value.missingCost) >= Number(value.rounds)) ? '费用未上报' : `$${value.cost.toFixed(4)}${Number(value.missingCost) > 0 ? '（已上报合计）' : ''}`}</p>{(Number(value.missingCost) > 0 || Number(value.missingTokens) > 0) && <p className="autoloop-muted">部分执行器未上报完整用量，合计不代表完整账单。</p>}</div>; })}</div>
      <section className="autoloop-block"><h3>待处理卡片</h3>{state.cards.length === 0 && <p className="autoloop-muted">当前没有待处理事项。</p>}{state.cards.map(card => <GlobalCard key={`${str(card.id)}:${str(card.version)}`} card={card} busy={busy} answer={input => action(() => client.answer(Number(card.id), input))} resolve={reason => action(() => client.resolve(Number(card.id), reason))} />)}</section>
      {selectedRun !== null && <section className="autoloop-block">
        <div className="autoloop-section-title"><PanelHeading request={traceRequest}>运行 #{selectedRun} 追溯</PanelHeading>
          <Button onClick={() => { ++traceEpoch.current; setSelectedRun(null); }}>关闭追溯</Button></div>
        {traceError && <><p role="alert" className="autoloop-error">{traceError}</p>
          <Button onClick={() => { void showTrace(selectedRun); }}>重试读取追溯</Button></>}
        {!trace && !traceError && <p role="status" className="autoloop-muted">读取中…</p>}
        {trace?.timeline.map(item => <div key={item.seq} className="autoloop-trace-item">
          <p className="autoloop-muted">{item.at} · {item.type}</p><pre className="autoloop-readme">{item.text}</pre></div>)}
        {trace && !trace.timeline.length && <p className="autoloop-muted">该运行暂无追溯记录。</p>}
      </section>}
      <section className="autoloop-block"><h3>运行记录</h3>{runs.length === 0 && <p className="autoloop-muted">还没有运行记录。</p>}<div className="autoloop-runs">{runs.map(run => <article className="autoloop-row" key={str(run.id)}><div className="autoloop-row-heading"><h3>#{str(run.id)} · {str(run.rule) || '任务'}</h3><span className="autoloop-muted">{run.stopping ? '正在停止' : ({ queued: '排队中', claimed: '执行中', done: '已完成', failed: '失败', cancelled: '已停止', unknown: '状态未知' } as Record<string, string>)[str(run.state ?? run.status)] || str(run.state ?? run.status)}</span></div><p className="autoloop-plain">{str(run.summary) || str(run.error) || '等待运行结果'}</p><p className="autoloop-muted">{str(run.agent)} · {str(run.createdAt)}</p><Buttons><Button label={`追溯运行 ${str(run.id)}`} onClick={event => { void showTrace(Number(run.id), event.currentTarget); }}>查看追溯</Button>{['queued', 'claimed'].includes(str(run.state ?? run.status)) && <Button label={`停止运行 ${str(run.id)}`} disabled={busy || Boolean(run.stopping)} onClick={() => setConfirmCancel(Number(run.id))}>停止</Button>}</Buttons>{confirmCancel === Number(run.id) && <div className="autoloop-stop"><p>停止此运行？</p><Buttons><Button disabled={busy} onClick={() => { void action(() => client.cancel(Number(run.id))).then(ok => { if (ok) setConfirmCancel(null); }); }}>确认停止运行</Button><Button onClick={() => setConfirmCancel(null)}>继续运行</Button></Buttons></div>}</article>)}</div>{nextBefore !== null && <Button disabled={busy} onClick={() => { void more(); }}>{busy ? '读取中…' : '加载更早记录'}</Button>}</section>

      <details className="autoloop-advanced"><summary>连接状态、事件与已处理卡片</summary>{(['agents', 'sources', 'channels', 'unrouted', 'recentCards', 'elsewhere'] as const).map(key => <section key={key}><h3>{{ agents: '执行器', sources: '事件来源', channels: '通知通道', unrouted: '未匹配规则的事件', recentCards: '最近卡片', elsewhere: '外部定时任务' }[key]}</h3>{state[key].length ? state[key].map((row, index) => <pre key={index} className="autoloop-readme">{JSON.stringify(row, null, 2)}</pre>) : <p className="autoloop-muted">暂无记录</p>}</section>)}</details>
    </>}
  </div>;
}
function GlobalCard({ card, busy, answer, resolve }: { card: Row; busy: boolean; answer: (input: { choice?: number; text?: string }) => Promise<boolean>; resolve: (reason: string) => Promise<boolean> }) {
  const [text, setText] = useState(''); const [reason, setReason] = useState(''); const [sent, setSent] = useState(false); const question = (card.kind === 'ask' || card.kind === 'question') && card.state === 'open';
  const options = Array.isArray(card.options) ? card.options.filter((value): value is string => typeof value === 'string') : [];
  return <article className="autoloop-row"><h3>{str(card.title) || `卡片 #${str(card.id)}`}</h3><p className="autoloop-plain">{str(card.text)}</p><p className="autoloop-muted">{str(card.rule)} · {str(card.state)}</p>{sent ? <p className="autoloop-notice">已处理，等待状态更新。</p> : question ? <><Buttons>{options.map((option, choice) => <Button key={choice} disabled={busy} onClick={() => { void answer({ choice }).then(setSent); }}>{option}</Button>)}</Buttons><form onSubmit={event => { event.preventDefault(); if (text.trim()) void answer({ text: text.trim() }).then(setSent); }}><Field label={`回答卡片 ${str(card.id)}`}><textarea rows={2} maxLength={4000} value={text} onChange={e => setText(e.target.value)} /></Field><Button type="submit" disabled={busy || !text.trim()}>提交回答</Button></form></> : card.state !== 'closed' && card.state !== 'resolved' ? <form onSubmit={event => { event.preventDefault(); if (reason.trim()) void resolve(reason.trim()).then(setSent); }}><Field label={`处理说明 ${str(card.id)}`}><input required value={reason} onChange={e => setReason(e.target.value)} placeholder="写下处理方式或关闭原因" /></Field><Button type="submit" disabled={busy || !reason.trim()}>标记已处理</Button></form> : null}</article>;
}
