import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { ExecutionAttempt, ExecutionScope, GoalRevision, LogicalWork } from '../../shared/contracts.generated'
import { sameDependencies, validateRunnerContract } from '../../shared/runner-validation'
import { ContractError } from '../../shared/validation'
import { RunnerArtifactState } from './artifact-state'
import { assertRunnerId, progressObservationConfig, RUNNER_LIMITS, type ProgressObservationConfig } from './limits'
import { observeRunnerProgress, type EffectiveProgressFact, type ProgressBackgroundFact, type ProgressCallFact, type ProgressDiagnosis, type ProgressRecordRef, type ProgressWaitFact, type RunnerProgressCheckpoint, type RunnerProgressObservation } from './progress-observer'
import { RunnerWorkState } from './work-state'

type ProductionWork = Extract<LogicalWork, { purpose: 'production' }>
type RecordRow = { id: string; sequence: number; created_at: string; owner_json: string | null; plan_revision: number | null }
type CallRow = RecordRow & { call_id: string; pattern: string | null; execution: string | null; delivery: string | null; error_source: string | null; call_owner_json?: string | null }
type StateRow = RecordRow & { state: string; reason: string | null }
type ActiveCallRow = RecordRow & { operation_id: string; call_owner_json: string }
export interface HostProgressPermission { capability_allowed: boolean }

function invalid(): never { throw new ContractError('INVALID_PROGRESS_OBSERVATION', 'Stored progress evidence must identify current bounded runner facts') }
function stable(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/.test(value) && Buffer.byteLength(value) <= RUNNER_LIMITS.index.id_bytes ? value : fallback
}
function sameOwner(left: ExecutionScope, right: ExecutionScope): boolean {
  return left.purpose === 'production' && right.purpose === 'production' && left.task_id === right.task_id && left.request_id === right.request_id && left.intent_revision === right.intent_revision && left.run_id === right.run_id && left.work_id === right.work_id && left.attempt_id === right.attempt_id && left.role === right.role
}
function owner(work: ProductionWork, attempt: ExecutionAttempt): ExecutionScope {
  return { purpose: 'production', task_id: work.task_id, request_id: work.request_id, intent_revision: work.intent_revision, run_id: work.run_id, work_id: work.work_id, attempt_id: attempt.attempt_id, role: work.role }
}
function outcome(execution: string | null, delivery: string | null): ProgressCallFact['outcome'] | null {
  if (execution === 'success') return delivery === 'failed' ? 'failure' : 'success'
  if (execution === 'failure') return 'failure'
  if (execution === 'unknown' || execution === 'partial') return 'unknown'
  if (execution === 'not_executed' || execution === 'cancelled') return 'not_executed'
  return null
}

// Read projections select metadata inside SQLite. Tool result bodies, model
// arguments, approval requests and resource bytes never enter the observer.
// This adapter only records observations; a diagnostic Worker still needs the
// normal capability, dispatch and cumulative-budget checks before execution.
export class RunnerHostProgress {
  constructor(private readonly db: Database.Database, private readonly epoch: string, private readonly clock: () => number = Date.now) {}

