import type Database from 'better-sqlite3'
import type { ExecutionAttempt, ExecutionScope, InputEvent, LogicalWork, PublicationEntry, RunnerRun } from '../../shared/contracts.generated'
import { validateRunnerContract } from '../../shared/runner-validation'
import { ContractError } from '../../shared/validation'
import { RunnerBudgetLedger } from './budget'
import { assertRunnerId, RUNNER_LIMITS } from './limits'
import { RunnerPublicationState, type PublicationResult } from './publication-state'
import { RunnerWorkState } from './work-state'

type PayloadRow = { payload_json: string }
type TaskState = { state: string }
type CallRow = { task_id: string; run_id: string | null; state: string; dispatch: string; execution: string | null; limits_json: string }
type ActionRow = { task_id: string; run_id: string | null; state: string; result: string | null; source_json: string }
type RecoveryState = 'not_dispatched' | 'known' | 'unknown'
const terminalRuns = new Set<RunnerRun['state']>(['completed', 'failed', 'cancelled', 'interrupted'])
const terminalAttempts = new Set<ExecutionAttempt['state']>(['succeeded', 'failed', 'cancelled', 'revoked'])
const terminalWorks = new Set<LogicalWork['state']>(['succeeded', 'failed', 'cancelled', 'invalidated', 'dependency_failed', 'dependency_cancelled'])

export interface RunnerRecoveryReport {
  run_ids: string[]
  revoked_attempt_ids: string[]
  unknown_attempt_ids: string[]
  released_reservation_ids: string[]
  unknown_reservation_ids: string[]
}
export interface RunnerRecoveryInputPage { items: InputEvent[]; next_cursor: string | null }
export interface RunnerRecoveredOperation {
  task_id: string
  operation_id: string
  kind: 'publication' | 'call' | 'action' | 'attempt' | 'tool' | 'model'
  state: RecoveryState
  execution: string | null
  owner?: ExecutionScope
  source_operation_id?: string
  publication?: PublicationResult
  publication_entries?: PublicationEntry[]
}
export interface RunnerResumeSource {
  previous_run: RunnerRun
  works: LogicalWork[]
  attempts: ExecutionAttempt[]
  request_id: string
}
export interface RunnerResumeInput { run: RunnerRun; attempts: ExecutionAttempt[]; planned_work_ids?: string[]; waiting_work_ids?: string[] }
export interface RunnerResumeHost {
  // Acquire leases and prepare material/configuration facts before this call.
  // Recheck their exact current bindings here, inside the installation lock.
  recheck(source: RunnerResumeSource): void
  installRun(run: RunnerRun, source: RunnerResumeSource): void
}
export interface RunnerResumeResult { run: RunnerRun; works: LogicalWork[]; attempts: ExecutionAttempt[] }

function fail(code: string, message: string): never { throw new ContractError(code, message) }
function invalid(): never { return fail('RUNNER_RECOVERY_FACTS_INVALID', 'Original execution facts require inspection; recovery cannot grant new authority') }
function ineligible(): never { return fail('RUNNER_RESUME_NOT_ELIGIBLE', 'Only current, definitely undispatched work can resume under new execution identities') }
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function json(value: unknown): string { return JSON.stringify(value) }
function synchronous(value: unknown): void {
  if (value && typeof (value as { then?: unknown }).then === 'function') {
    void Promise.resolve(value).catch(() => {})
    fail('RUNNER_TRANSACTION_ASYNC', 'Recovery installation callbacks must be synchronous')
  }
}
function scope(attempt: ExecutionAttempt, work: LogicalWork): ExecutionScope {
  const identity = { task_id: attempt.task_id, run_id: attempt.run_id, work_id: attempt.work_id, attempt_id: attempt.attempt_id, role: work.role }
  return validateRunnerContract('runner_execution_scope', attempt.purpose === 'production'
    ? { ...identity, purpose: 'production', request_id: attempt.request_id, intent_revision: attempt.intent_revision, ...(attempt.update_id ? { update_id: attempt.update_id } : {}), ...(attempt.message_id ? { message_id: attempt.message_id } : {}) }
    : { ...identity, purpose: 'composition', batch_id: attempt.batch_id, composition_version: attempt.composition_version, trigger_request_id: attempt.trigger_request_id })
}
function owner(raw: string, task: string, run: string | null): ExecutionScope | undefined {
  try {
    const value = JSON.parse(raw).owner as unknown
    if (value === undefined) return undefined
    const result = validateRunnerContract('runner_execution_scope', value)
    if (result.task_id !== task || result.run_id !== run) return invalid()
    return result
  } catch { return invalid() }
}

