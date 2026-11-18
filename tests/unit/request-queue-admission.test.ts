import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RequestQueue } from '../../src/runtime/request-queue'
import { RUNNER_LIMITS } from '../../src/runtime/runner/limits'
import { ContractError } from '../../src/shared/validation'

const coreSql = readFileSync(new URL('../../src/shared/contracts/001-core.sql', import.meta.url), 'utf8')
const runnerSql = readFileSync(new URL('../../src/shared/contracts/002-runner.sql', import.meta.url), 'utf8')
const fixtures: { queue: RequestQueue; db: Database.Database }[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => { for (const s of fixtures.splice(0)) { s.queue.close(); s.db.close() }; vi.useRealTimers() })

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup(options: {
  preflight?: (task: string, resources: Record<string, any>[]) => Promise<void>
  canAdmit?: (task: string, request: string, db: Database.Database) => boolean
} = {}) {
  const db = new Database(':memory:'); db.exec(coreSql); db.exec(runnerSql)
  db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Task','active',1)").run()
  let available = true, revision = 1, runSequence = 0
  const selection = vi.fn((id: string) => ({ id, revision }))
  const validate = vi.fn((task: string, id: string) => {
    const row = db.prepare('SELECT r.id,r.display_name,r.byte_length,r.media_type,r.sha256 FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? AND r.id=?').get(task, id) as Record<string, any> | undefined
    if (!row) throw new ContractError('REQUEST_MATERIAL_UNAVAILABLE', 'Resource unavailable')
    return row
  })
  const start = vi.fn((task: string, _text: string, _config: string, _attachments: Record<string, any>[], request: string) => db.transaction(() => {
    const run = `run-${++runSequence}`
    db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,?,?,'running','epoch','{}','{}','time')").run(run, task, request)
    db.prepare("UPDATE requests SET state='started' WHERE id=? AND state='queued'").run(request)
    return run
  })())
  const admit = options.canAdmit ? vi.fn((task: string, request: string) => options.canAdmit!(task, request, db)) : undefined
  const queue = new RequestQueue(db, 'epoch', selection, validate, start, () => available, options.preflight, admit)
  fixtures.push({ db, queue })
  const submit = (extra: Record<string, unknown> = {}) => queue.handle({ type: 'request.submit', task_id: 'task', text: 'original request', model_config_id: 'model', resource_ids: [], import_ids: [], ...extra })
  const status = (request: string) => queue.handle({ type: 'request.status', task_id: 'task', request_id: request })
  const resource = (id = 'large', bytes = 262145) => {
    db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(id, id, '0'.repeat(64), bytes, 'text/plain', id, 'time')
    db.prepare("INSERT INTO task_resources VALUES ('task',?)").run(id)
    return id
  }
  const materialImport = (id = 'import', ended = false) => {
    db.prepare("INSERT INTO actions(id,task_id,kind,state,result,source_json,request_json,commit_valid,created_at) VALUES (?,'task','invocation',?,?,'{}',?,1,'time')").run(id, ended ? 'ended' : 'registered', ended ? 'failure' : null, JSON.stringify({ type: 'material.import', display_name: id }))
    return id
  }
  const finish = (run: string) => db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(run)
  return { db, queue, submit, status, start, selection, validate, resource, materialImport, finish, admit, available: (value: boolean) => { available = value }, changeConfiguration: () => { revision++ } }
}

it('lets a ready request pass an importing request without changing its original bindings', () => {
  const s = setup(), operation = s.materialImport(), a = s.submit({ text: 'wait for my material', import_ids: [operation] })
  const original = s.db.prepare('SELECT input_json,config_selection_json FROM requests WHERE id=?').get(a.request_id)
  const b = s.submit({ text: 'independent ready goal' })
  expect(a.state).toBe('queued'); expect(b.state).toBe('started')
  expect(s.db.prepare('SELECT input_json,config_selection_json FROM requests WHERE id=?').get(a.request_id)).toEqual(original)
  expect(s.start).toHaveBeenCalledWith('task', 'independent ready goal', 'model', [], b.request_id)
})

