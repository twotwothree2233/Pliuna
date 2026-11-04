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
  await page.getByRole('button',{name:'模型与审批',exact:true}).click()
  await page.getByLabel('配置标识').fill('explicit')
  await page.getByLabel('服务 Base URL').fill(server.url)
  await page.getByLabel('API Key',{exact:true}).fill('synthetic-only')
  await page.getByLabel('精确模型标识').fill('wire')
  await page.getByLabel('已知上下文容量').fill('1000000')
  await page.getByLabel('输出上限',{exact:true}).fill('32768')
  await page.getByLabel('单请求超时（毫秒）').fill('300000')
  await page.getByLabel('Run 模型请求次数').fill('80')
  await page.getByRole('button',{name:'仅保存配置（不联网）',exact:true}).click()
  await expect(page.getByRole('status')).toContainText('未联网');expect(server.exchanges).toHaveLength(0)
  let modal=page.getByRole('dialog',{name:'模型与审批配置',exact:true});await modal.getByRole('button',{name:'关闭',exact:true}).click()
  for(const role of ['main','approval','compaction'])await call({type:'model.test',model_id:'explicit',role,confirm_cost:true})
  const task=(await call({type:'task.create',title:'Explicit limits synthetic'})).task.id
  await call({type:'approval.configure',mode:'assisted',model_id:'explicit',confirm_external_processing:true})
  const run=async(text:string)=>{await call({type:'task.submit',task_id:task,text,model_config_id:'explicit',attachments:[]});await expect.poll(async()=>{const snap=await call({type:'task.snapshot',task_id:task});return snap.runs[0].state}).toBe('completed')}
  await run('create synthetic data');let snapshot=await call({type:'task.snapshot',task_id:task});const object=snapshot.task_data.items[0].id
  await run('replace '+object);expect(await call({type:'task.data.read',task_id:task,id:object,expected_revision:2})).toMatchObject({value:{value:'updated'}})
  await call({type:'context.compact',task_id:task,model_config_id:'explicit',confirm_cost:true});await expect.poll(async()=>(await call({type:'task.snapshot',task_id:task})).runs[0].state).toBe('completed')
  expect(server.exchanges.length).toBeGreaterThan(8);expect(server.exchanges.every(e=>e.body.max_tokens===32768)).toBe(true)
  expect(server.exchanges.some(e=>e.body.messages[0].content.includes('你是 Trellis 的单次动作辅助审批评估器。'))).toBe(true)
  expect(server.exchanges.some(e=>e.body.messages.at(-1).role==='system')).toBe(true)
  await page.getByRole('button',{name:'模型与审批',exact:true}).click();await page.getByRole('button',{name:'编辑连接',exact:true}).click()
  await page.getByLabel('输出上限',{exact:true}).fill('');await page.getByLabel('单请求超时（毫秒）').fill('');await page.getByLabel('Run 模型请求次数').fill('')
  await page.getByRole('button',{name:'仅保存配置（不联网）',exact:true}).click();await expect(page.getByRole('status')).toContainText('未联网');await modal.getByRole('button',{name:'关闭',exact:true}).click()
  const beforeUnset=server.exchanges.length
  for(const role of ['main','approval','compaction'])await call({type:'model.test',model_id:'explicit',role,confirm_cost:true})
  await run('normal unset output');snapshot=await call({type:'task.snapshot',task_id:task});const runId=snapshot.runs[0].id
  const ledger=await call({type:'task.query',task_id:task,query:{type:'read',input:{target:{kind:'run',id:runId}}}})
  expect(ledger.data.accounting.requests[0]).toMatchObject({version:2,output_policy:'service-default',output_reserve:null})
  const settings=JSON.parse(await readFile(join(root,'settings.json'),'utf8'));expect(settings.version).toBe(3);expect(settings.connections[0].configuration).not.toHaveProperty('max_output_tokens');expect(settings.connections[0].configuration.limits).toEqual({})
  expect(server.exchanges.slice(beforeUnset).every(e=>!Object.hasOwn(e.body,'max_tokens')&&!Object.hasOwn(e.body,'max_completion_tokens'))).toBe(true)
  const count=server.exchanges.length,auth=await readFile(join(root,'auth.json'),'utf8'),saved=await readFile(join(root,'settings.json'),'utf8')
  await app.close();app=await launch();page=await app.firstWindow();await page.waitForFunction(()=>!!window.trellis);await page.route('https://**',route=>route.abort())
  modal=page.getByRole('dialog',{name:'模型与审批配置',exact:true})
  expect(server.exchanges).toHaveLength(count);expect(await readFile(join(root,'auth.json'),'utf8')).toBe(auth);expect(await readFile(join(root,'settings.json'),'utf8')).toBe(saved)
  const state=await call({type:'model.list'});expect(state.models[0]).not.toHaveProperty('max_output_tokens');expect(state.models[0].roles).toEqual(expect.arrayContaining(['main','approval','compaction']))
  await page.getByRole('button',{name:'模型与审批',exact:true}).click();await page.getByRole('button',{name:'编辑连接',exact:true}).click();await expect(page.getByLabel('输出上限',{exact:true})).toHaveValue('');await expect(page.getByLabel('单请求超时（毫秒）')).toHaveValue('');await modal.getByRole('button',{name:'关闭',exact:true}).click()
  expect((await call({type:'task.query',task_id:task,query:{type:'read',input:{target:{kind:'run',id:runId}}}})).data.accounting.requests[0]).toMatchObject({version:2,output_policy:'service-default',output_reserve:null})
  await run('normal after restart');expect(server.exchanges.at(-1)!.body).not.toHaveProperty('max_tokens')
 }finally{await app.close().catch(()=>{});await server.close()}
})
