import { afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeStore } from '../../src/runtime/store'

const stores: RuntimeStore[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.shutdown() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'pliuna-recovery-shutdown-')), store = new RuntimeStore(root)
  stores.push(store)
  const task = store.create('Recovery shutdown synthetic').task.id
  const call = (type: string, extra = {}): any => store.handle({ type, ...extra })
  const begin = () => call('maintenance.begin').reservation.token
  const point = () => call('maintenance.create', { token: begin(), inputs_saved: true, replace_id: null })
  return { root, store, task, call, begin, point }
}
const turn = () => new Promise<void>(done => setImmediate(done))

it.each([1, 2])('waits for restore backup %s before closing dependencies or acknowledging shutdown', async boundary => {
  const { root, store, task, call, begin, point } = setup(), active = (await point()).active
  const entered = deferred(), release = deferred(), original = Database.prototype.backup
  let backups = 0
  vi.spyOn(Database.prototype, 'backup').mockImplementation(async function(this: Database.Database, ...args: Parameters<typeof original>) {
    if (++backups === boundary) { entered.resolve(); await release.promise }
    return original.apply(this, args)
  })
  const events: string[] = [], recovery = (store as any).recovery, journal = (store as any).journal
  const closeRecovery = recovery.close.bind(recovery), closeJournal = journal.close.bind(journal)
  vi.spyOn(recovery, 'close').mockImplementation(() => { events.push('recovery-close'); closeRecovery() })
  vi.spyOn(journal, 'close').mockImplementation(() => { events.push('journal-close'); closeJournal() })
  const restoring = call('maintenance.restore', {token:begin(),point_id:active.id,database_sha256:active.database_sha256,inputs_saved:true,confirm_replace_newer_data:true}).then((value: any) => { events.push('restore-settled'); return value }, (error: unknown) => { events.push('restore-failed'); return { error } })
  await entered.promise
  let closed = false
  const shutting = store.shutdown().then(() => { closed = true; events.push('closed') })
  try {
    await turn()
    expect(() => call('maintenance.begin')).toThrow(expect.objectContaining({ code: 'SHUTTING_DOWN' }))
    expect(() => store.create('late task')).toThrow(expect.objectContaining({ code: 'SHUTTING_DOWN' }))
    expect(() => store.start(task,'late run','fixture',[])).toThrow(expect.objectContaining({ code: 'SHUTTING_DOWN' }))
    expect(closed).toBe(false)
    expect((store as any).db.open).toBe(true)
    expect(events).toEqual([])
  } finally { release.resolve(); await restoring; await shutting }
  expect(events).toEqual(['restore-settled','recovery-close','journal-close','closed'])
  vi.restoreAllMocks()
  const restarted = new RuntimeStore(root); stores.push(restarted)
  expect(restarted.snapshot(task).task.title).toBe('Recovery shutdown synthetic')
  expect((restarted.handle({type:'maintenance.status'}) as any).restore.last.phase).toBe('completed')
  expect(restarted.snapshot(task).runs).toEqual([])
})

it.each(['backup-failure', 'switched-rollback', 'rollback-failure'])('settles %s before shutdown and retains the failure result', async fault => {
  const {root,store,task,call,begin,point}=setup(),active=(await point()).active
  const entered=deferred(),release=deferred(),events:string[]=[]
  const journal=(store as any).journal,recovery=(store as any).recovery
  if(fault==='backup-failure') {
    vi.spyOn(Database.prototype,'backup').mockImplementationOnce(async()=>{entered.resolve();await release.promise;throw Error('synthetic backup failure')})
  } else {
    const rebind=(store as any).rebindDatabase.bind(store)
    vi.spyOn(store as any,'rebindDatabase').mockImplementationOnce((file:unknown)=>{
      rebind(file)
      events.push('target-rebound')
      throw Error('synthetic verification failure after rebind')
    })
    const rollback=journal.rollback.bind(journal)
    vi.spyOn(journal,'rollback').mockImplementation(()=>{events.push('rollback');if(fault==='rollback-failure')throw Error('synthetic rollback failure');return rollback()})
    const original=Database.prototype.backup
    vi.spyOn(Database.prototype,'backup').mockImplementationOnce(async function(this:Database.Database,...args:Parameters<typeof original>){entered.resolve();await release.promise;return original.apply(this,args)})
  }
  const restoring=call('maintenance.restore',{token:begin(),point_id:active.id,database_sha256:active.database_sha256,inputs_saved:true,confirm_replace_newer_data:true}).then(()=>{throw Error('restore unexpectedly succeeded')},(error:any)=>{events.push('restore-failed');return error.code})
  await entered.promise
  const closing=recovery.close.bind(recovery)
  vi.spyOn(recovery,'close').mockImplementation(()=>{events.push('recovery-close');closing()})
  let closed=false;const shutting=store.shutdown().then(()=>{closed=true;events.push('closed')})
  await turn();expect(closed).toBe(false);expect((store as any).db.open).toBe(true)
  release.resolve()
  expect(await restoring).toBe(fault==='rollback-failure'?'RESTORE_ROLLBACK_FAILED':'RESTORE_FAILED')
  await shutting
  expect(events.indexOf('restore-failed')).toBeLessThan(events.indexOf('recovery-close'))
  if(fault!=='backup-failure')expect(events.indexOf('rollback')).toBeLessThan(events.indexOf('restore-failed'))
  expect((recovery as any).error).toBe(fault==='rollback-failure'?'RESTORE_ROLLBACK_FAILED':'RESTORE_FAILED')
  vi.restoreAllMocks()
  const restarted=new RuntimeStore(root);stores.push(restarted)
  expect(restarted.snapshot(task).task.title).toBe('Recovery shutdown synthetic')
  expect(restarted.snapshot(task).runs).toEqual([])
  // An unrolled, valid switched target is reconciled as completed on restart.
  expect((restarted.handle({type:'maintenance.status'}) as any).restore.last.phase).toBe(fault==='rollback-failure'?'completed':'rolled_back')
})

