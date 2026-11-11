import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
import { generateExport, type ExportRunner, type ExportResult } from '../../src/runtime/export-generation'
import type { Bundle } from '../../src/shared/contracts.generated'
let root:string, store:RuntimeStore, db:Database.Database, task:string, run:string
beforeEach(()=>{vi.useFakeTimers();root=mkdtempSync(join(tmpdir(),'pliuna-long-stability-'));store=new RuntimeStore(root);db=new Database(join(root,'pliuna.sqlite'));task=store.create('Synthetic long task').task.id;run=store.start(task,'fixture held','fixture',[])})
afterEach(async()=>{await store.shutdown();db.close();rmSync(root,{recursive:true,force:true});vi.useRealTimers()})
const call=(type:string,extra:any={}):any=>store.handle({type,task_id:task,...extra})
const bundle=(n=0):Bundle=>({profile:'managed-v1',html:`<section id="lesson">Lesson ${n}</section>`,css:'',state:{schema:{type:'object',additionalProperties:false,properties:{}},initial:{},compatibility_version:'v1'},forms:[],behaviors:[],references:[],export:[{id:'learning',category:'learning',source:{type:'element',element_id:'lesson'}}]})
function publish(n=0){const s=store.snapshot(task).surface;return store.modelTool(task,run,{type:'write',input:{type:'surface.update',surface_id:s.id,expected_revision:s.revision,operations:[{type:'view.create',client_ref:'v',slot_id:'main',bundle:{type:'inline',bundle:bundle(n)}}]}})}
function reopen(runner:ExportRunner){store.close();store=new RuntimeStore(root,undefined,undefined,runner);run=store.start(task,'fixture held','fixture',[])}
it('bounds long events and answers while retaining exact original continuation',()=>{
 publish();const history=(db.prepare('SELECT id FROM view_history LIMIT 1').get() as any).id
 const text='中😀\\"'.repeat(20000);const insert=db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)'),answers=db.prepare('INSERT INTO answers VALUES(?,?,?,?,?,?,?,?)')
 for(let n=0;n<200;n++){insert.run('long-'+n,task,n+100,'message.assistant',JSON.stringify({text}),new Date().toISOString());answers.run('answer-'+n,task,history,'test',JSON.stringify({text}),JSON.stringify({text}),'long-'+n,new Date().toISOString())}
 const snapshot=store.snapshot(task);expect(Buffer.byteLength(JSON.stringify(snapshot.records))).toBeLessThanOrEqual(96*1024);expect(Buffer.byteLength(JSON.stringify(snapshot.answers))).toBeLessThanOrEqual(96*1024);expect(snapshot.answers.every(a=>a.truncated)).toBe(true)
 expect(JSON.stringify(snapshot.records)).not.toContain('undefined');expect(snapshot.records.every(r=>r.payload.truncated)).toBe(true)
 let cursor:string|undefined,content='';do{const page=call('task.query',{query:{type:'read',input:{target:{kind:'event',id:'long-0'},...(cursor?{cursor}:{})}}});content+=page.representation?page.data.text:JSON.stringify(page.data);cursor=page.next_cursor??undefined}while(cursor)
 expect(JSON.parse(content).payload.text).toBe(text);expect((db.prepare('SELECT count(*) n FROM answers').get() as any).n).toBe(200)
})
it('bounds large approval parameters without modifying original actions or permitting cross-task reads',async()=>{
 const value='x'.repeat(30000);const result=await store.agentTool(task,run,{type:'write',input:{type:'task_data.create',data:{schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},value:{text:value},references:[]}}},new AbortController().signal) as any
 // Creation is auto-authorized; a replacement is independently approved.
 const data=(db.prepare('SELECT id FROM task_data').get() as any).id
 call('run.cancel',{run_id:run});run=store.start(task,'new request','fixture',[])
 const pending=store.agentTool(task,run,{type:'write',input:{type:'task_data.replace',id:data,expected_revision:1,value:{text:value+'new'},references:[]}},new AbortController().signal)
 const p=store.snapshot(task).approvals[0]!;expect(p.request_truncated).toBe(true);expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(4096)
 const raw=JSON.parse((db.prepare('SELECT request_json FROM actions WHERE id=?').get(p.action_id) as any).request_json);expect(raw.value.text).toBe(value+'new')
 const other=store.create('Other').task.id;expect(()=>store.handle({type:'task.query',task_id:other,query:{type:'read',input:{target:{kind:'action',id:p.action_id}}}})).toThrow()
 call('approval.decide',{approval_id:p.id,decision:'deny'});await expect(pending).rejects.toThrow();expect(result).toBeTruthy()
})
it('looks up original run actions and calls without executing or leaking other tasks',()=>{
 publish();const result=call('host.run.results',{run_id:run,offset:0});expect(result.items).toHaveLength(1);expect(result.items[0]).toMatchObject({kind:'action',result:'success'});expect(result.total).toBe(1)
 expect(()=>call('host.run.results',{run_id:run,offset:-1})).toThrow();const other=store.create('Other').task.id;expect(()=>store.handle({type:'host.run.results',task_id:other,run_id:run,offset:0})).toThrow()
 expect(call('host.run.results',{run_id:run,offset:50}).items).toEqual([])
})
it('selects cross-page metadata and rejects stale snapshot selection',()=>{
 for(let n=0;n<22;n++)publish(n);const s=store.snapshot(task),page=call('export.catalog',{expected_revision:s.surface.revision,offset:20});expect(page.items).toHaveLength(2);expect(page.total).toBe(22);expect(JSON.stringify(page)).not.toContain('Lesson')
 const first=call('export.catalog',{expected_revision:s.surface.revision,offset:0}).items[0].id
 const job=call('export.prepare',{answer_ids:[],view_ids:[first,page.items[1].id],expected_revision:s.surface.revision});expect(job.html).toContain('Lesson 0');expect(job.html).toContain('Lesson 21');expect(job.html).not.toContain('Lesson 10');call('export.cancel',{operation_id:job.id});publish(23)
 expect(()=>call('export.prepare',{answer_ids:[],view_ids:[first],expected_revision:s.surface.revision})).toThrow('Surface changed')
})
it('keeps pins until cancellation reader exit and ignores a late generated preview',async()=>{
 publish();let resolve!:(value:ExportResult)=>void,exit!:()=>void;let input:any
 reopen(value=>{input=value;return{result:new Promise(r=>resolve=r),stop:()=>new Promise(r=>exit=r)}})
 const job=call('export.prepare',{answer_ids:[]});expect(job.phase).toBe('preparing');expect(call('export.status',{operation_id:job.id}).pinned).toBe(true)
 const cancelled=call('export.cancel',{operation_id:job.id});resolve(generateExport(input));await Promise.resolve();expect(call('export.status',{operation_id:job.id})).toMatchObject({phase:'preparing',pinned:true});exit();await cancelled;expect(call('export.status',{operation_id:job.id})).toMatchObject({phase:'cancelled',pinned:false})
})
it('blocks task purge until the reader exits and records generation failure without replay',async()=>{
 publish();let exit!:()=>void
 reopen(()=>({result:new Promise(()=>{}),stop:()=>new Promise(r=>exit=r)}));const job=call('export.prepare',{answer_ids:[]});const deletion=call('task.delete');expect(store.tasks()).toHaveLength(1);expect(call('export.status',{operation_id:job.id}).pinned).toBe(true);exit();await deletion;expect(store.tasks()).toHaveLength(0)
 task=store.create('Failure').task.id;run=store.start(task,'held','fixture',[]);publish();reopen(()=>({result:Promise.reject(Error('synthetic private detail')),stop:async()=>{}}));const failed=call('export.prepare',{answer_ids:[]});await Promise.resolve();await Promise.resolve();expect(call('export.status',{operation_id:failed.id})).toMatchObject({phase:'failed',pinned:false,reason:'EXPORT_GENERATION_FAILED'});expect(JSON.stringify(call('export.status',{operation_id:failed.id}))).not.toContain('private detail')
})
it('retains pins if a reader cannot confirm exit and shutdown waits before releasing',async()=>{
 publish();let fail=true,exit!:()=>void
 reopen(()=>({result:new Promise(()=>{}),stop:()=>fail?Promise.reject(Error('synthetic stop failure')):new Promise(resolve=>exit=resolve)}))
 const job=call('export.prepare',{answer_ids:[]});await expect(call('export.cancel',{operation_id:job.id})).rejects.toThrow('synthetic stop failure');expect(call('export.status',{operation_id:job.id})).toMatchObject({phase:'preparing',pinned:true})
 expect(()=>store.close()).toThrow('Wait for shutdown');fail=false
 const shutdown=store.shutdown()
 try {
  expect(()=>call('export.status',{operation_id:job.id})).toThrow('Host is shutting down')
  await vi.waitFor(()=>expect(exit).toBeTypeOf('function'))
  const control=new Database(join(root,'export-control.sqlite'),{readonly:true})
  try { expect(control.prepare('SELECT phase FROM export_jobs WHERE id=?').get(job.id)).toMatchObject({phase:'preparing'}) } finally { control.close() }
 } finally { if(exit)exit();await shutdown }
 store=new RuntimeStore(root);expect(call('export.status',{operation_id:job.id})).toMatchObject({phase:'cancelled',pinned:false})
})
it('publishes a fixed preview only after successful reader completion and blocks unresolved save cancellation',async()=>{
 publish();let resolve!:(result:ExportResult)=>void,input:any
 reopen(value=>{input=value;return{result:new Promise(r=>resolve=r),stop:async()=>{}}})
 const job=call('export.prepare',{answer_ids:[]});expect(()=>call('export.preview',{operation_id:job.id})).toThrow();resolve(generateExport(input));await Promise.resolve();await Promise.resolve();await Promise.resolve()
 expect(call('export.preview',{operation_id:job.id}).html).toContain('Lesson 0');call('export.internal.begin',{operation_id:job.id,partial:false,target:join(root,'output.html'),temporary:join(root,'temp.html')});expect(()=>call('export.cancel',{operation_id:job.id})).toThrow();expect(call('export.status',{operation_id:job.id})).toMatchObject({phase:'saving',pinned:true});call('export.internal.finish',{operation_id:job.id,phase:'failed',reason:'SYNTHETIC_FAILURE'})
})
it('keeps original Call execution and delivery facts separate from model completion',()=>{
 store.modelTool(task,run,{type:'call',input:{capability:'disabled',arguments:{},references:[]}})
 const result=call('host.run.results',{run_id:run,offset:0});expect(result.items[0]).toMatchObject({kind:'call',state:'ended',result:'not_executed'})
 const original=call('task.query',{query:{type:'read',input:{target:{kind:'call',id:result.items[0].id}}}});expect(original.data).toMatchObject({dispatch:'not_sent',execution:'not_executed',delivery:'delivered'})
})
