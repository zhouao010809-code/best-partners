import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createIndexRepository } from '../../src/server/index/index-repository.js';
import { createHash, randomUUID } from 'node:crypto';
import { createTrashService } from '../../src/server/trash/trash-service.js';
import type { PersonalTrashPort } from '../../src/server/trash/trash-native.js';
import type { ArchiveStat } from '../../src/server/archive/sandbox-native.js';
import { readMaterialVisibility } from '../../src/server/services/material-visibility.js';
import { createExtractionQueueService } from '../../src/server/services/extraction-queue-service.js';
import { readFileSync } from 'node:fs';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

it('adds durable independent queue visibility and trash state without deleting prior history', () => {
  const db = new Database(':memory:'); databases.push(db); applyMigrations(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name: string}[];
  expect(tables.map((table) => table.name)).toEqual(expect.arrayContaining(['personal_queue_visibility', 'personal_trash_entries', 'personal_candidate_reviews', 'personal_extraction_runs']));
});

it('migrates existing recycle records without losing their recovery data or hidden queue settings',()=>{
  const db=new Database(':memory:');databases.push(db);
  const names=['001_initial.sql','002_read_api_jobs.sql','008_personal_extraction.sql','009_personal_ingestion.sql','010_personal_material_management.sql'];
  applyMigrations(db,names.map((name)=>({version:Number(name.slice(0,3)),sql:readFileSync(new URL(`../../src/server/db/migrations/${name}`,import.meta.url),'utf8')})));
  const id=randomUUID();db.prepare('INSERT INTO personal_trash_entries VALUES(?,?,?,?,?,?,?,?,?)').run(id,'01图书馆/来自个人/旧.md','旧资料','2026-09-07T00:00:00.000Z','trashed','{"original":"receipt"}',null,1,null);
  db.prepare('INSERT INTO personal_queue_visibility VALUES(?,?)').run('01图书馆/来自个人/另一个.md','2026-09-07T00:00:00.000Z');
  const before=db.prepare('SELECT * FROM personal_trash_entries').get();applyMigrations(db);applyMigrations(db);
  expect(db.prepare('SELECT * FROM personal_trash_entries').get()).toEqual({...before as object,delete_manifest_json:null,deleted_at:null});
  expect(db.prepare('SELECT * FROM personal_queue_visibility').all()).toHaveLength(1);
  const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  expect(versions.slice(0, -7)).toEqual([1,2,8,9,10,11,12,14,15,16].map((version)=>({version})));
  expect(versions.slice(-7)).toEqual([{version:17},{version:18},{version:19},{version:20},{version:21},{version:22},{version:23}]);
});

const source = '01图书馆/来自个人/2026-09/原文.md';
const original = Buffer.from('---\n类型: 原始资料\n处理状态: 已归档\n来源平台: 个人\n原始标题: 原文\n作者:\n原始链接:\n采集日期: 2026-09-07\n所属主题: []\n关键词: []\n知识入库状态: 未提炼\n生成知识: []\n备注:\n---\n原文不可改。\n');
const knowledgeBytes = Buffer.from(`\ufeff---\r\n类型: 知识笔记\r\n来源类型: AI提炼\r\n使用状态: 定论\r\n知识类型: 方法\r\n所属主题: []\r\n关键词: []\r\n来源资料: [[${source.replace(/\.md$/u,'')}]]\r\n适用场景: []\r\n核心结论: 先核实再行动\r\n关键要点: []\r\n使用边界: 可核实的信息\r\n---\r\n\r\n# 原有知识\r\n\u0000字节保留。\r\n![附件](附件.bin)\r\n`);
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');

