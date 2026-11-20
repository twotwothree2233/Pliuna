import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import coreSchema from '../../src/shared/contracts/001-core.sql?raw'
import type { ExecutionScope } from '../../src/shared/contracts.generated'
import type { PluginIdentity } from '../../src/runtime/plugins/process'
import { RuntimeStore } from '../../src/runtime/store'

const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

const owner = (): Extract<ExecutionScope, { purpose: 'production' }> => ({ task_id: 'task', run_id: 'run', work_id: 'work', attempt_id: 'attempt', role: 'producer', purpose: 'production', request_id: 'request', intent_revision: 1 })
type ToolBoundary = { pluginToolCallback(identity: PluginIdentity, method: string, params: Record<string, unknown>): unknown }

function setup(storedOwner: ExecutionScope | null = owner(), currentOwner: ExecutionScope | null = owner(), callId: string | null = 'parent') {
  const db = new Database(':memory:')
  databases.push(db)
  db.exec(coreSchema)
  db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Work','active',1)").run()
  db.prepare("INSERT INTO runs(id,task_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES ('run','task','running','epoch','{}','{}','now')").run()
  const insert = db.prepare("INSERT INTO calls(id,task_id,run_id,parent_call_id,capability_id,state,dispatch,delivery,input_json,limits_json,result_json,commit_valid,created_at) VALUES (?,'task','run',?,'plugin:echo','executing','sent','pending','{}',?,'{\"private\":\"result\"}',1,'now')")
  insert.run('parent', null, '{}')
  insert.run('sibling', null, '{}')
  insert.run('child', 'parent', JSON.stringify(storedOwner ? { owner: storedOwner } : {}))
  const valid = vi.fn()
  const active = { task: 'task', instance: 'instance', controller: new AbortController(), source: { run_id: 'run', valid, ...(currentOwner ? { owner: currentOwner } : {}) } }
  const sources = new Map(callId ? [[callId, active]] : [])
  const cancel = vi.fn((id: string) => { db.prepare('UPDATE calls SET commit_valid=0 WHERE id=?').run(id) })
  const status = vi.fn((id: string) => ({ call_id: id, result: JSON.parse((db.prepare('SELECT result_json FROM calls WHERE id=?').get(id) as { result_json: string }).result_json) }))
  const host: ToolBoundary = Object.assign(Object.create(RuntimeStore.prototype), {
    db,
    epoch: 'epoch',
    pluginChildOwners: new Map([['child', 'instance']]),
    pluginProcesses: { live: vi.fn(() => true) },
    pluginCalls: { source: vi.fn((id: string) => sources.get(id)), cancel, status },
    qualifyPlugin: vi.fn(),
    plugins: { available: vi.fn(() => true) }
  })
  const identity: PluginIdentity = { instance_id: 'instance', digest: 'digest', task_id: 'task', call_id: callId }
  return { db, valid, cancel, status, sources, invoke: (method: string) => host.pluginToolCallback(identity, method, { call_id: 'child' }) }
}

it.each(['tools.get', 'tools.cancel'])('rejects %s across work owners before reading or cancelling the child', method => {
  const s = setup(owner(), { ...owner(), work_id: 'other-work', attempt_id: 'other-attempt' }, 'sibling')
  expect(() => s.invoke(method)).toThrow()
  expect(s.status).not.toHaveBeenCalled()
  expect(s.cancel).not.toHaveBeenCalled()
  expect(s.db.prepare("SELECT commit_valid FROM calls WHERE id='child'").get()).toEqual({ commit_valid: 1 })
})

it.each(['tools.get', 'tools.cancel'])('checks the complete owner before %s, including the request revision', method => {
  const s = setup(owner(), { ...owner(), intent_revision: 2 }, 'sibling')
  expect(() => s.invoke(method)).toThrow()
  expect(s.status).not.toHaveBeenCalled()
  expect(s.cancel).not.toHaveBeenCalled()
})

it.each(['tools.get', 'tools.cancel'])('allows %s for the same owner with a different property order', method => {
  const current: ExecutionScope = { intent_revision: 1, request_id: 'request', purpose: 'production', role: 'producer', attempt_id: 'attempt', work_id: 'work', run_id: 'run', task_id: 'task' }
  const s = setup(owner(), current, 'sibling')
  expect(s.invoke(method)).toEqual({ call_id: 'child', result: { private: 'result' } })
  expect(s.status).toHaveBeenCalledOnce()
  expect(s.cancel).toHaveBeenCalledTimes(method === 'tools.cancel' ? 1 : 0)
})

it.each(['tools.get', 'tools.cancel'])('rejects %s from an idle shared instance for an owned child', method => {
  const s = setup(owner(), null, null)
  expect(() => s.invoke(method)).toThrow()
  expect(s.status).not.toHaveBeenCalled()
  expect(s.cancel).not.toHaveBeenCalled()
})

it.each(['tools.get', 'tools.cancel'])('preserves %s for an older child without an execution owner', method => {
  const s = setup(null, null, null)
  expect(s.invoke(method)).toEqual({ call_id: 'child', result: { private: 'result' } })
  expect(s.status).toHaveBeenCalledOnce()
  expect(s.cancel).toHaveBeenCalledTimes(method === 'tools.cancel' ? 1 : 0)
})
