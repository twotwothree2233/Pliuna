import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import type { RequestAccounting } from '../../src/runtime/model/accounting'
import { RunnerBudgetLedger, type RunnerBudgetLimits } from '../../src/runtime/runner/budget'
import { RunnerBudgetAccounting } from '../../src/runtime/runner/budget-accounting'

const coreSql = readFileSync(new URL('../../src/shared/contracts/001-core.sql', import.meta.url), 'utf8')
const runnerSql = readFileSync(new URL('../../src/shared/contracts/002-runner.sql', import.meta.url), 'utf8')
const caps: RunnerBudgetLimits = { model_requests: 4, tool_requests: 2, tokens: 100, wall_ms: 1000 }
function setup() {
  const db = new Database(':memory:'); db.exec(coreSql); db.exec(runnerSql)
  db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Task','active',1),('other','Other','active',1)").run()
  db.prepare("INSERT INTO requests(id,task_id,state,config_selection_json,input_json,created_at) VALUES ('goal','task','started','{}','{}','2026-01-01T00:00:00.000Z')").run()
  let now = 1000
  const ledger = new RunnerBudgetLedger(db, () => now)
  ledger.create({ budget_id: 'budget', task_id: 'task', purpose: 'production', request_id: 'goal', limits: caps })
  ledger.create({ budget_id: 'composition', task_id: 'task', purpose: 'composition', request_id: null, limits: caps })
  const accounting = new RunnerBudgetAccounting(ledger, { task_id: 'task', budget_id: 'budget' })
  return { db, ledger, accounting, advance: (ms: number) => { now += ms } }
}
function event(phase: RequestAccounting['phase'], fields: Partial<RequestAccounting> = {}): RequestAccounting {
  return {
    version: 2, output_policy: 'configured', request_id: 'model-request', model_id: 'model', model_revision: 1, purpose: 'main', phase,
    at: '2026-01-01T00:00:00.000Z', input_bytes: 20, estimated_input_tokens: 20, output_reserve: 30, context_tokens: 100,
    components: { rules: 0, tools: 0, history: 0, summary: 0, current: 20, tool_results: 0, envelope: 0 }, usage: null, error: null, ...fields
  }
}
function attempt(db: Database.Database, runId: string, attemptId: string): void {
  db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,'task','goal','completed','epoch','{}','{}','2026-01-01T00:00:00.000Z')").run(runId)
  db.prepare("INSERT INTO runner_runs(run_id,task_id,purpose,request_id,intent_revision,budget_id,payload_json) VALUES (?,'task','production','goal',1,'budget','{}')").run(runId)
  db.prepare("INSERT INTO runner_work(work_id,task_id,run_id,plan_revision,state,payload_json) VALUES (?,'task',?,1,'completed','{}')").run(`work-${attemptId}`, runId)
  db.prepare("INSERT INTO runner_attempts(attempt_id,task_id,work_id,run_id,attempt_number,state,payload_json) VALUES (?,'task',?,?,1,'completed','{}')").run(attemptId, `work-${attemptId}`, runId)
}

it('reserves before dispatch and replaces the estimate with actual model usage once', () => {
  const { db, ledger, accounting } = setup()
  try {
    const reserved = accounting.model(event('reserved'))
    expect(reserved).toMatchObject({ reservation_id: 'model-request', operation_id: 'model-request', state: 'reserved', dispatched_at: null, reserved: { model_requests: 1, tool_requests: 0, tokens: 50 } })
    expect(accounting.model(event('reserved'))).toEqual(reserved)
    expect(accounting.model(event('dispatched')).dispatched_at).not.toBeNull()
    const settled = accounting.model(event('completed', { usage: { prompt_tokens: 11, completion_tokens: 9 } }))
    expect(settled).toMatchObject({ state: 'settled', usage: { model_requests: 1, tool_requests: 0, tokens: 20 } })
    expect(accounting.model(event('completed', { usage: { prompt_tokens: 11, completion_tokens: 9 } }))).toEqual(settled)
    expect(ledger.snapshot('budget').total).toEqual({ model_requests: 1, tool_requests: 0, tokens: 20 })
  } finally { db.close() }
})

