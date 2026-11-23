import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import defaults from '../shared/contracts/development-defaults.json'
import { ContractError } from '../shared/validation'
import { isMaterialRemoved, materialRemoved } from './material-removals'
type Row=Record<string,any>
const pending="state IN ('queued','confirmation_required')"
const fail=(code:string):never=>{throw new ContractError(code,'Request not started. Query the original request and explicitly resolve its state; no automatic replay.')}
export class RequestQueue {
 private timer:ReturnType<typeof setTimeout>|undefined
 private closed=false
 private after=0
 private through=0
 private checking=new Set<string>()
 busy():boolean{return this.checking.size>0}
 checkingRequest(id:string):boolean{return this.checking.has(id)}
 // A host admission adapter owns Run limits and actual call/cleanup conflicts.
 // Without it, the legacy single-Run and Task-wide resource guards still apply.
 constructor(private db:Database.Database,private epoch:string,private selection:(id:string)=>Row,private validateResource:(task:string,id:string)=>Row,private start:(task:string,text:string,config:string,attachments:Row[],requestId:string)=>string|Promise<string>,private available:()=>boolean,private preflight?:(task:string,resources:Row[])=>Promise<void>,private canAdmit?:(task:string,request:string)=>boolean,private receive?:(task:string,request:string,input:Row)=>Row){this.schedule()}
 close():void{this.closed=true;clearTimeout(this.timer)}
 private task(id:string):void{const t=this.db.prepare('SELECT state FROM tasks WHERE id=?').get(id) as Row|undefined;if(t?.state!=='active')fail('REQUEST_TASK_INACTIVE')}
 private row(task:string,id:string):Row{const row=this.db.prepare('SELECT * FROM requests WHERE id=? AND task_id=?').get(id,task) as Row|undefined;if(!row||JSON.parse(row.input_json).binding_version!==1)fail('REQUEST_NOT_FOUND');return row!}
 private action(task:string,id:string):Row{const row=this.db.prepare("SELECT * FROM actions WHERE id=? AND task_id=? AND json_extract(request_json,'$.type')='material.import'").get(id,task) as Row|undefined;if(!row)fail('REQUEST_IMPORT_INVALID');return row!}
 private inputs(row:Row):Row{const input=JSON.parse(row.input_json);if(input.epoch!==this.epoch)fail('REQUEST_SOURCE_INVALID');return input}
 private materialBinding(input:Row):{resourceIds:string[];importIds:string[]}{
  if(input.resource_ids?.length||input.import_ids?.length)return {resourceIds:input.resource_ids??[],importIds:input.import_ids??[]}
  // Freeze imported materials at acceptance, before a queued request can wait.
  // Generated resources and unsuccessful imports are not default attachments.
  const resources=this.db.prepare(`SELECT DISTINCT t.resource_id FROM actions a JOIN task_resources t ON t.task_id=a.task_id AND t.resource_id=json_extract(a.result_json,'$.resource.id') WHERE a.task_id=? AND json_extract(a.request_json,'$.type')='material.import' AND a.state='ended' AND a.result='success' AND NOT ${materialRemoved('t.task_id', 't.resource_id')} ORDER BY a.rowid LIMIT 51`).all(input.task_id) as Row[]
  const imports=this.db.prepare("SELECT id FROM actions WHERE task_id=? AND json_extract(request_json,'$.type')='material.import' AND state!='ended' ORDER BY rowid LIMIT 51").all(input.task_id) as Row[]
  return {resourceIds:resources.map(row=>row.resource_id),importIds:imports.map(row=>row.id)}
 }
 private inspect(row:Row):Row{
  const input=JSON.parse(row.input_json),items:Row[]=[],ids=new Set<string>();let waiting=false,failed=false
  for(const id of input.resource_ids){if(ids.has(id))continue;ids.add(id);const r=this.db.prepare('SELECT r.id,r.display_name,r.byte_length,r.media_type,r.sha256 FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? AND r.id=?').get(row.task_id,id) as Row|undefined;items.push(r?{...r,state:'success'}:{id,state:'unavailable'});if(!r)failed=true}
  for(const id of input.import_ids){const a=this.action(row.task_id,id),request=JSON.parse(a.request_json),result=a.result_json?JSON.parse(a.result_json):null;if(a.state!=='ended'){waiting=true;items.push({operation_id:id,display_name:request.display_name,state:'waiting'})}else if(a.result==='success'&&result?.resource?.id){if(!ids.has(result.resource.id)){ids.add(result.resource.id);items.push({...result.resource,operation_id:id,state:'success'})}}else{failed=true;items.push({operation_id:id,display_name:request.display_name,state:'failed',retryable:['failure','not_executed'].includes(a.result),code:result?.code??'IMPORT_INTERRUPTED'})}}
  return {items,waiting,failed}
 }
 private public(row:Row):Row{const input=JSON.parse(row.input_json),run=input.chapter_run_id?this.db.prepare('SELECT id,state FROM runs WHERE id=? AND task_id=?').get(input.chapter_run_id,row.task_id) as Row|undefined:this.db.prepare("SELECT r.id,r.state FROM runs r LEFT JOIN runner_runs n ON n.run_id=r.id WHERE r.request_id=? AND (n.purpose IS NULL OR n.purpose='production') ORDER BY (r.state IN ('running','waiting')) DESC,r.rowid DESC LIMIT 1").get(row.id) as Row|undefined;return {request_id:row.id,task_id:row.task_id,state:row.state,code:input.code??null,text:input.text.slice(0,500),text_truncated:input.text.length>500,model_selection:JSON.parse(row.config_selection_json),materials:this.inspect(row).items,run_id:run?.id??null,run_state:run?.state??null,created_at:row.created_at}}
 handle(r:Row):Row{
  if(r.type==='request.list'){const rows=this.db.prepare("SELECT rowid ordinal,* FROM requests WHERE task_id=? AND json_extract(input_json,'$.binding_version')=1 AND rowid<? ORDER BY rowid DESC LIMIT 21").all(r.task_id,r.before??Number.MAX_SAFE_INTEGER) as Row[];const items:Row[]=[];let bytes=0;for(const row of rows.slice(0,20)){const value=this.public(row),size=Buffer.byteLength(JSON.stringify(value));if(items.length&&bytes+size>defaults.transport.rpc_message_bytes/2)break;items.push(value);bytes+=size}const counts=this.db.prepare("SELECT count(*) pending,COALESCE(sum(state='confirmation_required'),0) confirmation FROM requests WHERE task_id=? AND json_extract(input_json,'$.binding_version')=1 AND state IN ('queued','confirmation_required')").get(r.task_id);return {items,next_before:rows.length>items.length?rows[items.length-1]!.ordinal:null,summary:counts}}
  if(r.type==='request.submit'){
   this.task(r.task_id);if(!r.text.trim()||Buffer.byteLength(r.text)>defaults.data.object_bytes)fail('INVALID_INPUT')
   const config=this.selection(r.model_config_id),id=randomUUID()
   this.db.transaction(()=>{
    const {resourceIds,importIds}=this.materialBinding(r);if(resourceIds.length+importIds.length>50||new Set(resourceIds).size!==resourceIds.length||new Set(importIds).size!==importIds.length)fail('REQUEST_MATERIAL_LIMIT')
    const count=this.db.prepare(`SELECT count(*) n FROM requests WHERE task_id=? AND ${pending}`).get(r.task_id) as Row;if(count.n>=defaults.queues.task_pending)fail('REQUEST_QUEUE_FULL')
    for(const id of resourceIds){if(isMaterialRemoved(this.db,r.task_id,id))fail('REQUEST_MATERIAL_REMOVED');this.validateResource(r.task_id,id)}
    for(const id of importIds){const a=this.action(r.task_id,id),resource=a.result==='success'&&JSON.parse(a.result_json)?.resource?.id;if(resource&&isMaterialRemoved(this.db,r.task_id,resource))fail('REQUEST_MATERIAL_REMOVED')}
    const input={binding_version:1,epoch:this.epoch,text:r.text,resource_ids:resourceIds,import_ids:importIds,code:null}
    const received={...input,...this.receive?.(r.task_id,id,input)}
    this.db.prepare("INSERT INTO requests VALUES (?,?,'queued',?,?,?)").run(id,r.task_id,JSON.stringify(config),JSON.stringify(received),new Date().toISOString())
   })()
   this.tickTask(r.task_id);return this.public(this.row(r.task_id,id))
  }
  const row=this.row(r.task_id,r.request_id)
  if(r.type==='request.status')return this.public(row)
  if(r.type==='request.cancel'){if(['queued','confirmation_required'].includes(row.state)){const input=this.inputs(row);this.update(row,'cancelled',{...input,code:'USER_CANCELLED'})}return this.public(this.row(row.task_id,row.id))}
  if(r.type==='request.resolve'){
   this.task(row.task_id);if(row.state!=='confirmation_required')fail('REQUEST_NOT_CONFIRMABLE');let input=this.inputs(row)
   for(const replacement of r.replacements??[]){if(!input.import_ids.includes(replacement.operation_id))fail('REQUEST_RETRY_INVALID');const prior=this.action(row.task_id,replacement.operation_id),next=this.action(row.task_id,replacement.new_operation_id);if(prior.state!=='ended'||!['failure','not_executed'].includes(prior.result)||JSON.parse(next.request_json).retry_of!==prior.id)fail('REQUEST_RETRY_INVALID');input={...input,import_ids:input.import_ids.map((id:string)=>id===prior.id?next.id:id)}}
   const changed={...row,input_json:JSON.stringify(input)},inspection=this.inspect(changed)
   if(r.use_successful){if(inspection.waiting)fail('REQUEST_IMPORT_PENDING');if(inspection.items.some((x:Row)=>x.state==='unavailable'))fail('REQUEST_MATERIAL_UNAVAILABLE');input={...input,resource_ids:inspection.items.filter((x:Row)=>x.state==='success').map((x:Row)=>x.id),import_ids:[]}}
   if(!r.use_successful&&inspection.failed)fail('REQUEST_MATERIALS_INCOMPLETE')
   const selection=this.selection(r.model_config_id)
   this.db.transaction(()=>{this.db.prepare('UPDATE requests SET config_selection_json=? WHERE id=?').run(JSON.stringify(selection),row.id);this.update(row,'queued',{...input,code:null})})()
   this.tickTask(row.task_id);return this.public(this.row(row.task_id,row.id))
  }
  return fail('UNSUPPORTED_OPERATION')
 }
 private update(row:Row,state:string,input:Row):void{this.db.prepare(`UPDATE requests SET state=?,input_json=? WHERE id=? AND ${pending}`).run(state,JSON.stringify(input),row.id)}
 invalidateConfiguration():void{for(const row of this.db.prepare(`SELECT * FROM requests WHERE ${pending} AND json_extract(input_json,'$.binding_version')=1`).all() as Row[])this.update(row,'confirmation_required',{...JSON.parse(row.input_json),code:'REQUEST_CONFIGURATION_CHANGED'})}
 cancelTask(task:string):void{for(const row of this.db.prepare(`SELECT * FROM requests WHERE task_id=? AND ${pending} AND json_extract(input_json,'$.binding_version')=1`).all(task) as Row[])this.update(row,'cancelled',{...JSON.parse(row.input_json),code:'TASK_STOPPED'})}
 private admitted(task:string,request:string):boolean{
  if(this.closed||!this.available())return false
  if(this.canAdmit)return this.canAdmit(task,request)===true
  if(this.db.prepare("SELECT 1 FROM runs WHERE task_id=? AND state IN ('running','waiting')").get(task))return false
  return !this.db.prepare("SELECT 1 FROM calls WHERE task_id=? AND state!='ended' UNION ALL SELECT 1 FROM cleanup_jobs WHERE task_id=? AND necessary=1 AND state!='done' LIMIT 1").get(task,task)
 }
 private tickTask(task:string):void{
  if(this.closed||!this.available())return
  const rows=this.db.prepare("SELECT * FROM requests WHERE task_id=? AND state='queued' AND json_extract(input_json,'$.binding_version')=1 ORDER BY rowid LIMIT ?").all(task,defaults.queues.task_pending) as Row[]
  for(const row of rows)this.tickRequest(row)
 }
 private startFailed(row:Row,error:unknown):void{
  if(this.closed)return
  const fresh=this.db.prepare('SELECT * FROM requests WHERE id=? AND task_id=?').get(row.id,row.task_id) as Row|undefined
  if(fresh?.state==='queued'&&fresh.input_json===row.input_json&&fresh.config_selection_json===row.config_selection_json)this.update(row,'confirmation_required',{...JSON.parse(row.input_json),code:error instanceof ContractError?error.code:'REQUEST_START_FAILED'})
 }
 private tickRequest(row:Row):void{
  if(this.closed||this.checking.has(row.id)||!this.available())return
  const task=row.task_id
  let deferred=false
  try{
   if(!this.admitted(task,row.id))return
   this.checking.add(row.id)
   this.task(task);const input=this.inputs(row),inspection=this.inspect(row)
   if(inspection.waiting)return
   if(inspection.failed){this.update(row,'confirmation_required',{...input,code:'REQUEST_MATERIALS_INCOMPLETE'});return}
   const saved=JSON.parse(row.config_selection_json),current=this.selection(saved.id)
   if(JSON.stringify(saved)!==JSON.stringify(current))fail('REQUEST_CONFIGURATION_CHANGED')
   const resources=inspection.items.map((item:Row)=>this.validateResource(task,item.id))
   const start=()=>{
    if(!this.admitted(task,row.id))return
    this.task(task);const fresh=this.row(task,row.id)
    if(fresh.state!=='queued'||fresh.input_json!==row.input_json||fresh.config_selection_json!==row.config_selection_json)return
    if(JSON.stringify(this.selection(saved.id))!==JSON.stringify(saved))fail('REQUEST_CONFIGURATION_CHANGED')
    const latest=this.inspect(fresh)
    if(latest.waiting)return
    if(latest.failed)fail('REQUEST_MATERIALS_INCOMPLETE')
    const checked=latest.items.map((resource:Row)=>this.validateResource(task,resource.id))
    if(JSON.stringify(checked)!==JSON.stringify(resources))fail('REQUEST_MATERIAL_UNAVAILABLE')
    return this.start(task,input.text,saved.id,resources.map((x:Row)=>({kind:'resource',id:x.id})),row.id)
   }
   if(this.preflight&&resources.some((resource:Row)=>resource.byte_length>262144)){
    const check=this.preflight(task,resources)
    deferred=true
    void check.then(start).catch(error=>this.startFailed(row,error)).finally(()=>this.checking.delete(row.id))
   }else {
    const result=start()
    if(result&&typeof result!=='string'){
     deferred=true
     void result.catch(error=>this.startFailed(row,error)).finally(()=>this.checking.delete(row.id))
    }
   }
  }catch(error){this.startFailed(row,error)}finally{if(!deferred)this.checking.delete(row.id)}
 }
 private schedule():void{this.timer=setTimeout(()=>{if(this.closed)return;try{
  // Fix each sweep's end so continuous arrivals cannot starve an earlier wait.
  if(this.after===0)this.through=(this.db.prepare('SELECT COALESCE(max(rowid),0) ordinal FROM requests').get() as Row).ordinal
  const rows=this.db.prepare("SELECT rowid ordinal,* FROM requests WHERE state='queued' AND json_extract(input_json,'$.binding_version')=1 AND rowid>? AND rowid<=? ORDER BY rowid LIMIT 50").all(this.after,this.through) as Row[]
  for(const row of rows)this.tickRequest(row)
  this.after=rows.length===50&&rows.at(-1)!.ordinal<this.through?rows.at(-1)!.ordinal:0
 }catch{/* Original persistent requests remain queryable after a scheduling failure. */}this.schedule()},250);this.timer.unref?.()}
}
