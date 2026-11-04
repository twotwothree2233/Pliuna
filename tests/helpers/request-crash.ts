import {RuntimeStore} from '../../src/runtime/store'
const [root,task,point]=process.argv.slice(2),store=new RuntimeStore(root!)
const pause=()=>{process.send?.({boundary:point});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)}
const db=(store as any).db
if(point==='registered')(store as any).requests.available=()=>false
if(['state-updated','run-inserted'].includes(point!)){const prepare=db.prepare.bind(db);db.prepare=(sql:string)=>{const s=prepare(sql);if((point==='state-updated'&&sql.startsWith("UPDATE requests SET state='started'"))||(point==='run-inserted'&&sql.startsWith('INSERT INTO runs'))){const run=s.run.bind(s);s.run=(...args:any[])=>{const r=run(...args);pause();return r}}return s}}
store.handle({type:'request.submit',task_id:task,text:'synthetic crash request',model_config_id:'fixture',resource_ids:[],import_ids:[]})
pause()