it('records main, summary, correction and approval usage without a cumulative request cap', () => {
  const { db, ledger, accounting } = setup()
  try {
    for (const purpose of ['main', 'summary', 'summary_correction', 'approval'] as const) {
      const fields = { request_id: purpose, purpose, estimated_input_tokens: 5, output_reserve: 5 }
      accounting.model(event('reserved', fields)); accounting.model(event('dispatched', fields))
      accounting.model(event('completed', { ...fields, usage: { prompt_tokens: 4, completion_tokens: 1 } }))
    }
    expect(ledger.snapshot('budget').total).toEqual({ model_requests: 4, tool_requests: 0, tokens: 20 })
    expect(accounting.model(event('reserved', { request_id: 'extra' })).state).toBe('reserved')
    expect(ledger.snapshot('budget').total.model_requests).toBe(5)
    expect(ledger.snapshot('composition').total.model_requests).toBe(0)
  } finally { db.close() }
})

it('shares unsettled accounting between adapters without a cumulative token cap', () => {
  const { db, ledger, accounting } = setup()
  try {
    const sibling = new RunnerBudgetAccounting(ledger, { task_id: 'task', budget_id: 'budget' })
    accounting.model(event('reserved', { output_reserve: 60 }))
    expect(sibling.model(event('reserved', { request_id: 'sibling' })).state).toBe('reserved')
    expect(ledger.snapshot('budget').total.tokens).toBe(130)
    accounting.model(event('dispatched', { output_reserve: 60 }))
    accounting.model(event('completed', { output_reserve: 60, usage: { prompt_tokens: 10, completion_tokens: 5 } }))
    expect(sibling.model(event('reserved', { request_id: 'sibling' })).state).toBe('reserved')
    expect(ledger.snapshot('budget').total.tokens).toBe(65)
  } finally { db.close() }
})

it('releases a failed model request only while it is definitely undispatched', () => {
  const { db, ledger, accounting } = setup()
  try {
    accounting.model(event('reserved'))
    expect(accounting.model(event('failed', { error: 'MODEL_CANCELLED' })).state).toBe('released')
    expect(accounting.model(event('failed', { error: 'MODEL_CANCELLED' })).state).toBe('released')
    expect(ledger.snapshot('budget').total).toEqual({ model_requests: 0, tool_requests: 0, tokens: 0 })
    expect(() => accounting.model(event('dispatched'))).toThrow(expect.objectContaining({ code: 'BUDGET_RESERVATION_NOT_ACTIVE' }))
    expect(() => accounting.model(event('completed', { usage: { prompt_tokens: 1, completion_tokens: 1 } }))).toThrow(expect.objectContaining({ code: 'BUDGET_RESERVATION_RELEASED' }))
  } finally { db.close() }
})

it('retains unknown model usage across cancellation, elapsed time and reconstruction', () => {
  const { db, ledger, accounting, advance } = setup()
  try {
    accounting.model(event('reserved')); accounting.model(event('dispatched'))
    accounting.model(event('unknown', { error: 'MODEL_TIMEOUT' })); advance(2000)
    db.prepare("UPDATE tasks SET state='stopped' WHERE id='task'").run()
    const reconstructed = new RunnerBudgetAccounting(ledger, { task_id: 'task', budget_id: 'budget' })
    expect(reconstructed.model(event('failed', { error: 'MODEL_CANCELLED' })).state).toBe('unknown')
    expect(ledger.snapshot('budget')).toMatchObject({ unknown: { model_requests: 1, tokens: 50 } })
    expect(reconstructed.model(event('completed', { usage: { prompt_tokens: 10, completion_tokens: 8 } })).state).toBe('settled')
    expect(ledger.snapshot('budget')).toMatchObject({ unknown: { tokens: 0 }, total: { tokens: 18 } })
  } finally { db.close() }
})

it('retains completion without usage and settles errors with explicit provider usage', () => {
  const { db, ledger, accounting } = setup()
  try {
    accounting.model(event('reserved')); accounting.model(event('dispatched'))
    expect(accounting.model(event('completed')).state).toBe('unknown')
    expect(ledger.snapshot('budget').unknown.tokens).toBe(50)
    expect(accounting.model(event('unknown', { usage: { prompt_tokens: 7, completion_tokens: 2 }, error: 'INVALID_TOOL_ARGUMENTS' }))).toMatchObject({ state: 'settled', usage: { tokens: 9 } })
    expect(accounting.model(event('unknown')).state).toBe('settled')
    expect(accounting.model(event('completed')).state).toBe('settled')
  } finally { db.close() }
})

