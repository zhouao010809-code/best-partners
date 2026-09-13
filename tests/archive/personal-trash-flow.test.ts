import { afterEach, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { startServer } from '../../src/server/start-server.js';
import { FileSystemVaultGateway } from '../../src/server/vault/FileSystemVaultGateway.js';
import { createNativeReadVaultPortFactory } from '../../src/server/vault/NativeReadVaultPort.js';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';
import { createKnowledgeNote } from '../../src/server/ingestion/note-format.js';

const source='01图书馆/来自个人/2026-09/测试原文.md',knowledge='02知识库/09学习/测试知识.md';
const original=Buffer.from('\ufeff---\r\n类型: 原始资料\r\n处理状态: 已归档\r\n来源平台: 个人\r\n原始标题: 测试原文\r\n所属主题: []\r\n关键词: []\r\n知识入库状态: 未提炼\r\n生成知识: []\r\n---\r\n\r\n测试原文正文不变。\r\n![附件](附件.bin)\r\n');
const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});

async function fixture(){
  const base=mkdtempSync('/private/tmp/xiaozhao-trash-flow-');chmodSync(base,0o700);
  writeFileSync(join(base,'.test-marker'),'personal-trash-flow-v1\n',{mode:0o600,flag:'wx'});
  cleanup.push(()=>{if(dirname(base)!=='/private/tmp'||!basename(base).startsWith('xiaozhao-trash-flow-')||realpathSync(base)!==base||readFileSync(join(base,'.test-marker'),'utf8')!=='personal-trash-flow-v1\n')throw Error('INVALID_TEST_CLEANUP');rmSync(base,{recursive:true});});
  const root=join(base,'vault'),clientRoot=join(base,'client'),appDataDir=join(base,'data');
  for(const path of ['00大脑规则','01图书馆/小兆clipper',dirname(source),dirname(knowledge),'03大讲堂'])mkdirSync(join(root,path),{recursive:true,mode:0o700});
  mkdirSync(clientRoot,{mode:0o700});writeFileSync(join(clientRoot,'index.html'),'<html><body>test</body></html>');
  for(const path of RULE_BUNDLE_SOURCE_PATHS)writeFileSync(join(root,path),'# 隔离回收站测试规则\n原文保真；只在手动确认时回收。\n',{mode:0o600});
  writeFileSync(join(root,source),original,{mode:0o644});const attachment=Buffer.from([255,0,13,10]);writeFileSync(join(root,dirname(source),'附件.bin'),attachment);
  const knowledgeBytes=createKnowledgeNote({title:'测试知识',knowledgeType:'方法',suggestedPath:dirname(knowledge),topics:[],coreContent:'先核实证据，再执行。',value:'保留依据',draft:{keywords:['核实','证据','操作'],scenarios:['核对资料时','行动之前'],conclusion:'先核实证据再执行。',keyPoints:['查看原文','核对依据'],boundary:'针对可验证资料。',quotes:[],summaries:['保持证据可追溯。']}},source,'2026-09-07');writeFileSync(join(root,knowledge),knowledgeBytes);
  const gateway=await FileSystemVaultGateway.create({vaultRoot:root,nativeReader:createNativeReadVaultPortFactory(resolve('dist/native/atomic-file-helper'))});
  async function open(){
    const server=await startServer({host:'127.0.0.1',port:0,vaultRealRoot:root,appDataDir,clientRoot,adapter:'filesystem',gateway,personalArchiveAddonPath:resolve('dist/native/personal-archive.node'),modelBaseUrl:'https://api.deepseek.com',
      modelCredentials:{status:()=>({available:true,configured:false,revision:'0'}),getKey:()=>{throw Error('NO_MODEL_CALL');},setKey:()=>{throw Error('NO_KEY_WRITES');},clear:()=>{throw Error('NO_KEY_WRITES');}}});
    cleanup.push(()=>server.close());await server.requestRefresh();const bootstrap=await fetch(`${server.origin}/api/v1/bootstrap`);const data=await bootstrap.json();
    const headers={origin:server.origin,cookie:bootstrap.headers.get('set-cookie')!.split(';')[0]!,'x-csrf-token':data.data.csrfToken as string,'content-type':'application/json'};
    async function request(path:string,body?:unknown){const response=await fetch(`${server.origin}/api/v1/${path}`,body===undefined?{}:{method:'POST',headers,body:JSON.stringify(body)});return {status:response.status,body:await response.json()};}
    return {server,request};
  }
  return {root,appDataDir,open,knowledgeBytes,attachment};
}

