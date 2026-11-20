import Database from 'better-sqlite3'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { RunnerBudgetLedger, type RunnerBudgetLimits } from '../../src/runtime/runner/budget'

const coreSql = readFileSync(new URL('../../src/shared/contracts/001-core.sql', import.meta.url), 'utf8')
const runnerSql = readFileSync(new URL('../../src/shared/contracts/002-runner.sql', import.meta.url), 'utf8')
const caps: RunnerBudgetLimits = { model_requests: 4, tool_requests: 4, tokens: 100, wall_ms: 1000 }
function prepare(db: Database.Database): void {
  db.exec(coreSql); db.exec(runnerSql)
  db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Task','active',1)").run()
  db.prepare("INSERT INTO requests(id,task_id,state,config_selection_json,input_json,created_at) VALUES ('goal','task','started','{}','{}','2026-01-01T00:00:00.000Z')").run()
}
function setup() {
  const db = new Database(':memory:'); prepare(db)
  let time = 1000
  const ledger = new RunnerBudgetLedger(db, () => time)
  ledger.create({ budget_id: 'budget', task_id: 'task', purpose: 'production', request_id: 'goal', limits: caps })
  return { db, ledger, clock: () => time, advance: (ms: number) => { time += ms } }
}
function attempt(db: Database.Database, runId: string, attemptId: string): void {
  db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,'task','goal','completed','epoch','{}','{}','2026-01-01T00:00:00.000Z')").run(runId)
  db.prepare("INSERT INTO runner_runs(run_id,task_id,purpose,request_id,intent_revision,budget_id,payload_json) VALUES (?,'task','production','goal',1,'budget','{}')").run(runId)
  db.prepare("INSERT INTO runner_work(work_id,task_id,run_id,plan_revision,state,payload_json) VALUES (?,'task',?,1,'completed','{}')").run(`work-${attemptId}`, runId)
  db.prepare("INSERT INTO runner_attempts(attempt_id,task_id,work_id,run_id,attempt_number,state,payload_json) VALUES (?,'task',?,?,1,'completed','{}')").run(attemptId, `work-${attemptId}`, runId)
}

