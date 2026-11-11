import * as platformFiles from '../../src/platform/files'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RuntimeStore } from '../../src/runtime/store'
import { digest } from '../../src/runtime/resources'
let root: string, store: RuntimeStore, task: string
const state = (): any => store.handle({ type: 'maintenance.status' })
const begin = (): string => (store.handle({ type: 'maintenance.begin' }) as any).reservation.token
const cancel = (token: string) => { if (state().reservation?.token === token) store.handle({ type: 'maintenance.cancel', token }) }
const list = (before?: number): any => store.handle({ type: 'maintenance.resource.list', ...(before ? { before } : {}) })
const status = (id: string): any => store.handle({ type: 'maintenance.resource.status', operation_id: id })
const preview = (id: string, token: string): any => store.handle({ type: 'maintenance.resource.preview', operation_id: id, token, inputs_saved: true })
const execute = (id: string, token: string, retry = false): any => store.handle({ type: retry ? 'maintenance.resource.retry' : 'maintenance.resource.execute', operation_id: id, token, inputs_saved: true, confirm_retire_resource: true })
const point = async (): Promise<any> => store.handle({ type: 'maintenance.create', token: begin(), inputs_saved: true, replace_id: state().active?.id ?? null })
const restart = () => { store.close(); store = new RuntimeStore(root, undefined, { viewReplacement: true }) }
const journal = (): any => { const db = new Database(join(root, 'restore-control.sqlite')); try { return JSON.parse((db.prepare('SELECT manifest FROM restore_control').get() as any).manifest) } finally { db.close() } }
const database = (): Database.Database => new Database(join(root, journal().selected))
const remove = (id = task, invalidate?: string) => store.handle({ type: 'task.delete', task_id: id, ...(invalidate ? { invalidate_recovery_id: invalidate } : {}) })
function resource(text = 'original', title = '材料'): string {
  vi.useFakeTimers(); const run = store.start(task, 'held', 'fixture', [])
  const result = store.modelTool(task, run, { type: 'write', input: { type: 'resource.create', display_name: title, content: { type: 'text', text } } }) as any
  store.handle({ type: 'run.cancel', task_id: task, run_id: run }); vi.useRealTimers(); return result.data.id
}
function candidate(key = resource()): any { remove(); const r = list().items.find((r: any) => r.resource_id === key); return r }
function prepare(id: string): string { const t = begin(); preview(id, t); return t }
beforeEach(context => { if (context.task.name === 'v2 control upgrades preserve existing replica and permanent task deletion facts') vi.stubEnv('PLIUNA_TEST_FILE_IDENTITIES', ''); root = fs.mkdtempSync(join(tmpdir(), 'pliuna-resource-cleanup-')); store = new RuntimeStore(root, undefined, { viewReplacement: true }); task = store.create('资源收尾隔离').task.id })
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); store.close(); fs.rmSync(root, { recursive: true, force: true }) })
it('registers exact source and committed handoff before deleting business; only explicit confirmation removes a resource', () => {
  const key = resource(), result = remove() as any; expect(result).toMatchObject({ deleted: true, resource_cleanup: 'retained_pending_explicit_confirmation' }); expect(store.tasks()).toEqual([])
  const r = list().items[0]; expect(r.eligible).toBe(true); expect(fs.readFileSync(join(root, 'resources', key), 'utf8')).toBe('original'); expect(journal().task_deletions[0].stages[0]).toMatchObject({ state: 'committed', owner_state: 'ended', owner_result: 'success' })
  const t = prepare(r.id); expect(execute(r.id, t)).toMatchObject({ phase: 'complete', file_result: 'deleted', files_deleted: 1, deleted_bytes: 8, metadata_cleaned: true, business_replayed: false })
  const db = database(); expect(db.prepare('SELECT * FROM resources').all()).toEqual([]); db.close(); expect(fs.existsSync(join(root, 'resources', key))).toBe(false)
  restart(); expect(status(r.id).phase).toBe('complete'); expect(journal().deleted_tasks).toContain(task); expect(journal().version).toBe(process.platform === 'win32' && process.env.PLIUNA_TEST_FILE_IDENTITIES === 'decimal-v2' ? 6 : 5)
})
it('cancel, expired preparation and all explicit confirmation fields are required', () => {
  const r = candidate(), t = prepare(r.id); cancel(t); const next = begin(); expect(() => execute(r.id, next)).toThrow(); cancel(next)
  for (const missing of ['token', 'inputs_saved', 'operation_id', 'confirm_retire_resource']) {
    const token = prepare(r.id), req: any = { type: 'maintenance.resource.execute', operation_id: r.id, token, inputs_saved: true, confirm_retire_resource: true }; delete req[missing]; expect(() => store.handle(req)).toThrow(); cancel(token)
  }
  vi.useFakeTimers(); const expired = prepare(r.id); vi.advanceTimersByTime(60001); expect(() => execute(r.id, expired)).toThrow(); expect(status(r.id).phase).toBe('candidate'); expect(fs.readdirSync(join(root, 'resources'))).toHaveLength(1)
})
it('shared task association keeps original bytes; deletion of last owner updates same cleanup and no file is auto-deleted', () => {
  const key = resource(), other = store.create('共享任务').task.id, db = database(); db.prepare('INSERT INTO task_resources VALUES (?,?)').run(other, key); db.close()
  remove(); let r = list().items[0]; expect(r).toMatchObject({ eligible: false, protection_reason: 'TASK_ASSOCIATION' }); expect(fs.existsSync(join(root, 'resources', key))).toBe(true)
  remove(other); expect(list().items).toHaveLength(1); r = list().items[0]; expect(r.eligible).toBe(true); expect(journal().resource_cleanups[0].source_tasks.sort()).toEqual([task, other].sort()); execute(r.id, prepare(r.id)); expect(fs.existsSync(join(root, 'resources', key))).toBe(false)
})
it.each(['task_data','explicit','view','history','frozen','recovery-projection','staging','alias','malformed-history'])('keeps %s protection even if its projection is absent', mode => {
  const key = resource(), r = candidate(key), other = store.create('保护任务').task.id, db = database()
  if (mode === 'task_data') db.prepare("INSERT INTO task_data VALUES ('data',?,1,'{}','{}',?,NULL,0)").run(other, JSON.stringify([{ name: 'r', target: { kind: 'resource', id: key } }]))
  if (mode === 'explicit') db.prepare("INSERT INTO object_references VALUES (?,'task_data','source','r','resource',?,NULL,1,0)").run(other, key)
  if (mode === 'view') { const surface = (db.prepare('SELECT id FROM surfaces WHERE task_id=?').get(other) as any).id; db.prepare("INSERT INTO views VALUES ('v',?,1,?,1,'{}','v1',NULL,0)").run(surface, key) }
  if (['history','frozen','malformed-history'].includes(mode)) {
    const alternate = randomUUID(); db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(alternate, alternate, digest(Buffer.from('x')),1,'text/plain','other','now'); fs.writeFileSync(join(root, 'resources', alternate),'x')
    db.prepare("INSERT INTO view_history VALUES ('h',?,'v',1,?,?)").run(other, mode === 'history' ? key : alternate, mode === 'malformed-history' ? '{broken' : JSON.stringify({ evidence: { version: 1, sources: mode === 'frozen' ? [{ resources: [{ id: key }], references: [] }] : [] } }))
  }
  if (mode === 'recovery-projection') { db.prepare("INSERT INTO recovery_points VALUES ('p','candidate','{}','now')").run(); db.prepare("INSERT INTO recovery_resources VALUES ('p',?)").run(key) }
  if (mode === 'staging') db.prepare("INSERT INTO staging (id,task_id,owner_kind,owner_id,runtime_epoch,state,storage_key,expected_bytes,created_at) VALUES ('newstage',?,'action','unknown','new','prepared',?,8,'now')").run(other,key)
  if (mode === 'alias') db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(randomUUID(),key,digest(Buffer.from('original')),8,'text/plain','alias','now')
  db.close(); const now = list().items.find((v: any) => v.id === r.id); expect(now.eligible).toBe(false); const t = begin(); expect(() => preview(r.id,t)).toThrow(); cancel(t); expect(fs.readFileSync(join(root,'resources',key),'utf8')).toBe('original')
})
it.each(['receiving','publishing','prepared','invalid','unknown-owner'])('does not discharge archived uncertain staging %s', mode => {
  const key = resource(), db = database(); if(mode==='unknown-owner') db.prepare("UPDATE staging SET owner_id='unknown'").run(); else db.prepare('UPDATE staging SET state=?').run(mode); db.close()
  const r = candidate(key); expect(r).toMatchObject({ eligible: false, protection_reason: 'ARCHIVED_STAGING_UNCERTAIN' }); expect(fs.existsSync(join(root,'resources',key))).toBe(true)
})
it('effective point prevents deletion and is never proactively invalidated by resource maintenance', async () => {
  const key = resource(), p = (await point()).active; expect(() => remove()).toThrow(); expect(state().active.id).toBe(p.id); expect(store.tasks()).toHaveLength(1)
  const db=database(); db.prepare('DELETE FROM task_resources WHERE resource_id=?').run(key); db.close(); expect(list().items).toEqual([]); expect(state().active.id).toBe(p.id)
})
it('invalidated backup still protects until its separate replica retirement is fully released', async () => {
  const key = resource(), p=(await point()).active; remove(task,p.id); const r=list().items[0]; expect(r.eligible).toBe(false)
  const token=begin(), replica=(store.handle({type:'maintenance.replica.list'}) as any).items.find((v:any)=>v.eligible), q=store.handle({type:'maintenance.replica.preview',token,replica_id:replica.replica_id,inputs_saved:true}) as any
  store.handle({type:'maintenance.replica.execute',token,operation_id:q.id,inputs_saved:true,confirm_retire_replica:true}); expect(fs.existsSync(join(root,'resources',key))).toBe(true); expect(list().items[0].eligible).toBe(true); execute(r.id,prepare(r.id)); expect(fs.existsSync(join(root,'resources',key))).toBe(false)
})
it.each(['EACCES','EPERM','EBUSY','EIO','ENOSPC'])('persists retry %s without auto deletion and keeps metadata until file result', code=>{
  const r=candidate(),t=prepare(r.id); vi.useFakeTimers(); vi.spyOn(fs,'unlinkSync').mockImplementation(()=>{throw Object.assign(new Error('private'),{code})})
  expect(execute(r.id,t)).toMatchObject({phase:'deleting',reason:code,attempt:1,metadata_cleaned:false}); vi.restoreAllMocks();restart();expect(fs.readdirSync(join(root,'resources'))).toHaveLength(1)
  expect(execute(r.id,begin(),true).attempt).toBe(1);vi.advanceTimersByTime(1001);expect(execute(r.id,begin(),true)).toMatchObject({phase:'complete',reason:'RESOURCE_CLEANUP_COMPLETE'})
})
it.each(['changed','symlink','dangling','hardlink','directory','corrupt','missing'])('retains unsafe %s resource without retirement or forced deletion',mode=>{
  const key=resource(),r=candidate(key),t=prepare(r.id),path=join(root,'resources',key)
  if(['symlink','dangling','directory','missing'].includes(mode))fs.unlinkSync(path)
  if(mode==='changed')fs.utimesSync(path,new Date(),new Date(Date.now()+5000))
  if(mode==='symlink'){fs.writeFileSync(path+'.target','original');fs.symlinkSync(path+'.target',path)}
  if(mode==='dangling')fs.symlinkSync(path+'.missing',path)
  if(mode==='hardlink')fs.linkSync(path,path+'.other')
  if(mode==='directory')fs.mkdirSync(path)
  if(mode==='corrupt')fs.writeFileSync(path,'modified')
  expect(()=>execute(r.id,t)).toThrow();expect(status(r.id).phase).toBe('candidate')
})
it('uses storage_key rather than resource ID and does not delete same-key temporary file',()=>{
  const id=resource(),key='distinct_'+randomUUID(),db=database();db.prepare('UPDATE resources SET storage_key=? WHERE id=?').run(key,id);db.prepare('UPDATE staging SET storage_key=? WHERE resource_id=?').run(key,id);db.close();fs.renameSync(join(root,'resources',id),join(root,'resources',key));fs.writeFileSync(join(root,'resources',key+'.tmp'),'keep')
  const r=candidate(id);expect(r.eligible).toBe(true);execute(r.id,prepare(r.id));expect(fs.existsSync(join(root,'resources',key))).toBe(false);expect(fs.readFileSync(join(root,'resources',key+'.tmp'),'utf8')).toBe('keep')
})
it('freezes deletion manifest before business data disappears and blocks deletion if registration fails',()=>{
  const key=resource(),original=Database.prototype.prepare
  vi.spyOn(Database.prototype,'prepare').mockImplementation(function(this:Database.Database,sql:string){if(this.name.endsWith('restore-control.sqlite')&&sql.startsWith('UPDATE restore_control SET manifest='))throw Object.assign(new Error('fault'),{code:'ENOSPC'});return original.call(this,sql)})
  expect(()=>remove()).toThrow();expect(fs.existsSync(join(root,'resources',key))).toBe(true);expect(store.tasks()).toHaveLength(1);vi.restoreAllMocks();restart();expect(store.tasks()).toHaveLength(1)
})
it.each(['retired','deleting','file_deleted','complete'])('preserves last durable phase when %s registration fails',phase=>{
  const key=resource(),r=candidate(key),t=prepare(r.id),original=Database.prototype.prepare
  vi.spyOn(Database.prototype,'prepare').mockImplementation(function(this:Database.Database,sql:string){const stmt=original.call(this,sql);if(this.name.endsWith('restore-control.sqlite')&&sql.startsWith('UPDATE restore_control SET manifest='))return new Proxy(stmt,{get(target,k){if(k==='run')return(manifest:string)=>{const q=JSON.parse(manifest).resource_cleanups.find((v:any)=>v.id===r.id);if(q?.phase===phase)throw Object.assign(new Error('fault'),{code:'EIO'});return target.run(manifest)};const v=Reflect.get(target,k);return typeof v==='function'?v.bind(target):v}});return stmt} as typeof Database.prototype.prepare)
  if(phase==='retired')expect(()=>execute(r.id,t)).toThrow();else expect(execute(r.id,t).phase).not.toBe('complete')
  vi.restoreAllMocks();restart();if(phase==='retired'){expect(fs.existsSync(join(root,'resources',key))).toBe(true);execute(r.id,prepare(r.id))}else{vi.useFakeTimers();vi.advanceTimersByTime(1100);expect(execute(r.id,begin(),true)).toMatchObject({phase:'complete',reason:'RESOURCE_CLEANUP_COMPLETE'})}
})
it('metadata transaction failure retains file_deleted and prevents new recovery publication until explicit original cleanup',async()=>{
  const r=candidate(),t=prepare(r.id),original=Database.prototype.prepare
  vi.spyOn(Database.prototype,'prepare').mockImplementation(function(this:Database.Database,sql:string){if(sql.startsWith('DELETE FROM resources WHERE id='))throw Object.assign(new Error('fault'),{code:'EIO'});return original.call(this,sql)})
  expect(execute(r.id,t)).toMatchObject({phase:'file_deleted',metadata_cleaned:false});vi.restoreAllMocks();restart();const token=begin();expect(()=>store.handle({type:'maintenance.create',token,inputs_saved:true,replace_id:null})).toThrow();cancel(token)
  vi.useFakeTimers();vi.advanceTimersByTime(1100);expect(execute(r.id,begin(),true)).toMatchObject({phase:'complete',reason:'RESOURCE_CLEANUP_COMPLETE'});vi.useRealTimers();expect((await point()).active).toBeTruthy()
})
it('flush failure after unlink is reconciled as absence only on explicit retry, not counted as confirmed deletion',()=>{
  const r=candidate(),t=prepare(r.id),unlink=fs.unlinkSync,flush=platformFiles.flushDirectorySync;let removed=false
  vi.spyOn(fs,'unlinkSync').mockImplementation(p=>{unlink(p);removed=true});vi.spyOn(platformFiles,'flushDirectorySync').mockImplementation(directory=>{if(removed)throw Object.assign(new Error('fault'),{code:'EIO'});return flush(directory)})
  expect(execute(r.id,t).phase).toBe('deleting');vi.restoreAllMocks();restart();expect(status(r.id).file_result).toBeNull();vi.useFakeTimers();vi.advanceTimersByTime(1100);expect(execute(r.id,begin(),true)).toMatchObject({phase:'complete',file_result:'absent',files_deleted:0})
})
it('new protection before retry blocks, never deletes it, and new preview cannot renew confirmed budget',()=>{
  const key=resource(),r=candidate(key),t=prepare(r.id);vi.spyOn(fs,'unlinkSync').mockImplementation(()=>{throw Object.assign(new Error('fault'),{code:'EBUSY'})});execute(r.id,t);vi.restoreAllMocks()
  const other=store.create('new').task.id,db=database();db.prepare('INSERT INTO task_resources VALUES (?,?)').run(other,key);db.close();vi.useFakeTimers();vi.advanceTimersByTime(1100);expect(()=>execute(r.id,begin(),true)).toThrow();expect(fs.existsSync(join(root,'resources',key))).toBe(true);expect(status(r.id).attempt).toBe(1)
})
it('pages original cleanup candidates and refuses arbitrary paths or unknown IDs',()=>{
  for(let i=0;i<22;i++)resource('item'+i);remove();const first=list();expect(first.items).toHaveLength(20);expect(list(first.next_before).items).toHaveLength(2);expect(()=>status(randomUUID())).toThrow();expect(()=>store.handle({type:'maintenance.resource.preview',token:randomUUID(),operation_id:'../secret',inputs_saved:true})).toThrow();expect(JSON.stringify(first)).not.toMatch(/storage_key|\/Users\//)
})

it('retains the original four-attempt budget across restart and new previews',()=>{
  const r=candidate(),t=prepare(r.id);vi.useFakeTimers();vi.spyOn(fs,'unlinkSync').mockImplementation(()=>{throw Object.assign(new Error('fault'),{code:'EBUSY'})})
  expect(execute(r.id,t).attempt).toBe(1)
  for(const [i,ms] of [1001,5001,15001].entries()){vi.advanceTimersByTime(ms);expect(execute(r.id,begin(),true).attempt).toBe(i+2)}
  vi.restoreAllMocks();restart();vi.advanceTimersByTime(60000);expect(execute(r.id,begin(),true).attempt).toBe(4)
  const token=begin();expect(()=>preview(r.id,token)).toThrow();cancel(token);expect(fs.existsSync(join(root,'resources',r.resource_id))).toBe(true)
})
it('final protection check refuses a new association after preview',()=>{
  const key=resource(),r=candidate(key),other=store.create('shared').task.id,t=prepare(r.id),db=database();db.prepare('INSERT INTO task_resources VALUES (?,?)').run(other,key);db.close()
  expect(()=>execute(r.id,t)).toThrow();cancel(t);expect(status(r.id).phase).toBe('candidate');expect(fs.existsSync(join(root,'resources',key))).toBe(true)
})
it('completed tombstones prevent reads and new model publications if a relation is reintroduced',()=>{
  const key=resource(),r=candidate(key);execute(r.id,prepare(r.id));const other=store.create('healthy').task.id,db=database(),saved=journal().resource_cleanups[0].resource
  fs.writeFileSync(join(root,'resources',key),'original');db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(saved.id,saved.storage_key,saved.sha256,saved.byte_length,saved.media_type,saved.display_name,saved.created_at);db.prepare('INSERT INTO task_resources VALUES (?,?)').run(other,key);db.close()
  expect(()=>store.handle({type:'task.query',task_id:other,query:{type:'list',input:{kind:'resource',limit:10}}})).toThrow('retirement')
  expect(list().items[0].protection_reason).toBe('RESOURCE_FILE_REAPPEARED');const t=begin();expect(()=>store.handle({type:'maintenance.create',token:t,inputs_saved:true,replace_id:null})).toThrow();cancel(t)
  expect(store.create('unrelated still usable').task.title).toBe('unrelated still usable')
})
it.each(['source','stages','missing-cleanup'])('rejects incomplete independent source manifest: %s',mode=>{
  candidate();store.close();const db=new Database(join(root,'restore-control.sqlite')),v=JSON.parse((db.prepare('SELECT manifest FROM restore_control').get() as any).manifest)
  if(mode==='source')v.task_deletions[0].resources=[];if(mode==='stages')v.resource_cleanups[0].stages=[];if(mode==='missing-cleanup')v.resource_cleanups=[]
  db.prepare('UPDATE restore_control SET manifest=?').run(JSON.stringify(v));db.close();expect(()=>new RuntimeStore(root)).toThrow()
})
it('v2 control upgrades preserve existing replica and permanent task deletion facts',()=>{
  const gone=store.create('old deletion').task.id;remove(gone);store.close();const db=new Database(join(root,'restore-control.sqlite')),v=JSON.parse((db.prepare('SELECT manifest FROM restore_control').get() as any).manifest)
  delete v.task_deletions;delete v.resource_cleanups;delete v.export_control;v.version=2;db.prepare('UPDATE restore_control SET manifest=?').run(JSON.stringify(v));db.close();fs.writeFileSync(join(root,'restore-established'),'restore-v2\n');store=new RuntimeStore(root)
  expect(journal()).toMatchObject({version:5,deleted_tasks:[gone],retirements:[],resource_cleanups:[]});expect(store.tasks().map(t=>t.id)).toEqual([task])
})
it('partial success is not rolled back and does not authorize another candidate',()=>{
  const first=resource('first'),second=resource('second');remove();const a=list().items.find((r:any)=>r.resource_id===first),b=list().items.find((r:any)=>r.resource_id===second)
  execute(a.id,prepare(a.id));restart();expect(status(a.id).phase).toBe('complete');expect(status(b.id).phase).toBe('candidate');expect(fs.readFileSync(join(root,'resources',second),'utf8')).toBe('second')
})
it('staging GC cannot take over a retired resource that reappears after metadata cleanup',()=>{
  const key=resource(),r=candidate(key);execute(r.id,prepare(r.id));const other=store.create('new task').task.id,db=database(),owner=randomUUID()
  fs.writeFileSync(join(root,'resources',key),'original');db.prepare("INSERT INTO actions (id,task_id,kind,state,result,source_json,request_json,commit_valid,created_at) VALUES (?,?,'mutation','ended','not_executed','{}','{}',0,'now')").run(owner,other)
  db.prepare("INSERT INTO staging (id,task_id,owner_kind,owner_id,runtime_epoch,state,storage_key,expected_bytes,sha256,created_at) VALUES (?,?,'action',?,'old','invalid',?,8,?,'now')").run(randomUUID(),other,owner,key,digest(Buffer.from('original')));db.close()
  const token=begin(),gc=store.handle({type:'maintenance.gc.preview',token,inputs_saved:true}) as any;expect(gc.items).toEqual([]);cancel(token);expect(fs.readFileSync(join(root,'resources',key),'utf8')).toBe('original')
})
it('partial replica retirement keeps historical JSON-only protection until release is durable',async()=>{
  const key=resource(),other=store.create('history owner').task.id,db=database(),bundle=randomUUID()
  db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(bundle,bundle,digest(Buffer.from('x')),1,'text/plain','history bundle','now');fs.writeFileSync(join(root,'resources',bundle),'x')
  db.prepare("INSERT INTO view_history VALUES ('frozen',?,'v',1,?,?)").run(other,bundle,JSON.stringify({evidence:{version:1,sources:[{resources:[{id:key}],references:[]}]}}));db.close()
  const op=candidate(key),old=(await point()).active;await point();const current=database();current.prepare("DELETE FROM view_history WHERE id='frozen'").run();current.close()
  expect(list().items.find((r:any)=>r.id===op.id).eligible).toBe(false)
  const token=begin(),replica=(store.handle({type:'maintenance.replica.list'}) as any).items.find((r:any)=>r.eligible),p=store.handle({type:'maintenance.replica.preview',token,replica_id:replica.replica_id,inputs_saved:true}) as any
  expect(journal().retirements.find((r:any)=>r.id===p.id).protection.keys).toContain(key)
  const original=Database.prototype.prepare
  vi.spyOn(Database.prototype,'prepare').mockImplementation(function(this:Database.Database,sql:string){const stmt=original.call(this,sql);if(this.name.endsWith('restore-control.sqlite')&&sql.startsWith('UPDATE restore_control SET manifest='))return new Proxy(stmt,{get(target,k){if(k==='run')return(manifest:string)=>{if(JSON.parse(manifest).retirements.find((r:any)=>r.id===p.id)?.phase==='released')throw Object.assign(new Error('fault'),{code:'EIO'});return target.run(manifest)};const value=Reflect.get(target,k);return typeof value==='function'?value.bind(target):value}});return stmt} as typeof Database.prototype.prepare)
  expect(store.handle({type:'maintenance.replica.execute',token,operation_id:p.id,inputs_saved:true,confirm_retire_replica:true})).toMatchObject({phase:'group_deleted',protection_released:false});vi.restoreAllMocks()
  expect(fs.existsSync(join(root,'recovery',old.id+'.sqlite'))).toBe(false);expect(list().items.find((r:any)=>r.id===op.id).eligible).toBe(false);expect(fs.existsSync(join(root,'resources',key))).toBe(true)
})
it('unrelated valid recovery point remains effective through resource cleanup and restart',async()=>{
  const oldTask=task,p=(await point()).active;task=store.create('later disposable task').task.id;const r=candidate();expect(r.eligible).toBe(true)
  execute(r.id,prepare(r.id));expect(state().active.id).toBe(p.id);restart();expect(state().active.id).toBe(p.id);expect(store.tasks().map(t=>t.id)).toEqual([oldTask]);expect(status(r.id).phase).toBe('complete')
})
it('completion registration failure blocks generation changes even after metadata is gone',async()=>{
  const r=candidate(),token=prepare(r.id),original=Database.prototype.prepare
  vi.spyOn(Database.prototype,'prepare').mockImplementation(function(this:Database.Database,sql:string){const stmt=original.call(this,sql);if(this.name.endsWith('restore-control.sqlite')&&sql.startsWith('UPDATE restore_control SET manifest='))return new Proxy(stmt,{get(target,k){if(k==='run')return(manifest:string)=>{if(JSON.parse(manifest).resource_cleanups.find((q:any)=>q.id===r.id)?.phase==='complete')throw Object.assign(new Error('fault'),{code:'EIO'});return target.run(manifest)};const value=Reflect.get(target,k);return typeof value==='function'?value.bind(target):value}});return stmt} as typeof Database.prototype.prepare)
  expect(execute(r.id,token).phase).toBe('file_deleted');vi.restoreAllMocks();const db=database();expect(db.prepare('SELECT * FROM resources').all()).toEqual([]);db.close();restart()
  const t=begin();expect(()=>store.handle({type:'maintenance.create',token:t,inputs_saved:true,replace_id:null})).toThrow('original resource cleanup');cancel(t)
  vi.useFakeTimers();vi.advanceTimersByTime(1100);expect(execute(r.id,begin(),true)).toMatchObject({phase:'complete',reason:'RESOURCE_CLEANUP_COMPLETE'});vi.useRealTimers();expect((await point()).active).toBeTruthy()
})