it('settles real usage above the former cumulative token cap', () => {
  const { db, ledger, accounting } = setup()
  try {
    accounting.model(event('reserved')); accounting.model(event('dispatched'))
    expect(accounting.model(event('completed', { usage: { prompt_tokens: 100, completion_tokens: 1 } })).state).toBe('settled')
    expect(ledger.query('model-request')).toMatchObject({ state: 'settled', usage: { tokens: 101 } })
    expect(accounting.model(event('unknown')).state).toBe('settled')
    expect(ledger.snapshot('budget').total.tokens).toBe(101)
  } finally { db.close() }
})

it('dispatches after the former wall deadline and retains unknown failed usage', () => {
  const { db, ledger, accounting, advance } = setup()
  try {
    accounting.model(event('reserved')); advance(1000)
    expect(accounting.model(event('dispatched')).dispatched_at).not.toBeNull()
    expect(accounting.model(event('failed')).state).toBe('unknown')
    expect(ledger.snapshot('budget').unknown.tokens).toBe(50)
  } finally { db.close() }
})

it('keeps one cumulative budget when different resumed attempts perform requests', () => {
  const { db, ledger } = setup()
  try {
    attempt(db, 'old-run', 'old-attempt'); attempt(db, 'new-run', 'new-attempt')
    const original = new RunnerBudgetAccounting(ledger, { task_id: 'task', budget_id: 'budget', attempt_id: 'old-attempt' })
    const resumed = new RunnerBudgetAccounting(ledger, { task_id: 'task', budget_id: 'budget', attempt_id: 'new-attempt' })
    original.model(event('reserved')); original.model(event('dispatched'))
    original.model(event('completed', { usage: { prompt_tokens: 20, completion_tokens: 20 } }))
    expect(resumed.model(event('reserved', { request_id: 'resumed-request' })).attempt_id).toBe('new-attempt')
    expect(ledger.snapshot('budget').total.tokens).toBe(90)
    expect(() => resumed.model(event('completed', { usage: { prompt_tokens: 1, completion_tokens: 1 } }))).toThrow(expect.objectContaining({ code: 'BUDGET_OWNER_MISMATCH' }))
    expect(() => resumed.model(event('reserved'))).toThrow(expect.objectContaining({ code: 'BUDGET_RESERVATION_CONFLICT' }))
  } finally { db.close() }
})

it('reserves, dispatches and settles known tool outcomes without model tokens', () => {
  const { db, ledger, accounting } = setup()
  try {
    const first = accounting.tool('read-operation', 'reserved')
    expect(accounting.tool('read-operation', 'reserved')).toEqual(first)
    accounting.tool('read-operation', 'dispatched')
    expect(accounting.tool('read-operation', 'completed')).toMatchObject({ state: 'settled', usage: { model_requests: 0, tool_requests: 1, tokens: 0 } })
    expect(accounting.tool('read-operation', 'completed').state).toBe('settled')
    accounting.tool('call-operation', 'reserved'); accounting.tool('call-operation', 'dispatched')
    expect(accounting.tool('call-operation', 'failed').state).toBe('settled')
    expect(ledger.snapshot('budget').total).toEqual({ model_requests: 0, tool_requests: 2, tokens: 0 })
    expect(accounting.tool('extra-operation', 'reserved').state).toBe('reserved')
    expect(ledger.snapshot('budget').total.tool_requests).toBe(3)
  } finally { db.close() }
})

it('keeps unknown tools occupied until their original operation has a known outcome', () => {
  const { db, ledger, accounting, advance } = setup()
  try {
    accounting.tool('call-operation', 'reserved'); accounting.tool('call-operation', 'dispatched')
    accounting.tool('call-operation', 'unknown'); advance(2000)
    const reconstructed = new RunnerBudgetAccounting(ledger, { task_id: 'task', budget_id: 'budget' })
    expect(reconstructed.tool('call-operation', 'unknown').state).toBe('unknown')
    expect(ledger.snapshot('budget').unknown.tool_requests).toBe(1)
    expect(() => reconstructed.tool('call-operation', 'dispatched')).toThrow(expect.objectContaining({ code: 'BUDGET_RESERVATION_NOT_ACTIVE' }))
    expect(reconstructed.tool('call-operation', 'failed')).toMatchObject({ state: 'settled', usage: { tool_requests: 1 } })
    expect(ledger.snapshot('budget').unknown.tool_requests).toBe(0)
  } finally { db.close() }
})