it('holds large-material verification per request and rechecks single-Run admission after it resolves', async () => {
  const hold = deferred(), preflight = vi.fn(() => hold.promise), s = setup({ preflight })
  const a = s.submit({ resource_ids: [s.resource()] }), b = s.submit()
  expect(a.state).toBe('queued'); expect(b.state).toBe('started'); expect(s.queue.busy()).toBe(true)
  await vi.advanceTimersByTimeAsync(501)
  expect(preflight).toHaveBeenCalledTimes(1)
  hold.resolve(); await vi.advanceTimersByTimeAsync(0)
  expect(s.status(a.request_id).state).toBe('queued'); expect(s.queue.busy()).toBe(false)
  s.finish(b.run_id); await vi.advanceTimersByTimeAsync(251)
  expect(s.status(a.request_id).state).toBe('started')
  expect(s.start.mock.calls.filter(call => call[4] === a.request_id)).toHaveLength(1)
})

it('allows independent preflights in the same Task and keeps busy until each request finishes', async () => {
  const aHold = deferred(), bHold = deferred(), s = setup({ preflight: (_task, resources) => resources[0]!.id === 'a' ? aHold.promise : bHold.promise })
  const a = s.submit({ resource_ids: [s.resource('a')] }), b = s.submit({ resource_ids: [s.resource('b')] })
  expect([a.state, b.state]).toEqual(['queued', 'queued'])
  aHold.resolve(); await vi.advanceTimersByTimeAsync(0)
  expect(s.status(a.request_id).state).toBe('started'); expect(s.queue.busy()).toBe(true)
  bHold.resolve(); await vi.advanceTimersByTimeAsync(0)
  expect(s.status(b.request_id).state).toBe('queued'); expect(s.queue.busy()).toBe(false)
})

it('uses the host Run limit before preflight and immediately before each start', async () => {
  const s = setup({ canAdmit: (task, _request, db) => (db.prepare("SELECT count(*) n FROM runs WHERE task_id=? AND state IN ('running','waiting')").get(task) as { n: number }).n < RUNNER_LIMITS.admission.producer_runs_per_task })
  const a = s.submit(), b = s.submit(), c = s.submit()
  expect([a.state, b.state, c.state]).toEqual(['started', 'started', 'queued'])
  s.db.prepare("UPDATE runs SET state='waiting',wait_reason='unknown' WHERE id=?").run(a.run_id)
  await vi.advanceTimersByTimeAsync(251)
  expect(s.status(c.request_id).state).toBe('queued')
  s.finish(b.run_id); await vi.advanceTimersByTimeAsync(251)
  expect(s.status(c.request_id).state).toBe('started')
  expect(s.admit).toHaveBeenCalledWith('task', c.request_id)
})

it('does not start a request when host admission is lost at the final recheck', async () => {
  const s = setup({ canAdmit: () => true })
  s.admit!.mockReturnValueOnce(true).mockReturnValueOnce(false)
  const request = s.submit()
  expect(request.state).toBe('queued'); expect(s.start).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(251)
  expect(s.status(request.request_id).state).toBe('started')
  expect(s.start).toHaveBeenCalledTimes(1)
})

it.each(['call', 'cleanup'] as const)('keeps the legacy %s guard and lets an explicit host own resource admission', kind => {
  for (const host of [false, true]) {
    const s = setup(host ? { canAdmit: () => true } : {})
    if (kind === 'call') s.db.prepare("INSERT INTO calls(id,task_id,capability_id,state,dispatch,delivery,input_json,limits_json,commit_valid,created_at) VALUES ('call','task','tool','executing','sent','pending','{}','{}',1,'time')").run()
    else s.db.prepare("INSERT INTO cleanup_jobs(id,task_id,owner_kind,owner_id,necessary,state,detail_json) VALUES ('cleanup','task','call','call',1,'pending','{}')").run()
    expect(s.submit().state).toBe(host ? 'started' : 'queued')
  }
})

it.each(['cancel', 'configuration', 'epoch', 'task', 'resource'] as const)('does not revive a preflight request after its %s binding changes', async mode => {
  const hold = deferred(), s = setup({ preflight: () => hold.promise }), a = s.submit({ resource_ids: [s.resource()] })
  if (mode === 'cancel') s.queue.handle({ type: 'request.cancel', task_id: 'task', request_id: a.request_id })
  else if (mode === 'configuration') { s.changeConfiguration(); s.queue.invalidateConfiguration() }
  else if (mode === 'epoch') s.db.prepare("UPDATE requests SET input_json=json_set(input_json,'$.epoch','different') WHERE id=?").run(a.request_id)
  else if (mode === 'task') { s.db.prepare("UPDATE tasks SET state='stopped' WHERE id='task'").run(); s.queue.cancelTask('task') }
  else s.db.prepare("DELETE FROM task_resources WHERE task_id='task' AND resource_id='large'").run()
  hold.resolve(); await vi.advanceTimersByTimeAsync(0)
  expect(s.start).not.toHaveBeenCalled(); expect(s.queue.busy()).toBe(false)
  expect(s.status(a.request_id).state).not.toBe('started')
})

