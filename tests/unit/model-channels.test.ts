import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileModelStore } from '../../src/main/file-model-store'
import { ModelService } from '../../src/runtime/model/service'
import { modelServer, synthetic, textStream } from '../helpers/model-server'
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close()})
async function setup() {
  const server=await modelServer(({body,url},res)=>{if(url?.endsWith('/models')){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[{"id":"wire","context_length":100000}]}')}else if (!synthetic(body,res)) textStream(res,'Synthetic summary')})
  cleanups.push(server.close)
  const root=mkdtempSync(join(tmpdir(),'pliuna-channels-'));cleanups.push(()=>rmSync(root,{recursive:true,force:true}))
  const create=async()=>{const files=new FileModelStore(root),service=new ModelService(undefined,undefined,{async load(){return files.load()},async save(records,channels){files.save(records,channels)}});await service.restore();cleanups.push(()=>service.close());return service}
  const service=await create()
  const channel={id:'channel-a',name:'Shared',base_url:server.url,compatibility_profile:'chat-max-tokens' as const}
  const saveChannel=(key='shared-secret')=>service.configureChannel({type:'model.channel.configure',channel,api_key:key,confirm_memory_only:true,remember_connection:true,confirm_plaintext_storage:true})
  const model=(id:string,wire='wire')=>({type:'model.channel.model',channel_id:channel.id,configuration:{id,base_url:channel.base_url,compatibility_profile:channel.compatibility_profile,wire_model_id:wire,context_tokens:100000,max_output_tokens:1024}})
  return {service,create,server,root,channel,saveChannel,model}
}
it('saves empty channels and adds multiple models with a single persisted credential',async()=>{
 const {service,create,root,saveChannel,model,server}=await setup();await saveChannel()
 expect((await create()).channelList()).toMatchObject([{id:'channel-a',name:'Shared',credential_missing:false}])
 await service.configureChannelModel(model('first'));await service.configureChannelModel(model('second','wire-two'))
 const settings=JSON.parse(readFileSync(join(root,'settings.json'),'utf8')),auth=JSON.parse(readFileSync(join(root,'auth.json'),'utf8'))
 expect(settings.version).toBe(4);expect(settings.channels).toHaveLength(1);expect(settings.connections).toHaveLength(2)
 expect(Object.keys(auth.credentials)).toHaveLength(1);expect(settings.connections[0].credential).toBe(settings.connections[1].credential)
 expect(JSON.stringify(service.channelList())).not.toContain('shared-secret');expect(JSON.stringify(service.list())).not.toContain('shared-secret')
 const count=server.exchanges.length,restored=await create();expect(server.exchanges).toHaveLength(count)
 await restored.discoverChannel('channel-a','discover');expect(server.exchanges.at(-1)?.authorization).toBe('Bearer shared-secret')
 expect(restored.list()).toMatchObject([{channel_id:'channel-a'},{channel_id:'channel-a'}])
})
it('changes a shared channel atomically and invalidates all its model roles',async()=>{
 const {service,create,saveChannel,model,server}=await setup();await saveChannel();await service.configureChannelModel(model('first'));await service.configureChannelModel(model('second','wire-two'))
 await service.test('first','main');await service.test('second','compaction');const lease=service.acquire('first','main')
 await expect(saveChannel('new-secret')).rejects.toThrow('Channel is occupied');lease.release()
 await saveChannel('new-secret');expect(service.list()).toMatchObject([{roles:[],revision:2},{roles:[],revision:2}])
 const restored=await create();await restored.discoverChannel('channel-a','discover');expect(server.exchanges.at(-1)?.authorization).toBe('Bearer new-secret')
})
it('retains credential on blank-key channel edit and prevents within-channel duplicate models',async()=>{
 const {service,channel,saveChannel,model,create}=await setup();await saveChannel();await service.configureChannelModel(model('first'));await service.test('first','main')
 await service.configureChannel({type:'model.channel.configure',channel:{...channel,name:'Renamed'},api_key:'',use_saved_credential:true,confirm_memory_only:true,remember_connection:true,confirm_plaintext_storage:true})
 expect(service.channelList()).toMatchObject([{name:'Renamed',credential_missing:false}])
 expect((await create()).list()).toMatchObject([{roles:['main']}])
 await expect(service.configureChannel({type:'model.channel.configure',channel:{...channel,base_url:'https://other.example/v1'},api_key:'',use_saved_credential:true,confirm_memory_only:true})).rejects.toThrow('credential is unavailable')
 await expect(service.configureChannelModel(model('duplicate'))).rejects.toThrow('already exists')
 expect(service.list()).toHaveLength(1)
})
it('keeps identical provider model IDs isolated across explicit channels on the same origin',async()=>{
 const {service,channel,saveChannel,model,server}=await setup();await saveChannel();await service.configureChannelModel(model('first'))
 await service.configureChannel({type:'model.channel.configure',channel:{...channel,id:'channel-b',name:'Other'},api_key:'other-secret',confirm_memory_only:true})
 await service.configureChannelModel({...model('other'),channel_id:'channel-b'})
 await service.deleteCredential('first');await service.discoverChannel('channel-b','other-discover');expect(server.exchanges.at(-1)?.authorization).toBe('Bearer other-secret')
 await expect(service.discoverChannel('channel-a','deleted')).rejects.toThrow('Configure the channel first')
})
it('migrates legacy connections in memory and persists channel grouping only on explicit save',async()=>{
 const {root,channel,create}=await setup(),files=new FileModelStore(root);files.load();files.save([{configuration:{id:'old',base_url:channel.base_url,wire_model_id:'wire',context_tokens:100000,compatibility_profile:'chat-max-tokens'},key:'legacy-key',revision:1,protocol:'old',roles:[]}])
 const before=readFileSync(join(root,'settings.json'),'utf8'),service=await create()
 expect(readFileSync(join(root,'settings.json'),'utf8')).toBe(before);expect(service.channelList()).toHaveLength(1)
 expect(service.list()).toMatchObject([{id:'old',channel_id:'legacy:'+new URL(channel.base_url).origin}])
 const c=service.channelList()[0]!;await service.configureChannel({type:'model.channel.configure',channel:{id:c.id,name:'Migrated',base_url:c.base_url,compatibility_profile:c.compatibility_profile},api_key:'',use_saved_credential:true,confirm_memory_only:true,remember_connection:true,confirm_plaintext_storage:true})
 expect(JSON.parse(readFileSync(join(root,'settings.json'),'utf8')).version).toBe(4)
 expect((await create()).list()).toMatchObject([{id:'old',channel_id:c.id}])
})
it('keeps an empty channel after removing the last model until explicitly deleted',async()=>{
 const {service,create,saveChannel,model}=await setup();await saveChannel();await service.configureChannelModel(model('first'))
 await expect(service.removeChannel('channel-a')).rejects.toThrow('Remove channel models first')
 await service.removeConnection('first');expect((await create()).channelList()).toHaveLength(1)
 await service.removeChannel('channel-a');expect((await create()).channelList()).toEqual([])
})
it('retains channel and model state when a shared credential save fails',async()=>{
 let fail=false
 const configuration={id:'channel',name:'Original',base_url:'https://example.test/v1',compatibility_profile:'chat-max-tokens' as const}
 const service=new ModelService(undefined,undefined,{async load(){return {available:true,backend:'plain-file',records:[],channels:[]}},async save(){if(fail)throw Error('SETTINGS_WRITE_FAILED')}});cleanups.push(()=>service.close());await service.restore()
 await service.configureChannel({type:'model.channel.configure',channel:configuration,api_key:'old-key',confirm_memory_only:true,remember_connection:true,confirm_plaintext_storage:true})
 await service.configureChannelModel({type:'model.channel.model',channel_id:'channel',configuration:{id:'model',base_url:configuration.base_url,compatibility_profile:configuration.compatibility_profile,wire_model_id:'wire',context_tokens:100000}})
 const before=service.list();fail=true
 await expect(service.configureChannel({type:'model.channel.configure',channel:{...configuration,name:'Changed'},api_key:'new-key',confirm_memory_only:true,remember_connection:true,confirm_plaintext_storage:true})).rejects.toThrow('Settings save did not complete')
 expect(service.list()).toEqual(before);expect(service.channelList()).toMatchObject([{name:'Original',revision:1,credential_missing:false}])
})
it('blocks connection changes during discovery, then releases the channel after cancellation',async()=>{
 const server=await modelServer((_request,res)=>{res.writeHead(200,{'content-type':'application/json'});res.flushHeaders()});cleanups.push(server.close)
 const service=new ModelService();cleanups.push(()=>service.close())
 const channel={id:'pending',name:'Pending',base_url:server.url,compatibility_profile:'chat-max-tokens'}
 const input={type:'model.channel.configure',channel,api_key:'key',confirm_memory_only:true}
 await service.configureChannel(input)
 const pending=service.discoverChannel('pending','discovery');const cancelled=expect(pending).rejects.toThrow('MODEL_CANCELLED')
 expect(service.channelList()).toMatchObject([{occupied:true}])
 await expect(service.configureChannel({...input,api_key:'changed'})).rejects.toThrow('discovery is in progress')
 await expect(service.removeChannel('pending')).rejects.toThrow('discovery is in progress')
 service.cancel('discovery');await cancelled
 expect(service.channelList()).toMatchObject([{occupied:false}]);await service.configureChannel({...input,api_key:'changed'})
})
it('keeps partial legacy credential deletion readable after a later v4 save',async()=>{
 const {root,channel,create}=await setup(),files=new FileModelStore(root);files.load()
 const configuration={base_url:channel.base_url,wire_model_id:'wire',context_tokens:100000,compatibility_profile:'chat-max-tokens' as const}
 files.save([{configuration:{...configuration,id:'missing'},key:null,revision:1,protocol:'old',roles:[]},{configuration:{...configuration,id:'available'},key:'legacy-key',revision:1,protocol:'old',roles:[]}])
 const service=await create(),c=service.channelList()[0]!
 expect(c.credential_missing).toBe(false)
 await service.removeConnection('missing')
 expect((await create()).list()).toMatchObject([{id:'available',credential_missing:false}])
})
