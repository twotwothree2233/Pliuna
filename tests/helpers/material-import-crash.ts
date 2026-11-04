import fs from 'node:fs'
import { RuntimeStore } from '../../src/runtime/store'
const [root,task,point]=process.argv.slice(2),store=new RuntimeStore(root!)
const call=(type:string,extra={})=>store.handle({type,task_id:task,...extra}) as any
const pause=()=>{process.send?.({boundary:point});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)}
const r=call('material.internal.register',{items:[{display_name:'crash.txt',source:'file'}]}),id=r.items[0].operation_id
if(point==='registered')pause()
call('material.internal.begin',{operation_id:id,byte_length:4,media_type:'text/plain; charset=utf-8'})
if(point==='receiving'){call('material.internal.chunk',{operation_id:id,offset:0,data:Buffer.from('ke').toString('base64')});pause()}
call('material.internal.chunk',{operation_id:id,offset:0,data:Buffer.from('keep').toString('base64')})
if(point==='renamed'){const rename=fs.renameSync;fs.renameSync=(...args)=>{rename(...args);pause()}}
if(point==='prepared'){
 const db=(store as any).db,prepare=db.prepare.bind(db)
 db.prepare=(sql:string)=>{const statement=prepare(sql);if(sql==="UPDATE staging SET state='prepared',sha256=? WHERE id=?"){const run=statement.run.bind(statement);statement.run=(...args:any[])=>{const result=run(...args);pause();return result}}return statement}
}
call('material.internal.finish',{operation_id:id})
if(point==='committed')pause()
