import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { ServerResponse } from 'node:http'
import { frame, modelInputFromHost, modelServer, synthetic } from '../helpers/model-server'
const require = createRequire(import.meta.url), electronPath: string = require('electron')
const repairedPath = process.env.PLIUNA_CANDIDATE_EXECUTABLE || electronPath
const repairedArgs = process.env.PLIUNA_CANDIDATE_EXECUTABLE ? [] : ['.']

async function sample():Promise<any> {
  const work=await mkdtemp(join(tmpdir(),'pliuna-review-seed-')),entry=join(work,'entry.ts'),output=join(work,'seed.cjs')
  await writeFile(entry,`import {reviewRepairSample} from ${JSON.stringify(resolve('tests/helpers/review-repair-sample.ts'))};reviewRepairSample().then(value=>console.log(JSON.stringify(value)))`)
  const esbuild=createRequire(require.resolve('vite'))('esbuild')
  await esbuild.build({entryPoints:[entry],outfile:output,bundle:true,platform:'node',format:'cjs',packages:'external',plugins:[{name:'raw',setup(build:any){build.onResolve({filter:/\?raw$/},(args:any)=>({path:resolve(args.resolveDir,args.path.slice(0,-4)),namespace:'raw'}));build.onLoad({filter:/.*/,namespace:'raw'},async(args:any)=>({contents:await readFile(args.path,'utf8'),loader:'text'}))}}],logLevel:'silent'})
  return JSON.parse(execFileSync(electronPath,[output],{env:{...process.env,NODE_OPTIONS:'',ELECTRON_RUN_AS_NODE:'1',NODE_PATH:join(process.cwd(),'node_modules')},encoding:'utf8',timeout:30000}))
}

test('frozen pre-fix candidate reproduces the top-layer escape in an isolated profile',async()=>{
  test.skip(!process.env.PLIUNA_REVIEW_BASELINE_EXECUTABLE,'Explicit immutable baseline path required')
  const fixture=await sample()
  const app=await electron.launch({executablePath:process.env.PLIUNA_REVIEW_BASELINE_EXECUTABLE!,args:[],env:{...process.env,NODE_OPTIONS:'',ELECTRON_RUN_AS_NODE:'',ELECTRON_RENDERER_URL:'',PLIUNA_TEST_DATA:fixture.root}})
  try{
    const page=await app.firstWindow()
    await page.getByRole('button',{name:/Review repair synthetic/}).click()
    const view=page.locator('.managed').first()
    await view.getByRole('button',{name:'OPEN_COVER',exact:true}).click()
    const evidence=await view.locator('[popover]').evaluate(el=>{
      const rect=el.getBoundingClientRect(),host=el.getRootNode() as ShadowRoot,outer=host.host.closest('.managed')!.getBoundingClientRect()
      return {open:el.matches(':popover-open'),left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,outer:{left:outer.left,top:outer.top,right:outer.right,bottom:outer.bottom},viewport:{width:innerWidth,height:innerHeight}}
    })
    expect(evidence.open).toBe(true)
    expect(evidence.left<evidence.outer.left||evidence.top<evidence.outer.top||evidence.right>evidence.outer.right||evidence.bottom>evidence.outer.bottom).toBe(true)
    const target=join(fixture.root,'baseline-top-layer-evidence.json')
    await writeFile(target,JSON.stringify(evidence,null,2))
  }finally{await app.close()}
})

test('blocks historical top-layer controls while preserving neighboring controls and restart data',async()=>{
  const fixture=await sample(),launch=()=>electron.launch({executablePath:repairedPath,args:repairedArgs,env:{...process.env,NODE_OPTIONS:'',ELECTRON_RUN_AS_NODE:'',ELECTRON_RENDERER_URL:'',PLIUNA_TEST_DATA:fixture.root}})
  let app=await launch(),page=await app.firstWindow()
  const errors:string[]=[]
  try{
    page.on('pageerror',e=>errors.push(e.message))
    await page.getByRole('button',{name:/Review repair synthetic/}).click()
    await expect(page.getByRole('alert').filter({hasText:'VIEW_TOP_LAYER_DISABLED'})).toBeVisible()
    await expect(page.getByText('OPEN_COVER',{exact:true})).toHaveCount(0)
    const safe=page.locator('.managed').nth(1)
    await safe.getByLabel('Note',{exact:true}).fill('REPAIR_PRESERVED_DRAFT')
    await expect(safe.getByLabel('Note',{exact:true})).toHaveValue('REPAIR_PRESERVED_DRAFT')
    await expect(safe.getByRole('status')).toHaveText('已保存')
    await expect.poll(async()=>{
      const result=await page.evaluate(task=>window.pliuna.request({type:'task.snapshot',task_id:task}),fixture.task)
      if(!result.ok)throw Error(result.error.code)
      return (result.data as any).views[1].draft.note
    }).toBe('REPAIR_PRESERVED_DRAFT')
    await expect(page.getByRole('button',{name:'停止任务',exact:true})).toBeVisible()
    expect(await page.evaluate(()=>document.querySelectorAll(':popover-open').length)).toBe(0)
    expect(await readFile(join(fixture.root,'resources',fixture.resource),'utf8')).toBe(fixture.source)
    await app.close();app=await launch();page=await app.firstWindow()
    await page.getByRole('button',{name:/Review repair synthetic/}).click()
    await expect(page.getByRole('alert').filter({hasText:'VIEW_TOP_LAYER_DISABLED'})).toBeVisible()
    await expect(page.getByLabel('Note',{exact:true})).toHaveValue('REPAIR_PRESERVED_DRAFT')
    expect(await readFile(join(fixture.root,'resources',fixture.resource),'utf8')).toBe(fixture.source)
    expect(errors).toEqual([])
  }finally{await app.close()}
})