function fixture(now:()=>Date=()=>new Date()) {
  const db = new Database(':memory:'); databases.push(db); applyMigrations(db);
  const repository = createIndexRepository(db);
  repository.replaceFile({kind: 'material', record: {path: source, title:'原文', rawSha256:hash(original), processingStatus:'已归档', knowledgeStatus:'未提炼', generatedKnowledge:[], sourcePlatform:'个人'}});
  const knowledgePath = '02知识库/09学习/知识.md';
  repository.replaceFile({kind:'knowledge',record:{path:knowledgePath,title:'知识',rawSha256:'b'.repeat(64),sourceType:'AI提炼',usageStatus:'AI总结',knowledgeType:'方法',recallFields:{topics:[],keywords:[],scenarios:[],conclusion:'结论',keyPoints:[],boundary:'边界'},sourceMaterials:[source.replace(/\.md$/u,'')]}});
  type File = {bytes:Buffer;ino:string};
  const files = new Map<string,File>([[source,{bytes:Buffer.from(original),ino:'10'}],[knowledgePath,{bytes:Buffer.from(knowledgeBytes),ino:'11'}]]);
  const trash = new Map<string,File>(); const records = new Map<string,Buffer>();
  let moves=0,restores=0,purges=0,failPurge=false,failAfterPurge=false,failAfterMove=false,failSourceStat=false,refreshOk=true,rules='a'.repeat(64),ruleWait:Promise<void>|undefined;
  const stat = (file:File|undefined):ArchiveStat|null => file ? {kind:'file',dev:'1',ino:file.ino,size:file.bytes.length}:null;
  const port:PersonalTrashPort = {rootIdentity:{dev:'1',ino:'2'},stat:(p)=>{if(failSourceStat)throw Error('IO_ERROR');return stat(files.get(p));},read:(p)=>files.get(p)?.bytes??null,
    statItem:(id)=>stat(trash.get(id)),readItem:(id)=>trash.get(id)?.bytes??null,
    move(p,id,expected){const file=files.get(p); if(!file||file.ino!==expected.ino)throw Error('SOURCE_IDENTITY_CHANGED');if(trash.has(id))throw Error('TARGET_EXISTS');trash.set(id,file);files.delete(p);moves++;if(failAfterMove)throw Error('TRASH_NEEDS_REVIEW');},
    restore(id,p,expected){const file=trash.get(id);if(files.has(p))throw Error('TARGET_EXISTS');if(!file||file.ino!==expected.ino)throw Error('SOURCE_IDENTITY_CHANGED');files.set(p,file);trash.delete(id);restores++;},
    purge(id,expected,bytes){const file=trash.get(id);if(!file||file.ino!==expected.ino||!file.bytes.equals(bytes))throw Error('SOURCE_IDENTITY_CHANGED');if(failPurge)throw Error('IO_ERROR');trash.delete(id);purges++;if(failAfterPurge)throw Error('TRASH_DELETE_NEEDS_REVIEW');},
    writeRecovery(name,bytes){if(records.has(name))throw Error('TARGET_EXISTS');records.set(name,Buffer.from(bytes));},readRecovery:(name)=>records.get(name)??null,listRecovery:()=>[...records.keys()],close(){}
  };
  const make = ()=>createTrashService({database:db,repository,port,getRuleFingerprint:async()=>{await ruleWait;return rules;},refreshIndex:async()=>refreshOk,now});
  const service=make();
  return {db,repository,files,trash,records,service,make,knowledgePath,
    counts:()=>({moves,restores}),purges:()=>purges,setFailPurge:(v:boolean)=>{failPurge=v;},setFailAfterPurge:()=>{failAfterPurge=true;},setFailAfterMove:()=>{failAfterMove=true;},setFailSourceStat:(v:boolean)=>{failSourceStat=v;},setRefresh:(v:boolean)=>{refreshOk=v;},setRules:(v:string)=>{rules=v;},pauseRules:()=>{let release!:()=>void;ruleWait=new Promise<void>((resolve)=>{release=resolve;});return release;}};
}

it('persists queue origin through preview, immutable intent, restart, deletion preview and restore',async()=>{
  const f=fixture();const preview=await f.service.preview(source,'queue');
  expect(preview).toMatchObject({origin:'queue'});
  expect(await f.service.commit(preview.id)).toMatchObject({origin:'queue',status:'trashed'});
  const intent=f.records.get(`${preview.id}.intent.json`)!;
  expect(JSON.parse(intent.toString())).toMatchObject({origin:'queue'});
  f.db.prepare('DELETE FROM personal_trash_entries WHERE id=?').run(preview.id);
  const reopened=f.make();await reopened.recover();
  expect(reopened.list().items).toEqual([expect.objectContaining({origin:'queue',status:'trashed'})]);
  expect(await reopened.previewDelete(preview.id)).toMatchObject({origin:'queue'});
  expect(await reopened.restore(preview.id)).toMatchObject({origin:'queue',status:'restored'});
  expect(f.records.get(`${preview.id}.intent.json`)).toEqual(intent);
});

it('reads an old originless intent as library while retaining its exact persisted bytes',async()=>{
  const f=fixture();const preview=await f.service.preview(source);await f.service.commit(preview.id);
  const data=JSON.parse(f.records.get(`${preview.id}.intent.json`)!.toString());delete data.origin;
  const legacy=Buffer.from(`${JSON.stringify(data,null,2)}\n`);f.records.set(`${preview.id}.intent.json`,legacy);
  f.db.prepare('DELETE FROM personal_trash_entries WHERE id=?').run(preview.id);
  const reopened=f.make();await reopened.recover();
  expect(reopened.get(preview.id)).toMatchObject({origin:'library',status:'trashed'});
  expect((f.db.prepare('SELECT manifest_json FROM personal_trash_entries WHERE id=?').get(preview.id) as {manifest_json:string}).manifest_json).toBe(legacy.toString());
  expect(await reopened.restore(preview.id)).toMatchObject({origin:'library',status:'restored'});
  expect(f.records.get(`${preview.id}.intent.json`)).toEqual(legacy);
});

