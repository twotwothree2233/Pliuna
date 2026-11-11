import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeStore } from '../../src/runtime/store'
import { ChatAdapter } from '../../src/runtime/model/adapter'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import { requestAccounting } from '../../src/runtime/model/accounting'
import { performance as realPerformance } from 'node:perf_hooks'
let root:string,store:RuntimeStore,db:Database.Database,task:string,run:string
const config={id:'isolated',base_url:'https://example.invalid',wire_model_id:'synthetic',context_tokens:1000000,max_output_tokens:1024,compatibility_profile:'chat-max-tokens' as const}
beforeEach(()=>{vi.useFakeTimers();root=mkdtempSync(join(tmpdir(),'pliuna-accounting-runtime-'));store=new RuntimeStore(root);db=new Database(join(root,'pliuna.sqlite'));task=store.create('synthetic').task.id;run=store.start(task,'synthetic','fixture',[])})
afterEach(()=>{vi.restoreAllMocks();store.close();db.close();vi.useRealTimers()})
const read=():any=>store.handle({type:'task.query',task_id:task,query:{type:'read',input:{target:{kind:'run',id:run}}}})
const page=(cursor?:string):any=>store.handle({type:'host.run.accounting',task_id:task,run_id:run,...(cursor?{cursor}:{})})
function lease(){const value:ModelLease={id:config.id,revision:1,config,release(){}};(store as any).accountLease(task,run,value);return value}
it('persists strict versioned facts, shows incomplete dispatch unknown and restores without replay',()=>{
 const l=lease(),record=requestAccounting(l,[],undefined,1024,'main');record('reserved');record('dispatched')
 expect(read().data.accounting.requests[0]).toMatchObject({phase:'unknown',dispatched:true,usage:null})
 store.close();store=new RuntimeStore(root)
 expect(read().data.state).toBe('interrupted');expect(read().data.accounting.requests[0]).toMatchObject({phase:'unknown',dispatched:true,usage:null})
 expect(db.prepare("SELECT count(*) n FROM records WHERE kind='model.request.accounting'").get()).toEqual({n:2})
})
it('does not invent per-request details for old Runs, and rejects corrupted accounting records',()=>{
 expect(read().data.accounting).toMatchObject({recorded:false,requests:[]})
 const record=requestAccounting(lease(),[],undefined,1024,'summary');record('reserved')
 db.prepare("UPDATE records SET payload_json=json_set(payload_json,'$.version',9) WHERE kind='model.request.accounting'").run()
 expect(()=>read()).toThrow()
})
it('record persistence failure prevents dispatch and leaves original business data intact',async()=>{
 const adapter=new ChatAdapter(),service=new ModelService(adapter),complete=vi.spyOn(adapter,'complete')
 service.configure({type:'model.configure',configuration:config,api_key:'synthetic',confirm_memory_only:true})
 db.exec("CREATE TRIGGER reject_accounting BEFORE INSERT ON records WHEN NEW.kind='model.request.accounting' BEGIN SELECT RAISE(ABORT,'disk failure'); END")
 await expect(service.request(lease(),task,[],undefined,new AbortController().signal)).rejects.toThrow('disk failure')
 expect(complete).not.toHaveBeenCalled();expect(db.prepare('SELECT count(*) n FROM calls').get()).toEqual({n:0})
})
it('late usage recording never reactivates a cancelled Run',()=>{
 const record=requestAccounting(lease(),[],undefined,1024,'approval');record('reserved');record('dispatched')
 store.handle({type:'run.cancel',task_id:task,run_id:run});record('completed',{prompt_tokens:10,completion_tokens:2})
 expect(read().data.state).toBe('cancelled');expect(read().data.accounting.requests[0]).toMatchObject({phase:'completed',purpose:'approval',usage:{prompt_tokens:10,completion_tokens:2}})
})
it('reads unchanged v1 alongside v2 service-default records and preserves them across restart', () => {
 const record=requestAccounting(lease(),[],undefined,1024,'main');record('reserved');record('dispatched');record('completed',{prompt_tokens:10,completion_tokens:2})
 const rows=db.prepare("SELECT id,payload_json FROM records WHERE kind='model.request.accounting'").all() as any[]
 for(const row of rows){const value=JSON.parse(row.payload_json);delete value.output_policy;value.version=1;db.prepare('UPDATE records SET payload_json=? WHERE id=?').run(JSON.stringify(value),row.id)}
 const l=lease();l.config={...l.config};delete l.config.max_output_tokens
 const unknown=requestAccounting(l,[],undefined,undefined,'summary');unknown('reserved');unknown('dispatched');unknown('completed')
 expect(read().data.accounting.requests).toMatchObject([{version:1,output_reserve:1024},{version:2,output_policy:'service-default',output_reserve:null,usage:null}])
 const before=db.prepare("SELECT payload_json FROM records WHERE kind='model.request.accounting' ORDER BY sequence").all()
 store.close();store=new RuntimeStore(root);expect(read().data.accounting.requests).toHaveLength(2)
 expect(db.prepare("SELECT payload_json FROM records WHERE kind='model.request.accounting' ORDER BY sequence").all()).toEqual(before)
})
it.each(['transition','identity','composition','date','usage'])('rejects inconsistent stored accounting %s rather than inventing totals', mode => {
 const record=requestAccounting(lease(),[],undefined,1024,'main');record('reserved');record('dispatched');record('completed',{prompt_tokens:10,completion_tokens:2})
 const rows=db.prepare("SELECT id,payload_json FROM records WHERE kind='model.request.accounting' ORDER BY sequence").all() as any[]
 const value=JSON.parse(rows[1].payload_json)
 if(mode==='transition')value.phase='completed'
 if(mode==='identity')value.output_reserve=999
 if(mode==='composition')value.components.envelope++
 if(mode==='date')value.at='2026-99-01T00:00:00.000Z'
 if(mode==='usage')value.usage={prompt_tokens:1,completion_tokens:1}
 db.prepare('UPDATE records SET payload_json=? WHERE id=?').run(JSON.stringify(value),rows[1].id)
 expect(()=>read()).toThrow()
})
it('pages 225 accounting events without loss, keeps each request complete and preserves original rows',()=>{
 const l=lease();for(let n=0;n<75;n++){const emit=requestAccounting(l,[],undefined,1024,n%2?'summary':'main');emit('reserved');emit('dispatched');emit('completed',{prompt_tokens:n,completion_tokens:2})}
 const before=db.prepare("SELECT * FROM records WHERE kind='model.request.accounting' ORDER BY sequence").all()
 expect(read().data.accounting).toMatchObject({complete:false,recorded:true,requests:[]})
 let cursor:string|undefined,requests:any[]=[],pages=0
 do{const result=page(cursor);expect(result.requests.length).toBeLessThanOrEqual(20);expect(result.consistency).toBe('snapshot');requests.push(...result.requests);cursor=result.next_cursor??undefined;pages++}while(cursor)
 expect(pages).toBe(4);expect(requests).toHaveLength(75);expect(new Set(requests.map(r=>r.request_id)).size).toBe(75)
 expect(requests.reduce((n,r)=>n+r.usage.prompt_tokens,0)).toBe(2775)
 expect(db.prepare("SELECT * FROM records WHERE kind='model.request.accounting' ORDER BY sequence").all()).toEqual(before)
})
it('excludes late usage and new requests from a fixed snapshot until an explicit refresh',()=>{
 const l=lease();for(let n=0;n<20;n++){const emit=requestAccounting(l,[],undefined,1024,'main');emit('reserved');emit('failed',null,'MODEL_CANCELLED')}
 const late=requestAccounting(l,[],undefined,1024,'main');late('reserved');late('dispatched')
 const first=page();expect(first.next_cursor).toBeTruthy()
 late('completed',{prompt_tokens:8,completion_tokens:3});const added=requestAccounting(l,[],undefined,1024,'main');added('reserved')
 const second=page(first.next_cursor);expect(second.requests).toHaveLength(1);expect(second.requests[0]).toMatchObject({phase:'unknown',usage:null});expect(second.complete).toBe(true)
 const refreshed=page();const tail=page(refreshed.next_cursor);expect(tail.requests).toHaveLength(2);expect(tail.requests[0]).toMatchObject({phase:'completed',usage:{prompt_tokens:8,completion_tokens:3}})
})
it('rejects forged, cross-task, extra-field and old-runtime accounting cursors without changing records',()=>{
 for(let n=0;n<21;n++)requestAccounting(lease(),[],undefined,1024,'main')('reserved')
 const cursor=page().next_cursor,other=store.create('other task').task.id
 expect(()=>page(cursor.slice(0,-3)+'xxx')).toThrow('Cursor')
 expect(()=>store.handle({type:'host.run.accounting',task_id:other,run_id:run,cursor})).toThrow('unavailable')
 expect(()=>store.handle({type:'host.run.accounting',task_id:task,run_id:run,extra:true})).toThrow('Invalid')
 store.close();store=new RuntimeStore(root);expect(()=>page(cursor)).toThrow('Cursor');expect(page().requests).toHaveLength(20)
})
it('validates malformed stage chains even beyond the former inline window',()=>{
 for(let n=0;n<70;n++){const emit=requestAccounting(lease(),[],undefined,1024,'main');emit('reserved');emit('dispatched');emit('completed',{prompt_tokens:1,completion_tokens:1})}
 const latest=db.prepare("SELECT id,payload_json FROM records WHERE kind='model.request.accounting' ORDER BY sequence DESC LIMIT 1").get() as any
 const bad=JSON.parse(latest.payload_json);bad.phase='reserved';db.prepare('UPDATE records SET payload_json=? WHERE id=?').run(JSON.stringify(bad),latest.id)
 let result=page();for(let n=0;n<2;n++)result=page(result.next_cursor)
 expect(()=>page(result.next_cursor)).toThrow('inconsistent')
})
it('keeps a 1000-request ledger page bounded without adding a persistent index',()=>{
 const l=lease();db.transaction(()=>{for(let n=0;n<1000;n++){const emit=requestAccounting(l,[],undefined,1024,'main');emit('reserved');emit('dispatched');emit('completed',{prompt_tokens:1,completion_tokens:1})}})()
 const start=realPerformance.now(),result=page(),elapsed=realPerformance.now()-start
 expect(result.requests).toHaveLength(20);expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(32768)
 console.info('accounting baseline: 1000 requests / 3000 events, first page ms='+elapsed.toFixed(2)+', bytes='+Buffer.byteLength(JSON.stringify(result)))
})
