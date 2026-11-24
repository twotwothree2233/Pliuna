import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {RuntimeStore} from '../../src/runtime/store'
let root:string,store:RuntimeStore,task:string
beforeEach(()=>{vi.useFakeTimers();root=fs.mkdtempSync(join(tmpdir(),'pliuna-request-'));store=new RuntimeStore(root);task=store.create('request fixture').task.id})
afterEach(()=>{vi.restoreAllMocks();store.close();fs.rmSync(root,{recursive:true,force:true});vi.useRealTimers()})
const call=(type:string,extra:Record<string,unknown>={})=>store.handle({type,task_id:task,...extra}) as any
const submit=(extra={})=>call('request.submit',{text:'synthetic request',model_config_id:'fixture',resource_ids:[],import_ids:[],...extra})
const db=()=>new Database(join(root,'pliuna.sqlite'))
function reg(){return call('material.internal.register',{items:[{display_name:'test.txt',source:'text'}]}).items[0].operation_id}
function save(id=reg()){call('material.internal.begin',{operation_id:id,byte_length:3,media_type:'text/plain; charset=utf-8'});call('material.internal.chunk',{operation_id:id,offset:0,data:Buffer.from('abc').toString('base64')});return call('material.internal.finish',{operation_id:id}).resource.id}
const resolve=(id:string,extra={})=>call('request.resolve',{request_id:id,model_config_id:'fixture',confirm:true,use_successful:false,replacements:[],...extra})
it('starts one registered request atomically and binds metadata not source content',()=>{const resource=save(),r=submit({resource_ids:[resource]});expect(r).toMatchObject({state:'started',materials:[{id:resource,state:'success'}]});const d=db();const input=JSON.parse((d.prepare('SELECT input_json FROM requests WHERE id=?').get(r.request_id) as any).input_json);expect(input.bound_materials).toMatchObject([{id:resource,byte_length:3}]);expect(JSON.stringify(input)).not.toContain(root);expect(d.prepare('SELECT id FROM runs WHERE request_id=?').all(r.request_id)).toHaveLength(1);d.close();expect(call('request.status',{request_id:r.request_id}).run_id).toBe(r.run_id)})
it('keeps waiting requests outside Run and dispatches FIFO',async()=>{const a=submit(),b=submit(),c=submit();expect([a.state,b.state,c.state]).toEqual(['started','queued','queued']);expect(store.snapshot(task).runs).toHaveLength(1);await vi.advanceTimersByTimeAsync(260);expect(call('request.status',{request_id:b.request_id}).state).toBe('started');expect(call('request.status',{request_id:c.request_id}).state).toBe('queued');await vi.advanceTimersByTimeAsync(300);expect(call('request.status',{request_id:c.request_id}).state).toBe('started')})
it('approval waiting counts as an occupied Run',async()=>{const a=submit(),d=db();d.prepare("UPDATE runs SET state='waiting',wait_reason='approval' WHERE id=?").run(a.run_id);d.close();const b=submit();await vi.advanceTimersByTimeAsync(100);expect(b.state).toBe('queued');expect(store.snapshot(task).runs).toHaveLength(1)})
it('does not globally serialize different tasks',()=>{submit();const other=store.create('other').task.id;expect(store.handle({type:'request.submit',task_id:other,text:'other',model_config_id:'fixture',resource_ids:[],import_ids:[]})).toMatchObject({state:'started'})})
it('waits for receiving import without Run and starts only after commit',async()=>{const id=reg(),r=submit({import_ids:[id]});expect(r.state).toBe('queued');expect(store.snapshot(task).runs).toHaveLength(0);save(id);await vi.advanceTimersByTimeAsync(251);expect(call('request.status',{request_id:r.request_id}).state).toBe('started')})
it.each(['failure','cancel'])('requires explicit partial selection after import %s',mode=>{const resource=save(),id=reg();if(mode==='failure')call('material.internal.fail',{operation_id:id,code:'IMPORT_SOURCE_UNAVAILABLE'});else call('material.cancel',{operation_id:id});const r=submit({resource_ids:[resource],import_ids:[id]});expect(r).toMatchObject({state:'confirmation_required',code:'REQUEST_MATERIALS_INCOMPLETE'});expect(r.materials.find((x:any)=>x.operation_id===id).retryable).toBe(mode==='failure');expect(store.snapshot(task).runs).toHaveLength(0);expect(()=>resolve(r.request_id)).toThrow();expect(resolve(r.request_id,{use_successful:true})).toMatchObject({state:'started',materials:[{id:resource,state:'success'}]});expect(call('material.read',{resource_id:resource})).toMatchObject({text:'abc'})})
it('accepts only an explicit failed-item retry and waits without reimporting success',async()=>{const id=reg();call('material.internal.fail',{operation_id:id,code:'IMPORT_SOURCE_UNAVAILABLE'});const r=submit({import_ids:[id]});const retry=call('material.internal.register',{items:[{display_name:'retry.txt',source:'text'}],retry_of:id}).items[0].operation_id;expect(resolve(r.request_id,{replacements:[{operation_id:id,new_operation_id:retry}]}).state).toBe('queued');save(retry);await vi.advanceTimersByTimeAsync(251);expect(call('request.status',{request_id:r.request_id}).state).toBe('started');expect(call('material.list').items).toHaveLength(2)})
it('rejects duplicate IDs, cross-task resources and spoofed paths',()=>{const resource=save(),other=store.create('other').task.id;expect(()=>store.handle({type:'request.submit',task_id:other,text:'other',model_config_id:'fixture',resource_ids:[resource],import_ids:[]})).toThrow();expect(()=>submit({resource_ids:[resource,resource]})).toThrow();expect(()=>submit({path:'/private/synthetic'})).toThrow()})
it('cancels request without cancelling its independent import',async()=>{const id=reg(),r=submit({import_ids:[id]});expect(call('request.cancel',{request_id:r.request_id}).state).toBe('cancelled');save(id);await vi.advanceTimersByTimeAsync(501);expect(store.snapshot(task).runs).toHaveLength(0);expect(call('material.list').items[0].state).toBe('success')})
it('publishes a request cancellation to an open subscription without a Run change',()=>{
 const request=submit({import_ids:[reg()]}),first=call('sync.subscribe')
 expect(first.snapshot.message_requests).toContainEqual({id:request.request_id,state:'queued',code:null})
 call('request.cancel',{request_id:request.request_id})
 const next=call('sync.subscribe',{after:{runtime_epoch:first.runtime_epoch,cache_generation:first.cache_generation,sequence:first.sequence}})
 expect(next.deltas[0].changes[0].value.message_requests).toContainEqual({id:request.request_id,state:'cancelled',code:'USER_CANCELLED'})
 expect(store.snapshot(task).runs).toEqual([])
})
it('bounds pending queue20 and history page20 without replay',()=>{const id=reg();for(let n=0;n<20;n++)submit({import_ids:[id]});expect(()=>submit()).toThrowError(expect.objectContaining({code:'REQUEST_QUEUE_FULL'}));const a=call('request.list');expect(a.items).toHaveLength(20);expect(a.next_before).toBeNull();call('request.cancel',{request_id:a.items[0].request_id});submit({import_ids:[id]});const b=call('request.list');expect(call('request.list',{before:b.next_before}).items).toHaveLength(1);expect(store.snapshot(task).runs).toHaveLength(0)})
it('startup cancels old pending requests without replay',async()=>{const id=reg(),r=submit({import_ids:[id]});store.close();store=new RuntimeStore(root);expect(call('request.status',{request_id:r.request_id}).state).toBe('cancelled');await vi.advanceTimersByTimeAsync(501);expect(store.snapshot(task).runs).toHaveLength(0)})
it('task stop cancels queue before imports and resume does not replay',async()=>{const id=reg(),r=submit({import_ids:[id]});call('task.stop');expect(call('request.status',{request_id:r.request_id}).state).toBe('cancelled');expect(call('material.status',{operation_id:id}).state).toBe('cancelled');call('task.resume');await vi.advanceTimersByTimeAsync(251);expect(store.snapshot(task).runs).toHaveLength(0)})
it('configuration mutation invalidates pending choices',async()=>{const id=reg(),r=submit({import_ids:[id]});store.handle({type:'approval.configure',mode:'manual',model_id:'',confirm_external_processing:false});save(id);await vi.advanceTimersByTimeAsync(251);expect(call('request.status',{request_id:r.request_id})).toMatchObject({state:'confirmation_required',code:'REQUEST_CONFIGURATION_CHANGED'});expect(resolve(r.request_id).state).toBe('started')})
it('start transaction failure leaves no Run and a queryable original request',()=>{const d=db();d.exec("CREATE TRIGGER request_fail BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT,'injected'); END;");d.close();const r=submit();expect(r).toMatchObject({state:'confirmation_required',code:'REQUEST_START_FAILED',run_id:null});expect(store.snapshot(task).runs).toHaveLength(0);expect(store.snapshot(task).records.filter(x=>x.kind==='message.user')).toHaveLength(0)})
it('reservation pauses queue dispatch without additional request pin',async()=>{const resource=save(),id=reg(),r=submit({resource_ids:[resource],import_ids:[id]});call('material.cancel',{operation_id:id});const token=(store.handle({type:'maintenance.begin'}) as any).reservation.token;await vi.advanceTimersByTimeAsync(251);expect(store.snapshot(task).runs).toHaveLength(0);const d=db();expect(d.prepare("SELECT * FROM object_references WHERE source_kind='request'").all()).toEqual([]);expect(d.prepare('SELECT * FROM task_resources WHERE resource_id=?').all(resource)).toHaveLength(1);d.close();store.handle({type:'maintenance.cancel',token});await vi.advanceTimersByTimeAsync(251);expect(call('request.status',{request_id:r.request_id}).state).toBe('confirmation_required')})
it('task deletion cancels request, retains material and registers existing cleanup provenance',()=>{const resource=save(),id=reg();submit({resource_ids:[resource],import_ids:[id]});call('task.delete');expect(fs.existsSync(join(root,'resources',resource))).toBe(true);const candidate=(store.handle({type:'maintenance.resource.list'}) as any).items[0];expect(candidate.resource_id).toBe(resource);const d=db();expect(d.prepare('SELECT * FROM requests').all()).toEqual([]);d.close()})
it('source or destination content damage before start refuses dispatch',async()=>{const resource=save(),id=reg(),r=submit({resource_ids:[resource],import_ids:[id]});fs.writeFileSync(join(root,'resources',resource),'bad');call('material.cancel',{operation_id:id});expect(()=>resolve(r.request_id,{use_successful:true})).toThrow();expect(store.snapshot(task).runs).toHaveLength(0)})
it('lost registration response can be recovered by original list without creating a duplicate',()=>{const r=submit();const rows=call('request.list').items;expect(rows).toHaveLength(1);expect(rows[0].request_id).toBe(r.request_id);expect(call('request.status',{request_id:r.request_id}).run_id).toBe(r.run_id);expect(store.snapshot(task).runs).toHaveLength(1)})
it('stale or second resolution cannot create a duplicate Run',()=>{const id=reg();call('material.internal.fail',{operation_id:id,code:'IMPORT_SOURCE_UNAVAILABLE'});const r=submit({import_ids:[id]});resolve(r.request_id,{use_successful:true});expect(()=>resolve(r.request_id,{use_successful:true})).toThrow();expect(store.snapshot(task).runs).toHaveLength(1)})
it('request status remains bounded for long text',()=>{const id=reg(),r=submit({text:'字'.repeat(50000),import_ids:[id]});expect(r.text_truncated).toBe(true);expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(8192)})
it('waits until slow model cleanup releases the lease before starting next request',async()=>{const a=submit(),b=submit();const d=db();d.prepare("UPDATE runs SET commit_valid=0,intended_terminal='cancelled',state='waiting',wait_reason='ending_cleanup' WHERE id=?").run(a.run_id);d.close();expect(call('request.status',{request_id:b.request_id}).state).toBe('queued');await vi.advanceTimersByTimeAsync(100);expect(store.snapshot(task).runs).toHaveLength(1)})
it('restart after successful start preserves one Run but never executes it again',async()=>{const r=submit();store.close();store=new RuntimeStore(root);expect(call('request.status',{request_id:r.request_id})).toMatchObject({state:'started',run_id:r.run_id,run_state:'interrupted'});await vi.advanceTimersByTimeAsync(501);expect(store.snapshot(task).runs).toHaveLength(1)})
it('invalid unrelated retry cannot replace an original failed item',()=>{const id=reg();call('material.internal.fail',{operation_id:id,code:'IMPORT_SOURCE_UNAVAILABLE'});const r=submit({import_ids:[id]}),other=reg();expect(()=>resolve(r.request_id,{replacements:[{operation_id:id,new_operation_id:other}]})).toThrow();expect(call('request.status',{request_id:r.request_id}).state).toBe('confirmation_required')})
it('restoring a point cancels saved pending requests and preserves associated resources',async()=>{vi.useRealTimers();const resource=save(),id=reg(),r=submit({resource_ids:[resource],import_ids:[id]});call('material.cancel',{operation_id:id});const token=(store.handle({type:'maintenance.begin'}) as any).reservation.token,point=(await store.handle({type:'maintenance.create',token,inputs_saved:true,replace_id:null}) as any).active;const restore=(store.handle({type:'maintenance.begin'}) as any).reservation.token;await store.handle({type:'maintenance.restore',token:restore,point_id:point.id,database_sha256:point.database_sha256,inputs_saved:true,confirm_replace_newer_data:true});expect(call('request.status',{request_id:r.request_id}).state).toBe('cancelled');expect(call('material.read',{resource_id:resource}).text).toBe('abc');expect(store.snapshot(task).runs).toHaveLength(0)})

