import {afterEach,it,expect} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {RuntimeStore} from '../../src/runtime/store'
import {ModelService} from '../../src/runtime/model/service'
import {modelServer,synthetic,textStream,type Exchange} from '../helpers/model-server'
import type {ServerResponse} from 'node:http'
const cleanups:(()=>void|Promise<void>)[]=[]
afterEach(async()=>{for(const f of cleanups.splice(0).reverse())await f()})
async function until(check:()=>boolean){const start=Date.now();while(!check()){if(Date.now()-start>4000)throw Error('request model timeout');await new Promise(r=>setTimeout(r,5))}}
async function setup(handler:(x:Exchange,r:ServerResponse)=>void){
 const server=await modelServer((x,r)=>{if(!synthetic(x.body,r))handler(x,r)});cleanups.push(server.close)
 const root=mkdtempSync(join(tmpdir(),'pliuna-request-http-')),models=new ModelService(),configuration={id:'main',base_url:server.url,wire_model_id:'synthetic-wire',context_tokens:1000000,max_output_tokens:1024,compatibility_profile:'chat-max-tokens'}
 models.configure({type:'model.configure',configuration,api_key:'synthetic',confirm_memory_only:true});await models.test('main','main')
 const store=new RuntimeStore(root,models),task=store.create('isolated request').task.id;cleanups.push(()=>{store.close();rmSync(root,{recursive:true,force:true})})
 const call=(type:string,extra:Record<string,unknown>={})=>store.handle({type,task_id:task,...extra}) as any
 const submit=(extra={})=>call('request.submit',{text:'synthetic request',model_config_id:'main',resource_ids:[],import_ids:[],...extra})
 return {store,models,configuration,call,submit,task,server}
}
it('waiting import uses no lease or HTTP and mutation requires explicit revalidation',async()=>{
 let traffic=0;const {store,models,configuration,call,submit}=await setup((_x,r)=>{traffic++;textStream(r,'done')})
 const id=call('material.internal.register',{items:[{display_name:'synthetic.txt',source:'text'}]}).items[0].operation_id,r=submit({import_ids:[id]})
 expect(r.state).toBe('queued');expect(models.busy()).toBe(false);expect(traffic).toBe(0)
 await store.handle({type:'model.configure',configuration:{...configuration,wire_model_id:'updated-wire'},api_key:'synthetic',confirm_memory_only:true})
 expect(call('request.status',{request_id:r.request_id}).state).toBe('confirmation_required');expect(traffic).toBe(0);expect((models.list() as any[])[0].roles).toEqual([])
 expect(()=>call('request.resolve',{request_id:r.request_id,model_config_id:'main',use_successful:false,replacements:[],confirm:true})).toThrow()
})
it('actual wire receives selected metadata but never automatically receives material body',async()=>{
 let input:any;const {store,call,submit,task}=await setup((x,r)=>{input=JSON.parse(x.body.messages.at(-1).content);textStream(r,'done')})
 const id=call('material.internal.register',{items:[{display_name:'selected.txt',source:'text'}]}).items[0].operation_id,body=Buffer.from('PRIVATE_SYNTHETIC_BODY')
 call('material.internal.begin',{operation_id:id,byte_length:body.length,media_type:'text/plain; charset=utf-8'});call('material.internal.chunk',{operation_id:id,offset:0,data:body.toString('base64')});const resource=call('material.internal.finish',{operation_id:id}).resource.id
 const r=submit({resource_ids:[resource]});await until(()=>store.snapshot(task).runs[0]?.state==='completed');expect(input.request_materials).toMatchObject([{id:resource,display_name:'selected.txt',byte_length:body.length}]);expect(JSON.stringify(input)).not.toContain('PRIVATE_SYNTHETIC_BODY');expect(call('request.status',{request_id:r.request_id}).run_id).toBe(r.run_id)
})
it('actual cancelled HTTP releases the prior execution before the next queued request',async()=>{
 let traffic=0,release:()=>void=()=>{};const {store,models,call,submit,task}=await setup((_x,r)=>{traffic++;if(traffic===1){release=()=>textStream(r,'late');return}textStream(r,'second')})
 const first=submit();await until(()=>traffic===1);const second=submit();expect(second.state).toBe('queued');expect((models.list() as any[])[0].occupied).toBe(true)
 call('run.cancel',{run_id:first.run_id});await until(()=>call('request.status',{request_id:second.request_id}).run_state==='completed');expect(traffic).toBe(2);expect(store.snapshot(task).runs.filter(r=>['running','waiting'].includes(r.state))).toHaveLength(0);expect(models.busy()).toBe(false);release()
})
