import { openPending } from '../helpers/agent-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
import type { Bundle } from '../../src/shared/contracts.generated'
const executablePath: string = createRequire(import.meta.url)('electron')
const bundle: Bundle = { profile: 'managed-v1', html: '<section id="learning"><h2>OFFLINE_LEARNING</h2><svg viewBox="0 0 80 40"><circle cx="20" cy="20" r="12" fill="#147654"></circle></svg><math><mfrac><mi>x</mi><mn>2</mn></mfrac></math></section><section id="answer-area"><label for="answer">Private answer</label><textarea id="answer"></textarea><button id="submit">Submit answer</button></section>', css: '', state: { schema: { type: 'object', additionalProperties: false, properties: { answer: { type: 'string' } } }, initial: { answer: '' }, compatibility_version: 'v1' }, forms: [{ id: 'answer', fields: ['/answer'] }], behaviors: [{ type: 'input', element_id: 'answer', field: '/answer', control: 'textarea' }, { type: 'submit', element_id: 'submit', form_id: 'answer' }], references: [], export: [{ id: 'learning', category: 'learning', source: { type: 'element', element_id: 'learning' } }, { id: 'answer-area', category: 'learning', source: { type: 'element', element_id: 'answer-area' } }] }

test('fixed preview, explicit answers, controlled overwrite, offline document and restart result', async () => {
  let surface: any
  const server = await modelServer(({ body }, res) => {
    if (synthetic(body, res)) return
    if (body.messages.at(-1).role === 'tool') return textStream(res, 'DAILY_READY')
    hostToolStream(res, 'write', { type: 'surface.update', surface_id: surface.id, expected_revision: surface.revision, operations: [{ type: 'view.create', client_ref: 'learning', slot_id: 'main', bundle: { type: 'inline', bundle } }] })
  })
  const root = await mkdtemp(join(tmpdir(), 'trellis-daily-export-')), target = join(root, 'learning.html')
  const launch = () => electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', TRELLIS_TEST_DATA: root, TRELLIS_ENABLE_VIEW_REPLACEMENT: '1' } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    const call = (request: unknown) => page.evaluate(async r => { const response = await window.trellis.request(r as any); if (!response.ok) throw Error(response.error.code); return response.data as any }, request)
    await call({ type: 'model.configure', configuration: { id: 'daily', base_url: server.url, wire_model_id: 'wire', context_tokens: 100000, max_output_tokens: 8192, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic', confirm_memory_only: true })
    await call({ type: 'model.test', model_id: 'daily', role: 'main', confirm_cost: true })
    await page.getByRole('button', { name: '创建第一个任务', exact: true }).click(); await page.getByLabel('任务名称').fill('Daily export'); await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const task = (await call({ type: 'host.tasks' }))[0]; surface = (await call({ type: 'task.snapshot', task_id: task.id })).surface
    await call({ type: 'task.submit', task_id: task.id, text: 'Publish lesson', model_config_id: 'daily', attachments: [] }); await expect(page.getByText('DAILY_READY', { exact: true })).toBeVisible()
    await expect(page.locator('.managed svg circle')).toHaveAttribute('r', '12'); await expect(page.locator('.managed math')).toBeVisible()
    await page.getByLabel('Private answer', { exact: true }).fill('PRIVATE_DRAFT_NEVER_EXPORT'); await expect(page.locator('.managed').getByRole('status')).toHaveText('已保存')
    const count = server.exchanges.length
    await page.getByRole('button', { name: '导出', exact: true }).click(); await page.getByRole('button', { name: '固定快照并预览', exact: true }).click()
    const preview = page.frameLocator('iframe[title="固定快照离线预览"]'); await expect(preview.getByText('OFFLINE_LEARNING', { exact: true })).toBeVisible(); await expect(preview.locator('textarea,input,button')).toHaveCount(0)
    const current = (await call({ type: 'export.list', task_id: task.id }))[0]
    expect((await call({ type: 'maintenance.status' })).phase).toBe('idle')
    const maintenance = await page.evaluate(() => window.trellis.request({ type: 'maintenance.begin' })); expect(maintenance.ok).toBe(false)
    await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) }, target)
    await writeFile(target, 'ORIGINAL_FILE')
    await page.getByRole('button', { name: '选择位置并保存 HTML', exact: true }).click(); await expect(page.getByRole('button', { name: '选择位置并保存 HTML', exact: true })).toBeEnabled(); expect(await readFile(target, 'utf8')).toBe('ORIGINAL_FILE')
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    await page.getByRole('button', { name: '选择位置并保存 HTML', exact: true }).click(); await expect(page.getByRole('status').filter({ hasText: '导出状态：saved' })).toBeVisible()
    const html = await readFile(target, 'utf8'); expect(html).toContain('OFFLINE_LEARNING'); expect(html).not.toContain('PRIVATE_DRAFT_NEVER_EXPORT'); expect(html).not.toMatch(/<input|<textarea|<button|<script|srcdoc=/)
    const offline = await app.browserWindow(page).then(() => app.evaluate(({ BrowserWindow }, html) => { const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }); return window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).then(async () => { const value = await window.webContents.executeJavaScript('(()=>{const roots=[document,...Array.from(document.querySelectorAll("section")).flatMap(el=>el.shadowRoot?[el.shadowRoot]:[])];return{lesson:roots.some(root=>root.textContent?.includes("OFFLINE_LEARNING")),formula:roots.some(root=>!!root.querySelector("math")),geometry:roots.some(root=>!!root.querySelector("svg circle")),controls:roots.reduce((n,root)=>n+root.querySelectorAll("input,textarea,button,script").length,0)}})()'); window.destroy(); return value }) }, html))
    expect(offline).toEqual({ lesson: true, formula: true, geometry: true, controls: 0 })
    expect(server.exchanges).toHaveLength(count)
    await page.getByRole('button', { name: '关闭导出', exact: true }).click(); await page.getByRole('button', { name: 'Submit answer', exact: true }).click(); await expect.poll(async () => (await call({ type: 'task.snapshot', task_id: task.id })).answer_total).toBe(1)
    const snapshot = await call({ type: 'task.snapshot', task_id: task.id }), selected = await call({ type: 'export.prepare', task_id: task.id, answer_ids: [snapshot.answers[0].id] }); await expect.poll(async () => (await call({ type: 'export.status', task_id: task.id, operation_id: selected.id })).phase).toBe('preview'); const selectedPreview = await call({ type: 'export.preview', task_id: task.id, operation_id: selected.id }); expect(selectedPreview.html).toContain('PRIVATE_DRAFT_NEVER_EXPORT'); expect(selectedPreview.html).toContain('原题版本 1'); await call({ type: 'export.cancel', task_id: task.id, operation_id: selected.id })
    await app.close(); app = await launch(); page = await app.firstWindow()
    expect(await call({ type: 'export.status', task_id: task.id, operation_id: current.id })).toMatchObject({ phase: 'saved', pinned: false }); expect(server.exchanges).toHaveLength(count)
    expect(await readFile(target, 'utf8')).toBe(html)
  } finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {}); await app.close().catch(() => {}); await server.close(); await rm(root, { recursive: true, force: true }) }
})