it("does not let the legacy entry jump a pending material request",()=>{const id=reg();submit({import_ids:[id]});expect(()=>store.start(task,"jump","fixture",[])).toThrowError(expect.objectContaining({code:"REQUEST_QUEUE_PENDING"}));expect(store.snapshot(task).runs).toHaveLength(0)})

it("invalid configuration input does not invalidate a waiting request",()=>{const id=reg(),r=submit({import_ids:[id]});expect(()=>store.handle({type:"approval.configure",mode:"invalid"})).toThrow();expect(call("request.status",{request_id:r.request_id}).state).toBe("queued")})

it('bounds material-heavy request history by bytes without losing page items',()=>{const d=db(),ids:string[]=[];for(let i=0;i<50;i++){const id=crypto.randomUUID();ids.push(id);d.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(id,id,'0'.repeat(64),1,'text/plain; charset=utf-8','材'.repeat(200),new Date().toISOString());d.prepare('INSERT INTO task_resources VALUES (?,?)').run(task,id)}for(let i=0;i<20;i++)d.prepare("INSERT INTO requests VALUES (?,?,'cancelled',?,?,?)").run(crypto.randomUUID(),task,JSON.stringify({id:'fixture'}),JSON.stringify({binding_version:1,epoch:store.epoch,text:'summary',resource_ids:ids,import_ids:[]}),new Date().toISOString());d.close();let page=call('request.list'),total=0;do{expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1048576);total+=page.items.length;if(!page.next_before)break;page=call('request.list',{before:page.next_before})}while(true);expect(total).toBe(20)})
it.each(['cancel','configure','stop'] as const)('late large-material verification never revives a %s decision',async mode=>{
 vi.useRealTimers();const body=Buffer.alloc(262145,97),operation=reg();call('material.internal.begin',{operation_id:operation,byte_length:body.length,media_type:'text/plain; charset=utf-8'});for(let offset=0;offset<body.length;offset+=262144)call('material.internal.chunk',{operation_id:operation,offset,data:body.subarray(offset,offset+262144).toString('base64')});const resource=(await call('material.internal.finish',{operation_id:operation})).resource.id
 const queue=(store as any).requests,original=queue.preflight;let release!:()=>void,started=false
 queue.preflight=async(...args:any[])=>{started=true;await new Promise<void>(resolve=>{release=resolve});return original(...args)}
 const request=submit({resource_ids:[resource]});expect(request.state).toBe('queued');expect(started).toBe(true);expect(()=>store.handle({type:'maintenance.begin'})).toThrow()
 if(mode==='cancel')call('request.cancel',{request_id:request.request_id});else if(mode==='stop')call('task.stop');else store.handle({type:'approval.configure',mode:'manual',model_id:'',confirm_external_processing:false})
 release();await vi.waitFor(()=>expect(queue.busy()).toBe(false));expect(store.snapshot(task).runs).toHaveLength(0);expect(call('request.status',{request_id:request.request_id}).state).toBe(mode==='configure'?'confirmation_required':'cancelled')
})
it('large-material preflight detects damage before creating any Run',async()=>{
 vi.useRealTimers();const body=Buffer.alloc(262145,97),operation=reg();call('material.internal.begin',{operation_id:operation,byte_length:body.length,media_type:'text/plain; charset=utf-8'});for(let offset=0;offset<body.length;offset+=262144)call('material.internal.chunk',{operation_id:operation,offset,data:body.subarray(offset,offset+262144).toString('base64')});const resource=(await call('material.internal.finish',{operation_id:operation})).resource.id
 fs.writeFileSync(join(root,'resources',resource),Buffer.alloc(body.length,98));const request=submit({resource_ids:[resource]});expect(request.state).toBe('queued');await vi.waitFor(()=>expect(call('request.status',{request_id:request.request_id})).toMatchObject({state:'confirmation_required',code:'RESOURCE_CORRUPT'}));expect(store.snapshot(task).runs).toHaveLength(0)
})