it('round-trips a real original through native trash and disk SQLite across restart via authenticated HTTP',async()=>{
  const f=await fixture(),first=await f.open(),inode=lstatSync(join(f.root,source)).ino;
  const p=await first.request('trash/preview',{materialPath:source});expect(p.status).toBe(200);expect(p.body.data.referencedKnowledge).toEqual([{path:knowledge,title:'测试知识'}]);expect(readFileSync(join(f.root,source))).toEqual(original);
  const id=p.body.data.id as string;expect((await first.request('trash/commit',{id})).body.data).toMatchObject({status:'trashed',indexed:true});expect(existsSync(join(f.root,source))).toBe(false);
  expect(readFileSync(join(f.appDataDir,'personal-trash-v1',`${id}.md`))).toEqual(original);
  expect((await first.request('materials?status=未提炼')).body.data.items).toEqual([]);expect((await first.request('extraction-queue')).body.data.items).toEqual([]);
  expect(readFileSync(join(f.root,knowledge))).toEqual(f.knowledgeBytes);expect(readFileSync(join(f.root,dirname(source),'附件.bin'))).toEqual(f.attachment);
  await first.server.close();const second=await f.open();expect((await second.request(`trash/${id}`)).body.data.status).toBe('trashed');
  expect((await second.request(`trash/${id}/restore`,{})).body.data).toMatchObject({status:'restored',indexed:true});expect(readFileSync(join(f.root,source))).toEqual(original);expect(lstatSync(join(f.root,source)).ino).toBe(inode);
  expect((await second.request(`trash/${id}/restore`,{})).body.data.status).toBe('restored');expect(lstatSync(join(f.root,source)).ino).toBe(inode);
  expect((await second.request('extraction-queue')).body.data.items).toEqual([expect.objectContaining({materialPath:source})]);
  expect((await second.request('extraction-queue/visibility',{materialPath:source,removed:true})).status).toBe(200);
  expect((await second.request('extraction-queue')).body.data.items).toEqual([]);
  expect((await second.request('materials?status=未提炼')).body.data.items).toEqual([expect.objectContaining({path:source})]);
  await second.server.close();const third=await f.open();expect((await third.request('extraction-queue?visibility=removed')).body.data.items).toEqual([expect.objectContaining({materialPath:source,removedAt:expect.any(String)})]);
  expect((await third.request('extraction-queue/visibility',{materialPath:source,removed:false})).body.data.item.removedAt).toBeUndefined();expect(readFileSync(join(f.root,source))).toEqual(original);expect(readFileSync(join(f.root,knowledge))).toEqual(f.knowledgeBytes);
});

it('keeps the recycled original when a new same-name file occupies the restore location',async()=>{
  const f=await fixture(),app=await f.open();const preview=await app.request('trash/preview',{materialPath:source});const id=preview.body.data.id as string;
  await app.request('trash/commit',{id});writeFileSync(join(f.root,source),'另一个文件',{mode:0o644,flag:'wx'});
  const restored=await app.request(`trash/${id}/restore`,{});expect(restored.status).toBe(409);expect(restored.body.error.code).toBe('TRASH_RESTORE_CONFLICT');
  expect(readFileSync(join(f.root,source),'utf8')).toBe('另一个文件');expect(readFileSync(join(f.appDataDir,'personal-trash-v1',`${id}.md`))).toEqual(original);expect(readFileSync(join(f.root,knowledge))).toEqual(f.knowledgeBytes);
});

it('permanently deletes a confirmed recycled Markdown via real native and HTTP while keeping knowledge and attachments across restart',async()=>{
  const f=await fixture(),first=await f.open();const moved=await first.request('trash/preview',{materialPath:source});const id=moved.body.data.id as string;
  await first.request('trash/commit',{id});const slot=join(f.appDataDir,'personal-trash-v1',`${id}.md`);
  const preview=await first.request(`trash/${id}/delete-preview`,{});expect(preview.status).toBe(200);expect(preview.body.data.referencedKnowledge).toEqual([{path:knowledge,title:'测试知识'}]);
  expect(readFileSync(slot)).toEqual(original);expect(existsSync(join(f.appDataDir,'personal-trash-v1',`${id}.delete.json`))).toBe(false);
  const token=preview.body.data.token as string;expect((await first.request(`trash/${id}/delete`,{token:'bad'})).status).toBe(400);expect(existsSync(slot)).toBe(true);
  const deleted=await first.request(`trash/${id}/delete`,{token});expect(deleted.status).toBe(200);expect(deleted.body.data).toMatchObject({id,status:'deleted',indexed:true,deletedAt:expect.any(String)});
  expect(existsSync(slot)).toBe(false);expect(existsSync(join(f.root,source))).toBe(false);
  expect((await first.request(`trash/${id}/delete`,{token})).body.data).toEqual(deleted.body.data);
  expect((await first.request(`trash/${id}/restore`,{})).body.error.code).toBe('TRASH_DELETED');
  expect(readFileSync(join(f.root,knowledge))).toEqual(f.knowledgeBytes);expect(readFileSync(join(f.root,dirname(source),'附件.bin'))).toEqual(f.attachment);
  await first.server.close();const second=await f.open();expect((await second.request(`trash/${id}`)).body.data).toEqual(deleted.body.data);
  expect((await second.request(`trash/${id}/restore`,{})).body.error.code).toBe('TRASH_DELETED');expect(existsSync(slot)).toBe(false);
  // A new material saved at the old path is independent from the deleted slot.
  writeFileSync(join(f.root,source),Buffer.concat([original,Buffer.from('新导入的资料。\n')]),{mode:0o644,flag:'wx'});await second.server.requestRefresh();
  expect((await second.request('materials?status=未提炼')).body.data.items).toEqual([expect.objectContaining({path:source})]);
  expect((await second.request('extraction-queue')).body.data.items).toEqual([expect.objectContaining({materialPath:source})]);
  expect(readFileSync(join(f.root,knowledge))).toEqual(f.knowledgeBytes);expect(readFileSync(join(f.root,dirname(source),'附件.bin'))).toEqual(f.attachment);
});