it('keeps historical delete confirmations bound to the unchanged originless intent after restart',async()=>{
  const f=fixture();const preview=await f.service.preview(source);await f.service.commit(preview.id);
  const data=JSON.parse(f.records.get(`${preview.id}.intent.json`)!.toString());delete data.origin;
  const legacy=Buffer.from(`${JSON.stringify(data,null,2)}\n`);f.records.set(`${preview.id}.intent.json`,legacy);
  f.db.prepare('UPDATE personal_trash_entries SET manifest_json=? WHERE id=?').run(legacy.toString(),preview.id);
  const deletion=await f.service.previewDelete(preview.id);f.setFailPurge(true);await f.service.delete(preview.id,deletion.token);
  const confirmed=f.records.get(`${preview.id}.delete.json`)!;
  expect(JSON.parse(confirmed.toString()).manifestSha256).toBe(hash(legacy));
  const reopened=f.make();await reopened.recover();expect(reopened.get(preview.id)).toMatchObject({origin:'library',status:'deleting'});
  expect(f.purges()).toBe(0);f.setFailPurge(false);
  expect(await reopened.delete(preview.id,deletion.token)).toMatchObject({origin:'library',status:'deleted'});
  expect(f.records.get(`${preview.id}.intent.json`)).toEqual(legacy);expect(f.records.get(`${preview.id}.delete.json`)).toEqual(confirmed);
});

it('moves a valid read-compatible knowledge note and restores its exact bytes without touching associated files or history',async()=>{
  const f=fixture(),beforeKnowledge=f.repository.getKnowledge(f.knowledgePath),beforeSource=f.files.get(source);
  const attachment={bytes:Buffer.from([0,255,13,10]),ino:'12'};f.files.set('02知识库/09学习/附件.bin',attachment);
  f.db.prepare('INSERT INTO personal_queue_visibility VALUES (?,?)').run(source,new Date().toISOString());
  const preview=await f.service.preview(f.knowledgePath);
  expect(preview).toMatchObject({origin:'knowledge',materialPath:f.knowledgePath,title:'知识',bytes:knowledgeBytes.length});
  expect(await f.service.commit(preview.id)).toMatchObject({origin:'knowledge',status:'trashed'});
  expect(f.files.has(f.knowledgePath)).toBe(false);expect(f.trash.get(preview.id)?.bytes).toEqual(knowledgeBytes);
  const reopened=f.make();await reopened.recover();
  expect(await reopened.restore(preview.id)).toMatchObject({origin:'knowledge',status:'restored'});
  expect(f.files.get(f.knowledgePath)).toEqual({bytes:knowledgeBytes,ino:'11'});
  expect(f.files.get(source)).toBe(beforeSource);expect(f.files.get('02知识库/09学习/附件.bin')).toBe(attachment);
  expect(f.repository.getKnowledge(f.knowledgePath)).toEqual(beforeKnowledge);expect(f.db.prepare('SELECT * FROM personal_queue_visibility').all()).toHaveLength(1);
});

it('purges only the confirmed knowledge slot and retains its source, other notes, attachments and journals',async()=>{
  const f=fixture(),sourceBefore=f.files.get(source),other={bytes:Buffer.from(knowledgeBytes),ino:'12'},attachment={bytes:Buffer.from([0,255]),ino:'13'};
  f.files.set('02知识库/09学习/其他.md',other);f.files.set('02知识库/09学习/附件.bin',attachment);
  const move=await f.service.preview(f.knowledgePath,'knowledge');await f.service.commit(move.id);
  const preview=await f.service.previewDelete(move.id);expect(preview.origin).toBe('knowledge');expect(f.trash.get(move.id)?.bytes).toEqual(knowledgeBytes);
  expect(await f.service.delete(move.id,preview.token)).toMatchObject({origin:'knowledge',status:'deleted'});
  expect(f.trash.has(move.id)).toBe(false);expect(f.files.has(f.knowledgePath)).toBe(false);expect(f.purges()).toBe(1);
  expect(f.files.get(source)).toBe(sourceBefore);expect(f.files.get('02知识库/09学习/其他.md')).toBe(other);expect(f.files.get('02知识库/09学习/附件.bin')).toBe(attachment);
  expect(f.records.has(`${move.id}.intent.json`)).toBe(true);expect(f.records.has(`${move.id}.delete.json`)).toBe(true);
});

it.each(['library','knowledge'] as const)('removes only the deleted %s version from the index even when refresh fails',async(origin)=>{
  const f=fixture(),path=origin==='knowledge'?f.knowledgePath:source;
  if(origin==='knowledge')f.repository.replaceFile({kind:'knowledge',record:{...f.repository.getKnowledge(path)!,rawSha256:hash(knowledgeBytes)}});
  const move=await f.service.preview(path,origin);await f.service.commit(move.id);const deletion=await f.service.previewDelete(move.id);f.setRefresh(false);
  expect(await f.service.delete(move.id,deletion.token)).toMatchObject({status:'deleted',indexed:false});
  expect(f.repository.getManifestEntry(path)).toBeUndefined();
});

it.each(['library','knowledge'] as const)('retains a different same-path indexed %s version after deleting the old slot',async(origin)=>{
  const f=fixture(),path=origin==='knowledge'?f.knowledgePath:source;
  const move=await f.service.preview(path,origin);await f.service.commit(move.id);
  const newBytes=Buffer.concat([origin==='knowledge'?knowledgeBytes:original,Buffer.from('新的版本\n')]);f.files.set(path,{bytes:newBytes,ino:'99'});
  if(origin==='knowledge')f.repository.replaceFile({kind:'knowledge',record:{...f.repository.getKnowledge(path)!,rawSha256:hash(newBytes)}});
  else f.repository.replaceFile({kind:'material',record:{...f.repository.listMaterials({}).items[0]!,rawSha256:hash(newBytes)}});
  const before=f.repository.getManifestEntry(path);const deletion=await f.service.previewDelete(move.id);f.setRefresh(false);
  expect(await f.service.delete(move.id,deletion.token)).toMatchObject({status:'deleted',indexed:false});
  expect(f.repository.getManifestEntry(path)).toEqual(before);expect(f.files.get(path)?.bytes).toEqual(newBytes);
});

