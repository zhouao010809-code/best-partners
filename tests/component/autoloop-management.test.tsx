import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AutoloopManagement } from '../../src/client/components/autoloop/AutoloopManagement.js';
const { management } = vi.hoisted(() => ({ management: { configuration: vi.fn(), saveConfiguration: vi.fn(), state: vi.fn(), trace: vi.fn(), answer: vi.fn(), resolve: vi.fn(), cancel: vi.fn(), emit: vi.fn(), trigger: vi.fn(), templates: vi.fn(), template: vi.fn(), prepareTemplate: vi.fn() } }));
vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => ({ api: { autoloopManagement: management }, runtimeMode: 'personal' }) }));
const success = <T,>(value: T) => ({ ok: true as const, value });
const rule = { name: '每日整理', when: { cron: '0 9 * * *' }, to: 'codex', cwd: '/tmp/work', prompt: '整理资料', tell: 'never' };
const configuration = () => ({ revision: 'r1', document: { sources: { local: { name: '本机' } }, agents: { codex: { name: 'Codex', worker: 'local', use: 'codex' } }, rules: [rule] }, disabledRules: [], localWorker: 'local' });
beforeEach(() => {
  vi.resetAllMocks();
  management.configuration.mockResolvedValue(success(configuration()));
  management.saveConfiguration.mockResolvedValue(success({ revision: 'r2', loaded: true, message: '已载入' }));
  management.templates.mockResolvedValue(success({ templates: [] }));
  management.state.mockResolvedValue(success({ connection: { connected: true }, now: '', timezone: 'Asia/Shanghai', totals: {}, spending: {}, cards: [], recentCards: [], agents: [], channels: [], sources: [], lines: [], elsewhere: [], runs: [], nextBefore: null, unrouted: [] }));
});
afterEach(cleanup);
it('pauses a native rule using its revision and retains every rule field', async () => {
  render(<AutoloopManagement section="rules" />);
  fireEvent.click(await screen.findByRole('button', { name: '暂停 每日整理' }));
  await waitFor(() => expect(management.saveConfiguration).toHaveBeenCalledExactlyOnceWith({ revision: 'r1', document: { ...configuration().document, rules: [] }, disabledRules: [rule] }));
  expect(await screen.findByRole('button', { name: '启用 每日整理' })).toBeInTheDocument();
});
it('keeps the cron draft on a failed save and submits the native rule shape', async () => {
  management.saveConfiguration.mockResolvedValue({ ok: false, state: { status: 'conflict', message: '配置已更新，请重新读取后再保存。' } });
  render(<AutoloopManagement section="rules" />);
  fireEvent.click(await screen.findByRole('button', { name: '新建规则' }));
  fireEvent.change(screen.getByLabelText('规则名称'), { target: { value: '每日汇总' } });
  fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/tmp/daily' } });
  fireEvent.change(screen.getByLabelText('规则任务要求'), { target: { value: '生成汇总' } });
  fireEvent.click(screen.getByRole('button', { name: '保存规则' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('配置已更新');
  expect(screen.getByLabelText('规则任务要求')).toHaveValue('生成汇总');
  expect(management.saveConfiguration.mock.calls[0]?.[0].document.rules[1]).toMatchObject({ name: '每日汇总', when: { cron: '0 9 * * *' }, to: 'codex', cwd: '/tmp/daily', prompt: '生成汇总' });
});
it('submits zero-based global answers only on click and loads the selected trace', async () => {
  const base = (await management.state()).value;
  management.state.mockResolvedValue(success({ ...base, cards: [{ id: 4, kind: 'question', state: 'open', title: '选择范围', options: ['本周', '本月'] }], runs: [{ id: 7, rule: '每日整理', status: 'done' }] }));
  management.answer.mockResolvedValue(success({ ok: true }));
  management.trace.mockResolvedValue(success({ runId: 7, timeline: [{ seq: 1, at: '', type: 'result', text: '<script>never execute</script>' }] }));
  render(<AutoloopManagement section="overview" />);
  expect(await screen.findByText('选择范围')).toBeInTheDocument();
  expect(management.answer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '本周' }));
  await waitFor(() => expect(management.answer).toHaveBeenCalledExactlyOnceWith(4, { choice: 0 }));
  fireEvent.click(screen.getByRole('button', { name: '追溯运行 7' }));
  expect(await screen.findByText('<script>never execute</script>')).toBeInTheDocument();
  expect(document.querySelector('script')).toBeNull();
});
it('opens a template as a draft without enabling it', async () => {
  management.templates.mockResolvedValue(success({ templates: [{ id: 'daily', name: '资料简报', description: '定时整理资料' }] }));
  management.template.mockResolvedValue(success({ id: 'daily', name: '资料简报', description: '', readme: '示例说明', rules: configuration().document }));
  render(<AutoloopManagement section="templates" />);
  fireEvent.click(await screen.findByRole('button', { name: '查看 资料简报' }));
  expect(await screen.findByText('示例说明')).toBeInTheDocument();
  expect(management.saveConfiguration).not.toHaveBeenCalled();
  expect(screen.getByLabelText('模板配置')).toBeInTheDocument();
});
it('supports native ask cards and claimed runs and never claims unreported usage is zero', async () => {
  const base = (await management.state()).value;
  management.state.mockResolvedValue(success({ ...base, spending: { today: { rounds: 2, tokens: 0, cost: 0, missingTokens: 2, missingCost: 2 } }, cards: [{ id: 8, kind: 'ask', state: 'open', title: '需要批准', options: ['继续'] }], runs: [{ id: 12, rule: '工作', state: 'claimed' }, { id: 13, rule: '未知', state: 'unknown' }] }));
  render(<AutoloopManagement section="overview" />);
  expect(await screen.findByRole('button', { name: '继续' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '停止运行 12' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '停止运行 13' })).not.toBeInTheDocument();
  expect(screen.getByText(/tokens 未上报/)).toBeInTheDocument();
});
it('reuses immediate-trigger identity after a transport failure', async () => {
  management.trigger.mockResolvedValueOnce({ ok: false, state: { status: 'disconnected', message: '中断' } }).mockResolvedValueOnce(success({ event: 5, duplicate: true, routed: ['每日整理'] }));
  render(<AutoloopManagement section="rules" />);
  fireEvent.click(await screen.findByRole('button', { name: '立即触发 每日整理' }));
  expect(await screen.findByText('中断')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '立即触发 每日整理' }));
  await waitFor(() => expect(management.trigger).toHaveBeenCalledTimes(2));
  expect(management.trigger.mock.calls[1]).toEqual(management.trigger.mock.calls[0]);
  expect(management.trigger.mock.calls[0]?.[1]).toMatch(/^[0-9a-f-]{36}$/u);
});
it('imports template rules paused and retains their askFirst requirements', async () => {
  const native = { ...configuration().document, askFirst: ['publish'], rules: [{ ...rule, name: '模板规则' }] };
  management.templates.mockResolvedValue(success({ templates: [{ id: 'daily', name: '资料简报', description: '' }] }));
  management.template.mockResolvedValue(success({ id: 'daily', name: '资料简报', description: '', readme: '说明', rules: native }));
  management.prepareTemplate.mockResolvedValue(success({ id: 'daily', name: '资料简报', description: '', readme: '说明', rules: native }));
  render(<AutoloopManagement section="templates" />);
  fireEvent.click(await screen.findByRole('button', { name: '查看 资料简报' }));
  fireEvent.click(await screen.findByRole('button', { name: '准备场景文件' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '导入为暂停规则' })).toBeEnabled());
  expect(management.saveConfiguration).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '导入为暂停规则' }));
  await waitFor(() => expect(management.saveConfiguration).toHaveBeenCalled());
  expect(management.saveConfiguration.mock.calls[0]?.[0]).toMatchObject({ document: { rules: [rule], askFirst: ['publish'] }, disabledRules: [{ ...rule, name: '模板规则' }] });
});
it('requires a concrete delivery repository and edits its native command through the form', async () => {
  const native = { sources: {}, agents: { delivery: { name: '交付', worker: 'local', use: 'delivery', command: ['REPLACE_OWNER/REPLACE_REPOSITORY'] }, poll: { name: '轮询', worker: 'local', use: 'command', command: ['node', '/app/poll.ts', 'REPLACE_OWNER/REPLACE_REPOSITORY'] } }, rules: [{ ...rule, name: '交付规则', to: 'delivery' }] };
  const template = { id: 'delivery', name: 'GitHub 交付', description: '', readme: '说明', rules: native };
  management.templates.mockResolvedValue(success({ templates: [template] })); management.template.mockResolvedValue(success(template)); management.prepareTemplate.mockResolvedValue(success(template));
  render(<AutoloopManagement section="templates" />);
  fireEvent.click(await screen.findByRole('button', { name: '查看 GitHub 交付' }));
  fireEvent.click(await screen.findByRole('button', { name: '准备场景文件' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '导入为暂停规则' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '导入为暂停规则' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('目标仓库');
  expect(management.saveConfiguration).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('GitHub 仓库（owner/repo）'), { target: { value: 'my-team/my-repo' } });
  fireEvent.click(screen.getByRole('button', { name: '导入为暂停规则' }));
  await waitFor(() => expect(management.saveConfiguration).toHaveBeenCalled());
  expect(management.saveConfiguration.mock.calls[0]?.[0].document.agents.delivery.command).toEqual(['my-team/my-repo']);
  expect(management.saveConfiguration.mock.calls[0]?.[0].document.agents.poll.command).toEqual(['node', '/app/poll.ts', 'my-team/my-repo']);
});
it('refreshes the configuration revision after triggering creates a hidden companion rule', async () => {
  management.configuration.mockResolvedValueOnce(success(configuration())).mockResolvedValue(success({ ...configuration(), revision: 'after-trigger' }));
  management.trigger.mockResolvedValue(success({ event: 6, duplicate: false, routed: ['每日整理'] }));
  render(<AutoloopManagement section="rules" />);
  fireEvent.click(await screen.findByRole('button', { name: '立即触发 每日整理' }));
  await waitFor(() => expect(management.configuration).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole('button', { name: '暂停 每日整理' }));
  await waitFor(() => expect(management.saveConfiguration).toHaveBeenCalled());
  expect(management.saveConfiguration.mock.calls[0]?.[0].revision).toBe('after-trigger');
});
it('keeps refreshed active runs newer than a previously loaded history page', async () => {
  const base = (await management.state()).value;
  const old = { id: 5, rule: '每日整理', state: 'claimed', summary: '还在运行' };
  management.state.mockReset();
  management.state.mockResolvedValueOnce(success({ ...base, runs: [old], nextBefore: 10 }));
  management.state.mockResolvedValueOnce(success({ ...base, runs: [old], nextBefore: null }));
  management.state.mockResolvedValue(success({ ...base, runs: [{ ...old, state: 'done', summary: '最新已完成' }], nextBefore: null }));
  render(<AutoloopManagement section="overview" />);
  fireEvent.click(await screen.findByRole('button', { name: '加载更早记录' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '加载更早记录' })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: '刷新总览' }));
  expect(await screen.findByText('最新已完成')).toBeInTheDocument();
  expect(screen.queryByText('还在运行')).not.toBeInTheDocument();
});