it('retains queue origin in real immutable recovery storage and exposes it after server restart',async()=>{
  const f=await fixture(),first=await f.open();
  const preview=await first.request('trash/preview',{materialPath:source,origin:'queue'});expect(preview.status).toBe(200);expect(preview.body.data.origin).toBe('queue');
  const id=preview.body.data.id as string;expect((await first.request('trash/commit',{id})).body.data).toMatchObject({status:'trashed',origin:'queue'});
  const intent=readFileSync(join(f.appDataDir,'personal-trash-v1',`${id}.intent.json`));expect(JSON.parse(intent.toString()).origin).toBe('queue');
  await first.server.close();const reopened=await f.open();
  expect((await reopened.request('trash')).body.data.items).toEqual([expect.objectContaining({id,origin:'queue',status:'trashed'})]);
  expect((await reopened.request(`trash/${id}/delete-preview`,{})).body.data.origin).toBe('queue');
  expect((await reopened.request(`trash/${id}/restore`,{})).body.data).toMatchObject({origin:'queue',status:'restored',indexed:true});
  expect(readFileSync(join(f.root,source))).toEqual(original);expect(readFileSync(join(f.appDataDir,'personal-trash-v1',`${id}.intent.json`))).toEqual(intent);
});

it('round-trips and explicitly purges only one real knowledge Markdown while preserving sources and attachments',async()=>{
  const f=await fixture();const bytes=Buffer.from(`\ufeff${f.knowledgeBytes.toString('utf8').replace(/\r?\n/gu,'\r\n')}\r\n![知识附件](知识附件.bin)\r\n`);
  writeFileSync(join(f.root,knowledge),bytes);const attachment=Buffer.from([255,0,13,10]);writeFileSync(join(f.root,dirname(knowledge),'知识附件.bin'),attachment);
  const first=await f.open(),inode=lstatSync(join(f.root,knowledge)).ino;
  const preview=await first.request('trash/preview',{materialPath:knowledge,origin:'knowledge'});expect(preview.status).toBe(200);expect(preview.body.data).toMatchObject({origin:'knowledge',bytes:bytes.length});
  const id=preview.body.data.id as string;expect((await first.request('trash/commit',{id})).body.data).toMatchObject({origin:'knowledge',status:'trashed',indexed:true});
  expect(existsSync(join(f.root,knowledge))).toBe(false);expect(readFileSync(join(f.appDataDir,'personal-trash-v1',`${id}.md`))).toEqual(bytes);
  expect(readFileSync(join(f.root,source))).toEqual(original);expect(readFileSync(join(f.root,dirname(knowledge),'知识附件.bin'))).toEqual(attachment);
  await first.server.close();const second=await f.open();
  expect((await second.request(`trash/${id}`)).body.data).toMatchObject({origin:'knowledge',status:'trashed'});
  expect((await second.request(`trash/${id}/restore`,{})).body.data).toMatchObject({origin:'knowledge',status:'restored',indexed:true});
  expect(readFileSync(join(f.root,knowledge))).toEqual(bytes);expect(lstatSync(join(f.root,knowledge)).ino).toBe(inode);
  const secondPreview=await second.request('trash/preview',{materialPath:knowledge});const secondId=secondPreview.body.data.id as string;
  expect(secondPreview.body.data.origin).toBe('knowledge');await second.request('trash/commit',{id:secondId});
  const deletion=await second.request(`trash/${secondId}/delete-preview`,{});expect(deletion.body.data.origin).toBe('knowledge');
  expect((await second.request(`trash/${secondId}/delete`,{token:deletion.body.data.token})).body.data).toMatchObject({origin:'knowledge',status:'deleted',indexed:true});
  expect(existsSync(join(f.appDataDir,'personal-trash-v1',`${secondId}.md`))).toBe(false);expect(existsSync(join(f.root,knowledge))).toBe(false);
  expect(readFileSync(join(f.root,source))).toEqual(original);expect(readFileSync(join(f.root,dirname(source),'附件.bin'))).toEqual(f.attachment);expect(readFileSync(join(f.root,dirname(knowledge),'知识附件.bin'))).toEqual(attachment);
  await second.server.close();const third=await f.open();expect((await third.request(`trash/${secondId}`)).body.data).toMatchObject({origin:'knowledge',status:'deleted'});
  expect((await third.request(`trash/${secondId}/restore`,{})).body.error.code).toBe('TRASH_DELETED');
});