  observe(taskId: string, requestId: string, permission: HostProgressPermission, overrides: Partial<ProgressObservationConfig> = {}): RunnerProgressObservation {
    assertRunnerId(taskId, 'task_id'); assertRunnerId(requestId, 'request_id')
    if (!permission || Object.keys(permission).some(key => key !== 'capability_allowed') || typeof permission.capability_allowed !== 'boolean') invalid()
    const config = progressObservationConfig(overrides), at = this.clock()
    if (!Number.isSafeInteger(at) || at < 0) invalid()
    return this.db.transaction(() => {
      const task = this.db.prepare("SELECT state FROM tasks WHERE id=? AND state!='deleting'").get(taskId) as { state: string } | undefined
      if (!task) throw new ContractError('RUNNER_NOT_FOUND', 'Progress Task does not exist')
      const state = new RunnerWorkState(this.db, this.epoch), goal = state.goal(requestId)
      if (goal.task_id !== taskId) throw new ContractError('RUNNER_OWNERSHIP_INVALID', 'Progress goal belongs to another Task')
      const rows = this.db.prepare("SELECT w.payload_json FROM runner_work w JOIN runner_runs r ON r.run_id=w.run_id WHERE w.task_id=? AND r.purpose='production' AND r.request_id=? AND r.intent_revision=? AND json_extract(w.payload_json,'$.role')!='diagnostic' ORDER BY w.rowid LIMIT ?").all(taskId, requestId, goal.intent_revision, config.evidence_max_calls + 1) as { payload_json: string }[]
      if (rows.length > config.evidence_max_calls) throw new ContractError('RUNNER_LIMIT_EXCEEDED', 'Progress work set exceeds its evidence bound')
      const works = rows.map(row => validateRunnerContract('runner_logical_work', JSON.parse(row.payload_json)) as ProductionWork)
      const attempts = new Map<string, ExecutionAttempt>(), bindings = new Map<string, number | null>()
      const workById = new Map(works.map(work => [work.work_id, work]))
      const reference = (row: RecordRow): ProgressRecordRef | null => {
        const time = Date.parse(row.created_at)
        if (!row.owner_json || !Number.isSafeInteger(time) || time < 0 || time > at) return null
        const source = validateRunnerContract('runner_execution_scope', JSON.parse(row.owner_json)), work = workById.get(source.work_id)
        if (!work || source.purpose !== 'production' || source.task_id !== taskId || source.request_id !== requestId || source.intent_revision !== goal.intent_revision || source.run_id !== work.run_id || source.role !== work.role) return null
        let attempt = attempts.get(source.attempt_id)
        if (!attempt) {
          const stored = this.db.prepare('SELECT payload_json FROM runner_attempts WHERE attempt_id=? AND task_id=?').get(source.attempt_id, taskId) as { payload_json: string } | undefined
          if (!stored) return null
          attempt = validateRunnerContract('runner_execution_attempt', JSON.parse(stored.payload_json)); attempts.set(source.attempt_id, attempt)
        }
        if (attempt.runtime_epoch !== this.epoch || attempt.task_id !== work.task_id || attempt.run_id !== work.run_id || attempt.work_id !== work.work_id || attempt.purpose !== 'production' || attempt.request_id !== work.request_id || attempt.intent_revision !== work.intent_revision || !sameOwner(source, owner(work, attempt)) || !sameDependencies(attempt.input_versions, work.dependencies)) return null
        let plan = row.plan_revision
        if (plan === null) {
          if (!bindings.has(attempt.attempt_id)) {
            const bound = this.db.prepare("SELECT json_extract(payload_json,'$.plan_revision') plan_revision FROM records WHERE task_id=? AND kind='worker.input' AND json_extract(payload_json,'$.owner.attempt_id')=? ORDER BY sequence LIMIT 1").get(taskId, attempt.attempt_id) as { plan_revision: number | null } | undefined
            bindings.set(attempt.attempt_id, bound?.plan_revision ?? null)
          }
          plan = bindings.get(attempt.attempt_id) ?? (work.current_attempt_id === attempt.attempt_id ? work.plan_revision : null)
        }
        if (plan !== work.plan_revision) return null
        return { record_id: row.id, sequence: row.sequence, at: time, owner: source, plan_revision: plan }
      }
      const currentWorks = works.map(work => {
        const run = state.run(work.run_id)
        return task.state !== 'active' || run.runtime_epoch !== this.epoch || !run.commit_valid || !['running', 'waiting'].includes(run.state)
          ? { ...work, state: work.state === 'succeeded' ? 'succeeded' as const : 'invalidated' as const } : work
      })
      const calls = this.calls(taskId, requestId, goal.intent_revision, at, config, reference)
      const progress = this.artifacts(goal, currentWorks, state, at, config)
      const waits = this.waits(taskId, currentWorks, reference, at, config)
      const background = this.background(taskId, requestId, goal.intent_revision, reference, at, config)
      const checkpoint = this.db.prepare("SELECT CASE WHEN length(CAST(payload_json AS BLOB))<=? THEN payload_json END payload_json FROM records WHERE task_id=? AND kind='runner.progress.checkpoint' ORDER BY sequence DESC LIMIT 1").get(RUNNER_LIMITS.index.page_bytes, taskId) as { payload_json: string | null } | undefined
      if (checkpoint && !checkpoint.payload_json) invalid()
      const previous = checkpoint ? JSON.parse(checkpoint.payload_json!) as RunnerProgressCheckpoint : undefined
      const result = observeRunnerProgress({ now: at, goal, works: currentWorks, calls, progress, waits, background, diagnosis: { capability_allowed: permission.capability_allowed } }, previous, config)
      for (const diagnosis of result.diagnoses) this.diagnosis(taskId, diagnosis, at)
      this.append(taskId, 'runner.progress.checkpoint', result.checkpoint, at)
      return result
    }).immediate()
  }

