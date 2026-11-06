import { chooseModel, openSettings } from '../helpers/settings-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
const electronPath: string = createRequire(import.meta.url)('electron')
for (const scenario of ['confirm', 'cancel', 'input-conflict', 'response-lost', 'persisted-retry', 'shared', 'recovery-protected', 'active-run'] as const) test('isolated formal resource cleanup desktop: ' + scenario, async () => {
  test.setTimeout(60000)
  const directory = await mkdtemp(join(tmpdir(), 'trellis-resource-desktop-'))
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', TRELLIS_TEST_DATA: directory, TRELLIS_ENABLE_VIEW_REPLACEMENT: '1' } })
  let app = await launch(), page = await app.firstWindow()
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  const call = async (request: any): Promise<any> => { const response = await page.evaluate(request => window.trellis.request(request), request); if (!response.ok) throw new Error(response.error.code); return response.data }
  const begin = async (): Promise<string> => (await call({ type: 'maintenance.begin' })).reservation.token
  async function inspect(): Promise<any> {
    return app.evaluate((_electron, root) => {
      const Database = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('better-sqlite3'), control = new Database(root + '/restore-control.sqlite')
      const journal = JSON.parse(control.prepare('SELECT manifest FROM restore_control').get().manifest); control.close(); const db = new Database(root + '/' + journal.selected)
      try { return { journal, drafts: db.prepare('SELECT id,draft_json FROM views').all(), runs: db.prepare('SELECT id,state FROM runs').all(), answers: db.prepare('SELECT count(*) n FROM answers').get().n } } finally { db.close() }
    }, directory)
  }
  try {
    await page.getByRole('button', { name: '创建第一个任务' }).click(); await page.getByLabel('任务名称').fill('保留的View任务'); await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await chooseModel(page, 'fixture'); await page.getByLabel('想从哪里开始？').fill('正常发布'); await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
    await expect(page.locator('.managed')).toHaveCount(1); await expect(page.locator('.agent-status')).toContainText('已完成')
    await page.getByLabel('你的想法').fill('保留的草稿'); await expect(page.locator('.managed').getByRole('status')).toHaveText('已保存'); await page.getByRole('button', { name: '提交答案', exact: true }).click(); await expect(page.locator('.managed').getByRole('status')).toContainText('提交成功')
    const keep = (await call({ type: 'host.tasks' }))[0].id, before = await inspect(), files = await readdir(join(directory, 'resources')), bytes = await Promise.all(files.map(f => readFile(join(directory, 'resources', f))))
    const source = await call({ type: 'task.create', title: '即将删除的材料任务' })
    const material = await app.evaluate((_electron, { root, task, keep, shared }) => {
      const req = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json'), Database = req('better-sqlite3'), fs = req('node:fs'), crypto = req('node:crypto'), db = new Database(root + '/trellis.sqlite'), id = crypto.randomUUID(), body = Buffer.from('DESKTOP_RESOURCE_3D3')
      try { db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(id,id,crypto.createHash('sha256').update(body).digest('hex'),body.length,'text/plain','隔离收尾材料','now'); db.prepare('INSERT INTO task_resources VALUES (?,?)').run(task,id); if(shared)db.prepare('INSERT INTO task_resources VALUES (?,?)').run(keep,id); fs.writeFileSync(root+'/resources/'+id,body); return id } finally { db.close() }
    }, { root: directory, task: source.task.id, keep, shared: scenario === 'shared' || scenario === 'recovery-protected' })
    await call({ type: 'task.delete', task_id: source.task.id })
    let point: any
    if (scenario === 'recovery-protected') {
      point = (await call({ type: 'maintenance.create', token: await begin(), inputs_saved: true, replace_id: null })).active
      await app.evaluate((_electron, { root, material }) => { const Database=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('better-sqlite3'),db=new Database(root+'/trellis.sqlite');db.prepare('DELETE FROM task_resources WHERE resource_id=?').run(material);db.close() }, { root: directory, material })
    }
    const op = (await call({ type: 'maintenance.resource.list' })).items[0]; expect(op.resource_id).toBe(material)
    if (scenario === 'persisted-retry') {
      const token = await begin(); await call({ type: 'maintenance.resource.preview', token, operation_id: op.id, inputs_saved: true }); await call({ type: 'maintenance.cancel', token })
      // Persisted UI fixture only; real unlink/flush/control failures are independently unit/SIGKILL tested.
      await app.evaluate((_electron, { root, id }) => {
        const Database=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('better-sqlite3'),db=new Database(root+'/restore-control.sqlite'),v=JSON.parse(db.prepare('SELECT manifest FROM restore_control').get().manifest),r=v.resource_cleanups.find((r:any)=>r.id===id)
        r.identity=r.preview.identity;r.selected=r.preview.selected;r.preview=null;r.phase='deleting';r.attempt=1;r.reason='EBUSY';r.next_retry_at='2000-01-01T00:00:00.000Z';db.prepare('UPDATE restore_control SET manifest=?').run(JSON.stringify(v));db.close()
      }, { root: directory, id: op.id })
      await app.close();app=await launch();page=await app.firstWindow();await page.getByRole('button',{name:/保留的View任务/}).click()
    }
    if(scenario==='response-lost')await app.evaluate(({ipcMain})=>{const original=(ipcMain as any)._invokeHandlers.get('trellis:request');let lost=false;ipcMain.removeHandler('trellis:request');ipcMain.handle('trellis:request',async(event,request)=>{const result=await original(event,request);if(!lost&&request?.type==='maintenance.resource.execute'&&result.ok){lost=true;return{ok:false,error:{code:'UNKNOWN_RESULT',message:'Isolated response loss'}}}return result})})
    if(scenario==='active-run'){
      const started=await call({type:'task.submit',task_id:keep,text:'held fixture',model_config_id:'fixture',attachments:[]}),blocked=await page.evaluate(()=>window.trellis.request({type:'maintenance.begin'}));expect(blocked.ok).toBe(false);if(!blocked.ok)expect(blocked.error.code).toBe('MAINTENANCE_EXECUTION_ACTIVE');await call({type:'run.cancel',task_id:keep,run_id:started.run_id})
    }
    await page.getByLabel('想从哪里开始？').fill('不能自动发送的消息');await openSettings(page, '存储与恢复')
    const panel=page.getByRole('dialog',{name:'应用设置',exact:true}),section=panel.getByRole('region',{name:'正式资源删除收尾'}),collect=section.getByRole('button',{name:'核验并回收此正式资源',exact:true})
    if(['shared','recovery-protected'].includes(scenario)){await expect(collect).toBeEnabled();await expect(section).toContainText('尚未核验保护与文件');await collect.click();await expect(panel.getByRole('alert').last()).toContainText(scenario==='shared'?'TASK_ASSOCIATION':'VIEW_HISTORY_OR_RECOVERY');expect((await call({type:'maintenance.resource.status',operation_id:op.id})).phase).toBe('candidate');if(point)expect((await call({type:'maintenance.status'})).active.id).toBe(point.id)}
    else if(scenario==='input-conflict'){
      await expect(collect).toBeEnabled()
      await app.evaluate((_electron,root)=>{const Database=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('better-sqlite3'),db=new Database(root+'/trellis.sqlite');db.exec('UPDATE views SET state_revision=state_revision+1');db.close()},directory)
      await page.getByLabel('你的想法').evaluate(inputElement=>{const input=inputElement as HTMLTextAreaElement;input.value='必须保留的冲突输入';input.dispatchEvent(new Event('input',{bubbles:true}));Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent==='核验并回收此正式资源')!.click()})
      await expect(panel.getByRole('alert').last()).toContainText('VERSION_CONFLICT');expect((await inspect()).journal.resource_cleanups[0].phase).toBe('candidate');await expect(page.getByLabel('你的想法')).toHaveValue('必须保留的冲突输入')
      await panel.getByRole('button',{name:/^返回工作区/}).click();const dialog=page.waitForEvent('dialog');const discard=page.getByRole('button',{name:'放弃本地输入并重新加载',exact:true}).click();await (await dialog).accept();await discard;await expect(page.getByLabel('你的想法')).toHaveValue('保留的草稿')
    }else if(scenario!=='active-run'){
      const button=scenario==='persisted-retry'?section.getByRole('button',{name:'重试原资源未完成收尾',exact:true}):collect
      await expect(button).toBeEnabled();let message='';page.once('dialog',async d=>{message=d.message();if(scenario==='cancel')await d.dismiss();else await d.accept()});await button.click();await expect(panel.getByRole('button',{name:/^返回工作区/})).toBeEnabled();expect(message).toContain('正式资源');expect(message).toContain('元数据')
      if(scenario==='cancel'){expect((await inspect()).journal.resource_cleanups[0].phase).toBe('candidate');expect((await readdir(join(directory,'resources')))).toContain(material)}else{await expect(section).toContainText('元数据收尾完成');await section.getByRole('button',{name:'查询原资源收尾',exact:true}).click();expect((await call({type:'maintenance.resource.status',operation_id:op.id})).phase).toBe('complete');await app.close();app=await launch();page=await app.firstWindow();expect((await call({type:'maintenance.resource.status',operation_id:op.id})).phase).toBe('complete');await page.getByRole('button',{name:/保留的View任务/}).click();await expect(page.getByLabel('你的想法')).toHaveValue('保留的草稿')}
    }
    const after=await inspect();expect(after.drafts).toEqual(before.drafts);expect(after.answers).toBe(before.answers);if(scenario!=='active-run')expect(after.runs).toEqual(before.runs)
    for(let i=0;i<files.length;i++)expect(await readFile(join(directory,'resources',files[i]!))).toEqual(bytes[i]);expect(errors).toEqual([])
  }finally{await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.destroy()}).catch(()=>{});await app.close();await rm(directory,{recursive:true,force:true})}
})
