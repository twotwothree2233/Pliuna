import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeStore } from '../../src/runtime/store'
import { ModelService } from '../../src/runtime/model/service'
import type { Bundle } from '../../src/shared/contracts.generated'
import { pluginCapabilityId } from '../../src/runtime/plugins/directory'
let root: string, store: RuntimeStore, task: string, db: Database.Database
const call = (type: string, extra: Record<string, unknown> = {}): any => store.handle({ type, ...extra })
const backend = `
const rl=require('node:readline').createInterface({input:process.stdin});
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');let sequence=0;const pending=new Map(),independent=[];
const request=(method,params,done)=>{const id='independent:'+sequence++;pending.set(id,done);send({jsonrpc:'2.0',id,method,params})};
rl.on('line',line=>{
 const m=JSON.parse(line);if(!m.method){const done=pending.get(m.id);pending.delete(m.id);if(done)done(m);return}
 if(!m.id)return;
 if(m.method==='initialize'){send({jsonrpc:'2.0',id:m.id,result:{protocol_version:'0.1',plugin_id:m.params.plugin_id,capabilities:m.params.capabilities}});return}
 if(m.method==='fixture.release'){const next=independent.shift();send({jsonrpc:'2.0',id:m.id,result:{released:!!next}});if(next)next();return}
 if(m.method!=='tools.execute')return;
 const value=m.params.arguments.value;
 let waitingError;const finish=value=>send({jsonrpc:'2.0',id:m.id,result:{value,...(waitingError?{waiting_error:waitingError}:{})}});
 if(value&&value.delay){setTimeout(()=>finish('delayed'),value.delay);return}
 if(value&&value.early){request('actions.submit',{task_id:m.params.task_id,mutation:value.early},()=>finish('returned before approval'));return}
 if(value&&value.cross){request('objects.list',{task_id:value.cross,input:{kind:'task_data'}},r=>finish(r.result||{rpc_error:r.error}));return}
 if(value&&value.inspect_surface){request('surface.stage',{task_id:m.params.task_id,mutation:value.inspect_surface},r=>finish(r.result||{rpc_error:r.error}));return}
 if(value&&value.nested){
  request('tools.call',{task_id:m.params.task_id,...value.nested},r=>{
   if(r.error){finish({rpc_error:r.error});return}
   const poll=()=>request('tools.get',{call_id:r.result.call_id},v=>{if(v.error)finish({rpc_error:v.error});else if(v.result.state==='ended')finish(v.result);else setTimeout(poll,10)});
   if(value.wait)request('execution.wait',{waiting:true},w=>{if(w.error){finish({rpc_error:w.error});return}request('actions.submit',{task_id:m.params.task_id,mutation:{type:'task_data.create',data:{schema:{type:'object'},value:{},references:[]}}},blocked=>{waitingError=blocked.error;request('execution.wait',{waiting:false},()=>poll())})});else poll();
  });return;
 }
 if(value&&value.upload){
  const bytes=Buffer.from(value.upload),sha256=value.sha256;
  request('upload.begin',{task_id:m.params.task_id,owner_id:m.params.call_id,byte_length:bytes.length,sha256,media_type:'text/plain',display_name:'fixture upload'},r=>{
   if(r.error){finish({rpc_error:r.error});return}
   const id=r.result.upload_id;
   request('upload.chunk',{upload_id:id,offset:0,base64:bytes.toString('base64')},c=>{if(c.error){finish({rpc_error:c.error});return}request('upload.finish',{upload_id:id},f=>finish(f.result||{rpc_error:f.error}))});
  });return;
 }
 if(value&&(value.submit||value.surface||value.invocation)){independent.push(()=>{
  if(value.surface)request('surface.stage',{task_id:m.params.task_id,mutation:value.surface},r=>{if(r.result)request('actions.submit',{task_id:m.params.task_id,action:{type:'surface.commit',draft_id:r.result.draft_id}},()=>{})});
  else if(value.invocation)request('actions.submit',{task_id:m.params.task_id,invocation:value.invocation},()=>{});
  else request('actions.submit',{task_id:m.params.task_id,mutation:value.submit},()=>{});
 })}
 send({jsonrpc:'2.0',id:m.id,result:{value:value&&(value.submit||value.surface||value.invocation)?'scheduled':value}})
});`