it('keeps current queue counts independent of the history page',()=>{
 const id=reg();for(let n=0;n<20;n++)submit({import_ids:[id]})
 const first=call('request.list');call('request.cancel',{request_id:first.items.at(-1).request_id});submit({import_ids:[id]})
 const current=call('request.list'),older=call('request.list',{before:current.next_before})
 expect(current.summary).toEqual({pending:20,confirmation:0});expect(older.items).toHaveLength(1);expect(older.items[0].state).toBe('cancelled');expect(older.summary).toEqual(current.summary)
})

it('binds already imported Task materials when the request has no explicit selection',()=>{
 const resources=[save(),save()],request=submit()
 expect(request.state).toBe('started')
 expect(new Set(request.materials.map((material:any)=>material.id))).toEqual(new Set(resources))
 const database=db()
 try{
  const input=JSON.parse((database.prepare('SELECT input_json FROM requests WHERE id=?').get(request.request_id) as any).input_json)
  expect(new Set(input.bound_materials.map((material:any)=>material.id))).toEqual(new Set(resources))
  expect(input.bound_materials).toEqual(expect.arrayContaining(resources.map(id=>expect.objectContaining({id,display_name:'test.txt',byte_length:3}))))
 }finally{database.close()}
})

it('waits for imports captured at acceptance and ignores materials added later',async()=>{
 const ready=save(),waiting=reg(),receiving=reg()
 call('material.internal.begin',{operation_id:receiving,byte_length:3,media_type:'text/plain; charset=utf-8'})
 const request=submit()
 expect(request.state).toBe('queued')
 expect(request.materials).toHaveLength(3)
 expect(new Set(request.materials.filter((material:any)=>material.operation_id).map((material:any)=>material.operation_id))).toEqual(new Set([waiting,receiving]))
 expect(store.snapshot(task).runs).toHaveLength(0)
 const late=save(),finished=save(waiting)
 await vi.advanceTimersByTimeAsync(251)
 expect(call('request.status',{request_id:request.request_id}).state).toBe('queued')
 expect(store.snapshot(task).runs).toHaveLength(0)
 call('material.internal.chunk',{operation_id:receiving,offset:0,data:Buffer.from('abc').toString('base64')})
 const received=call('material.internal.finish',{operation_id:receiving}).resource.id
 await vi.advanceTimersByTimeAsync(251)
 const completed=call('request.status',{request_id:request.request_id})
 expect(completed.state).toBe('started')
 expect(new Set(completed.materials.map((material:any)=>material.id))).toEqual(new Set([ready,finished,received]))
 expect(completed.materials.some((material:any)=>material.id===late)).toBe(false)
})

