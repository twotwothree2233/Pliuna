import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
const electronPath:string=createRequire(import.meta.url)('electron')
const executablePath=process.env.PLIUNA_CANDIDATE_EXECUTABLE||electronPath
const args=process.env.PLIUNA_CANDIDATE_EXECUTABLE?[]:['.']

// Injection wraps the real built worker outside the app; production IPC stays unchanged.
for(const scenario of ['backup-1','backup-2','backup-failure','publish-failure','renderer-gone'] as const) test(`accepted recovery shutdown barrier: ${scenario}`,async()=>{
  test.setTimeout(45000)
  const work=await mkdtemp(join(tmpdir(),'pliuna-p2-electron-')),root=join(work,'runtime'),release=join(work,'release'),wrapper=join(work,'wrapper.cjs')
  const app=await electron.launch({executablePath,args,env:{...process.env,NODE_OPTIONS:'',ELECTRON_RUN_AS_NODE:'',ELECTRON_RENDERER_URL:'',PLIUNA_TEST_DATA:join(work,'app')}})
  const runtime=await app.evaluate(({app})=>app.getAppPath()+'/out/main/runtime.js')
  const source=`const {createRequire}=require('node:module');const {existsSync}=require('node:fs');
const Database=createRequire(${JSON.stringify(runtime)})('better-sqlite3');const backup=Database.prototype.backup;let count=0;
Database.prototype.backup=async function(...args){if(++count===${scenario==='backup-2'?3:2}){process.parentPort.postMessage({paused:true});while(!existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,10));${scenario.endsWith('failure')?'throw Error("synthetic backup failure");':''}}return backup.apply(this,args)};
import(${JSON.stringify(runtime)});`
  await writeFile(wrapper,source)
  const start=()=>app.evaluate(({utilityProcess},{wrapper,root})=>{
    const state:any={events:[],pending:new Map(),next:0,paused:false,exited:false}
    const child=utilityProcess.fork(wrapper,[root,process.execPath],{stdio:'pipe',serviceName:'Pliuna isolated recovery test'})
    state.request=(request:any,shutdown=false)=>new Promise(resolve=>{const id=String(++state.next);state.pending.set(id,resolve);child.postMessage(shutdown?{id,shutdown:true}:{id,request})})
    child.on('message',(message:any)=>{
      if(message.vault){child.postMessage({vault_response:message.id,ok:true,data:message.vault==='load'?[]:undefined});return}
      if(message.paused){state.paused=true;return}
      const done=state.pending.get(message.id);if(done){state.pending.delete(message.id);done(message.response)}
    })
    child.on('exit',()=>{state.exited=true});state.child=child;(globalThis as any).__recoveryTest=state
  },{wrapper,root})
  const request=(r:any)=>app.evaluate(async(_electron,r)=>{const result:any=await (globalThis as any).__recoveryTest.request(r);if(!result.ok)throw Error(result.error.code);return result.data},r)
  try{
    await start()
    const task=(await request({type:'task.create',title:'P2 synthetic recovery'})).task.id
    const token=(await request({type:'maintenance.begin'})).reservation.token
    const active=(await request({type:'maintenance.create',token,inputs_saved:true,replace_id:null})).active
    const next=(await request({type:'maintenance.begin'})).reservation.token
    const operation=scenario==='publish-failure'?{type:'maintenance.create',token:next,inputs_saved:true,replace_id:active.id}:{type:'maintenance.restore',token:next,point_id:active.id,database_sha256:active.database_sha256,inputs_saved:true,confirm_replace_newer_data:true}
    await app.evaluate((_electron,operation)=>{const s=(globalThis as any).__recoveryTest;s.operation=s.request(operation).then((r:any)=>{s.events.push('operation');s.result=r});},operation)
    await expect.poll(()=>app.evaluate(()=>(globalThis as any).__recoveryTest.paused)).toBe(true)
    if(scenario==='renderer-gone')await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer()})
    await app.evaluate(()=>{const s=(globalThis as any).__recoveryTest;s.shutdown=s.request(null,true).then((r:any)=>{s.events.push('closed');s.closed=r})})
    expect(await app.evaluate(async()=>{await new Promise(r=>setTimeout(r,100));const s=(globalThis as any).__recoveryTest;return {events:s.events,exited:s.exited}})).toEqual({events:[],exited:false})
    await writeFile(release,'release')
    await expect.poll(()=>app.evaluate(()=>(globalThis as any).__recoveryTest.events)).toEqual(['operation','closed'])
    const facts=await app.evaluate(()=>{const s=(globalThis as any).__recoveryTest;return {result:s.result,closed:s.closed}})
    expect(facts.closed).toEqual({ok:true,data:{closed:true}})
    if(scenario.endsWith('failure'))expect(facts.result).toMatchObject({ok:false,error:{code:scenario==='publish-failure'?'RECOVERY_CREATE_FAILED':'RESTORE_FAILED'}})
    else expect(facts.result.ok).toBe(true)
    await app.evaluate(()=>{(globalThis as any).__recoveryTest.child.kill()})
    await expect.poll(()=>app.evaluate(()=>(globalThis as any).__recoveryTest.exited)).toBe(true)
    await start()
    const status=await request({type:'maintenance.status'}),snapshot=await request({type:'task.snapshot',task_id:task})
    expect(snapshot.task.title).toBe('P2 synthetic recovery');expect(snapshot.runs).toEqual([])
    expect(status.active.id).toBe(active.id)
    if(scenario!=='publish-failure')expect(status.restore.last.phase).toBe(scenario==='backup-failure'?'rolled_back':'completed')
    const shutdown=await app.evaluate(()=>(globalThis as any).__recoveryTest.request(null,true))
    expect(shutdown).toEqual({ok:true,data:{closed:true}})
    await writeFile(join(work,'evidence.json'),JSON.stringify({scenario,facts,status,run_count:snapshot.runs.length},null,2))
    expect(await readFile(release,'utf8')).toBe('release')
  }finally{
    await writeFile(release,'release')
    await app.evaluate(async()=>{const s=(globalThis as any).__recoveryTest;if(s&&!s.exited){await s.request(null,true);s.child.kill()}}).catch(()=>{})
    await app.close()
  }
})

