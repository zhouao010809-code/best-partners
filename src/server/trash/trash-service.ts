import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PublicApiError } from '../../shared/api/errors.js';
import { trashDeletePreviewSchema, trashDocumentPathSchema, trashEntrySchema, trashIdSchema, trashOriginSchema, trashPreviewSchema, trashReferenceSchema, type TrashDeletePreview, type TrashEntry, type TrashOrigin, type TrashPreview } from '../../shared/api/trash.js';
import { canonicalJson, type IndexRepository } from '../index/index-repository.js';
import { parseKnowledgeNoteForRead, parseLibraryNoteForRead } from '../rules/read-compatible-notes.js';
import { validateFilesystemPath } from '../vault/filesystem-path.js';
import { sha256Bytes } from '../vault/raw-bytes.js';
import type { ArchiveStat } from '../archive/sandbox-native.js';
import type { PersonalTrashPort } from './trash-native.js';

const identitySchema = z.strictObject({ dev:z.string().regex(/^\d+$/u), ino:z.string().regex(/^\d+$/u) });
const manifestSchema = z.strictObject({
  version:z.literal(1), id:trashIdSchema, materialPath:z.string().min(1).max(1024), origin:trashOriginSchema.optional(), title:z.string().min(1).max(1000),
  createdAt:z.iso.datetime(), root:identitySchema, identity:identitySchema, sha256:z.string().regex(/^[a-f0-9]{64}$/u),
  bytes:z.number().int().nonnegative().max(10*1024*1024), ruleFingerprint:z.string().min(1),
  referencedKnowledge:z.array(trashReferenceSchema).max(10000)
});
type Manifest = z.output<typeof manifestSchema>;
const deletionSchema = z.strictObject({version:z.literal(1),id:trashIdSchema,token:trashIdSchema,confirmedAt:z.iso.datetime(),manifestSha256:z.string().regex(/^[a-f0-9]{64}$/u),ruleFingerprint:z.string().min(1),referencedKnowledge:z.array(trashReferenceSchema).max(10000)});
type Deletion = z.output<typeof deletionSchema>;
type Row = {id:string;material_path:string;title:string;created_at:string;status:TrashEntry['status'];manifest_json:string;problem:string|null;indexed:number;restored_at:string|null;delete_manifest_json:string|null;deleted_at:string|null};
const sameIdentity = (a:{dev:string;ino:string}|null,b:{dev:string;ino:string})=>a?.dev===b.dev&&a.ino===b.ino;
function fail(code:string,message:string,status=409):never {throw new PublicApiError(code,message,status);}
function allowedPath(path:string,origin?:TrashOrigin):TrashOrigin {
  try {validateFilesystemPath(path);trashDocumentPathSchema.parse(path);} catch {fail('PATH_NOT_ALLOWED','请选择已归档原始资料或知识库中的单个 Markdown 文件。',400);}
  const knowledge=path.startsWith('02知识库/');
  if(origin!==undefined&&(!trashOriginSchema.safeParse(origin).success||(knowledge?origin!=='knowledge':origin==='knowledge')))fail('TRASH_ORIGIN_MISMATCH','所选来源与文件位置不一致，请从对应页面重新预览。',400);
  return origin??(knowledge?'knowledge':'library');
}
function target(link:string) {return link.replace(/^\[\[/u,'').replace(/\]\]$/u,'').split('|')[0]!.split('#')[0]!.replace(/\.md$/u,'');}

