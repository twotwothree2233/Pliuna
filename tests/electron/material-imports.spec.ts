import { _electron as electron,expect,test } from '@playwright/test'
import { mkdtemp,rm,writeFile,readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
const electronPath:string=createRequire(import.meta.url)('electron')
for(const scenario of ['text-restart','files-partial-retry','safe-source','markdown-preview','large-text','cancel','unsaved-input','internal-denied','lost-register'] as const)test('isolated material import desktop: '+scenario,async()=>{
 test.setTimeout(60000)
 const root=await mkdtemp(join(tmpdir(),'pliuna-import-desktop-')),data=join(root,'data');let app=await electron.launch({executablePath:electronPath,args:['.'],env:{...process.env,ELECTRON_RUN_AS_NODE:'',PLIUNA_TEST_DATA:data,PLIUNA_ENABLE_VIEW_REPLACEMENT:'1'}}),page=await app.firstWindow();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
 const call=async(r:any):Promise<any>=>{const response=await page.evaluate(r=>window.pliuna.request(r),r);if(!response.ok)throw Error(response.error.code);return response.data}
 const choose=async(paths:string[])=>app.evaluate(({dialog},paths)=>{(dialog as any).showOpenDialog=async()=>({canceled:!paths.length,filePaths:paths})},paths)
 try{
  await page.getByRole('button',{name:'创建第一个任务'}).click();await page.getByLabel('任务名称').fill('导入保留任务');await page.getByRole('button',{name:'创建任务',exact:true}).click();const task=(await call({type:'host.tasks'}))[0].id
  await page.getByRole('tab',{name:'材料',exact:true}).click();const panel=page.getByRole('region',{name:'材料导入'}),ops=panel.getByRole('region',{name:'导入操作'}),resources=panel.getByRole('region',{name:'全部资源分页浏览'}),history=panel.getByRole('button',{name:/^导入记录/});await panel.getByRole('button',{name:'粘贴文本',exact:true}).click()
  if(scenario==='text-restart'){
   await panel.getByLabel('材料名称').fill('人工文本');await panel.getByLabel('添加为材料的文本').fill('IMPORT_TEXT_READY');await panel.getByRole('button',{name:'将文本保存为材料'}).click();await expect(panel.getByLabel('添加为材料的文本')).toHaveValue('');const row=resources.getByRole('button',{name:/人工文本/});await expect(row).toBeVisible();await expect(ops).toHaveCount(0);await row.click();await expect(resources.getByRole('article')).toContainText('IMPORT_TEXT_READY');await history.click();await expect(ops).toContainText('已导入');await expect(resources).toHaveCount(0);await panel.getByRole('button',{name:'材料列表',exact:true}).click();await expect(row).toHaveAttribute('aria-expanded','true');expect((await call({type:'task.snapshot',task_id:task})).runs).toEqual([])
   const old=(await call({type:'material.list',task_id:task})).items[0];await app.close();app=await electron.launch({executablePath:electronPath,args:['.'],env:{...process.env,ELECTRON_RUN_AS_NODE:'',PLIUNA_TEST_DATA:data,PLIUNA_ENABLE_VIEW_REPLACEMENT:'1'}});page=await app.firstWindow();expect(await call({type:'material.status',task_id:task,operation_id:old.operation_id})).toMatchObject({state:'success',resource:old.resource});expect((await call({type:'task.snapshot',task_id:task})).runs).toEqual([])
  }else if(scenario==='files-partial-retry'){
   const good=join(root,'good.txt'),bad=join(root,'missing.txt');await writeFile(good,'GOOD_SOURCE');await choose([good,bad]);await panel.getByRole('button',{name:'选择文件导入',exact:true}).click();await expect(history).toContainText('1 项失败');await history.click();await expect(ops).toContainText('已导入');await expect(ops).toContainText('失败');const original=(await call({type:'material.list',task_id:task})).items,success=original.find((r:any)=>r.state==='success'),failure=original.find((r:any)=>r.state==='failed');await writeFile(bad,'RETRY_SOURCE');await choose([bad]);await ops.locator('.material-operation-toggle').filter({hasText:'missing.txt'}).click();await ops.getByRole('button',{name:'选择来源重试此失败项'}).click();await panel.getByRole('button',{name:'选择文件导入（仅重试此项）'}).click();await expect.poll(async()=>{const r=await call({type:'material.list',task_id:task});return r.items.filter((x:any)=>x.state==='success').length}).toBe(2);const rows=(await call({type:'material.list',task_id:task})).items;expect(rows).toHaveLength(3);expect(rows.find((r:any)=>r.operation_id===success.operation_id).resource.id).toBe(success.resource.id);expect(rows.find((r:any)=>r.retry_of===failure.operation_id).state).toBe('success');expect(await readFile(good,'utf8')).toBe('GOOD_SOURCE')
  }else if(scenario==='markdown-preview'){
   const file = join(root, 'guide.md')
   await writeFile(file, '# 材料导读\n\n- 第一项\n\n```js\nconst answer = 42\n```\n\n<script>window.MATERIAL_EXECUTED=true</script>\n\n![示例图片](https://invalid.example/image.jpg)\n\n[外部链接](https://invalid.example/)\n\n' + '正文。'.repeat(2700) + '\n\n## 结尾标记')
   const external: string[] = []
   page.on('request', request => { if (request.url().startsWith('https://invalid.example')) external.push(request.url()) })
   await choose([file])
   await panel.getByRole('button', { name: '选择文件导入', exact: true }).click()
   await resources.getByRole('button', { name: /guide\.md/ }).click()
   const detail = resources.getByRole('article', { name: '材料详情' }), preview = detail.getByRole('region', { name: '材料正文' })
   await expect(preview.getByRole('heading', { name: '材料导读' })).toBeVisible()
   await expect(preview.getByRole('listitem')).toHaveText('第一项')
   await expect(preview.locator('pre code')).toHaveText('const answer = 42\n')
   await expect(preview).toContainText('<script>')
   await expect(preview.getByRole('img')).toHaveCount(0)
   await expect(preview.getByRole('link')).toHaveCount(0)
   await expect(detail.getByText('只读原记录')).toHaveCount(0)
   await expect(preview.getByRole('heading', { name: '结尾标记' })).toHaveCount(0)
   await preview.getByRole('button', { name: '继续阅读' }).click()
   await expect(preview.getByRole('heading', { name: '结尾标记' })).toBeVisible()
   await detail.getByRole('button', { name: '来源与记录' }).click()
   await expect(preview).toHaveCount(0)
   await expect(detail.getByText('只读原记录')).toBeVisible()
   await detail.getByRole('button', { name: '正文', exact: true }).click()
   await expect(preview.getByRole('heading', { name: '结尾标记' })).toBeVisible()
   expect(await page.evaluate(() => 'MATERIAL_EXECUTED' in window)).toBe(false)
   expect(external).toEqual([])
  }else if(scenario==='safe-source'||scenario==='large-text'){
   const body=scenario==='safe-source'?'<script>window.MATERIAL_EXECUTED=true;fetch("https://invalid.example")</script><img src="https://invalid.example/x">':'字'.repeat(90000),file=join(root,scenario==='safe-source'?'active.html':'long.txt');await writeFile(file,body);const external:string[]=[];page.on('request',request=>{if(request.url().startsWith('https://invalid.example'))external.push(request.url())});await choose([file]);await panel.getByRole('button',{name:'选择文件导入',exact:true}).click();await resources.getByRole('button',{name:scenario==='safe-source'?/active\.html/:/long\.txt/}).click();const detail=resources.getByRole('article');if(scenario==='large-text'){await detail.getByRole('button',{name:'来源与记录'}).click();await detail.getByText('正文分段读取',{exact:true}).click();await detail.getByRole('button',{name:'读取选定正文'}).click();await expect(detail).toContainText('本段字节 [0, 12000)');await detail.getByRole('button',{name:'读取下一段正文'}).click();await expect(detail).toContainText('本段字节 [12000, 24000)')}else{await expect(detail).toContainText('<script>');expect(await page.evaluate(()=>(window as any).MATERIAL_EXECUTED)).toBeUndefined();expect(external).toEqual([])}
  }else if(scenario==='cancel'){
   const file=join(root,'cancel.txt');await writeFile(file,'x'.repeat(1024*1024));await choose([file]);
   await app.evaluate(async()=>{
    const req=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json'),probe=req('electron').utilityProcess.fork(process.cwd()+'/out/main/inspection.js',[process.cwd()]),prototype=Object.getPrototypeOf(probe),original=prototype.postMessage;probe.kill()
    prototype.postMessage=function(value:any,...rest:any[]){if(value?.request?.type==='material.internal.chunk'){setTimeout(()=>original.call(this,value,...rest),1500);return}return original.call(this,value,...rest)}
   })
   await panel.getByRole('button',{name:'选择文件导入',exact:true}).click();await expect(history).toContainText('1 项导入中');await history.click();await ops.locator('.material-operation-toggle').first().click();await expect(ops.getByRole('button',{name:'取消此项导入'})).toBeVisible();await ops.getByRole('button',{name:'取消此项导入'}).click();await expect(ops).toContainText('已取消');await expect(history).not.toContainText('项导入中');await page.waitForTimeout(1700);const rows=(await call({type:'material.list',task_id:task})).items;expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({state:'cancelled',resource:null});expect((await call({type:'task.query',task_id:task,query:{type:'list',input:{kind:'resource'}}})).items).toEqual([])

  }else if(scenario==='unsaved-input'){
   await panel.getByLabel('添加为材料的文本').fill('不要丢失的文本');await page.getByRole('tab',{name:/内容/}).click();await expect(panel).toBeVisible();await expect(panel.getByLabel('添加为材料的文本')).toHaveValue('不要丢失的文本');await panel.getByRole('button',{name:'丢弃未导入文本'}).click();await page.getByRole('dialog',{name:'丢弃未导入文本'}).getByRole('button',{name:'取消',exact:true}).click();await expect(panel.getByLabel('添加为材料的文本')).toHaveValue('不要丢失的文本');await panel.getByRole('button',{name:'丢弃未导入文本'}).click();await page.getByRole('dialog',{name:'丢弃未导入文本'}).getByRole('button',{name:'确认丢弃',exact:true}).click();await expect(panel.getByLabel('添加为材料的文本')).toHaveValue('')
  }else if(scenario==='internal-denied'){
   const response=await page.evaluate(task=>window.pliuna.request({type:'material.internal.register',task_id:task,items:[{display_name:'forged',source:'file'}]}),task);expect(response).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});await choose([]);await panel.getByRole('button',{name:'选择文件导入',exact:true}).click();expect((await call({type:'material.list',task_id:task})).items).toEqual([]);await panel.getByLabel('添加为材料的文本').fill('AFTER_NATIVE_CANCEL');await panel.getByRole('button',{name:'将文本保存为材料'}).click();await expect(resources.getByRole('button',{name:/文本材料/})).toBeVisible()
  }else{
   await app.evaluate(({ipcMain})=>{const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get('pliuna:request');handlers.set('pliuna:request',async(event:any,r:any)=>{const response=await original(event,r);return r.type==='material.text'&&response.ok?{ok:false,error:{code:'UNKNOWN_RESULT',message:'isolated lost response'}}:response})});await panel.getByLabel('添加为材料的文本').fill('UNKNOWN_RESULT_KEEP');await panel.getByRole('button',{name:'将文本保存为材料'}).click();await expect(panel).toContainText('注册结果未知');await expect(panel.getByLabel('添加为材料的文本')).toHaveValue('UNKNOWN_RESULT_KEEP');await expect(panel.getByRole('button',{name:'将文本保存为材料'})).toBeDisabled();await expect(ops).toContainText('已导入');expect((await call({type:'material.list',task_id:task})).items).toHaveLength(1)
  }
  expect(errors).toEqual([])
 }finally{await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.destroy()}).catch(()=>{});await app.close();await rm(root,{recursive:true,force:true})}
})

