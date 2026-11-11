import Database from 'better-sqlite3'
import fs from 'node:fs'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { beforeEach, afterEach, expect, it } from 'vitest'
import sql from '../../src/shared/contracts/001-core.sql?raw'
import { StorageLifecycle } from '../../src/runtime/storage-lifecycle'
import { PluginUploads } from '../../src/runtime/plugins/uploads'
import { digest } from '../../src/runtime/resources'
import type { PluginIdentity } from '../../src/runtime/plugins/process'
let root:string,db:Database.Database,storage:StorageLifecycle,uploads:PluginUploads,valid:boolean,task:string,call:string,identity:PluginIdentity
const body=Buffer.from('完整上传 fixture')
function begin():any{return uploads.handle(identity,'upload.begin',{task_id:task,owner_id:call,byte_length:body.length,sha256:digest(body),media_type:'text/plain; charset=utf-8',display_name:'fixture.txt'})}
function chunk(id:string,offset=0,data=body):any{return uploads.handle(identity,'upload.chunk',{upload_id:id,offset,base64:data.toString('base64')})}
function finish(id:string):any{return uploads.handle(identity,'upload.finish',{upload_id:id})}
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'pliuna-plugin-upload-'));mkdirSync(join(root,'resources'));db=new Database(join(root,'db.sqlite'));db.exec(sql);task=randomUUID();call=randomUUID();identity={instance_id:randomUUID(),digest:'a'.repeat(64),task_id:task,call_id:call};valid=true;db.prepare("INSERT INTO tasks VALUES (?, 'fixture','active',1,1)").run(task);db.prepare("INSERT INTO calls (id,task_id,capability_id,state,dispatch,delivery,input_json,limits_json,commit_valid,created_at) VALUES (?,?,'fixture','executing','sent','pending','{}','{}',1,'now')").run(call,task);storage=new StorageLifecycle(db,root,'epoch',(action,t)=>uploads.owns(action,t));uploads=new PluginUploads(db,root,'epoch',storage,(i,t,c)=>{if(!valid||i.instance_id!==identity.instance_id||t!==task||c!==call)throw Error('source invalid')},()=>{})})
afterEach(()=>{uploads.close();storage.close();db.close();rmSync(root,{recursive:true,force:true})})
it('prepares an upload without publishing, then hands pin and resource off in one transaction',async()=>{
 const u=begin();chunk(u.upload_id);expect(await finish(u.upload_id)).toMatchObject({state:'prepared',published:false});expect(db.prepare('SELECT * FROM resources').all()).toEqual([])
 const resources=db.transaction(()=>uploads.commit(call))();uploads.settled(call,true)
 expect(resources).toMatchObject([{id:u.resource_id,sha256:digest(body)}]);expect(db.prepare('SELECT state FROM staging').get()).toEqual({state:'committed'});expect(db.prepare('SELECT result FROM actions').get()).toEqual({result:'success'});expect(fs.readFileSync(join(root,'resources',u.resource_id))).toEqual(body)
})
it.each(['duplicate','offset','hash','incomplete'])('rejects %s and leaves no formal resource',mode=>{
 const u=begin();if(mode==='duplicate'){chunk(u.upload_id);expect(()=>chunk(u.upload_id)).toThrow()}
 if(mode==='offset')expect(()=>chunk(u.upload_id,1)).toThrow()
 if(mode==='hash'){chunk(u.upload_id,0,Buffer.alloc(body.length,1));expect(()=>finish(u.upload_id)).toThrow()}
 if(mode==='incomplete')expect(()=>finish(u.upload_id)).toThrow()
 expect(db.prepare('SELECT * FROM resources').all()).toEqual([]);expect(db.prepare('SELECT commit_valid FROM actions').get()).toEqual({commit_valid:0})
})
it('rejects another connection and stale source before accepting chunks',()=>{
 const u=begin();expect(()=>uploads.handle({...identity,instance_id:randomUUID()},'upload.chunk',{upload_id:u.upload_id,offset:0,base64:body.toString('base64')})).toThrow();valid=false;expect(()=>chunk(u.upload_id)).toThrow();expect(db.prepare('SELECT * FROM resources').all()).toEqual([])
})
it('rolls back formal publication and preserves prepared pin if transaction fails',async()=>{
 const u=begin();chunk(u.upload_id);await finish(u.upload_id)
 expect(()=>db.transaction(()=>{uploads.commit(call);throw Error('fault')})()).toThrow()
 expect(db.prepare('SELECT * FROM resources').all()).toEqual([]);expect(db.prepare('SELECT state FROM staging').get()).toEqual({state:'prepared'})
 uploads.settled(call,false);expect(db.prepare('SELECT commit_valid FROM actions').get()).toEqual({commit_valid:0});expect(fs.existsSync(join(root,'resources',u.resource_id))).toBe(true)
})
it('revokes unfinished transfer without deleting its file or publishing it',()=>{
 const u=begin();chunk(u.upload_id);uploads.settled(call,false)
 expect(db.prepare('SELECT * FROM resources').all()).toEqual([]);expect(fs.existsSync(join(root,'resources',u.resource_id+'.tmp'))).toBe(true);expect(()=>finish(u.upload_id)).toThrow()
})
it('keeps async verification responsive and prevents publication after cancellation',async()=>{
 const u=begin();chunk(u.upload_id);const pending=finish(u.upload_id);const assertion=expect(pending).rejects.toThrow()
 uploads.settled(call,false);await assertion
 expect(db.prepare('SELECT * FROM resources').all()).toEqual([])
 expect(fs.existsSync(join(root,'resources',u.resource_id+'.tmp'))).toBe(true)
 expect(db.prepare('SELECT result,commit_valid FROM actions').get()).toEqual({result:'cancelled',commit_valid:0})
})
function independent():{owner:string;begin:()=>any} {
 uploads.close();identity={...identity,call_id:null}
 uploads=new PluginUploads(db,root,'epoch',storage,()=>{throw Error('no borrowed Call')},()=>{},(i,t)=>{if(!valid||i.instance_id!==identity.instance_id||i.call_id!==null||t!==task)throw Error('invalid independent source')})
 const declaration={byte_length:body.length,sha256:digest(body),media_type:'text/plain; charset=utf-8',display_name:'independent.txt'}
 const r:any=uploads.register(identity,task,declaration)
 return {owner:r.action_id,begin:()=>uploads.handle(identity,'upload.begin',{task_id:task,owner_id:r.action_id,...declaration})}
}
it('publishes independently registered exact upload without manufacturing a Run or Call',async()=>{
 const grant=independent(),u=grant.begin();chunk(u.upload_id)
 expect(await finish(u.upload_id)).toMatchObject({state:'committed',published:true,action_id:grant.owner})
 expect(db.prepare('SELECT run_id,call_id,result FROM actions').get()).toEqual({run_id:null,call_id:null,result:'success'})
 expect(db.prepare('SELECT state FROM staging').get()).toEqual({state:'committed'})
 expect(uploads.busy(task)).toBe(false)
})
it('rejects independent self-reported owners, changed declarations and duplicate begins',()=>{
 const grant=independent()
 expect(()=>uploads.handle(identity,'upload.begin',{task_id:task,owner_id:'forged',byte_length:body.length,sha256:digest(body),media_type:'text/plain',display_name:'fixture'})).toThrow()
 const u=grant.begin();expect(()=>grant.begin()).toThrow();uploads.cancelTask(task)
 expect(()=>chunk(u.upload_id)).toThrow();expect(db.prepare('SELECT result FROM actions').get()).toEqual({result:'cancelled'})
})
it('revokes independent grants before bytes arrive and retains unfinished files after cancellation',async()=>{
 let grant=independent();valid=false;uploads.check();expect(()=>grant.begin()).toThrow()
 valid=true;grant=independent();const u=grant.begin();chunk(u.upload_id);const pending=finish(u.upload_id),assertion=expect(pending).rejects.toThrow()
 uploads.cancelTask(task);await assertion;expect(db.prepare('SELECT * FROM resources').all()).toEqual([])
 expect(fs.existsSync(join(root,'resources',u.resource_id+'.tmp'))).toBe(true)
})