it.each(['library','knowledge'] as const)('clears stale indexed %s bytes when a newer unindexed source was recycled and both refreshes failed',async(origin)=>{
  const f=fixture(),path=origin==='knowledge'?f.knowledgePath:source;
  const edited=Buffer.concat([origin==='knowledge'?knowledgeBytes:original,Buffer.from('预览前的外部编辑\n')]);f.files.get(path)!.bytes=edited;
  expect(f.repository.getManifestEntry(path)?.rawSha256).not.toBe(hash(edited));f.setRefresh(false);
  const move=await f.service.preview(path,origin);expect(await f.service.commit(move.id)).toMatchObject({status:'trashed',indexed:false});
  expect(f.repository.getManifestEntry(path)).toBeDefined();const deletion=await f.service.previewDelete(move.id);
  expect(await f.service.delete(move.id,deletion.token)).toMatchObject({status:'deleted',indexed:false});
  expect(f.files.has(path)).toBe(false);expect(f.repository.getManifestEntry(path)).toBeUndefined();
});

it('retains a different indexed version until the original path can be verified after permanent deletion',async()=>{
  const f=fixture();f.files.get(source)!.bytes=Buffer.concat([original,Buffer.from('未索引的新内容\n')]);f.setRefresh(false);
  const before=f.repository.getManifestEntry(source);const move=await f.service.preview(source);await f.service.commit(move.id);
  const deletion=await f.service.previewDelete(move.id);f.setFailSourceStat(true);
  await expect(f.service.delete(move.id,deletion.token)).rejects.toThrow('IO_ERROR');
  expect(f.repository.getManifestEntry(source)).toEqual(before);expect(f.service.get(move.id)).toMatchObject({status:'deleting'});
  expect(f.trash.has(move.id)).toBe(false);f.setFailSourceStat(false);
  expect(await f.service.retry(move.id)).toMatchObject({status:'deleted',indexed:false});expect(f.repository.getManifestEntry(source)).toBeUndefined();expect(f.purges()).toBe(1);
});

it('rejects an invalid knowledge file even when the indexed record is valid',async()=>{
  const f=fixture();f.files.get(f.knowledgePath)!.bytes=Buffer.from(original);
  await expect(f.service.preview(f.knowledgePath)).rejects.toMatchObject({code:'TRASH_SOURCE_UNAVAILABLE'});
  expect(f.counts().moves).toBe(0);expect(f.records.size).toBe(0);
});

it.each([[source,'knowledge'],['02知识库/09学习/知识.md','library'],['02知识库/09学习/知识.md','queue']] as const)('rejects an inconsistent origin for %s',async(path,origin)=>{
  const f=fixture();await expect(f.service.preview(path,origin)).rejects.toMatchObject({code:'TRASH_ORIGIN_MISMATCH'});expect(f.counts().moves).toBe(0);
});

it.each(['02知识库/../知识.md','02知识库/.隐藏/知识.md','02知识库//知识.md','02知识库/知识.md/其他.txt','02知识库/知识.txt','/02知识库/知识.md','02知识库/坏\\知识.md','02知识库/坏\n知识.md','01图书馆/小兆clipper/知识.md','00大脑规则/知识.md'])('rejects an unsafe or unsupported document path %s',async(path)=>{
  const f=fixture();await expect(f.service.preview(path)).rejects.toMatchObject({code:'PATH_NOT_ALLOWED'});expect(f.records.size).toBe(0);
});

it('maintains one active recycle record per path across library and queue origins',async()=>{
  const f=fixture();const library=await f.service.preview(source,'library'),queue=await f.service.preview(source,'queue');await f.service.commit(library.id);
  f.files.set(source,{bytes:Buffer.from(original),ino:'10'});
  await expect(f.service.commit(queue.id)).rejects.toMatchObject({code:'TRASH_ALREADY_PENDING'});
  await expect(f.service.preview(source,'queue')).rejects.toMatchObject({code:'TRASH_ALREADY_PENDING'});expect(f.counts().moves).toBe(1);
});