it('waits for recovery point creation without changing the old point on failure',async()=>{
  const {root,store,task,call,begin,point}=setup(),old=(await point()).active
  const entered=deferred(),release=deferred()
  vi.spyOn(Database.prototype,'backup').mockImplementationOnce(async()=>{entered.resolve();await release.promise;throw Error('synthetic backup failure')})
  const creating=call('maintenance.create',{token:begin(),inputs_saved:true,replace_id:old.id}).catch((error:any)=>error.code)
  await entered.promise
  let closed=false;const shutting=store.shutdown().then(()=>{closed=true})
  await turn();expect(closed).toBe(false);expect((store as any).db.open).toBe(true)
  release.resolve();expect(await creating).toBe('RECOVERY_CREATE_FAILED');await shutting
  vi.restoreAllMocks();const restarted=new RuntimeStore(root);stores.push(restarted)
  expect((restarted.handle({type:'maintenance.status'}) as any).active.id).toBe(old.id)
  expect(restarted.snapshot(task).runs).toEqual([])
})

it('keeps re-created managers and queues behind the closing barrier',async()=>{
  const {store,task,call,begin,point}=setup(),active=(await point()).active
  const entered=deferred(),release=deferred(),original=Database.prototype.backup
  vi.spyOn(Database.prototype,'backup').mockImplementationOnce(async function(this:Database.Database,...args:Parameters<typeof original>){entered.resolve();await release.promise;return original.apply(this,args)})
  const oldProcesses=(store as any).pluginProcesses
  const oldShutdown=vi.spyOn(oldProcesses,'shutdown')
  const initialize=(store as any).initializeRequests.bind(store),latestShutdown=vi.fn()
  let rebinds=0
  vi.spyOn(store as any,'initializeRequests').mockImplementation(()=>{
    initialize();rebinds++
    const internal=store as any,queue=internal.requests
    expect(internal.closing).toBe(true)
    expect(queue.closed).toBe(true)
    expect(queue.timer._destroyed).toBe(true)
    expect(queue.available()).toBe(false)
    const runCount=internal.db.prepare('SELECT count(*) n FROM runs').get().n
    expect(()=>store.start(task,'late fixture','fixture',[])).toThrow(expect.objectContaining({code:'SHUTTING_DOWN'}))
    expect(internal.db.prepare('SELECT count(*) n FROM runs').get().n).toBe(runCount)
    expect(internal.pluginProcesses).not.toBe(oldProcesses)
    const stop=internal.pluginProcesses.shutdown.bind(internal.pluginProcesses)
    vi.spyOn(internal.pluginProcesses,'shutdown').mockImplementation(async()=>{latestShutdown();await stop()})
  })
  const restoring=call('maintenance.restore',{token:begin(),point_id:active.id,database_sha256:active.database_sha256,inputs_saved:true,confirm_replace_newer_data:true})
  await entered.promise;const shutting=store.shutdown();release.resolve();await restoring;await shutting
  expect(rebinds).toBe(1);expect(oldShutdown).not.toHaveBeenCalled();expect(latestShutdown).toHaveBeenCalledOnce()
})

it('does not start a Run when an accepted material preflight returns after shutdown',async()=>{
  const {store,task,call}=setup(),body=Buffer.alloc(262145,97)
  const operation=call('material.internal.register',{task_id:task,items:[{display_name:'synthetic.txt',source:'text'}]}).items[0].operation_id
  call('material.internal.begin',{task_id:task,operation_id:operation,byte_length:body.length,media_type:'text/plain; charset=utf-8'})
  for(let offset=0;offset<body.length;offset+=262144)call('material.internal.chunk',{task_id:task,operation_id:operation,offset,data:body.subarray(offset,offset+262144).toString('base64')})
  const resource=(await call('material.internal.finish',{task_id:task,operation_id:operation})).resource.id
  const queue=(store as any).requests,preflight=queue.preflight,release=deferred()
  queue.preflight=async(...args:any[])=>{await release.promise;return preflight(...args)}
  const request=call('request.submit',{task_id:task,text:'late synthetic',model_config_id:'fixture',resource_ids:[resource],import_ids:[]})
  expect(request.state).toBe('queued');expect(queue.busy()).toBe(true)
  await store.shutdown();release.resolve()
  await vi.waitFor(()=>expect(queue.busy()).toBe(false))
  const db=new Database(join((store as any).root,'pliuna.sqlite'),{readonly:true})
  try{expect(db.prepare('SELECT count(*) n FROM runs').get()).toEqual({n:0})}finally{db.close()}
})