// Recovery only revokes old authority and records original facts. It never
// dispatches a model, tool, publication, cleanup operation or stopped Task.
export class RunnerHostRecovery {
  private readonly work: RunnerWorkState
  private readonly ledger: RunnerBudgetLedger
  constructor(private readonly db: Database.Database, readonly epoch: string, private readonly clock: () => number = Date.now) {
    assertRunnerId(epoch, 'runtime_epoch')
    this.work = new RunnerWorkState(db, epoch, clock)
    this.ledger = new RunnerBudgetLedger(db, clock)
  }

  recover(): RunnerRecoveryReport {
    return this.db.transaction(() => {
      const report: RunnerRecoveryReport = { run_ids: [], revoked_attempt_ids: [], unknown_attempt_ids: [], released_reservation_ids: [], unknown_reservation_ids: [] }
      const rows = this.db.prepare('SELECT payload_json FROM runner_runs ORDER BY rowid').all() as PayloadRow[]
      for (const row of rows) {
        const original = validateRunnerContract('runner_run', JSON.parse(row.payload_json))
        if (original.runtime_epoch === this.epoch) continue
        const run = this.work.run(original.run_id), ended = terminalRuns.has(run.state)
        this.db.prepare("UPDATE runs SET state=CASE WHEN state IN ('running','waiting') THEN COALESCE(intended_terminal,'interrupted') ELSE state END,primary_reason=CASE WHEN state IN ('running','waiting') THEN COALESCE(primary_reason,'runtime_restart') ELSE primary_reason END,commit_valid=0,ended_at=COALESCE(ended_at,?) WHERE id=?").run(new Date(this.clock()).toISOString(), run.run_id)
        const recovered = this.work.run(run.run_id)
        this.db.prepare('UPDATE runner_runs SET payload_json=? WHERE run_id=?').run(json(recovered), run.run_id)
        if (!ended) report.run_ids.push(run.run_id)
        // A persisted dispatch barrier is authoritative even when the final
        // response or the enclosing attempt update was lost.
        for (const reservation of this.db.prepare("SELECT reservation_id,dispatched_at FROM runner_budget_reservations WHERE budget_id=? AND state='reserved' AND (attempt_id IN (SELECT attempt_id FROM runner_attempts WHERE run_id=?) OR attempt_id IS NULL AND NOT EXISTS (SELECT 1 FROM runner_runs r WHERE r.budget_id=runner_budget_reservations.budget_id AND json_extract(r.payload_json,'$.runtime_epoch')=?))").all(run.budget_id, run.run_id, this.epoch) as { reservation_id: string; dispatched_at: string | null }[]) {
          if (reservation.dispatched_at === null) { this.ledger.releaseOnlyUndispatched(reservation.reservation_id); report.released_reservation_ids.push(reservation.reservation_id) }
          else { this.ledger.markUnknown(reservation.reservation_id); report.unknown_reservation_ids.push(reservation.reservation_id) }
        }
        this.db.prepare("UPDATE calls SET state='ended',commit_valid=0,execution=COALESCE(execution,CASE WHEN dispatch='not_sent' THEN 'not_executed' ELSE 'unknown' END),ended_at=COALESCE(ended_at,?) WHERE run_id=? AND state!='ended'").run(new Date(this.clock()).toISOString(), run.run_id)
        this.db.prepare("UPDATE actions SET state='ended',commit_valid=0,result=COALESCE(result,CASE WHEN state IN ('registered','waiting') AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.id=actions.call_id AND c.dispatch!='not_sent') THEN 'not_executed' ELSE 'unknown' END),ended_at=COALESCE(ended_at,?) WHERE run_id=? AND state!='ended'").run(new Date(this.clock()).toISOString(), run.run_id)
        this.db.prepare("UPDATE approvals SET validity='revoked' WHERE validity='valid' AND action_id IN (SELECT id FROM actions WHERE run_id=?)").run(run.run_id)
        this.db.prepare('UPDATE calls SET commit_valid=0 WHERE run_id=?').run(run.run_id)
        this.db.prepare('UPDATE actions SET commit_valid=0 WHERE run_id=?').run(run.run_id)
        for (const item of this.db.prepare('SELECT payload_json FROM runner_attempts WHERE run_id=? ORDER BY rowid').all(run.run_id) as PayloadRow[]) {
          const attempt = validateRunnerContract('runner_execution_attempt', JSON.parse(item.payload_json))
          if (attempt.runtime_epoch !== original.runtime_epoch || attempt.task_id !== run.task_id) invalid()
          if (terminalAttempts.has(attempt.state)) continue
          const dispatched = attempt.dispatch_state !== 'not_dispatched' || this.attemptMayHaveDispatched(attempt)
          const value: ExecutionAttempt = dispatched ? { ...attempt, state: 'unknown', dispatch_state: 'unknown' } : { ...attempt, state: 'revoked' }
          validateRunnerContract('runner_execution_attempt', value)
          this.db.prepare('UPDATE runner_attempts SET state=?,payload_json=? WHERE attempt_id=?').run(value.state, json(value), value.attempt_id)
          if (dispatched) report.unknown_attempt_ids.push(attempt.attempt_id)
          else report.revoked_attempt_ids.push(attempt.attempt_id)
        }
      }
      return report
    }).immediate()
  }

