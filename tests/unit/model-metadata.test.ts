import { expect, it } from 'vitest'
import { directoryCandidate, modelMetadata } from '../../src/runtime/model/metadata'
import { ModelDirectory } from '../../src/main/model-directory'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const payload = { openai: { id: 'openai', models: { 'exact/ID': { id: 'exact/ID', limit: { context: 100000, output: 8192 } } } } }
it('requires exact official provider and exact case-sensitive serving wire ID', () => {
  expect(directoryCandidate(payload, 'https://api.openai.com/v1', 'openai', 'exact/ID')).toMatchObject({ context_tokens: 100000 })
  for (const [base, provider, wire] of [['https://proxy.invalid/v1', 'openai', 'exact/ID'], ['https://api.openai.com/v1', 'other', 'exact/ID'], ['https://api.openai.com/v1', 'openai', 'exact/id']]) expect(directoryCandidate(payload, base!, provider!, wire!)).toBeNull()
})
it('preserves manual capacity overrides and unknown capabilities', () => {
  const value = modelMetadata({ id: 'x', context_tokens: 90000, max_output_tokens: 9000, conflicts: [] }, '2026-10-29', { context: false, output: true })
  expect(value.context_tokens.source).toBe('service'); expect(value.max_output_tokens.source).toBe('manual'); expect(value.capabilities.tools).toBe('unknown')
})
it('caches only public data, restores offline, clears independently and never sends credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trellis-directory-')); const requests: any[] = []
  try {
    const cache = new ModelDirectory(root, async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify(payload)) })
    expect(await cache.lookup('https://api.openai.com/v1', 'openai', 'exact/ID')).toMatchObject({ candidate: null })
    expect(requests).toHaveLength(0)
    expect(await cache.lookup('https://api.openai.com/v1', 'openai', 'exact/ID', true)).toMatchObject({ candidate: { id: 'exact/ID' } })
    expect(requests[0].url).toBe('https://models.dev/api.json'); expect(requests[0].options.headers).toEqual({ accept: 'application/json' })
    const restarted = new ModelDirectory(root, async () => { throw Error('offline') })
    expect(await restarted.lookup('https://api.openai.com/v1', 'openai', 'exact/ID')).toMatchObject({ candidate: { id: 'exact/ID' } })
    restarted.clear(); expect(await restarted.lookup('https://api.openai.com/v1', 'openai', 'exact/ID')).toMatchObject({ candidate: null })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
it('binds a separately validated compaction service, locks it and rejects changed targets', async () => {
  const { ModelService }=await import('../../src/runtime/model/service'),{ChatAdapter}=await import('../../src/runtime/model/adapter'),{frame}=await import('../helpers/model-server')
  const result={schema_version:'0.1',coverage:{snapshot_id:'synthetic',through_sequence:0},goals:[],constraints:[],completed:[],evidence:[],pending:[],uncertainties:[]}
  const service=new ModelService(new ChatAdapter(async()=>new Response(frame({content:JSON.stringify(result)})+frame({},'stop')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})))
  const config={id:'compact',base_url:'https://example.invalid/v1',wire_model_id:'compact-wire',context_tokens:100000,max_output_tokens:8192,compatibility_profile:'chat-max-tokens' as const}
  service.configure({type:'model.configure',configuration:config,api_key:'synthetic',confirm_memory_only:true});await service.test('compact','compaction')
  const main={...config,id:'main',compaction_model_id:'compact'}
  await expect(service.configureConnection({type:'model.configure',configuration:main,api_key:'synthetic',confirm_memory_only:true})).rejects.toThrow('Explicitly confirm task history')
  await service.configureConnection({type:'model.configure',configuration:main,api_key:'synthetic',confirm_memory_only:true,confirm_history_processing:true})
  const saved=(service.list() as any[]).find(m=>m.id==='main');const lease={id:'main',revision:saved.revision,config:saved,release(){}}
  const held=service.acquireCompaction(lease)!;expect(()=>service.configure({type:'model.configure',configuration:config,api_key:'synthetic',confirm_memory_only:true})).toThrow('occupied');held.release()
  service.configure({type:'model.configure',configuration:{...config,wire_model_id:'changed'},api_key:'synthetic',confirm_memory_only:true});expect(()=>service.acquireCompaction(lease)).toThrow('Compaction service changed');service.close()
})
it('does not fetch the public directory for a same-name custom proxy',async()=>{
 const root=mkdtempSync(join(tmpdir(),'trellis-directory-proxy-'));let requests=0
 try{const cache=new ModelDirectory(root,async()=>{requests++;throw Error('unexpected')});expect(await cache.lookup('https://proxy.invalid/v1','openai','exact/ID',true)).toMatchObject({candidate:null});expect(requests).toBe(0)}finally{rmSync(root,{recursive:true,force:true})}
})