  private calls(task: string, request: string, revision: number, at: number, config: Readonly<ProgressObservationConfig>, reference: (row: RecordRow) => ProgressRecordRef | null): ProgressCallFact[] {
    const common = `r.id,r.sequence,r.created_at,CASE WHEN length(CAST(json_extract(r.payload_json,'$.owner') AS BLOB))<=4096 THEN json_extract(r.payload_json,'$.owner') END owner_json,json_extract(r.payload_json,'$.plan_revision') plan_revision`
    const operationRows = this.db.prepare(`SELECT ${common},c.id call_id,c.capability_id pattern,c.execution,c.delivery,json_extract(c.result_json,'$.error.code') error_source,CASE WHEN length(CAST(json_extract(c.limits_json,'$.owner') AS BLOB))<=4096 THEN json_extract(c.limits_json,'$.owner') END call_owner_json FROM records r JOIN calls c ON c.id=json_extract(r.payload_json,'$.call_id') AND c.task_id=r.task_id AND c.run_id=json_extract(r.payload_json,'$.owner.run_id') WHERE r.task_id=? AND r.kind IN ('plugin.call.ended','monty.call.ended') AND json_extract(r.payload_json,'$.owner.request_id')=? AND json_extract(r.payload_json,'$.owner.intent_revision')=? AND r.created_at>? AND r.created_at<=? AND json_extract(c.limits_json,'$.owner.attempt_id')=json_extract(r.payload_json,'$.owner.attempt_id') ORDER BY r.sequence DESC LIMIT ?`).all(task, request, revision, new Date(Math.max(0, at - config.window_ms)).toISOString(), new Date(at).toISOString(), config.evidence_max_calls) as CallRow[]
    const modelRows = this.db.prepare(`WITH metadata AS (SELECT ${common},CASE WHEN json_valid(json_extract(r.payload_json,'$.message.content')) THEN json_extract(r.payload_json,'$.message.content') ELSE '{}' END result FROM records r WHERE r.task_id=? AND r.kind='model.tool_result' AND json_extract(r.payload_json,'$.owner.request_id')=? AND json_extract(r.payload_json,'$.owner.intent_revision')=? AND r.created_at>? AND r.created_at<=? ORDER BY r.sequence DESC LIMIT ?) SELECT id,sequence,created_at,owner_json,plan_revision,COALESCE(json_extract(result,'$.operation_id'),id) call_id,json_extract(result,'$.request_type') pattern,json_extract(result,'$.execution') execution,json_extract(result,'$.delivery') delivery,json_extract(result,'$.error.code') error_source FROM metadata WHERE NOT EXISTS (SELECT 1 FROM calls c WHERE c.task_id=? AND c.id=json_extract(result,'$.operation_id'))`).all(task, request, revision, new Date(Math.max(0, at - config.window_ms)).toISOString(), new Date(at).toISOString(), config.evidence_max_calls, task) as CallRow[]
    const facts: ProgressCallFact[] = []
    for (const row of [...operationRows, ...modelRows].sort((left, right) => right.sequence - left.sequence)) {
      const source = reference(row), result = outcome(row.execution, row.delivery)
      if (!source || !result) continue
      if ('call_owner_json' in row && (!row.call_owner_json || !sameOwner(validateRunnerContract('runner_execution_scope', JSON.parse(row.call_owner_json)), source.owner))) continue
      assertRunnerId(row.call_id, 'call_id')
      facts.push({ ...source, call_id: row.call_id, pattern: stable(row.pattern, 'tool.operation'), outcome: result, ...(result === 'failure' ? { error_source: stable(row.error_source, row.delivery === 'failed' ? 'DELIVERY_FAILED' : 'CALL_FAILED') } : {}) })
      if (facts.length >= config.evidence_max_calls) break
    }
    return facts
  }