it('excludes failed, cancelled, removed, generated and foreign materials from the default selection',()=>{
 const available=save(),removed=save(),failed=reg(),cancelled=reg()
 call('material.internal.fail',{operation_id:failed,code:'IMPORT_SOURCE_UNAVAILABLE'})
 call('material.cancel',{operation_id:cancelled})
 const run=store.start(task,'Generate a separate result','fixture',[])
 const generated=(store.modelTool(task,run,{type:'write',input:{type:'resource.create',display_name:'result.txt',content:{type:'text',text:'generated result'}}}) as any).data.id
 const other=store.create('other Task').task.id
 const foreignCall=(type:string,extra:Record<string,unknown>={})=>store.handle({type,task_id:other,...extra}) as any
 const foreignImport=foreignCall('material.internal.register',{items:[{display_name:'foreign.txt',source:'text'}]}).items[0].operation_id
 foreignCall('material.internal.begin',{operation_id:foreignImport,byte_length:3,media_type:'text/plain; charset=utf-8'})
 foreignCall('material.internal.chunk',{operation_id:foreignImport,offset:0,data:Buffer.from('abc').toString('base64')})
 const foreign=foreignCall('material.internal.finish',{operation_id:foreignImport}).resource.id
 const database=db()
 try{database.prepare('DELETE FROM task_resources WHERE task_id=? AND resource_id=?').run(task,removed)}finally{database.close()}
 const request=submit()
 expect(request.materials).toHaveLength(1)
 expect(request.materials[0]).toMatchObject({id:available,state:'success'})
 expect(request.materials.some((material:any)=>[removed,generated,foreign].includes(material.id)||[failed,cancelled].includes(material.operation_id))).toBe(false)
})