it.each(['preview','commit','restore','previewDelete','delete'] as const)('blocks knowledge %s while a noncommitted batch targets the note',async(action)=>{
  const f=fixture();const move=await f.service.preview(f.knowledgePath,'knowledge');
  if(['restore','previewDelete','delete'].includes(action))await f.service.commit(move.id);
  const deletion=action==='delete'?await f.service.previewDelete(move.id):undefined;
  f.db.prepare('INSERT INTO personal_ingestion_batches VALUES(?,?,?,?,?,?,?)').run(randomUUID(),randomUUID(),new Date().toISOString(),'needs-review',0,JSON.stringify({materialPath:source,files:[{path:f.knowledgePath}]}),'需恢复');
  const pending=action==='preview'?f.service.preview(f.knowledgePath):action==='delete'?f.service.delete(move.id,deletion!.token):f.service[action](move.id);
  await expect(pending).rejects.toMatchObject({code:'RECOVERY_REQUIRED'});expect(f.purges()).toBe(0);
  expect(f.files.get(f.knowledgePath)?.bytes??f.trash.get(move.id)?.bytes).toEqual(knowledgeBytes);
});

it('previews references without moving, confirms once, and restores byte-identical original while retaining history and knowledge',async()=>{
  const f=fixture(); const before=f.repository.getKnowledge(f.knowledgePath);
  f.db.prepare('INSERT INTO personal_queue_visibility VALUES (?,?)').run(source,new Date().toISOString());
  const preview=await f.service.preview(source);
  expect(preview).toMatchObject({materialPath:source,bytes:original.length,referencedKnowledge:[{path:f.knowledgePath,title:'知识'}]});
  expect(f.counts()).toEqual({moves:0,restores:0});expect(f.records.size).toBe(0);expect(f.service.list().items).toHaveLength(0);
  expect(await f.service.commit(preview.id)).toMatchObject({id:preview.id,status:'trashed',indexed:true});
  expect(f.files.has(source)).toBe(false);expect(f.trash.get(preview.id)?.bytes).toEqual(original);
  expect(await f.service.commit(preview.id)).toMatchObject({status:'trashed'});expect(f.counts().moves).toBe(1);
  const reopened=f.make();await reopened.recover();expect(reopened.get(preview.id)).toMatchObject({status:'trashed'});
  expect(await reopened.restore(preview.id)).toMatchObject({status:'restored',indexed:true});
  expect(await reopened.restore(preview.id)).toMatchObject({status:'restored'});
  expect(f.counts()).toEqual({moves:1,restores:1});expect(f.files.get(source)).toEqual({bytes:original,ino:'10'});
  expect(f.repository.getKnowledge(f.knowledgePath)).toEqual(before);expect(f.db.prepare('SELECT * FROM personal_queue_visibility').all()).toHaveLength(1);
});

it('invalidates a preview when bytes or rules change and never touches the file',async()=>{
  const f=fixture();const preview=await f.service.preview(source);f.files.get(source)!.bytes=Buffer.from('用户的新内容');
  await expect(f.service.commit(preview.id)).rejects.toMatchObject({code:'TRASH_PREVIEW_STALE'});expect(f.counts().moves).toBe(0);
  f.files.get(source)!.bytes=Buffer.from(original);const fresh=await f.service.preview(source);f.setRules('c'.repeat(64));
  await expect(f.service.commit(fresh.id)).rejects.toMatchObject({code:'TRASH_PREVIEW_STALE'});expect(f.counts().moves).toBe(0);
});

it('requires a fresh preview when a new knowledge reference appears',async()=>{
  const f=fixture();const preview=await f.service.preview(source);const old=f.repository.getKnowledge(f.knowledgePath)!;
  f.repository.replaceFile({kind:'knowledge',record:{...old,path:'02知识库/新增.md',title:'新增'}});
  await expect(f.service.commit(preview.id)).rejects.toMatchObject({code:'TRASH_PREVIEW_STALE'});expect(f.counts().moves).toBe(0);
});

