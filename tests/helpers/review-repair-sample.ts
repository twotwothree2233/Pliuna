import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
import { managedControls } from './managed-controls'
import { pluginCapabilityId } from '../../src/runtime/plugins/directory'

export async function reviewRepairSample() {
  const root = mkdtempSync(join(tmpdir(), 'trellis-review-desktop-')), store = new RuntimeStore(root)
  const snapshot = store.create('Review repair synthetic'), task = snapshot.task.id
  const run = store.start(task, 'held synthetic fixture', 'fixture', [])
  clearTimeout((store as any).timers.get(run)); (store as any).timers.delete(run)
  const bundle = managedControls()
  store.modelTool(task, run, {type:'write',input:{type:'surface.update',surface_id:snapshot.surface.id,expected_revision:1,operations:[0,1].map(i=>({type:'view.create',client_ref:'v'+i,slot_id:'main',bundle:{type:'inline',bundle}}))}})
  const view = store.snapshot(task).views[0]!, old = structuredClone(bundle)
  old.html += `<button id="open-cover" popovertarget="v-${view.id}-cover">OPEN_COVER</button><aside id="cover" popover="manual" style="position:fixed;inset:0;width:100vw;height:100vh;background:#fff;margin:0;z-index:999999">TOP_LAYER_COVER</aside>`
  const result: any = store.modelTool(task,run,{type:'write',input:{type:'resource.create',display_name:'historical.json',content:{type:'json',value:old}}})
  const resource = result.data.id, db = new Database(join(root,'trellis.sqlite'))
  // This fixture represents a previously accepted bundle; current publishing stays validated.
  db.prepare('UPDATE views SET bundle_resource_id=? WHERE id=?').run(resource,view.id)
  db.prepare('UPDATE view_history SET bundle_resource_id=? WHERE view_id=?').run(resource,view.id)
  db.close()
  store.handle({type:'run.cancel',task_id:task,run_id:run})
  const source=join(root,'plugin-source');mkdirSync(source)
  writeFileSync(join(source,'backend.cjs'), `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(join(root,'plugin-starts'))},process.pid+'\\n');const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocol_version:'0.1',plugin_id:m.params.plugin_id,capabilities:m.params.capabilities}});if(m.method==='tools.cancel')fs.writeFileSync(${JSON.stringify(join(root,'cancel-received'))},'yes');if(m.method==='shutdown')send({jsonrpc:'2.0',id:m.id,result:{accepted:true}});if(m.method==='tools.execute'){fs.appendFileSync(${JSON.stringify(join(root,'plugin-executions'))},m.params.call_id+'\\n');setTimeout(()=>send({jsonrpc:'2.0',id:m.id,result:{value:'late'}}),30000)}})`)
  writeFileSync(join(source,'tool.json'),JSON.stringify({id:'wait',description:'synthetic cancellation fixture',when_to_use:'isolated review tests',input_schema:{type:'object'},output_schema:{type:'object'},effect:'read',timeout_ms:60000,errors:[],examples:[]}))
  writeFileSync(join(source,'manifest.json'),JSON.stringify({manifest_version:'0.1',protocol_version:'0.1',id:'fixture.review',version:'1.0.0',access_level:'task',contributes:[{id:'wait',kind:'tool',entry:'tool.json',description:'synthetic'}],backend:{runtime:'app-node',entry:'backend.cjs'}}))
  const installed:any=await store.handle({type:'plugin.internal.install',source})
  await store.handle({type:'plugin.trust',digest:installed.digest,confirm_local_code:true,confirm_cross_task:false})
  const plan:any=await store.handle({type:'plugin.plan',task_id:task,digest:installed.digest})
  await store.handle({type:'plugin.enable',task_id:task,digest:installed.digest,fingerprint:plan.fingerprint,confirm_cross_task:false})
  await store.shutdown()
  return {root,task,view:view.id,resource,source:readFileSync(join(root,'resources',resource),'utf8'),digest:installed.digest,capability:pluginCapabilityId(installed.digest,'wait')}
}
