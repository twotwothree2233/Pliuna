import { openPending } from '../helpers/agent-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
import type { Bundle } from '../../src/shared/contracts.generated'
const executablePath:string=createRequire(import.meta.url)('electron')
const bundle=(n:number):Bundle=>({profile:'managed-v1',html:`<section id="lesson"><h2>LONG_LESSON_${n}</h2></section>`,css:'#lesson{color:#145634}',state:{schema:{type:'object',additionalProperties:false,properties:{}},initial:{},compatibility_version:'v1'},forms:[],behaviors:[],references:[],export:[{id:'learning',category:'learning',source:{type:'element',element_id:'lesson'}}]})
test('cross-page background export and long-approval original result navigation',async()=>{
 test.setTimeout(60000)
 let source:any,dataId='',mode='views'
 const server=await modelServer(({body},res)=>{
  if(synthetic(body,res))return
  if(body.messages.at(-1).role==='tool')return textStream(res,'LONG_DONE_'+mode)
  if(mode==='views')return hostToolStream(res,'write',{type:'surface.update',surface_id:source.surface.id,expected_revision:source.surface.revision,operations:Array.from({length:22},(_,n)=>({type:'view.create',client_ref:'v'+n,slot_id:'main',bundle:{type:'inline',bundle:bundle(n)}}))})
  if(mode==='data')return hostToolStream(res,'write',{type:'task_data.create',data:{schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},value:{text:'initial'},references:[]}})
  hostToolStream(res,'write',{type:'task_data.replace',id:dataId,expected_revision:1,value:{text:'LONG_PARAMETER_'.repeat(5000)},references:[]})
 })
 const root=await mkdtemp(join(tmpdir(),'pliuna-long-desktop-')),launch=()=>electron.launch({executablePath,args:['.'],env:{...process.env,ELECTRON_RUN_AS_NODE:'',ELECTRON_RENDERER_URL:'',PLIUNA_TEST_DATA:root,PLIUNA_ENABLE_VIEW_REPLACEMENT:'1'}})
 let app=await launch()
 try{
  let page=await app.firstWindow();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
  const call=(request:unknown)=>page.evaluate(async r=>{const reply=await window.pliuna.request(r as any);if(!reply.ok)throw Error(reply.error.code);return reply.data as any},request)
  await call({type:'model.configure',configuration:{id:'long',base_url:server.url,wire_model_id:'wire',context_tokens:1000000,max_output_tokens:100000,compatibility_profile:'chat-max-tokens'},api_key:'synthetic',confirm_memory_only:true})
  await call({type:'model.test',model_id:'long',role:'main',confirm_cost:true})
  await page.getByRole('button',{name:'创建第一个任务',exact:true}).click();await page.getByLabel('任务名称').fill('Long task acceptance');await page.getByRole('button',{name:'创建任务',exact:true}).click()
  const task=(await call({type:'host.tasks'}))[0];source=await call({type:'task.snapshot',task_id:task.id})
  const submit=async(text:string)=>call({type:'task.submit',task_id:task.id,text,model_config_id:'long',attachments:[]})
  await submit('Publish twenty-two synthetic lessons');await expect(page.getByText('LONG_DONE_views',{exact:true})).toBeVisible()
  const count=server.exchanges.length
  await page.getByRole('button',{name:'导出',exact:true}).click();await page.getByRole('button',{name:'下一页导出内容',exact:true}).click();await page.getByLabel('内容 22 · 版本 1',{exact:true}).check();await page.getByRole('button',{name:'上一页导出内容',exact:true}).click();await expect(page.getByLabel('内容 1 · 版本 1',{exact:true})).toBeChecked()
  await page.getByRole('button',{name:'固定快照并预览',exact:true}).click();await page.getByRole('button',{name:'关闭导出',exact:true}).click()
  const job=(await call({type:'export.list',task_id:task.id}))[0]
  await expect.poll(async()=>(await call({type:'export.status',task_id:task.id,operation_id:job.id})).phase).toBe('preview')
  await page.getByRole('button',{name:'导出',exact:true}).click();await page.getByText('原导出作业（最近 20 项）',{exact:true}).click();await page.getByRole('button',{name:'查看此原作业',exact:true}).click()
  const frame=page.frameLocator('iframe[title="固定快照离线预览"]');await expect(frame.getByText('LONG_LESSON_21',{exact:true})).toBeVisible();await expect(frame.getByText('LONG_LESSON_0',{exact:true})).toBeVisible();await expect(frame.getByText('LONG_LESSON_10',{exact:true})).toHaveCount(0)
  await page.getByRole('button',{name:'取消并释放本次快照',exact:true}).click();await page.getByRole('button',{name:'关闭导出',exact:true}).click();expect(server.exchanges).toHaveLength(count)
  mode='data';await submit('Create a data object');await expect(page.getByText('LONG_DONE_data',{exact:true})).toBeVisible();dataId=(await call({type:'task.snapshot',task_id:task.id})).task_data.items[0].id
  mode='replace';await submit('Replace with long parameters');await openPending(page);const approve=page.getByRole('button',{name:'批准本次动作',exact:true});await expect(approve).toBeDisabled()
  const original=page.getByRole('region',{name:'本次审批原动作分页浏览'});await expect(original.getByRole('button',{name:'继续读取全文',exact:true})).toBeVisible()
  while(await original.getByRole('button',{name:'继续读取全文',exact:true}).count()){
   await original.getByRole('button',{name:'继续读取全文',exact:true}).click()
   await page.waitForFunction(()=>{const region=document.querySelector('[aria-label="本次审批原动作分页浏览"]');const button=[...(region?.querySelectorAll('button')??[])].find(button=>button.textContent==='继续读取全文');return !button||!button.disabled})
  }
  await expect(approve).toBeEnabled();await approve.click();await expect(page.getByText('LONG_DONE_replace',{exact:true})).toBeVisible();await expect.poll(async()=>(await call({type:'task.snapshot',task_id:task.id})).task_data.items[0].revision).toBe(2)
  const latest=(await call({type:'task.snapshot',task_id:task.id})).runs[0];const results=await call({type:'host.run.results',task_id:task.id,run_id:latest.id,offset:0});expect(results.items).toHaveLength(1);expect(results.items[0].result).toBe('success')
  await page.getByRole('button',{name:'更多 Agent 操作',exact:true}).click();await page.getByRole('menuitem',{name:'本次请求详情',exact:true}).click();await page.getByRole('button',{name:'查看本 Run 原操作结果',exact:true}).click();await expect(page.getByText('原操作 1 项；每页最多 50 项。',{exact:false})).toBeVisible()
  const beforeRestart=server.exchanges.length;await app.close();app=await launch();page=await app.firstWindow();await page.getByRole('button',{name:/Long task acceptance/}).click();expect((await call({type:'task.snapshot',task_id:task.id})).task_data.items[0].revision).toBe(2);expect(server.exchanges).toHaveLength(beforeRestart);expect(errors).toEqual([])
 }finally{await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close().catch(()=>{});await server.close();await rm(root,{recursive:true,force:true})}
})
