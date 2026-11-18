import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import type { ExecutionAttempt, LogicalWork } from '../../src/shared/contracts.generated'
import { runnerFailureReason } from '../../src/runtime/runner/failure-reason'

const coreSql = readFileSync(new URL('../../src/shared/contracts/001-core.sql', import.meta.url), 'utf8')
const runnerSql = readFileSync(new URL('../../src/shared/contracts/002-runner.sql', import.meta.url), 'utf8')
const databases: Database.Database[] = []
type Work = Extract<LogicalWork, { purpose: 'production' }>
type Attempt = Extract<ExecutionAttempt, { purpose: 'production' }>
type Source = { work: Work; attempt: Attempt }

afterEach(() => { for (const db of databases.splice(0)) db.close() })

function setup(): Database.Database {
  const db = new Database(':memory:')
  databases.push(db)
  db.pragma('foreign_keys = ON')
  db.exec(coreSql)
  db.exec(runnerSql)
  db.prepare('UPDATE schema_version SET version=2').run()
  for (const taskId of ['task', 'other-task']) {
    const requestId = `${taskId}-goal`, budgetId = `${taskId}-budget`
    db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES (?,?,'active',1)").run(taskId, taskId)
    db.prepare("INSERT INTO requests VALUES (?,?,'started','{}','{}','time')").run(requestId, taskId)
    db.prepare("INSERT INTO runner_budgets VALUES (?,?,'production',?,'{}','time')").run(budgetId, taskId, requestId)
    for (const runId of taskId === 'task' ? ['run', 'other-run'] : ['other-task-run']) {
      db.prepare(`INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at)
        VALUES (?,?,?,'failed','epoch','{}','{}','time')`).run(runId, taskId, requestId)
      db.prepare(`INSERT INTO runner_runs(run_id,task_id,purpose,request_id,intent_revision,budget_id,payload_json)
        VALUES (?,?,'production',?,1,?,?)`).run(runId, taskId, requestId, budgetId, JSON.stringify({
        run_id: runId, task_id: taskId, purpose: 'production', request_id: requestId,
        intent_revision: 1, runtime_epoch: 'epoch', state: 'failed', budget_id: budgetId
      }))
    }
  }
  return db
}

function addWork(db: Database.Database, id: string, overrides: Partial<Work> = {}): Work {
  const work: Work = {
    work_id: id, task_id: 'task', run_id: 'run', plan_revision: 1, role: 'producer', required: true,
    requirement_ids: ['result'], dependencies: [{ kind: 'goal', task_id: 'task', request_id: 'task-goal', intent_revision: 1 }],
    state: 'failed', max_attempts: 2, current_attempt_id: `${id}-attempt`,
    root_cause: { kind: 'failure', work_id: id, attempt_id: `${id}-attempt`, operation_id: `${id}-operation` },
    purpose: 'production', request_id: 'task-goal', intent_revision: 1, ...overrides
  }
  db.prepare('INSERT INTO runner_work VALUES (?,?,?,?,?,?)')
    .run(work.work_id, work.task_id, work.run_id, work.plan_revision, work.state, JSON.stringify(work))
  return work
}

function addAttempt(db: Database.Database, work: Work, id = `${work.work_id}-attempt`, number = 1): Attempt {
  const attempt: Attempt = {
    attempt_id: id, task_id: work.task_id, run_id: work.run_id, work_id: work.work_id,
    runtime_epoch: 'epoch', attempt_number: number, profile_id: 'producer-output-v1',
    model_config_id: 'model', model_config_revision: 1, input_versions: work.dependencies,
    state: 'failed', dispatch_state: 'dispatched', operation_id: `${work.work_id}-operation`, usage_refs: [],
    purpose: 'production', request_id: work.request_id, intent_revision: work.intent_revision
  }
  db.prepare('INSERT INTO runner_attempts VALUES (?,?,?,?,?,?,?)')
    .run(id, work.task_id, work.work_id, work.run_id, number, attempt.state, JSON.stringify(attempt))
  return attempt
}