  private attemptMayHaveDispatched(attempt: ExecutionAttempt): boolean {
    if (this.db.prepare('SELECT 1 FROM runner_budget_reservations WHERE attempt_id=? AND (dispatched_at IS NOT NULL OR state IN (\'settled\',\'unknown\')) LIMIT 1').get(attempt.attempt_id)) return true
    if (this.db.prepare("SELECT 1 FROM calls WHERE task_id=? AND run_id=? AND json_extract(limits_json,'$.owner.attempt_id')=? AND (dispatch!='not_sent' OR execution IN ('success','partial','failure','cancelled','unknown')) LIMIT 1").get(attempt.task_id, attempt.run_id, attempt.attempt_id)) return true
    return !!this.db.prepare("SELECT 1 FROM actions WHERE task_id=? AND run_id=? AND json_extract(source_json,'$.owner.attempt_id')=? AND (state='executing' OR result IN ('success','failure','cancelled','unknown')) LIMIT 1").get(attempt.task_id, attempt.run_id, attempt.attempt_id)
  }

  undispatchedAttempt(attemptId: string): boolean {
    const attempt = this.work.attempt(attemptId)
    return ['registered', 'queued', 'revoked'].includes(attempt.state) && attempt.dispatch_state === 'not_dispatched' && !this.attemptMayHaveDispatched(attempt)
  }