async function plugin(effect = 'read', name = 'fixture.calls', global = false): Promise<{ digest: string; capability: string }> {
 const source=join(root,name);await mkdir(source)
 await writeFile(join(source,'backend.cjs'),backend)
 await writeFile(join(source,'tool.json'),JSON.stringify({id:'echo',description:'fixture',when_to_use:'tests',input_schema:{type:'object',required:['value']},output_schema:{type:'object',required:['value']},effect,timeout_ms:2000,errors:[],examples:[]}))
 await writeFile(join(source,'manifest.json'),JSON.stringify({manifest_version:'0.1',protocol_version:'0.1',id:name,version:'1.0.0',access_level:global?'global':'task',contributes:[{id:'echo',kind:'tool',entry:'tool.json',description:'fixture'}],backend:{command:process.execPath,args:['backend.cjs'],entry:'backend.cjs'}}))
 const p=await call('plugin.internal.install',{source});await call('plugin.trust',{digest:p.digest,confirm_local_code:true,confirm_cross_task:global})
 const plan=await call('plugin.plan',{task_id:task,digest:p.digest});await call('plugin.enable',{task_id:task,digest:p.digest,fingerprint:plan.fingerprint,confirm_cross_task:global})
 return {digest:p.digest,capability:pluginCapabilityId(p.digest,'echo')}
}
async function run(capability:string, value:unknown):Promise<{id:string;result:Promise<any>}> {
 const id=store.start(task,'fixture caller','fixture',[])
 clearTimeout((store as any).timers.get(id));(store as any).timers.delete(id)
 const result=store.agentTool(task,id,{type:'call',input:{capability,arguments:{value},references:[]}},new AbortController().signal)
 return {id,result}
}
async function approval():Promise<any>{for(let n=0;n<100;n++){const found=store.snapshot(task).approvals.find(a=>a.decision==='pending');if(found)return found;await new Promise(r=>setTimeout(r,10))}throw Error('approval missing')}
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'pliuna-plugin-calls-'));store=new RuntimeStore(root,new ModelService(),{viewReplacement:true});task=store.create('fixture').task.id;db=new Database(join(root,'pliuna.sqlite'))})
afterEach(async()=>{vi.restoreAllMocks();await (store as any).pluginProcesses.shutdown('test_cleanup',20);await store.shutdown();db.close();await rm(root,{recursive:true,force:true})})
it('keeps Run and task in cleanup until the ordinary child exits, including kill failure',async()=>{
 const p=await plugin(),r=await run(p.capability,{delay:1000})
 await until(()=>db.prepare("SELECT id FROM calls WHERE dispatch='sent'").get()!==undefined)
 const manager=(store as any).pluginProcesses,instance=[...manager.children][0] as any
 const kill=vi.spyOn(instance.tree,'terminate').mockReturnValue(false)
 call('task.stop',{task_id:task})
 expect(store.snapshot(task).task.state).toBe('stopping')
 expect(db.prepare('SELECT state,wait_reason,commit_valid FROM runs WHERE id=?').get(r.id)).toEqual({state:'waiting',wait_reason:'ending_cleanup',commit_valid:0})
 expect(db.prepare('SELECT state FROM calls').get()).not.toEqual({state:'ended'})
 expect(()=>call('task.resume',{task_id:task})).toThrow(expect.objectContaining({code:'PLUGIN_CLEANUP_PENDING'}))
 expect(()=>call('task.delete',{task_id:task})).toThrow(expect.objectContaining({code:'PLUGIN_EXECUTION_ACTIVE'}))
 await expect(call('plugin.workflow',{task_id:task,selection:null})).rejects.toMatchObject({code:'PLUGIN_CONFIGURATION_BUSY'})
 expect(manager.status(task,p.digest)).toMatchObject([{state:'cleanup_failed',cleanup_error:'PLUGIN_TERMINATION_UNCONFIRMED'}])
 kill.mockRestore();call('task.stop',{task_id:task})
 expect(await r.result).toMatchObject({execution:'cancelled'})
 await until(()=>store.snapshot(task).task.state==='stopped')
 expect(db.prepare('SELECT state FROM runs WHERE id=?').get(r.id)).toEqual({state:'cancelled'})
 expect(manager.status(task,p.digest)).toEqual([])
 call('task.resume',{task_id:task});expect(store.snapshot(task).task.state).toBe('active')
})
it('does not close storage or acknowledge shutdown before exit and Call settlement',async()=>{
 const p=await plugin(),r=await run(p.capability,{delay:1000})
 await until(()=>db.prepare("SELECT id FROM calls WHERE dispatch='sent'").get()!==undefined)
 const manager=(store as any).pluginProcesses,instance=[...manager.children][0] as any
 const kill=vi.spyOn(instance.tree,'terminate').mockReturnValue(false)
 const shutdown=manager.shutdown.bind(manager)
 vi.spyOn(manager,'shutdown').mockImplementation(()=>shutdown('fixture',20))
 let closed=false;const shutting=store.shutdown().then(()=>{closed=true})
 await until(()=>!!manager.status(task,p.digest)[0]?.cleanup_error)
 expect(closed).toBe(false);expect((store as any).db.open).toBe(true)
 expect(db.prepare('SELECT state FROM calls').get()).not.toEqual({state:'ended'})
 kill.mockRestore();const retry=store.shutdown()
 await r.result;await shutting;await retry
 expect(db.prepare('SELECT state FROM calls').get()).toEqual({state:'ended'})
 expect((store as any).db.open).toBe(false)
})
it('holds stopped task cleanup even when the plugin is idle and no Run remains active',async()=>{
 const p=await plugin(),r=await run(p.capability,'idle');await r.result
 call('run.cancel',{task_id:task,run_id:r.id})
 const manager=(store as any).pluginProcesses,instance=[...manager.children][0] as any
 const kill=vi.spyOn(instance.tree,'terminate').mockReturnValue(false)
 call('task.stop',{task_id:task})
 expect(store.snapshot(task).task.state).toBe('stopping')
 expect(()=>call('maintenance.begin')).toThrow(expect.objectContaining({code:'MAINTENANCE_EXECUTION_ACTIVE'}))
 expect(()=>call('task.resume',{task_id:task})).toThrow(expect.objectContaining({code:'PLUGIN_CLEANUP_PENDING'}))
 kill.mockRestore();call('task.stop',{task_id:task})
 await until(()=>store.snapshot(task).task.state==='stopped')
 expect(manager.status(task,p.digest)).toEqual([])
})
it('does not switch databases until an idle plugin exits',async()=>{
 const p=await plugin(),r=await run(p.capability,'idle');await r.result
 call('run.cancel',{task_id:task,run_id:r.id})
 let token=call('maintenance.begin').reservation.token
 const point=await call('maintenance.create',{token,inputs_saved:true,replace_id:null})
 token=call('maintenance.begin').reservation.token
 const manager=(store as any).pluginProcesses,instance=[...manager.children][0] as any
 const kill=vi.spyOn(instance.tree,'terminate').mockReturnValue(false),epoch=store.epoch
 let restored=false
 const restoring=call('maintenance.restore',{token,point_id:point.active.id,database_sha256:point.active.database_sha256,inputs_saved:true,confirm_replace_newer_data:true}).then(()=>{restored=true})
 await until(()=>manager.cleaning())
 expect(restored).toBe(false);expect(store.epoch).toBe(epoch);expect((store as any).db.open).toBe(true)
 kill.mockRestore();manager.retryCleanup();await restoring
 expect(store.epoch).not.toBe(epoch)
 expect((store as any).pluginProcesses.status(task,p.digest)).toEqual([])
})
it('keeps shutdown pending through beforeRebind and lets repeated shutdown retry plugin cleanup',async()=>{
 const p=await plugin(),r=await run(p.capability,'idle');await r.result
 call('run.cancel',{task_id:task,run_id:r.id})
 const point=await call('maintenance.create',{token:call('maintenance.begin').reservation.token,inputs_saved:true,replace_id:null})
 const token=call('maintenance.begin').reservation.token,manager=(store as any).pluginProcesses,instance=[...manager.children][0] as any
 const kill=vi.spyOn(instance.tree,'terminate').mockReturnValue(false),epoch=store.epoch
 const restoring=call('maintenance.restore',{token,point_id:point.active.id,database_sha256:point.active.database_sha256,inputs_saved:true,confirm_replace_newer_data:true})
 await until(()=>manager.cleaning())
 let closed=false;const shutting=store.shutdown().then(()=>{closed=true})
 await new Promise(resolve=>setImmediate(resolve))
 expect(closed).toBe(false);expect(store.epoch).toBe(epoch);expect((store as any).db.open).toBe(true)
 expect(instance.exitConfirmed).toBe(false)
 kill.mockRestore();const retry=store.shutdown()
 await restoring;await shutting;await retry
 expect(instance.exitConfirmed).toBe(true);expect(store.epoch).not.toBe(epoch)
 expect((store as any).db.open).toBe(false)
})
it('executes read calls with a distinct durable Call and no empty approval Action',async()=>{
 const p=await plugin(), r=await run(p.capability,'hello'), result=await r.result
 expect(result).toMatchObject({execution:'success',data:{value:'hello'}})
 expect(db.prepare('SELECT dispatch,execution,delivery,state FROM calls').all()).toEqual([{dispatch:'sent',execution:'success',delivery:'delivered',state:'ended'}])
 expect(db.prepare('SELECT id FROM actions').all()).toEqual([])
})
it('awaits discovered contract reads through the Agent boundary and rejects encoded arguments without dispatch',async()=>{
 const p=await plugin(),id=store.start(task,'fixture discovery','fixture',[]),signal=new AbortController().signal
 clearTimeout((store as any).timers.get(id));(store as any).timers.delete(id)
 const listed:any=await store.agentTool(task,id,{type:'list',input:{kind:'capability'}},signal)
 expect(listed.data.items[0].id).toBe(p.capability)
 const read:any=await store.agentTool(task,id,{type:'read',input:{target:{kind:'capability',id:p.capability}}},signal)
 expect(JSON.parse(JSON.stringify(read)).data.data).toMatchObject({id:p.capability,capability:{id:'echo',input_schema:{type:'object'}}})
 await expect(store.agentTool(task,id,{type:'call',input:{capability:p.capability,arguments:JSON.stringify({value:'text'}),references:[]}},signal)).rejects.toMatchObject({code:'PLUGIN_ARGUMENTS_INVALID',message:expect.stringContaining('actual JSON value')})
 expect(db.prepare('SELECT id FROM calls').all()).toEqual([])
 expect(db.prepare('SELECT id FROM actions').all()).toEqual([])
 expect((await call('plugin.list',{task_id:task})).items[0].instances).toEqual([])
 expect(await store.agentTool(task,id,{type:'call',input:{capability:read.data.data.id,arguments:{value:'text'},references:[]}},signal)).toMatchObject({execution:'success',data:{value:'text'}})
})
it('does not return a successful async read after its Run is cancelled',async()=>{
 const p=await plugin(),id=store.start(task,'fixture discovery','fixture',[])
 clearTimeout((store as any).timers.get(id));(store as any).timers.delete(id)
 const result=store.agentTool(task,id,{type:'read',input:{target:{kind:'capability',id:p.capability}}},new AbortController().signal)
 call('run.cancel',{task_id:task,run_id:id})
 await expect(result).rejects.toMatchObject({code:'SOURCE_INVALID'})
})
it('waits for invocation approval and distinguishes dispatch from execution',async()=>{
 const p=await plugin('external-write'),r=await run(p.capability,2),a=await approval()
 expect(db.prepare('SELECT dispatch FROM calls').get()).toEqual({dispatch:'not_sent'})
 call('approval.decide',{task_id:task,approval_id:a.id,decision:'approve'})
 expect(await r.result).toMatchObject({execution:'success',data:{value:2}})
 const action=db.prepare('SELECT kind,result,result_json FROM actions').get() as any
 expect(action.kind).toBe('invocation');expect(action.result).toBe('success');expect(JSON.parse(action.result_json)).toMatchObject({dispatched:'sent',tool_execution:'not_proven',call_id:expect.any(String)})
})
it('denied invocation never dispatches and remains queryable',async()=>{
 const p=await plugin('task-write'),r=await run(p.capability,2),a=await approval()
 call('approval.decide',{task_id:task,approval_id:a.id,decision:'deny'})
 expect(await r.result).toMatchObject({execution:'not_executed'})
 expect(db.prepare('SELECT dispatch,execution FROM calls').get()).toEqual({dispatch:'not_sent',execution:'not_executed'})
})
it('normal configuration changes are blocked while invocation approval owns a Run',async()=>{
 const p=await plugin('task-write'),r=await run(p.capability,2),a=await approval()
 await expect(call('plugin.workflow',{task_id:task,selection:null})).rejects.toMatchObject({code:'PLUGIN_CONFIGURATION_BUSY'})
 await call('plugin.revoke',{digest:p.digest});expect(await r.result).toMatchObject({execution:'not_executed'})
 expect(()=>call('approval.decide',{task_id:task,approval_id:a.id,decision:'approve'})).toThrow()
})
it('startup preserves dispatched unknown facts without replaying calls',async()=>{
 const id=crypto.randomUUID();db.prepare("INSERT INTO calls (id,task_id,capability_id,state,dispatch,delivery,input_json,limits_json,commit_valid,created_at) VALUES (?,?,'historical','executing','sent','pending','{}','{}',1,'now')").run(id,task)
 store.close();store=new RuntimeStore(root)
 expect(db.prepare('SELECT state,dispatch,execution,commit_valid FROM calls WHERE id=?').get(id)).toEqual({state:'ended',dispatch:'sent',execution:'unknown',commit_valid:0})
})

