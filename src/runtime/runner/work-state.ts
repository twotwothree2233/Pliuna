import { types } from 'node:util'
import type Database from 'better-sqlite3'
import type { ConsumptionStage, ExecutionAttempt, GoalRevision, InputEvent, LogicalWork, RunnerRun, WorkDependency } from '../../shared/contracts.generated'
import { sameDependencies, validateRunnerContract } from '../../shared/runner-validation'
import { ContractError } from '../../shared/validation'
import { RunnerBudgetLedger } from './budget'
import { assertRunnerId } from './limits'
import { ChapterState } from './chapter-state'
import { RunnerArtifactState } from './artifact-state'

type PayloadRow = { payload_json: string }
type CoreRun = { id: string; task_id: string; request_id: string | null; state: string; commit_valid: number; runtime_epoch: string }
type SynchronousInstaller<T> = ((input: InputEvent) => T) & (Extract<T, PromiseLike<unknown>> extends never ? unknown : never)
export interface InputConsumption<T = unknown> {
  input_event_id: string; task_id: string; stage: ConsumptionStage; result: T; installed_at: string
}
export interface QualifiedAttempt {
  task_id: string; runtime_epoch: string; run: RunnerRun; work: LogicalWork; attempt: ExecutionAttempt; goal?: GoalRevision
}
export type WorkCause = NonNullable<LogicalWork['root_cause']>
const stages: ConsumptionStage[] = ['received', 'routed', 'installed']
const terminalWork = new Set<LogicalWork['state']>(['succeeded', 'failed', 'cancelled', 'invalidated', 'dependency_failed', 'dependency_cancelled'])
const terminalAttempt = new Set<ExecutionAttempt['state']>(['succeeded', 'failed', 'cancelled', 'revoked'])
const terminalRun = new Set<RunnerRun['state']>(['completed', 'failed', 'cancelled', 'interrupted'])
function fail(code: string, message: string): never { throw new ContractError(code, message) }

// Consumption callbacks are synchronous database installations. Keeping their
// result in the same transaction makes an acknowledgement safe to repeat.
function json(value: unknown): string {
  const seen = new Set<object>()
  const check = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (typeof item !== 'object' || seen.has(item)) fail('RUNNER_RESULT_INVALID', 'Runner installation result must be finite JSON')
    seen.add(item)
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) check(item[i])
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) fail('RUNNER_RESULT_INVALID', 'Runner installation result must be plain JSON')
      for (const value of Object.values(item)) check(value)
    }
    seen.delete(item)
  }
  check(value)
  return JSON.stringify(value)
}
function equivalent(left: unknown, right: unknown): boolean {
  const normalize = (value: any): any => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}
function sameSource(left: RunnerRun | LogicalWork | ExecutionAttempt, right: RunnerRun | LogicalWork | ExecutionAttempt): boolean {
  return left.task_id === right.task_id && left.purpose === right.purpose && (left.purpose === 'production' && right.purpose === 'production'
    ? left.request_id === right.request_id && left.intent_revision === right.intent_revision && left.update_id === right.update_id
    : left.purpose === 'composition' && right.purpose === 'composition' && left.batch_id === right.batch_id && left.composition_version === right.composition_version && left.trigger_request_id === right.trigger_request_id)
}
function attemptBinding(value: ExecutionAttempt): unknown {
  const { state, dispatch_state, result_ref, usage_refs, operation_id, ...binding } = value
  return binding
}
function planBinding(value: LogicalWork): unknown {
  const { state, current_attempt_id, root_cause, result_revision, ...binding } = value
  return binding
}
function runBinding(value: RunnerRun): unknown {
  const { state, commit_valid, ...binding } = value
  return binding
}

export class RunnerWorkState {
  constructor(private readonly db: Database.Database, readonly epoch: string, private readonly clock: () => number = Date.now) {
    assertRunnerId(epoch, 'runtime_epoch')
  }

  private payload<K extends 'runner_input_event' | 'runner_goal_revision' | 'runner_run' | 'runner_logical_work' | 'runner_execution_attempt'>(definition: K, row: PayloadRow | undefined) {
    if (!row) fail('RUNNER_NOT_FOUND', 'Runner state does not exist')
    return validateRunnerContract(definition, JSON.parse(row.payload_json))
  }
  private activeTask(taskId: string): void {
    if (!(this.db.prepare("SELECT id FROM tasks WHERE id=? AND state='active'").get(taskId))) fail('RUNNER_OWNERSHIP_INVALID', 'Task is not active')
  }
  private requestOwner(taskId: string, requestId: string): void {
    if (!this.db.prepare('SELECT id FROM requests WHERE id=? AND task_id=?').get(requestId, taskId)) fail('RUNNER_OWNERSHIP_INVALID', 'Request does not belong to this Task')
  }
  private recordOwner(taskId: string, recordId: string): void {
    if (!this.db.prepare('SELECT id FROM records WHERE id=? AND task_id=?').get(recordId, taskId)) fail('RUNNER_OWNERSHIP_INVALID', 'Original input record does not belong to this Task')
  }