it('releases only a definitely undispatched tool failure', () => {
  const { db, ledger, accounting } = setup()
  try {
    accounting.tool('queued-operation', 'reserved')
    expect(accounting.tool('queued-operation', 'failed').state).toBe('released')
    expect(accounting.tool('queued-operation', 'failed').state).toBe('released')
    expect(ledger.snapshot('budget').total.tool_requests).toBe(0)
    expect(() => accounting.tool('queued-operation', 'unknown')).toThrow(expect.objectContaining({ code: 'BUDGET_RESERVATION_RELEASED' }))
  } finally { db.close() }
})

it('separates composition capacity and rejects foreign scopes or changed event amounts', () => {
  const { db, ledger, accounting } = setup()
  try {
    expect(() => new RunnerBudgetAccounting(ledger, { task_id: 'other', budget_id: 'budget' })).toThrow(expect.objectContaining({ code: 'BUDGET_OWNER_MISMATCH' }))
    const composition = new RunnerBudgetAccounting(ledger, { task_id: 'task', budget_id: 'composition' })
    accounting.model(event('reserved'))
    expect(() => composition.model(event('completed', { usage: { prompt_tokens: 1, completion_tokens: 1 } }))).toThrow(expect.objectContaining({ code: 'BUDGET_OWNER_MISMATCH' }))
    expect(() => accounting.model(event('dispatched', { output_reserve: 31 }))).toThrow(expect.objectContaining({ code: 'BUDGET_RESERVATION_CONFLICT' }))
    expect(() => accounting.tool('model-request', 'completed')).toThrow(expect.objectContaining({ code: 'BUDGET_RESERVATION_CONFLICT' }))
    composition.model(event('reserved', { request_id: 'composition-request', output_reserve: 80 }))
    expect(ledger.snapshot('composition').total.tokens).toBe(100)
    expect(ledger.snapshot('budget').total.tokens).toBe(50)
  } finally { db.close() }
})

it('captures the original scope so caller mutation cannot redirect later accounting', () => {
  const { db, ledger } = setup()
  try {
    const scope = { task_id: 'task', budget_id: 'budget' }
    const accounting = new RunnerBudgetAccounting(ledger, scope)
    accounting.model(event('reserved')); scope.budget_id = 'composition'
    accounting.model(event('completed', { usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    expect(ledger.snapshot('budget').total.tokens).toBe(2)
    expect(ledger.snapshot('composition').total.tokens).toBe(0)
  } finally { db.close() }
})

it('accounts service-default output using known input until provider usage arrives', () => {
  const { db, ledger, accounting } = setup()
  try {
    const fields = { output_policy: 'service-default' as const, output_reserve: null }
    expect(accounting.model(event('reserved', fields)).reserved.tokens).toBe(20)
    accounting.model(event('dispatched', fields))
    expect(accounting.model(event('completed', fields)).state).toBe('unknown')
    expect(ledger.snapshot('budget').unknown.tokens).toBe(20)
    expect(accounting.model(event('completed', { ...fields, usage: { prompt_tokens: 25, completion_tokens: 150 } }))).toMatchObject({ state: 'settled', usage: { tokens: 175 } })
    expect(ledger.snapshot('budget')).toMatchObject({ unknown: { tokens: 0 }, total: { tokens: 175 } })
  } finally { db.close() }
})

it('rejects missing reservations and unsafe token evidence without partial installs', () => {
  const { db, ledger, accounting } = setup()
  try {
    expect(() => accounting.model(event('dispatched'))).toThrow(expect.objectContaining({ code: 'BUDGET_RESERVATION_NOT_FOUND' }))
    expect(() => accounting.tool('missing-operation', 'completed')).toThrow(expect.objectContaining({ code: 'BUDGET_RESERVATION_NOT_FOUND' }))
    expect(() => accounting.model(event('reserved', { estimated_input_tokens: Number.MAX_SAFE_INTEGER }))).toThrow(expect.objectContaining({ code: 'BUDGET_EVIDENCE_INVALID' }))
    expect(ledger.snapshot('budget').total).toEqual({ model_requests: 0, tool_requests: 0, tokens: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM runner_budget_reservations').get()).toEqual({ count: 0 })
  } finally { db.close() }
})