it('rechecks an unannounced configuration change when preflight returns', async () => {
  const hold = deferred(), s = setup({ preflight: () => hold.promise }), a = s.submit({ resource_ids: [s.resource()] })
  s.changeConfiguration(); hold.resolve(); await vi.advanceTimersByTimeAsync(0)
  expect(s.status(a.request_id)).toMatchObject({ state: 'confirmation_required', code: 'REQUEST_CONFIGURATION_CHANGED' })
  expect(s.start).not.toHaveBeenCalled()
})

it('confines preflight failure to its original request while the next request runs', async () => {
  const hold = deferred(), s = setup({ preflight: () => hold.promise }), a = s.submit({ resource_ids: [s.resource()] }), b = s.submit()
  hold.reject(new ContractError('RESOURCE_CORRUPT', 'Damaged material')); await vi.advanceTimersByTimeAsync(0)
  expect(s.status(a.request_id)).toMatchObject({ state: 'confirmation_required', code: 'RESOURCE_CORRUPT' })
  expect(s.status(b.request_id).state).toBe('started'); expect(s.start).toHaveBeenCalledTimes(1)
})

it('keeps a failed original request unconfirmed while an independent request starts', async () => {
  const s = setup(), a = s.submit({ import_ids: [s.materialImport('failed', true)] }), b = s.submit()
  expect([a.state, b.state]).toEqual(['confirmation_required', 'started'])
  s.finish(b.run_id); await vi.advanceTimersByTimeAsync(251)
  expect(s.status(a.request_id).state).toBe('confirmation_required')
  const confirmed = s.queue.handle({ type: 'request.resolve', task_id: 'task', request_id: a.request_id, model_config_id: 'model', use_successful: true })
  expect(confirmed.state).toBe('started')
})

it('does not dispatch while storage availability is lost during preflight', async () => {
  const hold = deferred(), s = setup({ preflight: () => hold.promise }), a = s.submit({ resource_ids: [s.resource()] })
  s.available(false); hold.resolve(); await vi.advanceTimersByTimeAsync(0)
  expect(s.status(a.request_id).state).toBe('queued'); expect(s.start).not.toHaveBeenCalled()
  s.available(true); await vi.advanceTimersByTimeAsync(251)
  expect(s.status(a.request_id).state).toBe('started')
})

it('ignores a failed late preflight after its original request has been deleted', async () => {
  const hold = deferred(), s = setup({ preflight: () => hold.promise }), a = s.submit({ resource_ids: [s.resource()] })
  s.db.prepare('DELETE FROM requests WHERE id=?').run(a.request_id)
  hold.reject(Error('late result')); await vi.advanceTimersByTimeAsync(0)
  expect(s.queue.busy()).toBe(false); expect(s.start).not.toHaveBeenCalled()
})

it('scans the persistent queue in bounded pages across Tasks', async () => {
  const s = setup(); s.available(false)
  for (let n = 0; n < 55; n++) {
    const task = `task-${n}`
    s.db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES (?,'Task','active',1)").run(task)
    s.submit({ task_id: task })
  }
  s.available(true); await vi.advanceTimersByTimeAsync(251)
  expect(s.start).toHaveBeenCalledTimes(50)
  await vi.advanceTimersByTimeAsync(250)
  expect(s.start).toHaveBeenCalledTimes(55)
})

it('revisits an earlier wait while new requests keep extending the queue', async () => {
  let blocked: string | undefined, ordinal = 0
  const s = setup({ canAdmit: (_task, request) => request !== blocked })
  const add = (count: number) => {
    s.available(false)
    for (let n = 0; n < count; n++) {
      const task = `task-${++ordinal}`
      s.db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES (?,'Task','active',1)").run(task)
      const request = s.submit({ task_id: task })
      if (ordinal === 1) blocked = request.request_id
    }
    s.available(true)
  }
  add(55); await vi.advanceTimersByTimeAsync(251)
  const original = blocked!
  expect(s.start).toHaveBeenCalledTimes(49)
  add(50); blocked = undefined; await vi.advanceTimersByTimeAsync(250)
  expect(s.start).toHaveBeenCalledTimes(54)
  add(50); await vi.advanceTimersByTimeAsync(250)
  expect(s.db.prepare('SELECT state FROM requests WHERE id=?').get(original)).toEqual({ state: 'started' })
  expect(s.start).toHaveBeenCalledTimes(104)
})