  receive(raw: InputEvent): InputEvent {
    const input = validateRunnerContract('runner_input_event', raw)
    if (input.stage !== 'received') fail('RUNNER_INPUT_STAGE_INVALID', 'New input must begin at the received stage')
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT payload_json FROM runner_inputs WHERE input_event_id=?').get(input.input_event_id) as PayloadRow | undefined
      if (existing) {
        if (!equivalent(JSON.parse(existing.payload_json), input)) fail('RUNNER_INPUT_CONFLICT', 'An input identity cannot change its original bindings')
        return this.input(input.input_event_id)
      }
      this.recordOwner(input.task_id, input.record_id)
      if (input.request_id) this.requestOwner(input.task_id, input.request_id)
      if (input.caused_by_event_id && this.input(input.caused_by_event_id).task_id !== input.task_id) fail('RUNNER_OWNERSHIP_INVALID', 'Input cause belongs to another Task')
      if (input.run_id) {
        const run = this.run(input.run_id)
        if (run.task_id !== input.task_id || input.request_id && run.purpose === 'production' && run.request_id !== input.request_id) fail('RUNNER_OWNERSHIP_INVALID', 'Input Run binding is inconsistent')
      }
      if (input.work_id) {
        const work = this.work(input.work_id)
        if (work.task_id !== input.task_id || input.run_id && work.run_id !== input.run_id || input.request_id && work.purpose === 'production' && work.request_id !== input.request_id) fail('RUNNER_OWNERSHIP_INVALID', 'Input work binding is inconsistent')
      }
      const created = new Date(this.clock()).toISOString(), body = json(input)
      this.db.prepare('INSERT INTO runner_inputs(input_event_id,task_id,record_id,kind,payload_json,created_at) VALUES (?,?,?,?,?,?)').run(input.input_event_id, input.task_id, input.record_id, input.kind, body, created)
      this.db.prepare('INSERT INTO runner_consumptions(input_event_id,task_id,stage,result_json,installed_at) VALUES (?,?,?,?,?)').run(input.input_event_id, input.task_id, 'received', body, created)
      return JSON.parse(body) as InputEvent
    }).immediate()
  }

  input(inputId: string): InputEvent {
    const input = this.payload('runner_input_event', this.db.prepare('SELECT payload_json FROM runner_inputs WHERE input_event_id=?').get(inputId) as PayloadRow | undefined)
    const installed = this.db.prepare('SELECT stage FROM runner_consumptions WHERE input_event_id=?').all(inputId) as { stage: ConsumptionStage }[]
    return { ...input, stage: stages.filter(stage => installed.some(item => item.stage === stage)).at(-1) ?? 'received' }
  }

  consumption<T = unknown>(inputId: string, stage: ConsumptionStage): InputConsumption<T> | null {
    validateRunnerContract('runner_consumption_stage', stage)
    const row = this.db.prepare('SELECT * FROM runner_consumptions WHERE input_event_id=? AND stage=?').get(inputId, stage) as { input_event_id: string; task_id: string; stage: ConsumptionStage; result_json: string; installed_at: string } | undefined
    if (!row) return null
    const { result_json, ...identity } = row
    return { ...identity, result: JSON.parse(result_json) as T }
  }

  consume<T>(inputId: string, stage: ConsumptionStage, install: SynchronousInstaller<T>): T {
    validateRunnerContract('runner_consumption_stage', stage)
    return this.db.transaction(() => {
      const previous = this.consumption<T>(inputId, stage)
      if (previous) return previous.result
      const input = this.input(inputId), position = stages.indexOf(stage)
      if (position === 0 || !this.consumption(inputId, stages[position - 1]!)) fail('RUNNER_INPUT_STAGE_INVALID', 'Input stages must be installed in order')
      if (types.isAsyncFunction(install)) fail('RUNNER_RESULT_INVALID', 'Runner installation callback must be synchronous')
      const result = json(install(input))
      this.db.prepare('INSERT INTO runner_consumptions(input_event_id,task_id,stage,result_json,installed_at) VALUES (?,?,?,?,?)').run(inputId, input.task_id, stage, result, new Date(this.clock()).toISOString())
      return JSON.parse(result) as T
    }).immediate()
  }

  goal(requestId: string, revision?: number): GoalRevision {
    const row = revision === undefined
      ? this.db.prepare('SELECT r.payload_json FROM runner_goal_heads h JOIN runner_goal_revisions r ON r.request_id=h.request_id AND r.intent_revision=h.intent_revision WHERE h.request_id=?').get(requestId)
      : this.db.prepare('SELECT payload_json FROM runner_goal_revisions WHERE request_id=? AND intent_revision=?').get(requestId, revision)
    return this.payload('runner_goal_revision', row as PayloadRow | undefined)
  }

  installGoal(raw: GoalRevision, expectedRevision: number | null = raw.previous_revision ?? null): GoalRevision {
    const goal = validateRunnerContract('runner_goal_revision', raw)
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT payload_json FROM runner_goal_revisions WHERE request_id=? AND intent_revision=?').get(goal.request_id, goal.intent_revision) as PayloadRow | undefined
      if (existing) {
        if (!equivalent(JSON.parse(existing.payload_json), goal)) fail('RUNNER_GOAL_CONFLICT', 'A goal revision cannot be overwritten')
        return this.payload('runner_goal_revision', existing)
      }
      this.activeTask(goal.task_id); this.requestOwner(goal.task_id, goal.request_id)
      const input = this.input(goal.input_event_id)
      if (input.task_id !== goal.task_id || input.request_id !== goal.request_id || !['request', 'correction', 'withdraw_goal'].includes(input.kind)) fail('RUNNER_OWNERSHIP_INVALID', 'Goal revision requires an explicitly targeted goal input')
      const head = this.db.prepare('SELECT intent_revision FROM runner_goal_heads WHERE request_id=?').get(goal.request_id) as { intent_revision: number } | undefined
      if ((head?.intent_revision ?? null) !== expectedRevision || goal.intent_revision !== (head?.intent_revision ?? 0) + 1 || goal.previous_revision !== head?.intent_revision) fail('RUNNER_GOAL_CONFLICT', 'Goal revision does not match its current predecessor')
      if (head && this.goal(goal.request_id).state === 'withdrawn') fail('RUNNER_GOAL_CONFLICT', 'A withdrawn goal cannot be revived by a correction')
      if (!head && input.kind !== 'request' || head && input.kind === 'request' || goal.state === 'withdrawn' && input.kind !== 'withdraw_goal' || input.kind === 'withdraw_goal' && goal.state !== 'withdrawn') fail('RUNNER_GOAL_CONFLICT', 'Goal input kind does not match the revision transition')
      this.db.prepare('INSERT INTO runner_goal_revisions(task_id,request_id,intent_revision,input_event_id,payload_json) VALUES (?,?,?,?,?)').run(goal.task_id, goal.request_id, goal.intent_revision, goal.input_event_id, json(goal))
      this.db.prepare('INSERT INTO runner_goal_heads(task_id,request_id,intent_revision) VALUES (?,?,?) ON CONFLICT(request_id) DO UPDATE SET intent_revision=excluded.intent_revision').run(goal.task_id, goal.request_id, goal.intent_revision)
      return this.goal(goal.request_id)
    }).immediate()
  }

  run(runId: string): RunnerRun {
    const value = this.payload('runner_run', this.db.prepare('SELECT payload_json FROM runner_runs WHERE run_id=?').get(runId) as PayloadRow | undefined)
    const core = this.db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as CoreRun | undefined
    if (!core || core.task_id !== value.task_id || core.runtime_epoch !== value.runtime_epoch) fail('RUNNER_OWNERSHIP_INVALID', 'Run source record is inconsistent')
    const state = terminalRun.has(core.state as RunnerRun['state']) || !['queued', 'closing'].includes(value.state) ? core.state as RunnerRun['state'] : value.state
    return validateRunnerContract('runner_run', { ...value, state, commit_valid: core.commit_valid === 1 })
  }

  registerRun(raw: RunnerRun): RunnerRun {
    const run = validateRunnerContract('runner_run', raw)
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT payload_json FROM runner_runs WHERE run_id=?').get(run.run_id) as PayloadRow | undefined
      if (existing) {
        if (!equivalent(runBinding(this.payload('runner_run', existing)), runBinding(run))) fail('RUNNER_RUN_CONFLICT', 'A Run identity cannot change its original bindings')
        return this.run(run.run_id)
      }
      this.activeTask(run.task_id)
      const core = this.db.prepare('SELECT * FROM runs WHERE id=?').get(run.run_id) as CoreRun | undefined
      if (!core || core.task_id !== run.task_id || core.runtime_epoch !== run.runtime_epoch || run.runtime_epoch !== this.epoch || core.commit_valid !== Number(run.commit_valid) || (terminalRun.has(run.state) ? core.state !== run.state : !['running', 'waiting'].includes(core.state))) fail('RUNNER_OWNERSHIP_INVALID', 'Run does not match its original runtime record')
      if (run.purpose === 'production') {
        const goal = this.goal(run.request_id)
        if (core.request_id !== run.request_id || goal.task_id !== run.task_id || goal.intent_revision !== run.intent_revision || goal.state !== 'active') fail('RUNNER_OWNERSHIP_INVALID', 'Production Run does not match the current goal')
        if (run.update_id) new ChapterState(this.db).assertCurrent(run.task_id, run.update_id)
        const active = this.db.prepare("SELECT c.id FROM runs c LEFT JOIN runner_runs r ON r.run_id=c.id WHERE c.request_id=? AND c.id<>? AND c.state IN ('running','waiting') AND COALESCE(json_extract(r.payload_json,'$.update_id'),'')=?").get(run.request_id, run.run_id, run.update_id ?? '')
        if (active) fail('RUNNER_RUN_CONFLICT', 'A request already owns an active production Run')
      } else {
        this.requestOwner(run.task_id, run.trigger_request_id)
        const batch = this.db.prepare('SELECT task_id,composition_version FROM runner_batches WHERE batch_id=?').get(run.batch_id) as { task_id: string; composition_version: number } | undefined
        if (core.request_id !== null || !batch || batch.task_id !== run.task_id || batch.composition_version !== run.composition_version) fail('RUNNER_OWNERSHIP_INVALID', 'Composition Run does not match its batch source')
      }
      const ledger = new RunnerBudgetLedger(this.db, this.clock), budget = ledger.snapshot(run.budget_id)
      if (budget.budget.task_id !== run.task_id || budget.budget.purpose !== run.purpose || (run.purpose === 'production' && budget.budget.request_id !== run.request_id)) fail('RUNNER_OWNERSHIP_INVALID', 'Run does not own the cumulative budget')
      if (run.previous_run_id) {
        const previous = this.run(run.previous_run_id)
        if (!sameSource(previous, run) || previous.budget_id !== run.budget_id || !terminalRun.has(previous.state) || previous.commit_valid) fail('RUNNER_RUN_CONFLICT', 'Resumption must retain a terminal predecessor and its cumulative budget')
      }
      this.db.prepare('INSERT INTO runner_runs(run_id,task_id,purpose,request_id,intent_revision,batch_id,composition_version,budget_id,payload_json) VALUES (?,?,?,?,?,?,?,?,?)').run(run.run_id, run.task_id, run.purpose, run.purpose === 'production' ? run.request_id : null, run.purpose === 'production' ? run.intent_revision : null, run.purpose === 'composition' ? run.batch_id : null, run.purpose === 'composition' ? run.composition_version : null, run.budget_id, json(run))
      return this.run(run.run_id)
    }).immediate()
  }

  work(workId: string): LogicalWork {
    return this.payload('runner_logical_work', this.db.prepare('SELECT payload_json FROM runner_work WHERE work_id=?').get(workId) as PayloadRow | undefined)
  }
  attempt(attemptId: string): ExecutionAttempt {
    return this.payload('runner_execution_attempt', this.db.prepare('SELECT payload_json FROM runner_attempts WHERE attempt_id=?').get(attemptId) as PayloadRow | undefined)
  }
  taskWorks(taskId: string): LogicalWork[] {
    return (this.db.prepare('SELECT payload_json FROM runner_work WHERE task_id=? ORDER BY rowid').all(taskId) as PayloadRow[]).map(row => this.payload('runner_logical_work', row))
  }
  attempts(workId: string): ExecutionAttempt[] {
    return (this.db.prepare('SELECT payload_json FROM runner_attempts WHERE work_id=? ORDER BY attempt_number').all(workId) as PayloadRow[]).map(row => this.payload('runner_execution_attempt', row))
  }

  private sourceCurrent(run: RunnerRun): GoalRevision | undefined {
    this.activeTask(run.task_id)
    if (!run.commit_valid || run.runtime_epoch !== this.epoch || !['queued', 'running', 'waiting'].includes(run.state)) fail('RUNNER_OWNERSHIP_INVALID', 'Run no longer permits new work or commits')
    if (run.purpose === 'production') {
      const goal = this.goal(run.request_id)
      if (goal.task_id !== run.task_id || goal.intent_revision !== run.intent_revision || goal.state !== 'active') fail('RUNNER_OWNERSHIP_INVALID', 'Production goal revision is no longer current')
      if (run.update_id) new ChapterState(this.db).assertCurrent(run.task_id, run.update_id)
      return goal
    }
    const batch = this.db.prepare('SELECT payload_json FROM runner_batches WHERE batch_id=?').get(run.batch_id) as PayloadRow | undefined
    if (!batch) fail('RUNNER_OWNERSHIP_INVALID', 'Composition batch is unavailable')
    const value = validateRunnerContract('runner_composition_batch', JSON.parse(batch.payload_json))
    if (value.task_id !== run.task_id || value.composition_version !== run.composition_version || ['invalidated', 'cancelled', 'failed'].includes(value.state)) fail('RUNNER_OWNERSHIP_INVALID', 'Composition batch no longer permits work')
    return undefined
  }

  private artifactSource(dependency: Extract<WorkDependency, { kind: 'artifact' }>, proposed = new Map<string, LogicalWork>()): { work: LogicalWork; current: boolean; settled?: true } | null {
    const row = this.db.prepare('SELECT o.task_id,o.work_id,o.plan_revision,o.section_id,o.current_revision,a.payload_json,c.payload_json candidate_json,c.result_json FROM runner_artifact_owners o LEFT JOIN runner_artifacts a ON a.task_id=o.task_id AND a.artifact_id=o.artifact_id AND a.artifact_revision=o.current_revision LEFT JOIN runner_candidates c ON c.task_id=a.task_id AND c.candidate_id=a.candidate_id WHERE o.artifact_id=?').get(dependency.artifact_id) as { task_id: string; work_id: string; plan_revision: number; section_id: string; current_revision: number; payload_json: string | null; candidate_json: string | null; result_json: string | null } | undefined
    if (!row || row.task_id !== dependency.task_id || row.current_revision !== dependency.artifact_revision || !row.payload_json || !row.candidate_json || !row.result_json) return null
    const index = validateRunnerContract('runner_artifact_index', JSON.parse(row.payload_json)), candidate = validateRunnerContract('runner_artifact_candidate', JSON.parse(row.candidate_json)), decision = JSON.parse(row.result_json) as { state: string; index?: unknown }
    const source = proposed.get(index.work_id) ?? this.work(index.work_id), attempt = this.attempt(index.attempt_id)
    // Published chapter content has settled host provenance. Consuming it does
    // not require the publisher to regain authority over its old chapter input.
    try {
      if (new RunnerArtifactState(this.db, this).checkChapterAssembly(index)) return { work: source, current: true, settled: true }
    } catch (error) {
      if (error instanceof ContractError) return null
      throw error
    }
    if (decision.state !== 'accepted' || !equivalent(decision.index, index) || source.purpose !== 'production' || source.task_id !== dependency.task_id || source.request_id !== index.request_id || source.intent_revision !== index.intent_revision || source.run_id !== index.run_id || source.current_attempt_id !== index.attempt_id || row.work_id !== source.work_id || row.plan_revision !== source.plan_revision || row.section_id !== index.section_id || candidate.plan_revision !== source.plan_revision || !sameDependencies(candidate.dependencies, source.dependencies) || !sameDependencies(candidate.dependencies, attempt.input_versions)) return null
    if (!this.db.prepare('SELECT 1 FROM task_resources WHERE task_id=? AND resource_id=?').get(dependency.task_id, index.bundle_resource_id)) return null
    return { work: source, current: ['running', 'waiting', 'succeeded'].includes(source.state) && ['running', 'waiting', 'succeeded'].includes(attempt.state) }
  }

  private sourceDependenciesCurrent(work: LogicalWork, requireSuccess: boolean, proposed: Map<string, LogicalWork>, checking: Set<string>): void {
    if (work.purpose === 'production') {
      const goal = this.goal(work.request_id)
      if (goal.intent_revision !== work.intent_revision || goal.state !== 'active') fail('RUNNER_DEPENDENCY_INVALID', 'Work dependency belongs to an obsolete goal revision')
      if (work.update_id) new ChapterState(this.db).assertCurrent(work.task_id, work.update_id)
    }
    if (checking.has(work.work_id)) fail('RUNNER_DEPENDENCY_CYCLE', 'Logical work dependencies must form a DAG')
    checking.add(work.work_id)
    this.dependenciesCurrent(work.dependencies, requireSuccess, proposed, checking)
    checking.delete(work.work_id)
  }

  private dependenciesCurrent(dependencies: WorkDependency[], requireSuccess: boolean, proposed = new Map<string, LogicalWork>(), checking = new Set<string>()): void {
    for (const dependency of dependencies) {
      if (dependency.kind === 'goal') {
        const goal = this.goal(dependency.request_id)
        if (goal.task_id !== dependency.task_id || goal.state !== 'active' || goal.intent_revision !== dependency.intent_revision) fail('RUNNER_DEPENDENCY_INVALID', 'Goal dependency is no longer current')
      } else if (dependency.kind === 'work') {
        const work = proposed.get(dependency.work_id) ?? this.work(dependency.work_id)
        if (work.task_id !== dependency.task_id || terminalWork.has(work.state) && work.state !== 'succeeded' || work.result_revision !== undefined && work.result_revision !== dependency.result_revision || requireSuccess && (work.state !== 'succeeded' || work.result_revision !== dependency.result_revision)) fail('RUNNER_DEPENDENCY_INVALID', 'Work dependency is not an eligible exact result')
        this.sourceDependenciesCurrent(work, requireSuccess, proposed, checking)
      } else if (dependency.kind === 'artifact') {
        const source = this.artifactSource(dependency, proposed)
        if (!source?.current) fail('RUNNER_DEPENDENCY_INVALID', 'Artifact dependency is not the current accepted version')
        if (!source.settled) this.sourceDependenciesCurrent(source.work, requireSuccess, proposed, checking)
      } else if (dependency.kind === 'chapter') {
        if (!new ChapterState(this.db).dependencyCurrent(dependency)) fail('RUNNER_DEPENDENCY_INVALID', 'The exact chapter or shared dependency changed')
      } else if (!this.db.prepare('SELECT resource_id FROM task_resources WHERE task_id=? AND resource_id=?').get(dependency.task_id, dependency.resource_id)) fail('RUNNER_DEPENDENCY_INVALID', 'Resource dependency does not belong to this Task')
    }
  }

  installPlan(raw: LogicalWork[]): LogicalWork[] {
    if (!Array.isArray(raw) || !raw.length) fail('INVALID_RUNNER_CONTRACT', 'A work plan must contain logical work')
    const plan = raw.map(work => validateRunnerContract('runner_logical_work', work)), proposed = new Map(plan.map(work => [work.work_id, work]))
    if (proposed.size !== plan.length) fail('RUNNER_PLAN_CONFLICT', 'A work plan contains duplicate identities')
    return this.db.transaction(() => {
      const first = plan[0]!
      if (plan.some(work => work.task_id !== first.task_id || work.run_id !== first.run_id || work.plan_revision !== first.plan_revision)) fail('RUNNER_PLAN_CONFLICT', 'A plan installation must have one Run and revision')
      const run = this.run(first.run_id), goal = this.sourceCurrent(run), updates = new Set<string>()
      // Repeated plan bindings refer to their installed execution facts. A
      // raw planned snapshot must not hide an already accepted source result.
      for (const work of plan) {
        const row = this.db.prepare('SELECT payload_json FROM runner_work WHERE work_id=?').get(work.work_id) as PayloadRow | undefined
        if (row) { const installed = this.payload('runner_logical_work', row); if (equivalent(planBinding(installed), planBinding(work))) proposed.set(work.work_id, installed) }
      }
      for (const work of plan) {
        if (!sameSource(run, work) || work.current_attempt_id !== undefined || work.root_cause !== undefined || work.result_revision !== undefined || !['planned', 'queued', 'waiting'].includes(work.state) || goal && work.requirement_ids.some(id => !goal.requirements.some(requirement => requirement.requirement_id === id))) fail('RUNNER_PLAN_CONFLICT', 'Logical work does not match its current source and requirements')
        this.dependenciesCurrent(work.dependencies, false, proposed)
        const row = this.db.prepare('SELECT payload_json FROM runner_work WHERE work_id=?').get(work.work_id) as PayloadRow | undefined
        if (!row) { updates.add(work.work_id); continue }
        const old = this.payload('runner_logical_work', row)
        if (equivalent(planBinding(old), planBinding(work))) continue
        const previousAttempt = this.attempts(work.work_id).at(-1)
        if (old.task_id !== work.task_id || old.purpose !== work.purpose || old.purpose === 'production' && work.purpose === 'production' && old.request_id !== work.request_id || old.purpose === 'composition' && work.purpose === 'composition' && old.batch_id !== work.batch_id || work.plan_revision !== old.plan_revision + 1 || ['cancelled', 'dependency_cancelled', 'failed', 'dependency_failed'].includes(old.state) || work.max_attempts < this.attempts(work.work_id).length || previousAttempt && (!terminalAttempt.has(previousAttempt.state) || previousAttempt.dispatch_state === 'unknown')) fail('RUNNER_PLAN_CONFLICT', 'Replanning cannot revive cancelled work or bypass an unresolved attempt')
        if (old.run_id !== work.run_id && run.previous_run_id !== old.run_id) fail('RUNNER_PLAN_CONFLICT', 'Resumed work must retain the original Run predecessor')
        updates.add(work.work_id)
      }
      const all = new Map(this.taskWorks(first.task_id).map(work => [work.work_id, work]))
      for (const work of plan) all.set(work.work_id, work)
      const visiting = new Set<string>(), visited = new Set<string>()
      const visit = (work: LogicalWork): void => {
        if (visiting.has(work.work_id)) fail('RUNNER_DEPENDENCY_CYCLE', 'Logical work dependencies must form a DAG')
        if (visited.has(work.work_id)) return
        visiting.add(work.work_id)
        for (const dependency of work.dependencies) if (dependency.kind === 'work') {
          const upstream = all.get(dependency.work_id)
          if (!upstream) fail('RUNNER_DEPENDENCY_INVALID', 'Logical work dependency does not exist')
          visit(upstream)
        }
        visiting.delete(work.work_id); visited.add(work.work_id)
      }
      for (const work of plan) visit(work)
      for (const work of plan) if (updates.has(work.work_id)) this.db.prepare('INSERT INTO runner_work(work_id,task_id,run_id,plan_revision,state,payload_json) VALUES (?,?,?,?,?,?) ON CONFLICT(work_id) DO UPDATE SET run_id=excluded.run_id,plan_revision=excluded.plan_revision,state=excluded.state,payload_json=excluded.payload_json').run(work.work_id, work.task_id, work.run_id, work.plan_revision, work.state, json(work))
      return plan.map(work => this.work(work.work_id))
    }).immediate()
  }

  createAttempt(raw: ExecutionAttempt): ExecutionAttempt {
    const attempt = validateRunnerContract('runner_execution_attempt', raw)
    if (!['registered', 'queued'].includes(attempt.state) || attempt.dispatch_state !== 'not_dispatched' || attempt.result_ref !== undefined || attempt.usage_refs.length) fail('RUNNER_ATTEMPT_CONFLICT', 'A new attempt must be registered before dispatch')
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT payload_json FROM runner_attempts WHERE attempt_id=?').get(attempt.attempt_id) as PayloadRow | undefined
      if (existing) {
        const original = this.payload('runner_execution_attempt', existing)
        if (!equivalent(attemptBinding(original), attemptBinding(attempt)) || attempt.operation_id !== undefined && original.operation_id !== attempt.operation_id) fail('RUNNER_ATTEMPT_CONFLICT', 'An attempt identity cannot change its source or exact inputs')
        return original
      }
      const work = this.work(attempt.work_id), run = this.run(attempt.run_id)
      this.sourceCurrent(run)
      if (!sameSource(run, attempt) || !sameSource(work, attempt) || work.run_id !== run.run_id || attempt.runtime_epoch !== this.epoch || terminalWork.has(work.state) || !sameDependencies(work.dependencies, attempt.input_versions)) fail('RUNNER_OWNERSHIP_INVALID', 'Attempt does not match its eligible logical work')
      this.dependenciesCurrent(attempt.input_versions, true)
      const previous = this.attempts(work.work_id).at(-1)
      if (attempt.attempt_number !== (previous?.attempt_number ?? 0) + 1 || attempt.attempt_number > work.max_attempts || attempt.previous_attempt_id !== previous?.attempt_id) fail('RUNNER_ATTEMPT_CONFLICT', 'Attempt must retain its predecessor and installed bound')
      if (previous && (!terminalAttempt.has(previous.state) || previous.state === 'cancelled' || previous.dispatch_state === 'unknown' || previous.state === 'revoked' && previous.dispatch_state !== 'not_dispatched')) fail('RUNNER_ATTEMPT_CONFLICT', 'An unresolved or cancelled attempt cannot be replayed')
      if (work.current_attempt_id && work.current_attempt_id !== previous?.attempt_id) fail('RUNNER_ATTEMPT_CONFLICT', 'Logical work points to an inconsistent attempt')
      this.db.prepare('INSERT INTO runner_attempts(attempt_id,task_id,work_id,run_id,attempt_number,state,payload_json) VALUES (?,?,?,?,?,?,?)').run(attempt.attempt_id, attempt.task_id, attempt.work_id, attempt.run_id, attempt.attempt_number, attempt.state, json(attempt))
      this.saveWork({ ...work, current_attempt_id: attempt.attempt_id, state: 'queued' })
      return this.attempt(attempt.attempt_id)
    }).immediate()
  }

  qualify(attemptId: string, mode: 'dispatch' | 'commit' = 'commit'): QualifiedAttempt {
    const attempt = this.attempt(attemptId), work = this.work(attempt.work_id), run = this.run(attempt.run_id), goal = this.sourceCurrent(run)
    if (attempt.runtime_epoch !== this.epoch || work.current_attempt_id !== attemptId || work.run_id !== run.run_id || !sameSource(run, attempt) || !sameSource(work, attempt) || ['failed', 'cancelled', 'revoked', 'unknown'].includes(attempt.state) || terminalWork.has(work.state) && work.state !== 'succeeded' || !sameDependencies(work.dependencies, attempt.input_versions)) fail('RUNNER_OWNERSHIP_INVALID', 'Attempt no longer has current execution authority')
    if (mode === 'dispatch' && (attempt.dispatch_state !== 'not_dispatched' || !['registered', 'queued'].includes(attempt.state) || terminalWork.has(work.state))) fail('RUNNER_OWNERSHIP_INVALID', 'Attempt cannot be dispatched again')
    this.dependenciesCurrent(attempt.input_versions, true)
    return { task_id: run.task_id, runtime_epoch: this.epoch, run, work, attempt, ...(goal ? { goal } : {}) }
  }

  private saveWork(work: LogicalWork): void {
    validateRunnerContract('runner_logical_work', work)
    this.db.prepare('UPDATE runner_work SET run_id=?,plan_revision=?,state=?,payload_json=? WHERE work_id=?').run(work.run_id, work.plan_revision, work.state, json(work), work.work_id)
  }

  closeRun(runId: string): RunnerRun {
    return this.db.transaction(() => {
      const run = this.run(runId)
      if (terminalRun.has(run.state)) return run
      this.db.prepare('UPDATE runs SET commit_valid=0 WHERE id=?').run(runId)
      this.db.prepare('UPDATE runner_runs SET payload_json=? WHERE run_id=?').run(json({ ...run, state: 'closing', commit_valid: false }), runId)
      return this.run(runId)
    }).immediate()
  }

  private cause(work: LogicalWork, kind: WorkCause['kind']): WorkCause {
    const attempt = work.current_attempt_id ? this.attempt(work.current_attempt_id) : undefined
    return { kind, work_id: work.work_id, ...(attempt ? { attempt_id: attempt.attempt_id } : {}), ...(attempt?.operation_id ? { operation_id: attempt.operation_id } : {}) }
  }

  private installRevocation(work: LogicalWork, cause: WorkCause, downstream: boolean): LogicalWork {
    if (terminalWork.has(work.state) || terminalRun.has(this.run(work.run_id).state)) return work
    const state = cause.kind === 'failure' ? downstream ? 'dependency_failed' : 'failed' : cause.kind === 'cancellation' ? downstream ? 'dependency_cancelled' : 'cancelled' : 'invalidated'
    const value = { ...work, state, root_cause: work.root_cause ?? cause } as LogicalWork
    this.saveWork(value)
    // Revocation removes authority immediately. Dispatched execution is still
    // reconciled by its owner; it is not a clean cancellation result.
    for (const attempt of this.attempts(work.work_id)) if (!terminalAttempt.has(attempt.state) && attempt.dispatch_state === 'not_dispatched') {
      this.db.prepare('UPDATE runner_attempts SET state=?,payload_json=? WHERE attempt_id=?').run('revoked', json({ ...attempt, state: 'revoked' }), attempt.attempt_id)
    }
    return value
  }

  private propagate(workId: string, rawCause: WorkCause, includeSucceededSource = false): LogicalWork[] {
    const root = this.work(workId)
    if (terminalRun.has(this.run(root.run_id).state) || root.state === 'succeeded' && !includeSucceededSource) return [root]
    const cause = root.root_cause ?? (root.state === 'failed' || root.state === 'dependency_failed' ? this.cause(root, 'failure') : root.state === 'cancelled' || root.state === 'dependency_cancelled' ? this.cause(root, 'cancellation') : rawCause)
    // Validation also rejects malformed causes before any authority is changed.
    validateRunnerContract('runner_logical_work', { ...root, root_cause: cause })
    const all = this.taskWorks(root.task_id), affected = new Set([workId]), result: LogicalWork[] = []
    const sources = new Map(all.map(work => [work.work_id, work.dependencies.flatMap(dependency => {
      if (dependency.kind === 'work') return [dependency.work_id]
      if (dependency.kind !== 'artifact') return []
      const row = this.db.prepare('SELECT payload_json FROM runner_artifacts WHERE task_id=? AND artifact_id=? AND artifact_revision=?').get(dependency.task_id, dependency.artifact_id, dependency.artifact_revision) as PayloadRow | undefined
      return row ? [validateRunnerContract('runner_artifact_index', JSON.parse(row.payload_json)).work_id] : []
    })]))
    for (let changed = true; changed;) {
      changed = false
      for (const work of all) if (!affected.has(work.work_id) && sources.get(work.work_id)!.some(source => affected.has(source))) { affected.add(work.work_id); changed = true }
    }
    for (const work of all) if (affected.has(work.work_id)) result.push(this.installRevocation(work, cause, work.work_id !== workId))
    return result
  }

  revokeWork(workId: string, cause?: WorkCause): LogicalWork[] {
    return this.db.transaction(() => {
      const work = this.work(workId)
      return this.propagate(workId, cause ?? this.cause(work, 'cancellation'))
    }).immediate()
  }

  revokeRun(runId: string, cause?: WorkCause): LogicalWork[] {
    return this.db.transaction(() => {
      const run = this.run(runId), works = this.taskWorks(run.task_id).filter(work => work.run_id === runId)
      if (terminalRun.has(run.state)) return works
      this.closeRun(runId)
      const affected = new Map<string, LogicalWork>()
      for (const work of works) for (const value of this.propagate(work.work_id, cause ?? this.cause(work, 'cancellation'), true)) affected.set(value.work_id, value)
      return [...affected.keys()].map(workId => this.work(workId))
    }).immediate()
  }

  reconcileDependencies(taskId: string): LogicalWork[] {
    assertRunnerId(taskId, 'task_id')
    return this.db.transaction(() => {
      const works = this.taskWorks(taskId), all = new Map(works.map(work => [work.work_id, work])), memo = new Map<string, WorkCause | null>(), checking = new Set<string>()
      const choose = (causes: WorkCause[]): WorkCause | null => causes.sort((left, right) => ({ failure: 0, cancellation: 1, invalidation: 2 })[left.kind] - ({ failure: 0, cancellation: 1, invalidation: 2 })[right.kind] || (left.work_id < right.work_id ? -1 : left.work_id > right.work_id ? 1 : 0))[0] ?? null
      const inspect = (work: LogicalWork): WorkCause | null => {
        if (memo.has(work.work_id)) return memo.get(work.work_id)!
        if (checking.has(work.work_id)) fail('RUNNER_DEPENDENCY_CYCLE', 'Logical work dependencies must form a DAG')
        if (terminalWork.has(work.state) && work.state !== 'succeeded') {
          const cause = work.root_cause ?? this.cause(work, work.state === 'invalidated' ? 'invalidation' : work.state === 'failed' || work.state === 'dependency_failed' ? 'failure' : 'cancellation')
          memo.set(work.work_id, cause)
          return cause
        }
        checking.add(work.work_id)
        const causes: WorkCause[] = []
        if (work.purpose === 'production') {
          const goal = this.goal(work.request_id)
          if (goal.task_id !== taskId || goal.intent_revision !== work.intent_revision || goal.state !== 'active') causes.push(this.cause(work, 'invalidation'))
          if (work.update_id) {
            const chapters = new ChapterState(this.db), update = chapters.update(taskId, work.update_id)
            const published = update?.state === 'succeeded' && update.publication_operation_id && chapters.publication(taskId, update.publication_operation_id)?.operation.state === 'published'
            // An installed chapter result is historical evidence. Its own
            // replacement advances the old input versions without reviving it.
            if (work.state === 'succeeded' && published) {
              checking.delete(work.work_id)
              const cause = choose(causes); memo.set(work.work_id, cause)
              return cause
            }
            try { chapters.assertCurrent(taskId, work.update_id) }
            catch { causes.push(this.cause(work, 'invalidation')) }
          }
        }
        for (const dependency of work.dependencies) {
          if (dependency.kind === 'work') {
            const source = all.get(dependency.work_id)
            if (!source || source.task_id !== dependency.task_id || source.result_revision !== undefined && source.result_revision !== dependency.result_revision || source.state === 'succeeded' && source.result_revision !== dependency.result_revision) causes.push(this.cause(work, 'invalidation'))
            else { const cause = inspect(source); if (cause) causes.push(cause) }
          } else if (dependency.kind === 'goal') {
            const goal = this.goal(dependency.request_id)
            if (goal.task_id !== dependency.task_id || goal.intent_revision !== dependency.intent_revision || goal.state !== 'active') causes.push(this.cause(work, 'invalidation'))
          } else if (dependency.kind === 'artifact') {
            const source = this.artifactSource(dependency, all)
            if (!source) causes.push(this.cause(work, 'invalidation'))
            else if (!source.settled) { const cause = inspect(source.work); if (cause) causes.push(cause); else if (!source.current) causes.push(this.cause(work, 'invalidation')) }
          } else if (dependency.kind === 'chapter') {
            if (!new ChapterState(this.db).dependencyCurrent(dependency)) causes.push(this.cause(work, 'invalidation'))
          } else if (!this.db.prepare('SELECT 1 FROM task_resources WHERE task_id=? AND resource_id=?').get(dependency.task_id, dependency.resource_id)) causes.push(this.cause(work, 'invalidation'))
        }
        checking.delete(work.work_id)
        const cause = choose(causes); memo.set(work.work_id, cause)
        return cause
      }
      const affected: LogicalWork[] = []
      for (const work of works) {
        const cause = inspect(work)
        if (cause && !terminalWork.has(work.state) && !terminalRun.has(this.run(work.run_id).state)) affected.push(this.installRevocation(work, cause, cause.work_id !== work.work_id))
      }
      return affected
    }).immediate()
  }

  updateAttempt(raw: ExecutionAttempt, retryPlan?: LogicalWork): ExecutionAttempt {
    const value = validateRunnerContract('runner_execution_attempt', raw)
    return this.db.transaction(() => {
      const old = this.attempt(value.attempt_id)
      if (!equivalent(attemptBinding(old), attemptBinding(value)) || old.operation_id !== undefined && old.operation_id !== value.operation_id || old.result_ref !== undefined && !equivalent(old.result_ref, value.result_ref) || old.usage_refs.some(id => !value.usage_refs.includes(id)) || terminalAttempt.has(old.state) && (old.state !== value.state || old.dispatch_state !== value.dispatch_state) || old.dispatch_state !== 'not_dispatched' && value.dispatch_state === 'not_dispatched') fail('RUNNER_ATTEMPT_CONFLICT', 'Attempt evidence and historical outcomes cannot be overwritten')
      const allowed: Record<ExecutionAttempt['state'], ExecutionAttempt['state'][]> = {
        registered: ['registered', 'queued', 'dispatched', 'revoked', 'cancelled'], queued: ['queued', 'dispatched', 'revoked', 'cancelled'],
        dispatched: ['dispatched', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'unknown'], running: ['running', 'waiting', 'succeeded', 'failed', 'cancelled', 'unknown'],
        waiting: ['waiting', 'running', 'succeeded', 'failed', 'cancelled', 'unknown'], unknown: ['unknown', 'succeeded', 'failed', 'cancelled'], succeeded: ['succeeded'], failed: ['failed'], cancelled: ['cancelled'], revoked: ['revoked']
      }
      if (!allowed[old.state].includes(value.state) || ['dispatched', 'running', 'waiting', 'succeeded', 'unknown'].includes(value.state) && value.dispatch_state === 'not_dispatched' || value.state === 'unknown' && value.dispatch_state !== 'unknown') fail('RUNNER_ATTEMPT_CONFLICT', 'Attempt execution and dispatch evidence are inconsistent')
      if (old.dispatch_state === 'not_dispatched' && value.dispatch_state !== 'not_dispatched') {
        this.qualify(value.attempt_id, 'dispatch')
        if (!value.operation_id) fail('RUNNER_ATTEMPT_CONFLICT', 'Dispatch must retain a stable operation identity')
      }
      this.db.prepare('UPDATE runner_attempts SET state=?,payload_json=? WHERE attempt_id=?').run(value.state, json(value), value.attempt_id)
      const work = this.work(value.work_id)
      if (retryPlan !== undefined) {
        const next = validateRunnerContract('runner_logical_work', retryPlan)
        if (value.state !== 'failed' || work.current_attempt_id !== value.attempt_id || terminalWork.has(work.state) || terminalRun.has(this.run(value.run_id).state) || next.work_id !== work.work_id || next.run_id !== work.run_id || next.role !== work.role || next.plan_revision !== work.plan_revision + 1 || value.attempt_number >= work.max_attempts || next.max_attempts > work.max_attempts || next.max_attempts <= value.attempt_number) fail('RUNNER_PLAN_CONFLICT', 'A retry requires an exact installed successor plan within the remaining attempt bound')
        this.installPlan([next])
        return this.attempt(value.attempt_id)
      }
      // Late results enrich their original attempt; revoked work retains its
      // logical outcome and never receives fresh commit authority.
      if (work.current_attempt_id === value.attempt_id && !terminalWork.has(work.state) && !terminalRun.has(this.run(value.run_id).state)) {
        if (value.state === 'succeeded') this.saveWork({ ...work, state: 'succeeded', result_revision: (work.result_revision ?? 0) + 1 })
        else if (value.state === 'failed') this.saveWork({ ...work, state: 'failed', root_cause: { kind: 'failure', work_id: work.work_id, attempt_id: value.attempt_id, ...(value.operation_id ? { operation_id: value.operation_id } : {}) } })
        else if (value.state === 'cancelled') this.saveWork({ ...work, state: 'cancelled', root_cause: { kind: 'cancellation', work_id: work.work_id, attempt_id: value.attempt_id, ...(value.operation_id ? { operation_id: value.operation_id } : {}) } })
        else this.saveWork({ ...work, state: value.state === 'waiting' || value.state === 'unknown' ? 'waiting' : value.state === 'running' || value.state === 'dispatched' ? 'running' : 'queued' })
      }
      return this.attempt(value.attempt_id)
    }).immediate()
  }

}
