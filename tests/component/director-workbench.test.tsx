// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReadConsoleApi } from '../../src/client/api/client.js';
import { ProjectWorkbench } from '../../src/client/components/projects/ProjectWorkbench.js';

const ok = <T,>(value:T) => ({ok:true as const,value});
const item = {id:'11111111-1111-4111-8111-111111111111',projectId:'22222222-2222-4222-8222-222222222222',kind:'script' as const,title:'家长常见问题',brief:'60秒口播',body:'原来的开头。\n\n正文保持不变。',audience:'',angle:'',rationale:'',sources:[],revision:0,createdAt:'2026-09-26T00:00:00.000Z',updatedAt:'2026-09-26T00:00:00.000Z'};
function setup() {
  let saved = {...item};
  const detail = () => ({item:{...saved},versions:[],messages:[]});
  const creations = {
    list:vi.fn(async()=>ok({items:[{...saved}]})), get:vi.fn(async()=>ok(detail())),
    create:vi.fn(async(_p:string,input:Record<string,unknown>)=>ok({item:{...item,...input},versions:[],messages:[]})),
    save:vi.fn(async(_p:string,_id:string,input:Record<string,unknown>)=>{saved={...saved,...input,revision:saved.revision+1};return ok(detail());}),
    snapshot:vi.fn(),exportVersion:vi.fn(),suggest:vi.fn()
  };
  const api = {creations,assistant:{providers:vi.fn(async()=>ok({providers:[]}))}} as unknown as ReadConsoleApi;
  render(<MemoryRouter><ProjectWorkbench api={api} projectId={item.projectId} files={<p>文件目录</p>} /></MemoryRouter>);
  return creations;
}
afterEach(()=>{cleanup();localStorage.clear();});
it('opens a script as the main editable work surface and saves local edits',async()=>{
 const user=userEvent.setup();const api=setup();
 await user.click(await screen.findByRole('button',{name:/家长常见问题/}));
 const editor=await screen.findByRole('textbox',{name:'脚本正文'});
 await user.clear(editor);await user.type(editor,'用户亲自写的新稿');
 await waitFor(()=>expect(api.save).toHaveBeenCalled());
 expect(await screen.findByText('已保存到本机')).toBeVisible();
 expect(editor).toHaveValue('用户亲自写的新稿');
});
it('keeps the files view one tab away while defaulting to creation',async()=>{
 const user=userEvent.setup();setup();
 expect(await screen.findByRole('button',{name:'新建脚本'})).toBeVisible();
 expect(screen.queryByText('文件目录')).not.toBeInTheDocument();
 await user.click(screen.getByRole('tab',{name:'项目资料'}));
 expect(screen.getByText('文件目录')).toBeVisible();
});
it('shows a local save failure without discarding the edited manuscript',async()=>{
 const user=userEvent.setup();const api=setup();
 api.save.mockResolvedValue({ok:false,state:{status:'operation-error',message:'连接暂时中断'}} as never);
 await user.click(await screen.findByRole('button',{name:/家长常见问题/}));
 const editor=await screen.findByRole('textbox',{name:'脚本正文'});
 await user.type(editor,' 新增句子');
 expect(await screen.findByText(/连接暂时中断/)).toBeVisible();
 expect(editor).toHaveValue(`${item.body} 新增句子`);
 expect(screen.getByRole('button',{name:'重试保存'})).toBeVisible();
});