  private artifacts(goal: GoalRevision, works: ProductionWork[], state: RunnerWorkState, at: number, config: Readonly<ProgressObservationConfig>): EffectiveProgressFact[] {
    const artifacts = new RunnerArtifactState(this.db, state), facts: EffectiveProgressFact[] = []
    for (const work of works) {
      if (!['running', 'waiting', 'succeeded'].includes(work.state) || !work.current_attempt_id) continue
      const attempt = state.attempt(work.current_attempt_id), source = owner(work, attempt)
      if (attempt.runtime_epoch !== this.epoch || !['running', 'waiting', 'succeeded'].includes(attempt.state) || !sameDependencies(attempt.input_versions, work.dependencies)) continue
      try { state.qualify(attempt.attempt_id) } catch (error) { if (error instanceof ContractError) continue; throw error }
      const output = this.acceptedOutput(goal, work, attempt, source, at, config)
      if (output) {
        facts.push(output)
        if (facts.length >= config.evidence_max_calls) return facts
        continue
      }
      const rows = this.db.prepare('SELECT a.candidate_id,a.artifact_id,a.artifact_revision FROM runner_artifact_owners o JOIN runner_artifacts a ON a.artifact_id=o.artifact_id AND a.artifact_revision=o.current_revision WHERE o.task_id=? AND o.work_id=? AND o.plan_revision=? ORDER BY a.rowid DESC LIMIT ?').all(goal.task_id, work.work_id, work.plan_revision, config.evidence_max_calls) as { candidate_id: string; artifact_id: string; artifact_revision: number }[]
      for (const row of rows) {
        const record = artifacts.candidate(goal.task_id, row.candidate_id)
        if (!record || record.result.state !== 'accepted') continue
        const candidate = record.candidate, index = artifacts.artifact(goal.task_id, row.artifact_id, row.artifact_revision)
        if (!index || JSON.stringify(index) !== JSON.stringify(record.result.index)) continue
        if (candidate.request_id !== goal.request_id || candidate.intent_revision !== goal.intent_revision || candidate.run_id !== work.run_id || candidate.work_id !== work.work_id || candidate.plan_revision !== work.plan_revision || candidate.attempt_id !== work.current_attempt_id || attempt.runtime_epoch !== this.epoch || !['running', 'waiting', 'succeeded'].includes(attempt.state) || !sameDependencies(candidate.dependencies, work.dependencies) || !sameDependencies(attempt.input_versions, work.dependencies) || !candidate.requirement_ids.length || candidate.requirement_ids.some(id => !work.requirement_ids.includes(id) || !goal.requirements.some(item => item.requirement_id === id))) continue
        const resource = this.db.prepare('SELECT r.created_at FROM task_resources t JOIN resources r ON r.id=t.resource_id WHERE t.task_id=? AND r.id=?').get(goal.task_id, index.bundle_resource_id) as { created_at: string } | undefined
        if (!resource) continue
        // This is immutable production evidence. Observing an old accepted
        // resource must not renew progress at the observation's wall clock.
        const time = Date.parse(resource.created_at)
        if (!Number.isSafeInteger(time) || time < 0 || time > at || at - time >= config.window_ms) continue
        let evidence = this.db.prepare("SELECT id,sequence,created_at FROM records WHERE task_id=? AND kind='runner.progress.artifact' AND json_extract(payload_json,'$.candidate_id')=? ORDER BY sequence LIMIT 1").get(goal.task_id, candidate.candidate_id) as { id: string; sequence: number; created_at: string } | undefined
        evidence ??= this.append(goal.task_id, 'runner.progress.artifact', { owner: source, plan_revision: work.plan_revision, candidate_id: candidate.candidate_id, artifact_id: row.artifact_id, artifact_revision: row.artifact_revision, requirement_ids: candidate.requirement_ids, effective_at: time, source_ref: { task_id: goal.task_id, kind: 'resource', id: index.bundle_resource_id }, source_created_at: resource.created_at }, at)
        facts.push({ record_id: evidence.id, sequence: evidence.sequence, at: time, owner: source, plan_revision: work.plan_revision, kind: 'artifact_accepted', requirement_ids: [...candidate.requirement_ids] })
        if (facts.length >= config.evidence_max_calls) return facts
      }
    }
    return facts
  }