const dataSchema={type:'object',properties:{stage:{type:'string'}},required:['stage'],additionalProperties:false}
async function release(capability:string):Promise<void>{const instance=[...(store as any).pluginProcesses.children].find((i:any)=>pluginCapabilityId(i.copy.digest,'echo')===capability);expect(instance).toBeDefined();expect(await instance.rpc.request('fixture.release',{}, {timeout:2000})).toEqual({released:true})}
async function schedule(capability:string,mutation:unknown,beforeResult:()=>Promise<void>=async()=>{}):Promise<void>{const r=await run(capability,{submit:mutation});await beforeResult();expect(await r.result).toMatchObject({execution:'success'});call('run.cancel',{task_id:task,run_id:r.id});await release(capability)}
async function until(check:()=>boolean):Promise<void>{for(let i=0;i<150;i++){if(check())return;await new Promise(r=>setTimeout(r,10))}throw Error('condition not reached')}
it('accepts an independent no-Run creation and does not manufacture a Run',async()=>{
 const p=await plugin();await schedule(p.capability,{type:'task_data.create',data:{schema:dataSchema,value:{stage:'initial'},references:[]}})
 await until(()=>store.snapshot(task).task_data.total===1)
 const a=db.prepare('SELECT run_id,result,source_json FROM actions').get() as any
 expect(a.run_id).toBeNull();expect(a.result).toBe('success');expect(JSON.parse(a.source_json).type).toBe('plugin');expect(store.snapshot(task).runs).toHaveLength(1)
})
it('requires a new independent approval for prior data and rejects version changes at commit',async()=>{
 const p=await plugin();await schedule(p.capability,{type:'task_data.create',data:{schema:dataSchema,value:{stage:'initial'},references:[]}})
 await until(()=>store.snapshot(task).task_data.total===1);const id=store.snapshot(task).task_data.items[0]!.id
 await schedule(p.capability,{type:'task_data.replace',id,expected_revision:1,value:{stage:'updated'},references:[]})
 const a=await approval();expect(a.run_id).toBeNull()
 db.prepare('UPDATE task_data SET revision=2 WHERE id=?').run(id)
 call('approval.decide',{task_id:task,approval_id:a.id,decision:'approve'})
 await until(()=>(db.prepare('SELECT result FROM actions WHERE id=?').get(a.action_id) as any)?.result==='not_executed')
 expect(JSON.parse((db.prepare('SELECT value_json FROM task_data WHERE id=?').get(id) as any).value_json)).toEqual({stage:'initial'})
})
it('commits an independently approved replacement without borrowing the earlier call authorization',async()=>{
 const p=await plugin();await schedule(p.capability,{type:'task_data.create',data:{schema:dataSchema,value:{stage:'initial'},references:[]}})
 await until(()=>store.snapshot(task).task_data.total===1);const id=store.snapshot(task).task_data.items[0]!.id
 await schedule(p.capability,{type:'task_data.replace',id,expected_revision:1,value:{stage:'updated'},references:[]});const a=await approval()
 call('approval.decide',{task_id:task,approval_id:a.id,decision:'approve'})
 await until(()=>(db.prepare('SELECT revision FROM task_data WHERE id=?').get(id) as any)?.revision===2)
 expect((db.prepare('SELECT run_id,result FROM actions WHERE id=?').get(a.action_id) as any)).toEqual({run_id:null,result:'success'})
})
function viewBundle(initial = 'initial', compatibility = 'fixture-1'): Bundle {
 return {profile:'managed-v1',html:'<section><textarea id="answer"></textarea></section>',css:'',state:{schema:{type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false},initial:{answer:initial},compatibility_version:compatibility},forms:[],behaviors:[{type:'input',element_id:'answer',field:'/answer',control:'textarea'}],references:[],export:[]}
}
async function surface(capability:string,input:unknown):Promise<void>{const r=await run(capability,{surface:input});expect(await r.result).toMatchObject({execution:'success'});call('run.cancel',{task_id:task,run_id:r.id});await release(capability)}
async function createView(capability:string):Promise<void>{const s=store.snapshot(task);await surface(capability,{type:'surface.update',surface_id:s.surface.id,expected_revision:s.surface.revision,operations:[{type:'view.create',client_ref:'first',slot_id:'main',bundle:{type:'inline',bundle:viewBundle()}}]});await until(()=>store.snapshot(task).views.length===1)}
function replacement(reset=false):unknown{const s=store.snapshot(task),v=s.views[0]!;return {type:'surface.update',surface_id:s.surface.id,expected_revision:s.surface.revision,operations:[{type:'view.replace',view_id:v.id,expected_view_revision:v.revision,bundle:{type:'inline',bundle:viewBundle('new',reset?'fixture-2':'fixture-1')},state_transition:reset?{type:'reset',expected_state_revision:v.state_revision,initial:{answer:'new'}}:{type:'preserve',expected_state_revision:v.state_revision,compatibility_version:'fixture-1'}}]}}
function saveAnswer(answer:string):void{const v=store.snapshot(task).views[0]!;call('draft.save',{task_id:task,view_id:v.id,view_revision:v.revision,expected_state_revision:v.state_revision,fields:[{path:'/answer',value:answer}]})}
it('publishes independent inline resources through an actual staging owner after buffered tool output',async()=>{
 const p=await plugin(),warm=await run(p.capability,'warm');await warm.result;call('run.cancel',{task_id:task,run_id:warm.id})
 const instance=[...(store as any).pluginProcesses.children][0] as any
 instance.process.stdout.pause()
 try { await schedule(p.capability,{type:'resource.create',display_name:'fixture text',content:{type:'text',text:'independent resource'}},async()=>{await new Promise(r=>setTimeout(r,200));instance.process.stdout.resume()}) }
 finally { instance.process.stdout.resume() }
 await until(()=>(db.prepare('SELECT count(*) AS n FROM task_resources').get() as any).n===1)
 expect(db.prepare('SELECT run_id,result FROM actions').get()).toEqual({run_id:null,result:'success'})
 expect(db.prepare('SELECT state FROM staging').get()).toEqual({state:'committed'})
})
it('stages a no-Run View and preserves user input only after independent approval and host check',async()=>{
 const p=await plugin();await createView(p.capability);saveAnswer('keep this input');const before=store.snapshot(task).views[0]!
 await surface(p.capability,replacement());const a=await approval();expect(a.run_id).toBeNull()
 call('approval.decide',{task_id:task,approval_id:a.id,decision:'approve'});await until(()=>store.snapshot(task).surface_updates.length===1)
 const pending=store.snapshot(task).surface_updates[0]!;expect(pending.run_id).toBeNull()
 await call('surface.respond',{task_id:task,action_id:pending.action_id,proceed:true,confirm_discard:false})
 expect(store.snapshot(task).views[0]).toMatchObject({id:before.id,revision:2,draft:{answer:'keep this input'}})
})
it('keeps plugin reset input on cancellation and rejects a saved-input conflict after approval',async()=>{
 const p=await plugin();await createView(p.capability);saveAnswer('never silently discard')
 await surface(p.capability,replacement(true));let a=await approval();call('approval.decide',{task_id:task,approval_id:a.id,decision:'approve'});await until(()=>store.snapshot(task).surface_updates.length===1)
 let pending=store.snapshot(task).surface_updates[0]!
 await expect(call('surface.respond',{task_id:task,action_id:pending.action_id,proceed:true,confirm_discard:false})).rejects.toMatchObject({code:'CONFIRMATION_REQUIRED'})
 await call('surface.respond',{task_id:task,action_id:pending.action_id,proceed:false,confirm_discard:false})
 expect(store.snapshot(task).views[0]).toMatchObject({revision:1,draft:{answer:'never silently discard'}})
 await surface(p.capability,replacement());a=await approval();call('approval.decide',{task_id:task,approval_id:a.id,decision:'approve'});await until(()=>store.snapshot(task).surface_updates.length===1)
 pending=store.snapshot(task).surface_updates[0]!;saveAnswer('newer input')
 await expect(call('surface.respond',{task_id:task,action_id:pending.action_id,proceed:true,confirm_discard:false})).rejects.toMatchObject({code:'VERSION_CONFLICT'})
 expect(store.snapshot(task).views[0]).toMatchObject({revision:1,draft:{answer:'newer input'}})
})
it('registers an independent read invocation with no fabricated Run or approval',async()=>{
 const caller=await plugin(),target=await plugin('read','fixture.target'),r=await run(caller.capability,{invocation:{capability:target.capability,arguments:{value:'independent'},references:[]}})
 expect(await r.result).toMatchObject({execution:'success'});call('run.cancel',{task_id:task,run_id:r.id});await release(caller.capability)
 await until(()=>(db.prepare('SELECT count(*) AS n FROM calls WHERE run_id IS NULL AND state=\'ended\'').get() as any).n===1)
 expect(db.prepare('SELECT run_id,kind,result FROM actions').get()).toEqual({run_id:null,kind:'invocation',result:'success'})
 expect(store.snapshot(task).approvals).toHaveLength(0)
 const result=JSON.parse((db.prepare('SELECT result_json FROM calls WHERE run_id IS NULL').get() as any).result_json)
 expect(result).toMatchObject({execution:'success',data:{value:'independent'}})
})
it('gates an independent external invocation and records dispatch separately from execution',async()=>{
 const caller=await plugin(),target=await plugin('external-write','fixture.target'),r=await run(caller.capability,{invocation:{capability:target.capability,arguments:{value:'approved'},references:[]}})
 expect(await r.result).toMatchObject({execution:'success'});call('run.cancel',{task_id:task,run_id:r.id});await release(caller.capability)
 const a=await approval();expect(a.run_id).toBeNull();expect(db.prepare('SELECT dispatch FROM calls WHERE run_id IS NULL').get()).toEqual({dispatch:'not_sent'})
 call('approval.decide',{task_id:task,approval_id:a.id,decision:'approve'})
 await until(()=>(db.prepare('SELECT state FROM calls WHERE run_id IS NULL').get() as any)?.state==='ended')
 expect(db.prepare('SELECT kind,result FROM actions').get()).toEqual({kind:'invocation',result:'success'})
 expect(JSON.parse((db.prepare('SELECT result_json FROM actions').get() as any).result_json)).toMatchObject({dispatched:'sent',tool_execution:'not_proven'})
 expect(db.prepare('SELECT execution FROM calls WHERE run_id IS NULL').get()).toEqual({execution:'success'})
})
it('links real nested calls and keeps reverse result queries responsive',async()=>{
 const caller=await plugin(),target=await plugin('read','fixture.target'),r=await run(caller.capability,{nested:{capability:target.capability,arguments:{value:'child result'},references:[]}})
 expect(await r.result).toMatchObject({execution:'success',data:{value:{state:'ended',execution:'success',result:{data:{value:'child result'}}}}})
 const rows=db.prepare('SELECT id,parent_call_id,run_id,execution FROM calls ORDER BY rowid').all() as any[]
 expect(rows).toHaveLength(2);expect(rows[1]).toMatchObject({parent_call_id:rows[0].id,run_id:r.id,execution:'success'})
 expect(JSON.parse((db.prepare('SELECT result_json FROM calls WHERE id=?').get(rows[1].id) as any).result_json)).toMatchObject({data:{value:'child result'}})
})
it('rejects actual self reentry without creating or dispatching a second Call',async()=>{
 const caller=await plugin(),r=await run(caller.capability,{nested:{capability:caller.capability,arguments:{value:'must not run'},references:[]}})
 expect(await r.result).toMatchObject({execution:'success',data:{value:{rpc_error:{data:{code:'PLUGIN_CALL_CYCLE'}}}}})
 expect(db.prepare('SELECT id FROM calls').all()).toHaveLength(1)
})
it('receives actual plugin upload and atomically publishes it with the successful original Call',async()=>{
 const caller=await plugin(),text='bounded upload '.repeat(1000),r=await run(caller.capability,{upload:text,sha256:createHash('sha256').update(Buffer.from(text)).digest('hex')}),result=await r.result
 expect(result).toMatchObject({execution:'success',data:{value:{state:'prepared',published:false}},resources:[{byte_length:Buffer.byteLength(text)}]})
 expect(db.prepare('SELECT state FROM staging').get()).toEqual({state:'committed'})
 expect(db.prepare('SELECT result FROM actions').get()).toEqual({result:'success'})
 expect(db.prepare('SELECT byte_length FROM resources').get()).toEqual({byte_length:Buffer.byteLength(text)})
})
it('resourceizes a large valid JSON result and returns only a bounded preview',async()=>{
 const caller=await plugin(),text='large-result '.repeat(2000),r=await run(caller.capability,text),result=await r.result
 expect(result).toMatchObject({execution:'success',truncated:true,resources:[{media_type:'application/json'}]})
 expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(8192)
 const resource=result.resources[0],read:any=await call('task.query',{task_id:task,query:{type:'read',input:{target:{kind:'resource',id:resource.id}}}})
 const fragments=[read.data.text];let next=read.next_cursor
 while(next){const part:any=await call('task.query',{task_id:task,query:{type:'read',input:{target:{kind:'resource',id:resource.id},cursor:next}}});fragments.push(part.data.text);next=part.next_cursor}
 const full=read.truncated?JSON.parse(fragments.join('')):read.data
 expect(full.content.value).toEqual({value:text})
 expect(db.prepare('SELECT state FROM staging').get()).toEqual({state:'committed'})
})
it('invalid arguments never create an invocation approval or dispatch',async()=>{
 const target=await plugin('external-write'),id=store.start(task,'fixture','fixture',[])
 await expect(store.agentTool(task,id,{type:'call',input:{capability:target.capability,arguments:{},references:[]}},new AbortController().signal)).rejects.toMatchObject({code:'PLUGIN_ARGUMENTS_INVALID'})
 expect(db.prepare('SELECT id FROM calls').all()).toEqual([]);expect(store.snapshot(task).approvals).toEqual([])
})
it('invalidates a pending mutation as soon as its parent returns without awaiting it',async()=>{
 const p=await plugin();await schedule(p.capability,{type:'task_data.create',data:{schema:dataSchema,value:{stage:'initial'},references:[]}});await until(()=>store.snapshot(task).task_data.total===1)
 const data=store.snapshot(task).task_data.items[0]!,r=await run(p.capability,{early:{type:'task_data.replace',id:data.id,expected_revision:1,value:{stage:'must not commit'},references:[]}})
 expect(await r.result).toMatchObject({execution:'unknown'})
 await until(()=>!(db.prepare("SELECT id FROM actions WHERE state!='ended'").get()))
 const a=store.snapshot(task).approvals[0]!;expect(a.validity).toBe('revoked')
 expect(()=>call('approval.decide',{task_id:task,approval_id:a.id,decision:'approve'})).toThrow()
 expect(store.snapshot(task).task_data.items[0]!.revision).toBe(1)
})
it('permits verified approval waiting but refuses business submissions during it',async()=>{
 const waiting=vi.spyOn((store as any).pluginProcesses,'waiting')
 const caller=await plugin(),target=await plugin('external-write','fixture.target'),r=await run(caller.capability,{wait:true,nested:{capability:target.capability,arguments:{value:'child'},references:[]}}),a=await approval()
 await until(()=>waiting.mock.calls.some(args=>args[1]===false))
 call('approval.decide',{task_id:task,approval_id:a.id,decision:'approve'})
 expect(await r.result).toMatchObject({execution:'success',data:{value:{execution:'success'},waiting_error:{data:{code:'PLUGIN_SOURCE_WAITING'}}}})
 expect(store.snapshot(task).task_data.total).toBe(0)
})
it('rejects a global tool service query outside its current task call',async()=>{
 const other=store.create('other task').task.id,p=await plugin('read','fixture.global',true),r=await run(p.capability,{cross:other})
 expect(await r.result).toMatchObject({execution:'success',data:{value:{rpc_error:{data:{code:'PLUGIN_SCOPE_DENIED'}}}}})
})

