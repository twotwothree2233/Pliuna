import { beforeAll,afterAll,it,expect } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
let working:string,executable:string
beforeAll(async()=>{working=fs.mkdtempSync(join(tmpdir(),'trellis-import-crash-build-'));executable=join(working,'crash.cjs');const req=createRequire(import.meta.url),esbuild=createRequire(req.resolve('vite'))('esbuild');await esbuild.build({entryPoints:['tests/helpers/material-import-crash.ts'],outfile:executable,bundle:true,platform:'node',format:'cjs',packages:'external',loader:{'.txt':'text','.sql':'text'}})})
afterAll(()=>fs.rmSync(working,{recursive:true,force:true}))
for(const point of ['registered','receiving','renamed','prepared','committed'])it('import SIGKILL at '+point+' retains facts and never resumes',async()=>{
 const root=fs.mkdtempSync(join(tmpdir(),'trellis-import-crash-'));let store:RuntimeStore|undefined=new RuntimeStore(root);const task=store.create('isolated').task.id;store.close();store=undefined
 const child=fork(executable,[root,task,point],{env:{...process.env,NODE_PATH:join(process.cwd(),'node_modules')},stdio:['ignore','ignore','pipe','ipc']}),exit=once(child,'exit');let errors='';child.stderr!.on('data',data=>{errors+=data})
 try{
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('boundary timeout '+errors)),12000);child.once('message',()=>{clearTimeout(timer);resolve()});child.once('exit',()=>{clearTimeout(timer);reject(Error(errors))})});child.kill('SIGKILL');await exit
  const files=fs.readdirSync(join(root,'resources'));store=new RuntimeStore(root);expect(fs.readdirSync(join(root,'resources'))).toEqual(files)
  const r=(store.handle({type:'material.list',task_id:task}) as any).items[0];expect(r.state).toBe(point==='committed'?'success':'failed')
  const db=new Database(join(root,'trellis.sqlite'));expect(db.prepare('SELECT * FROM runs').all()).toEqual([]);expect(db.prepare('SELECT * FROM resources').all()).toHaveLength(point==='committed'?1:0);db.close()
  if(point==='committed')expect(fs.readFileSync(join(root,'resources',r.resource.id),'utf8')).toBe('keep')
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exit}store?.close();fs.rmSync(root,{recursive:true,force:true})}
},16000)
