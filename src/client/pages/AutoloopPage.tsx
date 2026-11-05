import { AutoloopManagement, type ManagementSection } from '../components/autoloop/AutoloopManagement.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { ArrowUpRight, Check, CircleDot, Clock3, MessageCircle, RefreshCw, Square, Workflow } from 'lucide-react';
import type { AutoloopChoices, AutoloopAnswerInput, AutoloopCard, AutoloopConnection, AutoloopTask, AutoloopTaskDetail } from '../../shared/api/autoloop.js';
import type { ApiClientResult } from '../api/client.js';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import '../styles/autoloop.css';

const POLL_MS = 4_000;
const FINAL_STATUSES = new Set<AutoloopTask['status']>(['done', 'failed', 'cancelled']);
const STATUS_LABEL: Record<AutoloopTask['status'], string> = {
  dispatching: '正在提交', queued: '排队中', running: '执行中', waiting: '等待你回答',
  done: '已完成', failed: '执行失败', cancelled: '已停止', unknown: '状态待更新'
};

function failureMessage<T>(result: ApiClientResult<T>, fallback: string): string {
  return !result.ok && 'state' in result ? result.state.message ?? fallback : fallback;
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function Status({ status }: { readonly status: AutoloopTask['status'] }) {
  const Icon = status === 'done' ? Check : status === 'waiting' ? MessageCircle : status === 'queued' ? Clock3 : CircleDot;
  return <span className={`autoloop-status autoloop-status--${status}`}><Icon size={13} aria-hidden="true" />{STATUS_LABEL[status]}</span>;
}

function Question({ card, disabled, onAnswer }: {
  readonly card: AutoloopCard;
  readonly disabled: boolean;
  readonly onAnswer: (input: AutoloopAnswerInput) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  async function answer(input: AutoloopAnswerInput) {
    if (disabled || sent) return;
    if (await onAnswer(input)) setSent(true);
  }
  return <section className="autoloop-question" aria-labelledby={`autoloop-question-${card.id}`}>
    <p className="autoloop-overline"><MessageCircle size={14} aria-hidden="true" />需要你回答</p>
    <h3 id={`autoloop-question-${card.id}`}>{card.title || '请补充任务信息'}</h3>
    {card.text && <p className="autoloop-plain">{card.text}</p>}
    {sent ? <p role="status" className="autoloop-sent"><Check size={16} aria-hidden="true" />回答已发送，等待继续执行。</p> : <>
      {card.options.length > 0 && <div className="autoloop-options">{card.options.map((option, choice) =>
        <button className="autoloop-button" key={choice} type="button" disabled={disabled} onClick={() => { void answer({ cardId: card.id, choice }); }}>{option}</button>
      )}</div>}
      <form className="autoloop-answer" onSubmit={(event) => { event.preventDefault(); if (text.trim()) void answer({ cardId: card.id, text: text.trim() }); }}>
        <label htmlFor={`autoloop-answer-${card.id}`}>补充回答</label>
        <textarea id={`autoloop-answer-${card.id}`} rows={3} maxLength={4000} value={text} onChange={event => setText(event.target.value)} disabled={disabled} placeholder="写下你的回答或补充要求" />
        <button className="autoloop-button" disabled={disabled || !text.trim()} type="submit">发送回答</button>
      </form>
    </>}
  </section>;
}

export function AutoloopPage() {
  const [tab, setTab] = useState<'tasks' | ManagementSection>('tasks');
  const [visited, setVisited] = useState<Set<ManagementSection>>(new Set());
  const tabs = [['tasks', '我的任务'], ['rules', '自动规则'], ['connections', '连接与执行'], ['overview', '运行总览'], ['templates', '场景模板']] as const;
  return <div className="autoloop-page"><nav className="autoloop-tabs" role="tablist" aria-label="自动任务导航">{tabs.map(([id, name]) => <button key={id} type="button" role="tab" aria-selected={tab === id} aria-current={tab === id ? 'page' : undefined} onClick={() => { setTab(id); if (id !== 'tasks') setVisited(old => new Set([...old, id])); }}>{name}</button>)}</nav><div hidden={tab !== 'tasks'}><AutoloopTasks active={tab === 'tasks'} /></div>{Array.from(visited).map(section => <div key={section} hidden={tab !== section}><AutoloopManagement section={section} active={tab === section} /></div>)}</div>;
}

function AutoloopTasks({ active }: { active: boolean }) {
  const { api, runtimeMode } = useConsoleRuntime();
  const client = runtimeMode === 'company' ? undefined : api.autoloop;
  const [tasks, setTasks] = useState<AutoloopTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailTitle = useRef<HTMLHeadingElement>(null);
  const [detail, setDetail] = useState<AutoloopTaskDetail | null>(null);
  const [connection, setConnection] = useState<AutoloopConnection | null>(null);
  const [listLoaded, setListLoaded] = useState(false);
  const [readError, setReadError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [createError, setCreateError] = useState('');
  const [choices, setChoices] = useState<AutoloopChoices | null>(null);
  const [choicesError, setChoicesError] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [model, setModel] = useState('');
  const [skillId, setSkillId] = useState('');
  const [notify, setNotify] = useState(true);
  const [actionError, setActionError] = useState<{ taskId: string; message: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<'create' | 'retry' | 'answer' | 'cancel' | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [revision, setRevision] = useState(0);
  const requestId = useRef<string | null>(null);
  const mutationPending = useRef(false);
  const readEpoch = useRef(0);
  const mounted = useRef(false);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!client || !active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      const epoch = readEpoch.current;
      if (!mutationPending.current) {
        const response = await client!.list(controller.signal);
        if (controller.signal.aborted || epoch !== readEpoch.current) return;
        setListLoaded(true);
        if (response.ok) {
          setTasks(response.value.tasks);
          setConnection(response.value.connection);
          setReadError('');
          setSelectedId(current => current ?? response.value.tasks[0]?.id ?? null);
        } else if (!('cancelled' in response)) {
          setReadError(failureMessage(response, '暂时无法读取任务，请重试。'));
          setConnection({ connected: false });
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(() => { void read(); }, POLL_MS);
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [client, revision, active]);

  useEffect(() => {
    setDetailError('');
    setConfirmStop(false);
    if (!client || !selectedId || !active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      const epoch = readEpoch.current;
      if (!mutationPending.current) {
        const response = await client!.get(selectedId!, controller.signal);
        if (controller.signal.aborted || epoch !== readEpoch.current) return;
        if (response.ok) {
          setDetail(response.value);
          setDetailError('');
        } else if (!('cancelled' in response)) {
          setDetailError(failureMessage(response, '暂时无法读取任务详情，请重试。'));
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(() => { void read(); }, POLL_MS);
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [client, selectedId, revision, active]);

  useEffect(() => {
    if (!client?.choices || !active) return;
    const controller = new AbortController();
    void client.choices(controller.signal).then(response => {
      if (controller.signal.aborted) return;
      if (response.ok) { setChoices(response.value); setChoicesError(''); }
      else setChoicesError(failureMessage(response, '暂时无法读取资料和执行配置。'));
    });
    return () => controller.abort();
  }, [client, revision, active]);

  function optionsChanged() { requestId.current = null; setCreateError(''); }

  function beginMutation(kind: 'create' | 'retry' | 'answer' | 'cancel'): boolean {
    if (mutationPending.current) return false;
    mutationPending.current = true;
    readEpoch.current += 1;
    setBusy(kind);
    return true;
  }

  function endMutation() {
    mutationPending.current = false;
    readEpoch.current += 1;
    if (!mounted.current) return;
    setBusy(null);
    setRevision(value => value + 1);
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || !title.trim() || !instructions.trim() || !beginMutation('create')) return;
    requestId.current ??= crypto.randomUUID();
    setCreateError('');
    setNotice('');
    try {
      const response = await client.create({ requestId: requestId.current, title: title.trim(), instructions: instructions.trim(), ...(workspaceId ? { workspaceId } : {}), ...(agentId ? { agentId } : {}), ...(model.trim() ? { model: model.trim() } : {}), ...(skillId ? { skillId } : {}), notify });
      if (!mounted.current) return;
      if (response.ok) {
        setTasks(current => [response.value.task, ...current.filter(task => task.id !== response.value.task.id)]);
        setSelectedId(response.value.task.id);
        setTitle(''); setInstructions(''); requestId.current = null;
        setNotice('任务已提交，可以在这里查看进展。');
      } else {
        setCreateError(`${failureMessage(response, '暂时未能确认提交结果。')} 任务内容已保留，再次提交会核对同一项任务。`);
      }
    } catch {
      setCreateError('无法确认提交结果。任务内容已保留，请再次提交以核对同一项任务。');
    } finally { endMutation(); }
  }

  async function answerTask(input: AutoloopAnswerInput): Promise<boolean> {
    if (!client || !selectedId || !beginMutation('answer')) return false;
    const taskId = selectedId;
    setActionError(null);
    try {
      const response = await client.answer(taskId, input);
      if (!mounted.current) return response.ok;
      if (!response.ok) setActionError({ taskId, message: failureMessage(response, '回答未能发送，请重试。') });
      return response.ok;
    } catch {
      if (mounted.current) setActionError({ taskId, message: '回答未能发送，内容已保留，请重试。' });
      return false;
    } finally { endMutation(); }
  }

  async function retryTask(task: AutoloopTask) {
    if (!client || !beginMutation('retry')) return;
    setActionError(null);
    try {
      const response = await client.create({ requestId: task.id, title: task.title, instructions: task.instructions, ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}), ...(task.agentId ? { agentId: task.agentId } : {}), ...(task.model ? { model: task.model } : {}), ...(task.skillId ? { skillId: task.skillId } : {}), ...(task.notify === undefined ? {} : { notify: task.notify }) });
      if (!mounted.current) return;
      if (!response.ok) setActionError({ taskId: task.id, message: failureMessage(response, '暂时未能确认提交结果，可以再次重试。') });
      else setNotice('已核对原任务，正在更新进展。');
    } catch {
      if (mounted.current) setActionError({ taskId: task.id, message: '暂时未能确认提交结果，可以再次重试。' });
    } finally { endMutation(); }
  }

  function openTask(id: string) {
    flushSync(() => {
      setSelectedId(id);
      setNotice('');
    });
    const heading = detailTitle.current;
    if (!heading) return;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView?.({ block: 'center' });
  }

  async function cancelTask() {
    if (!client || !selectedId || !beginMutation('cancel')) return;
    const taskId = selectedId;
    setActionError(null);
    try {
      const response = await client.cancel(taskId);
      if (!mounted.current) return;
      if (!response.ok) setActionError({ taskId, message: failureMessage(response, '停止请求未能发送，请重试。') });
      else { setConfirmStop(false); setNotice('停止请求已发送。'); }
    } catch {
      if (mounted.current) setActionError({ taskId, message: '停止请求未能发送，请重试。' });
    } finally { endMutation(); }
  }

  const currentDetail = detail?.task.id === selectedId ? detail : null;
  const currentTask = currentDetail?.task ?? tasks.find(task => task.id === selectedId);
  const connected = connection?.connected === true && currentDetail?.connection.connected !== false && !readError && !detailError;
  const pendingCards = currentTask?.cards.filter(card => card.state === 'open' && card.kind === 'ask') ?? [];
  const notices = currentTask?.cards.filter(card => card.state === 'open' && card.kind === 'notice') ?? [];
  const offlineMessage = readError || detailError || (!connection?.connected ? connection?.message : undefined) || (!currentDetail?.connection.connected ? currentDetail?.connection.message : undefined);

  if (!client) return <section className="autoloop-page"><div className="autoloop-empty"><Workflow aria-hidden="true" /><h2>自动任务暂不可用</h2><p>请在个人版中打开已接入自动任务服务的最佳拍档。</p></div></section>;

  return <section className="autoloop-page" aria-label="自动任务工作区">
    <div className="autoloop-service">
      <div className="autoloop-service__state" role="status"><span className={`autoloop-signal${connected ? ' autoloop-signal--online' : ''}`} aria-hidden="true" /><strong>{!listLoaded ? '正在连接自动任务服务' : connected ? '自动任务服务已连接' : '自动任务服务未连接'}</strong></div>
      <span className="autoloop-service__note">关闭最佳拍档后，任务仍会继续。</span>
      <button className="autoloop-icon-button" type="button" aria-label="刷新任务" title="刷新任务" disabled={busy !== null} onClick={() => setRevision(value => value + 1)}><RefreshCw size={16} aria-hidden="true" /></button>
    </div>
    {(offlineMessage || (listLoaded && !connected)) && <p className="autoloop-connection-message" role="status">{offlineMessage || '暂时无法更新进度，任务记录和已填写的内容会保留。'}</p>}
    <div className="autoloop-layout">
      <div className="autoloop-sidebar">
        <form className="autoloop-compose" onSubmit={event => { void createTask(event); }}>
          <div className="autoloop-section-title"><h2>交一个任务</h2><ArrowUpRight size={18} aria-hidden="true" /></div>
          <p className="autoloop-muted">交给本机 Codex 或已连接的 Agent 处理，需要补充信息时会在这里问你。选择资料范围后，Agent 会按对应资料库和项目规则查阅；成果在这里查看。</p>
          <label htmlFor="autoloop-title">任务名称</label>
          <input id="autoloop-title" value={title} maxLength={200} placeholder="给这次任务起个名字" disabled={busy === 'create'} onChange={event => { setTitle(event.target.value); requestId.current = null; setCreateError(''); }} />
          <label htmlFor="autoloop-instructions">任务要求</label>
          <textarea id="autoloop-instructions" value={instructions} rows={5} maxLength={20000} placeholder="说明要做什么、需要哪些资料，以及希望怎样交付。" disabled={busy === 'create'} onChange={event => { setInstructions(event.target.value); requestId.current = null; setCreateError(''); }} />
          <details className="autoloop-task-options" open>
            <summary>资料与执行方式</summary>
            {choicesError && <p className="autoloop-error">{choicesError}</p>}
            <label htmlFor="autoloop-workspace">资料范围</label>
            <select id="autoloop-workspace" value={workspaceId} disabled={busy === 'create'} onChange={event => { setWorkspaceId(event.target.value); optionsChanged(); }}><option value="">独立任务（使用提供的材料）</option>{choices?.workspaces.filter(item => item.kind !== 'isolated').map(item => <option value={item.id} disabled={!item.available} key={item.id}>{item.name}{!item.available ? ' · 暂不可用' : ''}</option>)}</select>
            <label htmlFor="autoloop-agent">执行 Agent</label>
            <select id="autoloop-agent" value={agentId} disabled={busy === 'create'} onChange={event => { setAgentId(event.target.value); optionsChanged(); }}><option value="">默认 Codex</option>{choices?.agents.map(item => <option value={item.id} disabled={!item.available} key={item.id}>{item.name}{!item.available ? ' · 暂不可用' : ''}</option>)}</select>
            <label htmlFor="autoloop-model">模型（可选）</label><input id="autoloop-model" value={model} maxLength={200} disabled={busy === 'create'} placeholder="留空使用 Agent 默认模型" onChange={event => { setModel(event.target.value); optionsChanged(); }} />
            <label htmlFor="autoloop-skill">使用 Skill</label><select id="autoloop-skill" value={skillId} disabled={busy === 'create'} onChange={event => { setSkillId(event.target.value); optionsChanged(); }}><option value="">按任务要求处理</option>{choices?.skills.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select>
            <label className="autoloop-check"><input type="checkbox" checked={notify} onChange={event => { setNotify(event.target.checked); optionsChanged(); }} disabled={busy === 'create'} />完成或需要回答时通知我</label>
            {notify && choices && !choices.notificationsAvailable && <p className="autoloop-muted">通知通道尚未连接，可在“连接与执行”中配置。</p>}
          </details>
          {createError && <p className="autoloop-error" role="alert">{createError}</p>}
          <button className="autoloop-button autoloop-button--primary" type="submit" disabled={busy !== null || !title.trim() || !instructions.trim()}>{busy === 'create' ? '提交中…' : '提交任务'}<ArrowUpRight size={15} aria-hidden="true" /></button>
          {notice && <p className="autoloop-notice" role="status">{notice}</p>}
        </form>

        <section className="autoloop-list" aria-labelledby="autoloop-list-title">
          <div className="autoloop-section-title"><h2 id="autoloop-list-title">我的任务</h2><span className="autoloop-count">{tasks.length}</span></div>
          {!listLoaded ? <p className="autoloop-muted" role="status">正在读取任务…</p> : tasks.length === 0 ? <p className="autoloop-muted">提交的任务会保存在这里。</p> : <ul>{tasks.map(task => <li key={task.id}>
            <button className={`autoloop-task${task.id === selectedId ? ' autoloop-task--selected' : ''}`} type="button" aria-pressed={task.id === selectedId} onClick={() => openTask(task.id)}>
              <strong>{task.title}</strong><Status status={task.status} /><time dateTime={task.createdAt}>{dateLabel(task.createdAt)}</time>
            </button>
          </li>)}</ul>}
        </section>
      </div>

      <div className="autoloop-workspace">
        {!currentTask ? <div className="autoloop-empty"><Workflow size={30} aria-hidden="true" /><h2>{listLoaded ? '还没有自动任务' : '正在读取任务'}</h2><p>写清任务要求，交给 Codex。<br />进展、需要你的回答和最终结果都会出现在这里。</p><ol className="autoloop-steps"><li><span>1</span>交任务</li><li><span>2</span>看进度</li><li><span>3</span>回答问题</li><li><span>4</span>收结果</li></ol></div> : <>
          <header className="autoloop-detail-heading"><div><Status status={currentTask.status} /><h2 tabIndex={-1} ref={detailTitle}>{currentTask.title}</h2><p className="autoloop-muted">创建于 {dateLabel(currentTask.createdAt)}</p></div>
            {!FINAL_STATUSES.has(currentTask.status) && <button className="autoloop-button autoloop-button--quiet" type="button" disabled={busy !== null} onClick={() => setConfirmStop(true)}><Square size={13} aria-hidden="true" />停止任务</button>}
          </header>
          {confirmStop && <div className="autoloop-stop"><p>停止这个任务？已经生成的内容会保留。</p><div><button className="autoloop-button autoloop-button--danger" type="button" disabled={busy !== null} onClick={() => { void cancelTask(); }}>{busy === 'cancel' ? '正在停止…' : '确认停止'}</button><button className="autoloop-button" type="button" disabled={busy !== null} onClick={() => setConfirmStop(false)}>继续运行</button></div></div>}
          {actionError?.taskId === selectedId && <p className="autoloop-error" role="alert">{actionError.message}</p>}
          {currentTask.status === 'dispatching' && <div className="autoloop-retry"><p>提交结果尚未确认。重试会核对同一个任务。</p><button className="autoloop-button" disabled={busy !== null} type="button" onClick={() => { void retryTask(currentTask); }}>{busy === 'retry' ? '正在核对…' : '重试提交'}</button></div>}
          <details className="autoloop-requirements"><summary>查看任务要求</summary><p className="autoloop-plain">{currentTask.instructions}</p></details>
          {!currentDetail && !detailError && <p className="autoloop-muted" role="status">正在读取任务详情…</p>}
          {pendingCards.map(card => <Question key={`${currentTask.id}:${card.id}`} card={card} disabled={busy !== null} onAnswer={answerTask} />)}
          {notices.map(card => <section className="autoloop-update" key={`${currentTask.id}:${card.id}`}><h3>{card.title || '任务消息'}</h3><p className="autoloop-plain">{card.text}</p></section>)}
          {currentTask.summary && <p className="autoloop-progress">{currentTask.summary}</p>}
          <section className="autoloop-result" aria-labelledby="autoloop-result-title"><h3 id="autoloop-result-title">任务结果</h3>{currentDetail?.result ? <pre>{currentDetail.result}</pre> : <p className="autoloop-muted">{currentTask.status === 'waiting' ? '回答上面的问题后，任务会继续。' : currentTask.status === 'cancelled' ? '任务已停止，暂时没有结果。' : currentTask.status === 'failed' ? '本次任务未完成，可查看下方经过。' : currentTask.status === 'done' ? '任务已完成，没有返回文字结果。' : '完成后，结果会显示在这里。'}</p>}</section>
          {currentDetail && currentDetail.timeline.length > 0 && <section className="autoloop-timeline"><h3>任务经过</h3><ol>{currentDetail.timeline.map(item => <li key={item.id}><time dateTime={item.at}>{dateLabel(item.at)}</time><p>{item.text}</p></li>)}</ol></section>}
        </>}
      </div>
    </div>
  </section>;
}