it('opens each of eight templates in its own view and returns focus to the card', async () => {
  const templates = Array.from({ length: 8 }, (_, index) => ({ id: `recipe-${index}`, name: `场景 ${index}`, description: `说明 ${index}` }));
  management.templates.mockResolvedValue(success({ templates }));
  management.template.mockImplementation(async (id: string) => {
    const template = templates.find(item => item.id === id)!;
    return success({ ...template, readme: `使用步骤 ${id}`, rules: null });
  });
  render(<AutoloopManagement section="templates" />);
  const cards = await screen.findAllByRole('button', { name: /^查看 场景/u });
  for (const [index, card] of cards.entries()) {
    const listViewport = card.closest('.autoloop-management')!;
    const listPosition = index % 2 ? 280 : 0;
    listViewport.scrollTop = listPosition;
    fireEvent.click(index % 2 ? within(card).getByText(`场景 ${index}`) : within(card).getByText('查看与配置 →'));
    expect(screen.queryAllByRole('button', { name: /^查看 场景/u })).toHaveLength(0);
    expect(screen.getByRole('heading', { name: `场景 ${index}` })).toHaveFocus();
    expect(await screen.findByText(`使用步骤 recipe-${index}`)).toBeVisible();
    listViewport.scrollTop = 600;
    fireEvent.click(screen.getByRole('button', { name: '返回模板列表' }));
    expect(card).toHaveFocus();
    expect(listViewport.scrollTop).toBe(listPosition);
  }
  expect(management.templates).toHaveBeenCalledTimes(1);
  expect(management.prepareTemplate).not.toHaveBeenCalled();
  expect(management.saveConfiguration).not.toHaveBeenCalled();
});

