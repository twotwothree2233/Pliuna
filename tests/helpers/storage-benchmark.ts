import Database from 'better-sqlite3'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir, platform, arch, totalmem } from 'node:os'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { RuntimeStore } from '../../src/runtime/store'
import { RestoreJournal } from '../../src/runtime/restore-journal'
import { inspectStorage } from '../../src/runtime/storage-inspection'
import { digest } from '../../src/runtime/resources'
const scenario=process.argv[2]??'',root=fs.mkdtempSync(join(tmpdir(),'pliuna-scale-'))
const report:any={scenario,platform:platform(),arch:arch(),node:process.versions.node,memory_gib:Math.round(totalmem()/1024**3),cache:'first observation and repeated OS-cache-warm; no cache flush',complete:false,metrics:{}}
const originalUsage=process.resourceUsage(),start=performance.now()
let measured:any
const originalRead=fs.readSync,originalPrepare=Database.prototype.prepare
fs.readSync=((...args:any[])=>{const bytes=Reflect.apply(originalRead,fs,args);if(measured){measured.explicit_read_bytes+=bytes;measured.explicit_read_calls++}return bytes}) as typeof fs.readSync
Database.prototype.prepare=function(this:Database.Database,...args:Parameters<typeof originalPrepare>){if(measured)measured.sql_prepare_calls++;return originalPrepare.apply(this,args)} as typeof originalPrepare
let store:RuntimeStore|undefined
const measure=async(name:string,fn:()=>any,n=5)=>{const times:number[]=[];measured={sql_prepare_calls:0,explicit_read_bytes:0,explicit_read_calls:0};let value:any,maxResponse=0;for(let i=0;i<n;i++){const t=performance.now();value=await fn();times.push(Math.round((performance.now()-t)*100)/100);maxResponse=Math.max(maxResponse,value===undefined?0:Buffer.byteLength(JSON.stringify(value)))}const sorted=[...times].sort((a,b)=>a-b);report.metrics[name]={...measured,first_ms:times[0],samples_ms:times,p95_ms:sorted[Math.ceil(n*.95)-1],max_response_bytes:maxResponse};measured=undefined;return value}
async function main(){try{
 if(fs.statfsSync(tmpdir()).bavail*fs.statfsSync(tmpdir()).bsize<4*1024**3)throw Error('INSUFFICIENT_SCRATCH_SPACE')
 store=new RuntimeStore(root);const task=store.create('benchmark').task.id;store.close();store=undefined
 const counts:any={baseline:[1000,10000,1000],large:[10000,100000,10000],control1k:[10,100,1000],control10k:[10,100,10000],control100k:[10,100,100000],replicas:[1000,10000,1000],largefile:[1,100,10]}
 const [resources,records,controls]=counts[scenario]??[];if(!resources)throw Error('UNKNOWN_SCENARIO');report.fixture={resources,records,controls,staging:0,resource_body_bytes:scenario==='largefile'?268435456:1}
 const db=new Database(join(root,'pliuna.sqlite')),body=Buffer.from('x'),hash=digest(body),resourceIds:string[]=[]
 db.transaction(()=>{const resource=db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)'),assoc=db.prepare('INSERT INTO task_resources VALUES (?,?)'),record=db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?)');for(let i=0;i<resources;i++){const id=randomUUID();resourceIds.push(id);resource.run(id,id,hash,1,'text/plain','benchmark','now');assoc.run(task,id);fs.writeFileSync(join(root,'resources',id),body)}for(let i=0;i<records;i++)record.run(randomUUID(),task,i+1,'message.user','{"text":"benchmark"}','now')})()
 if(scenario==='largefile'){const body=Buffer.alloc(268435456,1),id=resourceIds[0]!;fs.writeFileSync(join(root,'resources',id),body);db.prepare('UPDATE resources SET sha256=?,byte_length=? WHERE id=?').run(digest(body),body.length,id)}
 if(['baseline','large','replicas'].includes(scenario))db.transaction(()=>{const histories=Math.floor(records/10),data=db.prepare("INSERT INTO task_data VALUES (?, ?,1,'{}','{}',?,NULL,0)"),history=db.prepare('INSERT INTO view_history VALUES (?,?,?,?,?,?)');for(let i=0;i<histories;i++){const id=randomUUID(),resource=resourceIds[i%resourceIds.length]!;data.run(id,task,JSON.stringify([{name:'material',target:{kind:'resource',id:resource}}]));history.run(randomUUID(),task,randomUUID(),1,resource,JSON.stringify({evidence:{version:1,sources:[{resources:[{id:resource}],references:[]}]}}))}report.fixture.task_data=histories;report.fixture.view_history=histories})()
 if(['baseline','large','replicas'].includes(scenario))db.transaction(()=>{const count=Math.floor(resources/10),action=db.prepare("INSERT INTO actions (id,task_id,kind,state,result,source_json,request_json,commit_valid,created_at,ended_at) VALUES (?,?,'mutation','ended','success','{}','{}',0,'now','now')"),stage=db.prepare("INSERT INTO staging VALUES (?,?,'action',?,'old','committed',?,?,1,1,?,'now')");for(let i=0;i<count;i++){const owner=randomUUID(),id=resourceIds[i]!;action.run(owner,task);stage.run(randomUUID(),task,owner,id,id,hash)}report.fixture.staging=count})()
 db.close()
 const control=new Database(join(root,'restore-control.sqlite')),v=JSON.parse((control.prepare('SELECT manifest FROM restore_control').get() as any).manifest)
 for(let i=0;i<controls;i++){const task=randomUUID(),material={id:randomUUID(),storage_key:randomUUID(),sha256:hash,byte_length:1,media_type:'text/plain',display_name:'benchmark',created_at:'now'};v.deleted_tasks.push(task);v.task_deletions.push({task_id:task,resources:[material],stages:[]});v.resource_cleanups.push({version:1,id:randomUUID(),resource:material,source_tasks:[task],stages:[],phase:'candidate',preview:null,identity:null,selected:null,attempt:0,next_retry_at:null,reason:'TASK_DELETION_REGISTERED',file_result:null,created_at:new Date().toISOString()})}
 if(scenario==='replicas')for(const r of v.resource_cleanups)fs.writeFileSync(join(root,'resources',r.resource.storage_key),body)
 const payload=JSON.stringify(v);report.fixture.control_manifest_bytes=Buffer.byteLength(payload);control.prepare('UPDATE restore_control SET manifest=?').run(payload);control.close()
 const metadata=new Database(join(root,'pliuna.sqlite'));metadata.transaction(()=>{const insert=metadata.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)');for(const r of v.resource_cleanups){const m=r.resource;insert.run(m.id,m.storage_key,m.sha256,m.byte_length,m.media_type,m.display_name,m.created_at)}})();metadata.close()
 const gc=new Database(join(root,'gc-control.sqlite')),gcTemplate={version:1,id:'',token:randomUUID(),selected:'pliuna.sqlite',created_at:new Date().toISOString(),phase:'settled',authorized:true,items:[],protected:0,reviews:0,next_after:null};gc.transaction(()=>{const insert=gc.prepare('INSERT INTO gc_operations VALUES (?,?)');for(let i=0;i<controls;i++){const id=randomUUID();insert.run(id,JSON.stringify({...gcTemplate,id}))}})();gc.close()
 if(report.fixture.control_manifest_bytes>64*1024**2){report.unsupported='Control manifest exceeds 64 MiB diagnostic bound; startup/write deliberately not attempted';const r=await measure('growth',()=>inspectStorage(root,{scope:'growth'},()=>{}),1);report.growth_error=r.error;return}
 report.fixture.total_resource_metadata=resources+controls
 await measure('startup',()=>{store=new RuntimeStore(root);store.close();store=undefined},3)
 store=new RuntimeStore(root)
 await measure('resource_summary_page',()=>store!.handle({type:'maintenance.resource.list',summary:true}))
 await measure('replica_summary_page',()=>store!.handle({type:'maintenance.replica.list',summary:true}))
 await measure('business_resource_page',()=>store!.handle({type:'task.query',task_id:task,query:{type:'list',input:{kind:'resource',limit:50}}}))
 await measure('gc_history_page',()=>store!.handle({type:'maintenance.gc.list'}))
 const growth=await measure('growth',()=>inspectStorage(root,{scope:'growth'},()=>{}),3);if(!growth.complete)throw Error(growth.error)
 if(scenario==='replicas'){
  const begin=()=> (store!.handle({type:'maintenance.begin'}) as any).reservation.token;let current:any=null
  await measure('create_three_retained_points',async()=>{for(let i=0;i<3;i++)current=(await store!.handle({type:'maintenance.create',token:begin(),inputs_saved:true,replace_id:current?.id??null}) as any).active},1)
  report.fixture.retained_point_databases=3
  await measure('growth_with_three_points',()=>inspectStorage(root,{scope:'growth'},()=>{}),3)
  await measure('replica_summary_with_three_points',()=>store!.handle({type:'maintenance.replica.list',summary:true}))
 }
 if(scenario!=='largefile')await measure('legacy_full_protection_list',()=>store!.handle({type:'maintenance.resource.list'}),3)
 const fileResult=await measure('resource_diagnostic',()=>inspectStorage(root,{scope:'resource',resource_id:resourceIds[0]},()=>{}),scenario==='largefile'?3:5);if(!fileResult.complete)throw Error(fileResult.error)
 report.resource_state=fileResult.items[0].state
 if(scenario!=='largefile'){const batch=await measure('resource_diagnostic_batch',()=>inspectStorage(root,{scope:'resources'},()=>{}),3);if(!batch.complete)throw Error(batch.error)}
 store.close();store=undefined
 const journal=new RestoreJournal(root)
 try{await measure('control_single_record_full_manifest_write',()=>{const r=journal.resourcePage().records[0]!;r.reason='BENCHMARK_ONLY';journal.saveResourceCleanup(r)},3)}finally{journal.close()}
 report.complete=true
 }catch(e){report.error=(e as Error).message}
 finally{store?.close();report.elapsed_ms=Math.round(performance.now()-start);report.max_rss_mib=Math.round(process.resourceUsage().maxRSS/1024);report.fs_read_blocks=process.resourceUsage().fsRead-originalUsage.fsRead;report.fs_write_blocks=process.resourceUsage().fsWrite-originalUsage.fsWrite;report.io_note='OS block counters may be unavailable/zero on macOS; explicit_read_bytes excludes native SQLite and readFileSync; prepare_calls not row visits; no physical IO guarantee';fs.rmSync(root,{recursive:true,force:true});console.log(JSON.stringify(report))}}
void main()
