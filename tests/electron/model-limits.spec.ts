import { openSettings, closeSettings, addChannel, addModel } from '../helpers/settings-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
const electronPath: string = createRequire(import.meta.url)('electron')

test('explicit output settings, all roles, v3/v2 accounting and isolated restart', async () => {
 const server=await modelServer(({body},res)=>{
  if(synthetic(body,res))return
  const first=body.messages[0].content
  if(first.startsWith('Synthetic compaction')){textStream(res,JSON.stringify({schema_version:'0.1',coverage:{snapshot_id:'synthetic',through_sequence:0},goals:[],constraints:[],completed:[],evidence:[],pending:[],uncertainties:[]}));return}
  if(body.messages.at(-1).role==='system'){textStream(res,'Keep current task state.');return}
  if(first.includes('你是 Trellis 的单次动作辅助审批评估器。')){textStream(res,'{"decision":"approve","reason":"synthetic exact replacement"}');return}
  const request=JSON.parse(body.messages.findLast((m:any)=>m.role==='user').content).request
  if(body.messages.at(-1).role==='tool'){textStream(res,'Operation result checked.');return}
  if(request.startsWith('create'))hostToolStream(res,'write',{type:'task_data.create',data:{schema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false},value:{value:'initial'},references:[]}})
  else if(request.startsWith('replace '))hostToolStream(res,'write',{type:'task_data.replace',id:request.slice(8),expected_revision:1,value:{value:'updated'},references:[]})
  else textStream(res,'Synthetic normal answer.')
 })
 const parent=await mkdtemp(join(tmpdir(),'trellis-explicit-limits-desktop-')),root=join(parent,'.trellis')
 const launch=()=>electron.launch({executablePath:electronPath,args:['.'],env:{...process.env,ELECTRON_RUN_AS_NODE:'',ELECTRON_RENDERER_URL:'',TRELLIS_TEST_DATA:root,TRELLIS_TEST_VIEW_REPLACEMENT:'1'}})
 let app=await launch()
 try{
  let page=await app.firstWindow();await page.route('https://**',route=>route.abort())
  const call=async(request:unknown):Promise<any>=>page.evaluate(async request=>{const r=await window.trellis.request(request as any);if(!r.ok)throw Error(r.error.code);return r.data},request)
  await addChannel(page,{name:'Explicit',url:server.url,key:'synthetic-only',remember:true})
  await addModel(page,{name:'Explicit',model:'wire',context:1000000,output:32768})
  const modelId=(await call({type:'model.list'})).models[0].id
  await page.getByRole('button',{name:'编辑模型 Explicit',exact:true}).click()
  await page.getByText('运行限额与压缩模型',{exact:true}).click()
  await page.getByLabel('单请求超时（毫秒）').fill('300000')
  await page.getByLabel('Run 模型请求次数').fill('80')
  await page.getByRole('button',{name:'保存模型',exact:true}).click()
  await expect(page.getByRole('dialog',{name:'编辑模型',exact:true})).toHaveCount(0)
  expect(server.exchanges).toHaveLength(0)
  await closeSettings(page)
  for(const role of ['main','approval','compaction'])await call({type:'model.test',model_id:modelId,role,confirm_cost:true})
  const task=(await call({type:'task.create',title:'Explicit limits synthetic'})).task.id
  await call({type:'approval.configure',mode:'assisted',model_id:modelId,confirm_external_processing:true})
  const run=async(text:string)=>{await call({type:'task.submit',task_id:task,text,model_config_id:modelId,attachments:[]});await expect.poll(async()=>{const snap=await call({type:'task.snapshot',task_id:task});return snap.runs[0].state}).toBe('completed')}
  await run('create synthetic data');let snapshot=await call({type:'task.snapshot',task_id:task});const object=snapshot.task_data.items[0].id
  await run('replace '+object);expect(await call({type:'task.data.read',task_id:task,id:object,expected_revision:2})).toMatchObject({value:{value:'updated'}})
  await call({type:'context.compact',task_id:task,model_config_id:modelId,confirm_cost:true});await expect.poll(async()=>(await call({type:'task.snapshot',task_id:task})).runs[0].state).toBe('completed')
  expect(server.exchanges.length).toBeGreaterThan(8);expect(server.exchanges.every(e=>e.body.max_tokens===32768)).toBe(true)
  expect(server.exchanges.some(e=>e.body.messages[0].content.includes('你是 Trellis 的单次动作辅助审批评估器。'))).toBe(true)
  expect(server.exchanges.some(e=>e.body.messages.at(-1).role==='system')).toBe(true)
  await openSettings(page, '模型服务');await page.getByRole('button',{name:'编辑模型 Explicit',exact:true}).click()
  await page.getByText('运行限额与压缩模型',{exact:true}).click();await page.getByLabel('输出上限（留空由服务决定）').fill('');await page.getByLabel('单请求超时（毫秒）').fill('');await page.getByLabel('Run 模型请求次数').fill('')
  await page.getByRole('button',{name:'保存模型',exact:true}).click();await expect(page.getByRole('dialog',{name:'编辑模型',exact:true})).toHaveCount(0);await closeSettings(page)
  const beforeUnset=server.exchanges.length
  for(const role of ['main','approval','compaction'])await call({type:'model.test',model_id:modelId,role,confirm_cost:true})
  await run('normal unset output');snapshot=await call({type:'task.snapshot',task_id:task});const runId=snapshot.runs[0].id
  const ledger=await call({type:'task.query',task_id:task,query:{type:'read',input:{target:{kind:'run',id:runId}}}})
  expect(ledger.data.accounting.requests[0]).toMatchObject({version:2,output_policy:'service-default',output_reserve:null})
  const settings=JSON.parse(await readFile(join(root,'settings.json'),'utf8'));expect(settings.version).toBe(4);expect(settings.connections[0].configuration).not.toHaveProperty('max_output_tokens');expect(settings.connections[0].configuration.limits).toEqual({})
  expect(server.exchanges.slice(beforeUnset).every(e=>!Object.hasOwn(e.body,'max_tokens')&&!Object.hasOwn(e.body,'max_completion_tokens'))).toBe(true)
  const count=server.exchanges.length,auth=await readFile(join(root,'auth.json'),'utf8'),saved=await readFile(join(root,'settings.json'),'utf8')
  await app.close();app=await launch();page=await app.firstWindow();await page.waitForFunction(()=>!!window.trellis);await page.route('https://**',route=>route.abort())
  expect(server.exchanges).toHaveLength(count);expect(await readFile(join(root,'auth.json'),'utf8')).toBe(auth);expect(await readFile(join(root,'settings.json'),'utf8')).toBe(saved)
  const state=await call({type:'model.list'});expect(state.models[0]).not.toHaveProperty('max_output_tokens');expect(state.models[0].roles).toEqual(expect.arrayContaining(['main','approval','compaction']))
  await openSettings(page, '模型服务');await page.getByRole('button',{name:'编辑模型 Explicit',exact:true}).click();await expect(page.getByLabel('输出上限（留空由服务决定）')).toHaveValue('');await page.getByText('运行限额与压缩模型',{exact:true}).click();await expect(page.getByLabel('单请求超时（毫秒）')).toHaveValue('');await page.getByRole('button',{name:'关闭',exact:true}).click();await closeSettings(page)
  expect((await call({type:'task.query',task_id:task,query:{type:'read',input:{target:{kind:'run',id:runId}}}})).data.accounting.requests[0]).toMatchObject({version:2,output_policy:'service-default',output_reserve:null})
  await run('normal after restart');expect(server.exchanges.at(-1)!.body).not.toHaveProperty('max_tokens')
 }finally{await app.close().catch(()=>{});await server.close()}
})