  private acceptedOutput(goal: GoalRevision, work: ProductionWork, attempt: ExecutionAttempt, source: ExecutionScope, at: number, config: Readonly<ProgressObservationConfig>): EffectiveProgressFact | null {
    if (work.state !== 'succeeded' || attempt.state !== 'succeeded' || work.result_revision === undefined || !attempt.result_ref) return null
    const row = this.db.prepare(`SELECT r.id,r.sequence,r.created_at,json_extract(r.payload_json,'$.owner') owner_json,CASE WHEN length(CAST(o.payload_json AS BLOB))<=? THEN o.payload_json END payload_json FROM records r JOIN runner_work_outputs o ON o.task_id=r.task_id AND o.work_id=json_extract(r.payload_json,'$.owner.work_id') AND o.plan_revision=json_extract(r.payload_json,'$.plan_revision') AND o.result_revision=json_extract(r.payload_json,'$.result_revision') WHERE r.task_id=? AND r.kind='runner.output.accepted' AND o.request_id=? AND o.intent_revision=? AND o.work_id=? AND o.plan_revision=? AND o.result_revision=? AND json_extract(r.payload_json,'$.run_id')=json_extract(o.payload_json,'$.run_id') AND json_extract(r.payload_json,'$.requirement_ids')=json_extract(o.payload_json,'$.requirement_ids') AND json_extract(r.payload_json,'$.artifacts')=json_extract(o.payload_json,'$.artifacts') ORDER BY r.sequence LIMIT 1`).get(RUNNER_LIMITS.index.page_bytes, goal.task_id, goal.request_id, goal.intent_revision, work.work_id, work.plan_revision, work.result_revision) as { id: string; sequence: number; created_at: string; owner_json: string | null; payload_json: string | null } | undefined
    if (!row?.owner_json || !row.payload_json || !sameOwner(validateRunnerContract('runner_execution_scope', JSON.parse(row.owner_json)), source)) return null
    const output = validateRunnerContract('runner_work_output_declaration', JSON.parse(row.payload_json)), time = Date.parse(row.created_at)
    if (output.task_id !== goal.task_id || output.request_id !== goal.request_id || output.intent_revision !== goal.intent_revision || output.run_id !== work.run_id || output.work_id !== work.work_id || output.attempt_id !== attempt.attempt_id || output.plan_revision !== work.plan_revision || output.result_revision !== work.result_revision || output.result_ref.task_id !== attempt.result_ref.task_id || output.result_ref.kind !== attempt.result_ref.kind || output.result_ref.id !== attempt.result_ref.id || !output.requirement_ids.length || output.requirement_ids.some(id => !work.requirement_ids.includes(id) || !goal.requirements.some(requirement => requirement.requirement_id === id)) || !Number.isSafeInteger(time) || time < 0 || time > at || at - time >= config.window_ms) return null
    return { record_id: row.id, sequence: row.sequence, at: time, owner: source, plan_revision: work.plan_revision, kind: 'requirement_covered', requirement_ids: [...output.requirement_ids] }
  }

  private waits(task: string, works: ProductionWork[], reference: (row: RecordRow) => ProgressRecordRef | null, at: number, config: Readonly<ProgressObservationConfig>): ProgressWaitFact[] {
    const facts: ProgressWaitFact[] = []
    for (const work of works) {
      if (work.state !== 'waiting' || !work.current_attempt_id) continue
      const row = this.db.prepare("SELECT id,sequence,created_at,json_extract(payload_json,'$.owner') owner_json,json_extract(payload_json,'$.plan_revision') plan_revision,json_extract(payload_json,'$.state') state,json_extract(payload_json,'$.reason') reason FROM records WHERE task_id=? AND kind='worker.state' AND json_extract(payload_json,'$.owner.attempt_id')=? ORDER BY sequence DESC LIMIT 1").get(task, work.current_attempt_id) as StateRow | undefined
      if (!row || row.state !== 'waiting') continue
      const source = reference(row)
      if (!source) continue
      if (['input', 'input_required', 'user_input'].includes(row.reason ?? '')) {
        facts.push({ ...source, kind: 'input', valid_until: Number.MAX_SAFE_INTEGER })
      } else if (row.reason === 'approval') {
        const approvals = this.db.prepare("SELECT p.expires_at,json_extract(p.binding_json,'$.owner') owner_json,json_extract(p.binding_json,'$.runtime_epoch') runtime_epoch FROM approvals p JOIN actions a ON a.id=p.action_id WHERE a.task_id=? AND a.run_id=? AND a.state='waiting' AND a.commit_valid=1 AND p.decision='pending' AND p.validity='valid' AND p.expires_at>? AND json_extract(a.source_json,'$.owner.attempt_id')=? LIMIT ?").all(task, work.run_id, new Date(at).toISOString(), work.current_attempt_id, config.evidence_max_calls) as { expires_at: string; owner_json: string | null; runtime_epoch: string }[]
        for (const approval of approvals) {
          if (approval.runtime_epoch !== this.epoch || !approval.owner_json || !sameOwner(validateRunnerContract('runner_execution_scope', JSON.parse(approval.owner_json)), source.owner)) continue
          const expiry = Date.parse(approval.expires_at)
          if (Number.isSafeInteger(expiry) && expiry > at) { facts.push({ ...source, kind: 'approval', valid_until: expiry }); break }
        }
      }
      if (facts.length >= config.evidence_max_calls) break
    }
    return facts
  }

