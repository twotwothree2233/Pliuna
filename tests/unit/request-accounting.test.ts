import { expect, it, vi } from 'vitest'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import { ChatAdapter, ModelError } from '../../src/runtime/model/adapter'
import { requestAccounting, type RequestAccounting } from '../../src/runtime/model/accounting'
const config = { id:'accounting',base_url:'https://example.invalid/v1',wire_model_id:'synthetic',context_tokens:1000000,max_output_tokens:1024,compatibility_profile:'chat-max-tokens' as const }
function setup() {
 const adapter = new ChatAdapter(), service = new ModelService(adapter), events: RequestAccounting[]=[]
 service.configure({type:'model.configure',configuration:config,api_key:'synthetic',confirm_memory_only:true})
 const lease: ModelLease={id:config.id,revision:1,config,release(){},accounting:e=>events.push(e)}
 const complete=vi.spyOn(adapter,'complete').mockResolvedValue({text:'done',calls:[],finish:'stop',usage:{prompt_tokens:123,completion_tokens:7}})
 return {service,events,lease,complete,run:()=>service.request(lease,'task',[{role:'user',content:'synthetic'}],undefined,new AbortController().signal)}
}
it('records each reserved/dispatched/completed request with actual usage and numeric-only composition',async()=>{
 const s=setup();await s.run();expect(s.events.map(e=>e.phase)).toEqual(['reserved','dispatched','completed']);expect(new Set(s.events.map(e=>e.request_id)).size).toBe(1)
 expect(s.events[2]?.usage).toEqual({prompt_tokens:123,completion_tokens:7});expect(JSON.stringify(s.events)).not.toContain('synthetic')
 expect(Object.values(s.events[0]!.components).reduce((a,b)=>a+b,0)).toBe(s.events[0]!.input_bytes)
})
it('fails closed before HTTP when either reservation or dispatch persistence fails',async()=>{
 for(const phase of ['reserved','dispatched']){const s=setup();s.lease.accounting=e=>{if(e.phase===phase)throw Error('disk failure')};await expect(s.run()).rejects.toThrow('disk failure');expect(s.complete).not.toHaveBeenCalled()}
})
it('retains missing usage and dispatched failure as unknown, not zero consumption',async()=>{
 const s=setup();s.complete.mockResolvedValueOnce({text:'done',calls:[],finish:'stop'});await s.run();expect(s.events.at(-1)?.usage).toBeNull()
 s.complete.mockRejectedValueOnce(Error('synthetic network failure'));await expect(s.run()).rejects.toThrow();expect(s.events.at(-1)).toMatchObject({phase:'unknown',usage:null,error:'MODEL_REQUEST_FAILED'})
})
it('a cancelled queued request is not marked dispatched and source categories remain estimates',async()=>{
 const s=setup(),controller=new AbortController();controller.abort();await expect(s.service.request(s.lease,'task',[],undefined,controller.signal)).rejects.toThrow('MODEL_CANCELLED');expect(s.events.map(e=>e.phase)).toEqual(['reserved','failed']);expect(s.complete).not.toHaveBeenCalled()
 const events:RequestAccounting[]=[];const emit=requestAccounting({...s.lease,accounting:e=>events.push(e)},[{role:'system',content:'rules'},{role:'user',content:JSON.stringify({working_summary:{}})},{role:'user',content:JSON.stringify({host_context:{},request:'goal'})},{role:'tool',tool_call_id:'a',content:'{}'}],[],512,'summary_correction');emit('reserved');expect(events[0]?.purpose).toBe('summary_correction');for(const k of ['rules','summary','current','tool_results'] as const)expect(events[0]!.components[k]).toBeGreaterThan(0)
})
it('completion persistence failure stops the caller and leaves a persisted dispatch unknown', async () => {
 const s=setup();s.lease.accounting=e=>{if(e.phase==='completed')throw Error('completion disk failure');s.events.push(e)}
 await expect(s.run()).rejects.toThrow('completion disk failure');expect(s.complete).toHaveBeenCalledOnce();expect(s.events.map(e=>e.phase)).toEqual(['reserved','dispatched','unknown'])
})

it('binds the persisted input manifest, accounting and returned response to one request identity',async()=>{
 const s=setup(),evidence:any[]=[];s.lease.evidence=event=>{evidence.push(event);return 'manifest-record'}
 const first=await s.run(),second=await s.run()
 expect(first.request_link).toEqual({request_id:s.events[0]!.request_id,evidence_event_id:'manifest-record'})
 expect(second.request_link?.request_id).not.toBe(first.request_link?.request_id)
 expect(evidence.map(e=>e.request_id)).toEqual([s.events[0]!.request_id,s.events[3]!.request_id])
 expect(JSON.stringify(evidence)).not.toContain('synthetic')
})
it('never dispatches when evidence persistence fails, and records the failed attempt',async()=>{
 const s=setup();s.lease.evidence=()=>{throw Error('manifest disk failure')}
 await expect(s.run()).rejects.toThrow('manifest disk failure');expect(s.complete).not.toHaveBeenCalled()
 expect(s.events.map(e=>e.phase)).toEqual(['reserved','failed'])
})

it('persists actual usage on a failed upstream response in the existing ledger', async () => {
 const s=setup();s.complete.mockRejectedValueOnce(new ModelError('MODEL_PROVIDER_SERVER_ERROR',true,false,{prompt_tokens:64370,completion_tokens:1460}))
 await expect(s.run()).rejects.toMatchObject({code:'MODEL_PROVIDER_SERVER_ERROR'})
 expect(s.events.at(-1)).toMatchObject({phase:'unknown',error:'MODEL_PROVIDER_SERVER_ERROR',usage:{prompt_tokens:64370,completion_tokens:1460}})
 expect(s.complete).toHaveBeenCalledOnce()
})