it('shows the chosen template while loading, retries detail errors and ignores stale responses after going back', async () => {
  const first = { id: 'first', name: '第一个场景', description: '' };
  const second = { id: 'second', name: '第二个场景', description: '' };
  management.templates.mockResolvedValue(success({ templates: [first, second] }));
  let finishFirst!: (value: unknown) => void;
  management.template.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
    .mockResolvedValueOnce({ ok: false, state: { message: '读取失败，请重试。' } })
    .mockResolvedValueOnce(success({ ...second, readme: '第二个场景的正文', rules: null }));
  render(<AutoloopManagement section="templates" />);
  fireEvent.click(await screen.findByRole('button', { name: '查看 第一个场景' }));
  expect(screen.getByRole('heading', { name: first.name })).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('正在读取场景详情');
  fireEvent.click(screen.getByRole('button', { name: '返回模板列表' }));
  expect(management.template.mock.calls[0]?.[1]?.aborted).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '查看 第二个场景' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('读取失败');
  fireEvent.click(screen.getByRole('button', { name: '重试读取详情' }));
  expect(await screen.findByText('第二个场景的正文')).toBeVisible();
  await act(async () => { finishFirst(success({ ...first, readme: '过时的正文', rules: null })); });
  expect(screen.queryByText('过时的正文')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: second.name })).toBeVisible();
});