export function createTrashService(input:{database:Database.Database;repository:IndexRepository;port:PersonalTrashPort;getRuleFingerprint():Promise<string>;refreshIndex():Promise<boolean>;now?:()=>Date}) {
  const db=input.database,port=input.port,now=input.now??(()=>new Date());
  const previews=new Map<string,{manifest:Manifest;expiresAt:string}>();
  const deletePreviews=new Map<string,{preview:TrashDeletePreview;ruleFingerprint:string}>();
  let closed=false,busy=false,running:Promise<unknown>|undefined,activeCommitId:string|undefined,activeDeleteId:string|undefined;
  async function exclusive<T>(task:()=>Promise<T>):Promise<T> {
    if(closed)fail('TRASH_CLOSED','应用正在关闭，请重新打开后操作。');
    if(busy)fail('TRASH_BUSY','正在处理回收操作，请稍后再试。');
    busy=true;const work=task();running=work;try{return await work;}finally{busy=false;if(running===work)running=undefined;}
  }
  function row(id:string):Row {
    trashIdSchema.parse(id);const value=db.prepare('SELECT * FROM personal_trash_entries WHERE id=?').get(id) as Row|undefined;
    if(!value&&activeCommitId===id)fail('TRASH_BUSY','本次确认仍在处理中，请稍后查询同一编号的结果。');
    if(!value)fail('TRASH_NOT_FOUND','本次回收尚未提交，可使用原预览确认。',404);return value;
  }
  function entryOrigin(value:Row):TrashOrigin {
    // An older intent is never reserialized to supply a display-only default.
    // A malformed journal must still leave its needs-review record readable.
    try {return trashOriginSchema.catch('library').parse(JSON.parse(value.manifest_json)?.origin);}catch{return 'library';}
  }
  function get(id:string):TrashEntry {const value=row(id);return trashEntrySchema.parse({id,materialPath:value.material_path,origin:entryOrigin(value),title:value.title,createdAt:value.created_at,status:value.status,indexed:value.indexed===1,
    ...(value.status==='restored'&&value.restored_at?{restoredAt:value.restored_at}:{}),...(value.status==='deleted'&&value.deleted_at?{deletedAt:value.deleted_at}:{}),...(value.problem?{problem:value.problem}:{})});}
  function query(id:string):TrashEntry {
    if(activeDeleteId===id)fail('TRASH_BUSY','本次删除确认仍在处理中，请稍后查询同一编号的结果。');
    const value=row(id);
    // A durable confirmation can precede its DB update. Never tell the UI it
    // was unregistered (and cancellable) just because that update was lost.
    if(value.status!=='deleted'&&value.status!=='restored'&&value.status!=='deleting'&&(value.delete_manifest_json||port.readRecovery(`${id}.delete.json`)))return reconcileDeletion(value)!;
    return get(id);
  }
  function list(){return {items:(db.prepare('SELECT id FROM personal_trash_entries ORDER BY created_at DESC,rowid DESC').all() as {id:string}[]).map(({id})=>get(id))};}
  function manifest(value:Row):Manifest {
    const data=manifestSchema.parse(JSON.parse(value.manifest_json));allowedPath(data.materialPath,data.origin);
    const durable=port.readRecovery(`${data.id}.intent.json`);
    if(data.id!==value.id||data.materialPath!==value.material_path||!sameIdentity(port.rootIdentity,data.root)||!durable||durable.toString('utf8')!==value.manifest_json)fail('TRASH_JOURNAL_CHANGED','回收记录与保留版本不一致，文件未再移动。');
    return data;
  }
  function assertIdle(path:string) {
    if(db.prepare("SELECT id FROM personal_extraction_runs WHERE material_path=? AND status='generating' LIMIT 1").get(path))fail('RUN_ALREADY_ACTIVE','这份资料正在提炼，请先在提炼队列停止本次提炼。');
    const batches=db.prepare("SELECT b.plan_json,r.material_path FROM personal_ingestion_batches b LEFT JOIN personal_extraction_runs r ON r.id=b.run_id WHERE b.status!='committed'").all() as {plan_json:string;material_path:string|null}[];
    if(batches.some((batch)=>{if(batch.material_path===path)return true;const plan=JSON.parse(batch.plan_json) as {materialPath?:string;files?:{path:string}[]};return plan.materialPath===path||plan.files?.some((file)=>file.path===path);}))fail('RECOVERY_REQUIRED','这份资料仍有未完成入库，请先在 App 完成该批恢复。');
  }
  function references(path:string) {
    const exact=target(path),base=exact.split('/').at(-1);const result:{path:string;title:string}[]=[];
    for(let page=1;;page++){
      const part=input.repository.listKnowledge({includeObsolete:true,page,pageSize:200});
      for(const item of part.items)if(item.sourceMaterials.some((link)=>{const candidate=target(link);return candidate===exact||candidate===base;}))result.push({path:item.path,title:item.title});
      if(page*part.pageSize>=part.total||!part.items.length)break;
    }
    return result.sort((a,b)=>a.path.localeCompare(b.path));
  }
  function current(path:string):{stat:ArchiveStat;bytes:Buffer} {
    const before=port.stat(path),bytes=port.read(path),after=port.stat(path);
    if(!before||before.kind!=='file'||!bytes||bytes.length>10*1024*1024||!sameIdentity(after,before)||after?.size!==before.size||bytes.length!==before.size)fail('TRASH_SOURCE_CHANGED','原资料已变化或无法读取，请刷新后重新预览。');
    return {stat:before,bytes};
  }
  async function preview(path:string,requestedOrigin?:TrashOrigin):Promise<TrashPreview> {
    return exclusive(async()=>{
      const origin=allowedPath(path,requestedOrigin);assertIdle(path);
      if(db.prepare("SELECT id FROM personal_trash_entries WHERE material_path=? AND status NOT IN ('restored','deleted')").get(path))fail('TRASH_ALREADY_PENDING','这份资料已有回收记录，请前往回收站查看或继续核验。');
      const ruleFingerprint=await input.getRuleFingerprint();assertIdle(path);
      const file=current(path);const note=origin==='knowledge'?parseKnowledgeNoteForRead(file.bytes,path).record:parseLibraryNoteForRead(file.bytes,path).record;
      if(!note||('processingStatus' in note&&note.processingStatus!=='已归档'))fail('TRASH_SOURCE_UNAVAILABLE',origin==='knowledge'?'请先确认这是一份有效的知识笔记。':'请先确认这是一份已归档原始资料。');
      const id=randomUUID(),createdAt=now().toISOString(),expiresAt=new Date(now().getTime()+600_000).toISOString();
      const data=manifestSchema.parse({version:1,id,materialPath:path,origin,title:note.title,createdAt,root:port.rootIdentity,identity:{dev:file.stat.dev,ino:file.stat.ino},sha256:sha256Bytes(file.bytes),bytes:file.bytes.length,ruleFingerprint,referencedKnowledge:references(path)});
      for(const [key,value] of previews)if(Date.parse(value.expiresAt)<=now().getTime())previews.delete(key);
      if(previews.size>=100)previews.delete(previews.keys().next().value!);
      previews.set(id,{manifest:data,expiresAt});
      return trashPreviewSchema.parse({id,materialPath:path,origin,title:note.title,bytes:data.bytes,referencedKnowledge:data.referencedKnowledge,expiresAt});
    });
  }
  async function refresh(id:string) {
    let indexed=false;try{indexed=await input.refreshIndex();}catch{/* File outcome remains recorded. */}
    db.prepare('UPDATE personal_trash_entries SET indexed=? WHERE id=?').run(indexed?1:0,id);return get(id);
  }
  function mark(id:string,status:TrashEntry['status'],problem:string|null=null) {
    db.prepare('UPDATE personal_trash_entries SET status=?,problem=?,indexed=0 WHERE id=?').run(status,problem,id);
  }
  function observed(data:Manifest) {
    const sourceStat=port.stat(data.materialPath),trashStat=port.statItem(data.id);
    const sourceBytes=sourceStat?port.read(data.materialPath):null,trashBytes=trashStat?port.readItem(data.id):null;
    const matches=(stat:ArchiveStat|null,bytes:Buffer|null)=>sameIdentity(stat,data.identity)&&stat?.size===data.bytes&&bytes!==null&&sha256Bytes(bytes)===data.sha256;
    return {sourceStat,trashStat,sourceMatches:matches(sourceStat,sourceBytes),trashMatches:matches(trashStat,trashBytes)};
  }
  function verify(value:Row,data:Manifest):'source'|'trash'|'unknown' {
    const seen=observed(data);
    if(!seen.sourceStat&&seen.trashMatches)return 'trash';
    if(seen.sourceMatches&&!seen.trashStat)return 'source';
    // An unrelated file at the old path is not a lost trash item; it is a restore collision.
    if(seen.trashMatches&&value.status==='trashed')return 'trash';
    return 'unknown';
  }
  function reconcile(value:Row):TrashEntry {
    if(value.status==='restored'||value.status==='deleted')return get(value.id);
    const deleted=reconcileDeletion(value);if(deleted)return deleted;
    try{
      const data=manifest(value),state=verify(value,data);
      if(state==='trash'){if(value.status!=='trashed'||value.problem!==null)mark(value.id,'trashed');}
      else if(state==='source'&&value.restored_at)mark(value.id,'restored');
      else if(state==='source'&&(value.status==='moving'||value.status==='needs-review'))mark(value.id,'moving','上次回收尚未移动文件，可继续核验。');
      else mark(value.id,'needs-review','文件状态与回收记录不一致，现有版本已保留，未覆盖任何文件。');
    }catch{mark(value.id,'needs-review','暂时无法核验回收文件或记录，文件保持原状，请重试。');}
    return get(value.id);
  }
  async function moveConfirmed(value:Row):Promise<TrashEntry> {
    const data=manifest(value);assertIdle(data.materialPath);
    if(verify(value,data)!=='source')return reconcile(value);
    try{port.move(data.materialPath,data.id,data.identity);if(verify({...value,status:'moving'},data)!=='trash')throw Error('TRASH_NEEDS_REVIEW');mark(data.id,'trashed');}
    catch{mark(data.id,'needs-review','回收尚未核验完成，文件与记录已保留。请继续核验，不要重复新建回收操作。');return get(data.id);}
    return refresh(data.id);
  }
  async function commit(id:string):Promise<TrashEntry> {
    return exclusive(async()=>{
      trashIdSchema.parse(id);
      activeCommitId=id;
      try {
      if(db.prepare('SELECT id FROM personal_trash_entries WHERE id=?').get(id))return get(id);
      const pending=previews.get(id);if(!pending||Date.parse(pending.expiresAt)<=now().getTime())fail('TRASH_PREVIEW_STALE','回收预览已过期，请重新预览。');
      const data=pending.manifest;
      if(await input.getRuleFingerprint()!==data.ruleFingerprint)fail('TRASH_PREVIEW_STALE','规则已变化，请重新核对回收预览。');
      assertIdle(data.materialPath);
      const file=current(data.materialPath);
      if(!sameIdentity(file.stat,data.identity)||sha256Bytes(file.bytes)!==data.sha256||canonicalJson(references(data.materialPath))!==canonicalJson(data.referencedKnowledge))fail('TRASH_PREVIEW_STALE','原文或已有知识引用已变化，请重新预览。');
      if(db.prepare("SELECT id FROM personal_trash_entries WHERE material_path=? AND status NOT IN ('restored','deleted')").get(data.materialPath))fail('TRASH_ALREADY_PENDING','这份资料已有回收记录，请前往回收站。');
      const persisted=port.readRecovery(`${id}.intent.json`);
      // Queue history ends at confirmation, including runs finished since preview.
      // Keep that timestamp in the pending object if the durable intent precedes a DB failure.
      if(!persisted)data.createdAt=now().toISOString();
      const json=JSON.stringify(data);
      if(persisted&&persisted.toString('utf8')!==json)fail('TRASH_JOURNAL_CHANGED','已有回收意图与本次预览不一致，未移动文件。');
      if(!persisted)port.writeRecovery(`${id}.intent.json`,Buffer.from(json));
      db.prepare("INSERT INTO personal_trash_entries(id,material_path,title,created_at,status,manifest_json) VALUES(?,?,?,?,'moving',?)").run(id,data.materialPath,data.title,data.createdAt,json);
      previews.delete(id);return moveConfirmed(row(id));
      } finally { activeCommitId=undefined; }
    });
  }
  async function restore(id:string):Promise<TrashEntry> {
    return exclusive(async()=>{
      let value=row(id);
      if(value.status==='deleted')fail('TRASH_DELETED','该回收文件已彻底删除，无法从 App 恢复。');
      if(value.status==='deleting'||value.delete_manifest_json||port.readRecovery(`${id}.delete.json`))fail('TRASH_DELETE_PENDING','这份资料已有彻底删除确认，请先查询本次删除结果，不能同时恢复。');
      if(value.status==='restored')return value.indexed?get(id):refresh(id);
      const data=manifest(value);assertIdle(data.materialPath);
      if(value.status!=='trashed'){reconcile(value);value=row(id);if(value.status==='restored')return refresh(id);if(value.status!=='trashed')return get(id);}
      if(port.stat(data.materialPath))fail('TRASH_RESTORE_CONFLICT','原位置已有同名文件，未覆盖。回收站中的原文仍保留，请先在原始资料中核对。');
      if(!observed(data).trashMatches){mark(id,'needs-review','回收文件已被外部修改，原文未覆盖，请核验保留版本。');return get(id);}
      db.prepare("UPDATE personal_trash_entries SET status='restoring',restored_at=?,indexed=0,problem=NULL WHERE id=?").run(now().toISOString(),id);
      try{port.restore(id,data.materialPath,data.identity);if(verify(row(id),data)!=='source')throw Error('TRASH_NEEDS_REVIEW');mark(id,'restored');}
      catch(error){
        const code=error instanceof Error?error.message:'';
        if(['TARGET_EXISTS','NOT_FOUND'].includes(code)){mark(id,'trashed',code==='NOT_FOUND'?'原位置的父目录不存在，原文仍在回收站。':'原位置出现同名文件，原文仍在回收站，未覆盖。');}
        else mark(id,'needs-review','恢复尚未核验完成，两个位置均未清理，请继续核验。');
        return get(id);
      }
      return refresh(id);
    });
  }
  async function retry(id:string):Promise<TrashEntry> {
    return exclusive(async()=>{
      const before=row(id);if(before.status==='restored'||before.status==='deleted')return before.indexed?get(id):refresh(id);
      const entry=reconcile(before);if(entry.status==='moving')return moveConfirmed(row(id));
      if(entry.status==='trashed'||entry.status==='restored'||entry.status==='deleted')return refresh(id);
      return entry;
    });
  }

  function deletion(value:Row,token?:string):Deletion|undefined {
    const bytes=port.readRecovery(`${value.id}.delete.json`);
    if(!bytes){if(value.delete_manifest_json||value.status==='deleting')fail('TRASH_DELETE_JOURNAL_CHANGED','删除确认记录缺失，未继续删除或恢复。');return undefined;}
    manifest(value);
    const parse=(saved:Buffer):Deletion=>{
      const data=deletionSchema.parse(JSON.parse(saved.toString('utf8')));
      if(data.id!==value.id||data.manifestSha256!==sha256Bytes(Buffer.from(value.manifest_json)))fail('TRASH_DELETE_JOURNAL_CHANGED','删除确认与回收记录不一致，文件保持原状。');
      return data;
    };
    const first=parse(bytes);
    // Each explicit re-confirmation gets its own immutable sidecar. Reading a
    // newer preview must never change the authority of an older request token.
    if(token===first.token)return first;
    if(token){
      const saved=port.readRecovery(`${token}.delete.json`);if(!saved)return undefined;
      const data=parse(saved);if(data.token!==token)fail('TRASH_DELETE_JOURNAL_CHANGED','删除确认编号不匹配，文件保持原状。');return data;
    }
    if(!value.delete_manifest_json||value.delete_manifest_json===bytes.toString('utf8'))return first;
    const latest=parse(Buffer.from(value.delete_manifest_json));
    const saved=port.readRecovery(`${latest.token}.delete.json`);
    if(!saved||saved.toString('utf8')!==value.delete_manifest_json)fail('TRASH_DELETE_JOURNAL_CHANGED','删除确认记录不一致，文件保持原状。');
    return latest;
  }
  function recycledBytes(data:Manifest):Buffer {
    const before=port.statItem(data.id),bytes=port.readItem(data.id),after=port.statItem(data.id);
    if(!before||before.kind!=='file'||!bytes||!sameIdentity(before,data.identity)||!sameIdentity(after,data.identity)||before.size!==data.bytes||after?.size!==data.bytes||sha256Bytes(bytes)!==data.sha256)fail('TRASH_DELETE_PREVIEW_STALE','回收文件已变化或无法核验，请重新核对；尚未彻底删除。');
    return bytes;
  }
  function finishDeletion(id:string) {
    const data=manifest(row(id));
    db.transaction(()=>{
      // An unindexed external edit can make the saved projection older than
      // the deleted bytes. A verified absent source makes any projection stale;
      // a stat error must abort this transaction without clearing that index.
      if(input.repository.getManifestEntry(data.materialPath)?.rawSha256===data.sha256||port.stat(data.materialPath)===null)input.repository.removeFile(data.materialPath);
      db.prepare("UPDATE personal_trash_entries SET status='deleted',deleted_at=COALESCE(deleted_at,?),problem=NULL,indexed=0 WHERE id=?").run(now().toISOString(),id);
    }).immediate();
  }
  /** Reconcile only. A startup or ordinary retry must never unlink a file. */
  function reconcileDeletion(value:Row):TrashEntry|undefined {
    try {
      const confirmed=deletion(value);if(!confirmed)return undefined;
      db.prepare("UPDATE personal_trash_entries SET status='deleting',delete_manifest_json=? WHERE id=?").run(JSON.stringify(confirmed),value.id);
      if(!port.statItem(value.id))finishDeletion(value.id);
      else {recycledBytes(manifest(value));mark(value.id,'deleting','上次删除尚未完成；文件仍保留，请重新打开“彻底删除”并确认。');}
    } catch {
      mark(value.id,'deleting','暂时无法核验删除确认或文件内容，未继续删除，也未恢复文件。');
    }
    return get(value.id);
  }
  async function previewDelete(id:string):Promise<TrashDeletePreview> {
    return exclusive(async()=>{
      const value=row(id);
      if(!['trashed','deleting'].includes(value.status))fail('TRASH_DELETE_NOT_ALLOWED','只能彻底删除回收站中已完成回收的文件。');
      const data=manifest(value);assertIdle(data.materialPath);
      const ruleFingerprint=await input.getRuleFingerprint();assertIdle(data.materialPath);recycledBytes(data);
      deletion(value);const token=randomUUID();
      const preview=trashDeletePreviewSchema.parse({id,token,materialPath:data.materialPath,origin:data.origin??'library',title:data.title,bytes:data.bytes,referencedKnowledge:references(data.materialPath),expiresAt:new Date(now().getTime()+600_000).toISOString()});
      for(const [key,item] of deletePreviews)if(Date.parse(item.preview.expiresAt)<=now().getTime())deletePreviews.delete(key);
      if(deletePreviews.size>=100)deletePreviews.delete(deletePreviews.keys().next().value!);
      deletePreviews.set(token,{preview,ruleFingerprint});return preview;
    });
  }
  async function permanentlyDelete(id:string,token:string):Promise<TrashEntry> {
    return exclusive(async()=>{
      trashIdSchema.parse(id);trashIdSchema.parse(token);activeDeleteId=id;
      try {
        const value=row(id);if(value.status==='deleted')return value.indexed?get(id):refresh(id);
        if(!['trashed','deleting'].includes(value.status))fail('TRASH_DELETE_NOT_ALLOWED','这份资料当前不可彻底删除，请先核对回收状态。');
        const data=manifest(value),previous=deletion(value);let confirmed=deletion(value,token);
        const pending=deletePreviews.get(token);
        // A persisted confirmation can be resumed with its original token. A
        // new, unconfirmed token always needs a fresh in-memory preview.
        if(!confirmed&&(!pending||pending.preview.id!==id||Date.parse(pending.preview.expiresAt)<=now().getTime()))fail('TRASH_DELETE_PREVIEW_STALE','删除预览已过期或不属于本条资料，请重新预览。');
        const currentRules=await input.getRuleFingerprint();assertIdle(data.materialPath);
        const approvedRules=confirmed?.ruleFingerprint??pending?.ruleFingerprint;
        const approvedReferences=confirmed?.referencedKnowledge??pending?.preview.referencedKnowledge;
        if(currentRules!==approvedRules||canonicalJson(references(data.materialPath))!==canonicalJson(approvedReferences))fail('TRASH_DELETE_PREVIEW_STALE','规则或已有知识引用发生变化，请重新核对删除预览。');
        if(confirmed&&!port.statItem(id)){finishDeletion(id);return refresh(id);}
        const bytes=recycledBytes(data);
        if(!confirmed){
          confirmed=deletionSchema.parse({version:1,id,token,confirmedAt:now().toISOString(),manifestSha256:sha256Bytes(Buffer.from(value.manifest_json)),ruleFingerprint:currentRules,referencedKnowledge:approvedReferences});
          port.writeRecovery(`${previous?token:id}.delete.json`,Buffer.from(JSON.stringify(confirmed)));
        }
        db.prepare("UPDATE personal_trash_entries SET status='deleting',delete_manifest_json=?,problem=NULL,indexed=0 WHERE id=?").run(JSON.stringify(confirmed),id);
        deletePreviews.delete(token);
        try {
          port.purge(id,data.identity,bytes);
          if(port.statItem(id))throw Error('TRASH_DELETE_NEEDS_REVIEW');
        } catch {
          mark(id,'deleting','尚未收到明确删除结果，请查询同一条记录；文件仍在时需再次确认删除。');return get(id);
        }
        finishDeletion(id);return refresh(id);
      } finally {activeDeleteId=undefined;}
    });
  }
  async function recover():Promise<void> {
    return exclusive(async()=>{
      // Rehydrate only durable, explicitly confirmed intents; previews never create journals.
      for(const name of port.listRecovery()){
        const match=/^([a-f0-9-]+)\.intent\.json$/u.exec(name);if(!match||!trashIdSchema.safeParse(match[1]).success)continue;
        if(db.prepare('SELECT id FROM personal_trash_entries WHERE id=?').get(match[1]!))continue;
        let data:Manifest,bytes:Buffer;
        try {
          const saved=port.readRecovery(name);if(!saved)continue;bytes=saved;
          data=manifestSchema.parse(JSON.parse(bytes.toString('utf8')));allowedPath(data.materialPath,data.origin);
          if(data.id!==match[1]||!sameIdentity(port.rootIdentity,data.root))continue;
        } catch {
          // A crash while writing the first immutable intent can leave a partial
          // file before any DB row or move exists. Retain it; other items work.
          continue;
        }
        // Never invent an operation after a completed path has already been recycled again.
        if(db.prepare("SELECT id FROM personal_trash_entries WHERE material_path=? AND status NOT IN ('restored','deleted')").get(data.materialPath))continue;
        db.prepare("INSERT INTO personal_trash_entries(id,material_path,title,created_at,status,manifest_json) VALUES(?,?,?,?,'moving',?)").run(data.id,data.materialPath,data.title,data.createdAt,bytes.toString('utf8'));
      }
      for(const value of db.prepare("SELECT * FROM personal_trash_entries WHERE status NOT IN ('restored','deleted')").all() as Row[])reconcile(value);
    });
  }
  async function close(){closed=true;try{await running;}catch{/* Durable operation stays available on restart. */}}
  return {preview,commit,list,get:query,restore,retry,previewDelete,delete:permanentlyDelete,recover,close};
}
export type TrashService=ReturnType<typeof createTrashService>;