function failure(db: Database.Database, id = 'required', overrides: Partial<Work> = {}): Source {
  const work = addWork(db, id, overrides)
  return { work, attempt: addAttempt(db, work) }
}

function ended(db: Database.Database, sequence: number, source: Source, code: unknown,
  overrides: Record<string, unknown> = {}, ownerOverrides: Record<string, unknown> = {}): void {
  const { work, attempt } = source
  const payload = {
    state: 'failed', code, run_id: work.run_id,
    owner: { task_id: work.task_id, run_id: work.run_id, work_id: work.work_id, attempt_id: attempt.attempt_id,
      role: work.role, purpose: attempt.purpose, request_id: attempt.request_id,
      intent_revision: attempt.intent_revision, ...ownerOverrides },
    ...overrides
  }
  db.prepare("INSERT INTO records VALUES (?,?,?,'worker.ended',?,'time')")
    .run(`event-${sequence}`, work.task_id, sequence, JSON.stringify(payload))
}

it.each([null, 'required_work_settled'])('resolves a required failure from primary reason %s', primaryReason => {
  const db = setup(), source = failure(db)
  ended(db, 1, source, 'INVALID_WORKER_RESULT')
  expect(runnerFailureReason(db, 'task', 'run', primaryReason)).toBe('INVALID_WORKER_RESULT')
})

it('keeps a required failure when an optional diagnostic fails later in the same Run', () => {
  const db = setup(), source = failure(db)
  const diagnostic = failure(db, 'diagnostic', { role: 'diagnostic', required: false })
  ended(db, 1, source, 'INVALID_WORKER_RESULT')
  ended(db, 2, diagnostic, 'DIAGNOSTIC_FAILED')
  expect(runnerFailureReason(db, 'task', 'run', 'required_work_settled')).toBe('INVALID_WORKER_RESULT')
})

it('follows the exact upstream attempt of a dependency failure, including an optional producer', () => {
  const db = setup(), source = failure(db, 'upstream', { required: false })
  const retry = { work: source.work, attempt: addAttempt(db, source.work, 'upstream-retry', 2) }
  addWork(db, 'consumer', { state: 'dependency_failed', current_attempt_id: undefined,
    root_cause: { kind: 'failure', work_id: source.work.work_id, attempt_id: source.attempt.attempt_id } })
  ended(db, 1, retry, 'UNRELATED_RETRY_FAILURE')
  ended(db, 2, source, 'UPSTREAM_FAILED')
  expect(runnerFailureReason(db, 'task', 'run', null)).toBe('UPSTREAM_FAILED')
})

it('does not substitute another attempt when the causal attempt has no event', () => {
  const db = setup(), source = failure(db)
  const retry = { work: source.work, attempt: addAttempt(db, source.work, 'retry', 2) }
  ended(db, 1, retry, 'RETRY_FAILED')
  expect(runnerFailureReason(db, 'task', 'run', null)).toBeNull()
})

it('chooses the earliest valid event across root causes, regardless of work insertion order', () => {
  const db = setup(), later = failure(db, 'inserted-first'), earlier = failure(db, 'inserted-last')
  ended(db, 30, later, 'LATER_FAILURE')
  ended(db, 10, earlier, 'EARLIER_FAILURE')
  ended(db, 5, later, 'invalid code')
  expect(runnerFailureReason(db, 'task', 'run', null)).toBe('EARLIER_FAILURE')
})

it.each([
  ['task_id', 'other-task'], ['run_id', 'other-run'], ['work_id', 'other-work'], ['attempt_id', 'other-attempt'],
  ['role', 'diagnostic'], ['purpose', 'composition'], ['request_id', 'other-goal'], ['intent_revision', 2],
  ['batch_id', 'unexpected-batch'], ['composition_version', 1], ['trigger_request_id', 'unexpected-trigger']
])('rejects a worker event with a different owner %s', (field, value) => {
  const db = setup(), source = failure(db)
  ended(db, 1, source, 'WRONG_OWNER', {}, { [field]: value })
  expect(runnerFailureReason(db, 'task', 'run', null)).toBeNull()
})