it('focuses each opened editor and displays a failed save inside that editor', async () => {
  management.saveConfiguration.mockResolvedValue({ ok: false, state: { message: '保存失败，草稿仍可修改。' } });
  const rulePage = render(<AutoloopManagement section="rules" />);
  fireEvent.click(await screen.findByRole('button', { name: '编辑 每日整理' }));
  const ruleHeading = screen.getByRole('heading', { name: '编辑规则' });
  expect(ruleHeading).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: '保存规则' }));
  expect(await within(ruleHeading.closest('form')!).findByRole('alert')).toHaveTextContent('保存失败');
  rulePage.unmount();
  render(<AutoloopManagement section="connections" />);
  for (const [button, heading, submit] of [['编辑 Agent codex', '编辑 Agent', '保存 Agent'], ['编辑来源 local', '编辑来源', '保存来源']] as const) {
    fireEvent.click(await screen.findByRole('button', { name: button }));
    const title = screen.getByRole('heading', { name: heading });
    expect(title).toHaveFocus();
    const editor = within(title.closest('form')!);
    fireEvent.click(editor.getByRole('button', { name: submit }));
    expect(await editor.findByRole('alert')).toHaveTextContent('保存失败');
    fireEvent.click(editor.getByRole('button', { name: '关闭编辑' }));
  }
});

it('focuses the requested trace immediately and keeps loading, error and retry in that panel', async () => {
  const base = (await management.state()).value;
  management.state.mockResolvedValue(success({ ...base, runs: Array.from({ length: 35 }, (_, index) => ({ id: index + 1, state: 'done', rule: `规则 ${index}` })) }));
  let fail!: (result: unknown) => void;
  management.trace.mockImplementationOnce(() => new Promise(resolve => { fail = resolve; }))
    .mockResolvedValueOnce(success({ runId: 4, timeline: [{ seq: 1, at: '', type: 'result', text: '追溯成功' }] }));
  render(<AutoloopManagement section="overview" />);
  const trigger = await screen.findByRole('button', { name: '追溯运行 4' });
  fireEvent.click(trigger);
  const heading = screen.getByRole('heading', { name: '运行 #4 追溯' });
  expect(heading).toHaveFocus();
  const panel = within(heading.closest('section')!);
  expect(panel.getByRole('status')).toHaveTextContent('读取中');
  await act(async () => { fail({ ok: false, state: { message: '暂时无法读取追溯。' } }); });
  expect(panel.getByRole('alert')).toHaveTextContent('暂时无法读取追溯');
  fireEvent.click(panel.getByRole('button', { name: '重试读取追溯' }));
  expect(await panel.findByText('追溯成功')).toBeVisible();
  fireEvent.click(panel.getByRole('button', { name: '关闭追溯' }));
  expect(trigger).toHaveFocus();
});


