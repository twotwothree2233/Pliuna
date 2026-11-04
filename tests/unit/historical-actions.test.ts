import { expect, it, vi } from 'vitest'
import { attachEvidence } from '../../src/runtime/model/request-evidence'
import { historicalActionFacts } from '../../src/runtime/model/historical-actions'

const result = (body: unknown, read_target?: {kind:string;id:string}) => attachEvidence({role:'tool' as const,content:JSON.stringify(body)}, {kind:'model.tool_result',representation:'historical-preview',source:{kind:'event',id:'original'},recorded_sequence:8,...(read_target?{read_target}:{})})
it('links only registered tool results and exact read targets, never model or user assertions',()=>{
 const lookup=vi.fn(target=>({status:'found',action_id:target.id,approval:{decision:'approve',validity:'revoked'}}))
 const body={request_type:'write',execution:'success',delivery:'delivered',data:{action_id:'saved'}}
 const facts=historicalActionFacts([{role:'user',content:JSON.stringify(body)},{role:'assistant',content:'approval saved'},result(body),result(body),result({execution:'success',delivery:'delivered',data:{truncated:true}}, {kind:'approval',id:'approval'})],lookup)
 expect(lookup.mock.calls.map(c=>c[0])).toEqual([{kind:'action',id:'saved'},{kind:'approval',id:'approval'}])
 expect(facts.items).toHaveLength(2);expect(facts.items[0]).toMatchObject({status:'found',action_id:'saved',origin:{source:{kind:'event',id:'original'}}})
 expect(facts.complete_task_history).toBe(false)
})
it('does not authenticate failed delivery, preview text or arbitrary nested IDs',()=>{
 const lookup=vi.fn()
 const facts=historicalActionFacts([result({request_type:'write',execution:'success',delivery:'failed',data:{action_id:'bad'}}),result({preview:'{"action_id":"bad"}',truncated:true}),result({request_type:'read',execution:'success',delivery:'delivered',data:{action_id:'untrusted'}})],lookup)
 expect(facts.items).toEqual([]);expect(lookup).not.toHaveBeenCalled()
})
it('keeps exact lookup failure distinct from an empty current-Run subset',()=>{
 const facts=historicalActionFacts([result({}, {kind:'action',id:'missing'})],()=>({status:'not_found_in_task'}))
 expect(facts.items[0]).toMatchObject({target:{kind:'action',id:'missing'},status:'not_found_in_task'})
})
it('links complete recorded Action and approval reads but never mismatched or truncated bodies',()=>{
 const lookup=vi.fn(()=>({status:'found'})),body={request_type:'read',execution:'success',delivery:'delivered',data:{metadata:{id:'approval'},data:{id:'approval',action_id:'action',decision:'approve',validity:'revoked'}}}
 expect(historicalActionFacts([result(body)],lookup).items).toHaveLength(1)
 expect(lookup).toHaveBeenCalledWith({kind:'action',id:'action'})
 lookup.mockClear();historicalActionFacts([result({...body,truncated:true}),result({...body,data:{...body.data,metadata:{id:'other'}}})],lookup);expect(lookup).not.toHaveBeenCalled()
})

it('preserves typed origins for the same target without repeating its database lookup',()=>{
 const lookup=vi.fn(()=>({status:'found'}))
 const write=result({request_type:'write',execution:'success',delivery:'delivered',data:{action_id:'saved'}})
 const read=attachEvidence({role:'tool',content:'{}'}, {kind:'model.tool_result',representation:'recorded-message',source:{kind:'event',id:'later-read'},recorded_sequence:9,read_target:{kind:'action',id:'saved'},request_type:'read'})
 const facts=historicalActionFacts([write,read,read],lookup)
 expect(lookup).toHaveBeenCalledOnce();expect(facts.items[0]!.origins).toEqual([
 expect.objectContaining({request_type:'write',source:{id:'original',kind:'event'}}),expect.objectContaining({request_type:'read',source:{id:'later-read',kind:'event'}})])
})
