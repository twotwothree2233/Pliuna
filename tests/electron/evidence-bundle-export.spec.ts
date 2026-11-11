import { openPending } from '../helpers/agent-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
import type { Bundle } from '../../src/shared/contracts.generated'
const executablePath: string = createRequire(import.meta.url)('electron')
const bundle = (text: string): Bundle => ({ profile:'managed-v1',html:`<section id="lesson"><h2>${text}</h2><label for="answer">Synthetic answer</label><input id="answer" type="text"><button id="submit" type="button">Submit synthetic answer</button></section>`,css:'',state:{schema:{type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false},initial:{answer:''},compatibility_version:'v1'},forms:[{id:'answer',fields:['/answer']}],behaviors:[{type:'input',element_id:'answer',field:'/answer',control:'text'},{type:'submit',element_id:'submit',form_id:'answer'}],references:[],export:[{id:'lesson',category:'learning',source:{type:'element',element_id:'lesson'}}]})

test('resource bundle approval, explicit personal fragments, static file and isolated restart', async()=>{
 let task:any,source:any,mode:'create'|'replace'|'invalid'|'feedback'='create',step=0,resource='',original:any
 const server=await modelServer(({body},res)=>{
  if(synthetic(body,res))return
  const host=body.messages.map((m:any)=>{try{return JSON.parse(m.content)}catch{return null}}).find((m:any)=>m?.request)
  expect(host).not.toHaveProperty('host_context')
  if(step++===0){const next=mode==='feedback'?bundle('CURRENT_LESSON'):bundle(mode==='create'?'ORIGINAL_QUESTION':'UPDATED_QUESTION');if(mode==='invalid')next.export.push({id:'overlap',category:'learning',source:{type:'element',element_id:'answer'}});if(mode==='feedback'){next.html+='<p id="feedback">BOUND_PERSONAL_FEEDBACK</p>';next.export.push({id:'feedback',category:'feedback',source:{type:'element',element_id:'feedback'},personal_binding:{version:1,answer_id:original.id,view_history_id:original.view_history_id}})}return hostToolStream(res,'write',{type:'resource.create',display_name:'bundle.json',content:{type:'json',value:next}})}
  if(step===2){resource=JSON.parse(body.messages.at(-1).content).data.id;const op=mode==='replace'?{type:'view.replace',view_id:source.views[0].id,expected_view_revision:source.views[0].revision,state_transition:{type:'preserve',expected_state_revision:source.views[0].state_revision,compatibility_version:'v1'}}:{type:'view.create',slot_id:'main',client_ref:mode};return hostToolStream(res,'write',{type:'surface.update',surface_id:source.surface.id,expected_revision:source.surface.revision,operations:[{...op,bundle:{type:'resource',resource:{kind:'resource',id:resource}}}]})}
  if(mode==='invalid')expect(JSON.parse(body.messages.at(-1).content).error.code).toBe('EXPORT_FRAGMENT_OVERLAP')
  textStream(res,'FINISHED_'+mode)
 })
 const root=await mkdtemp(join(tmpdir(),'pliuna-evidence-bundle-desktop-')),target=join(root,'static-delivery.html')
 const launch=()=>electron.launch({executablePath,args:['.'],env:{...process.env,ELECTRON_RUN_AS_NODE:'',ELECTRON_RENDERER_URL:'',PLIUNA_TEST_DATA:root,PLIUNA_ENABLE_VIEW_REPLACEMENT:'1'}})
 let app=await test.step('Launch isolated application',()=>launch())
 try{
  let page=await app.firstWindow();const call=(r:unknown)=>test.step('Host request: '+(r as any).type,()=>page.evaluate(async r=>{const response=await window.pliuna.request(r as any);if(!response.ok)throw Error(response.error.code);return response.data as any},r))
  await call({type:'model.configure',configuration:{id:'evidence',base_url:server.url,wire_model_id:'wire',context_tokens:1000000,compatibility_profile:'chat-max-tokens'},api_key:'synthetic',confirm_memory_only:true});await call({type:'model.test',model_id:'evidence',role:'main',confirm_cost:true})
  await test.step('Create and select the task through the workspace',async()=>{
   await page.getByRole('button',{name:'创建第一个任务',exact:true}).click();await page.getByLabel('任务名称').fill('Evidence bundle delivery');await page.getByRole('button',{name:'创建任务',exact:true}).click()
   task=(await call({type:'host.tasks'}))[0];await expect(page.getByRole('button',{name:/Evidence bundle delivery/})).toBeVisible()
  })
  const snapshot=()=>call({type:'task.snapshot',task_id:task.id}),submit=async()=>{source=await snapshot();step=0;await call({type:'task.submit',task_id:task.id,text:'Explicit synthetic '+mode,model_config_id:'evidence',attachments:[]})}
  await submit();await expect(page.getByText('FINISHED_create',{exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'ORIGINAL_QUESTION',exact:true})).toBeVisible()
  await page.getByLabel('Synthetic answer',{exact:true}).fill('RETAINED_FORMAL_ANSWER');await expect(page.locator('.managed').getByRole('status')).toHaveText('已保存');await page.getByRole('button',{name:'Submit synthetic answer',exact:true}).click();await expect.poll(async()=>(await snapshot()).answer_total).toBe(1)
  const answer=(await snapshot()).answers[0],read=await call({type:'task.query',task_id:task.id,query:{type:'read',input:{target:{kind:'answer',id:answer.id}}}});original=read.data
  mode='replace';await submit();await openPending(page);await expect(page.getByRole('button',{name:'批准本次动作',exact:true})).toBeVisible();const approval=(await snapshot()).approvals.at(-1);expect(approval.request).toMatchObject({version:1,sources:[{id:resource}],effective_request:{operations:[{bundle:{type:'inline',bundle:{html:expect.stringContaining('UPDATED_QUESTION')}}}]}})
  await page.getByRole('button',{name:'批准本次动作',exact:true}).click();await openPending(page);await page.getByRole('button',{name:'保存输入并检查替换',exact:true}).click();await expect(page.getByText('FINISHED_replace',{exact:true})).toBeVisible();await expect(page.getByLabel('Synthetic answer',{exact:true})).toHaveValue('RETAINED_FORMAL_ANSWER')
  const beforeInvalid=await snapshot();mode='invalid';await submit();await expect(page.getByText('FINISHED_invalid',{exact:true})).toBeVisible();const afterInvalid=await snapshot();expect(afterInvalid.views).toEqual(beforeInvalid.views);expect(afterInvalid.surface).toEqual(beforeInvalid.surface);expect(afterInvalid.surface_updates).toHaveLength(0)
  mode='feedback';await submit();await expect(page.getByText('FINISHED_feedback',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'导出',exact:true}).click();await expect(page.getByText('片段 feedback', {exact:false})).toBeVisible();await page.getByRole('button',{name:'检查当前导出选择',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'完整性检查通过'})).toBeVisible();expect((await call({type:'export.list',task_id:task.id}))).toEqual([]);await page.getByRole('button',{name:'固定快照并预览',exact:true}).click();const frame=page.frameLocator('iframe[title="固定快照离线预览"]');await expect(frame.getByText('BOUND_PERSONAL_FEEDBACK',{exact:true})).toHaveCount(0)
  await page.getByRole('button',{name:'取消并释放本次快照',exact:true}).click();await page.getByLabel(/片段 feedback/).check();await page.getByText(/可选：附带已提交作答/).click();await page.getByLabel(/原题版本绑定/).check();await expect(page.getByRole('region',{name:'导出选择检查'})).toHaveCount(0);await page.getByRole('button',{name:'检查当前导出选择',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'完整性检查通过'})).toBeVisible();await page.getByRole('button',{name:'固定快照并预览',exact:true}).click();await expect(frame.getByText('BOUND_PERSONAL_FEEDBACK',{exact:true})).toBeVisible();await expect(frame.getByRole('heading',{name:'ORIGINAL_QUESTION',exact:true})).toBeVisible()
  await app.evaluate(({dialog},target)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:target})},target);await page.getByRole('button',{name:'选择位置并保存 HTML',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'导出状态：saved'})).toBeVisible()
  const html=await readFile(target,'utf8');expect(html).toContain('RETAINED_FORMAL_ANSWER');expect(html).toContain('BOUND_PERSONAL_FEEDBACK');expect(html).not.toContain(original.id);expect(html).not.toMatch(/<script|<input|<button|<textarea/)
  const count=server.exchanges.length;await app.close();app=await launch();page=await app.firstWindow();await page.getByRole('button',{name:/Evidence bundle delivery/}).click();await expect(page.getByRole('heading',{name:'UPDATED_QUESTION',exact:true})).toBeVisible();expect((await snapshot()).answer_total).toBe(1);expect(server.exchanges).toHaveLength(count);expect(await readFile(target,'utf8')).toBe(html);console.log('Preserved fresh synthetic personal export directory:',root)
 }finally{await test.step('Close isolated application',async()=>{await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close().catch(()=>{});await server.close()})}
})
