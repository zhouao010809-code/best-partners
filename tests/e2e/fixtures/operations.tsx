import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AppRouter } from '../../../src/client/app/router.js';
import type { ReadConsoleApi } from '../../../src/client/api/client.js';
import type { OperationRecord, OperationQuery } from '../../../src/shared/api/schemas.js';
import '../../../src/client/styles/tokens.css';
import '../../../src/client/styles/global.css';
import '../../../src/client/styles/shell.css';
const scenario = new URLSearchParams(location.search).get('scenario');
let rows: OperationRecord[] = scenario === 'empty' ? [] : [
  { id:'archive:example',sourceId:'example',title:'关于知识复用的笔记',kind:'archive',bucket:'attention',statusLabel:'待核验',summary:'归档尚未完成核验，原文件已保留。',preserved:'原文件与恢复记录已保留。',nextStep:'核验目标文件与索引，确认归档结果。',paths:['01图书馆/来自个人/知识复用'],action:{kind:'resume-archive',label:'继续核验归档'} },
  { id:'ingestion:example',sourceId:'example-batch',title:'内容选题的方法',kind:'ingestion',bucket:'attention',statusLabel:'待确认变化',summary:'写入前检测到内容变化，需要确认。',preserved:'本批候选与写入计划已保留。',nextStep:'在原提炼工作台核对本批文件。',paths:['02知识库/02触达/选题.md'],occurredAt:'2026-09-08T05:18:00.000Z',action:{kind:'navigate',label:'前往核验入库',href:'/extractions/example'} }
];
const counts = () => ({all:rows.length,attention:rows.filter(r=>r.bucket==='attention').length,running:0});
const ok = <T,>(value:T) => ({ok:true as const,value});
const api = {
  getHealth: async () => ok({status:'ready',vaultSource:{status:'ready',adapter:'filesystem',displayName:'视觉验收 · 示例资料'},index:{status:'ready',version:45,refreshedAt:'2026-09-08T00:00:00.000Z'},model:{status:'configured',providerHost:'example.invalid',name:'DeepSeek'},writeGate:{status:'blocked',missing:[],fingerprintMatches:true},schemaIssues:{status:'available',count:0}}),
  listOperations: async (_signal:AbortSignal,query:OperationQuery={}) => ok({items:rows.filter(r=>!query.view||query.view==='all'||r.bucket===query.view),counts:counts(),issues:scenario==='partial'?['归档记录暂不可用']:[]}),
  trash:{list:async()=>ok({items:[]})},intakeTrash:{list:async()=>ok({items:[]})},
  intake:{resume:async(id:string)=>{rows=rows.filter(r=>r.sourceId!==id);return ok({id,state:'archived',indexed:true});}}
} as unknown as ReadConsoleApi;
createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={['/operations']}><AppRouter api={api}/></MemoryRouter>);