it('allows safety revocation during maintenance without opening new execution permission',async()=>{
 const p=await plugin(),token=call('maintenance.begin').reservation.token
 await expect(call('plugin.trust',{digest:p.digest,confirm_local_code:true,confirm_cross_task:false})).rejects.toThrow()
 await call('plugin.revoke',{digest:p.digest})
 expect((await call('plugin.list',{task_id:task})).items[0]).toMatchObject({trusted:false,enabled:false,instances:[]})
 call('maintenance.cancel',{token})
})
it('preserves execution success separately from failed output storage without replaying',async()=>{
 const p=await plugin(),saving=vi.spyOn((store as any).pluginUploads,'receiveResult').mockRejectedValueOnce(Error('injected disk fault'))
 const r=await run(p.capability,'long output '.repeat(2000)),result=await r.result
 expect(result).toMatchObject({execution:'success',delivery:'failed'})
 expect(db.prepare('SELECT dispatch,execution,delivery FROM calls').all()).toEqual([{dispatch:'sent',execution:'success',delivery:'failed'}])
 expect(saving).toHaveBeenCalledOnce();expect(db.prepare('SELECT id FROM resources').all()).toEqual([])
})
it('does not return an old asynchronous plugin query after its runtime source changes',async()=>{
 let release!:(value:unknown)=>void
 vi.spyOn((store as any).pluginQueries,'query').mockImplementation(()=>new Promise(done=>{release=done}))
 const pending=call('task.query',{task_id:task,query:{type:'list',input:{kind:'plugin'}}})
 const assertion=expect(pending).rejects.toMatchObject({code:'QUERY_SOURCE_CHANGED'})
 ;(store as any).epoch=crypto.randomUUID();release({items:[]});await assertion
})

