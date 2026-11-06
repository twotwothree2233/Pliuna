import { openPending } from '../helpers/agent-ui'
import { openSettings } from '../helpers/settings-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
const electronPath: string = createRequire(import.meta.url)('electron')
for (const scenario of ['echo-restart', 'independent-data', 'surface-preserve-reset', 'revoke-active', 'revoke-idle', 'mobile'] as const) test('isolated plugin desktop: '+scenario, async()=>{
 test.setTimeout(90000)
 const root=await mkdtemp(join(tmpdir(),'trellis-plugin-desktop-')),fixture=resolve('tests/fixtures/plugin-demo')
 const server=await modelServer(({body,url},res)=>{
  if(url==='/v1/models'){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[{"id":"fixture-model"}]}');return}
  if(synthetic(body,res))return
  const current=JSON.parse(body.messages.findLast((m:any)=>m.role==='user').content),last=body.messages.at(-1)
  if(scenario==='echo-restart'){
   const tools=body.messages.filter((m:any)=>m.role==='tool')
   if(!tools.length){hostToolStream(res,'list',{kind:'capability'});return}
   const value=JSON.parse(last.content)
   if(tools.length===1){const echo=value.data.items.find((item:any)=>!item.id.startsWith('builtin:')&&!item.description.startsWith('Propose'));expect(echo).toBeDefined();hostToolStream(res,'read',{target:{kind:'capability',id:echo.id}});return}
   if(tools.length===2){hostToolStream(res,'call',{capability:value.data.data.id,arguments:{text:'PLUGIN_ECHO_OK'},references:[]});return}
  }
  if(last.role!=='tool'){hostToolStream(res,'list',{kind:'capability'},'','discover-capabilities');return}
  if(last.tool_call_id!=='discover-capabilities'){textStream(res,'PLUGIN_REQUEST_FINISHED');return}
  const capabilities=JSON.parse(last.content).data.items.filter((c:any)=>!c.id.startsWith('builtin:')),propose=capabilities.find((c:any)=>c.description.startsWith('Propose'))
  const args=current.request.startsWith('propose:')?{operation:current.request.slice(8),text:'new fixture value'}:{text:'PLUGIN_ECHO_OK',...(scenario==='revoke-active'?{delay_ms:5000}:{})}
  hostToolStream(res,'call',{capability:current.request.startsWith('propose:')?propose.id:capabilities.find((c:any)=>c.id!==propose.id).id,arguments:args,references:[]})
 })
 const launch=()=>electron.launch({executablePath:electronPath,args:['.'],env:{...process.env,ELECTRON_RUN_AS_NODE:'',ELECTRON_RENDERER_URL:'',TRELLIS_TEST_DATA:root,TRELLIS_ENABLE_VIEW_REPLACEMENT:'1'}})
 let app=await launch(),page=await app.firstWindow();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
 const call=async(r:any):Promise<any>=>{const response=await page.evaluate(r=>window.trellis.request(r),r);if(!response.ok)throw Error(response.error.code);return response.data}
 try{
  await call({type:'model.configure',configuration:{id:'fixture-main',base_url:server.url,wire_model_id:'fixture-model',context_tokens:1000000,max_output_tokens:4096,compatibility_profile:'chat-max-tokens'},api_key:'synthetic-only',confirm_memory_only:true})
  await call({type:'model.test',model_id:'fixture-main',role:'main',confirm_cost:true})
  await page.getByRole('button',{name:'创建第一个任务'}).click();await page.getByLabel('任务名称').fill('Plugin desktop fixture');await page.getByRole('button',{name:'创建任务',exact:true}).click()
  const task=(await call({type:'host.tasks'}))[0].id
  await openSettings(page, '插件与主流程');let panel=page.getByRole('dialog',{name:'应用设置',exact:true})
  if(scenario==='mobile')await page.setViewportSize({width:390,height:600})
  await app.evaluate(({dialog},fixture)=>{(dialog as any).showOpenDialog=async()=>({canceled:false,filePaths:[fixture]})},fixture)
  await panel.getByRole('button',{name:'从文件夹导入固定包'}).click();await expect(panel).toContainText('trellis.acceptance')
  const installed=(await call({type:'plugin.list',task_id:task})).items[0];expect(installed).toMatchObject({trusted:false,enabled:false,instances:[]})
  await panel.getByRole('button',{name:'核对代码信任'}).click();await expect(panel.getByRole('button',{name:'确认代码信任',exact:true})).toBeDisabled()
  await panel.getByRole('checkbox',{name:/我已核对固定包代码/}).check();await panel.getByRole('button',{name:'确认代码信任',exact:true}).click()
  await panel.getByRole('button',{name:'核对启用依赖'}).click();await panel.getByRole('button',{name:'确认共同启用'}).click();await expect(panel).toContainText('当前可用')
  await panel.getByRole('button',{name:'选择为唯一主流程'}).click();await expect(panel.getByRole('button',{name:'当前主流程'})).toBeDisabled()
  expect((await call({type:'plugin.list',task_id:task})).items[0].instances).toEqual([])
  if(scenario==='mobile'){
   expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true)
   await panel.getByRole('button',{name:/^返回工作区/}).click();expect(errors).toEqual([]);return
  }
  await panel.getByRole('button',{name:/^返回工作区/}).click()
  const submit=async(text:string)=>call({type:'request.submit',task_id:task,text,model_config_id:'fixture-main',resource_ids:[],import_ids:[]})
  const waitRun=async(id:string)=>expect.poll(async()=>(await call({type:'request.status',task_id:task,request_id:id})).run_state).toBe('completed')
  const approve=async()=>{await openPending(page);const card=page.locator('.approval-card').filter({has:page.getByRole('button',{name:'批准本次动作',exact:true})}).last();await expect(card).toBeVisible();await card.getByRole('button',{name:'批准本次动作',exact:true}).click()}
  if(scenario==='echo-restart'){
   const run=await submit('echo');await waitRun(run.request_id)
   const calls=await call({type:'task.query',task_id:task,query:{type:'list',input:{kind:'call'}}});expect(calls.items).toHaveLength(1)
   const result=await call({type:'task.query',task_id:task,query:{type:'read',input:{target:{kind:'call',id:calls.items[0].id}}}});expect(result.data.result_data).toMatchObject({execution:'success',data:{text:'PLUGIN_ECHO_OK'}})
   await app.close();app=await launch();page=await app.firstWindow()
   expect((await call({type:'plugin.list',task_id:task})).items[0]).toMatchObject({trusted:true,enabled:true,workflow:'acceptance',instances:[]})
   expect((await call({type:'task.snapshot',task_id:task})).runs).toHaveLength(1)
  }else if(scenario==='independent-data'){
   let run=await submit('propose:create_data');await approve();await waitRun(run.request_id)
   await expect.poll(async()=>(await call({type:'task.snapshot',task_id:task})).task_data.total).toBe(1)
   run=await submit('propose:replace_data');await approve();await waitRun(run.request_id);await approve()
   await expect.poll(async()=>(await call({type:'task.snapshot',task_id:task})).task_data.items[0].revision).toBe(2)
   const data=(await call({type:'task.snapshot',task_id:task})).task_data.items[0];expect((await call({type:'task.data.read',task_id:task,id:data.id,expected_revision:2})).value).toEqual({stage:'new fixture value'})
  }else if(scenario==='surface-preserve-reset'){
   let run=await submit('propose:create_view');await approve();await waitRun(run.request_id);await expect(page.getByLabel('Plugin answer',{exact:true})).toBeVisible()
   await page.getByLabel('Plugin answer',{exact:true}).fill('PRESERVED_INPUT');await expect(page.getByRole('status').filter({hasText:/^已保存$/})).toBeVisible()
   run=await submit('propose:preserve');await approve();await waitRun(run.request_id);await approve();await openPending(page);await page.getByRole('button',{name:'保存输入并检查替换'}).click();await expect(page.getByLabel('Plugin answer',{exact:true})).toHaveValue('PRESERVED_INPUT')
   await expect.poll(async()=>(await call({type:'task.snapshot',task_id:task})).surface_updates.length).toBe(0)
   await expect(page.getByRole('dialog',{name:'待处理事项',exact:true})).toHaveCount(0)
   run=await submit('propose:reset');await approve();await waitRun(run.request_id);await approve();await openPending(page);await page.getByRole('button',{name:'取消本次替换'}).click();await expect(page.getByLabel('Plugin answer',{exact:true})).toHaveValue('PRESERVED_INPUT')
  }else if(scenario==='revoke-idle'){
   const run=await submit('echo');await waitRun(run.request_id)
   await openSettings(page, '插件与主流程');panel=page.getByRole('dialog',{name:'应用设置',exact:true})
   await panel.getByRole('button',{name:'撤销代码信任',exact:true}).click();await panel.getByRole('button',{name:'确认撤销',exact:true}).click()
   await expect(panel).toContainText('本地代码尚未信任')
   expect((await call({type:'plugin.list',task_id:task})).items[0]).toMatchObject({trusted:false,enabled:false,workflow:null,instances:[]})
   await app.close();app=await launch();page=await app.firstWindow()
   expect((await call({type:'plugin.list',task_id:task})).items[0]).toMatchObject({trusted:false,enabled:false,workflow:null,instances:[]})
  }else{
   const run=await submit('echo');await expect.poll(async()=>(await call({type:'plugin.list',task_id:task})).items[0].instances[0]?.state).toBe('executing_or_finalizing')
   await openSettings(page, '插件与主流程');panel=page.getByRole('dialog',{name:'应用设置',exact:true});await panel.getByRole('button',{name:'撤销代码信任',exact:true}).click();await panel.getByRole('button',{name:'确认撤销',exact:true}).click()
   await expect(panel).toContainText('本地代码尚未信任');expect((await call({type:'plugin.list',task_id:task})).items[0]).toMatchObject({enabled:false,workflow:null,instances:[]})
   await expect.poll(async()=>(await call({type:'request.status',task_id:task,request_id:run.request_id})).run_state).toBe('completed')
   const calls=await call({type:'task.query',task_id:task,query:{type:'list',input:{kind:'call'}}});expect(calls.items).toHaveLength(1)
   const result=await call({type:'task.query',task_id:task,query:{type:'read',input:{target:{kind:'call',id:calls.items[0].id}}}});expect(result.data.execution).not.toBe('success')
  }
  expect(errors).toEqual([])
 }finally{await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.destroy()}).catch(()=>{});await app.close();await server.close();await rm(root,{recursive:true,force:true})}
})
