import { afterEach, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/server/app.js';
import type { TrashEntry, TrashPreview } from '../../src/shared/api/trash.js';

const headers={host:'127.0.0.1:4317',origin:'http://127.0.0.1:4317'};
const id='12345678-1234-4123-8123-123456789abc';
const entry:TrashEntry={id,materialPath:'01图书馆/来自个人/原文.md',title:'原文',createdAt:'2026-09-07T00:00:00.000Z',status:'trashed',indexed:true};
const preview:TrashPreview={id,materialPath:entry.materialPath,title:entry.title,bytes:15,referencedKnowledge:[],expiresAt:'2026-09-07T00:10:00.000Z'};
const servers:ReturnType<typeof buildServer>[]=[];afterEach(async()=>{for(const app of servers.splice(0))await app.close();});
function fixture(){const service={list:vi.fn(()=>({items:[entry]})),get:vi.fn(()=>entry),preview:vi.fn(async()=>preview),previewDelete:vi.fn(async()=>({...preview,token:id})),delete:vi.fn(async()=>({...entry,status:'deleted' as const,deletedAt:entry.createdAt})),commit:vi.fn(async()=>entry),restore:vi.fn(async()=>({...entry,status:'restored' as const})),retry:vi.fn(async()=>entry),recover:vi.fn(async()=>{}),close:vi.fn(async()=>{})};const app=buildServer({trashService:service});servers.push(app);return {app,service};}
async function auth(app:ReturnType<typeof buildServer>){const result=await app.inject({url:'/api/v1/bootstrap',headers});return {...headers,cookie:String(result.headers['set-cookie']).split(';')[0]!,'x-csrf-token':result.json().data.csrfToken as string};}

it('serves recycle records without executing a move, restore or recovery',async()=>{const f=fixture();
  for(const url of ['/api/v1/trash',`/api/v1/trash/${id}`]){const result=await f.app.inject({url,headers});expect(result.statusCode).toBe(200);expect(result.headers['cache-control']).toBe('no-store');}
  expect(f.service.commit).not.toHaveBeenCalled();expect(f.service.restore).not.toHaveBeenCalled();expect(f.service.recover).not.toHaveBeenCalled();
});

it.each([{path:'preview',body:{materialPath:entry.materialPath},method:'preview'},{path:'commit',body:{id},method:'commit'},{path:`${id}/restore`,body:{},method:'restore'},{path:`${id}/retry`,body:{},method:'retry'},{path:`${id}/delete-preview`,body:{},method:'previewDelete'},{path:`${id}/delete`,body:{token:id},method:'delete'}] as const)('validates and CSRF-protects $method',async({path,body,method})=>{const f=fixture();const url=`/api/v1/trash/${path}`;
  expect((await f.app.inject({method:'POST',url,headers,payload:body})).statusCode).toBe(401);
  const allowed=await auth(f.app);const {'x-csrf-token':_token,...noToken}=allowed;
  expect((await f.app.inject({method:'POST',url,headers:noToken,payload:body})).statusCode).toBe(403);
  expect((await f.app.inject({method:'POST',url,headers:{...allowed,origin:'https://evil.example'},payload:body})).statusCode).toBe(403);
  expect((await f.app.inject({method:'POST',url,headers:allowed,payload:{...body,force:true}})).statusCode).toBe(400);
  expect(f.service[method]).not.toHaveBeenCalled();const result=await f.app.inject({method:'POST',url,headers:allowed,payload:body});expect(result.statusCode).toBe(200);expect(f.service[method]).toHaveBeenCalledOnce();
});

it('requires a specific preview token for permanent deletion',async()=>{const f=fixture();const allowed=await auth(f.app);
  for(const payload of [{},{token:'wrong'},{token:id,materialPath:entry.materialPath}])expect((await f.app.inject({method:'POST',url:`/api/v1/trash/${id}/delete`,headers:allowed,payload})).statusCode).toBe(400);
  expect(f.service.delete).not.toHaveBeenCalled();
});

it.each(['library','queue','knowledge'] as const)('passes an optional %s origin to the document service and exposes it in the preview',async(origin)=>{
  const f=fixture(),allowed=await auth(f.app),materialPath=origin==='knowledge'?'02知识库/09学习/知识.md':entry.materialPath;
  f.service.preview.mockResolvedValue({...preview,materialPath,origin} as TrashPreview);
  const result=await f.app.inject({method:'POST',url:'/api/v1/trash/preview',headers:allowed,payload:{materialPath,origin}});
  expect(result.statusCode).toBe(200);expect(result.json().data).toMatchObject({materialPath,origin});expect(f.service.preview).toHaveBeenCalledWith(materialPath,origin);
});

it('rejects unknown origins and path traversal before calling the writer',async()=>{
  const f=fixture(),allowed=await auth(f.app);
  for(const payload of [{materialPath:entry.materialPath,origin:'intake'},{materialPath:'02知识库/../秘密.md',origin:'knowledge'},{materialPath:'02知识库/.隐藏/知识.md'},{materialPath:'01图书馆/小兆clipper/知识.md'},{materialPath:'02知识库/坏\n知识.md'}]){
    expect((await f.app.inject({method:'POST',url:'/api/v1/trash/preview',headers:allowed,payload})).statusCode).toBe(400);
  }
  expect(f.service.preview).not.toHaveBeenCalled();
});

it('keeps old or unavailable writers read-only and rejects extra output fields',async()=>{const app=buildServer();servers.push(app);expect((await app.inject({url:'/api/v1/trash',headers})).statusCode).toBe(503);
  const f=fixture();f.service.get.mockReturnValue({...entry,privatePath:'/private/key'} as TrashEntry);const result=await f.app.inject({url:`/api/v1/trash/${id}`,headers});expect(result.statusCode).toBe(500);expect(result.body).not.toContain('/private/key');
});