it('blocks active extraction and unfinished ingestion without cancelling or deleting them',async()=>{
  const f=fixture();const preview=await f.service.preview(source);const id=randomUUID();
  f.db.prepare('INSERT INTO personal_extraction_runs(id,preview_token,material_path,title,reading_state,source_raw_sha256,rule_fingerprint,model,created_at,status) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id,randomUUID(),source,'原文','未看',hash(original),'a'.repeat(64),'test',new Date().toISOString(),'generating');
  await expect(f.service.commit(preview.id)).rejects.toMatchObject({code:'RUN_ALREADY_ACTIVE'});
  f.db.prepare("UPDATE personal_extraction_runs SET status='cancelled' WHERE id=?").run(id);
  f.db.prepare('INSERT INTO personal_ingestion_batches VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,new Date().toISOString(),'needs-review',0,JSON.stringify({materialPath:source,files:[]}),'需恢复');
  await expect(f.service.commit(preview.id)).rejects.toMatchObject({code:'RECOVERY_REQUIRED'});expect(f.counts().moves).toBe(0);
});

it('does not overwrite a file created at the original path before restore',async()=>{
  const f=fixture();const preview=await f.service.preview(source);await f.service.commit(preview.id);
  const replacement={bytes:Buffer.from('新资料'),ino:'99'};f.files.set(source,replacement);
  await expect(f.service.restore(preview.id)).rejects.toMatchObject({code:'TRASH_RESTORE_CONFLICT'});
  expect(f.files.get(source)).toBe(replacement);expect(f.trash.get(preview.id)?.bytes).toEqual(original);expect(f.service.get(preview.id).status).toBe('trashed');
});

it('reconciles a move whose response was lost without moving again',async()=>{
  const f=fixture();const preview=await f.service.preview(source);f.setFailAfterMove();
  expect(await f.service.commit(preview.id)).toMatchObject({status:'needs-review'});
  const reopened=f.make();await reopened.recover();expect(reopened.get(preview.id)).toMatchObject({status:'trashed'});
  expect(await reopened.retry(preview.id)).toMatchObject({status:'trashed',indexed:true});expect(f.counts().moves).toBe(1);
});

it('never automatically moves an original from an interrupted pre-move intent',async()=>{
  const f=fixture();const preview=await f.service.preview(source);await f.service.commit(preview.id);
  f.files.set(source,f.trash.get(preview.id)!);f.trash.delete(preview.id);
  f.db.prepare("UPDATE personal_trash_entries SET status='moving' WHERE id=?").run(preview.id);
  const reopened=f.make();await reopened.recover();expect(reopened.get(preview.id)).toMatchObject({status:'moving'});expect(f.files.get(source)?.bytes).toEqual(original);
  expect(await reopened.retry(preview.id)).toMatchObject({status:'trashed'});expect(f.counts().moves).toBe(2);
});

it('keeps both versions and refuses recovery when the recycled file changed',async()=>{
  const f=fixture();const preview=await f.service.preview(source);await f.service.commit(preview.id);f.trash.get(preview.id)!.bytes=Buffer.from('外部改动');
  expect(await f.service.restore(preview.id)).toMatchObject({status:'needs-review'});expect(f.files.has(source)).toBe(false);
  expect(await f.service.retry(preview.id)).toMatchObject({status:'needs-review'});expect(f.counts().restores).toBe(0);
});

it('retries indexing without repeating a move or a restore',async()=>{
  const f=fixture();f.setRefresh(false);const preview=await f.service.preview(source);
  expect(await f.service.commit(preview.id)).toMatchObject({status:'trashed',indexed:false});f.setRefresh(true);
  expect(await f.service.retry(preview.id)).toMatchObject({status:'trashed',indexed:true});expect(f.counts().moves).toBe(1);
});

it('keeps runs completed after trash preview out of the queue once the confirmed source is permanently deleted',async()=>{
  let time='2026-09-07T00:00:00.000Z';const f=fixture(()=>new Date(time));const preview=await f.service.preview(source,'queue');
  const runId=randomUUID();
  f.db.prepare('INSERT INTO personal_extraction_runs(id,preview_token,material_path,title,reading_state,source_raw_sha256,rule_fingerprint,model,created_at,status,result_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(runId,randomUUID(),source,'原文','未看',hash(original),'a'.repeat(64),'test','2026-09-07T00:01:00.000Z','ready',JSON.stringify({candidates:[]}));
  time='2026-09-07T00:02:00.000Z';await f.service.commit(preview.id);
  const deletion=await f.service.previewDelete(preview.id);expect(await f.service.delete(preview.id,deletion.token)).toMatchObject({status:'deleted'});
  const queue=createExtractionQueueService({database:f.db,repository:f.repository});
  expect(queue.source(source).item).toBeNull();
  expect(queue.history({materialPath:source}).items).toEqual([expect.objectContaining({id:runId})]);
  expect(f.service.get(preview.id).createdAt).toBe('2026-09-07T00:02:00.000Z');
});

it('reuses the durable confirmation time and exact intent if SQLite failed before registering the move',async()=>{
  let time='2026-09-07T00:00:00.000Z';const f=fixture(()=>new Date(time));const preview=await f.service.preview(source);
  time='2026-09-07T00:01:00.000Z';
  f.db.exec("CREATE TRIGGER fail_trash_insert BEFORE INSERT ON personal_trash_entries BEGIN SELECT RAISE(ABORT,'isolated disk failure'); END;");
  await expect(f.service.commit(preview.id)).rejects.toThrow('isolated disk failure');expect(f.counts().moves).toBe(0);expect(f.records.size).toBe(1);
  const intent=Buffer.from(f.records.get(`${preview.id}.intent.json`)!);
  expect(JSON.parse(intent.toString()).createdAt).toBe('2026-09-07T00:01:00.000Z');
  time='2026-09-07T00:02:00.000Z';
  f.db.exec('DROP TRIGGER fail_trash_insert');expect(await f.service.commit(preview.id)).toMatchObject({status:'trashed'});expect(f.records.size).toBe(1);
  expect(f.records.get(`${preview.id}.intent.json`)).toEqual(intent);
  expect(f.service.get(preview.id).createdAt).toBe('2026-09-07T00:01:00.000Z');
});

it('does not mark an already indexed recycle entry stale on every restart',async()=>{
  const f=fixture();const preview=await f.service.preview(source);await f.service.commit(preview.id);
  const reopened=f.make();await reopened.recover();expect(reopened.get(preview.id)).toMatchObject({status:'trashed',indexed:true});
});

it('preserves a truncated orphan intent without disabling other complete recycled originals',async()=>{
  const f=fixture();const preview=await f.service.preview(source);await f.service.commit(preview.id);
  const brokenId=randomUUID();f.records.set(`${brokenId}.intent.json`,Buffer.from('{"version":1,'));
  const reopened=f.make();await expect(reopened.recover()).resolves.toBeUndefined();
  expect(reopened.get(preview.id)).toMatchObject({status:'trashed'});expect(await reopened.restore(preview.id)).toMatchObject({status:'restored'});
  expect(f.files.get(source)?.bytes).toEqual(original);expect(f.records.get(`${brokenId}.intent.json`)?.toString()).toBe('{"version":1,');
});

it('does not report an in-flight confirmed request as an unregistered operation',async()=>{
  const f=fixture();const preview=await f.service.preview(source);const release=f.pauseRules();const pending=f.service.commit(preview.id);
  try{expect(()=>f.service.get(preview.id)).toThrow(expect.objectContaining({code:'TRASH_BUSY'}));}finally{release();await pending;}
  expect(f.service.get(preview.id)).toMatchObject({status:'trashed'});
});

it('permanently deletes only after a bound preview and preserves knowledge and queue records',async()=>{
  const f=fixture();const move=await f.service.preview(source);await f.service.commit(move.id);
  const knowledge=f.repository.getKnowledge(f.knowledgePath);f.db.prepare('INSERT INTO personal_queue_visibility VALUES (?,?)').run(source,new Date().toISOString());
  const preview=await f.service.previewDelete(move.id);
  expect(preview).toMatchObject({id:move.id,bytes:original.length,referencedKnowledge:[{path:f.knowledgePath,title:'知识'}]});
  expect(f.purges()).toBe(0);expect(f.records.has(`${move.id}.delete.json`)).toBe(false);
  await expect(f.service.delete(move.id,randomUUID())).rejects.toMatchObject({code:'TRASH_DELETE_PREVIEW_STALE'});
  const deleted=await f.service.delete(move.id,preview.token);
  expect(deleted).toMatchObject({id:move.id,status:'deleted',indexed:true,deletedAt:expect.any(String)});
  expect(f.trash.has(move.id)).toBe(false);expect(f.files.has(source)).toBe(false);expect(f.purges()).toBe(1);
  expect(await f.service.delete(move.id,preview.token)).toEqual(deleted);expect(f.purges()).toBe(1);
  await expect(f.service.restore(move.id)).rejects.toMatchObject({code:'TRASH_DELETED'});
  const reopened=f.make();await reopened.recover();expect(reopened.get(move.id)).toEqual(deleted);
  expect(f.repository.getKnowledge(f.knowledgePath)).toEqual(knowledge);expect(f.db.prepare('SELECT * FROM personal_queue_visibility').all()).toHaveLength(1);
  expect(readMaterialVisibility(f.db).trashed.has(source)).toBe(false);
});

it.each(['rules','content','references'])('rejects a permanent-delete preview after %s change',async(kind)=>{
  const f=fixture();const move=await f.service.preview(source);await f.service.commit(move.id);const preview=await f.service.previewDelete(move.id);
  if(kind==='rules')f.setRules('d'.repeat(64));
  if(kind==='content')f.trash.get(move.id)!.bytes=Buffer.from('改后的原文');
  if(kind==='references')f.repository.replaceFile({kind:'knowledge',record:{...f.repository.getKnowledge(f.knowledgePath)!,path:'02知识库/新引用.md'}});
  await expect(f.service.delete(move.id,preview.token)).rejects.toMatchObject({code:'TRASH_DELETE_PREVIEW_STALE'});
  expect(f.purges()).toBe(0);expect(f.trash.has(move.id)).toBe(true);expect(f.records.has(`${move.id}.delete.json`)).toBe(false);
});

it('does not auto-delete pending deletion on restart or generic retry and blocks restore',async()=>{
  const f=fixture();const move=await f.service.preview(source);await f.service.commit(move.id);const preview=await f.service.previewDelete(move.id);f.setFailPurge(true);
  expect(await f.service.delete(move.id,preview.token)).toMatchObject({status:'deleting'});
  const reopened=f.make();await reopened.recover();expect(reopened.get(move.id).status).toBe('deleting');
  expect(await reopened.retry(move.id)).toMatchObject({status:'deleting'});expect(f.purges()).toBe(0);expect(f.trash.has(move.id)).toBe(true);
  await expect(reopened.restore(move.id)).rejects.toMatchObject({code:'TRASH_DELETE_PENDING'});
  const retry=await reopened.previewDelete(move.id);expect(retry.token).not.toBe(preview.token);f.setFailPurge(false);
  expect(await reopened.delete(move.id,retry.token)).toMatchObject({status:'deleted'});expect(f.purges()).toBe(1);
});

it('reconciles a lost delete outcome without repeating deletion or touching a replacement at the old path',async()=>{
  const f=fixture();const move=await f.service.preview(source);await f.service.commit(move.id);const preview=await f.service.previewDelete(move.id);f.setFailAfterPurge();
  expect(await f.service.delete(move.id,preview.token)).toMatchObject({status:'deleting'});
  const replacement={bytes:Buffer.from(original),ino:'99'};f.files.set(source,replacement);
  const reopened=f.make();await reopened.recover();expect(reopened.get(move.id)).toMatchObject({status:'deleted'});expect(f.files.get(source)).toBe(replacement);
  expect(f.purges()).toBe(1);expect(readMaterialVisibility(f.db).trashed.has(source)).toBe(false);
  const next=await reopened.preview(source);expect(await reopened.commit(next.id)).toMatchObject({status:'trashed'});expect(f.trash.get(next.id)?.ino).toBe('99');
});

it('does not infer a successful deletion from a missing trash file without deletion intent',async()=>{
  const f=fixture();const move=await f.service.preview(source);await f.service.commit(move.id);f.trash.delete(move.id);
  const reopened=f.make();await reopened.recover();expect(reopened.get(move.id)).toMatchObject({status:'needs-review'});expect(f.purges()).toBe(0);
});

it('forbids permanently deleting restored items or replacing a confirmed target',async()=>{
  const f=fixture();const move=await f.service.preview(source);await f.service.commit(move.id);const preview=await f.service.previewDelete(move.id);await f.service.restore(move.id);
  await expect(f.service.delete(move.id,preview.token)).rejects.toMatchObject({code:'TRASH_DELETE_NOT_ALLOWED'});expect(f.files.get(source)?.bytes).toEqual(original);expect(f.purges()).toBe(0);
});

it('never restores a file with a durable deletion intent even if the DB state update was interrupted',async()=>{
  const f=fixture();const move=await f.service.preview(source);await f.service.commit(move.id);const preview=await f.service.previewDelete(move.id);f.setFailPurge(true);await f.service.delete(move.id,preview.token);
  f.db.prepare("UPDATE personal_trash_entries SET status='trashed',delete_manifest_json=NULL WHERE id=?").run(move.id);
  expect(f.service.get(move.id)).toMatchObject({status:'deleting'});
  await expect(f.service.restore(move.id)).rejects.toMatchObject({code:'TRASH_DELETE_PENDING'});expect(f.files.has(source)).toBe(false);
  const reopened=f.make();await reopened.recover();expect(reopened.get(move.id)).toMatchObject({status:'deleting'});expect(f.purges()).toBe(0);
});

it('reports busy while a delete confirmation is suspended before its durable intent',async()=>{
  const f=fixture();const move=await f.service.preview(source);await f.service.commit(move.id);const preview=await f.service.previewDelete(move.id);const release=f.pauseRules();const pending=f.service.delete(move.id,preview.token);
  try{expect(()=>f.service.get(move.id)).toThrow(expect.objectContaining({code:'TRASH_BUSY'}));expect(f.purges()).toBe(0);}finally{release();await pending;}
  expect(f.service.get(move.id)).toMatchObject({status:'deleted'});
});

it('retries only indexing after successful deletion and keeps deleted unavailable for restore',async()=>{
  const f=fixture();const move=await f.service.preview(source);await f.service.commit(move.id);const preview=await f.service.previewDelete(move.id);f.setRefresh(false);
  expect(await f.service.delete(move.id,preview.token)).toMatchObject({status:'deleted',indexed:false});f.setRefresh(true);
  expect(await f.service.retry(move.id)).toMatchObject({status:'deleted',indexed:true});expect(f.purges()).toBe(1);
  await expect(f.service.restore(move.id)).rejects.toMatchObject({code:'TRASH_DELETED'});
});

it('does not reauthorize an old delete request merely by previewing changed references',async()=>{
  const f=fixture();const move=await f.service.preview(source);await f.service.commit(move.id);const first=await f.service.previewDelete(move.id);f.setFailPurge(true);await f.service.delete(move.id,first.token);
  f.repository.replaceFile({kind:'knowledge',record:{...f.repository.getKnowledge(f.knowledgePath)!,path:'02知识库/后加引用.md'}});
  await expect(f.service.delete(move.id,first.token)).rejects.toMatchObject({code:'TRASH_DELETE_PREVIEW_STALE'});
  const next=await f.service.previewDelete(move.id);expect(next.token).not.toBe(first.token);expect(next.referencedKnowledge).toHaveLength(2);
  await expect(f.service.delete(move.id,first.token)).rejects.toMatchObject({code:'TRASH_DELETE_PREVIEW_STALE'});expect(f.purges()).toBe(0);
  expect(await f.service.delete(move.id,next.token)).toMatchObject({status:'deleting'});
  expect(f.records.has(`${move.id}.delete.json`)).toBe(true);expect(f.records.has(`${next.token}.delete.json`)).toBe(true);
  const reopened=f.make();await reopened.recover();
  await expect(reopened.delete(move.id,first.token)).rejects.toMatchObject({code:'TRASH_DELETE_PREVIEW_STALE'});f.setFailPurge(false);
  expect(await reopened.delete(move.id,next.token)).toMatchObject({status:'deleted'});expect(f.purges()).toBe(1);
});

it.each(['00大脑规则/SKILL.md','01图书馆/小兆clipper/原文.md','01图书馆/来自个人/../原文.md'])('rejects out-of-scope original %s',async(path)=>{
  const f=fixture();await expect(f.service.preview(path)).rejects.toMatchObject({code:'PATH_NOT_ALLOWED'});expect(f.counts().moves).toBe(0);
});
