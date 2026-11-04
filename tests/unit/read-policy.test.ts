import { expect, it } from 'vitest'
import { assertReadDispatch, readPermission } from '../../src/runtime/model/read-policy'

it('reports no additional read approval while preserving dispatch waits and unchecked intent/object checks',()=>{
 for(const reason of [undefined,null,'model_queue','model_generating']){
  expect(readPermission(reason)).toMatchObject({scope:'current-task',separate_approval:false,dispatch:'available',object_checks:'required',user_intent:'not_inferred'})
  expect(()=>assertReadDispatch(reason)).not.toThrow()
 }
 for(const reason of ['approval','surface_host']){
  expect(readPermission(reason)).toMatchObject({separate_approval:false,dispatch:'blocked_waiting'})
  expect(()=>assertReadDispatch(reason)).toThrow('Awaiting approval')
 }
})
