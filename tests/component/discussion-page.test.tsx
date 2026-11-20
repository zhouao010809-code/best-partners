import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { DiscussionPage } from '../../src/client/pages/DiscussionPage.js';
import type { DiscussionAction, DiscussionHistoryItem, DiscussionHistoryDetail, DiscussionSession } from '../../src/shared/api/discussion.js';

const path = '01图书馆/01公域资料/课堂观察.md';
const id = '7061f2ea-5451-498b-893f-ab07dbbcf780';
const act = vi.fn<(action: DiscussionAction) => Promise<DiscussionSession>>();
const service = { act, list: vi.fn(async () => []),
  history: vi.fn<() => Promise<DiscussionHistoryItem[]>>(async () => []),
  readHistory: vi.fn<(path: string, signal?: AbortSignal) => Promise<DiscussionHistoryDetail>>() };
const api = { discussion: service, listMaterials: vi.fn(async () => ({ok: true, value: {items: [
  { path, title: '课堂观察', processingStatus: '已归档', knowledgeStatus: '部分探讨完成' }
]}})) };
const runtime = { api, health: { status: 'ready', data: { model: {status: 'configured'} } }, dataRevision: 1, refreshHealth: vi.fn(async () => {}) };
vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => runtime }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('opens a selected source, waits for consent, resumes conversation and confirms progress separately from saving a diary', async () => {
  const initial: DiscussionSession = {id, title: '课堂观察', phase: 'prepared', updatedAt: 'v1', materialPaths: [path], messages: [{role:'assistant',text:'准备好了。'}], proposals: [], knowledgePaths: []};
  const active = { ...initial, phase: 'active' as const, updatedAt: 'v2' };
  const replied: DiscussionSession = { ...active, updatedAt: 'v3', messages: [...active.messages, { role:'user',text:'我会记录动作。' }, { role:'assistant',text:'你观察到了什么？' }] };
  const paused: DiscussionSession = { ...replied, phase: 'paused', updatedAt: 'v4', chatPath: '02日记本/聊天记录.md', proposals:[{path,status:'全面探讨完成',covered:'观察的目标',remaining:'记录方式'}] };
  const confirmed = { ...paused, updatedAt: 'v5', proposals: [] };
  const diary = { ...confirmed, updatedAt: 'v6', diaryPath: '02日记本/今日.md', diaryMarkdown: '今天我记录了学生的动作。', knowledgePaths:['03知识库/课堂观察方法.md'] };
  act.mockResolvedValueOnce(initial).mockResolvedValueOnce(active).mockResolvedValueOnce(replied)
    .mockResolvedValueOnce(paused).mockResolvedValueOnce(confirmed).mockResolvedValueOnce(diary).mockResolvedValueOnce({...diary, phase:'active', updatedAt:'v7'});
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={[`/discussion?${new URLSearchParams({materialPath:path})}`]}><DiscussionPage /></MemoryRouter>);
  expect(await screen.findByRole('checkbox', {name:/课堂观察/})).toBeChecked();
  await user.click(screen.getByRole('button', {name:'准备资料'}));
  expect(act).toHaveBeenLastCalledWith({ type:'start',materialPaths:[path],requestId:expect.any(String) });
  await user.click(await screen.findByRole('button',{name:'开始探讨'}));
  await user.type(await screen.findByLabelText('说说你的想法'),'我会记录动作。');
  await user.click(screen.getByRole('button',{name:'发送'}));
  await user.click(await screen.findByRole('button',{name:'暂停探讨'}));
  await user.selectOptions(await screen.findByLabelText('探讨状态'),'部分探讨完成');
  await user.click(screen.getByRole('button',{name:'确认进度'}));
  expect(act).toHaveBeenLastCalledWith({type:'confirm',id,expectedUpdatedAt:'v4',progress:[{path,status:'部分探讨完成'}]});
  await user.click(screen.getByRole('button',{name:'整理小兆日记'}));
  expect(await screen.findByRole('link',{name:'课堂观察方法'})).toHaveAttribute('href',`/knowledge?${new URLSearchParams({path:diary.knowledgePaths[0]!})}`);
  await user.click(screen.getByRole('button',{name:'继续探讨'}));
  expect(await screen.findByRole('textbox',{name:'说说你的想法'})).toBeVisible();
});

it('reads a historical chat without sending it to the model, then continues only after the explicit action', async () => {
  const record = { path:'02日记本/2026/聊天记录.md', title:'此前的课堂探讨', startedAt:'2026-10-16T16:05:00.000Z', materialPaths: [path] };
  service.history.mockResolvedValueOnce([record]);
  service.readHistory.mockResolvedValueOnce({...record,body:'## 小兆\n\n上次聊到了学生举手。'});
  act.mockResolvedValueOnce({id,title:'接续课堂探讨',phase:'active',updatedAt:'v1',materialPaths:[path],messages:[{role:'assistant',text:'今天继续聊课堂观察。'}],proposals:[],knowledgePaths:[]});
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={['/discussion']}><DiscussionPage /></MemoryRouter>);
  expect(await screen.findByRole('heading',{name:'大脑里的聊天记录'})).toBeVisible();
  await user.click(await screen.findByRole('button',{name:/此前的课堂探讨.*00:05/}));
  expect(await screen.findByText('上次聊到了学生举手。')).toBeVisible();
  expect(service.readHistory).toHaveBeenCalledWith(record.path,expect.any(AbortSignal));
  expect(act).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'接着聊'}));
  expect(act).toHaveBeenLastCalledWith({type:'continueChat',chatPath:record.path,requestId:expect.any(String)});
  expect(await screen.findByRole('textbox',{name:'说说你的想法'})).toBeVisible();
});