it.each(['other-run', undefined])('requires the event top-level Run id to match: %s', runId => {
  const db = setup(), source = failure(db)
  ended(db, 1, source, 'WRONG_RUN', { run_id: runId })
  expect(runnerFailureReason(db, 'task', 'run', null)).toBeNull()
})

it('isolates failures from other Runs and Tasks', () => {
  const db = setup()
  const otherRun = failure(db, 'other-run-work', { run_id: 'other-run' })
  const otherTask = failure(db, 'other-task-work', { task_id: 'other-task', run_id: 'other-task-run', request_id: 'other-task-goal' })
  ended(db, 1, otherRun, 'OTHER_RUN_FAILURE')
  ended(db, 2, otherTask, 'OTHER_TASK_FAILURE')
  expect(runnerFailureReason(db, 'task', 'run', 'required_work_settled')).toBe('required_work_settled')
})

it.each([
  '', 'contains spaces', 'line\nbreak', 'slash/code', '失败', 'X'.repeat(129),
  'VALID\u0000HIDDEN', '\u0000', 123, null, { code: 'NESTED' }
])('rejects invalid error code %j', code => {
  const db = setup(), source = failure(db)
  ended(db, 1, source, code)
  expect(runnerFailureReason(db, 'task', 'run', 'required_work_settled')).toBe('required_work_settled')
})

it.each(['A', 'worker.result:INVALID-v1_2', 'X'.repeat(128)])('accepts a bounded error code %s', code => {
  const db = setup(), source = failure(db)
  ended(db, 1, source, code)
  expect(runnerFailureReason(db, 'task', 'run', null)).toBe(code)
})

it.each([null, 'required_work_settled'])('retains primary reason %s without causal evidence', primaryReason => {
  const db = setup()
  failure(db)
  expect(runnerFailureReason(db, 'task', 'run', primaryReason)).toBe(primaryReason)
})

it('preserves an existing specific primary reason', () => {
  const db = setup(), source = failure(db)
  ended(db, 1, source, 'INVALID_WORKER_RESULT')
  expect(runnerFailureReason(db, 'task', 'run', 'RUNNER_BUDGET_EXHAUSTED')).toBe('RUNNER_BUDGET_EXHAUSTED')
})

it.each(['succeeded', 'cancelled'])('excludes worker events ending in %s', state => {
  const db = setup(), source = failure(db)
  ended(db, 1, source, 'NOT_A_FAILURE', { state })
  expect(runnerFailureReason(db, 'task', 'run', null)).toBeNull()
})

it('excludes optional failures without a required dependent', () => {
  const db = setup(), source = failure(db, 'optional', { required: false })
  ended(db, 1, source, 'OPTIONAL_FAILED')
  expect(runnerFailureReason(db, 'task', 'run', null)).toBeNull()
})

it('excludes a diagnostic source even when a required dependent names it', () => {
  const db = setup(), source = failure(db, 'diagnostic', { role: 'diagnostic', required: false })
  addWork(db, 'consumer', { state: 'dependency_failed', current_attempt_id: undefined,
    root_cause: { kind: 'failure', work_id: source.work.work_id, attempt_id: source.attempt.attempt_id } })
  ended(db, 1, source, 'DIAGNOSTIC_FAILED')
  expect(runnerFailureReason(db, 'task', 'run', null)).toBeNull()
})

it('excludes cancellation roots even when a failed event exists for the attempt', () => {
  const db = setup(), source = failure(db, 'cancelled', {
    root_cause: { kind: 'cancellation', work_id: 'cancelled', attempt_id: 'cancelled-attempt' }
  })
  ended(db, 1, source, 'IGNORED_FAILURE')
  expect(runnerFailureReason(db, 'task', 'run', null)).toBeNull()
})