it('rejects actual A to B to A reentry using the host-owned instance chain',async()=>{
 const a=await plugin(),b=await plugin('read','fixture.target')
 const r=await run(a.capability,{nested:{capability:b.capability,arguments:{value:{nested:{capability:a.capability,arguments:{value:'must not execute'},references:[]}}},references:[]}})
 expect(await r.result).toMatchObject({execution:'success',data:{value:{execution:'success',result:{data:{value:{rpc_error:{data:{code:'PLUGIN_CALL_CYCLE'}}}}}}}})
 expect(db.prepare('SELECT id FROM calls').all()).toHaveLength(2)
})
it('rechecks an approved invocation expiry after waiting for its serial instance',async()=>{
 const p=await plugin('external-write'),first=await run(p.capability,{delay:300}),a=await approval()
 call('approval.decide',{task_id:task,approval_id:a.id,decision:'approve'})
 await until(()=>(db.prepare("SELECT dispatch FROM calls ORDER BY rowid LIMIT 1").get() as any).dispatch==='sent')
 const second=store.agentTool(task,first.id,{type:'call',input:{capability:p.capability,arguments:{value:'must not dispatch'},references:[]}},new AbortController().signal),b=await approval()
 call('approval.decide',{task_id:task,approval_id:b.id,decision:'approve'})
 await until(()=>(db.prepare('SELECT state FROM calls ORDER BY rowid DESC LIMIT 1').get() as any).state==='executing')
 db.prepare('UPDATE approvals SET expires_at=? WHERE id=?').run(new Date(Date.now()-1).toISOString(),b.id)
 expect(await first.result).toMatchObject({execution:'success'});expect(await second).toMatchObject({execution:'not_executed'})
 expect(db.prepare('SELECT dispatch,execution FROM calls ORDER BY rowid DESC LIMIT 1').get()).toEqual({dispatch:'not_sent',execution:'not_executed'})
})