test('material discard uses explicit in-app confirmation without browser dialog automation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pliuna-material-discard-'));const app=await electron.launch({executablePath:electronPath,args:['.'],env:{...process.env,ELECTRON_RUN_AS_NODE:'',ELECTRON_RENDERER_URL:'',PLIUNA_TEST_DATA:root}})
 try{const page=await app.firstWindow();await page.getByRole('button',{name:'创建第一个任务'}).click();await page.getByLabel('任务名称').fill('丢弃确认回归');await page.getByRole('button',{name:'创建任务',exact:true}).click();await page.getByRole('tab',{name:'材料',exact:true}).click();await page.getByRole('button',{name:'粘贴文本',exact:true}).click();const input=page.getByLabel('添加为材料的文本');await input.fill('确认前必须保留');await page.getByRole('tab',{name:/内容/}).click();await expect(input).toHaveValue('确认前必须保留');await page.getByRole('button',{name:'丢弃未导入文本'}).click();const dialog=page.getByRole('dialog',{name:'丢弃未导入文本'});await expect(dialog).toBeVisible({timeout:2000});await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(input).toHaveValue('确认前必须保留');await page.getByRole('button',{name:'丢弃未导入文本'}).click();await dialog.getByRole('button',{name:'确认丢弃',exact:true}).click();await expect(input).toHaveValue('');await page.waitForTimeout(1200);await expect(input).toHaveValue('');await page.getByRole('tab',{name:/内容/}).click();await expect(page.getByRole('region',{name:'材料导入'})).toHaveCount(0);const r=await page.evaluate(()=>window.pliuna.request({type:'host.tasks'}));expect(r.ok).toBe(true)
 }finally{await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.destroy()}).catch(()=>{});await app.close();await rm(root,{recursive:true,force:true})}
})