it.each(['resource','import'] as const)('retains an explicit %s selection without adding default materials',kind=>{
 const selected=save(),unselected=save(),pending=reg()
 const request=submit(kind==='resource'?{resource_ids:[selected]}:{import_ids:[pending]})
 expect(request.materials).toHaveLength(1)
 expect(request.materials[0]).toMatchObject(kind==='resource'?{id:selected,state:'success'}:{operation_id:pending})
 expect(request.materials.some((material:any)=>material.id===unselected)).toBe(false)
 expect(request.state).toBe(kind==='resource'?'started':'queued')
})

it.each(['completed','mixed'] as const)('keeps all 50 default %s materials and rejects overflow without truncation',kind=>{
 const resources=Array.from({length:kind==='completed'?50:25},()=>save())
 const imports=kind==='mixed'?Array.from({length:25},()=>reg()):[]
 const request=submit()
 expect(request.materials).toHaveLength(50)
 expect(new Set(request.materials.filter((material:any)=>material.id).map((material:any)=>material.id))).toEqual(new Set(resources))
 expect(new Set(request.materials.filter((material:any)=>material.operation_id).map((material:any)=>material.operation_id))).toEqual(new Set(imports))
 expect(request.state).toBe(kind==='completed'?'started':'queued')
 reg()
 expect(()=>submit()).toThrowError()
 expect(call('request.list').items).toHaveLength(1)
 expect(call('request.status',{request_id:request.request_id}).materials).toHaveLength(50)
})