  pendingInputs(taskId: string, cursor?: string, limit: number = RUNNER_LIMITS.index.page_items): RunnerRecoveryInputPage {
    assertRunnerId(taskId, 'task_id')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > RUNNER_LIMITS.index.page_items) invalid()
    const task = this.db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as TaskState | undefined
    if (!task) fail('RUNNER_NOT_FOUND', 'Recovery Task does not exist')
    if (task.state !== 'active') return { items: [], next_cursor: null }
    let after = 0, through = Number((this.db.prepare('SELECT COALESCE(MAX(rowid),0) position FROM runner_inputs WHERE task_id=?').get(taskId) as { position: number }).position)
    if (cursor !== undefined) {
      try {
        if (cursor.length > 4096) return invalid()
        const saved = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Record<string, unknown>
        if (Object.keys(saved).sort().join(',') !== 'after,epoch,task_id,through,version' || saved.version !== 1 || saved.epoch !== this.epoch || saved.task_id !== taskId || !Number.isSafeInteger(saved.after) || !Number.isSafeInteger(saved.through) || Number(saved.after) < 0 || Number(saved.through) < Number(saved.after)) return invalid()
        after = Number(saved.after); through = Number(saved.through)
      } catch { return invalid() }
    }
    const rows = this.db.prepare("SELECT i.rowid position,i.input_event_id FROM runner_inputs i WHERE i.task_id=? AND i.rowid>? AND i.rowid<=? AND NOT EXISTS (SELECT 1 FROM runner_consumptions c WHERE c.input_event_id=i.input_event_id AND c.stage='installed') ORDER BY i.rowid LIMIT ?").all(taskId, after, through, limit + 1) as { position: number; input_event_id: string }[]
    const items = rows.slice(0, limit).map(row => this.work.input(row.input_event_id))
    const next_cursor = rows.length > limit ? Buffer.from(json({ version: 1, epoch: this.epoch, task_id: taskId, after: rows[limit - 1]!.position, through })).toString('base64url') : null
    if (Buffer.byteLength(json({ items, next_cursor })) > RUNNER_LIMITS.index.page_bytes) invalid()
    return { items, next_cursor }
  }

  queryOperation(taskId: string, operationId: string): RunnerRecoveredOperation | null {
    assertRunnerId(taskId, 'task_id'); assertRunnerId(operationId, 'operation_id')
    const publication = new RunnerPublicationState(this.db).operation(taskId, operationId)
    if (publication) {
      if (publication.state === 'published') {
        if (!publication.result || publication.result.state !== 'published' || publication.result.operation_id !== operationId) return invalid()
        const result = publication.result, history = new RunnerPublicationState(this.db).history(taskId, result.surface_history_id)
        if (result.batch_id !== publication.registration.batch_id || result.action_id !== publication.registration.action_id || !history || history.surface_id !== result.surface_id || history.surface_revision !== result.surface_revision || history.action_id !== result.action_id) return invalid()
        const entries = (this.db.prepare('SELECT payload_json FROM runner_view_mappings WHERE task_id=? AND batch_id=? ORDER BY rowid').all(taskId, result.batch_id) as PayloadRow[]).map(row => validateRunnerContract('runner_publication_entry', JSON.parse(row.payload_json)))
        if (entries.length !== publication.registration.plan.intents.length || entries.some(entry => !publication.registration.plan.intents.some(intent => intent.artifact.artifact_id === entry.artifact_id && intent.artifact.artifact_revision === entry.artifact_revision) || !history.views.some(view => view.view_id === entry.view_id && view.view_revision === entry.view_revision && !!this.db.prepare('SELECT 1 FROM view_history WHERE id=? AND task_id=? AND view_id=? AND view_revision=? AND bundle_resource_id=?').get(view.view_history_id, taskId, entry.view_id, entry.view_revision, entry.published_bundle_resource_id)))) return invalid()
        return { task_id: taskId, operation_id: operationId, kind: 'publication', state: 'known', execution: 'success', publication: copy(result), publication_entries: entries }
      }
      if (publication.result) return { task_id: taskId, operation_id: operationId, kind: 'publication', state: publication.result.state === 'unknown' ? 'unknown' : 'known', execution: publication.result.state, publication: copy(publication.result) }
      const action = this.action(taskId, publication.registration.action_id)
      return { task_id: taskId, operation_id: operationId, kind: 'publication', state: action?.state === 'not_dispatched' ? 'not_dispatched' : 'unknown', execution: null, source_operation_id: publication.registration.action_id }
    }
    const call = this.db.prepare('SELECT task_id,run_id,state,dispatch,execution,limits_json FROM calls WHERE task_id=? AND id=?').get(taskId, operationId) as CallRow | undefined
    if (call) {
      const state: RecoveryState = call.execution && call.execution !== 'unknown' ? call.execution === 'not_executed' ? 'not_dispatched' : 'known' : call.dispatch === 'not_sent' && call.execution !== 'unknown' ? 'not_dispatched' : 'unknown'
      const savedOwner = owner(call.limits_json, taskId, call.run_id)
      return { task_id: taskId, operation_id: operationId, kind: 'call', state, execution: call.execution, ...(savedOwner ? { owner: savedOwner } : {}) }
    }
    const action = this.action(taskId, operationId)
    if (action) return action
    const row = this.db.prepare("SELECT payload_json FROM runner_attempts WHERE task_id=? AND json_extract(payload_json,'$.operation_id')=?").get(taskId, operationId) as PayloadRow | undefined
    if (row) {
      const attempt = validateRunnerContract('runner_execution_attempt', JSON.parse(row.payload_json)), work = this.work.work(attempt.work_id)
      const unresolved = this.db.prepare("SELECT 1 FROM runner_budget_reservations WHERE attempt_id=? AND state='unknown' UNION ALL SELECT 1 FROM calls WHERE task_id=? AND run_id=? AND json_extract(limits_json,'$.owner.attempt_id')=? AND (execution='unknown' OR dispatch!='not_sent' AND execution IS NULL) UNION ALL SELECT 1 FROM actions WHERE task_id=? AND run_id=? AND json_extract(source_json,'$.owner.attempt_id')=? AND (result='unknown' OR state='executing' AND result IS NULL) LIMIT 1").get(attempt.attempt_id, taskId, attempt.run_id, attempt.attempt_id, taskId, attempt.run_id, attempt.attempt_id)
      return { task_id: taskId, operation_id: operationId, kind: 'attempt', state: unresolved ? 'unknown' : terminalAttempts.has(attempt.state) && attempt.state !== 'revoked' ? 'known' : attempt.dispatch_state === 'not_dispatched' && !this.attemptMayHaveDispatched(attempt) ? 'not_dispatched' : 'unknown', execution: attempt.state, owner: scope(attempt, work) }
    }
    const reservation = this.db.prepare('SELECT attempt_id,reserved_json,state,dispatched_at FROM runner_budget_reservations WHERE task_id=? AND operation_id=?').get(taskId, operationId) as { attempt_id: string | null; reserved_json: string; state: string; dispatched_at: string | null } | undefined
    if (!reservation) return null
    const amounts = JSON.parse(reservation.reserved_json) as { model_requests: number; tool_requests: number }, attempt = reservation.attempt_id ? this.work.attempt(reservation.attempt_id) : undefined
    const ended = this.db.prepare("SELECT payload_json FROM records WHERE task_id=? AND kind='worker.tool.ended' AND json_extract(payload_json,'$.operation_id')=? ORDER BY sequence DESC LIMIT 1").get(taskId, operationId) as PayloadRow | undefined
    const saved = ended ? JSON.parse(ended.payload_json) as { state: string; source_operation_id?: string } : undefined
    let state: RecoveryState = reservation.dispatched_at === null && ['reserved', 'released'].includes(reservation.state) ? 'not_dispatched' : saved && saved.state !== 'unknown' || reservation.state === 'settled' ? 'known' : 'unknown'
    if (saved?.source_operation_id) {
      if (saved.source_operation_id === operationId) return invalid()
      const source = this.db.prepare('SELECT 1 FROM calls WHERE task_id=? AND id=? UNION ALL SELECT 1 FROM actions WHERE task_id=? AND id=? LIMIT 1').get(taskId, saved.source_operation_id, taskId, saved.source_operation_id)
      // A wrapper's successful return may only acknowledge an asynchronous start.
      // The persisted original call or action remains the execution authority.
      if (source) state = this.queryOperation(taskId, saved.source_operation_id)!.state
    }
    return { task_id: taskId, operation_id: operationId, kind: amounts.model_requests > 0 ? 'model' : 'tool', state, execution: saved?.state ?? null, ...(attempt ? { owner: scope(attempt, this.work.work(attempt.work_id)) } : {}), ...(saved?.source_operation_id ? { source_operation_id: saved.source_operation_id } : {}) }
  }

  private action(taskId: string, actionId: string): RunnerRecoveredOperation | null {
    const action = this.db.prepare('SELECT task_id,run_id,state,result,source_json FROM actions WHERE task_id=? AND id=?').get(taskId, actionId) as ActionRow | undefined
    if (!action) return null
    const state: RecoveryState = action.result === 'unknown' ? 'unknown' : action.result === 'not_executed' ? 'not_dispatched' : action.result ? 'known' : ['registered', 'waiting'].includes(action.state) ? 'not_dispatched' : 'unknown'
    const savedOwner = owner(action.source_json, taskId, action.run_id)
    return { task_id: taskId, operation_id: actionId, kind: 'action', state, execution: action.result, ...(savedOwner ? { owner: savedOwner } : {}) }
  }

  // A reliable capability query persists facts in its original owning module.
  // Re-read that exact operation afterward; an unavailable query stays unknown.
  async queryUnknown(taskId: string, operationId: string, lookup?: (operation: RunnerRecoveredOperation) => Promise<void>): Promise<RunnerRecoveredOperation | null> {
    const original = this.queryOperation(taskId, operationId)
    if (!original || original.state !== 'unknown' || !lookup) return original
    await lookup(copy(original))
    return this.queryOperation(taskId, operationId)
  }

  private source(taskId: string, runId: string, workIds: readonly string[], planned: ReadonlySet<string>, waiting: ReadonlySet<string>): RunnerResumeSource {
    assertRunnerId(taskId, 'task_id'); assertRunnerId(runId, 'run_id')
    if (!this.db.prepare("SELECT id FROM tasks WHERE id=? AND state='active'").get(taskId)) ineligible()
    const previous_run = this.work.run(runId)
    if (previous_run.task_id !== taskId || !terminalRuns.has(previous_run.state) || previous_run.state !== 'interrupted' || previous_run.commit_valid || previous_run.runtime_epoch === this.epoch) ineligible()
    if (previous_run.purpose === 'composition') fail('RUNNER_COMPOSITION_RESUME_REQUIRES_SUCCESSOR', 'Composition recovery requires a new batch with its original frozen predecessor and cumulative budget')
    const request_id = previous_run.request_id
    const request = this.db.prepare('SELECT state FROM requests WHERE task_id=? AND id=?').get(taskId, request_id) as TaskState | undefined
    if (!request || ['cancelled', 'rejected'].includes(request.state)) ineligible()
    if (previous_run.purpose === 'production') {
      const goal = this.work.goal(request_id)
      if (goal.task_id !== taskId || goal.intent_revision !== previous_run.intent_revision || goal.state !== 'active') ineligible()
    }
    const works = workIds.map(id => { assertRunnerId(id, 'work_id'); return this.work.work(id) })
    if (!works.length || new Set(workIds).size !== workIds.length) ineligible()
    const attempts: ExecutionAttempt[] = []
    for (const work of works) {
      if (work.task_id !== taskId || work.run_id !== runId || terminalWorks.has(work.state)) ineligible()
      if (waiting.has(work.work_id)) {
        if (!this.work.clarifiedAssignment(work)) ineligible()
        continue
      }
      if (planned.has(work.work_id)) {
        const reason = this.work.pendingAssignmentRecoveryFailure(work)
        if (reason === 'RUNNER_ATTEMPTS_EXHAUSTED') fail(reason, 'Recovery cannot exceed the installed attempt limit')
        if (reason) ineligible()
        continue
      }
      const previous = this.work.attempts(work.work_id).at(-1)
      if (previous) {
        if (work.current_attempt_id !== previous.attempt_id || previous.run_id !== runId || !this.undispatchedAttempt(previous.attempt_id) || previous.attempt_number >= work.max_attempts) ineligible()
        attempts.push(previous)
      } else if (work.current_attempt_id !== undefined) ineligible()
    }
    return { previous_run, works, attempts, request_id }
  }

  resume(raw: RunnerResumeInput, host: RunnerResumeHost): RunnerResumeResult {
    const run = validateRunnerContract('runner_run', copy(raw.run)), attempts = raw.attempts.map(value => validateRunnerContract('runner_execution_attempt', copy(value)))
    const planned = raw.planned_work_ids ?? [], waiting = raw.waiting_work_ids ?? [], waitingIds = new Set(waiting)
    const workIds = [...attempts.map(value => value.work_id), ...planned, ...waiting]
    if (!run.previous_run_id || run.run_id === run.previous_run_id || run.runtime_epoch !== this.epoch || !run.commit_valid || !['queued', 'running'].includes(run.state) || !workIds.length || new Set(workIds).size !== workIds.length || new Set(attempts.map(value => value.attempt_id)).size !== attempts.length) ineligible()
    return this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM runner_runs WHERE run_id=?').get(run.run_id)) {
        if (attempts.some(attempt => !this.db.prepare('SELECT 1 FROM runner_attempts WHERE attempt_id=? AND run_id=? AND work_id=?').get(attempt.attempt_id, run.run_id, attempt.work_id)) || [...planned, ...waiting].some(id => this.work.work(id).run_id !== run.run_id)) ineligible()
        const existing = this.work.registerRun(run)
        return { run: existing, works: workIds.map(id => this.work.work(id)), attempts: attempts.map(attempt => this.work.createAttempt(attempt)) }
      }
      const plannedIds = new Set(planned), source = this.source(run.task_id, run.previous_run_id!, workIds, plannedIds, waitingIds)
      const previous = source.previous_run
      if (run.budget_id !== previous.budget_id || run.purpose !== previous.purpose || run.purpose === 'production' && previous.purpose === 'production' && (run.request_id !== previous.request_id || run.intent_revision !== previous.intent_revision) || run.purpose === 'composition' && previous.purpose === 'composition' && (run.batch_id !== previous.batch_id || run.composition_version !== previous.composition_version || run.trigger_request_id !== previous.trigger_request_id)) ineligible()
      synchronous(host.recheck(copy(source)))
      for (const attempt of source.attempts) {
        if (attempt.state !== 'revoked') this.work.updateAttempt({ ...attempt, state: 'revoked' })
        for (const row of this.db.prepare("SELECT reservation_id FROM runner_budget_reservations WHERE attempt_id=? AND state='reserved' AND dispatched_at IS NULL").all(attempt.attempt_id) as { reservation_id: string }[]) this.ledger.releaseOnlyUndispatched(row.reservation_id)
      }
      synchronous(host.installRun(copy(run), copy(source)))
      this.work.registerRun(run)
      for (const workId of waiting) this.work.rebindClarifiedAssignment(workId, run.run_id)
      const starting = source.works.filter(work => !waitingIds.has(work.work_id))
      const plans = starting.map(work => {
        const { current_attempt_id: _attempt, root_cause: _cause, result_revision: _result, ...binding } = work
        return { ...binding, run_id: run.run_id, plan_revision: work.plan_revision + 1, state: plannedIds.has(work.work_id) ? 'planned' : 'queued' } as LogicalWork
      })
      for (const revision of new Set(plans.map(work => work.plan_revision))) this.work.installPlan(plans.filter(work => work.plan_revision === revision))
      this.work.rebindRecoveredOutputInputs(run, starting)
      for (const attempt of attempts) {
        if (attempt.run_id !== run.run_id || attempt.runtime_epoch !== this.epoch) ineligible()
        this.work.createAttempt(attempt)
      }
      return { run: this.work.run(run.run_id), works: workIds.map(workId => this.work.work(workId)), attempts: attempts.map(attempt => this.work.attempt(attempt.attempt_id)) }
    }).immediate()
  }
}
