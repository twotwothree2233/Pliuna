import { chooseModel, openSettings } from '../helpers/settings-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
const electronPath: string = createRequire(import.meta.url)('electron')
for(const scenario of ['growth','damaged-resource','cancel','blocked-control','paged-summary','responsive'] as const)test('isolated read-only storage inspection desktop: '+scenario,async()=>{
  test.setTimeout(60000)
  const directory=await mkdtemp(join(tmpdir(),'pliuna-inspection-desktop-'))
  const launch=()=>electron.launch({executablePath:electronPath,args:['.'],env:{...process.env,ELECTRON_RUN_AS_NODE:'',PLIUNA_TEST_DATA:directory,PLIUNA_ENABLE_VIEW_REPLACEMENT:'1'}})
  let app=await launch(),page=await app.firstWindow();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
  const call=async(request:any):Promise<any>=>{const r=await page.evaluate(request=>window.pliuna.request(request),request);if(!r.ok)throw Error(r.error.code);return r.data}
  const inspect=()=>app.evaluate((_electron,root)=>{const Database=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('better-sqlite3'),files=['pliuna.sqlite','restore-control.sqlite','recovery-control.sqlite','gc-control.sqlite'];return JSON.stringify(files.map(file=>{const db=new Database(root+'/'+file,{readonly:true});try{return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r:any)=>[r.name,db.prepare('SELECT * FROM '+r.name).all()])}finally{db.close()}}))},directory)
  try{
    await page.getByRole('button',{name:'创建第一个任务'}).click();await page.getByLabel('任务名称').fill('只读诊断保留任务');await page.getByRole('button',{name:'创建任务',exact:true}).click();await chooseModel(page, 'fixture');await page.getByLabel('想从哪里开始？').fill('正常发布');await page.getByRole('button',{name:/发送 · 新 Run/}).click();await expect(page.locator('.managed')).toHaveCount(1);await expect(page.locator('.agent-status')).toContainText('已完成');await page.getByLabel('你的想法').fill('诊断不能改动的草稿');await expect(page.locator('.managed').getByRole('status')).toHaveText('已保存')
    const tasks=await call({type:'host.tasks'}),resource=(await call({type:'task.query',task_id:tasks[0].id,query:{type:'list',input:{kind:'resource',limit:50}}})).items[0].id
    if(scenario==='paged-summary'){
      for(let i=0;i<23;i++){const t=await call({type:'task.create',title:'source'+i});await app.evaluate((_electron,{root,task})=>{const req=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json'),Database=req('better-sqlite3'),crypto=req('node:crypto'),fs=req('node:fs'),db=new Database(root+'/pliuna.sqlite'),id=crypto.randomUUID();db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(id,id,crypto.createHash('sha256').update('x').digest('hex'),1,'text/plain','分页候选','now');db.prepare('INSERT INTO task_resources VALUES (?,?)').run(task,id);fs.writeFileSync(root+'/resources/'+id,'x');db.close()},{root:directory,task:t.task.id});await call({type:'task.delete',task_id:t.task.id})}
    }
    if(scenario==='damaged-resource')await writeFile(join(directory,'resources',resource),'broken')
    if(scenario==='blocked-control'){await test.step('Close before controlled corruption',()=>app.close());await test.step('Corrupt isolated control file',()=>writeFile(join(directory,'restore-control.sqlite'),'damaged control'));app=await test.step('Restart with damaged isolated control',()=>launch());page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message))}
    const before=scenario==='blocked-control'?null:await inspect(),controlBefore=await readFile(join(directory,'restore-control.sqlite'))
    await openSettings(page, '存储与恢复');const panel=page.getByRole('dialog',{name:'应用设置',exact:true}),region=panel.getByRole('region',{name:'只读诊断与增长'})
    if(scenario==='paged-summary'){
      const candidates=panel.getByRole('region',{name:'正式资源删除收尾'});await expect(candidates.locator('article')).toHaveCount(20);await expect(candidates).toContainText('尚未核验保护与文件');await candidates.getByRole('button',{name:'查看更早资源收尾'}).click();await expect(candidates.locator('article')).toHaveCount(3)
    }else if(scenario==='cancel'||scenario==='responsive'){
      // Deterministic delayed isolated worker result: core streaming cancellation and file changes have real unit coverage.
      await app.evaluate(({utilityProcess})=>{const original=utilityProcess.fork;(utilityProcess as any).fork=function(...args:any[]){const child=Reflect.apply(original,utilityProcess,args);if(String(args[0]).endsWith('inspection.js')){const emit=child.emit;child.emit=function(event:any,...values:any[]){if(event==='message'&&values[0]?.result){setTimeout(()=>Reflect.apply(emit,child,[event,...values]),2000);return true}return Reflect.apply(emit,child,[event,...values])}}return child}})
      await region.getByRole('button',{name:'只读核验资源首批'}).click();await expect(region.getByRole('button',{name:'取消只读检查'})).toBeVisible()
      if(scenario==='cancel'){await region.getByRole('button',{name:'取消只读检查'}).click();await expect(region).toContainText('INSPECT_CANCELLED')}
      else {await page.getByLabel('诊断资源 ID').fill(resource);await expect(page.getByLabel('诊断资源 ID')).toHaveValue(resource);await expect(region).toContainText('本次范围检查完成')}
    }else{
      if(scenario==='damaged-resource'){await region.getByLabel('诊断资源 ID').fill(resource);await region.getByRole('button',{name:'只读诊断此资源'}).click();await expect(region).toContainText('INSPECT_LENGTH_MISMATCH');await expect(region).toContainText('anomaly');expect((await readFile(join(directory,'resources',resource))).toString()).toBe('broken')}
      else {await region.getByRole('button',{name:'检查控制清单增长'}).click();await expect(region).toContainText(scenario==='blocked-control'?'未完成，不能推断健康或无保护':'独立控制记录（只增不裁剪）');if(scenario==='blocked-control')await expect(region).toContainText('INSPECT_UNAVAILABLE');else await expect(region).toContainText('控制格式 5')}
    }
    expect(await readFile(join(directory,'restore-control.sqlite'))).toEqual(controlBefore);if(before)expect(await inspect()).toBe(before)
    await panel.getByRole('button',{name:/^返回工作区/}).click();if(scenario!=='blocked-control')await expect(page.getByLabel('你的想法')).toHaveValue('诊断不能改动的草稿');expect(errors).toEqual([])
  }finally{await test.step('Close isolated inspection application',async()=>{await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.destroy()}).catch(()=>{});await app.close();await rm(directory,{recursive:true,force:true})})}
})