  private background(task: string, request: string, revision: number, reference: (row: RecordRow) => ProgressRecordRef | null, at: number, config: Readonly<ProgressObservationConfig>): ProgressBackgroundFact[] {
    const rows = this.db.prepare("SELECT r.id,r.sequence,r.created_at,json_extract(r.payload_json,'$.owner') owner_json,json_extract(r.payload_json,'$.plan_revision') plan_revision,c.id operation_id,json_extract(c.limits_json,'$.owner') call_owner_json FROM records r JOIN calls c ON c.task_id=r.task_id AND c.run_id=json_extract(r.payload_json,'$.owner.run_id') AND json_extract(c.limits_json,'$.owner.attempt_id')=json_extract(r.payload_json,'$.owner.attempt_id') AND c.capability_id=json_extract(r.payload_json,'$.capability') WHERE r.task_id=? AND r.kind='worker.tool.started' AND json_extract(r.payload_json,'$.request_type')='call' AND json_extract(r.payload_json,'$.owner.request_id')=? AND json_extract(r.payload_json,'$.owner.intent_revision')=? AND r.created_at>? AND r.created_at<=? AND c.created_at>=r.created_at AND c.state IN ('executing','finalizing') AND c.dispatch='sent' AND c.commit_valid=1 AND c.execution IS NULL AND NOT EXISTS (SELECT 1 FROM records e WHERE e.task_id=r.task_id AND e.kind='worker.tool.ended' AND json_extract(e.payload_json,'$.operation_id')=json_extract(r.payload_json,'$.operation_id')) ORDER BY r.sequence DESC LIMIT ?").all(task, request, revision, new Date(Math.max(0, at - config.window_ms)).toISOString(), new Date(at).toISOString(), config.evidence_max_calls) as ActiveCallRow[]
    const facts: ProgressBackgroundFact[] = [], seen = new Set<string>()
    for (const row of rows) {
      const source = reference(row)
      if (!source || seen.has(source.record_id) || !sameOwner(validateRunnerContract('runner_execution_scope', JSON.parse(row.call_owner_json)), source.owner)) continue
      facts.push({ ...source, operation_id: row.operation_id, valid_until: source.at + config.window_ms }); seen.add(source.record_id)
    }
    return facts
  }

  private diagnosis(task: string, value: ProgressDiagnosis, at: number): void {
    if (value.model_diagnosis === 'same_evidence') return
    const previous = this.db.prepare("SELECT payload_json FROM records WHERE task_id=? AND kind='runner.progress.diagnosis' AND json_extract(payload_json,'$.request_id')=? AND json_extract(payload_json,'$.intent_revision')=? AND json_extract(payload_json,'$.work_id')=? AND json_extract(payload_json,'$.plan_revision')=? AND json_extract(payload_json,'$.reason')=? AND json_extract(payload_json,'$.pattern')=? AND json_extract(payload_json,'$.error_source') IS ? AND json_extract(payload_json,'$.through_sequence')=? ORDER BY sequence DESC LIMIT 1").get(task, value.request_id, value.intent_revision, value.work_id, value.plan_revision, value.reason, value.pattern, value.error_source ?? null, value.through_sequence) as { payload_json: string } | undefined
    if (!previous || JSON.parse(previous.payload_json).model_diagnosis !== value.model_diagnosis) this.append(task, 'runner.progress.diagnosis', value, at)
  }

  private append(task: string, kind: string, value: unknown, at: number): { id: string; sequence: number; created_at: string } {
    const payload = JSON.stringify(value)
    if (Buffer.byteLength(payload) > RUNNER_LIMITS.index.page_bytes) throw new ContractError('RUNNER_LIMIT_EXCEEDED', 'Stored progress metadata exceeds its page bound')
    const row = this.db.prepare('SELECT next_sequence FROM tasks WHERE id=?').get(task) as { next_sequence: number }
    const record = { id: randomUUID(), sequence: row.next_sequence, created_at: new Date(at).toISOString() }
    this.db.prepare('INSERT INTO records(id,task_id,sequence,kind,payload_json,created_at) VALUES (?,?,?,?,?,?)').run(record.id, task, record.sequence, kind, payload, record.created_at)
    this.db.prepare('UPDATE tasks SET next_sequence=next_sequence+1,revision=revision+1 WHERE id=?').run(task)
    return record
  }
}
