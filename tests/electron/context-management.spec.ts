import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { modelServer, synthetic, textStream } from '../helpers/model-server'
const summaryPrompt = readFileSync('src/runtime/model/prompts/summary-v0.1.txt', 'utf8')
const electronPath: string = createRequire(import.meta.url)('electron')
for (const scenario of ['organize-restart', 'cancel-late', 'invalid-candidate'] as const) test(`context management: ${scenario}`, async () => {
 let waiting:any=null
 const server=await modelServer(({body},res)=>{
  if(synthetic(body,res))return
  if(body.messages.at(-1).content===summaryPrompt){
   expect(body.messages.some((m:any)=>m.role==='user'&&JSON.parse(m.content).request==='Retain corrected goal and unresolved request.')).toBe(true)
   const result='Keep corrected goal; no old approval grants current authority.'
   if(scenario==='cancel-late'){waiting={res,result};return}
   textStream(res,scenario==='invalid-candidate'?'   ':result);return
  }
  textStream(res,'Business reply; original records retained.')
 })
 const root=await mkdtemp(join(tmpdir(),'trellis-context-desktop-'))
 const launch=()=>electron.launch({executablePath:electronPath,args:['.'],env:{...process.env,ELECTRON_RUN_AS_NODE:'',ELECTRON_RENDERER_URL:'',TRELLIS_TEST_DATA:root,TRELLIS_TEST_VIEW_REPLACEMENT:'1'}})
 let app=await launch()
 try{
  let page=await app.firstWindow()
  const call=async(request:unknown)=>page.evaluate(async request=>{const result=await window.trellis.request(request as any);if(!result.ok)throw Error(result.error.code);return result.data as any},request)
  await call({type:'model.configure',configuration:{id:'context-main',base_url:server.url,wire_model_id:'wire',context_tokens:100000,max_output_tokens:8192,compatibility_profile:'chat-max-tokens'},api_key:'synthetic-key',confirm_memory_only:true,remember_connection:true,confirm_plaintext_storage:true})
  await call({type:'model.test',model_id:'context-main',role:'main',confirm_cost:true})
  await page.getByRole('button',{name:'创建第一个任务',exact:true}).click();await page.getByLabel('任务名称').fill('Context acceptance');await page.getByRole('button',{name:'创建任务',exact:true}).click()
  await expect(page.getByRole('button',{name:/Context acceptance/})).toBeVisible();const created={task:(await call({type:'host.tasks'}))[0]}
  await page.getByRole('button',{name:'更多 Agent 操作'}).click();await page.getByRole('menuitem',{name:'工作摘要与上下文',exact:true}).click()
  if(scenario==='organize-restart'){
   const count=server.exchanges.length
   await page.getByRole('button',{name:'整理上下文',exact:true}).click();await page.getByRole('button',{name:'确认费用并整理',exact:true}).click()
   await expect(page.getByRole('status').filter({hasText:'没有新的可整理历史'})).toBeVisible()
   expect((await call({type:'task.snapshot',task_id:created.task.id})).runs).toHaveLength(0);expect(server.exchanges).toHaveLength(count)
  }

  await call({type:'task.submit',task_id:created.task.id,text:'Retain corrected goal and unresolved request.',model_config_id:'context-main',attachments:[]})
  await expect.poll(async()=> (await call({type:'task.snapshot',task_id:created.task.id})).runs[0].state).toBe('completed')
  await page.getByRole('button',{name:'关闭弹窗',exact:true}).click()
  const input=page.locator('textarea').filter({visible:true}).last();await input.fill('Unsent input must stay local');await page.getByRole('button',{name:'更多 Agent 操作'}).click();await page.getByRole('menuitem',{name:'工作摘要与上下文',exact:true}).click()
  await page.getByRole('button',{name:'整理上下文',exact:true}).click();await expect(page.getByText('未发送输入不会发送。',{exact:false})).toBeVisible()
  const before=server.exchanges.length
  await page.getByRole('button',{name:'取消整理',exact:true}).click();expect(server.exchanges).toHaveLength(before)
  await page.getByRole('button',{name:'整理上下文',exact:true}).click();await page.getByRole('button',{name:'确认费用并整理',exact:true}).click()
  if(scenario==='cancel-late'){
   await expect.poll(()=>!!waiting).toBe(true);await expect(page.getByRole('status').filter({hasText:'正在整理上下文'})).toBeVisible()
   await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();await page.getByRole('button',{name:'停止本次执行',exact:true}).click();await page.getByRole('dialog',{name:'停止当前执行？'}).getByRole('button',{name:'停止本次执行',exact:true}).click();textStream(waiting.res,waiting.result)
   await expect.poll(async()=> (await call({type:'task.snapshot',task_id:created.task.id})).runs[0].state).toBe('cancelled')
   expect((await call({type:'context.status',task_id:created.task.id})).current).toBeNull()
  }else if(scenario==='invalid-candidate'){
   await expect.poll(async()=> (await call({type:'task.snapshot',task_id:created.task.id})).runs[0].state).toBe('failed');expect((await call({type:'context.status',task_id:created.task.id})).current).toBeNull()
   expect(server.exchanges.length).toBe(before+1)
  }else{
   await expect.poll(async()=> (await call({type:'context.status',task_id:created.task.id})).current?.version).toBe(2)
   await expect(page.getByText(/工作摘要与保留记录 · 覆盖至/)).toBeVisible();await page.getByText(/工作摘要与保留记录 · 覆盖至/).click();await expect(page.getByText('Keep corrected goal; no old approval grants current authority.',{exact:false})).toBeVisible()
   expect(JSON.parse(await readFile(join(root,'settings.json'),'utf8')).version).toBe(4)
   await expect(input).toHaveValue('Unsent input must stay local');await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();await input.fill('');await page.getByRole('button',{name:'更多 Agent 操作'}).click();await page.getByRole('menuitem',{name:'工作摘要与上下文',exact:true}).click()
   const unchanged=await call({type:'task.snapshot',task_id:created.task.id}),oldSummary=await call({type:'context.status',task_id:created.task.id}),noRequest=server.exchanges.length
   await page.getByRole('button',{name:'整理上下文',exact:true}).click();await page.getByRole('button',{name:'确认费用并整理',exact:true}).click()
   await expect(page.getByRole('status').filter({hasText:'没有新的可整理历史'})).toBeVisible()
   expect((await call({type:'task.snapshot',task_id:created.task.id})).runs).toEqual(unchanged.runs);expect((await call({type:'context.status',task_id:created.task.id})).current).toEqual(oldSummary.current);expect(server.exchanges).toHaveLength(noRequest)
   const linkedRecords=(await call({type:'task.snapshot',task_id:created.task.id})).records
   const responseRecord=linkedRecords.find((r:any)=>r.kind==='model.response'), evidenceRecord=linkedRecords.find((r:any)=>r.id===responseRecord.payload.request_link.evidence_event_id)
   expect(evidenceRecord.kind).toBe('model.request.evidence');expect(evidenceRecord.payload.request_id).toBe(responseRecord.payload.request_link.request_id)
   const summaryEvidence=linkedRecords.find((r:any)=>r.id===oldSummary.current.request_link.evidence_event_id)
   expect(summaryEvidence.kind).toBe('model.request.evidence');expect(summaryEvidence.payload.request_id).toBe(oldSummary.current.request_link.request_id)
   expect(oldSummary.current.latest_user_id).toBe(linkedRecords.find((r:any)=>r.kind==='message.user').id)
   expect(oldSummary.current.retained_interactions).toHaveLength(1)
   const count=server.exchanges.length;await app.close();app=await launch();page=await app.firstWindow();await expect(page.getByRole('button',{name:/Context acceptance/})).toBeVisible();await page.getByRole('button',{name:/Context acceptance/}).click();await page.getByRole('button',{name:'更多 Agent 操作'}).click();await page.getByRole('menuitem',{name:'工作摘要与上下文',exact:true}).click();await expect(page.getByText(/工作摘要与保留记录 · 覆盖至/)).toBeVisible();expect(server.exchanges).toHaveLength(count)
   expect((await call({type:'context.status',task_id:created.task.id})).current).toEqual(oldSummary.current)
   expect((await call({type:'task.snapshot',task_id:created.task.id})).records).toEqual(linkedRecords)
   expect(await call({type:'context.compact',task_id:created.task.id,model_config_id:'context-main',confirm_cost:true})).toMatchObject({status:'unchanged',reason:'no_new_history'});expect(server.exchanges).toHaveLength(count)
  }
  expect(JSON.stringify(server.exchanges.filter(x=>x.body).map(x=>x.body))).not.toContain('Unsent input must stay local')
  if(scenario!=='organize-restart')await input.fill('')
 }finally{await app.close().catch(()=>{});await server.close();await rm(root,{recursive:true,force:true})}
})
