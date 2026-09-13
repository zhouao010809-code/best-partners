// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { OperationsPage } from '../../src/client/pages/OperationsPage.js';
import type { OperationRecord } from '../../src/shared/api/schemas.js';
const { runtime } = vi.hoisted(() => ({ runtime: { api: { listOperations: vi.fn(), intake: { resume: vi.fn() }, ingestion: { resume: vi.fn() } }, dataRevision: 0, refreshHealth: vi.fn(), health: { status: 'ready' } } }));
vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => runtime }));
const entry: OperationRecord = { id:'archive:one',sourceId:'one',title:'知识复用笔记',kind:'archive',bucket:'attention',statusLabel:'待核验',summary:'归档尚未完成核验。',preserved:'原文件已保留。',nextStep:'继续核验目标。',paths:['01图书馆/来自个人/笔记'],action:{kind:'resume-archive',label:'继续核验归档'} };
const page = (items = [entry]) => ({ok:true,value:{items,counts:{all:items.length,attention:items.filter(i => i.bucket === 'attention').length,running:0},issues:[]}});
beforeEach(() => { vi.clearAllMocks(); runtime.api.listOperations.mockResolvedValue(page()); });
afterEach(cleanup);
function mount() { return render(<MemoryRouter><OperationsPage /></MemoryRouter>); }
it('shows a work slip only after a record is selected, and can close it', async () => {
  mount(); await screen.findByText('知识复用笔记'); expect(screen.queryByRole('heading',{name:'恢复工作单'})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:/知识复用笔记/})); expect(screen.getByRole('heading',{name:'恢复工作单'})).toBeInTheDocument();
  expect(screen.getByText('历史记录 · 时间未记录')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'关闭工作单'})); expect(screen.queryByRole('heading',{name:'恢复工作单'})).not.toBeInTheDocument();
});
it('resumes only after explicit click, prevents duplicate submission and refreshes the result', async () => {
  let complete!: (value: unknown) => void; runtime.api.intake.resume.mockImplementation(() => new Promise(resolve => {complete=resolve;}));
  mount(); fireEvent.click(await screen.findByRole('button',{name:/知识复用笔记/})); expect(runtime.api.intake.resume).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'继续核验归档'})); expect(screen.getByRole('button',{name:/核验中/})).toBeDisabled();
  runtime.api.listOperations.mockResolvedValue(page([])); complete({ok:true,value:{id:'one',state:'archived',indexed:true}});
  await screen.findByText('归档核验完成，检索已更新。'); expect(runtime.api.intake.resume).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByText('知识复用笔记')).not.toBeInTheDocument());
});
it('keeps a readable error after resume fails and allows retry', async () => {
  runtime.api.intake.resume.mockResolvedValue({ok:false,state:{status:'conflict',message:'目标文件有变化，请核验。'}});
  mount(); fireEvent.click(await screen.findByRole('button',{name:/知识复用笔记/})); fireEvent.click(screen.getByRole('button',{name:'继续核验归档'}));
  await screen.findByText('目标文件有变化，请核验。'); expect(screen.getByRole('button',{name:'继续核验归档'})).toBeEnabled();
});
it('keeps destructive operations out of this page and reports partial data', async () => {
  const recycled: OperationRecord = {...entry,id:'trash:one',kind:'trash',action:{kind:'navigate',label:'前往回收站',href:'/trash'}};
  runtime.api.listOperations.mockResolvedValue({ok:true,value:{...page([recycled]).value,issues:['归档记录暂不可用']}});
  mount(); fireEvent.click(await screen.findByRole('button',{name:/知识复用笔记/}));
  expect(screen.getByText(/记录未完整读取/)).toBeInTheDocument();
  expect(screen.getAllByRole('link',{name:/前往回收站/})[0]).toHaveAttribute('href','/trash');
  expect(screen.queryByRole('button',{name:/彻底删除|恢复资料/})).not.toBeInTheDocument();
});
it('switches views and appends subsequent pages without auto-opening details', async () => {
  runtime.api.listOperations.mockImplementation(async (_signal, query) => query?.cursor ? page([{...entry,id:'archive:two',title:'另一份资料'}]) : {ok:true,value:{...page().value,nextCursor:'50'}});
  mount(); await screen.findByText('知识复用笔记');
  fireEvent.click(screen.getByRole('button',{name:'加载更多记录'})); await screen.findByText('另一份资料');
  fireEvent.click(screen.getByRole('tab',{name:/全部记录/}));
  await waitFor(() => expect(runtime.api.listOperations).toHaveBeenLastCalledWith(expect.any(AbortSignal),{view:'all'}));
  expect(screen.queryByRole('heading',{name:'恢复工作单'})).not.toBeInTheDocument();
});