test('deleting a material excludes it from new requests and preserves existing references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pliuna-material-delete-'))
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: join(root, 'data'), PLIUNA_WEB: '' } })
  let app = await launch(), page = await app.firstWindow()
  const request = (input: import('../../src/shared/types').HostRequest) => page.evaluate(input => window.pliuna.request(input), input)
  async function call<T>(input: import('../../src/shared/types').HostRequest) {
    const result = await request(input)
    if (!result.ok) throw Error(result.error.code)
    return result.data as T
  }
  try {
    await page.getByRole('button', { name: '创建第一个任务' }).click()
    await page.getByLabel('任务名称').fill('材料删除验收')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const task_id = (await call<{ id: string }[]>({ type: 'host.tasks' }))[0]!.id
    const source = join(root, '待删.txt'), kept = join(root, '保留.txt')
    await Promise.all([writeFile(source, 'HISTORICAL MATERIAL'), writeFile(kept, 'ACTIVE MATERIAL')])
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }) }, [source, kept])
    await page.getByRole('tab', { name: '材料', exact: true }).click()
    await page.getByRole('button', { name: '选择文件导入', exact: true }).click()
    const row = page.getByRole('group', { name: '待删.txt', exact: true })
    await expect(row).toBeVisible()
    await expect(page.getByRole('group', { name: '保留.txt', exact: true })).toBeVisible()
    const sources = () => call<{ items: { id: string; display_name: string }[] }>({ type: 'task.query', task_id, query: { type: 'list', input: { kind: 'resource' } } })
    const textNames = async () => (await sources()).items.map(value => value.display_name).filter(name => name.endsWith('.txt'))
    const imports = await call<{ items: { operation_id: string; resource: { id: string }; display_name: string }[] }>({ type: 'material.list', task_id })
    const item = imports.items.find(row => row.display_name === '待删.txt')!
    const resource_id = item.resource.id
    const remove = { type: 'material.delete', task_id, resource_id, confirm: true } as const
    const submit = { type: 'request.submit' as const, task_id, text: '材料范围验收', model_config_id: 'fixture', resource_ids: [], import_ids: [] }
    const before = await call<{ request_id: string; materials: { id: string }[] }>(submit)
    expect(before.materials.map(value => value.id)).toContain(resource_id)

    await row.getByRole('button', { name: /待删\.txt/ }).click()
    await expect(page.getByRole('region', { name: '材料正文' })).toContainText('HISTORICAL MATERIAL')
    await row.getByRole('button', { name: '删除', exact: true }).click()
    const confirm = page.getByRole('dialog', { name: '删除材料' })
    await expect(confirm.getByText('待删.txt', { exact: true })).toBeVisible()
    await confirm.getByRole('button', { name: '取消', exact: true }).click()
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: '删除', exact: true }).click()
    await confirm.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(row).toHaveCount(0)
    await expect(page.getByRole('region', { name: '材料正文' })).toHaveCount(0)
    expect(await readFile(source, 'utf8')).toBe('HISTORICAL MATERIAL')
    expect(await textNames()).toEqual(['保留.txt'])
    const original = await call<{ materials: { id: string }[] }>({ type: 'request.status', task_id, request_id: before.request_id })
    expect(original.materials.map(value => value.id)).toContain(resource_id)
    expect((await call<{ materials: { display_name: string }[] }>(submit)).materials.map(value => value.display_name)).toEqual(['保留.txt'])
    await expect(page.getByRole('button', { name: /导入记录/ })).toBeVisible()
    await page.getByRole('button', { name: /导入记录/ }).click()
    await expect(page.getByRole('region', { name: '导入操作' }).getByRole('button', { name: /待删\.txt.*已删除/ })).toBeVisible()

    expect(await request({ ...submit, resource_ids: [resource_id] })).toMatchObject({ ok: false, error: { code: 'REQUEST_MATERIAL_REMOVED' } })
    expect(await request({ ...submit, import_ids: [item.operation_id] })).toMatchObject({ ok: false, error: { code: 'REQUEST_MATERIAL_REMOVED' } })
    expect(await call(remove)).toMatchObject({ removed: true })
    const other = await call<{ task: { id: string } }>({ type: 'task.create', title: '另一任务' })
    expect(await request({ ...remove, task_id: other.task.id })).toMatchObject({ ok: false, error: { code: 'IMPORT_NOT_FOUND' } })

    await app.close(); app = await launch(); page = await app.firstWindow()
    expect(await textNames()).toEqual(['保留.txt'])
    expect(await call({ type: 'material.read', task_id, resource_id })).toMatchObject({ text: 'HISTORICAL MATERIAL' })
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {})
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