it('publishes resource-backed plugin drafts and preserves source-bound replacement approval',async()=>{
 const p=await plugin(),id=store.start(task,'fixture resources','fixture',[]);clearTimeout((store as any).timers.get(id))
 const resource:any=store.modelTool(task,id,{type:'write',input:{type:'resource.create',display_name:'plugin-bundle.json',content:{type:'json',value:viewBundle('resource')}}});call('run.cancel',{task_id:task,run_id:id})
 const ref={type:'resource',resource:{kind:'resource',id:resource.data.id}},s=store.snapshot(task)
 await surface(p.capability,{type:'surface.update',surface_id:s.surface.id,expected_revision:s.surface.revision,operations:[{type:'view.create',client_ref:'resource',slot_id:'main',bundle:ref}]});await until(()=>store.snapshot(task).views.length===1)
 const input:any=replacement();input.operations[0].bundle=ref;await surface(p.capability,input);const a=await approval()
 const row=db.prepare('SELECT request_json FROM actions WHERE id=?').get(a.action_id) as any;expect(JSON.parse(row.request_json)).toEqual(input)
 expect(a.request).toMatchObject({version:1,effective_request:{operations:[{bundle:{type:'inline',bundle:{profile:'managed-v1'}}}]},sources:[{id:resource.data.id}]})
 call('approval.decide',{task_id:task,approval_id:a.id,decision:'approve'});await until(()=>store.snapshot(task).surface_updates.length===1)
 await call('surface.respond',{task_id:task,action_id:store.snapshot(task).surface_updates[0]!.action_id,proceed:true,confirm_discard:false});expect(store.snapshot(task).views[0]!.revision).toBe(2)
})
it('rejects overlapping plugin publications at staging without registering an action',async()=>{
 const p=await plugin(),s=store.snapshot(task),b=viewBundle();b.html='<section id="lesson">'+b.html+'</section>';b.export=[{id:'one',category:'learning',source:{type:'element',element_id:'lesson'}},{id:'two',category:'learning',source:{type:'element',element_id:'answer'}}]
 const r=await run(p.capability,{inspect_surface:{type:'surface.update',surface_id:s.surface.id,expected_revision:s.surface.revision,operations:[{type:'view.create',client_ref:'bad',slot_id:'main',bundle:{type:'inline',bundle:b}}]}})
 expect(await r.result).toMatchObject({execution:'success',data:{value:{rpc_error:expect.anything()}}})
 expect(store.snapshot(task).views).toHaveLength(0);expect(store.snapshot(task).approvals).toHaveLength(0)
 expect(db.prepare('SELECT count(*) AS n FROM actions').get()).toEqual({n:0})
})