it('continues overview polling after an action fails while a read is in flight', async () => {
  vi.useFakeTimers();
  try {
    const base = (await management.state()).value;
    const state = { ...base, cards: [{ id: 4, kind: 'ask', state: 'open', title: '继续任务？', options: ['继续'] }] };
    let finishRead!: (value: unknown) => void;
    let finishAnswer!: (value: unknown) => void;
    management.state.mockReset();
    management.state.mockResolvedValueOnce(success(state))
      .mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }))
      .mockResolvedValue(success({ ...state, cards: [] }));
    management.answer.mockImplementation(() => new Promise(resolve => { finishAnswer = resolve; }));
    await act(async () => { render(<AutoloopManagement section="overview" />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(management.state).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await act(async () => { finishRead(success({ ...state, cards: [] })); });
    expect(screen.getByText('继续任务？')).toBeVisible();
    await act(async () => { finishAnswer({ ok: false, state: { message: '连接失败' } }); });
    expect(screen.getByRole('alert')).toHaveTextContent('连接失败');
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(management.state).toHaveBeenCalledTimes(3);
    expect(screen.queryByText('继续任务？')).not.toBeInTheDocument();
  } finally { cleanup(); vi.useRealTimers(); }
});

it('waits for refreshed configuration before saving an existing editor', async () => {
  let finishRead!: (value: unknown) => void;
  management.configuration.mockResolvedValueOnce(success(configuration()))
    .mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
  render(<AutoloopManagement section="connections" />);
  fireEvent.click(await screen.findByRole('button', { name: '编辑 Agent codex' }));
  const editor = screen.getByRole('heading', { name: '编辑 Agent' }).closest('form')!;
  fireEvent.click(screen.getByRole('button', { name: '重新读取配置' }));
  expect(within(editor).getByRole('button', { name: '保存中…' })).toBeDisabled();
  // A submit event must also respect the pending read, independent of button state.
  fireEvent.submit(editor);
  expect(management.saveConfiguration).not.toHaveBeenCalled();
  await act(async () => { finishRead(success({ ...configuration(), revision: 'refreshed' })); });
  expect(screen.getByRole('button', { name: '重新读取配置' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '保存 Agent' }));
  await waitFor(() => expect(management.saveConfiguration).toHaveBeenCalledTimes(1));
  expect(management.saveConfiguration.mock.calls[0]?.[0].revision).toBe('refreshed');
});

it('rejects normalized duplicate and blank source identifiers without overwriting a source', async () => {
  render(<AutoloopManagement section="connections" />);
  fireEvent.click(await screen.findByRole('button', { name: '新增来源' }));
  fireEvent.change(screen.getByLabelText('来源名称'), { target: { value: '覆盖本机' } });
  fireEvent.change(screen.getByLabelText('来源标识'), { target: { value: ' local ' } });
  fireEvent.click(screen.getByRole('button', { name: '保存来源' }));
  expect(screen.getByRole('alert')).toHaveTextContent('来源标识已存在');
  expect(management.saveConfiguration).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('来源标识'), { target: { value: '   ' } });
  fireEvent.click(screen.getByRole('button', { name: '保存来源' }));
  expect(screen.getByRole('alert')).toHaveTextContent('请填写来源标识');
  expect(management.saveConfiguration).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('来源标识'), { target: { value: ' new-source ' } });
  fireEvent.click(screen.getByRole('button', { name: '保存来源' }));
  await waitFor(() => expect(management.saveConfiguration).toHaveBeenCalledTimes(1));
  expect(management.saveConfiguration.mock.calls[0]?.[0].document.sources).toEqual({ local: { name: '本机' }, 'new-source': { name: '覆盖本机' } });
});