for (const ending of ['cancel', 'quit'] as const) test(`ordinary plugin ${ending} waits for actual child exit before terminal state and restart`,async()=>{
  test.setTimeout(45000)
  const fixture=await sample()
  const stages:string[]=[],modelErrors:string[]=[]
  let discoveredCapability:string|undefined
  const respond=(res:ServerResponse,name:string,args:unknown,id:string)=>{
    res.writeHead(200,{'content-type':'text/event-stream'})
    res.end(frame({role:'assistant',tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(modelInputFromHost(name,args))}}]})+`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:30,completion_tokens:8}})}\n\n`+'data: [DONE]\n\n')
  }
  const server=await modelServer(({body},res)=>{
    try{
      if(synthetic(body,res))return
      expect(body.max_tokens).toBe(4096)
      const user=body.messages.findLast((message:any)=>message.role==='user')
      expect(JSON.parse(user.content)).toMatchObject({request:'Synthetic cancellation',request_materials:[{kind:'goal',task_id:fixture.task,request_id:expect.any(String),intent_revision:1}]})
      const last=body.messages.at(-1)
      if(last.role!=='tool'){
        expect(stages).toEqual([])
        stages.push('discover')
        respond(res,'list',{kind:'capability'},'runner-plugin-discover')
      }else if(last.tool_call_id==='runner-plugin-discover'){
        expect(stages).toEqual(['discover'])
        const result=JSON.parse(last.content)
        const capability=result.data.items.find((item:any)=>item.id===fixture.capability)
        expect(capability).toMatchObject({id:fixture.capability,read_contract_before_call:true})
        discoveredCapability=capability.id
        stages.push('read')
        respond(res,'read',{target:{kind:'capability',id:discoveredCapability}},'runner-plugin-contract')
      }else if(last.tool_call_id==='runner-plugin-contract'){
        expect(stages).toEqual(['discover','read'])
        const contract=JSON.parse(last.content).data.data
        expect(contract).toMatchObject({id:discoveredCapability,capability:{id:'wait',effect:'read'}})
        stages.push('call')
        respond(res,'call',{capability:contract.id,arguments:{},references:[]},'runner-plugin-invoke')
      }else throw Error('A cancelled plugin call must not cause another model request')
    }catch(error){
      modelErrors.push(error instanceof Error?error.message:String(error))
      res.writeHead(500);res.end('Default Runner plugin fixture failed')
    }
  })
  const env={...process.env}
  delete env.PLIUNA_TEST_RUNNER
  delete env.TRELLIS_TEST_RUNNER
  delete env.PLIUNA_TEST_RUNNER_COLLATOR
  delete env.TRELLIS_TEST_RUNNER_COLLATOR
  const launch=()=>electron.launch({executablePath:repairedPath,args:repairedArgs,env:{...env,NODE_OPTIONS:'',ELECTRON_RUN_AS_NODE:'',ELECTRON_RENDERER_URL:'',PLIUNA_TEST_DATA:fixture.root}})
  let app=await launch(),page=await app.firstWindow()
  const call=async(request:any):Promise<any>=>{const result=await page.evaluate(r=>window.pliuna.request(r),request);if(!result.ok)throw Error(`${request.type}: ${result.error.code}: ${result.error.message} (fixture ${fixture.root})`);return result.data}
  try{
    await call({type:'model.configure',configuration:{id:'review',base_url:server.url,wire_model_id:'synthetic',context_tokens:100000,max_output_tokens:4096,compatibility_profile:'chat-max-tokens'},api_key:'synthetic-only',confirm_memory_only:true})
    await call({type:'model.test',model_id:'review',role:'main',confirm_cost:true})
    await page.getByRole('button',{name:/Review repair synthetic/}).click()
    const submitted=await call({type:'request.submit',task_id:fixture.task,text:'Synthetic cancellation',model_config_id:'review',resource_ids:[],import_ids:[]})
    await expect.poll(async()=>{expect(modelErrors).toEqual([]);return readFile(join(fixture.root,'plugin-executions'),'utf8').catch(()=>'' )}).not.toBe('')
    const pid=Number((await readFile(join(fixture.root,'plugin-starts'),'utf8')).trim())
    const request=await call({type:'request.status',task_id:fixture.task,request_id:submitted.request_id})
    expect(request).toMatchObject({state:'started',run_id:expect.any(String)})
    expect(stages).toEqual(['discover','read','call'])
    expect(()=>process.kill(pid,0)).not.toThrow()
    const running=await call({type:'task.snapshot',task_id:fixture.task})
    expect(running.runner.goals.find((goal:any)=>goal.request_id===submitted.request_id).run).toMatchObject({id:request.run_id,source:{purpose:'production',task_id:fixture.task,request_id:submitted.request_id,run_id:request.run_id,intent_revision:1}})
    const plan=running.records.find((record:any)=>record.kind==='runner.plan.installed'&&record.payload.run_id===request.run_id)
    expect(plan).toBeDefined()
    const owner={task_id:fixture.task,run_id:request.run_id,work_id:plan.payload.work_id,attempt_id:plan.payload.attempt_id,role:'producer',purpose:'production',request_id:submitted.request_id,intent_revision:1}
    const pluginCalls=await app.evaluate((_electron,{directory,task,run})=>{
      const Database=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('better-sqlite3')
      const control=new Database(directory+'/restore-control.sqlite',{readonly:true})
      let selected:string
      try{selected=JSON.parse(control.prepare('SELECT manifest FROM restore_control').get().manifest).selected}finally{control.close()}
      const db=new Database(directory+'/'+selected,{readonly:true})
      try{return db.prepare('SELECT id,run_id,capability_id,dispatch,limits_json FROM calls WHERE task_id=? AND run_id=?').all(task,run).map((row:any)=>({id:row.id,run_id:row.run_id,capability:row.capability_id,dispatch:row.dispatch,owner:JSON.parse(row.limits_json).owner}))}finally{db.close()}
    },{directory:fixture.root,task:fixture.task,run:request.run_id})
    expect(pluginCalls).toEqual([{id:expect.any(String),run_id:request.run_id,capability:discoveredCapability,dispatch:'sent',owner}])
    expect((await readFile(join(fixture.root,'plugin-executions'),'utf8')).trim()).toBe(pluginCalls[0].id)
    if(ending==='cancel'){
      await call({type:'run.cancel',task_id:fixture.task,run_id:request.run_id})
      await expect.poll(async()=>readFile(join(fixture.root,'cancel-received'),'utf8').catch(()=>'' )).toBe('yes')
      const pending=await call({type:'task.snapshot',task_id:fixture.task})
      expect(pending.runs.find((r:any)=>r.id===request.run_id)).toMatchObject({state:'waiting',wait_reason:'ending_cleanup'})
      expect((await call({type:'plugin.list',task_id:fixture.task})).items[0].instances).toMatchObject([{state:'stopping'}])
      expect(()=>process.kill(pid,0)).not.toThrow()
      await expect.poll(async()=>(await call({type:'request.status',task_id:fixture.task,request_id:submitted.request_id})).run_state,{timeout:12000}).toBe('cancelled')
      expect(()=>process.kill(pid,0)).toThrow()
      expect((await call({type:'plugin.list',task_id:fixture.task})).items[0].instances).toEqual([])
    }
    const executions=await readFile(join(fixture.root,'plugin-executions'),'utf8'),count=server.exchanges.length
    await app.close()
    expect(()=>process.kill(pid,0)).toThrow()
    app=await launch();page=await app.firstWindow()
    expect((await call({type:'plugin.list',task_id:fixture.task})).items[0].instances).toEqual([])
    expect((await call({type:'request.status',task_id:fixture.task,request_id:submitted.request_id})).run_state).toBe(ending==='cancel'?'cancelled':'interrupted')
    const ended=await call({type:'task.snapshot',task_id:fixture.task})
    if(ending==='quit')expect(ended.runs.find((run:any)=>run.id===request.run_id)).toMatchObject({state:'interrupted',primary_reason:'host_shutdown'})
    expect(ended.records.find((record:any)=>record.kind==='plugin.call.ended'&&record.payload.call_id===pluginCalls[0].id)?.payload).toMatchObject({call_id:pluginCalls[0].id,owner})
    expect(await readFile(join(fixture.root,'plugin-executions'),'utf8')).toBe(executions)
    expect(server.exchanges).toHaveLength(count)
    expect(modelErrors).toEqual([])
  }finally{await app.close();await server.close()}
})
