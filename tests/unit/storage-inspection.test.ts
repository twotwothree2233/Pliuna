import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RuntimeStore } from '../../src/runtime/store'
import { inspectStorage } from '../../src/runtime/storage-inspection'
import { StorageInspections } from '../../src/main/storage-inspections'
import { digest } from '../../src/runtime/resources'
import { validateIpc, validateModel } from '../../src/shared/validation'
import { EventEmitter } from 'node:events'
let root: string, store: RuntimeStore, task: string
beforeEach(() => { root=fs.mkdtempSync(join(tmpdir(),'trellis-inspection-'));store=new RuntimeStore(root);task=store.create('isolated').task.id })
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();store.close();fs.rmSync(root,{recursive:true,force:true})})
function resource(body=Buffer.from('original')): string { const id=randomUUID(),db=new Database(join(root,'trellis.sqlite'));db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(id,id,digest(body),body.length,'text/plain','private name','now');db.prepare('INSERT INTO task_resources VALUES (?,?)').run(task,id);db.close();fs.writeFileSync(join(root,'resources',id),body);return id }
function logical(): string { const files=['trellis.sqlite','restore-control.sqlite','recovery-control.sqlite','gc-control.sqlite'];return JSON.stringify(files.map(file=>{const db=new Database(join(root,file),{readonly:true});try{return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r:any)=>[r.name,db.prepare(`SELECT * FROM ${r.name}`).all()])}finally{db.close()}})) }
const inspect=(scope:'growth'|'resources'|'resource'='growth',extra={})=>inspectStorage(root,{scope,...extra},()=>{})
it('growth reports counts and sizes without hashing files or mutating logical facts',async()=>{
  resource();const before=logical();vi.spyOn(fs,'readSync').mockImplementation(()=>{throw Error('must not read resource bodies')})
  const r=await inspect();expect(r.complete).toBe(true);expect(r.controls).toMatchObject({format:5,resource_records:0,records_pruned:0});expect(r.business.counts.resources).toBe(1);expect(r.protection.files_not_scanned).toBe(true);expect(logical()).toBe(before);expect(JSON.stringify(r)).not.toMatch(/private name|storage_key|\/Users\//)
})
it('resource diagnostics verify bytes without changing database/control/source files',async()=>{
  const id=resource(),before=logical(),body=fs.readFileSync(join(root,'resources',id));const r=await inspect('resource',{resource_id:id});expect(r).toMatchObject({complete:true,readonly:true,deletion_authority:false});expect(r.items[0]).toMatchObject({resource_id:id,state:'verified',bytes_read:8});expect(logical()).toBe(before);expect(fs.readFileSync(join(root,'resources',id))).toEqual(body)
})
it('reports plugin control growth without restoring authority or removing packages',async()=>{
  const path=join(root,'plugin-control.sqlite'),before=fs.readFileSync(path),result=await inspect()
  expect(result.controls.plugins).toMatchObject({format:1,packages:0,trust_records:0,enabled:0,workflows:0,records_pruned:0,physical_package_gc:false})
  expect(fs.readFileSync(path)).toEqual(before)
})
it('fails closed on unknown plugin control without rewriting it',async()=>{
  const path=join(root,'plugin-control.sqlite'),db=new Database(path),value=JSON.parse((db.prepare('SELECT manifest FROM plugin_control').get() as any).manifest)
  value.version=999;db.prepare('UPDATE plugin_control SET manifest=?').run(JSON.stringify(value));db.close()
  const before=fs.readFileSync(path),result=await inspect();expect(result.complete).toBe(false);expect(fs.readFileSync(path)).toEqual(before)
})
it.each(['missing','length','hash','symlink','dangling','hardlink','directory','metadata','permission','io'])('diagnoses %s and never fixes or deletes',async mode=>{
  const id=resource(),path=join(root,'resources',id)
  if(['missing','symlink','dangling','directory'].includes(mode))fs.unlinkSync(path)
  if(mode==='length')fs.writeFileSync(path,'short')
  if(mode==='hash')fs.writeFileSync(path,'modified')
  if(mode==='symlink'){fs.writeFileSync(path+'.target','original');fs.symlinkSync(path+'.target',path)}
  if(mode==='dangling')fs.symlinkSync(path+'.absent',path)
  if(mode==='hardlink')fs.linkSync(path,path+'.other')
  if(mode==='directory')fs.mkdirSync(path)
  if(mode==='metadata'){const db=new Database(join(root,'trellis.sqlite'));db.prepare("UPDATE resources SET storage_key='../private' WHERE id=?").run(id);db.close()}
  if(['permission','io'].includes(mode)){const open=fs.openSync;vi.spyOn(fs,'openSync').mockImplementation(((file:any,...args:any[])=>{if(file===path)throw Object.assign(Error('secret path'),{code:mode==='io'?'EIO':'EACCES'});return Reflect.apply(open,fs,[file,...args])}) as typeof fs.openSync)}
  const before=logical(),r=await inspect('resource',{resource_id:id});expect(r.complete).toBe(true);expect(r.items[0].state).toBe(['permission','io'].includes(mode)?'unavailable':'anomaly');expect(r.items[0].reason).toBeTruthy();expect(logical()).toBe(before);expect(JSON.stringify(r)).not.toContain('secret path')
})
it('pages 51 resources and reports exactly the observed scope, not whole-store health',async()=>{
  for(let i=0;i<51;i++)resource(Buffer.from('x'));const first=await inspect('resources'),last=await inspect('resources',{after:first.next_after});expect(first.items).toHaveLength(50);expect(last.items).toHaveLength(1);expect(last.next_after).toBeNull();expect(first.deletion_authority).toBe(false)
})
it('abort stops at a safe read boundary without maintenance registration',async()=>{
  resource();const before=logical(),controller=new AbortController();const r=await inspectStorage(root,{scope:'resources'},()=>controller.abort(),controller.signal);expect(r).toMatchObject({complete:false,error:'INSPECT_CANCELLED'});expect(logical()).toBe(before)
})
it.each(['file','json','version','missing','sources','recovery','schema'])('fails closed for damaged %s control without constructing managers or rebuilding files',async mode=>{
  resource();store.close();const path=join(root,'restore-control.sqlite')
  if(mode==='file')fs.writeFileSync(path,'broken')
  if(mode==='missing')fs.unlinkSync(path)
  if(['json','version','sources'].includes(mode)){const db=new Database(path),v=JSON.parse((db.prepare('SELECT manifest FROM restore_control').get() as any).manifest);if(mode==='version')v.version=999;if(mode==='sources')v.task_deletions=[{task_id:randomUUID(),resources:[],stages:[]}];db.prepare('UPDATE restore_control SET manifest=?').run(mode==='json'?'{broken':JSON.stringify(v));db.close()}
  if(mode==='recovery')fs.writeFileSync(join(root,'recovery-control.sqlite'),'broken')
  if(mode==='schema'){const db=new Database(join(root,'trellis.sqlite'));db.exec('UPDATE schema_version SET version=99');db.close()}
  const files=fs.readdirSync(root),r=await inspect();expect(r.complete).toBe(false);expect(r.error).toBeTruthy();expect(fs.readdirSync(root).filter(f=>!f.endsWith('-wal')&&!f.endsWith('-shm'))).toEqual(files.filter(f=>!f.endsWith('-wal')&&!f.endsWith('-shm')));if(mode==='missing')expect(fs.existsSync(path)).toBe(false)
})
it('metadata changes while reading are reported rather than claiming verification',async()=>{
  const id=resource();let changed=false;const r=await inspectStorage(root,{scope:'resource',resource_id:id},p=>{if(p.phase==='checking_resources'&&!changed){changed=true;const db=new Database(join(root,'trellis.sqlite'));db.prepare("UPDATE resources SET display_name='changed' WHERE id=?").run(id);db.close()}});expect(r.items[0].reason).toBe('INSPECT_METADATA_CHANGED')
})
it('file changes while hashing produce a bounded anomaly, not a repair',async()=>{
  const id=resource(Buffer.alloc(5*1024*1024,1));const r=await inspectStorage(root,{scope:'resource',resource_id:id},p=>{if(p.phase==='hashing')fs.writeFileSync(join(root,'resources',id),Buffer.alloc(5*1024*1024,2))});expect(r.items[0].reason).toBe('INSPECT_IDENTITY_CHANGED')
})
it('summary page returns unverified metadata without full protection or resource reads',()=>{
  resource();store.handle({type:'task.delete',task_id:task});const before=logical();vi.spyOn(fs,'readFileSync').mockImplementation(()=>{throw Error('body read forbidden')})
  const page=store.handle({type:'maintenance.resource.list',summary:true}) as any;expect(page.items[0]).toMatchObject({checked:false,can_request:true,eligible:false,protection_reason:null});expect(logical()).toBe(before)
})
it('host contracts reject arbitrary paths, extra flags and model inspection tool access',()=>{
  for(const r of [{type:'storage.inspect.start',scope:'resource',resource_id:'../secret'},{type:'storage.inspect.start',scope:'growth',repair:true},{type:'storage.inspect.cancel',job_id:'not-uuid'}])expect(()=>validateIpc(r)).toThrow()
  expect(()=>validateModel({type:'call',input:{capability:'storage.inspect.start',scope:'growth'}})).toThrow()
})
it('job manager caps history, cancels only inspection and ignores late results',()=>{
  const children:any[]=[],manager=new StorageInspections(()=>{const c=Object.assign(new EventEmitter(),{postMessage:vi.fn(),kill:vi.fn(()=>true)});children.push(c);return c})
  const first=manager.handle({type:'storage.inspect.start',scope:'growth'}) as any;expect(first.phase).toBe('running');expect(()=>manager.handle({type:'storage.inspect.start',scope:'growth'})).toThrow('INSPECT_BUSY');expect((manager.handle({type:'storage.inspect.cancel',job_id:first.id}) as any).phase).toBe('cancelled');children[0].emit('message',{result:{complete:true}});expect((manager.handle({type:'storage.inspect.status',job_id:first.id}) as any).phase).toBe('cancelled')
  for(let i=0;i<5;i++){manager.handle({type:'storage.inspect.start',scope:'growth'});children.at(-1).emit('message',{result:{complete:true,readonly:true}})}expect(()=>manager.handle({type:'storage.inspect.status',job_id:first.id})).toThrow('INSPECT_JOB_UNAVAILABLE');manager.close()
})
it.each(['exit','timeout','launch','scope'])('job failure %s never dispatches business/recovery work',mode=>{
  vi.useFakeTimers();const child=Object.assign(new EventEmitter(),{postMessage:vi.fn(),kill:vi.fn(()=>true)}),manager=new StorageInspections(()=>{if(mode==='launch')throw Error('fail');return child})
  if(mode==='scope'){expect(()=>manager.handle({type:'storage.inspect.start',scope:'resource'})).toThrow('INSPECT_SCOPE_INVALID');return}
  const job=manager.handle({type:'storage.inspect.start',scope:'growth'}) as any;if(mode==='exit')child.emit('exit');if(mode==='timeout')vi.advanceTimersByTime(120001);expect((manager.handle({type:'storage.inspect.status',job_id:job.id}) as any).phase).toBe('failed');manager.close()
})
it('diagnostic protection observations do not authorize deletion or change explicit references',async()=>{
  const id=resource(),db=new Database(join(root,'trellis.sqlite'));db.prepare("INSERT INTO task_data VALUES ('source',?,1,'{}','{}',?,NULL,0)").run(task,JSON.stringify([{name:'material',target:{kind:'resource',id}}]));db.close();const before=logical(),r=await inspect('resource',{resource_id:id});expect(r.items[0].observed_protection_sources).toEqual(expect.arrayContaining(['CURRENT_TASK_ASSOCIATION','TASK_DATA_JSON']));expect(r.deletion_authority).toBe(false);expect(logical()).toBe(before)
})
it.each(['task_data','history'])('damaged %s JSON makes the diagnostic incomplete, not unprotected',async kind=>{
  const id=resource(),db=new Database(join(root,'trellis.sqlite'));if(kind==='task_data')db.prepare("INSERT INTO task_data VALUES ('source',?,1,'{}','{}','{broken',NULL,0)").run(task);else db.prepare("INSERT INTO view_history VALUES ('history',?,'v',1,?,'{broken')").run(task,id);db.close();const r=await inspect('resources');expect(r).toMatchObject({complete:false,error:'INSPECT_REFERENCE_FACTS_INVALID'});expect(r.items).toEqual([])
})
it('diagnostic never loads a manifest exceeding its byte bound',async()=>{
  store.close();const db=new Database(join(root,'restore-control.sqlite'));db.prepare('UPDATE restore_control SET manifest=CAST(zeroblob(?) AS TEXT)').run(64*1024*1024+1);db.close();const r=await inspect();expect(r).toMatchObject({complete:false,error:'INSPECT_CONTROL_LIMIT'});expect(fs.statSync(join(root,'restore-control.sqlite')).size).toBeGreaterThan(64*1024*1024)
})
it('oversized reference JSON is rejected by SQL before materializing its contents',async()=>{
  resource();const db=new Database(join(root,'trellis.sqlite'));db.prepare("INSERT INTO task_data VALUES ('oversized',?,1,'{}','{}',CAST(zeroblob(?) AS TEXT),NULL,0)").run(task,1024*1024+1);db.close();const r=await inspect('resources');expect(r).toMatchObject({complete:false,error:'INSPECT_REFERENCE_FACTS_INVALID'});expect(r.items).toEqual([])
})
it('cancellation during streamed hashing does not advance any business or control facts',async()=>{
  const id=resource(Buffer.alloc(5*1024*1024,1)),before=logical(),controller=new AbortController();const r=await inspectStorage(root,{scope:'resource',resource_id:id},p=>{if(p.phase==='hashing')controller.abort()},controller.signal);expect(r).toMatchObject({complete:false,error:'INSPECT_CANCELLED'});expect(logical()).toBe(before);expect(fs.statSync(join(root,'resources',id)).size).toBe(5*1024*1024)
})
it('summary pagination stays bounded without cloning all candidate history',()=>{
  for(let i=0;i<25;i++)resource();store.handle({type:'task.delete',task_id:task});const first=store.handle({type:'maintenance.resource.list',summary:true}) as any,last=store.handle({type:'maintenance.resource.list',summary:true,before:first.next_before}) as any;expect(first.items).toHaveLength(20);expect(last.items).toHaveLength(5);expect(new Set([...first.items,...last.items].map(r=>r.id)).size).toBe(25);expect(last.next_before).toBeNull()
})
it('the independent inspector works when runtime startup rejects damaged selector control',async()=>{
  store.close();const db=new Database(join(root,'restore-control.sqlite'));db.prepare('UPDATE restore_control SET manifest=?').run('{broken');db.close();expect(()=>new RuntimeStore(root)).toThrow();const before=fs.readFileSync(join(root,'restore-control.sqlite')),r=await inspect();expect(r.complete).toBe(false);expect(fs.readFileSync(join(root,'restore-control.sqlite'))).toEqual(before)
})