test('ordinary app quit drains accepted restore after renderer loss and restarts without replay',async()=>{
  test.setTimeout(60000)
  const work=await mkdtemp(join(tmpdir(),'pliuna-p2-app-')),root=join(work,'profile'),release=join(work,'release'),paused=join(work,'paused'),events=join(work,'events'),wrapper=join(work,'wrapper.cjs')
  const launch=()=>electron.launch({executablePath,args,env:{...process.env,NODE_OPTIONS:'',ELECTRON_RUN_AS_NODE:'',ELECTRON_RENDERER_URL:'',PLIUNA_TEST_DATA:root}})
  let app=await launch(),page=await app.firstWindow(),exited=false
  const request=async(r:any)=>{const result=await page.evaluate(r=>window.pliuna.request(r),r);if(!result.ok)throw Error(result.error.code);return result.data as any}
  try{
    const task=(await request({type:'task.create',title:'P2 application lifecycle'})).task.id
    await request({type:'request.submit',task_id:task,text:'synthetic fixture',model_config_id:'fixture',resource_ids:[],import_ids:[]})
    await page.getByRole('button',{name:/P2 application lifecycle/}).click()
    await expect(page.locator('.agent-status')).toContainText('已完成')
    await page.getByLabel('你的想法').fill('P2_RESTART_PRESERVED')
    await expect(page.locator('.managed').getByRole('status')).toHaveText('已保存')
    const token=(await request({type:'maintenance.begin'})).reservation.token
    const point=(await request({type:'maintenance.create',token,inputs_saved:true,replace_id:null})).active
    const runtime=await app.evaluate(({app})=>app.getAppPath()+'/out/main/runtime.js')
    await writeFile(wrapper,`const {createRequire}=require('node:module');const fs=require('node:fs');const Database=createRequire(${JSON.stringify(runtime)})('better-sqlite3');const backup=Database.prototype.backup;let once=false;Database.prototype.backup=async function(...args){if(!once){once=true;fs.writeFileSync(${JSON.stringify(paused)},'paused');while(!fs.existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,10))}return backup.apply(this,args)};import(${JSON.stringify(runtime)});`)
    await app.evaluate(({app,utilityProcess},{wrapper,events})=>{
      const fs=process.getBuiltinModule('fs'),fork=utilityProcess.fork.bind(utilityProcess)
      utilityProcess.fork=((file:string,argv:string[],options:any)=>{
        const child=fork(file.endsWith('/runtime.js')?wrapper:file,argv,options)
        if(file.endsWith('/runtime.js'))child.on('message',(m:any)=>{if(m.response&&!m.vault)fs.appendFileSync(events,JSON.stringify({id:m.id,response:m.response})+'\n')})
        return child
      }) as any
      const runtime=app.getAppMetrics().find((m:any)=>m.name==='Pliuna Runtime')
      if(!runtime)throw Error('Synthetic runtime missing')
      process.kill(runtime.pid,'SIGTERM')
    },{wrapper,events})
    await expect.poll(async()=>{try{return (await request({type:'task.snapshot',task_id:task})).task.id}catch{return null}},{timeout:10000}).toBe(task)
    const next=(await request({type:'maintenance.begin'})).reservation.token
    await page.evaluate((r:any)=>{void window.pliuna.request(r)}, {type:'maintenance.restore',token:next,point_id:point.id,database_sha256:point.database_sha256,inputs_saved:true,confirm_replace_newer_data:true})
    await expect.poll(()=>readFile(paused,'utf8').catch(()=>'' )).toBe('paused')
    app.on('close',()=>{exited=true})
    await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer()})
    await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.webContents.isCrashed())).toBe(true)
    await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0]!.destroy()})
    await new Promise(r=>setTimeout(r,150));expect(exited).toBe(false)
    const before=(await readFile(events,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
    expect(before.some(m=>m.response?.data?.closed)).toBe(false)
    await writeFile(release,'release')
    await expect.poll(()=>exited,{timeout:10000}).toBe(true)
    const messages=(await readFile(events,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
    const restoreIndex=messages.findIndex(m=>m.response?.data?.restore?.last?.phase==='completed'),closedIndex=messages.findIndex(m=>m.response?.data?.closed===true)
    expect(restoreIndex).toBeGreaterThanOrEqual(0);expect(closedIndex).toBeGreaterThan(restoreIndex)
    app=await launch();page=await app.firstWindow()
    await page.getByRole('button',{name:/P2 application lifecycle/}).click()
    await expect(page.getByLabel('你的想法')).toHaveValue('P2_RESTART_PRESERVED')
    const snapshot=await request({type:'task.snapshot',task_id:task})
    expect(snapshot.runs).toHaveLength(1);expect(snapshot.runs[0].state).toBe('completed')
    expect((await request({type:'maintenance.status'})).restore.last.phase).toBe('completed')
    await writeFile(join(work,'evidence.json'),JSON.stringify({restoreIndex,closedIndex,run_count:snapshot.runs.length,draft:snapshot.views[0].draft},null,2))
  }finally{await writeFile(release,'release');await app.close().catch(()=>{})}
})
