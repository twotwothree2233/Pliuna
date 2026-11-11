import { expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { RuntimeStore } from '../../src/runtime/store'
import { digest } from '../../src/runtime/resources'
import { inspectStorage } from '../../src/runtime/storage-inspection'
it('real inspector SIGKILL preserves business/control/resource facts and allows a fresh read-only check', async () => {
  const root=fs.mkdtempSync(join(tmpdir(),'pliuna-inspection-kill-')),working=fs.mkdtempSync(join(tmpdir(),'pliuna-inspection-build-')),executable=join(working,'inspect.cjs')
  const store=new RuntimeStore(root),task=store.create('isolated crash').task.id,id=randomUUID(),body=Buffer.alloc(5*1024*1024,1)
  const db=new Database(join(root,'pliuna.sqlite'));db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(id,id,digest(body),body.length,'text/plain','isolated','now');db.prepare('INSERT INTO task_resources VALUES (?,?)').run(task,id);db.close();fs.writeFileSync(join(root,'resources',id),body);store.close()
  const files=['pliuna.sqlite','restore-control.sqlite','recovery-control.sqlite','gc-control.sqlite'],before=files.map(file=>fs.readFileSync(join(root,file)))
  let child: ReturnType<typeof fork> | undefined
  try {
    const req=createRequire(import.meta.url),esbuild=createRequire(req.resolve('vite'))('esbuild')
    await esbuild.build({entryPoints:['tests/helpers/storage-inspection-crash.ts'],outfile:executable,bundle:true,platform:'node',format:'cjs',packages:'external',loader:{'.txt':'text','.sql':'text'}})
    child=fork(executable,[root],{env:{...process.env,NODE_PATH:join(process.cwd(),'node_modules')},stdio:['ignore','ignore','pipe','ipc']})
    let errors='';child.stderr!.on('data',data=>{errors+=data});const exit=once(child,'exit')
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('inspector boundary timeout: '+errors)),10000);child!.once('message',()=>{clearTimeout(timer);resolve()});child!.once('exit',()=>{clearTimeout(timer);reject(Error(errors))})})
    child.kill('SIGKILL');await exit
    expect(files.map(file=>fs.readFileSync(join(root,file)))).toEqual(before);expect(fs.readFileSync(join(root,'resources',id))).toEqual(body)
    const result=await inspectStorage(root,{scope:'resources'},()=>{});expect(result.complete).toBe(true);expect(result.items[0].state).toBe('verified');expect(files.map(file=>fs.readFileSync(join(root,file)))).toEqual(before)
  } finally {
    if(child?.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited}
    fs.rmSync(root,{recursive:true,force:true});fs.rmSync(working,{recursive:true,force:true})
  }
},15000)
