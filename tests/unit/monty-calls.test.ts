import Database from 'better-sqlite3'
import { beforeEach,afterEach,expect,it,vi } from 'vitest'
import { mkdtempSync,readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeStore } from '../../src/runtime/store'
import { MontyCalls } from '../../src/runtime/monty/calls'
import { MONTY_ID } from '../../src/runtime/monty/contract'
import { ContractError } from '../../src/shared/validation'
import type { MontyRunner,MontyOutput } from '../../src/runtime/monty/runner'
let store:RuntimeStore,db:Database.Database,root:string,task:string,run:string,manager:MontyCalls
beforeEach(()=>{vi.useFakeTimers();manager=undefined as any;root=mkdtempSync(join(tmpdir(),'pliuna-monty-calls-'));store=new RuntimeStore(root);db=(store as any).db;task=store.create('calculation').task.id;run=store.start(task,'synthetic','fixture',[])})
afterEach(async()=>{await manager?.shutdown();store.close();vi.useRealTimers()})
function setup(output:MontyOutput,custom?:MontyRunner){
 const runner:MontyRunner=custom??((_a,_i,_s,_r,started)=>{started(123);return{result:Promise.resolve(output),stop:async()=>{}}})
 manager=new MontyCalls(db,root,(store as any).storage,()=>{const value=db.prepare('SELECT commit_valid,state FROM runs WHERE id=?').get(run) as any;if(!value.commit_valid||!['running','waiting'].includes(value.state))throw new ContractError('SOURCE_INVALID','source ended')},(t,refs)=>(store as any).validateDataReferences(t,refs),(t,k,v)=>(store as any).record(t,k,v),process.execPath,true,runner,()=>({binary:'fixture-binary',native:'fixture-native',binary_sha256:'0'.repeat(64),runner:'fixture-runner'}))
 return (signal=new AbortController().signal)=>manager.call(task,run,{code:'result=1',inputs:{}},[],signal) as Promise<any>
}
const ok:MontyOutput={ok:true,value:{type:'json',value:{answer:17}},stdout:'done\n',stderr:''}
it('persists actionable execution diagnostics without output publication or replay', async () => {
 const result = await setup({ok:false,execution:'failure',error:'MONTY_NAME_ERROR',message:'NameError at code line 2: missing is not defined'})()
 expect(result).toMatchObject({execution:'failure',delivery:'delivered',error:{code:'MONTY_NAME_ERROR',message:expect.stringContaining('code line 2: missing is not defined')}})
 expect(JSON.parse((db.prepare('SELECT result_json FROM calls').get() as any).result_json)).toEqual(result)
 expect(db.prepare('SELECT count(*) n FROM calls').get()).toEqual({n:1})
 expect(db.prepare('SELECT count(*) n FROM resources').get()).toEqual({n:0})
 expect(db.prepare('SELECT count(*) n FROM staging').get()).toEqual({n:0})
})
it('commits an inline version1 result and quota identity without creating unrelated resources',async()=>{
 const result=await setup(ok)();expect(result).toMatchObject({execution:'success',delivery:'delivered',data:{version:1,value:{type:'json',value:{answer:17}}}})
 const row=db.prepare('SELECT * FROM calls').get() as any;expect(row.capability_id).toBe(MONTY_ID);expect(row.commit_valid).toBe(0);expect(JSON.parse(row.limits_json)).toMatchObject({memory_bytes:134217728,wall_ms:180000})
 expect(db.prepare('SELECT count(*) n FROM task_resources').get()).toEqual({n:0})
})
it.each(['MONTY_NONFAITHFUL_FLOAT', 'MONTY_CYCLIC_VALUE', 'MONTY_VALUE_UNSUPPORTED', 'MONTY_ENCODING_FAILED'])('preserves %s after execution without publishing output or replaying', async error => {
 const result = await setup({ ok: false, execution: 'success', error })()
 expect(result).toMatchObject({ execution: 'success', delivery: 'failed', error: { code: error } })
 expect(result).not.toHaveProperty('data')
 const calls = db.prepare('SELECT * FROM calls').all() as any[]
 expect(calls).toHaveLength(1)
 expect(JSON.parse(calls[0].result_json)).toEqual(result)
 expect(db.prepare('SELECT result,commit_valid,result_json FROM actions').get()).toEqual({ result: 'failure', commit_valid: 0, result_json: JSON.stringify({ code: error }) })
 expect(db.prepare('SELECT count(*) n FROM staging').get()).toEqual({ n: 0 })
 expect(db.prepare('SELECT count(*) n FROM resources').get()).toEqual({ n: 0 })
})
it('atomically pins bytes and the complete result, keeps type labels and restores original results without replay',async()=>{
 const result=await setup({...ok,value:{type:'tuple',items:[{type:'bytes',hex:'616263'},{type:'frozenset',items:[{type:'bigint',decimal:'1267650600228229401496703205376'}]}]}})()
 expect(result.data.result_resource.kind).toBe('resource')
 const saved=db.prepare('SELECT * FROM resources').all() as any[];expect(saved).toHaveLength(2)
 const output=JSON.parse(readFileSync(join(root,'resources',result.data.result_resource.id),'utf8'));expect(output.value.items[0]).toMatchObject({type:'bytes',byte_length:3});expect(readFileSync(join(root,'resources',output.value.items[0].resource.id)).toString()).toBe('abc')
 expect(db.prepare("SELECT count(*) n FROM staging WHERE state='committed'").get()).toEqual({n:2})
 await manager.shutdown();store.close();store=new RuntimeStore(root);db=(store as any).db
 const row=db.prepare('SELECT result_json FROM calls').get() as any;expect(JSON.parse(row.result_json)).toEqual(result)
 expect(db.prepare('SELECT count(*) n FROM calls').get()).toEqual({n:1})
})
it('rolls back all resource links on publication failure while preserving retryable staging facts',async()=>{
 const invoke=setup({...ok,value:{type:'bytes',hex:'616263'}})
 db.exec("CREATE TRIGGER fail_resource BEFORE INSERT ON resources BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END")
 const result=await invoke();expect(result).toMatchObject({execution:'success',delivery:'failed',error:{code:'MONTY_SAVE_FAILED'}})
 expect(db.prepare('SELECT count(*) n FROM resources').get()).toEqual({n:0});expect(db.prepare('SELECT count(*) n FROM task_resources').get()).toEqual({n:0})
 expect(db.prepare("SELECT count(*) n FROM staging WHERE state='committed'").get()).toEqual({n:0});expect(db.prepare('SELECT count(*) n FROM staging').get()).toEqual({n:2})
})
it('revokes commit before cancellation and rejects a late successful result',async()=>{
 let deliver!:(value:MontyOutput)=>void,signal!:AbortSignal
 const invoke=setup(ok,(_a,_i,s,_r,started)=>{signal=s;started(123);return{result:new Promise(resolve=>{deliver=resolve}),stop:async()=>{}}})
 const controller=new AbortController(),pending=invoke(controller.signal);controller.abort();expect(signal.aborted).toBe(true)
 expect(db.prepare('SELECT commit_valid FROM calls').get()).toEqual({commit_valid:0})
 deliver(ok);expect(await pending).toMatchObject({execution:'cancelled'});expect(db.prepare('SELECT count(*) n FROM resources').get()).toEqual({n:0})
})
it('keeps cleanup-unknown work busy and refuses shutdown rather than claiming destroyed',async()=>{
 const invoke=setup(ok,(_a,_i,_s,_r,started)=>{started(123);return{result:Promise.reject(new ContractError('MONTY_CLEANUP_UNCONFIRMED','injected')),stop:async()=>{throw new ContractError('MONTY_CLEANUP_UNCONFIRMED','still occupied')}}})
 expect(await invoke()).toMatchObject({error:{code:'MONTY_CLEANUP_UNCONFIRMED'}});expect(manager.busy()).toBe(true)
 await expect(manager.shutdown()).rejects.toMatchObject({code:'MONTY_CLEANUP_UNCONFIRMED'})
 // Test fixture only: discard manager after asserting the conservative production state.
 manager=undefined as any
})
it('retries cleanup without rewriting or replaying the original unknown Call',async()=>{
 let confirmed=false
 const invoke=setup(ok,(_a,_i,_s,_r,started)=>{started(123);return{result:Promise.reject(new ContractError('MONTY_CLEANUP_UNCONFIRMED','injected')),stop:async()=>{if(!confirmed)throw new ContractError('MONTY_CLEANUP_UNCONFIRMED','still occupied')}}})
 const original=await invoke()
 await expect(manager.shutdown()).rejects.toMatchObject({code:'MONTY_CLEANUP_UNCONFIRMED'})
 expect(manager.busy()).toBe(true)
 confirmed=true;await manager.shutdown();expect(manager.busy()).toBe(false)
 expect(db.prepare('SELECT count(*) n FROM calls').get()).toEqual({n:1})
 expect(JSON.parse((db.prepare('SELECT result_json FROM calls').get() as any).result_json)).toEqual(original)
})
it('rejects invalid or cross-task references before registration and never replays a failed computation',async()=>{
 const invoke=setup({ok:false,execution:'failure',error:'MONTY_EXECUTION_FAILED'})
 await expect(manager.call(task,run,{code:'result=1',inputs:{}},[{name:'other',target:{kind:'resource',id:'absent'}}],new AbortController().signal)).rejects.toMatchObject({code:'REFERENCE_UNAVAILABLE'})
 expect(db.prepare('SELECT count(*) n FROM calls').get()).toEqual({n:0})
 expect(await invoke()).toMatchObject({execution:'failure'});expect(db.prepare('SELECT count(*) n FROM calls').get()).toEqual({n:1})
})
it('continues a large immutable result with task-bound cursors and detects corruption',async()=>{
 const expected={version:1,runtime:'@pydantic/monty@1.3.0',contract_version:1,value:{type:'json',value:'中😀'.repeat(45000)},stdout:'done\n',stderr:''}
 const result=await setup({...ok,value:expected.value})();const resource=result.data.result_resource.id
 const read=(owner=task,cursor?:string)=>Promise.resolve().then(()=>store.handle({type:'task.query',task_id:owner,query:{type:'read',input:{target:{kind:'resource',id:resource},...(cursor?{cursor}:{})}}})) as Promise<any>
 let page=await read(),whole=page.data.text;expect(page.truncated).toBe(true)
 const other=store.create('another task').task.id
 await expect(read(other,page.next_cursor)).rejects.toMatchObject({code:'NOT_FOUND'})
 while(page.next_cursor){page=await read(task,page.next_cursor);whole+=page.data.text}
 expect(JSON.parse(whole)).toEqual(expected)
 const {writeFileSync}=await import('node:fs');writeFileSync(join(root,'resources',resource),'damaged')
 await expect(read()).rejects.toMatchObject({code:'RESOURCE_CORRUPT'})
})
it('holds the task slot until cancellation has settled and does not hang shutdown on cleanup registration failure',async()=>{
 let deliver!:(value:MontyOutput)=>void
 const invoke=setup(ok,(_a,_i,_s,_r,started)=>{started(123);return{result:new Promise(resolve=>{deliver=resolve}),stop:async()=>{}}})
 const pending=invoke();await expect(invoke()).rejects.toMatchObject({code:'MONTY_BUSY'})
 const original=(store as any).monty;(store as any).monty=manager
 try {
  store.handle({type:'run.cancel',task_id:task,run_id:run})
  expect(()=>store.handle({type:'maintenance.begin'})).toThrow('Wait for all executions')
  expect(()=>store.handle({type:'task.delete',task_id:task})).toThrow('confirmed cleanup')
  expect(()=>store.close()).toThrow('calculation shutdown')
 } catch(error) { deliver(ok);await pending;throw error }
 finally { (store as any).monty=original }
 manager.cancelRun(run);expect(db.prepare('SELECT commit_valid FROM calls').get()).toEqual({commit_valid:0})
 const failure=vi.spyOn((store as any).storage,'failed').mockImplementation(()=>{throw Error('injected registration failure')})
 deliver(ok);await expect(pending).rejects.toThrow('registration failure');expect(manager.busy()).toBe(false)
 failure.mockRestore();await manager.shutdown()
})