test('View paging saves input; layout and removal retain history across restart', async () => {
 let mode: 'create'|'layout'|'remove'='create', source:any, ids:string[]=[]
 const server=await modelServer(({body},res)=>{
  if(synthetic(body,res))return
  if(body.messages.at(-1).role==='tool'){
   if(mode==='create')ids=JSON.parse(body.messages.at(-1).content).data.views.map((view:any)=>view.view_id)
   return textStream(res,'DAILY_'+mode.toUpperCase()+'_ENDED')
  }
  const operations=mode==='create'?Array.from({length:12},(_,index)=>({type:'view.create',client_ref:'lesson-'+index,slot_id:'main',bundle:{type:'inline',bundle:{...bundle,html:bundle.html.replace('OFFLINE_LEARNING','Lesson '+index)}}})):mode==='layout'?[{type:'layout.set',layout:{slots:[{slot_id:'main',groups:[{id:'reordered',mode:'responsive_columns',views:[...ids].reverse().map(view_id=>({type:'existing',view_id})),gap:'large',align:'start'}]}]}}]:[{type:'view.remove',view_id:source.views[0].id,expected_view_revision:source.views[0].revision,expected_state_revision:source.views[0].state_revision}]
  hostToolStream(res,'write',{type:'surface.update',surface_id:source.surface.id,expected_revision:source.surface.revision,operations})
 })
 const root=await mkdtemp(join(tmpdir(),'trellis-daily-surface-')),launch=()=>electron.launch({executablePath,args:['.'],env:{...process.env,ELECTRON_RUN_AS_NODE:'',ELECTRON_RENDERER_URL:'',TRELLIS_TEST_DATA:root,TRELLIS_ENABLE_VIEW_REPLACEMENT:'1'}})
 let app=await launch()
 try{
  let page=await app.firstWindow();const call=(request:unknown)=>page.evaluate(async r=>{const response=await window.trellis.request(r as any);if(!response.ok)throw Error(response.error.code);return response.data as any},request)
  await call({type:'model.configure',configuration:{id:'daily',base_url:server.url,wire_model_id:'wire',context_tokens:1000000,max_output_tokens:8192,compatibility_profile:'chat-max-tokens'},api_key:'synthetic',confirm_memory_only:true});await call({type:'model.test',model_id:'daily',role:'main',confirm_cost:true})
  await page.getByRole('button',{name:'创建第一个任务',exact:true}).click();await page.getByLabel('任务名称').fill('Paged daily task');await page.getByRole('button',{name:'创建任务',exact:true}).click()
  const task=(await call({type:'host.tasks'}))[0],snapshot=()=>call({type:'task.snapshot',task_id:task.id});source=await snapshot()
  await call({type:'task.submit',task_id:task.id,text:'Create twelve lessons',model_config_id:'daily',attachments:[]});await expect(page.getByText('DAILY_CREATE_ENDED',{exact:true})).toBeVisible();await expect(page.locator('.managed')).toHaveCount(10)
  await page.getByRole('button',{name:'下一页内容',exact:true}).click();await expect(page.locator('.managed')).toHaveCount(2);await expect(page.getByRole('heading',{name:'Lesson 10',exact:true})).toBeVisible()
  await page.locator('.managed').first().getByLabel('Private answer').fill('PAGE_TWO_SAVED');await page.getByRole('button',{name:'上一页内容',exact:true}).click();await expect(page.locator('.managed')).toHaveCount(10)
  await page.getByRole('button',{name:'下一页内容',exact:true}).click();await expect(page.locator('.managed').first().getByLabel('Private answer')).toHaveValue('PAGE_TWO_SAVED');await page.getByRole('button',{name:'上一页内容',exact:true}).click()
  mode='layout';source=await snapshot();await call({type:'task.submit',task_id:task.id,text:'Reorder lessons',model_config_id:'daily',attachments:[]});await openPending(page);await page.getByRole('button',{name:'批准本次动作',exact:true}).click();await openPending(page);await page.getByRole('button',{name:'保存输入并检查替换',exact:true}).click();await expect(page.getByText('DAILY_LAYOUT_ENDED',{exact:true})).toBeVisible();await expect(page.locator('.managed').first().getByRole('heading')).toHaveText('Lesson 11')
  mode='remove';source=await snapshot();await call({type:'task.submit',task_id:task.id,text:'Remove the first View',model_config_id:'daily',attachments:[]});await openPending(page);await page.getByRole('button',{name:'批准本次动作',exact:true}).click();page.once('dialog',dialog=>dialog.dismiss());await openPending(page);await page.getByRole('button',{name:'保存输入并检查替换',exact:true}).click();await expect(page.getByText('DAILY_REMOVE_ENDED',{exact:true})).toBeVisible();expect((await snapshot()).view_page.total).toBe(12)
  source=await snapshot();await call({type:'task.submit',task_id:task.id,text:'Explicit new request: remove the first View',model_config_id:'daily',attachments:[]});await openPending(page);await page.getByRole('button',{name:'批准本次动作',exact:true}).click();page.once('dialog',dialog=>dialog.accept());await openPending(page);await page.getByRole('button',{name:'保存输入并检查替换',exact:true}).click();await expect.poll(async()=>(await snapshot()).view_page.total).toBe(11);await expect(page.locator('.managed').first().getByRole('heading')).toHaveText('Lesson 10');await expect(page.locator('.managed').first().getByLabel('Private answer')).toHaveValue('PAGE_TWO_SAVED')
  const history=await call({type:'task.query',task_id:task.id,query:{type:'list',input:{kind:'view_history',limit:50}}});expect(history.items).toHaveLength(12)
  const count=server.exchanges.length;await app.close();app=await launch();page=await app.firstWindow();await page.getByRole('button',{name:/Paged daily task/}).click();await expect(page.locator('.managed').first().getByRole('heading')).toHaveText('Lesson 10');await expect(page.locator('.managed').first().getByLabel('Private answer')).toHaveValue('PAGE_TWO_SAVED');expect(server.exchanges).toHaveLength(count)
 }finally{await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.destroy())).catch(()=>{});await app.close().catch(()=>{});await server.close();await rm(root,{recursive:true,force:true})}
})