it('records cumulative usage without imposing model, tool or token allowances', () => {
  const { db, ledger } = setup()
  try {
    ledger.reserve('a', 'budget', 'model-a', { model_requests: 1, tokens: 60 })
    expect(ledger.reserve('b', 'budget', 'model-b', { model_requests: 1, tokens: 60 }).state).toBe('reserved')
    expect(ledger.snapshot('budget').total.tokens).toBe(120)
    ledger.markDispatched('a'); ledger.settle('a', { tokens: 40 })
    ledger.reserve('b', 'budget', 'model-b', { model_requests: 1, tokens: 60 })
    ledger.markDispatched('b'); ledger.settle('b', { tokens: 50 })
    expect(ledger.snapshot('budget').total).toEqual({ model_requests: 2, tool_requests: 0, tokens: 90 })
    expect(ledger.reserve('c', 'budget', 'model-c', { model_requests: 5, tool_requests: 5, tokens: 110 }).state).toBe('reserved')
    expect(ledger.snapshot('budget').total).toEqual({ model_requests: 7, tool_requests: 5, tokens: 200 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM runner_budget_reservations').get()).toEqual({ count: 3 })
    expect(db.prepare('SELECT limits_json FROM runner_budgets').get()).toEqual({ limits_json: '{}' })
    expect(ledger.budget('budget')).not.toHaveProperty('limits')
  } finally { db.close() }
})

it('retains cumulative accounting across resumed Runs and rejects a new ownership identity', () => {
  const { db, ledger, clock } = setup()
  try {
    attempt(db, 'original', 'attempt-original'); attempt(db, 'resumed', 'attempt-resumed')
    ledger.reserve('a', 'budget', 'model-a', { model_requests: 1, tokens: 70 }, 'attempt-original')
    ledger.settle('a', { tokens: 70 })
    const resumed = new RunnerBudgetLedger(db, clock)
    expect(resumed.reserve('b', 'budget', 'model-b', { model_requests: 1, tokens: 30 }, 'attempt-resumed').attempt_id).toBe('attempt-resumed')
    expect(resumed.snapshot('budget').total.tokens).toBe(100)
    expect(() => resumed.create({ budget_id: 'fresh', task_id: 'task', purpose: 'production', request_id: 'goal', limits: caps })).toThrow(expect.objectContaining({ code: 'BUDGET_ID_CONFLICT' }))
    expect(resumed.create({ budget_id: 'budget', task_id: 'task', purpose: 'production', request_id: 'goal', limits: { ...caps, tokens: 1000 } })).toEqual(resumed.budget('budget'))
    expect(() => resumed.create({ budget_id: 'budget', task_id: 'task', purpose: 'composition', request_id: null })).toThrow(expect.objectContaining({ code: 'BUDGET_ID_CONFLICT' }))
    expect(() => resumed.reserve('foreign', 'budget', 'model-foreign', { model_requests: 1 }, 'missing')).toThrow(expect.objectContaining({ code: 'BUDGET_OWNER_MISMATCH' }))
  } finally { db.close() }
})

it('returns original operation reservations and rejects changed attempts, identity bindings or usage', () => {
  const { db, ledger } = setup()
  try {
    const original = ledger.reserve('a', 'budget', 'model-a', { model_requests: 1, tokens: 20 })
    expect(ledger.reserve('a', 'budget', 'model-a', { tokens: 20, model_requests: 1 })).toEqual(original)
    expect(ledger.reserve('another-id', 'budget', 'model-a', { model_requests: 1, tokens: 20 })).toEqual(original)
    expect(() => ledger.reserve('a', 'budget', 'another-operation', { tokens: 20 })).toThrow(expect.objectContaining({ code: 'BUDGET_RESERVATION_CONFLICT' }))
    expect(() => ledger.reserve('another-id', 'budget', 'model-a', { model_requests: 1, tokens: 21 })).toThrow(expect.objectContaining({ code: 'BUDGET_RESERVATION_CONFLICT' }))
    ledger.markDispatched('a')
    const settled = ledger.settle('a', { tokens: 12 })
    expect(ledger.settle('a', { tokens: 12 })).toEqual(settled)
    expect(() => ledger.settle('a', { tokens: 13 })).toThrow(expect.objectContaining({ code: 'BUDGET_USAGE_CONFLICT' }))
    expect(() => ledger.settle('a', { tokens: 12, model_requests: 0 })).toThrow(expect.objectContaining({ code: 'BUDGET_USAGE_CONFLICT' }))
    expect(ledger.markUnknown('a').state).toBe('settled')
    expect(ledger.snapshot('budget').total).toEqual({ model_requests: 1, tool_requests: 0, tokens: 12 })
  } finally { db.close() }
})

it('keeps unknown usage reserved until the original operation is reconciled', () => {
  const { db, ledger, advance } = setup()
  try {
    ledger.reserve('a', 'budget', 'model-a', { model_requests: 1, tokens: 100 })
    ledger.markDispatched('a'); ledger.markUnknown('a'); advance(10000)
    expect(ledger.snapshot('budget')).toMatchObject({ unknown: { model_requests: 1, tool_requests: 0, tokens: 100 } })
    expect(ledger.reserve('b', 'budget', 'model-b', { tokens: 1 }).state).toBe('reserved')
    expect(() => ledger.releaseOnlyUndispatched('a')).toThrow(expect.objectContaining({ code: 'BUDGET_RECONCILIATION_REQUIRED' }))
    const settled = ledger.settle('a', { tokens: 40 })
    expect(settled).toMatchObject({ state: 'settled', usage: { model_requests: 1, tokens: 40 } })
    expect(ledger.snapshot('budget').unknown.tokens).toBe(0)
  } finally { db.close() }
})

it('releases only operations that never crossed the durable dispatch barrier', () => {
  const { db, ledger } = setup()
  try {
    ledger.reserve('queued', 'budget', 'queued-operation', { model_requests: 1, tokens: 100 })
    const released = ledger.releaseOnlyUndispatched('queued')
    expect(released.state).toBe('released')
    expect(ledger.releaseOnlyUndispatched('queued')).toEqual(released)
    expect(ledger.snapshot('budget').total).toEqual({ model_requests: 0, tool_requests: 0, tokens: 0 })
    expect(ledger.reserve('same', 'budget', 'queued-operation', { model_requests: 1, tokens: 100 }).state).toBe('released')
    expect(() => ledger.markDispatched('queued')).toThrow(expect.objectContaining({ code: 'BUDGET_RESERVATION_NOT_ACTIVE' }))
    ledger.reserve('dispatched', 'budget', 'sent-operation', { model_requests: 1, tokens: 100 })
    ledger.markDispatched('dispatched')
    expect(() => ledger.releaseOnlyUndispatched('dispatched')).toThrow(expect.objectContaining({ code: 'BUDGET_RECONCILIATION_REQUIRED' }))
  } finally { db.close() }
})

it('settles actual provider usage above historical caps and permits more operations', () => {
  const { db, ledger } = setup()
  try {
    ledger.reserve('a', 'budget', 'model-a', { model_requests: 1, tokens: 80 }); ledger.markDispatched('a')
    expect(ledger.settle('a', { tokens: 101 }).state).toBe('settled')
    expect(ledger.query('a')).toMatchObject({ state: 'settled', usage: { tokens: 101 } })
    expect(ledger.snapshot('budget')).toMatchObject({ total: { tokens: 101 } })
    expect(ledger.reserve('b', 'budget', 'model-b', { tool_requests: 5 }).state).toBe('reserved')
  } finally { db.close() }
})

it('ignores all four persisted legacy caps across reconstruction without rewriting their evidence', () => {
  const { db, ledger, advance, clock } = setup()
  try {
    db.prepare("UPDATE runner_budgets SET limits_json=? WHERE budget_id='budget'").run(JSON.stringify(caps))
    advance(999)
    ledger.reserve('queued', 'budget', 'queued-operation', { model_requests: 1, tokens: 1 })
    advance(1)
    const resumed = new RunnerBudgetLedger(db, clock)
    expect(resumed.snapshot('budget')).not.toHaveProperty('expired')
    expect(resumed.reserve('new', 'budget', 'new-operation', { model_requests: 5, tool_requests: 5, tokens: 101 }).state).toBe('reserved')
    expect(resumed.markDispatched('queued').dispatched_at).not.toBeNull()
    expect(resumed.budget('budget').created_at).toBe(new Date(1000).toISOString())
    expect(db.prepare("SELECT limits_json FROM runner_budgets WHERE budget_id='budget'").get()).toEqual({ limits_json: JSON.stringify(caps) })
    expect(() => resumed.releaseOnlyUndispatched('queued')).toThrow(expect.objectContaining({ code: 'BUDGET_RECONCILIATION_REQUIRED' }))
  } finally { db.close() }
})

it('coordinates reservation identities across separate database connections without an allowance gate', () => {
  const root = mkdtempSync(join(tmpdir(), 'pliuna-runner-budget-')), file = join(root, 'business.sqlite')
  const first = new Database(file), second = new Database(file, { timeout: 0 })
  try {
    prepare(first)
    const a = new RunnerBudgetLedger(first), b = new RunnerBudgetLedger(second)
    a.create({ budget_id: 'budget', task_id: 'task', purpose: 'production', request_id: 'goal', limits: { ...caps, wall_ms: 60000 } })
    first.transaction(() => {
      a.reserve('a', 'budget', 'model-a', { model_requests: 1, tokens: 60 })
      expect(() => b.reserve('b', 'budget', 'model-b', { model_requests: 1, tokens: 60 })).toThrow(expect.objectContaining({ code: 'SQLITE_BUSY' }))
    }).immediate()
    expect(b.reserve('b', 'budget', 'model-b', { model_requests: 1, tokens: 60 }).state).toBe('reserved')
    expect(b.snapshot('budget').total.tokens).toBe(120)
  } finally { first.close(); second.close(); rmSync(root, { recursive: true, force: true }) }
})

it('validates ownership and safe integer amounts without installing partial reservations', () => {
  const { db, ledger } = setup()
  try {
    expect(() => ledger.create({ budget_id: 'composition', task_id: 'task', purpose: 'composition', request_id: 'goal', limits: caps })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(ledger.create({ budget_id: 'composition', task_id: 'task', purpose: 'composition', request_id: null }).purpose).toBe('composition')
    for (const requested of [{ tokens: -1 }, { tokens: Number.MAX_SAFE_INTEGER + 1 }, { model_requests: 0.1 }, { tool_requests: Infinity }, {}]) expect(() => ledger.reserve('a', 'budget', 'invalid-operation', requested)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(db.prepare('SELECT COUNT(*) AS count FROM runner_budget_reservations').get()).toEqual({ count: 0 })
  } finally { db.close() }
})
